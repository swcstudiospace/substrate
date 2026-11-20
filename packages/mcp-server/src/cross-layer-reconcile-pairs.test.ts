/**
 * The index <-> ledger and cache <-> index pairs (phase 78) are judged on what a caller sees: a clean run is clean and writes
 * nothing; a planted mismatch is reported with its first key and per-layer counts; a truncated or unreachable read makes no
 * drift claim; an open breaker is `unavailable`; and a repair is refused without a confirmed plan and then touches only the
 * planned keys. Every fake records any write, so a test can assert that nothing was written.
 */
import { describe, expect, test } from "bun:test";
import { BreakerOpenError } from "@substrate/observability";
import { type CacheRedis, cacheKey, GRAPHS_GENERATION_KEY, graphGenerationKey } from "./cache.ts";
import {
	type CacheIndexRepairPorts,
	type CachedGraph,
	type PairCache,
	type PairCacheBumper,
	type PairDeps,
	type PairIndex,
	type PairLedger,
	type PairMemoryRow,
	type PairNode,
	CACHE_INDEX_PLAN_ACTION,
	PAIR_DEFAULT_SURFACE,
	PAIR_INDEX_ROWS,
	PAIR_SURFACES,
	pairCacheFrom,
	pairIndexFrom,
	pairLedgerFrom,
	applyCacheIndexRepair,
	planCacheIndexRepair,
	reconcileCacheIndex,
	reconcileIndexLedger,
	runPairReconcile,
} from "./cross-layer-reconcile-pairs.ts";
import type { LedgerNote, ReconcileLedger } from "./cross-layer-reconcile.ts";
import type { IndexStore } from "./index-store.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const GRAPH = "g-42";
const OPTIONS = { settleMs: 300_000 };

