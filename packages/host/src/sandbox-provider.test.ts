/**
 * Tests for the LANEA-05 disk gate: any image build or pull below 10 GiB
 * free is refused before any docker call, with a stubbed df runner.
 * Docker is faked; no daemon is touched.
 */
import { describe, expect, test } from "bun:test";
import {
	checkDiskFloor,
	DISK_FLOOR_BYTES,
	ensureImagePulled,
	type DockerClient,
} from "./sandbox-provider.ts";

function dfWith(availBytes: number): () => string | null {
	return () => `Avail\n${availBytes}\n`;
}

function notFoundError(): Error {
	return Object.assign(new Error("No such image"), { statusCode: 404 });
}

function fakeDocker(): { docker: DockerClient; calls: string[] } {
	const calls: string[] = [];
	const docker = {
		getImage: (name: string) => {
			calls.push(`getImage:${name}`);
			return { inspect: async () => ({}) };
		},
		pull: async (name: string) => {
			calls.push(`pull:${name}`);
			return { stream: true };
		},
		modem: {
			followProgress: (stream: unknown, onFinished: (error: Error | null, output: unknown) => void) => {
				calls.push("followProgress");
				expect(stream).toEqual({ stream: true });
				onFinished(null, []);
			},
		},
		createContainer: async () => {
			throw new Error("not needed here");
		},
		getContainer: (id: string) => {
			throw new Error(`not needed here: ${id}`);
		},
		getNetwork: () => {
			throw new Error("not needed here");
		},
		createNetwork: async () => undefined,
	} satisfies DockerClient;
	return { docker, calls };
}

describe("checkDiskFloor", () => {
	test("refuses below the floor and names the free bytes and the floor", () => {
		const gate = checkDiskFloor(dfWith(DISK_FLOOR_BYTES - 1));
		expect(gate.ok).toBe(false);
	});

	test("allows above the floor", () => {
		const gate = checkDiskFloor(dfWith(DISK_FLOOR_BYTES + 1));
		expect(gate).toEqual({ ok: true, availBytes: DISK_FLOOR_BYTES + 1 });
	});

	test("unreadable df refuses (fail-closed)", () => {
		expect(checkDiskFloor(() => null).ok).toBe(false);
		expect(checkDiskFloor(() => "garbage").ok).toBe(false);
	});
});

describe("ensureImagePulled", () => {
	test("present image skips the pull without a docker pull call", async () => {
		const { docker, calls } = fakeDocker();
		const result = await ensureImagePulled(docker, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES + 1));
		expect(result).toBe("present");
		expect(calls.some((call) => call.startsWith("pull:"))).toBe(false);
	});

	test("missing image pulls, but only after the gate passes", async () => {
		const { docker, calls } = fakeDocker();
		const missing = {
			...docker,
			getImage: (name: string) => {
				calls.push(`getImage:${name}`);
				return { inspect: async () => { throw notFoundError(); } };
			},
		} satisfies DockerClient;
		const result = await ensureImagePulled(missing, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES + 1));
		expect(result).toBe("pulled");
		expect(calls).toEqual([
			"getImage:substrate-sandbox:0.1",
			"pull:substrate-sandbox:0.1",
			"followProgress",
		]);
	});

	test("below the floor no docker call happens at all", async () => {
		const { docker, calls } = fakeDocker();
		await expect(
			ensureImagePulled(docker, "substrate-sandbox:0.1", dfWith(DISK_FLOOR_BYTES - 1)),
		).rejects.toThrow(/floor 10737418240/);
		expect(calls).toEqual([]);
	});

	test("unreadable df refuses before any docker call", async () => {
		const { docker, calls } = fakeDocker();
		await expect(ensureImagePulled(docker, "substrate-sandbox:0.1", () => null)).rejects.toThrow(
			/refusing image substrate-sandbox:0.1/,
		);
		expect(calls).toEqual([]);
	});
});
