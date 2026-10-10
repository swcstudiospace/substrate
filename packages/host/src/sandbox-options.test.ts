import { describe, expect, test } from "bun:test";
import {
	buildContainerSpec,
	GRAPH_LABEL,
	SANDBOX_NETWORK,
	WORKTREES_ROOT,
	type ContainerSpecOptions,
} from "./sandbox-options.ts";

const graphId = "ut-abc-12345678";
const base: ContainerSpecOptions = {
	graphId,
	worktree: `${WORKTREES_ROOT}/${graphId}`,
	token: "t",
	image: "substrate-sandbox:0.1",
	network: "published_loopback",
};

type Spec = {
	Cmd: string[];
	Labels: Record<string, string>;
	HostConfig: {
		PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]>;
		Binds: string[];
		Privileged?: boolean;
		AutoRemove?: boolean;
		NetworkMode?: string;
	};
};

const spec = (overrides: Partial<ContainerSpecOptions> = {}) =>
	buildContainerSpec({ ...base, ...overrides }) as unknown as Spec;

describe("buildContainerSpec — published_loopback", () => {
	test("publishes the command port on host loopback only", () => {
		const bindings = spec().HostConfig.PortBindings?.["3000/tcp"];
		expect(bindings).toHaveLength(1);
		expect(bindings?.[0]?.HostIp).toBe("127.0.0.1");
		expect(bindings?.[0]?.HostPort ?? "").toMatch(/^(|[0-9]+)$/);
	});

	test("every port binding carries HostIp 127.0.0.1", () => {
		for (const list of Object.values(spec().HostConfig.PortBindings ?? {})) {
			for (const binding of list) expect(binding.HostIp).toBe("127.0.0.1");
		}
	});

	test("starts the server with the per-container token and never without one", () => {
		const cmd = spec().Cmd;
		const i = cmd.indexOf("--token");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(cmd[i + 1]).toBe("t");
		expect(cmd).not.toContain("--no-token");
	});

	test("turns the command server's telemetry off", () => {
		expect(spec().Cmd).toContain("--no-telemetry");
	});

	test("labels the container with its graph id", () => {
		expect(spec().Labels[GRAPH_LABEL]).toBe(graphId);
	});

	test("binds the worktree at /work, unprivileged, auto-removed, no docker socket", () => {
		const hc = spec().HostConfig;
		expect(hc.Binds).toContain(`${WORKTREES_ROOT}/${graphId}:/work`);
		expect(hc.Privileged ?? false).toBe(false);
		expect(hc.AutoRemove).toBe(true);
		expect(hc.Binds.some((b) => b.includes("docker.sock"))).toBe(false);
	});
});

describe("buildContainerSpec — internal", () => {
	test("joins the internal network and publishes no port", () => {
		const hc = spec({ network: "internal" }).HostConfig;
		expect(hc.NetworkMode).toBe(SANDBOX_NETWORK);
		expect(hc.PortBindings).toBeUndefined();
	});
});

describe("buildContainerSpec — read-only binds", () => {
	test("appends each read-only bind with :ro", () => {
		const hc = spec({ readOnlyBinds: ["/root/src/repos/agent-substrate/node_modules:/work/node_modules"] }).HostConfig;
		expect(hc.Binds).toEqual([
			`${WORKTREES_ROOT}/${graphId}:/work`,
			"/root/src/repos/agent-substrate/node_modules:/work/node_modules:ro",
		]);
	});

	test("refuses the docker socket even as a read-only bind", () => {
		expect(() => spec({ readOnlyBinds: ["/var/run/docker.sock:/var/run/docker.sock"] })).toThrow();
	});
});

describe("buildContainerSpec — refusals", () => {
	test.each(["../x", "a b", "", ".hidden", "x.lock", "x.", "a..b"])("refuses graph id %p", (bad) => {
		expect(() => spec({ graphId: bad, worktree: `${WORKTREES_ROOT}/${bad}` })).toThrow();
	});

	test("refuses a worktree outside the worktrees root", () => {
		expect(() => spec({ worktree: `/tmp/${graphId}` })).toThrow();
		expect(() => spec({ worktree: `/var/lib/substrate/${graphId}` })).toThrow();
	});

	test("refuses a worktree that does not end in the graph id", () => {
		expect(() => spec({ worktree: `${WORKTREES_ROOT}/ut-other-00000000` })).toThrow();
		expect(() => spec({ worktree: `${WORKTREES_ROOT}/${graphId}/sub` })).toThrow();
	});

	test("refuses an empty token", () => {
		expect(() => spec({ token: "" })).toThrow();
	});
});
