/**
 * The two cross-layer pairs phase 78 adds beside the memory-forget pair in `cross-layer-reconcile.ts`:
 *   - index -> ledger, for one graph: every provenance key the index holds (a memory row's `source_event`) must be an event
 *     the ledger holds for that graph. A `session:` source is a session reference, not a ledger event id: it is counted
 *     apart and never judged. The ledger side is read oldest first; the first index key it cannot find is reported.
 *   - cache -> index, for one graph: for every surface a caller reads the graph under (`PAIR_SURFACES`), the cached graph view
 *     (the `graph-view` entry at the graph's current generation, if that surface holds one) must hold the same nodes as the
 *     index, each at the same `lease_epoch` (the node's CAS token, bumped on every change of holder). A cached node the index
 *     lacks, an index node a present entry lacks, or a version that differs is drift. An absent entry under one surface says
 *     nothing about another surface's entry, so every surface is read.
 *
 * Read-only. The comparisons take read ports only; a clean run and a dirty run both write nothing. A layer that cannot be read
 * makes its pair `unavailable` with no drift claim: a breaker that is open is reported as `breaker-open`, never as a mismatch.
 * A read that was truncated is `incomplete`: a key the ledger did not return may simply lie past the page, so no mismatch is
 * claimed on it.
 *
 * Repair is a separate, confirmed step and is never called from a comparison. Only the cache -> index pair has a repair: a
 * stale cached graph view is made unreachable by bumping the graph's generation (and the graphs generation, which briefs
 * embed), the cache's own invalidation. Nothing is deleted. Planning writes ONE `reconcile.plan.cache-index` ledger note whose
 * event id is the plan id; the note holds exactly those two keys, a digest of them, and a digest of the cache and index state
 * the plan was made from. `applyCacheIndexRepair` refuses unless the caller passes the plan id back as `confirm`, refuses a note
 * whose items no longer match their digest, and refuses when a fresh read digests differently from the recorded state. An index
 * -> ledger mismatch has no automatic repair: a provenance key that names no event of the graph is a fact about a caller's
 * write, and the reconcile reports it without choosing a fix for it.
 */
import { createHash } from "node:crypto";
import { BreakerOpenError } from "@substrate/observability";
import { type CacheRedis, cacheKey, GRAPHS_GENERATION_KEY, graphGenerationKey } from "./cache.ts";
import { isRecord } from "./corpus/validate.ts";
import { type EventQuery, MAX_QUERY_LIMIT } from "./greptime.ts";
import { type LedgerNote, type LedgerReads, RECONCILE_REPORT_MAX, type ReconcileLedger } from "./cross-layer-reconcile.ts";
import { redact } from "./redact.ts";
import type { IndexStore } from "./index-store.ts";
import { SURFACES } from "./types.ts";

/** Ledger events one graph read may return. A full page is a truncated read: the pair is then `incomplete`. */
export const PAIR_LEDGER_LIMIT = MAX_QUERY_LIMIT;
/** In-force memory rows one graph read may return. */
export const PAIR_INDEX_ROWS = 200;
/** The cache surface a graph view is keyed under when the caller does not name one: the one `SubstrateService.getGraph` uses. */
export const PAIR_DEFAULT_SURFACE = "unattributed";
/** Every surface a graph view can be cached under: the anonymous default, then each named surface a caller can read as. */
export const PAIR_SURFACES: readonly string[] = [PAIR_DEFAULT_SURFACE, ...SURFACES];
/** The prefix of a `source_event` that names a session rather than a ledger event (`memory_write` stamps it). */
const SESSION_REF_PREFIX = "session:";

// ---------------------------------------------------------------------------
// Ports. The stores satisfy them structurally through the adapters below; tests use fakes.
// ---------------------------------------------------------------------------

/** The ledger read the index -> ledger pair needs: one graph's event ids, oldest first. */
export interface PairLedger {
	graphEvents(graphId: string): Promise<{ ids: string[]; truncated: boolean }>;
}

