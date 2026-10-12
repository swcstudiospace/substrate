/**
 * Tests for the LANEA-05 disk gate: any image build or pull below 10 GiB
 * free is refused before any docker call, with a stubbed df runner.
 * Docker is faked; no daemon is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_LABEL, worktreeFor } from "./sandbox-options.ts";
import {
	checkDiskFloor,
	defaultSandboxStatePath,
	destroySandbox,
	DISK_FLOOR_BYTES,
	ensureImagePulled,
	type DockerClient,
	listSandboxes,
	substrateDocker,
} from "./sandbox-provider.ts";
import { SandboxStateStore } from "./tasks.ts";

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
		listContainers: async () => [],
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

/** State-file paths created by tests, removed after each test. */
const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A full fake daemon for provider-level tests: containers live in a map, every call is recorded. */
function daemonDocker(): { docker: DockerClient; calls: string[] } {
	const calls: string[] = [];
	const containers = new Map<string, { labels: Record<string, string>; running: boolean }>();
	const handle = (id: string) => ({
		id,
		start: async () => {
			calls.push(`start:${id}`);
			const container = containers.get(id);
			if (container) container.running = true;
		},
		stop: async () => {
			calls.push(`stop:${id}`);
		},
		remove: async () => {
			calls.push(`remove:${id}`);
			containers.delete(id);
		},
		inspect: async () => {
			const container = containers.get(id);
			if (!container) throw Object.assign(new Error("No such container"), { statusCode: 404 });
			return { Config: { Labels: container.labels } };
		},
	});
	const docker = {
		createContainer: async (body: Record<string, unknown>) => {
			const id = `c${containers.size + 1}`;
			calls.push(`create:${id}`);
			// buildContainerSpec always sends Labels: { [GRAPH_LABEL]: string }.
			const labels = body.Labels as Record<string, string> | undefined;
			containers.set(id, { labels: labels ?? {}, running: false });
			return handle(id);
		},
		getContainer: (id: string) => handle(id),
		getNetwork: () => {
			throw new Error("not needed here");
		},
		createNetwork: async () => undefined,
		getImage: (name: string) => {
			calls.push(`getImage:${name}`);
			return { inspect: async () => ({}) };
		},
		pull: async (name: string) => {
			calls.push(`pull:${name}`);
			return { stream: true };
		},
		listContainers: async () =>
			[...containers].map(([Id, container]) => ({
				Id,
				Labels: container.labels,
				State: container.running ? "running" : "exited",
			})),
		modem: {
			followProgress: (stream: unknown, onFinished: (error: Error | null, output: unknown) => void) => {
				expect(stream).toEqual({ stream: true });
				onFinished(null, []);
			},
		},
	} satisfies DockerClient;
	return { docker, calls };
}

const U2_GID = "ut-a-12345678";
const dfAboveFloor = () => `Avail\n${DISK_FLOOR_BYTES + 1}\n`;

function u2Provider(docker: DockerClient, state: SandboxStateStore) {
	return substrateDocker({
		graphId: U2_GID,
		worktree: worktreeFor(U2_GID),
		network: "published_loopback",
		docker,
		runDf: dfAboveFloor,
		sandboxState: state,
	});
}

describe("substrateDocker sandbox state (U2)", () => {
	function tmpState(): SandboxStateStore {
		const dir = mkdtempSync(join(tmpdir(), "u2-provider-"));
		tmpDirs.push(dir);
		return new SandboxStateStore(join(dir, "sandboxes.json"), (line) => {
			throw new Error(line);
		});
	}

	test("create records the sandbox after a successful start; destroy drops the entry", async () => {
		const { docker, calls } = daemonDocker();
		const state = tmpState();
		const sandboxId = await u2Provider(docker, state).create();
		expect(calls).toEqual([`getImage:substrate-sandbox:0.1`, `create:${sandboxId}`, `start:${sandboxId}`]);
		expect(state.list()).toEqual([
			{ sandbox_id: sandboxId, graph_id: U2_GID, node_id: null, task: null, opened_at: expect.any(String) },
		]);
		await u2Provider(docker, state).destroy(sandboxId);
		expect(calls).toContain(`stop:${sandboxId}`);
		expect(calls).toContain(`remove:${sandboxId}`);
		expect(state.list()).toEqual([]);
	});

	test("destroy of an already-removed sandbox takes the AutoRemove path and still drops the entry", async () => {
		const { docker } = daemonDocker();
		const state = tmpState();
		const provider = u2Provider(docker, state);
		const sandboxId = await provider.create();
		await docker.getContainer(sandboxId).remove({ force: true }); // the daemon removed it first
		await provider.destroy(sandboxId); // must not throw; entry dies with the container
		expect(state.list()).toEqual([]);
	});

	test("a failed start records nothing: only sandboxes that came up are re-adoptable", async () => {
		const { docker } = daemonDocker();
		const state = tmpState();
		const failing = {
			...docker,
			createContainer: async (body: Record<string, unknown>) => {
				const handle = await docker.createContainer(body);
				return {
					...handle,
					start: async () => {
						throw new Error("port already published");
					},
				};
			},
		} satisfies DockerClient;
		await expect(u2Provider(failing, state).create()).rejects.toThrow(/port already published/);
		expect(state.list()).toEqual([]);
	});

	test("listSandboxes reports every container with its labels and state; destroySandbox stops and removes", async () => {
		const { docker, calls } = daemonDocker();
		const provider = u2Provider(docker, tmpState());
		const sandboxId = await provider.create();
		expect(await listSandboxes(docker)).toEqual([
			{ sandbox_id: sandboxId, labels: { [GRAPH_LABEL]: U2_GID }, state: "running" },
		]);
		await destroySandbox(sandboxId, docker);
		expect(calls).toContain(`stop:${sandboxId}`);
		expect(calls).toContain(`remove:${sandboxId}`);
		expect(await listSandboxes(docker)).toEqual([]);
	});
});

describe("defaultSandboxStatePath (U2)", () => {
	test("SUBSTRATE_SANDBOX_STATE wins, else the storage root, else the unit default", () => {
		expect(defaultSandboxStatePath({ SUBSTRATE_SANDBOX_STATE: "/tmp/sandboxes.json" })).toBe("/tmp/sandboxes.json");
		expect(defaultSandboxStatePath({ RIVETKIT_STORAGE_PATH: "/var/lib/substrate/agentos" })).toBe(
			"/var/lib/substrate/agentos/sandboxes.json",
		);
		expect(defaultSandboxStatePath({})).toBe("/var/lib/substrate/agentos/sandboxes.json");
	});
});
