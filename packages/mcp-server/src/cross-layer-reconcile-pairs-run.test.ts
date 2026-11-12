import { describe, expect, test } from "bun:test";
import { EXIT, RECONCILE_GRAPHS_MAX, type PairsOutcome, type TickResult, combineExit, graphIdsFrom } from "./cross-layer-reconcile-run.ts";

const CLEAN: TickResult = { code: EXIT.clean, stdout: "", stderr: "" };
const FAILED: TickResult = { code: EXIT.failed, stdout: "", stderr: "" };
const MISMATCH: TickResult = { code: EXIT.mismatch, stdout: "", stderr: "" };

function pairs(mismatches: number, incomplete: string[] = []): PairsOutcome {
	return { reports: [], mismatches, incomplete };
}

describe("graphIdsFrom", () => {
	test("unset or blank judges no graphs and is not a problem", () => {
		expect(graphIdsFrom(undefined)).toEqual({ ok: true, ids: [] });
		expect(graphIdsFrom("   ")).toEqual({ ok: true, ids: [] });
	});

	test("trims entries and drops duplicates, keeping the first occurrence", () => {
		expect(graphIdsFrom(" g1, g2 ,g1 ")).toEqual({ ok: true, ids: ["g1", "g2"] });
	});

	test("an empty entry is refused, never silently skipped", () => {
		const parsed = graphIdsFrom("g1,,g2");
		expect(parsed.ok).toBe(false);
	});

	test("more than the maximum is refused, not truncated", () => {
		const many = Array.from({ length: RECONCILE_GRAPHS_MAX + 1 }, (_, i) => `g${i}`).join(",");
		const parsed = graphIdsFrom(many);
		expect(parsed.ok).toBe(false);
	});
});

describe("combineExit", () => {
	test("clean forget pair and clean graph pairs exit clean", () => {
		expect(combineExit(CLEAN, pairs(0))).toBe(EXIT.clean);
	});

	test("no graph pairs configured leaves the forget pair's exit alone", () => {
		expect(combineExit(CLEAN, null)).toBe(EXIT.clean);
		expect(combineExit(FAILED, null)).toBe(EXIT.failed);
	});

	test("a graph pair mismatch exits mismatch even when the forget pair failed to read", () => {
		expect(combineExit(FAILED, pairs(2))).toBe(EXIT.mismatch);
	});

	test("an incomplete graph pair exits failed, never clean", () => {
		expect(combineExit(CLEAN, pairs(0, ["g1 index-ledger: incomplete (ledger-truncated)"]))).toBe(EXIT.failed);
	});

	test("a forget mismatch outranks everything", () => {
		expect(combineExit(MISMATCH, pairs(0))).toBe(EXIT.mismatch);
	});
});
