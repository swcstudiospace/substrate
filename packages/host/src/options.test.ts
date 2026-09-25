import { describe, expect, test } from "bun:test";
import {
	D12_HOSTS,
	formatRoute,
	hostFunctionPermissions,
	loopbackPorts,
	networkPermissions,
	parseRoute,
	parseTestsRoute,
	type Route,
	sessionEnv,
	TRACKER_PROXY_PORT,
	testRunArgv,
	trackerRoute,
	worktreeFor,
} from "./options.ts";

const A = ["loopback", "hostfn_proxy", "anthropic_key"] as const;
const B = ["hooks", "prompt_hostfn", "host_after_turn"] as const;
const C = ["vm_git", "sandbox_git", "hostfn_commit"] as const;
const S = ["mcp", "hostfn"] as const;

/** Every one of the 3 × 3 × 3 × 2 = 54 grammatical routes (36 distinct a/b/s combinations × c). */
function allRoutes(): Route[] {
	const routes: Route[] = [];
	for (const a of A) for (const b of B) for (const c of C) for (const s of S) routes.push({ a, b, c, s });
	return routes;
}

const SPIKE_ROUTE = "a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn";
const VM_MCP_ROUTE = parseRoute("a:loopback,b:hooks,c:vm_git,s:mcp");
const GID = "ut-a-12345678";

function tcpPatterns(route: Route): string[] {
	const perms = networkPermissions(route);
	return perms.rules
		.filter((r) => r.mode === "allow" && r.operations.includes("*"))
		.flatMap((r) => r.patterns)
		.filter((p) => p.startsWith("tcp://"))
		.sort();
}

describe("parseRoute", () => {
	test("accepts every 03-01 route value and round-trips through formatRoute", () => {
		expect(allRoutes().length).toBe(54);
		for (const route of allRoutes()) {
			expect(parseRoute(formatRoute(route))).toEqual(route);
		}
		expect(parseRoute(SPIKE_ROUTE)).toEqual({ a: "loopback", b: "prompt_hostfn", c: "hostfn_commit", s: "hostfn" });
	});

	test("rejects a:loopback alone and an unknown segment value", () => {
		expect(() => parseRoute("a:loopback")).toThrow(/segments/);
		expect(() => parseRoute("a:loopback,b:hooks,c:vm_git,s:telepathy")).toThrow(/s:telepathy/);
		expect(() => parseRoute("a:loopback,b:hooks,x:vm_git,s:mcp")).toThrow(/segment 3/);
	});

	test("parseTestsRoute accepts sandbox|oneshot|none only", () => {
		expect(parseTestsRoute("sandbox")).toBe("sandbox");
		expect(parseTestsRoute("oneshot")).toBe("oneshot");
		expect(parseTestsRoute("none")).toBe("none");
		expect(() => parseTestsRoute("docker")).toThrow(/sandbox\|oneshot\|none/);
	});
});

describe("trackerRoute (D-10)", () => {
	test("vm_mcp exactly for b:hooks + s:mcp, host for every other of the 36 a/b/s combinations", () => {
		const seen = new Set<string>();
		for (const route of allRoutes()) {
			seen.add(`${route.a}/${route.b}/${route.s}`);
			const expected = route.b === "hooks" && route.s === "mcp" ? "vm_mcp" : "host";
			expect(trackerRoute(route)).toBe(expected);
		}
		expect(seen.size).toBe(18);
		expect(trackerRoute(parseRoute(SPIKE_ROUTE))).toBe("host");
		expect(trackerRoute(VM_MCP_ROUTE)).toBe("vm_mcp");
	});
});

describe("sessionEnv (D-08)", () => {
	const base = { model: "grok-4.6", graphId: GID, nodeId: "n1" };

	test("exactly the five keys on every route", () => {
		for (const route of allRoutes()) {
			const env = sessionEnv({ ...base, route, directKey: "sk-ant-dummy-000000000000000000000000" });
			expect(Object.keys(env).sort()).toEqual([
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_BASE_URL",
				"ANTHROPIC_MODEL",
				"SUBSTRATE_GRAPH_ID",
				"SUBSTRATE_NODE_ID",
			]);
			expect(env.ANTHROPIC_MODEL).toBe("grok-4.6");
			expect(env.SUBSTRATE_GRAPH_ID).toBe(GID);
			expect(env.SUBSTRATE_NODE_ID).toBe("n1");
		}
	});

	test("loopback and hostfn_proxy use the relay and the dummy key, ignoring a supplied directKey", () => {
		for (const a of ["loopback", "hostfn_proxy"] as const) {
			const route: Route = { a, b: "prompt_hostfn", c: "hostfn_commit", s: "hostfn" };
			const env = sessionEnv({ ...base, route, directKey: "sk-ant-supplied-00000000000000000000" });
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3001");
			expect(env.ANTHROPIC_API_KEY).toBe("shunt");
		}
	});

	test("anthropic_key uses api.anthropic.com and the supplied key, and throws without one", () => {
		const route: Route = { a: "anthropic_key", b: "prompt_hostfn", c: "hostfn_commit", s: "hostfn" };
		const env = sessionEnv({ ...base, route, directKey: "sk-ant-supplied-00000000000000000000" });
		expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-supplied-00000000000000000000");
		expect(() => sessionEnv({ ...base, route })).toThrow("SUBSTRATE_VM_ANTHROPIC_API_KEY required on route a:anthropic_key");
	});
});

