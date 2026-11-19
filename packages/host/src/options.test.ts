import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copyLibraryInto,
	D12_HOSTS,
	formatRoute,
	hostFunctionPermissions,
	LIBRARY_HEAD_MARKER,
	libraryCopyPlan,
	listLibrary,
	loopbackPorts,
	networkPermissions,
	parseMountRoute,
	parseRoute,
	parseTestsRoute,
	type HostDirMount,
	type Route,
	sessionEnv,
	skillMounts,
	TRACKER_PROXY_PORT,
	testRunArgv,
	trackerRoute,
	VM_LIBRARY_DIR,
	VM_SKILLS_DIR,
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

describe("sessionEnv (D-08, LANEA-07)", () => {
	const base = { model: "grok-4.6", graphId: GID, nodeId: "n1" };

	test("exactly the five keys: the model relay and the placeholder key, no real key", () => {
		const env = sessionEnv(base);
		expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "SUBSTRATE_GRAPH_ID", "SUBSTRATE_NODE_ID"]);
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3001");
		expect(env.ANTHROPIC_API_KEY).toBe("shunt");
		expect(env.ANTHROPIC_MODEL).toBe("grok-4.6");
		expect(env.SUBSTRATE_GRAPH_ID).toBe(GID);
		expect(env.SUBSTRATE_NODE_ID).toBe("n1");
	});
});

