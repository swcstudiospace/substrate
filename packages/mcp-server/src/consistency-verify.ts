/**
 * The cross-store consistency verifier (v1.6, phase 57, unit d).
 *
 * Three stores describe the same memory: the index (`memory_entries`, the
 * authoritative row per entry), the Hindsight bank (one derived document per
 * retained entry, rebuildable) and the ledger (one `memory.write` note per
 * governed write). After outages, parked retains, forgets and rollbacks they
 * can drift; this module compares them and reports the drift as data.
 *
 * Pure by construction: no I/O, no clock, no randomness of its own. The three
 * stores arrive as small reader interfaces, the clock and the timer are
 * injected, and the report is deterministic (sorted findings, byte-stable
 * JSON from {@link formatReportJson}). It repairs nothing. {@link planRepairs}
 * turns findings into an instruction list that an operator-run executor may
 * carry out; nothing here ever calls a write.
 *
 * What counts as drift, and what deliberately does not:
 *
 * - A forgotten entry (`superseded_by = forgotten:<id>`) is absent from the
 *   plane ON PURPOSE. It is never reported as missing; the opposite, a
 *   forgotten entry whose document is still there, is the finding
 *   `forgotten_entry_in_plane` (the forget's plane delete is pending).
 * - A superseded entry owes the plane nothing. An entry past its lifetime
 *   (`expired`), one with no `source_event` (the retain refuses it) and one
 *   whose retain is parked in the outbox are not reported as missing either.
 * - A subject-addressed document is shared by every entry with that scope,
 *   kind and subject, so a document a live entry still owns is never an
 *   orphan and never a forgotten entry's leftover.
 * - The ledger's write event carries the stored entry id (`entry_id`, see
 *   `auditMemoryWrite`), and an event with one satisfies exactly that entry.
 *   An event written before the key existed carries none: the two ledger
 *   findings then compare by what such an event DOES carry: writer surface,
 *   canonical scope, memory kind and time. That heuristic runs first, over
 *   every scanned entry and every event without an entry id, so a legacy
 *   event is consumed by the entry it matched before the key existed; an
 *   event that names an entry only ever adds a satisfied entry and never
 *   frees a legacy event for another one. The heuristic is exact in count
 *   within a bucket and approximate in identity, and a replayed idempotent
 *   write or an entry the sweeper deleted can explain a
 *   `ledger_write_without_entry`. When an entry that no event names could just
 *   as well own the legacy event the heuristic gave to an entry an exact event
 *   also names (an entry written before the upgrade and retried after it), the
 *   data cannot tell which entry lacks an audit: that is reported as
 *   `ledger_pairing_ambiguous`, never guessed either way. The window is bounded (default seven
 *   days) so the ledger's own retention and the sweeper do not turn into
 *   noise.
 *
 * Failure model: a reader that throws or times out marks ITS store
 * `store_unreachable` in the report and `ok` false. The run never crashes
 * and never reports a clean result for a store it could not read. Findings
 * the run already had are kept.
 *
 * No content ever enters the report: a finding carries ids, codes, bank and
 * document ids and a fixed-template detail. Reader failure reasons are
 * redacted and stripped of URLs and addresses.
 */
import { canonicalJson, sha256Hex } from "./event.ts";
import { isForgetMarker } from "./memory-forget.ts";
import { parseScope } from "./memory-policy.ts";
import { retainDocumentId } from "./memory-retain.ts";
import { contentHash, HASH_TENANT, HASH_VERSION_MARKER } from "./memory-write.ts";
import { redact } from "./redact.ts";
import { SURFACES, type MemoryEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONSISTENCY_SCHEMA = 1 as const;

export const FINDING_CODES = [
	"duplicate_document",
	"forgotten_entry_in_plane",
	"hash_mismatch",
	"index_entry_missing_in_plane",
	"index_entry_without_ledger_write",
	"ledger_pairing_ambiguous",
	"ledger_write_without_entry",
	"plane_document_orphan",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export const STORES = ["index", "plane", "ledger"] as const;
export type Store = (typeof STORES)[number];

export const DEFAULT_MAX_ENTRIES = 5000;
/** A single run never examines more than this, however it is asked. */
export const MAX_ENTRIES_CEILING = 50_000;
export const DEFAULT_MAX_FINDINGS = 500;
export const MAX_FINDINGS_CEILING = 5000;
/** Plane documents listed per run, all banks together. */
export const DEFAULT_MAX_DOCUMENTS = 5000;
export const MAX_DOCUMENTS_CEILING = 50_000;
export const DEFAULT_MAX_LEDGER_EVENTS = 20_000;
export const DEFAULT_PAGE_SIZE = 200;
/** The ledger read's own page ceiling (`MAX_QUERY_LIMIT` in greptime.ts). */
export const LEDGER_PAGE_SIZE = 500;
export const DEFAULT_READER_TIMEOUT_MS = 10_000;
export const DEFAULT_DEADLINE_MS = 300_000;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
/** The ledger comparison covers this much recent time (the ledger's retention and the sweeper stay out of it). */
export const DEFAULT_LEDGER_WINDOW_MS = 7 * 24 * 3_600_000;
/** How long after its entry's `created` a write event's `ts` may fall and still pair with it (the audit runs right after the insert). */
export const DEFAULT_LEDGER_LAG_MS = 120_000;
/** How far BEFORE its entry's `created` an event's `ts` may fall (clock skew between the database and the service). */
export const DEFAULT_LEDGER_SKEW_MS = 30_000;
/** Ledger pages one run reads at most, whatever the reader returns per page. */
export const MAX_LEDGER_PAGES = 2000;
/** Writes this recent are not judged: their event, or their entry, may still be in flight. */
export const DEFAULT_LEDGER_GRACE_MS = 60_000;
/** Entries read per examined entry before the scan stops: a bank filter must not make one run walk the whole table. */
const READ_FACTOR = 10;
const MAX_REASON_CHARS = 200;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The keyset cursor of the index listing: the `(created, id)` of the last entry a page returned. */
export interface IndexCursor {
	before: string;
	before_id: string;
}

/**
 * The index, read-only. `page` lists EVERY row (superseded and forgotten
 * included), newest first, `next` null at the end. `entry` is a point read by
 * id (null: no row). `documentShared` answers the same question as
 * `IndexStore.memoryDocumentShared`: another live entry owns this entry's
 * plane document.
 */
export interface IndexReader {
	page(request: { limit: number; cursor: IndexCursor | null }): Promise<{ entries: readonly MemoryEntry[]; next: IndexCursor | null }>;
	entry(id: string): Promise<MemoryEntry | null>;
	documentShared?(entry: MemoryEntry): Promise<boolean>;
}

/** What the verifier needs to know about one plane document: its id and the entry it says it came from. Never its text. */
export interface PlaneDocumentView {
	id: string;
	entry_id?: string;
}

/** Thrown by a reader that cannot do what was asked because the plane has no such operation (not because it is down). */
export class ReaderUnsupported extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReaderUnsupported";
	}
}

/**
 * The plane, read-only. `listDocuments` is optional: without it (or when it
 * throws {@link ReaderUnsupported}) presence is decided by point lookups only
 * and the orphan and duplicate checks are reported as skipped, never as clean.
 */
export interface PlaneReader {
	listDocuments?(bank: string, request: { limit: number; cursor: string | null }): Promise<{ ids: readonly string[]; next: string | null }>;
	getDocument(bank: string, id: string): Promise<PlaneDocumentView | null>;
}