describe("loopbackPorts", () => {
	test("[7410, 3001, 7412] on a:loopback + vm_mcp, [7410, 3001] on a:loopback otherwise, [] off a:loopback", () => {
		expect(TRACKER_PROXY_PORT).toBe(7412);
		for (const route of allRoutes()) {
			const ports = loopbackPorts(route);
			if (route.a !== "loopback") expect(ports).toEqual([]);
			else if (trackerRoute(route) === "vm_mcp") expect(ports).toEqual([7410, 3001, 7412]);
			else expect(ports).toEqual([7410, 3001]);
		}
	});
});

describe("networkPermissions (D-12)", () => {
	test("default deny; exactly the five D-12 hosts on :443 plus the route's loopback ports; no tcp://** connect", () => {
		expect(D12_HOSTS).toEqual(["mcp.notion.com", "mcp.linear.app", "api.greptile.com", "github.com", "api.github.com"]);
		for (const route of allRoutes()) {
			const perms = networkPermissions(route);
			expect(perms.default).toBe("deny");
			const expected = D12_HOSTS.map((h) => `tcp://${h}:443`);
			if (route.a === "loopback") expected.push("tcp://127.0.0.1:7410", "tcp://127.0.0.1:3001");
			if (trackerRoute(route) === "vm_mcp") expected.push("tcp://127.0.0.1:7412");
			if (route.a === "anthropic_key") expected.push("tcp://api.anthropic.com:443");
			expect(tcpPatterns(route)).toEqual(expected.sort());
			for (const rule of perms.rules) {
				if (rule.patterns.includes("tcp://**")) {
					expect(rule.operations).toEqual(["listen"]);
					expect(rule.operations).not.toContain("connect");
					expect(rule.operations).not.toContain("*");
				}
			}
		}
	});

	test("127.0.0.1:7412 appears only on tracker_route vm_mcp; api.anthropic.com only on a:anthropic_key", () => {
		for (const route of allRoutes()) {
			const all = networkPermissions(route).rules.flatMap((r) => r.patterns).join(" ");
			expect(all.includes("127.0.0.1:7412")).toBe(trackerRoute(route) === "vm_mcp");
			expect(all.includes("api.anthropic.com")).toBe(route.a === "anthropic_key");
		}
	});
});

describe("hostFunctionPermissions", () => {
	test("allows only substrate:* and the configured sandbox collection (03-03: <collection>:* grammar)", () => {
		const perms = hostFunctionPermissions("sandbox");
		expect(perms.default).toBe("deny");
		expect(perms.rules).toEqual([{ mode: "allow", operations: ["invoke"], patterns: ["substrate:*", "sandbox:*"] }]);
		expect(hostFunctionPermissions("box").rules[0]?.patterns).toEqual(["substrate:*", "box:*"]);
	});
});

describe("testRunArgv (tests_route oneshot)", () => {
	const worktree = worktreeFor(GID);
	const nodeModules = "/root/src/repos/agent-substrate/node_modules";

	test("is exactly the docker run argv with a read-only worktree and node_modules", () => {
		expect(testRunArgv({ graphId: GID, worktree, nodeModules, paths: ["packages/host/src/seed.test.ts"] })).toEqual([
			"docker",
			"run",
			"--rm",
			"--network",
			"none",
			"--label",
			`substrate.test_run=${GID}`,
			"--tmpfs",
			"/tmp",
			"-v",
			`${worktree}:/work:ro`,
			"-v",
			`${nodeModules}:/work/node_modules:ro`,
			"-w",
			"/work",
			"substrate-sandbox:0.1",
			"bun",
			"test",
			"packages/host/src/seed.test.ts",
		]);
	});

	test("omits the node_modules pair when nodeModules is null", () => {
		const argv = testRunArgv({ graphId: GID, worktree, nodeModules: null, paths: ["a.test.ts", "b/c.test.ts"] });
		expect(argv.filter((a) => a === "-v")).toHaveLength(1);
		expect(argv).not.toContain(`${nodeModules}:/work/node_modules:ro`);
		expect(argv.slice(-3)).toEqual(["test", "a.test.ts", "b/c.test.ts"]);
	});

	test("rejects an absolute path, a .. segment, a non-.test.ts path, more than 8 paths and a foreign worktree", () => {
		const ok = { graphId: GID, worktree, nodeModules: null };
		expect(() => testRunArgv({ ...ok, paths: ["/etc/passwd.test.ts"] })).toThrow(/absolute/);
		expect(() => testRunArgv({ ...ok, paths: ["../x.test.ts"] })).toThrow(/\.\./);
		expect(() => testRunArgv({ ...ok, paths: ["a/../b.test.ts"] })).toThrow(/\.\./);
		expect(() => testRunArgv({ ...ok, paths: ["src/index.ts"] })).toThrow(/\.test\.ts/);
		expect(() => testRunArgv({ ...ok, paths: Array.from({ length: 9 }, (_, i) => `t${i}.test.ts`) })).toThrow(/8/);
		expect(() => testRunArgv({ ...ok, worktree: "/tmp/x", paths: ["a.test.ts"] })).toThrow(/worktree/);
		expect(() => testRunArgv({ ...ok, worktree: `${worktree}/../other`, paths: ["a.test.ts"] })).toThrow(/worktree/);
		expect(testRunArgv({ ...ok, paths: Array.from({ length: 8 }, (_, i) => `t${i}.test.ts`) })).toHaveLength(8 + 16);
	});
});
