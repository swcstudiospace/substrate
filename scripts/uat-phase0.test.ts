#!/usr/bin/env bun
/**
 * Server-free units for `scripts/uat-phase0.ts`: classifier cases,
 * live-guard refusals, scenario parsing, tag format, the report renderer
 * (tokens, bodies and non-loopback hosts never land) and the expectation
 * functions on canned bodies.
 */
import { describe, expect, test } from "bun:test";
import {
	classifyTarget,
	countConversation,
	expectBackfillCounts,
	expectCrossSurface,
	expectGraphHasNodes,
	expectGraphIdentifiers,
	expectHealthz,
	expectMemorySearch,
	expectMcpTarget,
	expectOutageBounds,
	expectToolsList,
	flag,
	namesSubstrateToken,
	parseOptions,
	parseScenarios,
	parseUatBody,
	PLUGIN_HANG_GUARD_MS,
	raceGuard,
	refuseWriteScenarios,
	renderReport,
	resolvePlugin,
	runChild,
	runRepo,
	runTag,
	sanitizeHost,
	scratchGitEnv,
	UAT_PRODUCTION_PORTS,
	validateTag,
	V1_TOOLS,
} from "./uat-phase0.ts";
import { PRODUCTION_PORTS } from "./rehearsal.ts";
import { mapNotionRows } from "../packages/mcp-server/src/backfill.ts";
import fixture from "./uat/fixtures/notion-rows.json";

describe("classifier", () => {
	test("production ports are production", () => {
		for (const port of PRODUCTION_PORTS) {
			expect(classifyTarget(`http://127.0.0.1:${port}`)).toBe("production");
		}
	});
	test("non-loopback hosts are production", () => {
		expect(classifyTarget("http://192.168.1.10:17410")).toBe("production");
		expect(classifyTarget("http://substrate.example.com:17410")).toBe("production");
	});
	test("loopback scratch ports are scratch", () => {
		expect(classifyTarget("http://127.0.0.1:17410")).toBe("scratch");
		expect(classifyTarget("http://localhost:19999")).toBe("scratch");
		expect(classifyTarget("http://[::1]:19999")).toBe("scratch");
	});
	test("the ports constant is referenced, not copied", () => {
		expect([...UAT_PRODUCTION_PORTS]).toEqual([...PRODUCTION_PORTS]);
		expect(UAT_PRODUCTION_PORTS).toContain(7410);
	});
});

describe("live guard", () => {
	test("write scenarios refuse on production without --live", () => {
		for (const id of [1, 3, 6, 8]) {
			expect(refuseWriteScenarios([id], "production", undefined)).not.toBeNull();
		}
	});
	test("read-only scenarios pass on production without --live", () => {
		expect(refuseWriteScenarios([2, 4, 5, 7], "production", undefined)).toBeNull();
	});
	test("writes pass on production with an approval reference", () => {
		expect(refuseWriteScenarios([1, 3, 6, 8], "production", "op-2026-10-09")).toBeNull();
	});
	test("writes pass on scratch without --live", () => {
		expect(refuseWriteScenarios([1, 3, 6, 8], "scratch", undefined)).toBeNull();
	});
});

describe("scenario parsing", () => {
	test("explicit lists parse, sort and dedupe", () => {
		expect(parseScenarios("8,1,3,1")).toEqual([1, 3, 8]);
	});
	test("empty means the target default", () => {
		expect(parseScenarios(undefined)).toBeNull();
		expect(parseScenarios("  ")).toBeNull();
	});
	test("out-of-range ids refuse", () => {
		expect(() => parseScenarios("0,9")).toThrow();
		expect(() => parseScenarios("abc")).toThrow();
	});
	test("options require a tag and accept the live reference", () => {
		const opts = parseOptions(["--tag", "p20", "--scenarios", "1,3", "--report", "/tmp/x.md", "--live", "op-1"]);
		expect(opts).toMatchObject({ tag: "p20", scenarios: [1, 3], report: "/tmp/x.md", live: "op-1" });
		expect(() => parseOptions([])).toThrow();
	});
	test("an option-like or empty live value refuses instead of permitting writes", () => {
		expect(() => parseOptions(["--tag", "p20", "--live", "--graph", "gid"])).toThrow("--live takes an approval reference");
		expect(() => parseOptions(["--tag", "p20", "--live", ""])).toThrow("--live takes an approval reference");
		expect(() => parseOptions(["--tag", "p20", "--live", "--tag"])).toThrow("--live takes an approval reference");
	});
	test("flag reads the following argv entry", () => {
		expect(flag(["--tag", "abc"], "--tag")).toBe("abc");
		expect(flag(["--tag"], "--tag")).toBeUndefined();
	});
});

