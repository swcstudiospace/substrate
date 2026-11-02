import { describe, expect, test } from "bun:test";
import {
	type Finding,
	type LeaseHold,
	buildReport,
	compareGenerations,
	compareLeases,
	compareMemory,
} from "./reconcile.ts";

/**
 * Pure reconcile core (Phase 78, U1). No I/O: every input is an in-memory
 * map or set, so these tests pin the drift semantics of D78-2 to D78-4.
 */

const hold = (surface: string, session_id: string, epoch: number): LeaseHold => ({
	surface,
	session_id,
	epoch,
});

describe("compareLeases", () => {
	test("ledger holds and index is free is drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
			new Map([["g1/n1", null]]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.comparison).toBe("lease");
		expect(findings[0]?.key).toBe("g1/n1");
		expect(findings[0]?.detail).toContain("ledger holds");
		expect(findings[0]?.detail).toContain("index is free");
	});

	test("ledger holds and index has no entry for the key is drift", () => {
		const findings = compareLeases(new Map([["g1/n1", hold("cli", "s1", 2)]]), new Map());
		expect(findings.map((f) => f.key)).toEqual(["g1/n1"]);
		expect(findings[0]?.detail).toContain("index is free");
	});

	test("index holds and ledger is free is drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", null]]),
			new Map([["g1/n1", hold("mcp", "s9", 5)]]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.key).toBe("g1/n1");
		expect(findings[0]?.detail).toContain("index holds");
		expect(findings[0]?.detail).toContain("ledger is free");
	});

	test("identity mismatch on surface is drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
			new Map([["g1/n1", hold("mcp", "s1", 2)]]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toContain("identity differs");
	});

	test("identity mismatch on session is drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
			new Map([["g1/n1", hold("cli", "s2", 2)]]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toContain("identity differs");
	});

	test("identity mismatch on epoch is drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
			new Map([["g1/n1", hold("cli", "s1", 3)]]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toContain("identity differs");
	});

	test("identical holds on both sides are not drift", () => {
		const findings = compareLeases(
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
			new Map([["g1/n1", hold("cli", "s1", 2)]]),
		);
		expect(findings).toEqual([]);
	});

	test("free on both sides is not drift, even when both maps carry the key", () => {
		const findings = compareLeases(new Map([["g1/n1", null]]), new Map([["g1/n1", null]]));
		expect(findings).toEqual([]);
	});

	test("an empty pair of maps yields no findings", () => {
		expect(compareLeases(new Map(), new Map())).toEqual([]);
	});

	test("findings come back sorted by key regardless of map insertion order", () => {
		const findings = compareLeases(
			new Map([
				["g2/n1", hold("cli", "s1", 1)],
				["g1/n2", hold("cli", "s1", 1)],
			]),
			new Map([["g1/n1", hold("mcp", "s2", 1)]]),
		);
		expect(findings.map((f) => f.key)).toEqual(["g1/n1", "g1/n2", "g2/n1"]);
	});
});

describe("compareMemory", () => {
	test("index row with no accepted ledger event is drift", () => {
		const findings = compareMemory(new Set(["m1"]), new Set());
		expect(findings).toHaveLength(1);
		expect(findings[0]?.comparison).toBe("memory");
		expect(findings[0]?.key).toBe("m1");
		expect(findings[0]?.detail).toContain("no accepted audit event");
	});

	test("accepted ledger event with no index row is drift", () => {
		const findings = compareMemory(new Set(), new Set(["m2"]));
		expect(findings).toHaveLength(1);
		expect(findings[0]?.comparison).toBe("memory");
		expect(findings[0]?.key).toBe("m2");
		expect(findings[0]?.detail).toContain("no index memory row");
	});

	test("an id present on both sides is not drift", () => {
		expect(compareMemory(new Set(["m1"]), new Set(["m1"]))).toEqual([]);
	});

	test("both directions are reported and sorted by entry id", () => {
		const findings = compareMemory(new Set(["m3", "m1"]), new Set(["m2", "m1"]));
		expect(findings.map((f) => [f.key, f.detail.includes("no accepted")])).toEqual([
			["m2", false],
			["m3", true],
		]);
	});
});

describe("compareGenerations", () => {
	test("a generation counter whose graph is absent from the index is an orphan", () => {
		const findings = compareGenerations(new Set(["g-gone"]), new Set(["g-live"]));
		expect(findings).toHaveLength(1);
		const orphan = findings[0] as Finding;
		expect(orphan.comparison).toBe("generation");
		expect(orphan.key).toBe("substrate:v1:gen:graph:g-gone");
		expect(orphan.detail).toContain("g-gone");
	});

	test("a counter whose graph is indexed is not an orphan", () => {
		expect(compareGenerations(new Set(["g1"]), new Set(["g1", "g2"]))).toEqual([]);
	});

	test("an index graph with no counter is not reported", () => {
		expect(compareGenerations(new Set(), new Set(["g1"]))).toEqual([]);
	});

	test("orphans come back sorted by key", () => {
		const findings = compareGenerations(new Set(["gB", "gA", "gC"]), new Set(["gC"]));
		expect(findings.map((f) => f.key)).toEqual([
			"substrate:v1:gen:graph:gA",
			"substrate:v1:gen:graph:gB",
		]);
	});
});