function minutesAgo(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

/** Every write any fake receives. A clean run must leave it empty. */
class WriteSpy {
	writes: string[] = [];
}

class FakeLedger implements PairLedger {
	constructor(
		private readonly ids: string[],
		private readonly truncated = false,
	) {}
	async graphEvents(): Promise<{ ids: string[]; truncated: boolean }> {
		return { ids: this.ids, truncated: this.truncated };
	}
}

class FakeIndex implements PairIndex {
	constructor(
		private readonly rows: PairMemoryRow[],
		private readonly nodes: PairNode[] | null,
		private readonly spy: WriteSpy,
	) {}
	async graphMemory(): Promise<{ rows: PairMemoryRow[]; truncated: boolean }> {
		return { rows: this.rows, truncated: false };
	}
	async graphNodes(): Promise<PairNode[] | null> {
		return this.nodes;
	}
	/** Not part of the pair's read port; present so the write spy would catch an index write. */
	async markMemoryForgotten(ids: readonly string[]): Promise<string[]> {
		this.spy.writes.push(`index.markMemoryForgotten:${ids.join(",")}`);
		return [];
	}
}

/**
 * The cache under test. The anonymous surface holds `value`; a named surface holds the entry in `named`, or nothing when it is not
 * listed, so every surface a comparison reads is answered.
 */
class FakeCache implements PairCache {
	constructor(
		private readonly value: CachedGraph | Error,
		private readonly spy: WriteSpy,
		private readonly named: Record<string, CachedGraph> = {},
	) {}
	async graphGeneration(_graphId: string): Promise<string> {
		return "0";
	}
	async cachedGraph(_graphId: string, surface: string): Promise<CachedGraph> {
		if (this.value instanceof Error) throw this.value;
		if (surface in this.named) return this.named[surface] as CachedGraph;
		return surface === PAIR_DEFAULT_SURFACE ? this.value : { state: "absent" };
	}
	/** Not part of the pair's read port; present so the write spy would catch a cache write. */
	async bump(key: string): Promise<void> {
		this.spy.writes.push(`cache.bump:${key}`);
	}
}

class SpyBumper implements PairCacheBumper {
	constructor(
		readonly spy: WriteSpy,
		private readonly failOn: string | null = null,
	) {}
	async bump(key: string): Promise<void> {
		if (key === this.failOn) throw new Error("redis went away");
		this.spy.writes.push(`cache.bump:${key}`);
	}
}

function deps(parts: { ledger: PairLedger; index: PairIndex; cache: PairCache }): PairDeps {
	return { ledger: parts.ledger, index: parts.index, cache: parts.cache, now: () => NOW };
}

function memoryRow(id: string, sourceEvent: string | null, createdMinutesAgo = 30): PairMemoryRow {
	return { id, scope: `graph:${GRAPH}`, created: minutesAgo(createdMinutesAgo), sourceEvent };
}

function node(nodeId: string, leaseEpoch: number, state: string | null = "claimed"): PairNode {
	return { nodeId, state, leaseEpoch };
}

describe("index -> ledger: what it reports", () => {
	test("a clean graph reports zero drift, with per-layer counts, and writes nothing", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1", "e2", "e3"]),
				index: new FakeIndex([memoryRow("m1", "e3"), memoryRow("m2", "e1"), memoryRow("m3", null)], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("clean");
		expect(report.mismatches.count).toBe(0);
		expect(report.counts).toEqual({ ledgerEvents: 3, indexRows: 3, settling: 0, unsourced: 1, sessionRefs: 0, judged: 2, matched: 2, mismatched: 0 });
		expect(spy.writes).toEqual([]);
	});

	test("a provenance key the ledger does not hold for the graph is drift, named by its first key", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1", "e2"]),
				index: new FakeIndex([memoryRow("m1", "e1"), memoryRow("m2", "e-ghost"), memoryRow("m3", "e-also-ghost")], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("drift");
		expect(report.counts).toMatchObject({ ledgerEvents: 2, indexRows: 3, judged: 3, matched: 1, mismatched: 2 });
		expect(report.mismatches.count).toBe(2);
		expect(report.mismatches.first).toEqual({ key: "e-ghost", reason: "event-not-in-ledger", entryId: "m2" });
		expect(spy.writes).toEqual([]);
	});

	test("a row too young to judge is counted as settling and is not drift", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1"]),
				index: new FakeIndex([memoryRow("m1", "e-in-flight", 1)], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("clean");
		expect(report.counts).toMatchObject({ settling: 1, judged: 0, mismatched: 0 });
	});

	test("a truncated ledger read is incomplete: a key past the page is not called drift", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1"], true),
				index: new FakeIndex([memoryRow("m1", "e-beyond-page")], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("incomplete");
		expect(report.reason).toBe("ledger-truncated");
		expect(report.layer).toBe("ledger");
		expect(report.mismatches.count).toBe(0);
		expect(spy.writes).toEqual([]);
	});

	test("an unreadable ledger is unavailable, not drift", async () => {
		const spy = new WriteSpy();
		const failing: PairLedger = {
			async graphEvents() {
				throw new Error("greptime connection refused");
			},
		};
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({ ledger: failing, index: new FakeIndex([memoryRow("m1", "e9")], null, spy), cache: new FakeCache({ state: "absent" }, spy) }),
			OPTIONS,
		);
		expect(report.verdict).toBe("unavailable");
		expect(report.reason).toBe("unreadable");
		expect(report.layer).toBe("ledger");
		expect(report.mismatches.count).toBe(0);
		expect(spy.writes).toEqual([]);
	});

	test("a session reference is counted apart: it is not an event-not-in-ledger, and it hides no real mismatch beside it", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1"]),
				index: new FakeIndex([memoryRow("m1", "session:sess-7"), memoryRow("m2", "e1"), memoryRow("m3", "e-ghost")], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("drift");
		expect(report.counts).toEqual({ ledgerEvents: 1, indexRows: 3, settling: 0, unsourced: 0, sessionRefs: 1, judged: 2, matched: 1, mismatched: 1 });
		expect(report.mismatches.count).toBe(1);
		expect(report.mismatches.first).toEqual({ key: "e-ghost", reason: "event-not-in-ledger", entryId: "m3" });
		expect(spy.writes).toEqual([]);
	});

	test("a graph whose provenance is only session references is clean, with nothing judged and nothing written", async () => {
		const spy = new WriteSpy();
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([memoryRow("m1", "session:sess-7"), memoryRow("m2", "session:sess-8")], null, spy),
				cache: new FakeCache({ state: "absent" }, spy),
			}),
			OPTIONS,
		);
		expect(report.verdict).toBe("clean");
		expect(report.mismatches.count).toBe(0);
		expect(report.counts).toMatchObject({ sessionRefs: 2, judged: 0, mismatched: 0 });
		expect(spy.writes).toEqual([]);
	});
});