/** One accepted `memory.write` ledger event, reduced to what it carries. `ts` is ISO. */
export interface LedgerWriteEvent {
	id: string;
	ts: string;
	surface: string;
	scope: string;
	kind: string;
	/**
	 * The stored entry's id, when the event carries one (`auditMemoryWrite` writes it from the gate's result).
	 * Events written before the key existed lack it and are paired by the writer + scope + kind + time heuristic.
	 */
	entry_id?: string;
}

/**
 * The ledger, read-only: accepted memory-write events with `ts` in
 * `[since, until]` (inclusive ISO), oldest first, at most `limit` per page.
 * `next` is opaque; the verifier de-duplicates by event id, so a reader may
 * resume inclusively at the last `ts` it saw.
 * `skipped` counts the rows in this page the reader could not read as an event; they are not in `events`.
 */
export interface LedgerReader {
	memoryWrites(request: { since: string; until: string; limit: number; cursor: string | null }): Promise<{ events: readonly LedgerWriteEvent[]; next: string | null; skipped: number }>;
}

/** The retain outbox's parked entry ids; `null` when they cannot be known (a memory-only outbox lives in the server process). */
export interface OutboxReader {
	parkedEntryIds(): Promise<ReadonlySet<string> | null>;
}

export interface ConsistencyReaders {
	index: IndexReader;
	plane: PlaneReader;
	ledger: LedgerReader;
	outbox?: OutboxReader;
}

/** Schedules `fire` after `ms` and returns the cancel. Injected so a timeout test needs no real delay. */
export interface Timer {
	after(ms: number, fire: () => void): () => void;
}

const realTimer: Timer = {
	after(ms, fire) {
		const handle = setTimeout(fire, ms);
		return () => clearTimeout(handle);
	},
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConsistencyOptions {
	/** Epoch milliseconds. The only clock the run reads. */
	now: () => number;
	/** The bank an entry written by `writer` retains into (`bankForSurface` with the configured prefix). */
	bankFor: (writer: string) => string;
	/** The plane document one entry maps to; `null` when it cannot be derived. Default: `retainDocumentId` over the stored idempotency key. */
	documentIdOf?: (entry: MemoryEntry) => string | null;
	/** Restrict the run to one bank. */
	bank?: string;
	/**
	 * The banks the server is configured to write and recall (the surface banks plus `HINDSIGHT_BANKS`).
	 * Every one is examined whether or not the index holds a row for it: a bank whose rows were swept can
	 * still hold orphan documents. Ignored when `bank` restricts the run. Without it only the banks the
	 * examined index rows name are walked.
	 */
	configuredBanks?: readonly string[];
	/** Only entries created at or after this ISO instant. */
	since?: string;
	maxEntries?: number;
	maxFindings?: number;
	maxDocuments?: number;
	maxLedgerEvents?: number;
	pageSize?: number;
	readerTimeoutMs?: number;
	/** Total time the run may take, by the injected clock. */
	deadlineMs?: number;
	concurrency?: number;
	ledgerWindowMs?: number;
	ledgerLagMs?: number;
	ledgerSkewMs?: number;
	ledgerGraceMs?: number;
	timer?: Timer;
}

/** An option that is out of range. A caller bug, not a store failure: thrown, never reported as drift. */
export class ConsistencyOptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConsistencyOptionError";
	}
}

interface ResolvedOptions {
	now: () => number;
	bankFor: (writer: string) => string;
	documentIdOf: (entry: MemoryEntry) => string | null;
	bank: string | null;
	configuredBanks: string[];
	since: string | null;
	sinceMs: number | null;
	maxEntries: number;
	maxFindings: number;
	maxDocuments: number;
	maxLedgerEvents: number;
	pageSize: number;
	readerTimeoutMs: number;
	deadlineMs: number;
	concurrency: number;
	ledgerWindowMs: number;
	ledgerLagMs: number;
	ledgerSkewMs: number;
	ledgerGraceMs: number;
	timer: Timer;
}

function boundedInt(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
	const chosen = value ?? fallback;
	if (!Number.isSafeInteger(chosen) || chosen < min || chosen > max) {
		throw new ConsistencyOptionError(`${name} must be an integer from ${min} to ${max}, got ${String(chosen).slice(0, 40)}`);
	}
	return chosen;
}

/** The plane document id one entry maps to, or `null` when the idempotency key a subject-less entry needs is not stored. */
export function defaultDocumentId(entry: MemoryEntry): string | null {
	const hasSubject = typeof entry.subject === "string" && entry.subject.length > 0;
	if (!hasSubject && !entry.idempotency_key) return null;
	return retainDocumentId(entry, entry.idempotency_key ?? "");
}

