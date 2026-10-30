import { describe, expect, test } from "bun:test";
import { goldenRecallOf, ingestDocsPerSecond, INGEST_MIN_ELAPSED_MS, loadSloThresholds, SLO_DEFAULTS, sloBreaches } from "./slo.ts";

describe("loadSloThresholds", () => {
	test("unset is the documented defaults", () => {
		expect(loadSloThresholds({})).toEqual({ freshnessS: 86_400, recall5: 0.6, ingestDocsPerS: 0.2 });
		expect(loadSloThresholds({})).toEqual(SLO_DEFAULTS);
	});

	test("a valid value is used, with whitespace trimmed", () => {
		expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_FRESHNESS_S: " 3600 ", SUBSTRATE_DOCS_SLO_RECALL5: "0.75", SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S: "1.5" })).toEqual({
			freshnessS: 3600,
			recall5: 0.75,
			ingestDocsPerS: 1.5,
		});
		expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_RECALL5: "1" }).recall5).toBe(1);
		expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_FRESHNESS_S: "90.9" }).freshnessS).toBe(90);
	});

	test("empty, zero, negative, non-numeric or out-of-range values are the default, so a typo never switches a check off", () => {
		for (const value of ["", " ", "0", "-5", "soon", "NaN", "Infinity"]) {
			expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_FRESHNESS_S: value }).freshnessS).toBe(SLO_DEFAULTS.freshnessS);
			expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S: value }).ingestDocsPerS).toBe(SLO_DEFAULTS.ingestDocsPerS);
		}
		for (const value of ["", "0", "-0.1", "1.01", "high"]) {
			expect(loadSloThresholds({ SUBSTRATE_DOCS_SLO_RECALL5: value }).recall5).toBe(SLO_DEFAULTS.recall5);
		}
	});
});

describe("sloBreaches", () => {
	const limits = { freshnessS: 100, recall5: 0.6, ingestDocsPerS: 0.2 };

	test("nothing breaches while every reading holds, and a reading exactly on its threshold holds", () => {
		expect(sloBreaches({ freshnessS: 100, recall5: 0.6, ingestDocsPerS: 0.2 }, limits)).toEqual([]);
		expect(sloBreaches({ freshnessS: 0, recall5: 1, ingestDocsPerS: 50 }, limits)).toEqual([]);
	});

	test("each objective breaches on its own side of the threshold, in a fixed order", () => {
		expect(sloBreaches({ freshnessS: 101, recall5: null, ingestDocsPerS: null }, limits)).toEqual(["freshness"]);
		expect(sloBreaches({ freshnessS: null, recall5: 0.59, ingestDocsPerS: null }, limits)).toEqual(["recall5"]);
		expect(sloBreaches({ freshnessS: null, recall5: null, ingestDocsPerS: 0.19 }, limits)).toEqual(["ingest"]);
		expect(sloBreaches({ freshnessS: 500, recall5: 0.1, ingestDocsPerS: 0.01 }, limits)).toEqual(["freshness", "recall5", "ingest"]);
	});

	test("a reading nobody has taken is never a breach", () => {
		expect(sloBreaches({ freshnessS: null, recall5: null, ingestDocsPerS: null }, limits)).toEqual([]);
	});
});

describe("ingestDocsPerSecond", () => {
	test("is documents over the wall time in seconds", () => {
		expect(ingestDocsPerSecond(10, 2000)).toBe(5);
		expect(ingestDocsPerSecond(1, 4000)).toBe(0.25);
	});

	test("nothing sent reads 0 whatever the time", () => {
		expect(ingestDocsPerSecond(0, 5000)).toBe(0);
		expect(ingestDocsPerSecond(-3, 5000)).toBe(0);
		expect(ingestDocsPerSecond(Number.NaN, 5000)).toBe(0);
	});

	test("a request inside the clock's resolution is divided by the floor, never by zero", () => {
		expect(ingestDocsPerSecond(3, 0)).toBe((3 * 1000) / INGEST_MIN_ELAPSED_MS);
		expect(ingestDocsPerSecond(3, -10)).toBe((3 * 1000) / INGEST_MIN_ELAPSED_MS);
		expect(ingestDocsPerSecond(3, Number.NaN)).toBe((3 * 1000) / INGEST_MIN_ELAPSED_MS);
	});
});

describe("goldenRecallOf", () => {
	test("reads a finite number in [0, 1] from a canary payload and nothing else", () => {
		expect(goldenRecallOf({ action: "docs.canary", golden_recall5: 0.82 })).toBe(0.82);
		expect(goldenRecallOf({ golden_recall5: 0 })).toBe(0);
		expect(goldenRecallOf({ golden_recall5: 1 })).toBe(1);
		for (const bad of [1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.9", null, undefined, [0.5]]) {
			expect(goldenRecallOf({ golden_recall5: bad })).toBeNull();
		}
		expect(goldenRecallOf({})).toBeNull();
	});
});