describe("cache -> index: what it reports", () => {
	test("a cached graph view that matches the index on every node is clean and writes nothing", async () => {
		const spy = new WriteSpy();
		const nodes = [node("n1", 2), node("n2", 0, null)];
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], nodes, spy),
				cache: new FakeCache({ state: "present", nodes }, spy),
			}),
		);
		expect(report.verdict).toBe("clean");
		expect(report.counts).toEqual({ cacheState: "present", surfacesCompared: 1, cacheNodes: 2, indexNodes: 2, matched: 2, versionMismatch: 0, cacheOnly: 0, indexOnly: 0 });
		expect(spy.writes).toEqual([]);
	});

	test("a stale version, a cached node the index dropped and an index node the cache lacks are drift, first key in cache order", async () => {
		const spy = new WriteSpy();
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], [node("n1", 3), node("n2", 1), node("n4", 5)], spy),
				cache: new FakeCache({ state: "present", nodes: [node("n1", 2), node("n9", 0)] }, spy),
			}),
		);
		expect(report.verdict).toBe("drift");
		expect(report.counts).toMatchObject({ cacheNodes: 2, indexNodes: 3, matched: 0, versionMismatch: 1, cacheOnly: 1, indexOnly: 2 });
		expect(report.mismatches.count).toBe(4);
		expect(report.mismatches.first).toEqual({ surface: "unattributed", key: "n1", reason: "version-mismatch", cachedVersion: 2, indexVersion: 3 });
		expect(spy.writes).toEqual([]);
	});

	test("no cached entry for the current generation has nothing to compare: clean", async () => {
		const spy = new WriteSpy();
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 1)], spy), cache: new FakeCache({ state: "absent" }, spy) }),
		);
		expect(report.verdict).toBe("clean");
		expect(report.counts).toMatchObject({ cacheState: "absent", matched: 0, indexOnly: 0 });
	});

	test("an open breaker on the cache is unavailable with no drift claim", async () => {
		const spy = new WriteSpy();
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], [node("n1", 3)], spy),
				cache: new FakeCache(new BreakerOpenError("cache", 30_000), spy),
			}),
		);
		expect(report.verdict).toBe("unavailable");
		expect(report.reason).toBe("breaker-open");
		expect(report.layer).toBe("cache");
		expect(report.mismatches).toEqual({ count: 0, first: null, items: [] });
		expect(spy.writes).toEqual([]);
	});

	test("the production cache adapter reports an open breaker, from the redis client's own gated call, as unavailable", async () => {
		const spy = new WriteSpy();
		const breakerOpen: CacheRedis = {
			async get() {
				throw new BreakerOpenError("cache", 30_000);
			},
			async set() {},
			async incr() {
				return 0;
			},
		};
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 3)], spy), cache: pairCacheFrom(breakerOpen) }),
		);
		expect(report).toMatchObject({ verdict: "unavailable", reason: "breaker-open", layer: "cache" });
		expect(spy.writes).toEqual([]);
	});

	test("a cache that is off, or holds an envelope that is not a graph view, is unavailable, not drift", async () => {
		const spy = new WriteSpy();
		const index = new FakeIndex([], [node("n1", 1)], spy);
		const off = await reconcileCacheIndex(GRAPH, deps({ ledger: new FakeLedger([]), index, cache: pairCacheFrom(null) }));
		expect(off).toMatchObject({ verdict: "unavailable", reason: "cache-disabled" });

		const generation = "7";
		const garbage = new Map<string, string>([
			[graphGenerationKey(GRAPH), generation],
			[cacheKey("graph-view", "unattributed", generation, { graph_id: GRAPH }), JSON.stringify({ v: { nodes: [{ node_id: 3 }] } })],
		]);
		const malformed = await reconcileCacheIndex(GRAPH, deps({ ledger: new FakeLedger([]), index, cache: pairCacheFrom(fakeRedis(garbage)) }));
		expect(malformed).toMatchObject({ verdict: "unavailable", reason: "cache-malformed" });
		expect(spy.writes).toEqual([]);
	});

	test("the production cache adapter reads the entry at the graph's current generation, and ignores retired ones", async () => {
		const spy = new WriteSpy();
		const store = new Map<string, string>([
			[graphGenerationKey(GRAPH), "7"],
			// A retired generation: its entry says n1 is at epoch 0, which the current view must not be judged against.
			[cacheKey("graph-view", "unattributed", "6", { graph_id: GRAPH }), JSON.stringify({ v: { nodes: [{ node_id: "n1", state: "claimed", lease_epoch: 0 }] } })],
			[cacheKey("graph-view", "unattributed", "7", { graph_id: GRAPH }), JSON.stringify({ v: { nodes: [{ node_id: "n1", state: "claimed", lease_epoch: 4 }] } })],
		]);
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 4)], spy), cache: pairCacheFrom(fakeRedis(store)) }),
		);
		expect(report.verdict).toBe("clean");
		expect(report.counts).toMatchObject({ cacheState: "present", cacheNodes: 1, matched: 1 });
		expect(spy.writes).toEqual([]);
	});

	test("a generation that moves during the read is incomplete, not drift, and writes nothing", async () => {
		const spy = new WriteSpy();
		let reads = 0;
		const cache: PairCache = {
			async graphGeneration() {
				reads += 1;
				return reads === 1 ? "1" : "2";
			},
			async cachedGraph(_graphId, surface) {
				return surface === "unattributed" ? { state: "present", nodes: [node("n1", 9)] } : { state: "absent" };
			},
		};
		const report = await reconcileCacheIndex(GRAPH, deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 1)], spy), cache }));
		expect(report).toMatchObject({ verdict: "incomplete", reason: "generation-moved", mismatches: { count: 0 } });
		expect(spy.writes).toEqual([]);
	});

	test("every surface a caller can read as is compared, not only the anonymous one", async () => {
		const read: string[] = [];
		const cache: PairCache = {
			async graphGeneration() {
				return "0";
			},
			async cachedGraph(_graphId, surface) {
				read.push(surface);
				return { state: "absent" };
			},
		};
		const report = await reconcileCacheIndex(GRAPH, deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 1)], new WriteSpy()), cache }));
		expect(read).toEqual([...PAIR_SURFACES]);
		expect(report).toMatchObject({ verdict: "clean", counts: { surfacesCompared: 0 } });
	});

	test("a stale entry under a named surface is drift, even when the anonymous surface holds nothing", async () => {
		const spy = new WriteSpy();
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], [node("n1", 3)], spy),
				cache: new FakeCache({ state: "absent" }, spy, { omp: { state: "present", nodes: [node("n1", 2)] } }),
			}),
		);
		expect(report.verdict).toBe("drift");
		expect(report.counts).toMatchObject({ cacheState: "present", surfacesCompared: 1, cacheNodes: 1, versionMismatch: 1 });
		expect(report.mismatches.first).toEqual({ surface: "omp", key: "n1", reason: "version-mismatch", cachedVersion: 2, indexVersion: 3 });
		expect(spy.writes).toEqual([]);
	});

	test("an index node one surface lacks is drift under that surface, and the entries that match elsewhere still count", async () => {
		const spy = new WriteSpy();
		const nodes = [node("n1", 1), node("n2", 0)];
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], nodes, spy),
				cache: new FakeCache({ state: "present", nodes }, spy, { omp: { state: "present", nodes: [node("n1", 1)] } }),
			}),
		);
		expect(report.verdict).toBe("drift");
		expect(report.counts).toEqual({ cacheState: "present", surfacesCompared: 2, cacheNodes: 3, indexNodes: 2, matched: 3, versionMismatch: 0, cacheOnly: 0, indexOnly: 1 });
		expect(report.mismatches.first).toEqual({ surface: "omp", key: "n2", reason: "index-only", indexVersion: 0 });
		expect(spy.writes).toEqual([]);
	});

	test("the production cache adapter compares a named surface's current entry when the anonymous surface has none", async () => {
		const spy = new WriteSpy();
		const store = new Map<string, string>([
			[graphGenerationKey(GRAPH), "7"],
			[cacheKey("graph-view", "omp", "7", { graph_id: GRAPH }), JSON.stringify({ v: { nodes: [{ node_id: "n1", state: "claimed", lease_epoch: 2 }] } })],
		]);
		const report = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 3)], spy), cache: pairCacheFrom(fakeRedis(store)) }),
		);
		expect(report.verdict).toBe("drift");
		expect(report.mismatches.first).toEqual({ surface: "omp", key: "n1", reason: "version-mismatch", cachedVersion: 2, indexVersion: 3 });
		expect(spy.writes).toEqual([]);
	});
});