describe("loopbackPorts", () => {
	test("[7413, 3001, 7412] on a:loopback + vm_mcp, [7413, 3001] on a:loopback otherwise, [3001] on a:anthropic_key, [] on a:hostfn_proxy", () => {
		expect(TRACKER_PROXY_PORT).toBe(7412);
		for (const route of allRoutes()) {
			const ports = loopbackPorts(route);
			if (route.a === "hostfn_proxy") expect(ports).toEqual([]);
			else if (route.a === "anthropic_key") expect(ports).toEqual([3001]);
			else if (trackerRoute(route) === "vm_mcp") expect(ports).toEqual([7413, 3001, 7412]);
			else expect(ports).toEqual([7413, 3001]);
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
			if (route.a === "loopback") expected.push("tcp://127.0.0.1:7413");
			if (route.a === "loopback" || route.a === "anthropic_key") expected.push("tcp://127.0.0.1:3001");
			if (trackerRoute(route) === "vm_mcp") expected.push("tcp://127.0.0.1:7412");
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

	test("127.0.0.1:7412 appears only on tracker_route vm_mcp; no route reaches api.anthropic.com", () => {
		for (const route of allRoutes()) {
			const all = networkPermissions(route).rules.flatMap((r) => r.patterns).join(" ");
			expect(all.includes("127.0.0.1:7412")).toBe(trackerRoute(route) === "vm_mcp");
			expect(all.includes("api.anthropic.com")).toBe(false);
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

const ULTRATHINK = ["ultrathink-kickoff", "ultrathink-plan", "ultrathink-ship", "ultrathink-sync"] as const;

describe("skillMounts (D-08)", () => {
	test("nested: one read-only host_dir mount per library skill, sorted by name", () => {
		expect(skillMounts({ route: "nested", libraryDir: "/lib", names: ["b-skill", "a-skill"], reserved: [] })).toEqual([
			{ path: `${VM_SKILLS_DIR}/a-skill`, readOnly: true, plugin: { id: "host_dir", config: { hostPath: "/lib/a-skill", readOnly: true } } },
			{ path: `${VM_SKILLS_DIR}/b-skill`, readOnly: true, plugin: { id: "host_dir", config: { hostPath: "/lib/b-skill", readOnly: true } } },
		]);
		expect(VM_SKILLS_DIR).toBe("/home/agentos/.claude/skills");
	});

	test("reserved (seeded ultrathink) names are never mounted; invalid names are skipped", () => {
		const names = [...ULTRATHINK, "../x", "X", ".git", "a/b", "", "-lead", "ok-skill"];
		const mounts = skillMounts({ route: "nested", libraryDir: "/lib", names, reserved: ULTRATHINK });
		expect(mounts.map((m) => m.path)).toEqual([`${VM_SKILLS_DIR}/ok-skill`]);
	});

	test("sibling: exactly one read-only mount of the whole library whatever the names", () => {
		const expected: HostDirMount[] = [{ path: VM_LIBRARY_DIR, readOnly: true, plugin: { id: "host_dir", config: { hostPath: "/lib", readOnly: true } } }];
		expect(skillMounts({ route: "sibling", libraryDir: "/lib", names: ["a", "b", "c"], reserved: [] })).toEqual(expected);
		expect(skillMounts({ route: "sibling", libraryDir: "/lib/", names: [], reserved: [] })).toEqual(expected);
		expect(VM_LIBRARY_DIR).toBe("/home/agentos/agent-skills");
	});

	test("copy: no mounts; every mount any route builds is read-only and confined to the library dir", () => {
		const names = ["a-skill", "b-skill", "../../var/lib/substrate", "ultrathink-sync"];
		expect(skillMounts({ route: "copy", libraryDir: "/lib", names, reserved: ULTRATHINK })).toEqual([]);
		for (const route of ["nested", "sibling", "copy"] as const) {
			for (const mount of skillMounts({ route, libraryDir: "/lib", names, reserved: ULTRATHINK })) {
				expect(mount.readOnly).toBe(true);
				expect(mount.plugin.config.readOnly).toBe(true);
				expect(mount.plugin.config.hostPath === "/lib" || /^\/lib\/[a-z0-9][a-z0-9-]*$/.test(mount.plugin.config.hostPath)).toBe(true);
			}
		}
	});
});

describe("listLibrary (D-08)", () => {
	test("sorted names of real subdirectories holding SKILL.md; .git, README.md, dirs without SKILL.md and symlinks ignored", () => {
		const dir = mkdtempSync(join(tmpdir(), "options-04-06-"));
		try {
			for (const name of ["b-skill", "a-skill", "no-skill-md", ".git"]) mkdirSync(join(dir, name));
			writeFileSync(join(dir, "b-skill", "SKILL.md"), "b");
			writeFileSync(join(dir, "a-skill", "SKILL.md"), "a");
			writeFileSync(join(dir, ".git", "SKILL.md"), "not a skill");
			writeFileSync(join(dir, "no-skill-md", "README.md"), "x");
			writeFileSync(join(dir, "README.md"), "library");
			symlinkSync(join(dir, "a-skill"), join(dir, "linked-skill"));
			expect(listLibrary(dir)).toEqual(["a-skill", "b-skill"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing library dir lists nothing", () => {
		expect(listLibrary(join(tmpdir(), "options-04-06-missing-library"))).toEqual([]);
	});
});

describe("parseMountRoute", () => {
	test("nested, sibling and copy pass; the spike's none selects copy; anything else throws", () => {
		expect(parseMountRoute("nested")).toBe("nested");
		expect(parseMountRoute("sibling")).toBe("sibling");
		expect(parseMountRoute("copy")).toBe("copy");
		expect(parseMountRoute("none")).toBe("copy");
		for (const bad of ["", "Nested", "rw", "nested,sibling"]) expect(() => parseMountRoute(bad)).toThrow(/mount route/);
	});
});

describe("libraryCopyPlan (D-08 copy route)", () => {
	test("only git-tracked <valid name>/<rel> files outside reserved names, sorted, confined to the library", () => {
		const files = [
			"b-skill/SKILL.md",
			"a-skill/SKILL.md",
			"a-skill/refs/x.md",
			"README.md",
			".git/config",
			"ultrathink-sync/SKILL.md",
			"X/SKILL.md",
			"../e/SKILL.md",
			"a-skill/../../etc/passwd",
			"a-skill/.git/config",
			"a-skill/./SKILL.md",
			"a-skill//SKILL.md",
			"/abs/SKILL.md",
		];
		const plan = libraryCopyPlan({ libraryDir: "/lib", files, reserved: ["ultrathink-sync"] });
		expect(plan).toEqual([
			{ hostPath: "/lib/a-skill/SKILL.md", vmPath: `${VM_LIBRARY_DIR}/a-skill/SKILL.md` },
			{ hostPath: "/lib/a-skill/refs/x.md", vmPath: `${VM_LIBRARY_DIR}/a-skill/refs/x.md` },
			{ hostPath: "/lib/b-skill/SKILL.md", vmPath: `${VM_LIBRARY_DIR}/b-skill/SKILL.md` },
		]);
		for (const entry of plan) {
			expect(entry.hostPath.startsWith("/lib/")).toBe(true);
			expect(entry.vmPath.startsWith(`${VM_LIBRARY_DIR}/`)).toBe(true);
			for (const path of [entry.hostPath, entry.vmPath]) {
				expect(path.split("/").includes("..")).toBe(false);
				expect(path.split("/").includes(".git")).toBe(false);
			}
		}
	});
});

type FakeCall = { op: "readFile" | "writeFile" | "writeFiles" | "mkdir"; path?: string; paths?: string[]; recursive?: boolean | undefined };

/** In-memory stand-in for rivet's VM filesystem (structural: no rivet import). */
function fakeTarget(opts: { marker?: string; failPaths?: string[]; rejectWriteFiles?: boolean; rejectMkdir?: boolean } = {}) {
	const files = new Map<string, Uint8Array | string>();
	if (opts.marker !== undefined) files.set(LIBRARY_HEAD_MARKER, opts.marker);
	const calls: FakeCall[] = [];
	const target = {
		readFile: async (path: string) => {
			calls.push({ op: "readFile", path });
			const value = files.get(path);
			if (value === undefined) throw new Error("ENOENT");
			return typeof value === "string" ? new TextEncoder().encode(value) : value;
		},
		writeFile: async (path: string, content: string | Uint8Array) => {
			calls.push({ op: "writeFile", path });
			files.set(path, content);
		},
		writeFiles: async (entries: { path: string; content: Uint8Array }[]) => {
			calls.push({ op: "writeFiles", paths: entries.map((e) => e.path) });
			if (opts.rejectWriteFiles) throw new Error("batch rejected");
			return entries.map((entry) => {
				if (opts.failPaths?.includes(entry.path)) return { path: entry.path, success: false, error: "EIO" };
				files.set(entry.path, entry.content);
				return { path: entry.path, success: true };
			});
		},
		mkdir: async (path: string, options?: { recursive?: boolean }) => {
			calls.push({ op: "mkdir", path, recursive: options?.recursive });
			if (opts.rejectMkdir) throw new Error("mkdir rejected");
		},
	};
	const marker = () => {
		const value = files.get(LIBRARY_HEAD_MARKER);
		return value === undefined ? undefined : typeof value === "string" ? value : new TextDecoder().decode(value);
	};
	return { target, calls, files, marker };
}

function entriesOf(n: number) {
	return Array.from({ length: n }, (_, i) => {
		const rel = `s${i % 3}/d${i % 2}/f${String(i).padStart(3, "0")}.md`;
		return { hostPath: `/lib/${rel}`, vmPath: `${VM_LIBRARY_DIR}/${rel}` };
	});
}
const readHost = (path: string) => new TextEncoder().encode(`bytes of ${path}`);

describe("copyLibraryInto (D-08 copy route, checker I17)", () => {
	test("a VM already holding the current head is skipped with no write", async () => {
		const fake = fakeTarget({ marker: "abc123" });
		expect(await copyLibraryInto(fake.target, entriesOf(5), "abc123", readHost)).toEqual({ copied: 0, skipped: true, failed: [] });
		expect(fake.calls.filter((c) => c.op !== "readFile")).toEqual([]);
		expect(LIBRARY_HEAD_MARKER).toBe("/home/agentos/agent-skills/.library-head");
	});

	test("stale marker: cleared first, parent dirs made once each (sorted) before any file write, batches ≤ 200, marker = head last", async () => {
		const fake = fakeTarget({ marker: "old-head" });
		const entries = entriesOf(450);
		expect(await copyLibraryInto(fake.target, entries, "new-head", readHost)).toEqual({ copied: 450, skipped: false, failed: [] });
		const writes = fake.calls.filter((c) => c.op !== "readFile");
		expect(writes[0]).toEqual({ op: "writeFile", path: LIBRARY_HEAD_MARKER });
		const mkdirs = writes.filter((c) => c.op === "mkdir");
		const dirs = [...new Set([VM_LIBRARY_DIR, ...entries.map((e) => e.vmPath.slice(0, e.vmPath.lastIndexOf("/")))])].sort();
		expect(mkdirs.map((c) => c.path)).toEqual(dirs);
		expect(mkdirs.every((c) => c.recursive === true)).toBe(true);
		const firstBatch = writes.findIndex((c) => c.op === "writeFiles");
		expect(writes.slice(1, firstBatch).every((c) => c.op === "mkdir")).toBe(true);
		expect(writes.slice(1, firstBatch)).toHaveLength(dirs.length);
		const batches = writes.filter((c) => c.op === "writeFiles").map((c) => c.paths ?? []);
		expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
		expect(batches.flat()).toEqual(entries.map((e) => e.vmPath));
		expect(writes.at(-1)).toEqual({ op: "writeFile", path: LIBRARY_HEAD_MARKER });
		expect(fake.marker()).toBe("new-head");
		expect(new TextDecoder().decode(fake.files.get(entries[7]?.vmPath ?? "") as Uint8Array)).toBe(`bytes of ${entries[7]?.hostPath}`);
	});

	test("first boot (no marker): copies everything and writes the marker", async () => {
		const fake = fakeTarget();
		expect(await copyLibraryInto(fake.target, entriesOf(3), "h1", readHost)).toEqual({ copied: 3, skipped: false, failed: [] });
		expect(fake.marker()).toBe("h1");
	});

	test("one failed BatchWriteResult: marker stays empty, failed names the path, the next call copies again", async () => {
		const entries = entriesOf(4);
		const bad = entries[2]?.vmPath ?? "";
		const fake = fakeTarget({ marker: "old-head", failPaths: [bad] });
		const first = await copyLibraryInto(fake.target, entries, "new-head", readHost);
		expect(first).toEqual({ copied: 3, skipped: false, failed: [bad] });
		expect(fake.marker()).toBe("");
		const again = await copyLibraryInto(fake.target, entries, "new-head", readHost);
		expect(again.skipped).toBe(false);
		expect(again.failed).toEqual([bad]);
	});

	test("a writeFiles or mkdir rejection propagates with the marker left empty", async () => {
		const batch = fakeTarget({ marker: "old-head", rejectWriteFiles: true });
		await expect(copyLibraryInto(batch.target, entriesOf(3), "new-head", readHost)).rejects.toThrow(/batch rejected/);
		expect(batch.marker()).toBe("");
		const mk = fakeTarget({ marker: "old-head", rejectMkdir: true });
		await expect(copyLibraryInto(mk.target, entriesOf(3), "new-head", readHost)).rejects.toThrow(/mkdir rejected/);
		expect(mk.marker()).toBe("");
		expect(mk.calls.some((c) => c.op === "writeFiles")).toBe(false);
	});
});
