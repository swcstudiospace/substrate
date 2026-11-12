/**
 * The cross-layer reconcile (v1.8 phase 78): the ledger, the index and the cache must agree about memory forgets, and a
 * disagreement is reported with its first key and the evidence for it.
 *
 * Why this pair. `Substrate.memoryForget` does four things: it marks the index rows out of force (`superseded_by` becomes
 * the forget marker), emits ONE `memory.forget` note into the ledger, then bumps the recall and memory generations and sets
 * the cache forget mark. The index keeps no ledger event id, so only this pair has a precise key: a forget note names its
 * forget id and its entry ids. The reconcile judges four agreements, and reports each mismatch with its key and its evidence:
 *   - ledger -> index: an entry a forget note names must not still be in force in the index. An entry the index no longer
 *     has, or that another superseder already holds, is consistent with the forget and is not a mismatch.
 *   - ledger -> cache: a forget that marked rows set the forget mark at or after its note, for as long as the mark is meant
 *     to live (`markTtlS`). An older forget may legitimately have let its mark expire.
 *   - index -> ledger: a forget mark the index set in the window (its `forgotten_at`, migration 47) must have a `memory.forget`
 *     note for its forget id that names the entry, or a `reconcile.applied` note that marked it: a repair stamps `forgotten_at` with
 *     the repair's time, so its forget note may be older than the window. A window or note read short is not judged.
 *   - cache -> index: a forget mark present in the cache and not older than the latest forget must find that forget in the
 *     index: an entry the index still holds carries the forget's marker.
 * The index -> ledger and cache -> index findings are report-only: they add no `RepairItem`, so the repair flow never acts on
 * them. Only ledger -> index and ledger -> cache findings are repairable, and only on a complete read.
 *
 * Read-only by default. `runScheduledReconcile` writes nothing, clean or not. `planRepair` writes ONE plan record (a
 * `reconcile.plan` ledger note, whose event id is the plan id) and only when there is a repair to make on a complete read.
 * `applyRepair` refuses without the plan id as its confirmation, then applies only the items the stored plan holds.
 *
 * The corpus delete rules (`corpus/plan.ts`, `corpus/reconcile.ts`) are the model:
 *   - scope: repair needs a complete read (no truncated window, no capped key set, no malformed or partial forget note). An
 *     incomplete read is reported and plans nothing, as a narrow scan tombstones nothing outside its coverage.
 *   - never overwrite: a row another superseder holds is left alone. `markMemoryForgotten` only marks rows still in force.
 *   - never remove: a forget keeps the row for audit, so repair marks and never deletes.
 *   - planned keys only: apply re-reads each planned key and touches nothing else, whatever has drifted since the plan.
 *   - the plan is recorded before any repair, and the apply records what it did in a `reconcile.applied` note.
 * Apply is idempotent for the index: a planned key already marked is skipped, so a repeat apply marks nothing new.
 */
import { createHash } from "node:crypto";
import { FORGET_MARK_KEY, type ForgetMarkRead, MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY } from "./cache.ts";
import { isRecord } from "./corpus/validate.ts";
import { type EventQuery, epochMsAnyUnit, MAX_QUERY_LIMIT } from "./greptime.ts";
import { FORGET_ACTION, forgetIdOfMarker, forgetMarker, isForgetMarker } from "./memory-forget.ts";
import { redact } from "./redact.ts";
import type { Surface } from "./types.ts";

export const RECONCILE_PLAN_ACTION = "reconcile.plan";
export const RECONCILE_APPLIED_ACTION = "reconcile.applied";
/** Notes one window read may return. A full page is a truncated window: what it does not show is not judged. */
export const RECONCILE_LEDGER_LIMIT = MAX_QUERY_LIMIT;
/** Distinct entry ids one run judges. Past it the run is incomplete and plans nothing. */
export const RECONCILE_MAX_KEYS = 200;
/** Items one plan record may hold, so the record stays under the ledger's 16 KB payload cap. */
export const RECONCILE_PLAN_MAX_ITEMS = 50;
/** Mismatches a report names in full. Its count is always exact. */
export const RECONCILE_REPORT_MAX = 20;

/** The longest a repaired forget mark may be held: a week. */
const MAX_MARK_TTL_S = 7 * 24 * 3600;
const EVENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The forget id shape `memory-forget.ts` mints. */
const FORGET_ID = /^fg_[0-9a-f]{26}$/;