describe("the scheduled comparison", () => {
	test("both pairs clean on a consistent graph, with zero writes across every fake", async () => {
		const spy = new WriteSpy();
		const nodes = [node("n1", 2)];
		const { indexLedger, cacheIndex } = await runPairReconcile(
			GRAPH,
			deps({
				ledger: new FakeLedger(["e1"]),
				index: new FakeIndex([memoryRow("m1", "e1")], nodes, spy),
				cache: new FakeCache({ state: "present", nodes }, spy),
			}),
			OPTIONS,
		);
		expect(indexLedger.verdict).toBe("clean");
		expect(cacheIndex.verdict).toBe("clean");
		expect(spy.writes).toEqual([]);
	});
});

/** A ledger that keeps the plan notes it is given, so a plan can be read back by its event id. Every write it takes is recorded. */
class PlanLedger implements Pick<ReconcileLedger, "emitNote" | "readEvent"> {
	readonly notes = new Map<string, LedgerNote>();
	constructor(
		private readonly spy: WriteSpy,
		private readonly stored = true,
	) {}
	async emitNote(_summary: string, payload: Record<string, unknown>): Promise<{ id: string; stored: boolean }> {
		const id = `evt_${this.notes.size + 1}`;
		this.spy.writes.push(`ledger.note:${id}`);
		if (this.stored) this.notes.set(id, { id, ts: minutesAgo(0), kind: "note", payload });
		return { id, stored: this.stored };
	}
	async readEvent(id: string): Promise<LedgerNote | null> {
		return this.notes.get(id) ?? null;
	}
}