describe("tag format", () => {
	test("run tag prefixes every write", () => {
		expect(runTag("p20")).toBe("uat-p20");
		expect(runRepo("p20")).toBe("uat/p20-repo");
	});
	test("tags are path-safe tokens", () => {
		expect(validateTag("p20-abc")).toBe("p20-abc");
		for (const bad of ["", "has space", "semi;colon", "x".repeat(65), "-lead"]) {
			expect(() => validateTag(bad)).toThrow();
		}
	});
});

describe("report renderer", () => {
	test("reports hold verdicts and counts, never tokens or bodies", () => {
		const { markdown, json } = renderReport({
			tag: "uat-p20",
			targetKind: "scratch",
			targetPort: 17410,
			targetHost: "127.0.0.1",
			live: null,
			plugin: { version: "0.3.0", commit: "abc123" },
			scenarios: [{ id: 1, name: "x", verdict: "pass", evidence: ["status 200", "3 tools"], elapsedMs: 12 }],
			passed: 1,
			failed: 0,
		});
		expect(markdown).toContain("| 1 x | pass |");
		expect(markdown).toContain("1 passed, 0 failed of 1");
		expect(`${markdown}${json}`.toLowerCase()).not.toContain("bearer");
		expect(json).not.toContain("summary");
	});
	test("non-loopback hosts are dropped", () => {
		expect(sanitizeHost("127.0.0.1")).toBe("127.0.0.1");
		expect(sanitizeHost("[::1]")).toBe("::1");
		expect(sanitizeHost("localhost")).toBe("localhost");
		expect(sanitizeHost("10.0.0.5")).toBe("[non-loopback]");
		expect(sanitizeHost("substrate.example.com")).toBe("[non-loopback]");
		const { markdown } = renderReport({
			tag: "uat-x",
			targetKind: "production",
			targetPort: 7410,
			targetHost: sanitizeHost("10.0.0.5"),
			live: "op-1",
			plugin: { version: null, commit: null },
			scenarios: [],
			passed: 0,
			failed: 0,
		});
		expect(markdown).not.toContain("10.0.0.5");
		expect(markdown).toContain("[non-loopback]");
	});
});

describe("expectations on canned bodies", () => {
	test("tools/list needs the nine v1 names as a superset", () => {
		expect(expectToolsList([...V1_TOOLS, "graph_bind", "extra"])).toEqual([]);
		expect(expectToolsList(["memory_brief"])).toContain("missing v1 tool events_emit");
		expect(expectToolsList(null)).toHaveLength(1);
	});
	test("healthz needs the index, the ledger and the lock", () => {
		expect(expectHealthz({ index: true, greptime: true, appendOnly: true })).toEqual([]);
		expect(expectHealthz({ index: true, greptime: false, appendOnly: true })).toContain("greptime is not true");
		expect(expectHealthz(null)).toHaveLength(3);
	});
	test("outage answers stay inside budget", () => {
		expect(expectOutageBounds(120)).toEqual([]);
		expect(expectOutageBounds(1750)).toEqual([]);
		expect(expectOutageBounds(1751)).toHaveLength(1);
	});
	test("cross-surface briefs name the edit line and the holder", () => {
		const brief = `# brief for uat-p20-repo\n\n- cursor file.edit src/a.ts\n- n1 held by claude-code\n`;
		expect(expectCrossSurface(brief, "uat-p20-repo", "claude-code")).toEqual([]);
		expect(expectCrossSurface("nothing here", "uat-p20-repo", "claude-code").length).toBeGreaterThan(0);
	});
	test("SSE bodies parse like the smoke's", () => {
		expect(parseUatBody(`{"ok":true}`)).toEqual({ ok: true });
		expect(parseUatBody(`event: message\ndata: {"stored":true}\n\ndata: {"stored":false}\n`)).toEqual({ stored: false });
	});
});