function resolveOptions(options: ConsistencyOptions): ResolvedOptions {
	let since: string | null = null;
	let sinceMs: number | null = null;
	if (options.since !== undefined) {
		const parsed = Date.parse(options.since);
		if (Number.isNaN(parsed)) throw new ConsistencyOptionError(`since must be an ISO instant, got "${options.since.slice(0, 40)}"`);
		sinceMs = parsed;
		since = new Date(parsed).toISOString();
	}
	if (options.bank !== undefined && options.bank.length === 0) throw new ConsistencyOptionError("bank must not be empty");
	if (options.configuredBanks?.some((bank) => typeof bank !== "string" || bank.length === 0) === true) {
		throw new ConsistencyOptionError("configuredBanks must hold only non-empty bank names");
	}
	return {
		now: options.now,
		bankFor: options.bankFor,
		documentIdOf: options.documentIdOf ?? defaultDocumentId,
		bank: options.bank ?? null,
		configuredBanks: [...new Set(options.configuredBanks ?? [])].sort(compareText),
		since,
		sinceMs,
		maxEntries: boundedInt("maxEntries", options.maxEntries, DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES_CEILING),
		maxFindings: boundedInt("maxFindings", options.maxFindings, DEFAULT_MAX_FINDINGS, 1, MAX_FINDINGS_CEILING),
		maxDocuments: boundedInt("maxDocuments", options.maxDocuments, DEFAULT_MAX_DOCUMENTS, 1, MAX_DOCUMENTS_CEILING),
		maxLedgerEvents: boundedInt("maxLedgerEvents", options.maxLedgerEvents, DEFAULT_MAX_LEDGER_EVENTS, 1, 200_000),
		pageSize: boundedInt("pageSize", options.pageSize, DEFAULT_PAGE_SIZE, 1, 1000),
		readerTimeoutMs: boundedInt("readerTimeoutMs", options.readerTimeoutMs, DEFAULT_READER_TIMEOUT_MS, 1, 600_000),
		deadlineMs: boundedInt("deadlineMs", options.deadlineMs, DEFAULT_DEADLINE_MS, 1, 3_600_000),
		concurrency: boundedInt("concurrency", options.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
		ledgerWindowMs: boundedInt("ledgerWindowMs", options.ledgerWindowMs, DEFAULT_LEDGER_WINDOW_MS, 1, 366 * 24 * 3_600_000),
		ledgerLagMs: boundedInt("ledgerLagMs", options.ledgerLagMs, DEFAULT_LEDGER_LAG_MS, 0, 3_600_000),
		ledgerSkewMs: boundedInt("ledgerSkewMs", options.ledgerSkewMs, DEFAULT_LEDGER_SKEW_MS, 0, 3_600_000),
		ledgerGraceMs: boundedInt("ledgerGraceMs", options.ledgerGraceMs, DEFAULT_LEDGER_GRACE_MS, 0, 3_600_000),
		timer: options.timer ?? realTimer,
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Finding {
	code: FindingCode;
	/** The entry id, the document id or the event id the finding is about (see `entry_id`, `document_id`, `event_id`). */
	id: string;
	/** The stores whose records disagree. */
	stores: readonly Store[];
	bank?: string;
	document_id?: string;
	/** For `duplicate_document`: the document the entry should have. */
	expected_document_id?: string;
	entry_id?: string;
	event_id?: string;
	/** For `ledger_pairing_ambiguous`: the other entry the same legacy event may belong to. */
	contender_entry_id?: string;
	/** For `ledger_pairing_ambiguous`: the event written without an entry id that either entry may own. */
	legacy_event_id?: string;
	/** A fixed-template sentence over validated tokens. Never content. */
	detail: string;
}

export type StoreState = "ok" | "store_unreachable" | "not_checked";

export interface StoreStatus {
	state: StoreState;
	/** Set when `state` is `store_unreachable`: the failed operation and a redacted reason. */
	reason?: string;
}

export interface ConsistencyCounts {
	entries_examined: number;
	entries_current: number;
	entries_superseded: number;
	entries_forgotten: number;
	/** Current entries that should have a plane document (not expired, sourced, derivable). Includes parked ones. */
	expected_in_plane: number;
	skipped_expired: number;
	skipped_unsourced: number;
	skipped_underivable: number;
	/** Expected entries whose retain is parked in the outbox. */
	parked_retains: number;
	hash_checked: number;
	/** Entries stored without a hash (rows older than the gate). */
	hash_unchecked: number;
	banks_examined: number;
	plane_documents_listed: number;
	plane_lookups: number;
	index_lookups: number;
	/** A forgotten entry's document that a live entry still owns: left alone on purpose. */
	shared_documents: number;
	/** A document whose ownership could not be decided (truncated scan, no `documentShared` reader). */
	unverifiable_documents: number;
	ledger_events_examined: number;
	ledger_events_malformed: number;
	ledger_entries_judged: number;
	ledger_events_judged: number;
	ledger_pairs: number;
	findings_total: number;
	findings_by_code: Record<FindingCode, number>;
}

/** What the plane check covered, per bank. A bank in `skipped` was NOT checked for orphans or duplicates, whatever else the report says. */
export interface BankCoverage {
	/** The configured banks the run was given (sorted); empty when it was given none. */
	configured: string[];
	/** Banks whose plane documents were listed and compared with the index (a truncated listing is also in `listing_truncated`). */
	examined: string[];
	/** Banks whose document listing did not run, with a short reason. Each one makes `ok` false. */
	skipped: Array<{ bank: string; reason: string }>;
	/** Banks whose document listing a bound (`max_documents`) cut short: documents past it were not seen. */
	listing_truncated: string[];
}

export interface ConsistencyCoverage {
	/** `known`: the parked set was read. `unknown`: no outbox reader, a memory-only outbox, or a read that failed. */
	outbox: "known" | "unknown";
	plane_listing: "complete" | "partial" | "unavailable" | "not_checked";
	ledger: "compared" | "partial" | "not_checked";
	banks: BankCoverage;
	/** Checks that could not run, as `<check>:<reason>`. Any entry makes `ok` false. */
	skipped_checks: string[];
}

export interface ConsistencyScope {
	bank: string | null;
	since: string | null;
	max_entries: number;
	max_findings: number;
	max_documents: number;
	/** The ledger comparison window, ISO; `null` when the ledger was not compared. */
	ledger_window: { from: string; to: string } | null;
}

export interface ConsistencyReport {
	schema: typeof CONSISTENCY_SCHEMA;
	generated_at: string;
	scope: ConsistencyScope;
	stores: Record<Store, StoreStatus>;
	coverage: ConsistencyCoverage;
	counts: ConsistencyCounts;
	/** Sorted, at most `max_findings`. `counts.findings_total` is the exact number found. */
	findings: Finding[];
	/** True when a bound cut the run: entries, documents, ledger events or the findings list. Counts stay exact for what was examined. */
	truncated: boolean;
	/** No findings, every store read, no skipped check. A truncated but clean sample is `ok` (see `truncated`). */
	ok: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A reason fit to print: redacted, URLs and addresses removed, one line, short. */
export function scrubReason(text: string): string {
	return redact(text)
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<addr>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_REASON_CHARS);
}

const SAFE_TOKEN = /^[A-Za-z0-9._:/@-]{1,200}$/;

/** An id or name from a store, as it may appear in the report: itself when it is a plain token, a digest of it otherwise. */
function token(value: string): string {
	return SAFE_TOKEN.test(value) ? value : `invalid:${sha256Hex(value).slice(0, 16)}`;
}

function describe(cause: unknown): string {
	return scrubReason(cause instanceof Error ? cause.message : String(cause));
}

class ReaderFailure extends Error {
	constructor(
		readonly store: Store,
		readonly op: string,
		readonly reason: string,
	) {
		super(`${store}.${op}: ${reason}`);
		this.name = "ReaderFailure";
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		for (;;) {
			// A failed sibling stops new work: the run is about to report the store unreachable.
			if (failed) return;
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await work(items[index] as T);
			} catch (cause) {
				failed = true;
				throw cause;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

type EntryState = "current" | "superseded" | "forgotten";

function stateOf(entry: MemoryEntry): EntryState {
	if (entry.superseded_by === undefined || entry.superseded_by === null) return "current";
	return isForgetMarker(entry.superseded_by) ? "forgotten" : "superseded";
}

const docKey = (bank: string, documentId: string): string => `${bank}\u0000${documentId}`;

/** True when the stored hash matches the governed-content digest under either preimage version. */
function hashMatches(entry: MemoryEntry): boolean {
	const base = { scope: entry.scope, kind: entry.kind, subject: entry.subject ?? null, text: entry.text, writer: entry.writer };
	const v1 = contentHash(base);
	if (entry.entry_hash === v1) return true;
	return entry.entry_hash === contentHash({ ...base, hv: HASH_VERSION_MARKER, tenant: HASH_TENANT });
}

const KNOWN_SURFACES: ReadonlySet<string> = new Set(SURFACES);

function emptyCounts(): ConsistencyCounts {
	return {
		entries_examined: 0,
		entries_current: 0,
		entries_superseded: 0,
		entries_forgotten: 0,
		expected_in_plane: 0,
		skipped_expired: 0,
		skipped_unsourced: 0,
		skipped_underivable: 0,
		parked_retains: 0,
		hash_checked: 0,
		hash_unchecked: 0,
		banks_examined: 0,
		plane_documents_listed: 0,
		plane_lookups: 0,
		index_lookups: 0,
		shared_documents: 0,
		unverifiable_documents: 0,
		ledger_events_examined: 0,
		ledger_events_malformed: 0,
		ledger_entries_judged: 0,
		ledger_events_judged: 0,
		ledger_pairs: 0,
		findings_total: 0,
		findings_by_code: Object.fromEntries(FINDING_CODES.map((code) => [code, 0])) as Record<FindingCode, number>,
	};
}

interface Item {
	entry: MemoryEntry;
	state: EntryState;
	bank: string;
	docId: string | null;
	expected: boolean;
	createdMs: number;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareFindings(a: Finding, b: Finding): number {
	return (
		compareText(a.code, b.code) ||
		compareText(a.bank ?? "", b.bank ?? "") ||
		compareText(a.id, b.id) ||
		compareText(a.document_id ?? "", b.document_id ?? "")
	);
}

/** The ledger pairing bucket: what a write event carries (writer surface, canonical scope, memory kind). */
function bucketOf(writer: string, scope: string, kind: string): string {
	return JSON.stringify([writer, parseScope(scope)?.canonical ?? scope, kind]);
}

function bucketParts(bucket: string): { writer: string; scope: string; kind: string } {
	const parts = JSON.parse(bucket) as string[];
	return { writer: parts[0] ?? "", scope: parts[1] ?? "", kind: parts[2] ?? "" };
}

/** A recorded (entry, legacy event) pair of one bucket. */
export interface LedgerPair {
	entry: { id: string; tsMs: number };
	event: { id: string; tsMs: number };
}

/**
 * The first pair, in bucket order, whose legacy event could be the audit of an entry created at `entryTsMs`: the
 * event's time minus the entry's lies in `[-skewMs, lagMs]` (both ends inclusive, the matcher's own rule). `pairs` MUST
 * be sorted by event time with ties in bucket order, so the first pair at or after the lower bound is the answer when it
 * is inside the upper one. A binary search, not a scan: O(log n) per call, and O(1) for an empty list.
 */
export function findContender(pairs: readonly LedgerPair[], entryTsMs: number, skewMs: number, lagMs: number): LedgerPair | undefined {
	if (pairs.length === 0) return undefined;
	const lower = entryTsMs - skewMs;
	let lo = 0;
	let hi = pairs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((pairs[mid] as LedgerPair).event.tsMs < lower) lo = mid + 1;
		else hi = mid;
	}
	const candidate = pairs[lo];
	return candidate !== undefined && candidate.event.tsMs - entryTsMs <= lagMs ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// verifyConsistency
// ---------------------------------------------------------------------------

/**
 * Compare the index, the plane and the ledger. Never throws for a store
 * problem (it is reported); throws {@link ConsistencyOptionError} for an
 * option out of range. Reads only.
 */
export async function verifyConsistency(readers: ConsistencyReaders, options: ConsistencyOptions): Promise<ConsistencyReport> {
	const cfg = resolveOptions(options);
	const startedAt = cfg.now();
	const deadlineAt = startedAt + cfg.deadlineMs;

	const counts = emptyCounts();
	const stores: Record<Store, StoreStatus> = { index: { state: "not_checked" }, plane: { state: "not_checked" }, ledger: { state: "not_checked" } };
	const coverage: ConsistencyCoverage = {
		outbox: "unknown",
		plane_listing: "not_checked",
		ledger: "not_checked",
		banks: { configured: cfg.configuredBanks.map(token), examined: [], skipped: [], listing_truncated: [] },
		skipped_checks: [],
	};
	const findings: Finding[] = [];
	let truncated = false;
	let ledgerWindow: ConsistencyScope["ledger_window"] = null;

	const add = (finding: Omit<Finding, "stores"> & { stores: readonly Store[] }): void => {
		findings.push(finding);
		counts.findings_by_code[finding.code] += 1;
		counts.findings_total += 1;
	};

	/** One reader call: bounded by the per-call timeout and the total deadline; any failure is a `ReaderFailure` naming its store. */
	const call = async <T>(store: Store, op: string, fn: () => Promise<T>): Promise<T> => {
		if (cfg.now() >= deadlineAt) throw new ReaderFailure(store, op, "deadline_exceeded");
		const timeout = Promise.withResolvers<never>();
		const cancel = cfg.timer.after(cfg.readerTimeoutMs, () => timeout.reject(new ReaderFailure(store, op, `timeout after ${cfg.readerTimeoutMs}ms`)));
		const work = (async () => fn())();
		// The loser of the race must not surface later as an unhandled rejection.
		work.catch(() => undefined);
		try {
			return await Promise.race([work, timeout.promise]);
		} catch (cause) {
			if (cause instanceof ReaderFailure || cause instanceof ReaderUnsupported) throw cause;
			throw new ReaderFailure(store, op, describe(cause));
		} finally {
			cancel();
		}
	};

	const fail = (cause: unknown, fallback: Store): void => {
		const failure = cause instanceof ReaderFailure ? cause : new ReaderFailure(fallback, "unknown", describe(cause));
		stores[failure.store] = { state: "store_unreachable", reason: `${failure.op}: ${failure.reason}` };
	};

	// ── 1. the index scan ─────────────────────────────────────────────────
	const items: Item[] = [];
	let scanTruncated = false;
	try {
		const seen = new Set<string>();
		let cursor: IndexCursor | null = null;
		let read = 0;
		const readCap = cfg.maxEntries * READ_FACTOR;
		scan: for (;;) {
			const page: { entries: readonly MemoryEntry[]; next: IndexCursor | null } = await call("index", "page", () => readers.index.page({ limit: cfg.pageSize, cursor }));
			for (const entry of page.entries) {
				if (seen.has(entry.id)) continue;
				seen.add(entry.id);
				const createdMs = Date.parse(entry.created);
				// Newest first: the first entry older than `since` ends the scan.
				if (cfg.sinceMs !== null && createdMs < cfg.sinceMs) break scan;
				read += 1;
				const bank = cfg.bankFor(entry.writer);
				if (cfg.bank !== null && bank !== cfg.bank) {
					if (read >= readCap) {
						scanTruncated = true;
						break scan;
					}
					continue;
				}
				if (items.length >= cfg.maxEntries) {
					scanTruncated = true;
					break scan;
				}
				const state = stateOf(entry);
				const docId = cfg.documentIdOf(entry);
				items.push({ entry, state, bank, docId, expected: false, createdMs });
			}
			if (page.next === null) break;
			if (page.entries.length === 0) throw new ReaderFailure("index", "page", "an empty page came with a next cursor");
			if (cursor !== null && page.next.before === cursor.before && page.next.before_id === cursor.before_id) {
				throw new ReaderFailure("index", "page", "paging made no progress");
			}
			cursor = page.next;
		}
		stores.index = { state: "ok" };
	} catch (cause) {
		fail(cause, "index");
	}
	if (scanTruncated) truncated = true;

	if (stores.index.state === "ok") {
		counts.entries_examined = items.length;
		for (const item of items) {
			const { entry } = item;
			if (item.state === "current") counts.entries_current += 1;
			else if (item.state === "superseded") counts.entries_superseded += 1;
			else counts.entries_forgotten += 1;

			// hash_mismatch: the stored hash against the recomputed one, whatever the row's state.
			if (entry.entry_hash === "") {
				counts.hash_unchecked += 1;
			} else {
				counts.hash_checked += 1;
				if (!hashMatches(entry)) {
					add({
						code: "hash_mismatch",
						id: token(entry.id),
						stores: ["index"],
						entry_id: token(entry.id),
						detail: "the stored entry hash matches neither the v1 nor the v2 digest of the stored content (a row written before the gate can differ)",
					});
				}
			}

			if (item.state !== "current") continue;
			if (entry.expired === true) counts.skipped_expired += 1;
			else if (typeof entry.source_event !== "string" || entry.source_event.length === 0) counts.skipped_unsourced += 1;
			else if (item.docId === null) counts.skipped_underivable += 1;
			else {
				item.expected = true;
				counts.expected_in_plane += 1;
			}
		}

		// ── 2. the plane ───────────────────────────────────────────────────
		try {
			await comparePlane();
			stores.plane = { state: "ok" };
		} catch (cause) {
			fail(cause, "plane");
		}

		// ── 3. the ledger ──────────────────────────────────────────────────
		try {
			await compareLedger();
			stores.ledger = { state: "ok" };
		} catch (cause) {
			fail(cause, "ledger");
		}
	}

	// ── the plane comparison ──────────────────────────────────────────────
	async function comparePlane(): Promise<void> {
		let parked: ReadonlySet<string> = new Set();
		if (readers.outbox !== undefined) {
			const outbox = readers.outbox;
			try {
				const read = await call("plane", "parked", () => outbox.parkedEntryIds());
				if (read !== null) {
					parked = read;
					coverage.outbox = "known";
				}
			} catch (cause) {
				// The outbox is a local file, not one of the three stores: an unreadable one means the parked
				// set is unknown (reported as coverage), never a failed plane. A missing entry may then be a
				// parked retain, which the finding's detail says.
				if (cause instanceof ReaderFailure && cause.reason === "deadline_exceeded") throw cause;
			}
		}
		for (const item of items) {
			if (item.expected && parked.has(item.entry.id)) counts.parked_retains += 1;
		}

		const byId = new Map<string, Item>(items.map((item): [string, Item] => [item.entry.id, item]));
		const currentKeys = new Set<string>();
		const forgottenKeys = new Set<string>();
		for (const item of items) {
			if (item.docId === null) continue;
			if (item.state === "current") currentKeys.add(docKey(item.bank, item.docId));
			else if (item.state === "forgotten") forgottenKeys.add(docKey(item.bank, item.docId));
		}
		const banks = [...new Set([...items.map((item) => item.bank), ...(cfg.bank !== null ? [cfg.bank] : cfg.configuredBanks)])].sort(compareText);
		counts.banks_examined = banks.length;

		const lookup = (bank: string, id: string): Promise<PlaneDocumentView | null> => {
			counts.plane_lookups += 1;
			return call("plane", "getDocument", () => readers.plane.getDocument(bank, id));
		};
		const sharedWithLive = async (entry: MemoryEntry): Promise<boolean | null> => {
			const reader = readers.index.documentShared?.bind(readers.index);
			if (reader === undefined) return null;
			counts.index_lookups += 1;
			return call("index", "documentShared", () => reader(entry));
		};

		let documentBudget = cfg.maxDocuments;
		let listingUnsupported = false;
		let listingPartial = false;
		let listedAny = false;
		const unlistedFor = new Set<string>();
		const itemBanks = new Set(items.map((item) => item.bank));
		let skippedConfiguredOnly = 0;

		for (const bank of banks) {
			// 2a. the bank's document listing, when the plane has one.
			let skipReason: string | null = null;
			let listed: Set<string> | null = null;
			let listingComplete = false;
			if (readers.plane.listDocuments !== undefined && !listingUnsupported) {
				const list = readers.plane.listDocuments.bind(readers.plane);
				try {
					const ids = new Set<string>();
					let cursor: string | null = null;
					for (;;) {
						if (documentBudget <= 0) {
							listingPartial = true;
							truncated = true;
							break;
						}
						const page: { ids: readonly string[]; next: string | null } = await call("plane", "listDocuments", () => list(bank, { limit: cfg.pageSize, cursor }));
						let fresh = 0;
						for (const id of page.ids) {
							if (ids.has(id)) continue;
							if (documentBudget <= 0) {
								listingPartial = true;
								truncated = true;
								break;
							}
							ids.add(id);
							fresh += 1;
							documentBudget -= 1;
							counts.plane_documents_listed += 1;
						}
						if (page.next === null) {
							listingComplete = !listingPartial;
							break;
						}
						// The budget ran out inside this page: the top of the loop ends the listing as partial.
						if (listingPartial) continue;
						if (fresh === 0 || page.next === cursor) throw new ReaderFailure("plane", "listDocuments", "paging made no progress");
						cursor = page.next;
					}
					listed = ids;
					listedAny = true;
					if (!listingComplete) listingPartial = true;
				} catch (cause) {
					if (cause instanceof ReaderUnsupported) {
						listingUnsupported = true;
					} else if (!itemBanks.has(bank) && bank !== cfg.bank && !(cause instanceof ReaderFailure && cause.reason === "deadline_exceeded")) {
						// A configured bank with no index row is only examined for stray documents: when it cannot be read it
						// is reported as skipped (which makes the run not clean) instead of failing the plane for the banks that were read.
						skipReason = `listing failed: ${cause instanceof ReaderFailure ? cause.reason : describe(cause)}`;
					} else {
						throw cause;
					}
				}
			} else if (readers.plane.listDocuments === undefined) {
				listingUnsupported = true;
			}
			if (listed === null) {
				unlistedFor.add(bank);
				coverage.banks.skipped.push({ bank: token(bank), reason: skipReason ?? "the plane has no usable document listing" });
				if (!itemBanks.has(bank)) skippedConfiguredOnly += 1;
			} else {
				coverage.banks.examined.push(token(bank));
				if (!listingComplete) coverage.banks.listing_truncated.push(token(bank));
			}

			// 2b. an expected entry whose document is absent. A listing that lacks it is confirmed by a point read.
			const wanted = items.filter((item) => item.bank === bank && item.expected && item.docId !== null && !parked.has(item.entry.id));
			const toConfirm = wanted.filter((item) => !(listed?.has(item.docId as string) ?? false));
			await mapLimit(toConfirm, cfg.concurrency, async (item) => {
				const documentId = item.docId as string;
				if ((await lookup(bank, documentId)) !== null) return;
				add({
					code: "index_entry_missing_in_plane",
					id: token(item.entry.id),
					stores: ["index", "plane"],
					bank: token(bank),
					document_id: token(documentId),
					entry_id: token(item.entry.id),
					detail:
						readers.outbox !== undefined && coverage.outbox === "known"
							? "a current entry has no plane document and no retain is parked for it"
							: "a current entry has no plane document (the retain outbox could not be read, so a parked retain is not ruled out)",
				});
			});

			// 2c. a forgotten entry whose document is still there.
			const forgotten = items.filter((item) => item.bank === bank && item.state === "forgotten" && item.docId !== null);
			await mapLimit(forgotten, cfg.concurrency, async (item) => {
				const documentId = item.docId as string;
				let present: boolean;
				if (listed?.has(documentId)) present = true;
				else if (listed !== null && listingComplete) present = false;
				else present = (await lookup(bank, documentId)) !== null;
				if (!present) return;
				if (currentKeys.has(docKey(bank, documentId))) {
					counts.shared_documents += 1;
					return;
				}
				if ((await sharedWithLive(item.entry)) === true) {
					counts.shared_documents += 1;
					return;
				}
				add({
					code: "forgotten_entry_in_plane",
					id: token(item.entry.id),
					stores: ["index", "plane"],
					bank: token(bank),
					document_id: token(documentId),
					entry_id: token(item.entry.id),
					detail: "a forgotten entry still has its plane document: the forget's plane delete is pending",
				});
			});

			// 2d. documents no examined entry accounts for: orphans and duplicates.
			if (listed === null) continue;
			const unknown = [...listed].filter((id) => !currentKeys.has(docKey(bank, id)) && !forgottenKeys.has(docKey(bank, id))).sort(compareText);
			await mapLimit(unknown, cfg.concurrency, async (documentId) => {
				const view = await lookup(bank, documentId);
				if (view === null) return;
				const entryId = view.entry_id;
				if (entryId === undefined || entryId.length === 0) {
					add({
						code: "plane_document_orphan",
						id: token(documentId),
						stores: ["plane", "index"],
						bank: token(bank),
						document_id: token(documentId),
						detail: "a plane document names no entry (no entry_id metadata) and no entry accounts for it",
					});
					return;
				}
				let entry = byId.get(entryId)?.entry ?? null;
				if (entry === null) {
					counts.index_lookups += 1;
					entry = await call("index", "entry", () => readers.index.entry(entryId));
				}
				if (entry === null) {
					add({
						code: "plane_document_orphan",
						id: token(documentId),
						stores: ["plane", "index"],
						bank: token(bank),
						document_id: token(documentId),
						entry_id: token(entryId),
						detail: "a plane document names an entry the index does not have",
					});
					return;
				}
				const state = stateOf(entry);
				if (state === "current") {
					const expected = cfg.documentIdOf(entry);
					if (expected !== null && expected !== documentId && cfg.bankFor(entry.writer) === bank) {
						add({
							code: "duplicate_document",
							id: token(entry.id),
							stores: ["plane"],
							bank: token(bank),
							document_id: token(documentId),
							expected_document_id: token(expected),
							entry_id: token(entry.id),
							detail: "a second plane document names an entry that already has its own document",
						});
					}
					return;
				}
				const shared = await sharedWithLive(entry);
				if (shared === true) {
					counts.shared_documents += 1;
					return;
				}
				// Without a `documentShared` reader, a subject-addressed document may belong to a live entry the
				// truncated scan never reached: not decidable, so not reported.
				if (shared === null && scanTruncated && documentId.startsWith("subj_")) {
					counts.unverifiable_documents += 1;
					return;
				}
				if (state === "forgotten") {
					add({
						code: "forgotten_entry_in_plane",
						id: token(entry.id),
						stores: ["index", "plane"],
						bank: token(bank),
						document_id: token(documentId),
						entry_id: token(entry.id),
						detail: "a forgotten entry still has its plane document: the forget's plane delete is pending",
					});
					return;
				}
				add({
					code: "plane_document_orphan",
					id: token(documentId),
					stores: ["plane", "index"],
					bank: token(bank),
					document_id: token(documentId),
					entry_id: token(entryId),
					detail: "a plane document names an entry that a later write superseded",
				});
			});
		}

		if (banks.length === 0) coverage.plane_listing = "not_checked";
		else if (listingUnsupported && !listedAny) coverage.plane_listing = "unavailable";
		else if (listingPartial || unlistedFor.size > 0) coverage.plane_listing = "partial";
		else coverage.plane_listing = "complete";
		if (coverage.plane_listing === "unavailable") {
			coverage.skipped_checks.push("duplicate_document:plane_listing_unavailable", "plane_document_orphan:plane_listing_unavailable");
		} else {
			// A bank that was not listed is not clean: the global entries above cover the case where no bank could be.
			for (const skipped of coverage.banks.skipped) coverage.skipped_checks.push(`plane_bank_skipped:${skipped.bank}:${skipped.reason}`);
		}
		counts.banks_examined = banks.length - skippedConfiguredOnly;
	}

	// ── the ledger comparison ─────────────────────────────────────────────
	async function compareLedger(): Promise<void> {
		const now = cfg.now();
		const nowIso = new Date(now).toISOString();
		let windowFrom = now - cfg.ledgerWindowMs;
		if (cfg.sinceMs !== null) windowFrom = Math.max(windowFrom, cfg.sinceMs);
		// A truncated scan saw only the newest entries: older ones are not judged, and neither are their events.
		if (scanTruncated) {
			const oldest = items.reduce((least, item) => Math.min(least, item.createdMs), Number.POSITIVE_INFINITY);
			if (Number.isFinite(oldest)) windowFrom = Math.max(windowFrom, oldest);
		}
		const windowTo = now - cfg.ledgerGraceMs;
		if (windowFrom >= windowTo) {
			ledgerWindow = null;
			coverage.ledger = "compared";
			return;
		}
		ledgerWindow = { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() };

		const events: Array<{ id: string; tsMs: number; bucket: string; entryId: string | null }> = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		let partial = false;
		let ledgerPages = 0;
		for (;;) {
			const page: { events: readonly LedgerWriteEvent[]; next: string | null; skipped: number } = await call("ledger", "memoryWrites", () =>
				readers.ledger.memoryWrites({ since: new Date(windowFrom - cfg.ledgerSkewMs).toISOString(), until: nowIso, limit: LEDGER_PAGE_SIZE, cursor }),
			);
			ledgerPages += 1;
			counts.ledger_events_malformed += page.skipped;
			for (const event of page.events) {
				if (typeof event.id !== "string" || seen.has(event.id)) continue;
				seen.add(event.id);
				counts.ledger_events_examined += 1;
				const tsMs = Date.parse(event.ts);
				if (Number.isNaN(tsMs) || typeof event.surface !== "string" || typeof event.scope !== "string" || typeof event.kind !== "string") {
					counts.ledger_events_malformed += 1;
					continue;
				}
				// An unknown surface cannot have emitted; with a bank filter only that bank's writers count.
				if (cfg.bank !== null && cfg.bankFor(event.surface) !== cfg.bank) continue;
				if (events.length >= cfg.maxLedgerEvents) {
					partial = true;
					break;
				}
				// A non-string or empty entry_id is no id: such an event pairs like a legacy one.
				const entryId = typeof event.entry_id === "string" && event.entry_id.length > 0 ? event.entry_id : null;
				events.push({ id: event.id, tsMs, bucket: bucketOf(event.surface, event.scope, event.kind), entryId });
			}
			if (partial || page.next === null) break;
			// A page may carry no write events at all (the reader filters a window of notes), so progress is the cursor moving.
			if (page.next === cursor) throw new ReaderFailure("ledger", "memoryWrites", "paging made no progress");
			if (ledgerPages >= MAX_LEDGER_PAGES) {
				partial = true;
				break;
			}
			cursor = page.next;
		}
		if (partial) {
			truncated = true;
			coverage.ledger = "partial";
			coverage.skipped_checks.push("ledger_compare:ledger_event_cap");
			return;
		}
		coverage.ledger = "compared";

		// Events that name no entry (written before `entry_id` existed) pair by the heuristic, over EVERY scanned entry,
		// exactly as they did before the key existed: an exact event never frees a legacy event for another entry.
		// Events that name an entry then satisfy that entry on top of the heuristic (an entry named by several events
		// counts one pair). An event naming an entry the scan did not read never falls back to the heuristic: it would
		// steal the event of an entry that has its own, so it is reported as it is.
		const itemIds = new Set<string>();
		for (const item of items) itemIds.add(item.entry.id);
		const exactEntryIds = new Set<string>();
		const heuristicMatchedIds = new Set<string>();
		const namedWithoutEntry: Array<{ id: string; tsMs: number; bucket: string; entryId: string }> = [];
		const heuristicEvents: Array<{ id: string; tsMs: number; bucket: string }> = [];
		for (const event of events) {
			if (event.entryId === null) {
				heuristicEvents.push(event);
			} else if (itemIds.has(event.entryId)) {
				exactEntryIds.add(event.entryId);
			} else {
				namedWithoutEntry.push({ id: event.id, tsMs: event.tsMs, bucket: event.bucket, entryId: event.entryId });
			}
		}

		// Entries a writer's surface can have an event for, created inside the judged window.
		const entriesByBucket = new Map<string, Array<{ id: string; tsMs: number }>>();
		for (const item of items) {
			if (!KNOWN_SURFACES.has(item.entry.writer)) continue;
			if (Number.isNaN(item.createdMs) || item.createdMs < windowFrom || item.createdMs > windowTo) continue;
			counts.ledger_entries_judged += 1;
			const bucket = bucketOf(item.entry.writer, item.entry.scope, item.entry.kind);
			const list = entriesByBucket.get(bucket) ?? [];
			list.push({ id: item.entry.id, tsMs: item.createdMs });
			entriesByBucket.set(bucket, list);
		}
		const eventsByBucket = new Map<string, Array<{ id: string; tsMs: number }>>();
		for (const event of heuristicEvents) {
			// Every event up to now pairs (an entry near the window's end may have its event after it); only the judged range reports.
			const list = eventsByBucket.get(event.bucket) ?? [];
			list.push({ id: event.id, tsMs: event.tsMs });
			eventsByBucket.set(event.bucket, list);
		}
		const judgedEventFrom = windowFrom + cfg.ledgerLagMs;
		const order = (a: { id: string; tsMs: number }, b: { id: string; tsMs: number }): number => a.tsMs - b.tsMs || compareText(a.id, b.id);
		for (const bucket of [...new Set([...entriesByBucket.keys(), ...eventsByBucket.keys()])].sort(compareText)) {
			const entryList = (entriesByBucket.get(bucket) ?? []).sort(order);
			const eventList = (eventsByBucket.get(bucket) ?? []).sort(order);
			const { writer, scope, kind } = bucketParts(bucket);
			const bankLabel = token(cfg.bankFor(writer));
			let i = 0;
			let j = 0;
			const unmatchedEntries: Array<{ id: string; tsMs: number }> = [];
			const unmatchedEvents: Array<{ id: string; tsMs: number }> = [];
			const pairs: Array<{ entry: { id: string; tsMs: number }; event: { id: string; tsMs: number } }> = [];
			while (i < entryList.length && j < eventList.length) {
				const entry = entryList[i] as { id: string; tsMs: number };
				const event = eventList[j] as { id: string; tsMs: number };
				const delta = event.tsMs - entry.tsMs;
				if (delta < -cfg.ledgerSkewMs) {
					// The event precedes this entry by more than skew: it belongs to an older entry.
					unmatchedEvents.push(event);
					j += 1;
				} else if (delta > cfg.ledgerLagMs) {
					// The event comes too long after this entry: this entry has none.
					unmatchedEntries.push(entry);
					i += 1;
				} else {
					counts.ledger_pairs += 1;
					heuristicMatchedIds.add(entry.id);
					pairs.push({ entry, event });
					i += 1;
					j += 1;
				}
			}
			unmatchedEntries.push(...entryList.slice(i));
			unmatchedEvents.push(...eventList.slice(j));
			// Only a pair whose entry an exact event names can contend; with none, no unmatched entry needs a search at all.
			// `pairs` is built in bucket order, which is event time order (ties by id), so `contenders` is sorted already.
			const contenders = exactEntryIds.size === 0 ? [] : pairs.filter((pair) => exactEntryIds.has(pair.entry.id));
			for (const entry of unmatchedEntries) {
				// An event that names this entry satisfies it (its pair is counted below).
				if (exactEntryIds.has(entry.id)) continue;
				// A legacy event the heuristic gave to an entry that an exact event also names could as well be this entry's own
				// audit (the other entry then had none until a retry after the upgrade). The data cannot say which: report that.
				const contender = findContender(contenders, entry.tsMs, cfg.ledgerSkewMs, cfg.ledgerLagMs);
				if (contender !== undefined) {
					add({
						code: "ledger_pairing_ambiguous",
						id: token(entry.id),
						stores: ["index", "ledger"],
						bank: bankLabel,
						entry_id: token(entry.id),
						contender_entry_id: token(contender.entry.id),
						legacy_event_id: token(contender.event.id),
						detail: `the memory.write event ${token(contender.event.id)} (writer ${token(writer)}, ${token(kind)} at ${token(scope)}) carries no entry id and may be the audit of this entry or of entry ${token(contender.entry.id)}; an exact event also names entry ${token(contender.entry.id)}, so one of the two entries may have no audit and the data cannot say which`,
					});
					continue;
				}
				add({
					code: "index_entry_without_ledger_write",
					id: token(entry.id),
					stores: ["index", "ledger"],
					bank: bankLabel,
					entry_id: token(entry.id),
					detail: `no accepted memory.write event names this entry or matches writer ${token(writer)}, ${token(kind)} at ${token(scope)} within ${Math.round(cfg.ledgerLagMs / 1000)}s after it (an event written without an entry id can only match by writer, scope, kind and time)`,
				});
			}
			for (const event of unmatchedEvents) {
				if (event.tsMs < judgedEventFrom || event.tsMs > windowTo) continue;
				add({
					code: "ledger_write_without_entry",
					id: token(event.id),
					stores: ["ledger", "index"],
					bank: bankLabel,
					event_id: token(event.id),
					detail: `an accepted memory.write event (writer ${token(writer)}, ${token(kind)} at ${token(scope)}) has no index entry created within ${Math.round(cfg.ledgerLagMs / 1000)}s before it (the event carries no entry id: it may be an idempotent replay or an entry the sweeper deleted)`,
				});
			}
		}
		// An entry satisfied by an event that names it, and by no heuristic pair, is one more pair.
		for (const id of exactEntryIds) {
			if (!heuristicMatchedIds.has(id)) counts.ledger_pairs += 1;
		}
		for (const event of namedWithoutEntry) {
			if (event.tsMs < judgedEventFrom || event.tsMs > windowTo) continue;
			const { writer, scope, kind } = bucketParts(event.bucket);
			add({
				code: "ledger_write_without_entry",
				id: token(event.id),
				stores: ["ledger", "index"],
				bank: token(cfg.bankFor(writer)),
				event_id: token(event.id),
				entry_id: token(event.entryId),
				detail: `an accepted memory.write event (writer ${token(writer)}, ${token(kind)} at ${token(scope)}) names entry ${token(event.entryId)}, which the index scan did not return (the entry may have been swept, or lies beyond the scan bound)`,
			});
		}
		counts.ledger_events_judged += events.filter((event) => event.tsMs >= judgedEventFrom && event.tsMs <= windowTo).length;
	}

	// ── assemble ──────────────────────────────────────────────────────────
	findings.sort(compareFindings);
	const listed = findings.slice(0, cfg.maxFindings);
	if (findings.length > cfg.maxFindings) truncated = true;
	const ok =
		counts.findings_total === 0 &&
		STORES.every((store) => stores[store].state === "ok") &&
		coverage.skipped_checks.length === 0;

	return {
		schema: CONSISTENCY_SCHEMA,
		generated_at: new Date(startedAt).toISOString(),
		scope: {
			bank: cfg.bank,
			since: cfg.since,
			max_entries: cfg.maxEntries,
			max_findings: cfg.maxFindings,
			max_documents: cfg.maxDocuments,
			ledger_window: ledgerWindow,
		},
		stores,
		coverage,
		counts,
		findings: listed,
		truncated,
		ok,
	};
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The report as byte-stable JSON (keys sorted recursively), one trailing newline. */
export function formatReportJson(report: unknown): string {
	return `${canonicalJson(report)}\n`;
}

/** The short human summary: verdict, store states, counts per code. Ids stay in the JSON. */
export function formatReportText(report: ConsistencyReport): string {
	const lines: string[] = [];
	const unreachable = STORES.filter((store) => report.stores[store].state !== "ok");
	const verdict = report.ok
		? "CLEAN"
		: report.counts.findings_total > 0
			? `DRIFT (${report.counts.findings_total} finding${report.counts.findings_total === 1 ? "" : "s"})`
			: "INCOMPLETE (no drift found, but a store or a check could not run)";
	lines.push(`memory consistency: ${verdict}${report.truncated ? " [truncated: a bound cut the run]" : ""}`);
	lines.push(
		`  scope    bank ${report.scope.bank ?? "all"}, since ${report.scope.since ?? "start"}, ${report.counts.entries_examined} entries, ${report.counts.banks_examined} bank(s)`,
	);
	for (const store of STORES) {
		const status = report.stores[store];
		lines.push(`  ${store.padEnd(8)} ${status.state}${status.reason !== undefined ? ` (${status.reason})` : ""}`);
	}
	for (const code of FINDING_CODES) {
		const count = report.counts.findings_by_code[code];
		if (count > 0) lines.push(`  finding  ${code}: ${count}`);
	}
	for (const skipped of report.coverage.skipped_checks) lines.push(`  skipped  ${skipped}`);
	if (report.coverage.outbox === "unknown") lines.push("  note     retain outbox not readable: a missing document may be a parked retain");
	if (report.coverage.banks.listing_truncated.length > 0) {
		lines.push(`  note     document listing cut short for ${report.coverage.banks.listing_truncated.length} bank(s): ${report.coverage.banks.listing_truncated.join(", ")}`);
	}
	if (unreachable.length > 0) lines.push(`  unread   ${unreachable.join(", ")}: ok cannot be claimed`);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Repair plan (data only)
// ---------------------------------------------------------------------------

export const REPAIR_ACTIONS = ["re_retain", "delete_forgotten_document", "delete_orphan_document"] as const;
export type RepairActionName = (typeof REPAIR_ACTIONS)[number];

/** `safe` actions are idempotent and leave the index alone; `orphan` deletes a document nothing in force owns and needs its own switch. */
export type RepairClass = "safe" | "orphan";

export type RepairCondition =
	| "entry_current"
	| "entry_forgotten"
	| "document_absent"
	| "document_present"
	| "document_not_shared"
	| "document_orphaned";

/**
 * One instruction. `read_entry` and `read_document` only read; `require` checks
 * the world is still as the finding saw it; `retain_document` and
 * `delete_document` are the only writes, and both are plane writes: no
 * instruction touches the index or the ledger.
 */
export type RepairStep =
	| { op: "read_entry"; entry_id: string }
	| { op: "require"; condition: RepairCondition; entry_id?: string; bank?: string; document_id?: string; expected_document_id?: string }
	| { op: "retain_document"; entry_id: string; bank: string; document_id: string }
	| { op: "delete_document"; bank: string; document_id: string };

export interface RepairAction {
	action: RepairActionName;
	class: RepairClass;
	/** The finding this answers. */
	finding: FindingCode;
	finding_id: string;
	steps: RepairStep[];
}

export interface Unrepairable {
	finding: FindingCode;
	finding_id: string;
	reason: string;
}

export interface RepairPlan {
	schema: typeof CONSISTENCY_SCHEMA;
	generated_at: string;
	/** False when the report's findings list was cut (`findings_total` exceeds it) or a store was unreachable: the plan covers only what is listed. */
	complete: boolean;
	actions: RepairAction[];
	unrepairable: Unrepairable[];
}

/**
 * The single safe repair each finding implies, as data. Nothing here runs:
 * the plan is an instruction list for an executor the operator started with an
 * explicit flag.
 *
 * - `index_entry_missing_in_plane`: re-retain through the existing retain path (idempotent, replace by document id).
 * - `forgotten_entry_in_plane`: delete the document (the forget's pending plane delete).
 * - `plane_document_orphan` with an entry id, `duplicate_document`: delete the stray document (class `orphan`).
 * - `hash_mismatch`, the two ledger codes, and an orphan that names no entry: no automatic repair; the index is
 *   authoritative and the ledger append-only, so a human decides.
 */
export function planRepairs(report: ConsistencyReport): RepairPlan {
	const actions: RepairAction[] = [];
	const unrepairable: Unrepairable[] = [];
	for (const finding of report.findings) {
		const bank = finding.bank;
		const documentId = finding.document_id;
		switch (finding.code) {
			case "index_entry_missing_in_plane": {
				if (bank === undefined || documentId === undefined || finding.entry_id === undefined) break;
				actions.push({
					action: "re_retain",
					class: "safe",
					finding: finding.code,
					finding_id: finding.id,
					steps: [
						{ op: "read_entry", entry_id: finding.entry_id },
						{ op: "require", condition: "entry_current", entry_id: finding.entry_id },
						{ op: "require", condition: "document_absent", bank, document_id: documentId },
						{ op: "retain_document", entry_id: finding.entry_id, bank, document_id: documentId },
					],
				});
				continue;
			}
			case "forgotten_entry_in_plane": {
				if (bank === undefined || documentId === undefined || finding.entry_id === undefined) break;
				actions.push({
					action: "delete_forgotten_document",
					class: "safe",
					finding: finding.code,
					finding_id: finding.id,
					steps: [
						{ op: "read_entry", entry_id: finding.entry_id },
						{ op: "require", condition: "entry_forgotten", entry_id: finding.entry_id },
						{ op: "require", condition: "document_present", bank, document_id: documentId },
						{ op: "require", condition: "document_not_shared", entry_id: finding.entry_id },
						{ op: "delete_document", bank, document_id: documentId },
					],
				});
				continue;
			}
			case "plane_document_orphan":
			case "duplicate_document": {
				if (bank === undefined || documentId === undefined) break;
				if (finding.code === "plane_document_orphan" && finding.entry_id === undefined) {
					unrepairable.push({ finding: finding.code, finding_id: finding.id, reason: "the document names no entry: inspect it by hand before deleting" });
					continue;
				}
				actions.push({
					action: "delete_orphan_document",
					class: "orphan",
					finding: finding.code,
					finding_id: finding.id,
					steps: [
						{
							op: "require",
							condition: "document_orphaned",
							bank,
							document_id: documentId,
							...(finding.expected_document_id !== undefined ? { expected_document_id: finding.expected_document_id } : {}),
						},
						{ op: "delete_document", bank, document_id: documentId },
					],
				});
				continue;
			}
			case "hash_mismatch":
				unrepairable.push({ finding: finding.code, finding_id: finding.id, reason: "the index row is authoritative: review the row, nothing is rewritten automatically" });
				continue;
			case "index_entry_without_ledger_write":
			case "ledger_pairing_ambiguous":
			case "ledger_write_without_entry":
				unrepairable.push({ finding: finding.code, finding_id: finding.id, reason: "the ledger is append-only and this run cannot repair a pairing between it and the index: review by hand" });
				continue;
		}
		unrepairable.push({ finding: finding.code, finding_id: finding.id, reason: "the finding lacks the ids a repair needs" });
	}
	const unreachable = STORES.some((store) => report.stores[store].state === "store_unreachable");
	return {
		schema: CONSISTENCY_SCHEMA,
		generated_at: report.generated_at,
		complete: report.counts.findings_total === report.findings.length && !unreachable,
		actions,
		unrepairable,
	};
}