/** The ports over a drifted graph: the index holds n1 at epoch 3, the anonymous cache view holds it at epoch 2. */
function driftPorts(ledger: PlanLedger, spy: WriteSpy, cacheNodes: PairNode[] = [node("n1", 2)]): CacheIndexRepairPorts {
	return { ledger, index: new FakeIndex([], [node("n1", 3)], spy), cache: new FakeCache({ state: "present", nodes: cacheNodes }, spy) };
}

async function planDrift(ledger: PlanLedger, spy: WriteSpy) {
	return planCacheIndexRepair(ledger, await reconcileCacheIndex(GRAPH, driftPorts(ledger, spy)));
}

async function driftPlanId(ledger: PlanLedger, spy: WriteSpy): Promise<string> {
	const run = await planDrift(ledger, spy);
	if (!run.ok || run.planId === null) throw new Error("expected a plan for a drifted report");
	return run.planId;
}

/** Rewrites the plan a stored note holds, keeping its action and digests, so the stored record no longer matches them. */
function editStoredPlan(ledger: PlanLedger, planId: string, edit: (plan: Record<string, unknown>) => Record<string, unknown>): void {
	const note = ledger.notes.get(planId);
	const payload = note?.payload;
	if (note === undefined || payload === null || payload === undefined) throw new Error("no stored plan to edit");
	ledger.notes.set(planId, { ...note, payload: { ...payload, plan: edit(payload.plan as Record<string, unknown>) } });
}

