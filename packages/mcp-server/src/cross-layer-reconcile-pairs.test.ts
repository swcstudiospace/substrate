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
	type CachedGraph,
	type CacheIndexRepairPlan,
	type PairCache,
	type PairCacheBumper,
	type PairDeps,
	type PairIndex,
	type PairLedger,
	type PairMemoryRow,
	type PairNode,
	PAIR_INDEX_ROWS,
	pairCacheFrom,
	pairIndexFrom,
	pairLedgerFrom,
	applyCacheIndexRepair,
	planCacheIndexRepair,
	reconcileCacheIndex,
	reconcileIndexLedger,
	runPairReconcile,
	type CacheIndexReport,
} from "./cross-layer-reconcile-pairs.ts";
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

class FakeCache implements PairCache {
	constructor(
		private readonly value: CachedGraph | Error,
		private readonly spy: WriteSpy,
	) {}
	async cachedGraph(): Promise<CachedGraph> {
		if (this.value instanceof Error) throw this.value;
		return this.value;
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
		expect(report.counts).toEqual({ ledgerEvents: 3, indexRows: 3, settling: 0, unsourced: 1, judged: 2, matched: 2, mismatched: 0 });
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
		expect(report.counts).toEqual({ cacheState: "present", cacheNodes: 2, indexNodes: 2, matched: 2, versionMismatch: 0, cacheOnly: 0, indexOnly: 0 });
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
		expect(report.mismatches.first).toEqual({ key: "n1", reason: "version-mismatch", cachedVersion: 2, indexVersion: 3 });
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

describe("repair: refused without a confirmed plan", () => {
	async function driftReport(): Promise<CacheIndexReport> {
		const spy = new WriteSpy();
		return reconcileCacheIndex(
			GRAPH,
			deps({
				ledger: new FakeLedger([]),
				index: new FakeIndex([], [node("n1", 3)], spy),
				cache: new FakeCache({ state: "present", nodes: [node("n1", 2)] }, spy),
			}),
		);
	}

	async function driftPlan(): Promise<CacheIndexRepairPlan> {
		const plan = planCacheIndexRepair(await driftReport());
		if (plan === null) throw new Error("expected a plan for a drifted report");
		return plan;
	}

	test("a clean or unavailable report plans nothing", async () => {
		const spy = new WriteSpy();
		const clean = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 1)], spy), cache: new FakeCache({ state: "absent" }, spy) }),
		);
		expect(planCacheIndexRepair(clean)).toBeNull();
		const down = await reconcileCacheIndex(
			GRAPH,
			deps({ ledger: new FakeLedger([]), index: new FakeIndex([], [node("n1", 1)], spy), cache: new FakeCache(new BreakerOpenError("cache", 1), spy) }),
		);
		expect(planCacheIndexRepair(down)).toBeNull();
	});

	test("no plan, a missing confirmation or a wrong one is refused and writes nothing", async () => {
		const plan = await driftPlan();
		const spy = new WriteSpy();
		const bumper = new SpyBumper(spy);
		expect(await applyCacheIndexRepair({ cache: bumper }, null, plan.planId)).toMatchObject({ ok: false, reason: "not-confirmed" });
		expect(await applyCacheIndexRepair({ cache: bumper }, plan, undefined)).toMatchObject({ ok: false, reason: "not-confirmed" });
		expect(await applyCacheIndexRepair({ cache: bumper }, plan, "not-the-plan")).toMatchObject({ ok: false, reason: "not-confirmed" });
		expect(spy.writes).toEqual([]);
	});

	test("a plan whose items were altered after it was made is refused and writes nothing", async () => {
		const plan = await driftPlan();
		const spy = new WriteSpy();
		const swapped: CacheIndexRepairPlan = { ...plan, items: [...plan.items].reverse() };
		expect(await applyCacheIndexRepair({ cache: new SpyBumper(spy) }, swapped, plan.planId)).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(spy.writes).toEqual([]);
	});
});

describe("repair: a confirmed plan touches only the planned keys", () => {
	test("a confirmed plan bumps exactly its two generation keys, in order, and nothing else", async () => {
		const spy = new WriteSpy();
		const plan = planCacheIndexRepair({
			pair: "cache-index",
			graphId: GRAPH,
			verdict: "drift",
			reason: null,
			layer: null,
			counts: { cacheState: "present", cacheNodes: 1, indexNodes: 1, matched: 0, versionMismatch: 1, cacheOnly: 0, indexOnly: 0 },
			mismatches: { count: 1, first: null, items: [] },
		});
		if (plan === null) throw new Error("expected a plan");
		const run = await applyCacheIndexRepair({ cache: new SpyBumper(spy) }, plan, plan.planId);
		expect(run).toEqual({ ok: true, planId: plan.planId, bumped: [graphGenerationKey(GRAPH), GRAPHS_GENERATION_KEY] });
		expect(spy.writes).toEqual([`cache.bump:${graphGenerationKey(GRAPH)}`, `cache.bump:${GRAPHS_GENERATION_KEY}`]);
	});

	test("a cache that cannot write stops the repair and reports how far it got", async () => {
		const spy = new WriteSpy();
		const plan = planCacheIndexRepair({
			pair: "cache-index",
			graphId: GRAPH,
			verdict: "drift",
			reason: null,
			layer: null,
			counts: { cacheState: "present", cacheNodes: 1, indexNodes: 1, matched: 0, versionMismatch: 1, cacheOnly: 0, indexOnly: 0 },
			mismatches: { count: 1, first: null, items: [] },
		});
		if (plan === null) throw new Error("expected a plan");
		const run = await applyCacheIndexRepair({ cache: new SpyBumper(spy, GRAPHS_GENERATION_KEY) }, plan, plan.planId);
		expect(run).toMatchObject({ ok: false, reason: "unavailable" });
		expect(spy.writes).toEqual([`cache.bump:${graphGenerationKey(GRAPH)}`]);
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
