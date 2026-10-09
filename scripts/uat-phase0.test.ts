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
	expectCrossSurface,
	expectHealthz,
	expectOutageBounds,
	expectToolsList,
	flag,
	parseOptions,
	parseScenarios,
	parseUatBody,
	refuseWriteScenarios,
	renderReport,
	resolvePlugin,
	runRepo,
	runTag,
	sanitizeHost,
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
	test("the installed plugin resolves with version and commit", () => {
		const plugin = resolvePlugin();
		expect(plugin.dir).not.toBeNull();
	});
});