describe("repair: planning writes one plan note and no bump", () => {

	test("a drifted report writes exactly one reconcile.plan.cache-index note whose event id is the plan id, and bumps nothing", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const run = await planDrift(ledger, spy);
		expect(run).toEqual({
			ok: true,
			planId: "evt_1",
			items: [
				{ action: "bump", key: graphGenerationKey(GRAPH) },
				{ action: "bump", key: GRAPHS_GENERATION_KEY },
			],
		});
		expect(spy.writes).toEqual(["ledger.note:evt_1"]);
		expect(ledger.notes.size).toBe(1);
		expect(ledger.notes.get("evt_1")?.payload).toMatchObject({ action: CACHE_INDEX_PLAN_ACTION, plan: { pair: "cache-index", graphId: GRAPH } });
	});

	test("a clean or unavailable report plans nothing and writes nothing", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const clean = await reconcileCacheIndex(GRAPH, { index: new FakeIndex([], [node("n1", 1)], spy), cache: new FakeCache({ state: "absent" }, spy) });
		expect(await planCacheIndexRepair(ledger, clean)).toEqual({ ok: true, planId: null, refused: "not-drift" });
		const down = await reconcileCacheIndex(GRAPH, { index: new FakeIndex([], [node("n1", 1)], spy), cache: new FakeCache(new BreakerOpenError("cache", 1), spy) });
		expect(await planCacheIndexRepair(ledger, down)).toEqual({ ok: true, planId: null, refused: "not-drift" });
		expect(spy.writes).toEqual([]);
		expect(ledger.notes.size).toBe(0);
	});

	test("a plan the ledger does not store is refused, and no bump follows", async () => {
		const spy = new WriteSpy();
		const run = await planDrift(new PlanLedger(spy, false), spy);
		expect(run).toMatchObject({ ok: false, reason: "plan-not-recorded" });
		expect(spy.writes.filter((write) => write.startsWith("cache.bump"))).toEqual([]);
	});
});