export interface PairMemoryRow {
	id: string;
	/** The row's scope, as the index stores it (`graph:<id>` for a graph's own row). */
	scope: string;
	/** ISO instant the row was created. */
	created: string;
	/** The ledger event the row names as its source, or null when the write named none. */
	sourceEvent: string | null;
}

export interface PairNode {
	nodeId: string;
	state: string | null;
	/** The node's CAS token: monotonic per node, bumped on every change of holder. */
	leaseEpoch: number;
}

/** The index reads both pairs need. `null` from `graphNodes` means the index holds no graph row for the id. */
export interface PairIndex {
	graphMemory(graphId: string, limit: number): Promise<{ rows: PairMemoryRow[]; truncated: boolean }>;
	graphNodes(graphId: string): Promise<PairNode[] | null>;
}

/** What the cache holds for a graph's view, read without writing. */
export type CachedGraph =
	| { state: "disabled" }
	| { state: "absent" }
	| { state: "malformed" }
	| { state: "present"; nodes: PairNode[] };

export interface PairCache {
	/** The graph's current generation: the key every graph view is cached under. Read-only. */
	graphGeneration(graphId: string): Promise<string>;
	/** The graph view cached under one surface, at the graph's current generation. */
	cachedGraph(graphId: string, surface: string): Promise<CachedGraph>;
}

export interface PairDeps {
	ledger: PairLedger;
	index: PairIndex;
	cache: PairCache;
	now: () => number;
}