// ---------------------------------------------------------------------------
// Ports. The stores satisfy them structurally; tests use fakes.
// ---------------------------------------------------------------------------

/** One ledger event as the reconcile reads it. `payload` is null when the stored payload did not decode. */
export interface LedgerNote {
	id: string;
	/** ISO instant of the event's ts. */
	ts: string;
	kind: string;
	payload: Record<string, unknown> | null;
}

export interface NoteWindow {
	notes: LedgerNote[];
	/** The page was full, so the window may hold notes this read did not return. */
	truncated: boolean;
}

export interface ReconcileLedger {
	/** The `note` events with ts in [since, until], oldest first. */
	notesBetween(since: string, until: string): Promise<NoteWindow>;
	/** One event by id, or null when no event has it. */
	readEvent(id: string): Promise<LedgerNote | null>;
	/** Writes one `note` on the reconcile's surface through the chained write path. `stored` is false when it was not written. */
	emitNote(summary: string, payload: Record<string, unknown>): Promise<{ id: string; stored: boolean }>;
}

/** The index reads and the one guarded write the reconcile uses. `IndexStore` satisfies it. */
export interface ReconcileIndex {
	/** `superseded_by` for each id that has a row; an id with no row is absent from the map. */
	memoryMarkers(ids: readonly string[]): Promise<Map<string, string | null>>;
	/** Marks rows still in force with `marker` and returns the ids this call changed. Never overwrites another superseder. */
	markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]>;
	/**
	 * The forget marks `markMemoryForgotten` set in [sinceIso, untilIso] (inclusive, to the millisecond), oldest first, at most
	 * `limit`; `truncated` is true when more matched. Read for the index -> ledger direction.
	 */
	forgetMarksBetween(sinceIso: string, untilIso: string, limit: number): Promise<{ marks: Array<{ entryId: string; marker: string }>; truncated: boolean }>;
}

/** The cache's forget mark. `ReadThroughCache` satisfies it. */
export interface ReconcileCache {
	/** Throws when the mark cannot be read; never answers `absent` for a failed read. */
	readForgetMark(): Promise<ForgetMarkRead>;
	/** Sets the mark to now for `ttlSeconds`. */
	markForget(ttlSeconds: number): Promise<void>;
	/** Moves a generation, so every cached answer keyed under it is no longer served. `ReadThroughCache` satisfies it. */
	bump(key: string): Promise<void>;
}

export interface ReconcileDeps {
	ledger: ReconcileLedger;
	index: ReconcileIndex;
	cache: ReconcileCache;
	now: () => number;
}