describe("repair: refused without a confirmed plan", () => {
	test("apply without a confirmation writes nothing", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		const applySpy = new WriteSpy();
		const ports = driftPorts(ledger, applySpy);
		expect(await applyCacheIndexRepair(ports, { planId })).toMatchObject({ ok: false, reason: "not-confirmed" });
		expect(await applyCacheIndexRepair(ports, { planId, confirm: "not-the-plan" })).toMatchObject({ ok: false, reason: "not-confirmed" });
		expect(applySpy.writes).toEqual([]);
	});

	test("a plan id that is not on the ledger, or that names a note which is not a cache-index plan, is refused", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const applySpy = new WriteSpy();
		const ports = driftPorts(ledger, applySpy);
		expect(await applyCacheIndexRepair(ports, { planId: "evt_404", confirm: "evt_404" })).toMatchObject({ ok: false, reason: "plan-not-found" });
		expect(await applyCacheIndexRepair(ports, { planId: "not a plan!", confirm: "not a plan!" })).toMatchObject({ ok: false, reason: "plan-invalid" });
		// A forget plan is a different action: its note is not a cache-index plan, whatever its items.
		ledger.notes.set("evt_forget", { id: "evt_forget", ts: minutesAgo(0), kind: "note", payload: { action: "reconcile.plan", plan: { items: [], itemsSha256: "x" } } });
		expect(await applyCacheIndexRepair(ports, { planId: "evt_forget", confirm: "evt_forget" })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(applySpy.writes).toEqual([]);
	});

	test("a plan whose recorded items were altered after it was made is refused and writes nothing", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		editStoredPlan(ledger, planId, (plan) => ({ ...plan, items: [...(plan.items as unknown[])].reverse() }));
		const applySpy = new WriteSpy();
		expect(await applyCacheIndexRepair(driftPorts(ledger, applySpy), { planId, confirm: planId })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(applySpy.writes).toEqual([]);
	});

	test("apply with a stale digest refuses: the cache or index has moved since the plan was made, and nothing is written", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		const applySpy = new WriteSpy();
		// The cache has since been repaired under another epoch: the same node, now agreeing with the index. The plan's state is gone.
		const moved = driftPorts(ledger, applySpy, [node("n1", 3)]);
		expect(await applyCacheIndexRepair(moved, { planId, confirm: planId })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(applySpy.writes).toEqual([]);
	});

	test("a fresh read that cannot be taken refuses, and writes nothing", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		const applySpy = new WriteSpy();
		const down = { ...driftPorts(ledger, applySpy), cache: new FakeCache(new BreakerOpenError("cache", 1), applySpy) };
		expect(await applyCacheIndexRepair(down, { planId, confirm: planId })).toMatchObject({ ok: false, reason: "unavailable" });
		expect(applySpy.writes).toEqual([]);
	});
});

describe("repair: a confirmed plan touches only the planned keys", () => {
	test("apply with confirmation bumps only the two generation keys, in order, and writes no other note", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		const applySpy = new WriteSpy();
		const run = await applyCacheIndexRepair(driftPorts(ledger, applySpy), { planId, confirm: planId });
		expect(run).toEqual({ ok: true, planId, bumped: [graphGenerationKey(GRAPH), GRAPHS_GENERATION_KEY] });
		expect(applySpy.writes).toEqual([`cache.bump:${graphGenerationKey(GRAPH)}`, `cache.bump:${GRAPHS_GENERATION_KEY}`]);
		expect(ledger.notes.size).toBe(1);
	});

	test("a cache that cannot write stops the repair and reports how far it got", async () => {
		const spy = new WriteSpy();
		const ledger = new PlanLedger(spy);
		const planId = await driftPlanId(ledger, spy);
		const applySpy = new WriteSpy();
		const base = new FakeCache({ state: "present", nodes: [node("n1", 2)] }, applySpy);
		// Reads like `base`; the bump of the graphs generation key fails.
		const writes = new SpyBumper(applySpy, GRAPHS_GENERATION_KEY);
		const cache: PairCache & PairCacheBumper = {
			graphGeneration: (graphId) => base.graphGeneration(graphId),
			cachedGraph: (graphId, surface) => base.cachedGraph(graphId, surface),
			bump: (key) => writes.bump(key),
		};
		const run = await applyCacheIndexRepair({ ledger, index: new FakeIndex([], [node("n1", 3)], applySpy), cache }, { planId, confirm: planId });
		expect(run).toMatchObject({ ok: false, reason: "unavailable", detail: expect.stringContaining("bumped 1 of 2") });
		expect(applySpy.writes).toEqual([`cache.bump:${graphGenerationKey(GRAPH)}`]);
	});
});

describe("the ledger adapter", () => {
	test("reads one graph's events oldest first, and reports a full page as truncated", async () => {
		const queries: unknown[] = [];
		const reads = {
			async queryEvents(query: unknown) {
				queries.push(query);
				return [{ id: "e1" }, { id: "e2" }];
			},
			async readEvent() {
				return null;
			},
		};
		const ledger = pairLedgerFrom(reads);
		expect(await ledger.graphEvents(GRAPH)).toEqual({ ids: ["e1", "e2"], truncated: false });
		expect(queries).toEqual([{ match: { graph_id: GRAPH }, order: "asc", limit: 500 }]);
	});
});

