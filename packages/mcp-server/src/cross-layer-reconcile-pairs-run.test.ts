import { describe, expect, test } from "bun:test";
import { EXIT, RECONCILE_GRAPHS_MAX, type PairsOutcome, type TickResult, combineExit, graphIdsFrom, parseCacheIndexArgs, renderPairs, runCacheIndexApply, runCacheIndexPlan, runPairsTick } from "./cross-layer-reconcile-run.ts";
import { type CachedGraph, type PairCache, type PairCacheBumper, type PairDeps, PAIR_DEFAULT_SURFACE, PAIR_SURFACES, type PairIndex, type PairLedger, type PairMemoryRow, type PairNode } from "./cross-layer-reconcile-pairs.ts";
import type { LedgerNote, ReconcileLedger } from "./cross-layer-reconcile.ts";
import { GRAPHS_GENERATION_KEY, graphGenerationKey } from "./cache.ts";

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

describe("the cache-index repair run: a printed plan, then its confirmed apply; the scheduled tick does neither", () => {
	const GRAPH = "g-42";
	const NOW = Date.parse("2026-11-11T12:00:00.000Z");
	const OPTIONS = { settleMs: 300_000 };
	const indexAt3: PairNode[] = [{ nodeId: "n1", state: "claimed", leaseEpoch: 3 }];
	const cacheAt2: PairNode[] = [{ nodeId: "n1", state: "claimed", leaseEpoch: 2 }];
	const cacheAt3: PairNode[] = [{ nodeId: "n1", state: "claimed", leaseEpoch: 3 }];

	/** A ledger that stores the notes it is given and reads them back by event id. `notes` is every write it took. */
	class NotesLedger implements PairLedger, Pick<ReconcileLedger, "emitNote" | "readEvent"> {
		readonly notes = new Map<string, LedgerNote>();
		async graphEvents(): Promise<{ ids: string[]; truncated: boolean }> {
			return { ids: [], truncated: false };
		}
		async emitNote(_summary: string, payload: Record<string, unknown>): Promise<{ id: string; stored: boolean }> {
			const id = `evt_${this.notes.size + 1}`;
			this.notes.set(id, { id, ts: new Date(NOW).toISOString(), kind: "note", payload });
			return { id, stored: true };
		}
		async readEvent(id: string): Promise<LedgerNote | null> {
			return this.notes.get(id) ?? null;
		}
	}

	/** A cache whose anonymous view is `view`; `writes` records every bump. */
	class FixedCache implements PairCache, PairCacheBumper {
		readonly writes: string[] = [];
		constructor(private readonly view: CachedGraph) {}
		async graphGeneration(_graphId: string): Promise<string> {
			return "0";
		}
		async cachedGraph(_graphId: string, surface: string): Promise<CachedGraph> {
			return surface === PAIR_DEFAULT_SURFACE ? this.view : { state: "absent" };
		}
		async bump(key: string): Promise<void> {
			this.writes.push(key);
		}
	}

	class FixedIndex implements PairIndex {
		constructor(private readonly nodes: PairNode[]) {}
		async graphMemory(): Promise<{ rows: PairMemoryRow[]; truncated: boolean }> {
			return { rows: [], truncated: false };
		}
		async graphNodes(): Promise<PairNode[] | null> {
			return this.nodes;
		}
	}

	function present(nodes: PairNode[]): CachedGraph {
		return { state: "present", nodes };
	}

	test("--cache-index takes a graph id to plan, or --apply PLAN_ID --confirm; anything else is refused before a store is opened", () => {
		expect(parseCacheIndexArgs([GRAPH])).toEqual({ mode: "cache-index-plan", graphId: GRAPH });
		expect(parseCacheIndexArgs(["--apply", "evt_1", "--confirm"])).toEqual({ mode: "cache-index-apply", planId: "evt_1" });
		for (const argv of [[], ["--apply", "evt_1"], ["--apply", "--confirm"], ["--apply", "evt_1", "--force"], ["--apply", "evt_1", "--confirm", "extra"], [GRAPH, "extra"], ["--json"], ["has space"]]) {
			expect(parseCacheIndexArgs(argv).mode, JSON.stringify(argv)).toBe("refused");
		}
	});

	test("a plan on drift prints the report and the apply command, records one plan note, bumps nothing, and exits 3", async () => {
		const ledger = new NotesLedger();
		const cache = new FixedCache(present(cacheAt2));
		const run = await runCacheIndexPlan({ ledger, index: new FixedIndex(indexAt3), cache }, GRAPH);
		expect(run.code).toBe(EXIT.mismatch);
		expect(run.stdout).toContain(`pair cache-index graph=${GRAPH}: drift, mismatches=1 first=n1 surface=${PAIR_DEFAULT_SURFACE}`);
		expect(run.stdout).toContain("plan evt_1: 2 bump(s) recorded as a reconcile.plan.cache-index note; nothing repaired yet");
		expect(run.stdout).toContain("--cache-index --apply evt_1 --confirm");
		expect(ledger.notes.size).toBe(1);
		expect(cache.writes).toEqual([]);
	});

	test("a plan on a graph the layers agree on exits clean and records nothing", async () => {
		const ledger = new NotesLedger();
		const run = await runCacheIndexPlan({ ledger, index: new FixedIndex(indexAt3), cache: new FixedCache(present(cacheAt3)) }, GRAPH);
		expect(run.code).toBe(EXIT.clean);
		expect(run.stdout).toContain(`nothing to repair: the cache and the index agree for graph ${GRAPH}`);
		expect(ledger.notes.size).toBe(0);
	});

	test("a plan on a cache that is disabled exits failed and records nothing", async () => {
		const ledger = new NotesLedger();
		const run = await runCacheIndexPlan({ ledger, index: new FixedIndex(indexAt3), cache: new FixedCache({ state: "disabled" }) }, GRAPH);
		expect(run.code).toBe(EXIT.failed);
		expect(run.stderr).toContain("nothing was planned");
		expect(ledger.notes.size).toBe(0);
	});

	test("apply with the printed plan id bumps exactly the two generation keys and exits clean", async () => {
		const ledger = new NotesLedger();
		await runCacheIndexPlan({ ledger, index: new FixedIndex(indexAt3), cache: new FixedCache(present(cacheAt2)) }, GRAPH);
		const cache = new FixedCache(present(cacheAt2));
		const run = await runCacheIndexApply({ ledger, index: new FixedIndex(indexAt3), cache }, "evt_1");
		expect(run).toEqual({ code: EXIT.clean, stdout: `applied cache-index plan evt_1: bumped ${graphGenerationKey(GRAPH)}, ${GRAPHS_GENERATION_KEY}\n`, stderr: "" });
		expect(cache.writes).toEqual([graphGenerationKey(GRAPH), GRAPHS_GENERATION_KEY]);
		expect(ledger.notes.size).toBe(1);
	});

	test("apply after the layers have moved on refuses with exit failed and bumps nothing", async () => {
		const ledger = new NotesLedger();
		await runCacheIndexPlan({ ledger, index: new FixedIndex(indexAt3), cache: new FixedCache(present(cacheAt2)) }, GRAPH);
		const cache = new FixedCache(present(cacheAt3));
		const run = await runCacheIndexApply({ ledger, index: new FixedIndex(indexAt3), cache }, "evt_1");
		expect(run.code).toBe(EXIT.failed);
		expect(run.stderr).toContain("plan-invalid");
		expect(cache.writes).toEqual([]);
	});

	test("the scheduled tick judges the drift and neither plans nor applies: no ledger note and no bump", async () => {
		const ledger = new NotesLedger();
		const cache = new FixedCache(present(cacheAt2));
		const deps: PairDeps = { ledger, index: new FixedIndex(indexAt3), cache, now: () => NOW };
		const outcome = await runPairsTick(deps, [GRAPH], OPTIONS);
		expect(outcome.reports[0]?.cacheIndex.verdict).toBe("drift");
		expect(outcome.mismatches).toBe(1);
		expect(ledger.notes.size).toBe(0);
		expect(cache.writes).toEqual([]);
	});
});