describe("fixture", () => {
	test("placeholder rows validate through the pure row mapper", () => {
		const plans = mapNotionRows(fixture as never);
		expect(plans).toHaveLength(2);
		const nodes = plans.flatMap((plan) => plan.nodes);
		expect(nodes.length).toBeGreaterThanOrEqual(3);
		expect(nodes.filter((node) => typeof node.linear_identifier === "string")).toHaveLength(3);
		expect(plans.every((plan) => plan.repo === "UAT_FIXTURE_REPO")).toBe(true);
	});
	test("no real identifiers leak into the fixture", () => {
		const text = JSON.stringify(fixture);
		expect(text).not.toContain("uat-p20");
		expect(text).toContain("UAT_FIXTURE_GRAPH_A");
		expect(text).toContain("UAT_FIXTURE_REPO");
	});
});

describe("plugin resolution", () => {
	test("a fabricated registry resolves with dir, version and commit", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "uat-home-"));
		const installPath = mkdtempSync(join(tmpdir(), "uat-plugin-"));
		mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({ plugins: { "ultrathink@ultrathink": [{ installPath, version: "9.9.9", gitCommitSha: "cafef00d" }] } }),
		);
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			const plugin = resolvePlugin();
			expect(plugin.dir).toBe(installPath);
			expect(plugin.version).toBe("9.9.9");
			expect(plugin.commit).toBe("cafef00d");
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
	});
	test("an empty home with no fallback documents clean-checkout behavior", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "uat-empty-home-"));
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			const plugin = resolvePlugin(home, join(home, "no-fallback"));
			expect(plugin.dir).toBeNull();
			expect(plugin.version).toBeNull();
			expect(plugin.commit).toBeNull();
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
	});
});

describe("memory search shape", () => {
	test("a top-level array with rows passes", () => {
		expect(expectMemorySearch([{ id: "mem_1" }, { id: "mem_2" }])).toEqual([]);
	});
	test("an empty array fails", () => {
		expect(expectMemorySearch([])).toEqual(["memory_search returned 0 rows"]);
	});
	test("a non-array body fails", () => {
		expect(expectMemorySearch({ entries: [{ id: "mem_1" }] })).toEqual(["memory_search returned -1 rows"]);
		expect(expectMemorySearch(null)).toEqual(["memory_search returned -1 rows"]);
	});
});

describe("graph read strictness", () => {
	test("graph_get needs a non-empty nodes array", () => {
		expect(expectGraphHasNodes({ nodes: [{ node_id: "n1" }] })).toEqual([]);
		expect(expectGraphHasNodes({ nodes: [] })).toHaveLength(1);
		expect(expectGraphHasNodes(null)).toHaveLength(1);
		expect(expectGraphHasNodes({})).toHaveLength(1);
	});
	test("kickoff graphs need a string Linear identifier", () => {
		expect(expectGraphIdentifiers({ nodes: [{ node_id: "n1", linear_identifier: "SPE-1" }] })).toEqual([]);
		expect(expectGraphIdentifiers({ nodes: [{ node_id: "n1" }] })).toHaveLength(1);
		expect(expectGraphIdentifiers({ nodes: [] })).toHaveLength(1);
	});
	test("backfill read-back needs nodes and identifiers", () => {
		expect(expectBackfillCounts(3, 2)).toEqual([]);
		expect(expectBackfillCounts(0, 2)).toHaveLength(1);
		expect(expectBackfillCounts(3, 0)).toHaveLength(1);
		expect(expectBackfillCounts(0, 0)).toHaveLength(2);
	});
});

describe("substrate token header", () => {
	test("both supported Authorization forms name the variable", () => {
		expect(namesSubstrateToken("Bearer ${SUBSTRATE_TOKEN}")).toBe(true);
		expect(namesSubstrateToken("Bearer ${SUBSTRATE_TOKEN:-}")).toBe(true);
	});
	test("a wrong variable or empty header is rejected", () => {
		expect(namesSubstrateToken("Bearer ${OTHER_TOKEN}")).toBe(false);
		expect(namesSubstrateToken("Bearer ")).toBe(false);
		expect(namesSubstrateToken("")).toBe(false);
		expect(namesSubstrateToken(undefined)).toBe(false);
	});
});