export interface ReconcileOptions {
	/** Length of the judged window, ms. */
	windowMs: number;
	/** How old a note must be before it is judged, ms. A write the telemetry buffer parked lands after its retry budget, so judging it sooner would call a late write drift. */
	settleMs: number;
	/** The cache forget mark's lifetime, seconds: what `Substrate` holds the mark for. A forget older than this may have legitimately expired its mark. */
	markTtlS: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type UnavailableReason = "ledger-unavailable" | "index-unavailable" | "cache-unavailable";
export type FailureReason = UnavailableReason | "not-confirmed" | "plan-not-found" | "plan-invalid" | "plan-not-recorded";

export interface Failure {
	ok: false;
	reason: FailureReason;
	/** Redacted and short: a connection error can quote a URL. */
	detail: string;
}

export type Mismatch =
	| { layer: "index"; key: string; reason: "in-force"; forgetId: string; noteId: string }
	| { layer: "index"; key: string; reason: "unnoted-forget"; forgetId: string; marker: string }
	| { layer: "cache"; key: string; reason: "stale-forget-mark" }
	| { layer: "cache"; key: string; reason: "forget-not-in-index"; forgetId: string; noteId: string };

export interface CrossLayerReport {
	window: { since: string; until: string };
	coverage: {
		/** The read was complete: a repair may be planned from it. */
		complete: boolean;
		ledgerTruncated: boolean;
		keysTruncated: boolean;
		/** Ledger notes the reconcile could not read as a forget. */
		malformedNotes: number;
		/** Forget notes that name fewer entries than they touched. */
		partialNotes: number;
	};
	layers: {
		ledger: { forgetNotes: number; notesWithMarks: number; namedEntries: number };
		index: { forgotten: number; superseded: number; absent: number; inForce: number };
		cache: { state: ForgetMarkRead["state"]; atMs: number | null; checked: boolean };
	};
	mismatches: { count: number; first: Mismatch | null; items: Mismatch[] };
	/** Mismatches a confirmed plan could repair: all of them on a complete read, none otherwise. */
	repairable: number;
}

export type ReconcileRun = { ok: true; report: CrossLayerReport } | Failure;

export type RepairItem = IndexMarkItem | CacheMarkItem;
export interface IndexMarkItem {
	action: "index-mark";
	entryId: string;
	forgetId: string;
	marker: string;
}
export interface CacheMarkItem {
	action: "cache-mark";
	key: string;
	ttlS: number;
}

export type PlanRun =
	| { ok: true; report: CrossLayerReport; planId: string | null; items: RepairItem[]; refused: "incomplete-coverage" | "too-many-items" | null }
	| Failure;

/** A read of the layers and the repairs it calls for. Writes nothing. */
export type PreviewRun = { ok: true; report: CrossLayerReport; items: RepairItem[] } | Failure;

export type SkipReason = "absent" | "already-marked" | "forgotten-by-other" | "superseded" | "raced";

export interface ApplyReport {
	ok: true;
	planId: string;
	marked: string[];
	skipped: Array<{ entryId: string; reason: SkipReason }>;
	cache: "marked" | "unverified" | "not-planned";
	/** Whether the `reconcile.applied` note was stored. Repairs already made stay made; a repeat apply marks nothing new. */
	recorded: boolean;
	recordError: string | null;
}

export type ApplyRun = ApplyReport | Failure;

export interface ApplyRequest {
	planId?: unknown;
	/** Must equal `planId`: the explicit confirmation. */
	confirm?: unknown;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function detailOf(cause: unknown): string {
	return redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}

/** A port call that failed, tagged with the layer it failed on. Only this class becomes a `Failure`; anything else is a bug and propagates. */
class Unavailable extends Error {
	constructor(
		readonly reason: UnavailableReason,
		detail: string,
	) {
		super(detail);
	}
}

async function reach<T>(reason: UnavailableReason, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (cause) {
		throw new Unavailable(reason, detailOf(cause));
	}
}

function failureOf(cause: unknown): Failure {
	if (cause instanceof Unavailable) return { ok: false, reason: cause.reason, detail: cause.message };
	throw cause;
}

function assertOptions(options: ReconcileOptions): void {
	if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new RangeError("windowMs must be a positive number of milliseconds");
	if (!Number.isFinite(options.settleMs) || options.settleMs < 0) throw new RangeError("settleMs must be a non-negative number of milliseconds");
	if (!Number.isInteger(options.markTtlS) || options.markTtlS < 1 || options.markTtlS > MAX_MARK_TTL_S) {
		throw new RangeError(`markTtlS must be an integer from 1 to ${MAX_MARK_TTL_S}`);
	}
}

// ---------------------------------------------------------------------------
// Reading the ledger's forget notes
// ---------------------------------------------------------------------------

interface ForgetFact {
	noteId: string;
	atMs: number;
	forgetId: string;
	marked: number;
	entryIds: string[];
	/** The payload names every entry the forget touched. It keeps only the first few, so a longer forget is partial. */
	namesAll: boolean;
}

type NoteRead = { kind: "other" } | { kind: "malformed" } | { kind: "forget"; fact: ForgetFact } | { kind: "applied"; marked: string[] };

function readNote(note: LedgerNote): NoteRead {
	const payload = note.payload;
	// A payload that did not decode could be a forget that cannot be judged, so it is malformed, not ignored.
	if (payload === null) return { kind: "malformed" };
	if (payload.action === RECONCILE_APPLIED_ACTION) {
		// The entries a repair marked. A list that does not read as entry ids is malformed: the repaired rows cannot be known.
		const marked = payload.marked;
		return Array.isArray(marked) && marked.every(isEntryId) ? { kind: "applied", marked } : { kind: "malformed" };
	}
	if (payload.action !== FORGET_ACTION) return { kind: "other" };
	const atMs = Date.parse(note.ts);
	const { forget_id: forgetId, counts, entry_count: entryCount, entry_ids: entryIds } = payload;
	const marked = isRecord(counts) ? counts.marked : undefined;
	if (!Number.isFinite(atMs) || typeof forgetId !== "string" || !FORGET_ID.test(forgetId)) return { kind: "malformed" };
	if (typeof marked !== "number" || !Number.isInteger(marked) || marked < 0) return { kind: "malformed" };
	if (typeof entryCount !== "number" || !Number.isInteger(entryCount) || entryCount < 1) return { kind: "malformed" };
	if (!Array.isArray(entryIds) || !entryIds.every(isEntryId)) return { kind: "malformed" };
	return {
		kind: "forget",
		fact: { noteId: note.id, atMs, forgetId, marked, entryIds, namesAll: entryIds.length === entryCount },
	};
}

function isEntryId(value: unknown): value is string {
	return typeof value === "string" && ENTRY_ID.test(value);
}

// ---------------------------------------------------------------------------
// Observing both layers
// ---------------------------------------------------------------------------

interface Observation {
	report: CrossLayerReport;
	/** Every entry still in force, once each, with the first forget that named it. */
	inForce: Array<{ entryId: string; forgetId: string }>;
	cacheStale: boolean;
}

async function observe(deps: ReconcileDeps, options: ReconcileOptions): Promise<Observation> {
	const now = deps.now();
	const until = now - options.settleMs;
	const since = until - options.windowMs;
	const window = await reach("ledger-unavailable", () => deps.ledger.notesBetween(iso(since), iso(until)));

	let malformed = 0;
	const facts: ForgetFact[] = [];
	// The entries a repair marked in the window: their index marks are the repair's, not the forget's.
	const repaired = new Set<string>();
	for (const note of window.notes) {
		const read = readNote(note);
		if (read.kind === "malformed") malformed += 1;
		else if (read.kind === "forget") facts.push(read.fact);
		else if (read.kind === "applied") for (const entryId of read.marked) repaired.add(entryId);
	}
	facts.sort((left, right) => left.atMs - right.atMs || (left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0));

	// Each distinct entry is judged once, against the first forget that named it.
	const firstFact = new Map<string, ForgetFact>();
	let keysTruncated = false;
	for (const fact of facts) {
		for (const entryId of fact.entryIds) {
			if (firstFact.has(entryId)) continue;
			if (firstFact.size >= RECONCILE_MAX_KEYS) {
				keysTruncated = true;
				continue;
			}
			firstFact.set(entryId, fact);
		}
	}

	const markers = await reach("index-unavailable", () => deps.index.memoryMarkers([...firstFact.keys()]));
	let forgotten = 0;
	let superseded = 0;
	let absent = 0;
	const inForce: Array<{ entryId: string; forgetId: string }> = [];
	const items: Mismatch[] = [];
	for (const [entryId, fact] of firstFact) {
		if (!markers.has(entryId)) {
			absent += 1;
			continue;
		}
		const marker = markers.get(entryId) ?? null;
		if (marker === null) {
			inForce.push({ entryId, forgetId: fact.forgetId });
			items.push({ layer: "index", key: entryId, reason: "in-force", forgetId: fact.forgetId, noteId: fact.noteId });
		} else if (isForgetMarker(marker)) {
			forgotten += 1;
		} else {
			superseded += 1;
		}
	}

	// Index -> ledger: a forget mark the index set in the window must have a `memory.forget` note for its forget id that names the
	// entry. The index window ends a settle lag early: a forget's note is written just after its mark, so the note is in the ledger
	// window once the mark is at or before `until - settleMs`. A window read short, or a malformed note that may be this forget's,
	// is not judged, and neither is a partial note that may name the entry past its kept ids. Report only.
	const reportOnly: Mismatch[] = [];
	const marksUntil = Math.max(since, until - options.settleMs);
	const marks = await reach("index-unavailable", () => deps.index.forgetMarksBetween(iso(since), iso(marksUntil), RECONCILE_MAX_KEYS));
	if (marks.truncated) keysTruncated = true;
	if (!window.truncated && malformed === 0) {
		// An entry is unnoted only when no note in the window names it under ANY forget id: a later superseder or another forget
		// holding it is consistent with the forget. A partial note of this same forget may name it past its kept ids.
		// A repair marks a row with the forget it repairs, and stamps `forgotten_at` with the repair's time. Its forget note may be older
		// than the window, so an entry a `reconcile.applied` note marked is the repair's, not an unnoted forget.
		const namedEntries = new Set(facts.flatMap((fact) => fact.entryIds));
		const partialForgets = new Set(facts.filter((fact) => !fact.namesAll).map((fact) => fact.forgetId));
		for (const mark of marks.marks) {
			// `markMemoryForgotten` writes only well-formed forget markers; any other value is not a forget mark and is not judged.
			const forgetId = forgetIdOfMarker(mark.marker);
			if (forgetId === null) continue;
			if (namedEntries.has(mark.entryId) || partialForgets.has(forgetId) || repaired.has(mark.entryId)) continue;
			reportOnly.push({ layer: "index", key: mark.entryId, reason: "unnoted-forget", forgetId, marker: mark.marker });
		}
	}

	// The cache must hold the forget mark for the latest forget that marked rows, while the mark is meant to live.
	const mark = await reach("cache-unavailable", () => deps.cache.readForgetMark());
	const withMarks = facts.filter((fact) => fact.marked > 0);
	const latest = withMarks.length > 0 ? (withMarks[withMarks.length - 1] ?? null) : null;
	let checked = false;
	let cacheStale = false;
	if (latest !== null && mark.state !== "disabled" && now - latest.atMs < options.markTtlS * 1000) {
		checked = true;
		cacheStale = !(mark.state === "present" && mark.atMs >= latest.atMs);
	}
	if (cacheStale) items.push({ layer: "cache", key: FORGET_MARK_KEY, reason: "stale-forget-mark" });

	// Cache -> index: a mark present and not older than the latest forget reflects that forget, so the index must hold its effect.
	// The forget's entries the index still holds must not all be in force. Report only; no repair item.
	if (checked && !cacheStale && latest !== null) {
		const latestMarkers = await reach("index-unavailable", () => deps.index.memoryMarkers(latest.entryIds));
		// The entries the index still holds, under the same rule: held by a later superseder or another forget counts as consistent.
		// Flagged only when every held entry of the latest forget is in force, which is what the forget was meant to take out of force.
		const held = [...latestMarkers.values()];
		if (held.length > 0 && held.every((value) => value === null)) {
			reportOnly.push({ layer: "cache", key: FORGET_MARK_KEY, reason: "forget-not-in-index", forgetId: latest.forgetId, noteId: latest.noteId });
		}
	}
	const findings: Mismatch[] = [...items, ...reportOnly];

	const partialNotes = facts.filter((fact) => !fact.namesAll).length;
	const coverage = {
		complete: !window.truncated && !keysTruncated && malformed === 0 && partialNotes === 0,
		ledgerTruncated: window.truncated,
		keysTruncated,
		malformedNotes: malformed,
		partialNotes,
	};
	const report: CrossLayerReport = {
		window: { since: iso(since), until: iso(until) },
		coverage,
		layers: {
			ledger: { forgetNotes: facts.length, notesWithMarks: withMarks.length, namedEntries: firstFact.size },
			index: { forgotten, superseded, absent, inForce: inForce.length },
			cache: { state: mark.state, atMs: mark.state === "present" ? mark.atMs : null, checked },
		},
		mismatches: { count: findings.length, first: findings[0] ?? null, items: findings.slice(0, RECONCILE_REPORT_MAX) },
		repairable: coverage.complete ? items.length : 0,
	};
	return { report, inForce, cacheStale };
}

/**
 * The scheduled reconcile. Reads the ledger window, the index and the cache mark, and reports per-layer counts and the first
 * mismatching key. It writes nothing, on a clean run or on a dirty one. Never throws for a layer that is down: that is the
 * `Failure` it returns.
 */
export async function runScheduledReconcile(deps: ReconcileDeps, options: ReconcileOptions): Promise<ReconcileRun> {
	assertOptions(options);
	try {
		return { ok: true, report: (await observe(deps, options)).report };
	} catch (cause) {
		return failureOf(cause);
	}
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function repairItemsOf(observed: Observation, markTtlS: number): RepairItem[] {
	const items: RepairItem[] = observed.inForce.map(({ entryId, forgetId }): IndexMarkItem => ({
		action: "index-mark",
		entryId,
		forgetId,
		marker: forgetMarker(forgetId),
	}));
	// An index mark is invalidated with the cache mark, as `memoryForget` sets it on every forget, whether or not the cache agreed.
	if (observed.cacheStale || items.length > 0) items.push({ action: "cache-mark", key: FORGET_MARK_KEY, ttlS: markTtlS });
	return items;
}

/**
 * Plan the repair of what the read found. Writes ONE plan record when there is something to repair on a complete read, and
 * returns its id, which `applyRepair` needs as its confirmation. Writes nothing when the layers agree on a complete read. An
 * incomplete read is refused even when it shows no repair: a read short of its coverage cannot show that the layers agree. A plan
 * that is not stored is `plan-not-recorded`: nothing is repaired.
 */
export async function planRepair(deps: ReconcileDeps, options: ReconcileOptions): Promise<PlanRun> {
	assertOptions(options);
	try {
		const observed = await observe(deps, options);
		const { report } = observed;
		const items = repairItemsOf(observed, options.markTtlS);
		if (!report.coverage.complete) return { ok: true, report, planId: null, items: [], refused: "incomplete-coverage" };
		if (items.length === 0) return { ok: true, report, planId: null, items, refused: null };
		if (items.length > RECONCILE_PLAN_MAX_ITEMS) return { ok: true, report, planId: null, items: [], refused: "too-many-items" };

		const plan = { items, itemsSha256: repairDigest(items), window: report.window };
		const written = await reach("ledger-unavailable", () =>
			deps.ledger.emitNote(`reconcile plan: ${items.length} repair(s) for ${report.window.since} to ${report.window.until}`, {
				action: RECONCILE_PLAN_ACTION,
				plan,
			}),
		);
		if (!written.stored) {
			return { ok: false, reason: "plan-not-recorded", detail: "the plan record was not stored (it may be parked); nothing was repaired" };
		}
		return { ok: true, report, planId: written.id, items, refused: null };
	} catch (cause) {
		return failureOf(cause);
	}
}

/** The digest a plan carries over its items: what `applyRepair` checks, and what a fresh read is compared with. */
export function repairDigest(items: readonly RepairItem[]): string {
	return sha256(JSON.stringify(items));
}

/**
 * The repair a fresh read would plan, written nowhere: the items `planRepair` would record. Empty when the layers agree.
 * `substrate reconcile --apply` checks these against the stored plan with `freshItemsWithinPlan` before it applies anything.
 */
export async function previewRepair(deps: ReconcileDeps, options: ReconcileOptions): Promise<PreviewRun> {
	assertOptions(options);
	try {
		const observed = await observe(deps, options);
		const items = repairItemsOf(observed, options.markTtlS);
		return { ok: true, report: observed.report, items };
	} catch (cause) {
		return failureOf(cause);
	}
}

function isIndexMark(item: RepairItem): item is IndexMarkItem {
	return item.action === "index-mark";
}

function isCacheMark(item: RepairItem): item is CacheMarkItem {
	return item.action === "cache-mark";
}

function parseItem(raw: unknown): RepairItem | null {
	if (!isRecord(raw)) return null;
	if (raw.action === "index-mark") {
		const { entryId, forgetId, marker } = raw;
		if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) return null;
		if (typeof forgetId !== "string" || !FORGET_ID.test(forgetId)) return null;
		if (typeof marker !== "string" || marker !== forgetMarker(forgetId)) return null;
		return { action: "index-mark", entryId, forgetId, marker };
	}
	if (raw.action === "cache-mark") {
		const { key, ttlS } = raw;
		if (typeof key !== "string" || key !== FORGET_MARK_KEY) return null;
		if (typeof ttlS !== "number" || !Number.isInteger(ttlS) || ttlS < 1 || ttlS > MAX_MARK_TTL_S) return null;
		return { action: "cache-mark", key, ttlS };
	}
	return null;
}

/** The items of a stored plan, or null when the event is not a plan, its items do not parse, or its digest does not match. */
function parseStoredPlan(payload: Record<string, unknown> | null): RepairItem[] | null {
	if (payload === null || payload.action !== RECONCILE_PLAN_ACTION) return null;
	const plan = payload.plan;
	if (!isRecord(plan)) return null;
	const { items, itemsSha256 } = plan;
	if (typeof itemsSha256 !== "string" || !Array.isArray(items)) return null;
	if (items.length < 1 || items.length > RECONCILE_PLAN_MAX_ITEMS) return null;
	const parsed: RepairItem[] = [];
	for (const raw of items) {
		const item = parseItem(raw);
		if (item === null) return null;
		parsed.push(item);
	}
	if (parsed.filter(isCacheMark).length > 1) return null;
	// An index mark comes with the cache mark that invalidates it. A plan without one predates that rule: applying it would mark rows and leave the cache serving them, so it is refused and must be planned again.
	if (parsed.some(isIndexMark) && !parsed.some(isCacheMark)) return null;
	if (repairDigest(parsed) !== itemsSha256) return null;
	return parsed;
}

/** The items of a ledger note that is a stored reconcile plan, or null when it is not one or its items do not parse. */
export function storedPlanItems(note: LedgerNote | null): RepairItem[] | null {
	if (note === null || note.kind !== "note") return null;
	return parseStoredPlan(note.payload);
}

/**
 * Whether a fresh read's repairs are the stored plan's, or a part of them. A partly applied plan drops its applied items out of a
 * fresh read, so the rest still matches. An item the plan never held, or one whose content changed, is not the plan.
 */
export function freshItemsWithinPlan(stored: readonly RepairItem[], fresh: readonly RepairItem[]): boolean {
	return fresh.every((item) => stored.some((planned) => sameItem(planned, item)));
}

function sameItem(left: RepairItem, right: RepairItem): boolean {
	if (isIndexMark(left) && isIndexMark(right)) return left.entryId === right.entryId && left.forgetId === right.forgetId && left.marker === right.marker;
	if (isCacheMark(left) && isCacheMark(right)) return left.key === right.key && left.ttlS === right.ttlS;
	return false;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * What a forget invalidates, as `Substrate.memoryForget` does it: the memory and recall generations, which a cached search,
 * recall or brief is keyed under, and the forget mark, which a saved brief (it has no generation) is checked against.
 */
async function invalidateForgets(deps: ReconcileDeps, ttlS: number): Promise<void> {
	await reach("cache-unavailable", () => deps.cache.bump(MEMORY_GENERATION_KEY));
	await reach("cache-unavailable", () => deps.cache.bump(RECALL_GENERATION_KEY));
	await reach("cache-unavailable", () => deps.cache.markForget(ttlS));
}

/**
 * Apply a confirmed plan. Refuses, writing nothing, unless `confirm` equals `planId` and the plan record is a valid stored
 * plan. Then, for each planned key only: marks an in-force index row with the plan's forget marker (never a row another
 * superseder holds). Whenever a mark was attempted, the forget's invalidation runs as `Substrate.memoryForget` does it: the
 * memory and recall generations move and the cache forget mark is set for the plan's TTL, so a cached answer or saved brief
 * naming the entry is not served. Records what it did in a `reconcile.applied` note. A layer that fails mid-apply returns
 * its `Failure`; the plan can be applied again, because a key already marked is skipped.
 */
export async function applyRepair(deps: ReconcileDeps, request: ApplyRequest): Promise<ApplyRun> {
	if (typeof request.planId !== "string" || request.confirm !== request.planId) {
		return { ok: false, reason: "not-confirmed", detail: "repair needs a confirmed plan: pass the plan id as planId and again as confirm" };
	}
	const planId = request.planId;
	if (!EVENT_ID.test(planId)) return { ok: false, reason: "plan-invalid", detail: "the plan id is malformed" };
	try {
		const note = await reach("ledger-unavailable", () => deps.ledger.readEvent(planId));
		if (note === null || note.kind !== "note") return { ok: false, reason: "plan-not-found", detail: "no ledger note has this plan id" };
		const items = parseStoredPlan(note.payload);
		if (items === null) return { ok: false, reason: "plan-invalid", detail: "the event is not a reconcile plan, or its items do not match its digest" };

		const indexItems = items.filter(isIndexMark);
		const markers = await reach("index-unavailable", () => deps.index.memoryMarkers(indexItems.map((item) => item.entryId)));
		const skipped: ApplyReport["skipped"] = [];
		const toMark = new Map<string, string[]>();
		for (const item of indexItems) {
			const current = markers.get(item.entryId);
			if (current === undefined) skipped.push({ entryId: item.entryId, reason: "absent" });
			else if (current === item.marker) skipped.push({ entryId: item.entryId, reason: "already-marked" });
			else if (current !== null) skipped.push({ entryId: item.entryId, reason: isForgetMarker(current) ? "forgotten-by-other" : "superseded" });
			else {
				const group = toMark.get(item.marker) ?? [];
				group.push(item.entryId);
				toMark.set(item.marker, group);
			}
		}
		const cacheItem = items.find(isCacheMark);
		const marked: string[] = [];
		// Set before the first mark call: a call that throws may still have committed its rows, so the invalidation must run for it too.
		let attempted = false;
		try {
			for (const [marker, ids] of toMark) {
				attempted = true;
				const changed = new Set(await reach("index-unavailable", () => deps.index.markMemoryForgotten(ids, marker)));
				for (const id of ids) {
					if (changed.has(id)) marked.push(id);
					else skipped.push({ entryId: id, reason: "raced" });
				}
			}
		} catch (cause) {
			if (attempted && cacheItem !== undefined) await invalidateForgets(deps, cacheItem.ttlS);
			throw cause;
		}

		let cache: ApplyReport["cache"] = "not-planned";
		if (cacheItem !== undefined) {
			if (attempted) await invalidateForgets(deps, cacheItem.ttlS);
			else await reach("cache-unavailable", () => deps.cache.markForget(cacheItem.ttlS));
			const after = await reach("cache-unavailable", () => deps.cache.readForgetMark());
			cache = after.state === "present" ? "marked" : "unverified";
		}

		const recording = await deps.ledger
			.emitNote(`reconcile applied: ${marked.length} marked, ${skipped.length} skipped`, {
				action: RECONCILE_APPLIED_ACTION,
				planId,
				marked,
				skipped,
				cache,
			})
			.then(
				(written) => ({ recorded: written.stored, recordError: null }),
				(cause: unknown) => ({ recorded: false, recordError: detailOf(cause) }),
			);
		return { ok: true, planId, marked, skipped, cache, ...recording };
	} catch (cause) {
		return failureOf(cause);
	}
}

// ---------------------------------------------------------------------------
// Adapters over the ledger's own read and write paths
// ---------------------------------------------------------------------------

/** The reads the ledger adapter needs from `GreptimeClient`. */
export interface LedgerReads {
	queryEvents(query: EventQuery): Promise<Array<Record<string, unknown>>>;
	readEvent(id: string): Promise<Record<string, unknown> | null>;
}

/** The write the ledger adapter needs: one `note` through the ledger's chained, redacting write path (`Substrate.emit`, or the repair run's direct append). */
export interface NoteWriter {
	emit(input: { surface: Surface; kind: "note"; summary: string; payload: Record<string, unknown> }): Promise<{ stored: boolean; event: { id: string } }>;
}

function decodePayload(raw: unknown): Record<string, unknown> | null {
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch {
		// A payload that is not JSON is an undecodable row; `readNote` counts it as malformed, so it is reported, not skipped.
		return null;
	}
}

function toNote(row: Record<string, unknown>): LedgerNote {
	const atMs = epochMsAnyUnit(row.ts);
	if (!Number.isFinite(atMs)) throw new Error(`ledger row ${String(row.id)} has a ts that is not a time`);
	return { id: String(row.id), ts: iso(atMs), kind: String(row.kind), payload: decodePayload(row.payload) };
}

/**
 * A `ReconcileLedger` over the ledger's read path (`GreptimeClient`) and the `NoteWriter` given for its write path. Reads ask for the
 * payload, so a forget note can be judged. A row whose ts does not read as a time fails the read rather than being dropped.
 */
export function ledgerFromSubstrate(surface: Surface, reads: LedgerReads, writer: NoteWriter): ReconcileLedger {
	return {
		async notesBetween(since, until) {
			const rows = await reads.queryEvents({
				match: { kind: "note" },
				since,
				until,
				includePayload: true,
				order: "asc",
				limit: RECONCILE_LEDGER_LIMIT,
			});
			return { notes: rows.map(toNote), truncated: rows.length >= RECONCILE_LEDGER_LIMIT };
		},
		async readEvent(id) {
			const row = await reads.readEvent(id);
			return row === null ? null : toNote(row);
		},
		async emitNote(summary, payload) {
			const result = await writer.emit({ surface, kind: "note", summary, payload });
			return { id: result.event.id, stored: result.stored };
		},
	};
}
