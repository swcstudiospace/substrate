import { describe, expect, test } from "bun:test";
import { EXIT, RECONCILE_GRAPHS_MAX, type PairsOutcome, type TickResult, combineExit, graphIdsFrom, renderPairs, runPairsTick } from "./cross-layer-reconcile-run.ts";
import { type CachedGraph, type PairCache, type PairDeps, PAIR_SURFACES, type PairMemoryRow, type PairNode } from "./cross-layer-reconcile-pairs.ts";

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

describe("the scheduled pairs tick: every surface, and a session reference is not drift", () => {
	const GRAPH = "g-42";
	const NOW = Date.parse("2026-11-11T12:00:00.000Z");
	const OPTIONS = { settleMs: 300_000 };

	/** A cache that records every surface it is read under and every write; a clean tick must leave `writes` empty. */
	class RecordingCache implements PairCache {
		reads: string[] = [];
		writes: string[] = [];
		constructor(private readonly bySurface: Record<string, CachedGraph>) {}
		async graphGeneration(_graphId: string): Promise<string> {
			return "0";
		}
		async cachedGraph(_graphId: string, surface: string): Promise<CachedGraph> {
			this.reads.push(surface);
			return this.bySurface[surface] ?? { state: "absent" };
		}
		async bump(key: string): Promise<void> {
			this.writes.push(key);
		}
	}

	function tickDeps(parts: { ledgerIds: string[]; rows: PairMemoryRow[]; nodes: PairNode[] | null; cache: PairCache }): PairDeps {
		return {
			ledger: {
				async graphEvents() {
					return { ids: parts.ledgerIds, truncated: false };
				},
			},
			index: {
				async graphMemory() {
					return { rows: parts.rows, truncated: false };
				},
				async graphNodes() {
					return parts.nodes;
				},
			},
			cache: parts.cache,
			now: () => NOW,
		};
	}

	test("a stale entry under a named surface fails the tick, with no anonymous entry, and every surface is read with zero writes", async () => {
		const cache = new RecordingCache({ omp: { state: "present", nodes: [{ nodeId: "n1", state: "claimed", leaseEpoch: 2 }] } });
		const outcome = await runPairsTick(tickDeps({ ledgerIds: [], rows: [], nodes: [{ nodeId: "n1", state: "claimed", leaseEpoch: 3 }], cache }), [GRAPH], OPTIONS);
		expect(outcome.mismatches).toBe(1);
		expect(outcome.reports[0]?.cacheIndex.mismatches.first).toEqual({ surface: "omp", key: "n1", reason: "version-mismatch", cachedVersion: 2, indexVersion: 3 });
		expect(renderPairs(outcome)).toContain("first=n1 surface=omp");
		expect(combineExit(CLEAN, outcome)).toBe(EXIT.mismatch);
		expect(cache.reads).toEqual([...PAIR_SURFACES]);
		expect(cache.writes).toEqual([]);
	});

	test("a graph whose entries agree on every surface exits clean and writes nothing", async () => {
		const nodes = [{ nodeId: "n1", state: "claimed", leaseEpoch: 1 }];
		const cache = new RecordingCache({ unattributed: { state: "present", nodes }, omp: { state: "present", nodes } });
		const outcome = await runPairsTick(tickDeps({ ledgerIds: [], rows: [], nodes, cache }), [GRAPH], OPTIONS);
		expect(outcome.mismatches).toBe(0);
		expect(outcome.incomplete).toEqual([]);
		expect(combineExit(CLEAN, outcome)).toBe(EXIT.clean);
		expect(cache.writes).toEqual([]);
	});

	test("a session reference in the index is not drift in the scheduled tick", async () => {
		const cache = new RecordingCache({});
		const row: PairMemoryRow = { id: "m1", scope: `graph:${GRAPH}`, created: new Date(NOW - 30 * 60_000).toISOString(), sourceEvent: "session:sess-7" };
		const outcome = await runPairsTick(tickDeps({ ledgerIds: [], rows: [row], nodes: null, cache }), [GRAPH], OPTIONS);
		expect(outcome.reports[0]?.indexLedger).toMatchObject({ verdict: "clean", counts: { sessionRefs: 1 } });
		expect(outcome.mismatches).toBe(0);
		expect(combineExit(CLEAN, outcome)).toBe(EXIT.clean);
		expect(cache.writes).toEqual([]);
	});
});