describe("buildReport", () => {
	const base = {
		generated_at: "2026-11-02T00:00:00.000Z",
		window_hours: 24,
		counts: { "ledger.lease": 3, "index.graph": 2 },
		truncated: { cache: false },
		unchecked_memory_rows: 0,
	};

	test("no findings and no truncation is clean", () => {
		const report = buildReport({ ...base, findings: [] });
		expect(report.schema).toBe("substrate.reconcile.report.v1");
		expect(report.findings).toEqual([]);
		expect(report.clean).toBe(true);
		expect(report.first).toEqual({ lease: null, memory: null, generation: null });
		expect(report.generated_at).toBe(base.generated_at);
		expect(report.window_hours).toBe(24);
		expect(report.unchecked_memory_rows).toBe(0);
		expect(report.counts).toEqual({ "index.graph": 2, "ledger.lease": 3 });
	});

	test("a truncation flag makes the report not clean even with no findings", () => {
		const report = buildReport({ ...base, truncated: { cache: true }, findings: [] });
		expect(report.findings).toEqual([]);
		expect(report.clean).toBe(false);
		expect(report.truncated).toEqual({ cache: true });
	});

	test("any single truncation flag among several makes the report not clean", () => {
		const report = buildReport({
			...base,
			truncated: { cache: false, memory: true },
			findings: [],
		});
		expect(report.clean).toBe(false);
	});

	test("any finding makes the report not clean", () => {
		const report = buildReport({
			...base,
			findings: [{ comparison: "memory", key: "m1", detail: "x" }],
		});
		expect(report.clean).toBe(false);
	});

	test("findings are sorted by key across comparisons", () => {
		const report = buildReport({
			...base,
			findings: [
				{ comparison: "generation", key: "substrate:v1:gen:graph:gA", detail: "d" },
				{ comparison: "lease", key: "g1/n1", detail: "d" },
				{ comparison: "memory", key: "m0", detail: "d" },
			],
		});
		expect(report.findings.map((f) => f.key)).toEqual([
			"g1/n1",
			"m0",
			"substrate:v1:gen:graph:gA",
		]);
	});

	test("first is the first finding of each comparison in sorted order", () => {
		const report = buildReport({
			...base,
			findings: [
				{ comparison: "lease", key: "g2/n1", detail: "later lease" },
				{ comparison: "memory", key: "m9", detail: "later memory" },
				{ comparison: "lease", key: "g1/n1", detail: "first lease" },
				{ comparison: "memory", key: "m1", detail: "first memory" },
				{ comparison: "generation", key: "substrate:v1:gen:graph:z", detail: "only gen" },
			],
		});
		expect(report.first.lease?.key).toBe("g1/n1");
		expect(report.first.lease?.detail).toBe("first lease");
		expect(report.first.memory?.key).toBe("m1");
		expect(report.first.memory?.detail).toBe("first memory");
		expect(report.first.generation?.key).toBe("substrate:v1:gen:graph:z");
	});

	test("first is null for a comparison with no findings", () => {
		const report = buildReport({
			...base,
			findings: [{ comparison: "lease", key: "g1/n1", detail: "d" }],
		});
		expect(report.first.lease?.key).toBe("g1/n1");
		expect(report.first.memory).toBeNull();
		expect(report.first.generation).toBeNull();
	});

	test("does not mutate the input findings array", () => {
		const findings: Finding[] = [
			{ comparison: "memory", key: "m2", detail: "d" },
			{ comparison: "memory", key: "m1", detail: "d" },
		];
		buildReport({ ...base, findings });
		expect(findings.map((f) => f.key)).toEqual(["m2", "m1"]);
	});

	test("end to end: comparator output feeds buildReport with correct first and clean", () => {
		const lease = compareLeases(new Map([["g1/n1", hold("cli", "s1", 1)]]), new Map());
		const memory = compareMemory(new Set(), new Set(["m1"]));
		const generation = compareGenerations(new Set(["gone"]), new Set());
		const report = buildReport({
			...base,
			findings: [...lease, ...memory, ...generation],
		});
		expect(report.clean).toBe(false);
		expect(report.findings.map((f) => f.comparison)).toEqual(["lease", "memory", "generation"]);
		expect(report.first.lease?.key).toBe("g1/n1");
		expect(report.first.memory?.key).toBe("m1");
		expect(report.first.generation?.key).toBe("substrate:v1:gen:graph:gone");
	});
});