export interface PairOptions {
	/**
	 * How young a memory row may be before it is not judged, ms. A row whose source event is still on its way to the ledger
	 * would otherwise read as a mismatch.
	 */
	settleMs: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type PairName = "index-ledger" | "cache-index";
/** `clean` and `drift` are claims about a complete read; `incomplete` and `unavailable` make none. */
export type PairVerdict = "clean" | "drift" | "incomplete" | "unavailable";
export type PairLayer = "ledger" | "index" | "cache";
export type PairReason = "breaker-open" | "unreadable" | "cache-disabled" | "cache-malformed" | "ledger-truncated" | "index-rows-truncated" | "generation-moved";

export interface IndexLedgerCounts {
	ledgerEvents: number;
	indexRows: number;
	/** Rows younger than the settle lag: not judged. */
	settling: number;
	/** Rows with no source event: nothing to compare. */
	unsourced: number;
	/** Rows whose source is a session reference (`session:...`): not a ledger event id, so not judged against the ledger. */
	sessionRefs: number;
	judged: number;
	matched: number;
	mismatched: number;
}

export interface CacheIndexCounts {
	/** `present` when at least one surface holds an entry at the current generation. */
	cacheState: "absent" | "present";
	/** Surfaces that held an entry at the current generation: the ones compared. */
	surfacesCompared: number;
	/** Cached nodes, summed over the compared surfaces. */
	cacheNodes: number;
	indexNodes: number;
	matched: number;
	versionMismatch: number;
	cacheOnly: number;
	indexOnly: number;
}

export type IndexLedgerMismatch = { key: string; reason: "event-not-in-ledger"; entryId: string };

/** Each mismatch names the surface whose cached view it was found in. */
export type CacheIndexMismatch =
	| { surface: string; key: string; reason: "version-mismatch"; cachedVersion: number; indexVersion: number }
	| { surface: string; key: string; reason: "cache-only"; cachedVersion: number }
	| { surface: string; key: string; reason: "index-only"; indexVersion: number };

interface PairReportBase<M> {
	graphId: string;
	verdict: PairVerdict;
	/** Why the verdict is `incomplete` or `unavailable`. Null for `clean` and `drift`. */
	reason: PairReason | null;
	/** The layer the reason is about, or null. */
	layer: PairLayer | null;
	mismatches: { count: number; first: M | null; items: M[] };
}

export interface IndexLedgerReport extends PairReportBase<IndexLedgerMismatch> {
	pair: "index-ledger";
	counts: IndexLedgerCounts;
}

export interface CacheIndexReport extends PairReportBase<CacheIndexMismatch> {
	pair: "cache-index";
	counts: CacheIndexCounts;
}

export type PairReport = IndexLedgerReport | CacheIndexReport;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detailOf(cause: unknown): string {
	return redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}


/** A layer read that failed. Only this class is turned into a report; anything else is a bug and propagates. */
class PairUnavailable extends Error {
	constructor(
		readonly layer: PairLayer,
		readonly reason: "breaker-open" | "unreadable",
		detail: string,
	) {
		super(detail);
	}
}

async function reachLayer<T>(layer: PairLayer, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (cause) {
		throw new PairUnavailable(layer, cause instanceof BreakerOpenError ? "breaker-open" : "unreadable", detailOf(cause));
	}
}

function assertOptions(options: PairOptions): void {
	if (!Number.isFinite(options.settleMs) || options.settleMs < 0) throw new RangeError("settleMs must be a non-negative number of milliseconds");
}

function capped<M>(items: M[]): { count: number; first: M | null; items: M[] } {
	return { count: items.length, first: items[0] ?? null, items: items.slice(0, RECONCILE_REPORT_MAX) };
}

const NO_MISMATCHES = { count: 0, first: null, items: [] } as const;

function unavailableReport<M>(graphId: string, error: PairUnavailable): PairReportBase<M> {
	return { graphId, verdict: "unavailable", reason: error.reason, layer: error.layer, mismatches: { ...NO_MISMATCHES, items: [] } };
}

// ---------------------------------------------------------------------------
// index -> ledger
// ---------------------------------------------------------------------------

const EMPTY_INDEX_LEDGER: IndexLedgerCounts = {
	ledgerEvents: 0,
	indexRows: 0,
	settling: 0,
	unsourced: 0,
	sessionRefs: 0,
	judged: 0,
	matched: 0,
	mismatched: 0,
};

/**
 * Compare one graph's index provenance with its ledger events. Each in-force memory row of the graph that is old enough to judge
 * and names a ledger event as its source must name an event the ledger holds for the graph. A row whose source is a session
 * reference is counted as `sessionRefs` and not judged: it names a session, not an event. Judged rows are matched by membership;
 * the reported first mismatch is the first such row in the index's own order (newest first).
 */
export async function reconcileIndexLedger(graphId: string, deps: PairDeps, options: PairOptions): Promise<IndexLedgerReport> {
	assertOptions(options);
	try {
		const events = await reachLayer("ledger", () => deps.ledger.graphEvents(graphId));
		const memory = await reachLayer("index", () => deps.index.graphMemory(graphId, PAIR_INDEX_ROWS));
		const counts: IndexLedgerCounts = { ...EMPTY_INDEX_LEDGER, ledgerEvents: events.ids.length, indexRows: memory.rows.length };
		const base = { pair: "index-ledger" as const, graphId, layer: null };

		if (events.truncated) return { ...base, verdict: "incomplete", reason: "ledger-truncated", layer: "ledger", counts, mismatches: { ...NO_MISMATCHES, items: [] } };
		if (memory.truncated) return { ...base, verdict: "incomplete", reason: "index-rows-truncated", layer: "index", counts, mismatches: { ...NO_MISMATCHES, items: [] } };

		const inLedger = new Set(events.ids);
		const cutoff = deps.now() - options.settleMs;
		const found: IndexLedgerMismatch[] = [];
		for (const row of memory.rows) {
			const createdMs = Date.parse(row.created);
			if (!(createdMs <= cutoff)) counts.settling += 1;
			else if (row.sourceEvent === null) counts.unsourced += 1;
			else if (row.sourceEvent.startsWith(SESSION_REF_PREFIX)) counts.sessionRefs += 1;
			else {
				counts.judged += 1;
				if (inLedger.has(row.sourceEvent)) counts.matched += 1;
				else {
					counts.mismatched += 1;
					found.push({ key: row.sourceEvent, reason: "event-not-in-ledger", entryId: row.id });
				}
			}
		}
		const mismatches = capped(found);
		return { ...base, verdict: mismatches.count > 0 ? "drift" : "clean", reason: null, counts, mismatches };
	} catch (cause) {
		if (cause instanceof PairUnavailable) {
			return { pair: "index-ledger", ...unavailableReport<IndexLedgerMismatch>(graphId, cause), counts: { ...EMPTY_INDEX_LEDGER } };
		}
		throw cause;
	}
}

// ---------------------------------------------------------------------------
// cache -> index
// ---------------------------------------------------------------------------

const EMPTY_CACHE_INDEX: CacheIndexCounts = {
	cacheState: "absent",
	surfacesCompared: 0,
	cacheNodes: 0,
	indexNodes: 0,
	matched: 0,
	versionMismatch: 0,
	cacheOnly: 0,
	indexOnly: 0,
};

/**
 * Compare the cached graph views with the index's nodes: one comparison per surface in `PAIR_SURFACES`, each at the graph's
 * current generation, so an entry the generation has already retired is not compared. A surface with no entry has nothing to
 * compare, and it stands in for no other surface: a stale entry under a named surface is drift even when the anonymous surface
 * holds nothing. A disabled or unreadable cache, or a malformed entry under any surface, is `unavailable`.
 */
export async function reconcileCacheIndex(graphId: string, deps: Pick<PairDeps, "index" | "cache">): Promise<CacheIndexReport> {
	const unavailable = (reason: "cache-disabled" | "cache-malformed"): CacheIndexReport => ({
		pair: "cache-index",
		graphId,
		verdict: "unavailable",
		reason,
		layer: "cache",
		counts: { ...EMPTY_CACHE_INDEX },
		mismatches: { ...NO_MISMATCHES, items: [] },
	});
	const moved = (): CacheIndexReport => ({
		pair: "cache-index",
		graphId,
		verdict: "incomplete",
		reason: "generation-moved",
		layer: "cache",
		counts: { ...EMPTY_CACHE_INDEX },
		mismatches: { ...NO_MISMATCHES, items: [] },
	});
	try {
		const generation = await reachLayer("cache", () => deps.cache.graphGeneration(graphId));
		const held: Array<{ surface: string; nodes: PairNode[] }> = [];
		for (const surface of PAIR_SURFACES) {
			const cached = await reachLayer("cache", () => deps.cache.cachedGraph(graphId, surface));
			if (cached.state === "disabled") return unavailable("cache-disabled");
			if (cached.state === "malformed") return unavailable("cache-malformed");
			if (cached.state === "present") held.push({ surface, nodes: cached.nodes });
		}
		const indexNodes = (await reachLayer("index", () => deps.index.graphNodes(graphId))) ?? [];
		// A claim or release that advanced the generation during these reads left the views and the index on different generations:
		// the old views are retired entries `graph_get` can no longer reach, so the pair cannot judge them and must not report drift.
		if ((await reachLayer("cache", () => deps.cache.graphGeneration(graphId))) !== generation) return moved();
		const counts: CacheIndexCounts = {
			...EMPTY_CACHE_INDEX,
			cacheState: held.length > 0 ? "present" : "absent",
			surfacesCompared: held.length,
			indexNodes: indexNodes.length,
		};
		const indexed = new Map(indexNodes.map((node) => [node.nodeId, node.leaseEpoch]));
		const found: CacheIndexMismatch[] = [];
		for (const { surface, nodes } of held) {
			counts.cacheNodes += nodes.length;
			const cachedIds = new Set<string>();
			for (const node of nodes) {
				cachedIds.add(node.nodeId);
				const indexVersion = indexed.get(node.nodeId);
				if (indexVersion === undefined) {
					counts.cacheOnly += 1;
					found.push({ surface, key: node.nodeId, reason: "cache-only", cachedVersion: node.leaseEpoch });
				} else if (indexVersion !== node.leaseEpoch) {
					counts.versionMismatch += 1;
					found.push({ surface, key: node.nodeId, reason: "version-mismatch", cachedVersion: node.leaseEpoch, indexVersion });
				} else counts.matched += 1;
			}
			for (const node of indexNodes) {
				if (cachedIds.has(node.nodeId)) continue;
				counts.indexOnly += 1;
				found.push({ surface, key: node.nodeId, reason: "index-only", indexVersion: node.leaseEpoch });
			}
		}
		const mismatches = capped(found);
		return { pair: "cache-index", graphId, verdict: mismatches.count > 0 ? "drift" : "clean", reason: null, layer: null, counts, mismatches };
	} catch (cause) {
		if (cause instanceof PairUnavailable) {
			return { pair: "cache-index", ...unavailableReport<CacheIndexMismatch>(graphId, cause), counts: { ...EMPTY_CACHE_INDEX } };
		}
		throw cause;
	}
}

/** Both pairs for one graph. Read-only: it is the scheduled comparison, and it never repairs. */
export async function runPairReconcile(graphId: string, deps: PairDeps, options: PairOptions): Promise<{ indexLedger: IndexLedgerReport; cacheIndex: CacheIndexReport }> {
	return {
		indexLedger: await reconcileIndexLedger(graphId, deps, options),
		cacheIndex: await reconcileCacheIndex(graphId, deps),
	};
}

// ---------------------------------------------------------------------------
// Repair (cache -> index only), gated on a confirmed plan
// ---------------------------------------------------------------------------

export interface CacheBumpItem {
	action: "bump";
	key: string;
}

/** The ledger note action a cache-index repair plan is recorded under. The plan's id is the event id of its note. */
export const CACHE_INDEX_PLAN_ACTION = "reconcile.plan.cache-index";
/** A plan id is a ledger event id, so it has the shape the forget repair's plan ids have. */
const EVENT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** A cache-index plan as the ledger holds it. `planId` is the event id of its `reconcile.plan.cache-index` note. */
export interface CacheIndexRepairPlan {
	planId: string;
	graphId: string;
	items: CacheBumpItem[];
	/** Digest of the graph and its items: a note whose items were changed after planning does not match it. */
	itemsSha256: string;
	/** Digest of the cache and index state the plan was made from. Apply refuses when a fresh read digests differently. */
	stateSha256: string;
}

/** The one write the repair makes. `ReadThroughCache.bump` satisfies it. */
export interface PairCacheBumper {
	bump(key: string): Promise<void>;
}

/** The ledger the plan is recorded in and read back from. `ReconcileLedger` satisfies it. */
export type CacheIndexLedger = Pick<ReconcileLedger, "emitNote" | "readEvent">;

/** What a repair reads and writes: the ledger for the plan record, the index and cache for the fresh read, and the cache for the bumps. */
export interface CacheIndexRepairPorts {
	ledger: CacheIndexLedger;
	index: PairIndex;
	cache: PairCache & PairCacheBumper;
}

/** Outcome of applying a repair. `not-confirmed` writes nothing; `plan-not-found` and `plan-invalid` mean the record is not a usable plan. */
export type PairRepairRun =
	| { ok: true; planId: string; bumped: string[] }
	| { ok: false; reason: "not-confirmed" | "plan-not-found" | "plan-invalid" | "unavailable"; detail: string };

/** Outcome of planning: a plan id when the report is drift; nothing when it is not; a failure when the plan record was not stored. */
export type CacheIndexPlanRun =
	| { ok: true; planId: string; items: CacheBumpItem[] }
	| { ok: true; planId: null; refused: "not-drift" }
	| { ok: false; reason: "unavailable" | "plan-not-recorded"; detail: string };

/** The confirmation a repair needs: the plan id, passed back as `confirm`. Mirrors the forget repair's request. */
export interface CacheIndexApplyRequest {
	planId: string;
	confirm?: string;
}

function cacheBumpItems(graphId: string): CacheBumpItem[] {
	const generation = graphGenerationKey(graphId);
	return [
		{ action: "bump", key: generation },
		{ action: "bump", key: GRAPHS_GENERATION_KEY },
	];
}

function planDigest(graphId: string, items: readonly CacheBumpItem[]): string {
	const canonical = JSON.stringify({ pair: "cache-index", graphId, items });
	return createHash("sha256").update(canonical).digest("hex");
}

/** What a cache-index read observed, digested. Planning records it; apply reads again and refuses when it digests differently. */
function stateDigest(report: CacheIndexReport): string {
	const state = { verdict: report.verdict, counts: report.counts, mismatches: report.mismatches };
	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/**
 * Plan the cache -> index repair of a drifted report. Writes ONE `reconcile.plan.cache-index` ledger note and returns its event id
 * as the plan id. Bumps nothing. A report that is not drift (clean, incomplete or unavailable) plans nothing and writes nothing.
 */
export async function planCacheIndexRepair(ledger: Pick<ReconcileLedger, "emitNote">, report: CacheIndexReport): Promise<CacheIndexPlanRun> {
	if (report.verdict !== "drift") return { ok: true, planId: null, refused: "not-drift" };
	const items = cacheBumpItems(report.graphId);
	const plan = { pair: "cache-index", graphId: report.graphId, items, itemsSha256: planDigest(report.graphId, items), stateSha256: stateDigest(report) };
	let written: { id: string; stored: boolean };
	try {
		written = await ledger.emitNote(`reconcile plan: cache-index drift for ${report.graphId}: ${items.length} bump(s)`, { action: CACHE_INDEX_PLAN_ACTION, plan });
	} catch (cause) {
		return { ok: false, reason: "unavailable", detail: detailOf(cause) };
	}
	if (!written.stored) return { ok: false, reason: "plan-not-recorded", detail: "the plan record was not stored (it may be parked); nothing was repaired" };
	return { ok: true, planId: written.id, items };
}

/** The plan a ledger note holds, or null when the note is not a cache-index plan, its items are not the two it names, or its digest does not match. */
function parseStoredPlan(planId: string, payload: Record<string, unknown> | null): CacheIndexRepairPlan | null {
	if (payload === null || payload.action !== CACHE_INDEX_PLAN_ACTION) return null;
	const raw = payload.plan;
	if (!isRecord(raw)) return null;
	const { graphId, items, itemsSha256, stateSha256 } = raw;
	if (typeof graphId !== "string" || graphId.length < 1) return null;
	if (typeof itemsSha256 !== "string" || typeof stateSha256 !== "string") return null;
	const expected = cacheBumpItems(graphId);
	if (!Array.isArray(items) || items.length !== expected.length) return null;
	if (!items.every((item, i) => isRecord(item) && item.action === "bump" && item.key === expected[i]?.key)) return null;
	if (planDigest(graphId, expected) !== itemsSha256) return null;
	return { planId, graphId, items: expected, itemsSha256, stateSha256 };
}

/**
 * Apply a cache-index repair. Refuses, writing nothing, unless `confirm` equals `planId` and the plan record is a valid cache-index
 * plan. Then it reads the cache and index afresh: an incomplete or unavailable read is refused, and so is one whose state digests
 * differently from the plan's, because the plan was made from other state. Only then does it bump the planned keys, and nothing else.
 */
export async function applyCacheIndexRepair(ports: CacheIndexRepairPorts, request: CacheIndexApplyRequest): Promise<PairRepairRun> {
	if (typeof request.planId !== "string" || request.confirm !== request.planId) {
		return { ok: false, reason: "not-confirmed", detail: "repair needs a confirmed plan: pass the plan id as planId and again as confirm; nothing was changed" };
	}
	const planId = request.planId;
	if (!EVENT_ID.test(planId)) return { ok: false, reason: "plan-invalid", detail: "the plan id is malformed; nothing was changed" };
	let note: LedgerNote | null;
	try {
		note = await ports.ledger.readEvent(planId);
	} catch (cause) {
		return { ok: false, reason: "unavailable", detail: detailOf(cause) };
	}
	if (note === null || note.kind !== "note") return { ok: false, reason: "plan-not-found", detail: "no ledger note has this plan id; nothing was changed" };
	const plan = parseStoredPlan(planId, note.payload);
	if (plan === null) return { ok: false, reason: "plan-invalid", detail: "the event is not a cache-index repair plan, or its items do not match its digest; nothing was changed" };
	const fresh = await reconcileCacheIndex(plan.graphId, ports);
	if (fresh.verdict === "incomplete" || fresh.verdict === "unavailable") {
		return { ok: false, reason: "unavailable", detail: `the fresh read is ${fresh.verdict}${fresh.reason === null ? "" : ` (${fresh.reason})`}; nothing was changed` };
	}
	if (stateDigest(fresh) !== plan.stateSha256) {
		return { ok: false, reason: "plan-invalid", detail: "the cache or index no longer matches the state this plan was made from; plan again. Nothing was changed" };
	}
	const bumped: string[] = [];
	for (const item of plan.items) {
		try {
			await ports.cache.bump(item.key);
		} catch (cause) {
			return { ok: false, reason: "unavailable", detail: `${detailOf(cause)}; bumped ${bumped.length} of ${plan.items.length}` };
		}
		bumped.push(item.key);
	}
	return { ok: true, planId, bumped };
}

// ---------------------------------------------------------------------------
// Adapters over the stores' existing read paths
// ---------------------------------------------------------------------------

/** The ledger's graph read: `GreptimeClient.queryEvents`, matched on `graph_id`, oldest first. */
export function pairLedgerFrom(reads: LedgerReads): PairLedger {
	return {
		async graphEvents(graphId) {
			const query: EventQuery = { match: { graph_id: graphId }, order: "asc", limit: PAIR_LEDGER_LIMIT };
			const rows = await reads.queryEvents(query);
			return { ids: rows.map((row) => String(row.id)), truncated: rows.length >= PAIR_LEDGER_LIMIT };
		},
	};
}

/**
 * The index's graph reads: `memoryForGraphScope` for the graph's own in-force rows, so the page holds only `graph:<id>` rows and
 * a busy global or repo scope cannot push them off it, and `getGraph` for the nodes.
 */
export function pairIndexFrom(store: Pick<IndexStore, "memoryForGraphScope" | "getGraph">): PairIndex {
	return {
		async graphMemory(graphId, limit) {
			const page = await store.memoryForGraphScope(graphId, limit);
			return {
				rows: page.entries.map((row) => ({ id: row.id, scope: row.scope, created: row.created, sourceEvent: row.source_event ?? null })),
				truncated: page.truncated,
			};
		},
		async graphNodes(graphId) {
			const view = await store.getGraph(graphId);
			return view === null ? null : view.nodes.map((node) => ({ nodeId: node.node_id, state: node.state, leaseEpoch: node.lease_epoch }));
		},
	};
}

/** The graph-view nodes a cached envelope holds, or null when the envelope is not one. `{ v: null }` is a graph the index lacks. */
function nodesOfEnvelope(raw: string): PairNode[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !("v" in parsed)) return null;
	const view = parsed.v;
	if (view === null) return [];
	if (!isRecord(view) || !Array.isArray(view.nodes)) return null;
	const nodes: PairNode[] = [];
	for (const node of view.nodes) {
		if (!isRecord(node) || typeof node.node_id !== "string" || typeof node.lease_epoch !== "number" || !Number.isInteger(node.lease_epoch)) return null;
		nodes.push({ nodeId: node.node_id, state: typeof node.state === "string" ? node.state : null, leaseEpoch: node.lease_epoch });
	}
	return nodes;
}

/**
 * The cache's graph view under one surface, read the way `ReadThroughCache.getOrLoad` reads it: the graph's generation, then the
 * entry keyed by that generation and surface. Only `get` is called, so every read goes through the redis client's own gated path:
 * an open breaker surfaces as `BreakerOpenError` and the pair reports `unavailable`. `redis` is null when the cache is off.
 */
export function pairCacheFrom(redis: CacheRedis | null): PairCache {
	return {
		async graphGeneration(graphId) {
			return (redis === null ? null : await redis.get(graphGenerationKey(graphId))) ?? "0";
		},
		async cachedGraph(graphId, surface) {
			if (redis === null) return { state: "disabled" };
			const generation = (await redis.get(graphGenerationKey(graphId))) ?? "0";
			const raw = await redis.get(cacheKey("graph-view", surface, generation, { graph_id: graphId }));
			if (raw === null) return { state: "absent" };
			const nodes = nodesOfEnvelope(raw);
			return nodes === null ? { state: "malformed" } : { state: "present", nodes };
		},
	};
}