describe("scratch git isolation", () => {
	test("the env builder pins hooksPath off shared config", () => {
		const env = scratchGitEnv("/tmp/uat6-hooks");
		expect(env).toMatchObject({
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/tmp/uat6-hooks",
		});
	});
	test("the env builder clears repository-location variables", () => {
		const env = scratchGitEnv("/tmp/uat6-hooks");
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_WORK_TREE).toBeUndefined();
		expect(env.GIT_INDEX_FILE).toBeUndefined();
		expect("GIT_DIR" in env && "GIT_WORK_TREE" in env && "GIT_INDEX_FILE" in env).toBe(true);
	});
	test("an undefined entry clears an inherited variable in the child", async () => {
		process.env.UAT_PROBE_CLEAR_ME = "inherited";
		try {
			const kept = await runChild(["sh", "-c", "echo ${UAT_PROBE_CLEAR_ME:-cleared}"], {});
			expect(kept.stdout.trim()).toBe("inherited");
			const cleared = await runChild(["sh", "-c", "echo ${UAT_PROBE_CLEAR_ME:-cleared}"], { UAT_PROBE_CLEAR_ME: undefined });
			expect(cleared.stdout.trim()).toBe("cleared");
		} finally {
			delete process.env.UAT_PROBE_CLEAR_ME;
		}
	});
});

describe("hook event read-back", () => {
	test("conversation matching filters on payload.conversation_id", () => {
		const events = [
			{ payload: { conversation_id: "uat-x-s6-conv" } },
			{ payload: { conversation_id: "other" } },
			{ payload: {} },
		];
		expect(countConversation(events, "uat-x-s6-conv")).toBe(1);
		expect(countConversation(events, "missing")).toBe(0);
		expect(countConversation(null, "uat-x-s6-conv")).toBe(0);
	});
});

describe("child deadline", () => {
	test("a failing exit propagates its status", async () => {
		const done = await runChild(["sh", "-c", "exit 3"], {});
		expect(done.status).toBe(3);
	});
	test("a sleep past a tiny timeout reports timed-out", async () => {
		const hung = await runChild(["sleep", "5"], {}, undefined, undefined, 200);
		expect(hung.status).toBe(-1);
		expect(hung.error).toBe("timed-out");
	});
	test("outage bounds hold canned elapsed values", () => {
		expect(expectOutageBounds(120)).toEqual([]);
		expect(expectOutageBounds(1751)).toHaveLength(1);
	});
});

describe("mcp entry target", () => {
	test("the projected entry passes", () => {
		expect(
			expectMcpTarget({
				type: "http",
				url: "http://127.0.0.1:7410/mcp",
				headers: { Authorization: "Bearer ${SUBSTRATE_TOKEN}" },
			}),
		).toEqual([]);
	});
	test("the url matches by suffix, never by equality", () => {
		// A hostname config against a loopback run (or the reverse) still
		// points at the target's /mcp: only scheme and path are asserted.
		expect(expectMcpTarget({ type: "http", url: "http://substrate.example.com:7410/mcp" })).toEqual([]);
		expect(expectMcpTarget({ type: "http", url: "https://substrate.example.com/mcp" })).toEqual([]);
	});
	test("a stale or non-HTTP entry fails", () => {
		expect(expectMcpTarget({ type: "http", url: "http://127.0.0.1:9999/healthz" }).length).toBeGreaterThan(0);
		expect(expectMcpTarget({ type: "http", url: "http://127.0.0.1:7410/" }).length).toBeGreaterThan(0);
		expect(expectMcpTarget({ type: "sse", url: "http://127.0.0.1:7410/mcp" }).length).toBeGreaterThan(0);
		expect(expectMcpTarget({ command: "substrate-mcp" }).length).toBeGreaterThan(0);
		expect(expectMcpTarget(null).length).toBeGreaterThan(0);
	});
	test("a bad path reports no host: reports omit non-loopback addresses", () => {
		const problems = expectMcpTarget({ type: "http", url: "http://10.9.9.9:7410/healthz" });
		expect(problems.length).toBeGreaterThan(0);
		expect(JSON.stringify(problems)).not.toContain("10.9.9.9");
	});
});

describe("hang guard", () => {
	test("the proof guard is ten seconds", () => {
		expect(PLUGIN_HANG_GUARD_MS).toBe(10_000);
	});
	test("a fast promise passes through", async () => {
		await expect(raceGuard(Promise.resolve("brief"), 50, "fast")).resolves.toBe("brief");
	});
	test("a hanging promise rejects inside the guard", async () => {
		const started = performance.now();
		await expect(raceGuard(new Promise(() => {}), 50, "hanging")).rejects.toThrow("hanging hung past 50 ms");
		expect(performance.now() - started).toBeLessThan(5000);
	});
	test("a callee rejection still rejects", async () => {
		await expect(raceGuard(Promise.reject(new Error("boom")), 50, "failing")).rejects.toThrow("boom");
	});
});