interface StoredRow {
	id: string;
	scope: string;
	created: string;
	source_event: string | null;
}

function storedRow(id: string, scope: string, sourceEvent: string | null, createdMinutesAgo: number): StoredRow {
	return { id, scope, created: minutesAgo(createdMinutesAgo), source_event: sourceEvent };
}

/**
 * The index's memory table as the two reads see it: rows newest first, every scope mixed. `memoryForBrief` pages the shared
 * brief scopes; `memoryForGraphScope` reads one graph's own scope, as the store's SQL does, one row past `limit` to report
 * truncation. Each read is counted, so a test can tell which path the pair took.
 */
class FakeGraphStore {
	briefReads = 0;
	graphScopeReads = 0;
	constructor(private readonly rows: StoredRow[]) {}
	async memoryForBrief(_repo: null, graphId: string | null, limit: number): Promise<StoredRow[]> {
		this.briefReads += 1;
		const scopes = new Set(["global", `graph:${graphId}`]);
		return this.rows.filter((row) => scopes.has(row.scope)).slice(0, limit);
	}
	async memoryForGraphScope(graphId: string, limit: number): Promise<{ entries: StoredRow[]; truncated: boolean }> {
		this.graphScopeReads += 1;
		const matched = this.rows.filter((row) => row.scope === `graph:${graphId}`);
		return { entries: matched.slice(0, limit), truncated: matched.length > limit };
	}
	async getGraph(): Promise<null> {
		return null;
	}
	asStore(): Pick<IndexStore, "memoryForGraphScope" | "getGraph"> {
		return this as unknown as Pick<IndexStore, "memoryForGraphScope" | "getGraph">;
	}
}

describe("the index adapter: a graph's own scope", () => {
	test("a shared page full of global rows does not make a graph's comparison incomplete", async () => {
		const spy = new WriteSpy();
		const store = new FakeGraphStore([
			...Array.from({ length: PAIR_INDEX_ROWS + 50 }, (_, i) => storedRow(`g${i}`, "global", null, 1)),
			storedRow("m1", `graph:${GRAPH}`, "e1", 30),
			storedRow("m2", `graph:${GRAPH}`, "e2", 40),
		]);
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({ ledger: new FakeLedger(["e1", "e2"]), index: pairIndexFrom(store.asStore()), cache: new FakeCache({ state: "absent" }, spy) }),
			OPTIONS,
		);
		expect(report.verdict).toBe("clean");
		expect(report.counts).toMatchObject({ indexRows: 2, judged: 2, matched: 2, mismatched: 0 });
		expect(store.graphScopeReads).toBe(1);
		expect(store.briefReads).toBe(0);
		expect(spy.writes).toEqual([]);
	});

	test("a graph whose own scope overflows the page is incomplete, not clean", async () => {
		const spy = new WriteSpy();
		const ids = Array.from({ length: PAIR_INDEX_ROWS + 1 }, (_, i) => `e${i}`);
		const store = new FakeGraphStore(ids.map((id, i) => storedRow(`m${i}`, `graph:${GRAPH}`, id, 30)));
		const report = await reconcileIndexLedger(
			GRAPH,
			deps({ ledger: new FakeLedger(ids), index: pairIndexFrom(store.asStore()), cache: new FakeCache({ state: "absent" }, spy) }),
			OPTIONS,
		);
		expect(report.verdict).toBe("incomplete");
		expect(report.reason).toBe("index-rows-truncated");
		expect(report.layer).toBe("index");
		expect(report.mismatches.count).toBe(0);
		expect(spy.writes).toEqual([]);
	});
});

/** A redis double over a plain map. `get` on an absent key answers null, as the real client does. */
function fakeRedis(values: Map<string, string>): CacheRedis {
	return {
		async get(key: string) {
			return values.get(key) ?? null;
		},
		async set() {},
		async incr() {
			return 0;
		},
	};
}
