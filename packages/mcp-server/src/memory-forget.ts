/**
 * The forget primitive (v1.6, phase 57, unit b): memory written after a rollback
 * point, or past its lifetime, stops influencing recall and its plane documents
 * go, while the ledger and the index rows stay for audit.
 *
 * No schema change. `memory_entries` already has `superseded_by`, and every
 * reader treats a non-null value as "not in force" (the brief, `memory_search`
 * without `include_superseded`, the standing-entry lookup behind the write gate,
 * the sweeper's lifetime classes, the retain replay's "gone" rule). A forgotten
 * entry therefore gets a MARKER there instead of an entry id:
 *
 *     superseded_by = 'forgotten:<forget_id>'      forget_id = 'fg_' + 26 lowercase hex
 *
 * The row is kept. A marker cannot be mistaken for a superseder: no reader
 * follows `superseded_by` as a pointer (the write path only ever writes it, from
 * `supersedes`), and `isForgetMarker` tells the two apart where a caller cares.
 * `markForgotten` never overwrites an existing `superseded_by`, so an entry a
 * later write already replaced keeps its real superseder.
 *
 * Order of one call: mark in the index FIRST (recall stops at once), then delete
 * the plane documents with bounded concurrency, then emit exactly ONE ledger
 * note (`kind: note`, `payload.action: "memory.forget"`). A plane failure never
 * undoes the index mark; the report says how many deletions are pending and a
 * re-run with the same request (same `forget_id`) retries only the plane
 * deletion of entries already marked with that id.
 *
 * Pure by construction: no I/O of its own, no clock, no randomness. Every
 * dependency (index reads and marks, the plane delete, the ledger emit, `now`)
 * is injected, so nothing here calls Hindsight or the database. Wiring it to the
 * service is the integration step's job.
 */
import { canonicalJson, sha256Hex } from "./event.ts";
import { redact } from "./redact.ts";
import type { Actor, EventKind, MemoryEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FORGET_ACTION = "memory.forget";
export const FORGET_REASONS = ["rollback", "expiry", "operator"] as const;
export type ForgetReason = (typeof FORGET_REASONS)[number];

/** What `superseded_by` starts with on a forgotten entry. An entry id never does (`parseEntryId` refuses it). */
export const FORGET_MARKER_PREFIX = "forgotten:";

/** Entries one `forgetEntries` call may name, after de-duplication. */
export const MAX_FORGET_ENTRIES = 200;
/** The raw list is refused above this before it is de-duplicated, so a hostile list costs a bounded walk. */
export const MAX_FORGET_RAW_ENTRIES = 1000;
/** Plane deletions (and index reads) in flight at once. */
export const FORGET_PLANE_CONCURRENCY = 4;
/** Entry ids the ledger note carries; `entry_count` is the full count. */
export const FORGET_PAYLOAD_ENTRY_IDS = 50;

export const DEFAULT_ROLLBACK_SELECT_LIMIT = 1000;
export const MAX_ROLLBACK_SELECT_LIMIT = 5000;

/** The ledger's per-event payload cap (`MAX_PAYLOAD_BYTES` in `event.ts`): a larger payload is replaced by a marker there. */
export const FORGET_PAYLOAD_MAX_BYTES = 16_000;

const MAX_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_REASON_LENGTH = 200;

const FORGET_ID = /^fg_[0-9a-f]{26}$/;
/** The shapes `session-events.ts` uses for the same ids; copied, not imported, because that file does not export them. */
const CKPT_ID = /^ckpt_[0-9a-z]{26}$/;
const ROLLBACK_ID = /^rb_[0-9a-z]{26}$/;
/** An entry id: `mem_<32 hex>` in practice, any opaque id for rows older than the gate. Never a path. */
const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Which rule a validation failure broke; a closed set so callers can branch on it. */
export type ForgetRule =
	| "not_object"
	| "not_json"
	| "payload_too_large"
	| "unknown_key"
	| "missing"
	| "type"
	| "format"
	| "range"
	| "too_long"
	| "enum"
	| "inconsistent"
	| "at_least_one_of"
	| "store_inconsistent";

/** A contract violation. `path` names the offending field (`entry_ids[3]`), `rule` the rule broken. */
export class ForgetError extends Error {
	readonly rule: ForgetRule;
	readonly path: string;
	constructor(rule: ForgetRule, path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "ForgetError";
		this.rule = rule;
		this.path = path;
	}
}

// ---------------------------------------------------------------------------
// Marker and id
// ---------------------------------------------------------------------------

/** True for a well-formed forget id (`fg_` + 26 lowercase hex). */
export function isForgetId(value: unknown): boolean {
	return typeof value === "string" && FORGET_ID.test(value);
}

/** The `superseded_by` value of an entry forgotten by `forgetId`. Throws on a malformed id: a marker is never improvised. */
export function forgetMarker(forgetId: string): string {
	if (!isForgetId(forgetId)) throw new ForgetError("format", "forget_id", '"fg_" followed by 26 lowercase hex characters');
	return `${FORGET_MARKER_PREFIX}${forgetId}`;
}

/** True when `value` is a `superseded_by` marker written by `forgetMarker` (not an entry id, not empty, not malformed). */
export function isForgetMarker(value: unknown): boolean {
	return typeof value === "string" && value.startsWith(FORGET_MARKER_PREFIX) && FORGET_ID.test(value.slice(FORGET_MARKER_PREFIX.length));
}

/** The forget id inside a marker, or `null` when `value` is not one. */
export function forgetIdOfMarker(value: unknown): string | null {
	return typeof value === "string" && isForgetMarker(value) ? value.slice(FORGET_MARKER_PREFIX.length) : null;
}

/**
 * The id of one forget call, derived from what it is about: the sorted, de-duplicated entry ids, the reason, and
 * the rollback and checkpoint ids. The same request therefore always names the same id, which is what makes a
 * retried call idempotent. The session id is not part of it (it only locates the entries).
 */
export function forgetIdFor(request: Pick<ForgetRequest, "reason" | "entry_ids" | "rollback_id" | "checkpoint_id">): string {
	const entryIds = [...new Set(request.entry_ids)].sort();
	const digest = sha256Hex(
		canonicalJson({ v: 1, entry_ids: entryIds, reason: request.reason, rollback_id: request.rollback_id ?? null, checkpoint_id: request.checkpoint_id ?? null }),
	);
	return `fg_${digest.slice(0, 26)}`;
}

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function asRecord(value: unknown, path: string): Rec {
	if (!isPlainObject(value)) throw new ForgetError("not_object", path, "must be a JSON object");
	return value;
}

const at = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

function assertKeys(rec: Rec, path: string, required: readonly string[], optionalKeys: readonly string[]): void {
	const allowed = new Set([...required, ...optionalKeys]);
	for (const key of Object.keys(rec)) {
		if (!allowed.has(key)) throw new ForgetError("unknown_key", at(path, key), `unknown key; allowed: ${[...allowed].join(", ")}`);
	}
	for (const key of required) {
		if (rec[key] === undefined) throw new ForgetError("missing", at(path, key), "is required");
	}
}

function parseString(value: unknown, path: string, min: number, max: number): string {
	if (typeof value !== "string") throw new ForgetError("type", path, "must be a string");
	if (value.length < min) throw new ForgetError("range", path, `must be at least ${min} character${min === 1 ? "" : "s"}`);
	if (value.length > max) throw new ForgetError("too_long", path, `must be at most ${max} characters (got ${value.length})`);
	if (CONTROL_CHARS.test(value)) throw new ForgetError("format", path, "must not contain control characters");
	return value;
}

function parsePattern(value: unknown, path: string, pattern: RegExp, what: string): string {
	if (typeof value !== "string") throw new ForgetError("type", path, "must be a string");
	if (!pattern.test(value)) throw new ForgetError("format", path, `must be ${what}`);
	return value;
}

function parseEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string") throw new ForgetError("type", path, "must be a string");
	if (!(allowed as readonly string[]).includes(value)) throw new ForgetError("enum", path, `must be one of: ${allowed.join(", ")}`);
	return value as T;
}

function parseCount(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ForgetError("type", path, "must be an integer");
	if (value < 0) throw new ForgetError("range", path, "must be >= 0");
	return value;
}

function parseEntryId(value: unknown, path: string): string {
	const id = parseString(value, path, 1, MAX_ID_LENGTH);
	if (!OPAQUE_ID.test(id)) throw new ForgetError("format", path, "must be an opaque id of A-Z a-z 0-9 . _ : - (never a path)");
	if (id.startsWith(FORGET_MARKER_PREFIX)) throw new ForgetError("format", path, `must not start with "${FORGET_MARKER_PREFIX}" (that prefix marks a forgotten entry)`);
	return id;
}

const actorField = (value: unknown, path: string): Actor => parseEnum(value, path, ["agent", "human"] as const);
const sessionIdField = (value: unknown, path: string): string => parseString(value, path, 1, MAX_SESSION_ID_LENGTH);
const ckptIdField = (value: unknown, path: string): string => parsePattern(value, path, CKPT_ID, '"ckpt_" followed by 26 characters of 0-9 a-z');
const rollbackIdField = (value: unknown, path: string): string => parsePattern(value, path, ROLLBACK_ID, '"rb_" followed by 26 characters of 0-9 a-z');

function optional<K extends string, T>(rec: Rec, key: K, path: string, parse: (value: unknown, path: string) => T): { [P in K]?: T } {
	if (rec[key] === undefined) return {};
	return { [key]: parse(rec[key], at(path, key)) } as { [P in K]?: T };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ForgetRequest {
	reason: ForgetReason;
	/** 1 to {@link MAX_FORGET_ENTRIES} distinct entry ids, sorted. */
	entry_ids: string[];
	/** Who asked: a person or an agent. The authenticated surface is the ledger event's own `surface`, added by the caller. */
	actor: Actor;
	session_id?: string;
	checkpoint_id?: string;
	rollback_id?: string;
}

export type ForgetRequestParse = { ok: true; request: ForgetRequest } | { ok: false; error: ForgetError };

/**
 * Parse an untrusted request. Strict: an unknown key, a wrong type, a malformed id, an empty list, more than
 * {@link MAX_FORGET_ENTRIES} distinct ids, or a `rollback` reason with neither a `rollback_id` nor a `checkpoint_id`
 * is an error naming the offending field. Duplicate ids collapse; the result is sorted so equal requests are equal.
 */
export function parseForgetRequest(input: unknown): ForgetRequestParse {
	try {
		return { ok: true, request: parseRequestOrThrow(input) };
	} catch (cause) {
		if (cause instanceof ForgetError) return { ok: false, error: cause };
		throw cause;
	}
}

function parseRequestOrThrow(input: unknown): ForgetRequest {
	const rec = asRecord(input, "request");
	assertKeys(rec, "", ["reason", "entry_ids", "actor"], ["session_id", "checkpoint_id", "rollback_id"]);
	const reason = parseEnum(rec["reason"], "reason", FORGET_REASONS);
	const rawIds = rec["entry_ids"];
	if (!Array.isArray(rawIds)) throw new ForgetError("type", "entry_ids", "must be an array of entry ids");
	if (rawIds.length > MAX_FORGET_RAW_ENTRIES) {
		throw new ForgetError("too_long", "entry_ids", `must name at most ${MAX_FORGET_RAW_ENTRIES} ids (got ${rawIds.length})`);
	}
	const distinct = [...new Set(rawIds.map((value, index) => parseEntryId(value, `entry_ids[${index}]`)))].sort();
	if (distinct.length === 0) throw new ForgetError("range", "entry_ids", "must name at least one entry");
	if (distinct.length > MAX_FORGET_ENTRIES) {
		throw new ForgetError("too_long", "entry_ids", `must name at most ${MAX_FORGET_ENTRIES} distinct ids (got ${distinct.length}); forget in batches`);
	}
	const request: ForgetRequest = {
		reason,
		entry_ids: distinct,
		actor: actorField(rec["actor"], "actor"),
		...optional(rec, "session_id", "", sessionIdField),
		...optional(rec, "checkpoint_id", "", ckptIdField),
		...optional(rec, "rollback_id", "", rollbackIdField),
	};
	if (reason === "rollback" && request.rollback_id === undefined && request.checkpoint_id === undefined) {
		throw new ForgetError("at_least_one_of", "rollback_id", "a rollback forget needs a rollback_id or a checkpoint_id, so the note can be tied to the rollback it belongs to");
	}
	return request;
}

// ---------------------------------------------------------------------------
// Ledger payload
// ---------------------------------------------------------------------------

export const FORGET_ENTRY_OUTCOMES = ["marked", "already_forgotten", "already_superseded", "missing"] as const;
export type ForgetEntryOutcome = (typeof FORGET_ENTRY_OUTCOMES)[number];

export const FORGET_PLANE_STATUSES = ["deleted", "absent", "pending", "skipped"] as const;
export type ForgetPlaneStatus = (typeof FORGET_PLANE_STATUSES)[number];

export interface ForgetPayload {
	action: typeof FORGET_ACTION;
	forget_id: string;
	reason: ForgetReason;
	actor: Actor;
	/** Distinct entries the call named. */
	entry_count: number;
	/** The first {@link FORGET_PAYLOAD_ENTRY_IDS} of them, sorted. */
	entry_ids: string[];
	/** One entry, one outcome: the values sum to `entry_count`. */
	counts: Record<ForgetEntryOutcome, number>;
	/** One entry, one plane status: the values sum to `entry_count`. */
	plane: Record<ForgetPlaneStatus, number>;
	session_id?: string;
	checkpoint_id?: string;
	rollback_id?: string;
}

/** What a builder returns: the part of an `EventInput` this contract owns. `surface`, `session_id` and `ts` stay the caller's. */
export interface ForgetEventDraft {
	kind: Extract<EventKind, "note">;
	summary: string;
	payload: ForgetPayload;
	/** Distinct per outcome: a re-run that changes nothing dedupes, one that retries the plane does not. */
	idempotency_key: string;
}

function parseCounts<K extends string>(value: unknown, path: string, keys: readonly K[]): Record<K, number> {
	const rec = asRecord(value, path);
	assertKeys(rec, path, keys, []);
	const out = {} as Record<K, number>;
	for (const key of keys) out[key] = parseCount(rec[key], at(path, key));
	return out;
}

const sum = (values: Iterable<number>): number => {
	let total = 0;
	for (const value of values) total += value;
	return total;
};

/** Throw unless `payload` serialises to at most {@link FORGET_PAYLOAD_MAX_BYTES} UTF-8 bytes. Exported so the boundary is testable. */
export function assertForgetPayloadWithinCap(payload: unknown): void {
	let json: string | undefined;
	try {
		json = JSON.stringify(payload);
	} catch {
		throw new ForgetError("not_json", "payload", "must be JSON-serialisable");
	}
	if (json === undefined) throw new ForgetError("not_json", "payload", "must be JSON-serialisable");
	const bytes = Buffer.byteLength(json);
	if (bytes > FORGET_PAYLOAD_MAX_BYTES) {
		throw new ForgetError("payload_too_large", "payload", `${bytes} bytes exceeds the ${FORGET_PAYLOAD_MAX_BYTES}-byte ledger cap`);
	}
}

/** Validate a `memory.forget` payload. Strict: unknown keys, bad ids and inconsistent counts are errors. Throws `ForgetError`. */
export function parseForgetPayload(value: unknown): ForgetPayload {
	const rec = asRecord(value, "payload");
	assertForgetPayloadWithinCap(value);
	assertKeys(
		rec,
		"",
		["action", "forget_id", "reason", "actor", "entry_count", "entry_ids", "counts", "plane"],
		["session_id", "checkpoint_id", "rollback_id"],
	);
	if (rec["action"] !== FORGET_ACTION) throw new ForgetError("enum", "action", `must be "${FORGET_ACTION}"`);
	const forgetId = parsePattern(rec["forget_id"], "forget_id", FORGET_ID, '"fg_" followed by 26 lowercase hex characters');
	const reason = parseEnum(rec["reason"], "reason", FORGET_REASONS);
	const actor = actorField(rec["actor"], "actor");
	const entryCount = parseCount(rec["entry_count"], "entry_count");
	if (entryCount < 1) throw new ForgetError("range", "entry_count", "must be >= 1");
	if (entryCount > MAX_FORGET_ENTRIES) throw new ForgetError("range", "entry_count", `must be <= ${MAX_FORGET_ENTRIES}`);
	const rawIds = rec["entry_ids"];
	if (!Array.isArray(rawIds)) throw new ForgetError("type", "entry_ids", "must be an array of entry ids");
	if (rawIds.length > FORGET_PAYLOAD_ENTRY_IDS) {
		throw new ForgetError("too_long", "entry_ids", `must carry at most ${FORGET_PAYLOAD_ENTRY_IDS} ids (got ${rawIds.length})`);
	}
	const entryIds = rawIds.map((id, index) => parseEntryId(id, `entry_ids[${index}]`));
	if (new Set(entryIds).size !== entryIds.length) throw new ForgetError("inconsistent", "entry_ids", "must not repeat an id");
	if (entryIds.length !== Math.min(entryCount, FORGET_PAYLOAD_ENTRY_IDS)) {
		throw new ForgetError("inconsistent", "entry_ids", `must carry min(entry_count, ${FORGET_PAYLOAD_ENTRY_IDS}) = ${Math.min(entryCount, FORGET_PAYLOAD_ENTRY_IDS)} ids (got ${entryIds.length})`);
	}
	const counts = parseCounts(rec["counts"], "counts", FORGET_ENTRY_OUTCOMES);
	if (sum(Object.values(counts)) !== entryCount) throw new ForgetError("inconsistent", "counts", `must sum to entry_count (${entryCount})`);
	const plane = parseCounts(rec["plane"], "plane", FORGET_PLANE_STATUSES);
	if (sum(Object.values(plane)) !== entryCount) throw new ForgetError("inconsistent", "plane", `must sum to entry_count (${entryCount})`);
	return {
		action: FORGET_ACTION,
		forget_id: forgetId,
		reason,
		actor,
		entry_count: entryCount,
		entry_ids: entryIds,
		counts,
		plane,
		...optional(rec, "session_id", "", sessionIdField),
		...optional(rec, "checkpoint_id", "", ckptIdField),
		...optional(rec, "rollback_id", "", rollbackIdField),
	};
}

/** The ledger key of a note: equal outcomes of one forget id are one fact, a plane retry is a new one. */
export function forgetIdempotencyKey(payload: Pick<ForgetPayload, "forget_id" | "counts" | "plane">): string {
	const digest = sha256Hex(canonicalJson({ counts: payload.counts, plane: payload.plane })).slice(0, 16);
	return `memory.forget:${payload.forget_id}:${digest}`;
}

/** Build and validate the `memory.forget` event. The summary is a fixed shape over validated tokens and counts, never caller free text. */
export function buildForgetEvent(fields: Omit<ForgetPayload, "action">): ForgetEventDraft {
	const payload = parseForgetPayload({ ...fields, action: FORGET_ACTION });
	const { counts, plane } = payload;
	return {
		kind: "note",
		summary:
			`memory forget ${payload.forget_id} (${payload.reason}): ${counts.marked} marked, ${counts.already_forgotten} already forgotten, ` +
			`${counts.already_superseded} superseded, ${counts.missing} missing; plane ${plane.deleted} deleted, ${plane.absent} absent, ${plane.pending} pending`,
		payload,
		idempotency_key: forgetIdempotencyKey(payload),
	};
}

// ---------------------------------------------------------------------------
// forgetEntries
// ---------------------------------------------------------------------------

/** What the injected plane delete answers. A 404 on an absent document is success (`absent: true`). */
export type PlaneDeleteResult =
	| { ok: true; absent?: boolean; skipped?: undefined }
	| { ok: true; skipped: string; absent?: undefined }
	| { ok: false; reason: string; retryable: boolean };

export interface ForgetDeps {
	/** The entry by id, or `null` when there is none. A read that fails throws: nothing has been changed yet. */
	readEntry(id: string): Promise<MemoryEntry | null>;
	/**
	 * Set `superseded_by = marker` on every id whose `superseded_by` is still null, in one statement, and return the
	 * ids it changed. Idempotent; never overwrites a real superseder or an earlier marker.
	 */
	markForgotten(ids: readonly string[], marker: string): Promise<readonly string[]>;
	/** Delete the entry's plane document. The caller resolves the bank and the document id from the entry. May return `skipped` when there is nowhere to delete (plane not configured). */
	deletePlaneDocument(entry: MemoryEntry): Promise<PlaneDeleteResult>;
	/**
	 * True when another live entry of the SAME WRITER now maps to the same plane document (a subject-addressed
	 * document is shared by every entry of that writer with that scope, kind and subject), so deleting it would remove
	 * memory that is still in force. Absent: never skipped for that reason. This check runs where `forgetEntries` calls
	 * it, outside any queue: an adapter that serialises plane writes (the service's per-document retain queue) leaves
	 * it unset and asks the same question inside `deletePlaneDocument`, after the writes queued before the delete have
	 * landed, answering `{ ok: true, skipped: "document-shared" }`.
	 */
	documentShared?(entry: MemoryEntry): Promise<boolean>;
	/** Emit the one ledger note. The caller adds its authenticated `surface` and the `session_id`. */
	emit(payload: ForgetPayload, summary: string, meta: { idempotency_key: string }): Promise<void>;
	/** Epoch milliseconds. */
	now(): number;
}

export type ForgetPlaneOutcome =
	| { status: "deleted" }
	| { status: "absent" }
	| { status: "pending"; reason: string; retryable: boolean }
	| { status: "skipped"; reason: string };

export interface ForgetEntryReport {
	id: string;
	outcome: ForgetEntryOutcome;
	/** `already_forgotten`: the forget id on the marker (this call's own, or another call's). */
	forgotten_by?: string;
	/** `already_superseded`: the entry that replaced it. */
	superseded_by?: string;
	plane: ForgetPlaneOutcome;
}

export interface ForgetReport {
	forget_id: string;
	marker: string;
	reason: ForgetReason;
	/** ISO instant the call started, from the injected clock. */
	at: string;
	entry_count: number;
	counts: Record<ForgetEntryOutcome, number>;
	plane: Record<ForgetPlaneStatus, number>;
	/** Entries whose plane document is still to delete: re-run the same request to retry exactly those. */
	plane_pending: number;
	entries: ForgetEntryReport[];
	/** The note's fate. An emit that failed is reported, never thrown: the index mark already stands. */
	ledger: { emitted: true; idempotency_key: string } | { emitted: false; reason: string };
}

/** Map `items` through `work`, at most `limit` at a time, results in input order. A rejection stops new work and propagates. */
async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await work(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

const clip = (text: string): string => redact(text).slice(0, MAX_REASON_LENGTH);

type Classified =
	| { kind: "open"; entry: MemoryEntry }
	| { kind: "missing" }
	| { kind: "own"; entry: MemoryEntry }
	| { kind: "other"; forgottenBy: string }
	| { kind: "superseded"; by: string };

/** A classification once the mark has run: `open` became `marked` (this call forgot it) or whatever raced it. */
type Resolved = Exclude<Classified, { kind: "open" }> | { kind: "marked"; entry: MemoryEntry };

function classify(entry: MemoryEntry | null, marker: string): Classified {
	if (entry === null) return { kind: "missing" };
	const by = entry.superseded_by;
	// `=== undefined`, the rule the retain replay applies: any value, a marker included, means "not in force".
	if (by === undefined) return { kind: "open", entry };
	if (by === marker) return { kind: "own", entry };
	const other = forgetIdOfMarker(by);
	if (other !== null) return { kind: "other", forgottenBy: other };
	return { kind: "superseded", by };
}

async function deletePlane(deps: ForgetDeps, entry: MemoryEntry): Promise<ForgetPlaneOutcome> {
	try {
		if (deps.documentShared && (await deps.documentShared(entry))) return { status: "skipped", reason: "document-shared" };
		const result = await deps.deletePlaneDocument(entry);
		if (!result.ok) return { status: "pending", reason: clip(result.reason), retryable: result.retryable };
		if (result.skipped !== undefined) return { status: "skipped", reason: clip(result.skipped) };
		return result.absent === true ? { status: "absent" } : { status: "deleted" };
	} catch (cause) {
		// A throw from the injected delete is a plane failure like any other: the index mark already stands and a
		// re-run retries this deletion, so it is reported as pending (retryable) rather than undoing or aborting.
		return { status: "pending", reason: clip(`plane delete threw: ${cause instanceof Error ? cause.message : String(cause)}`), retryable: true };
	}
}

/**
 * Forget the named entries: mark them in the index, delete their plane documents, emit one note.
 *
 * `request` is re-validated with {@link parseForgetRequest} (a `ForgetError` names the bad field), so a caller that
 * built it by hand cannot skip the rules. A read or mark that throws propagates before anything is changed or, for a
 * mark, atomically (one statement); a plane failure or a failed emit never does. Per entry the outcome is
 * `marked` (this call forgot it), `already_forgotten` (a forget marker was there), `already_superseded` (a real
 * superseder was there: left alone, its plane document is not touched) or `missing`. For an entry marked with this
 * call's own forget id the plane deletion is attempted (again, on a re-run); entries forgotten by another call are
 * left to it.
 */
export async function forgetEntries(deps: ForgetDeps, request: ForgetRequest): Promise<ForgetReport> {
	const parsed = parseForgetRequest(request);
	if (!parsed.ok) throw parsed.error;
	const input = parsed.request;
	const forgetId = forgetIdFor(input);
	const marker = forgetMarker(forgetId);
	const startedAt = new Date(deps.now()).toISOString();

	// 1. Read. Nothing has been changed yet, so a failing read simply propagates.
	const entries = await mapBounded(input.entry_ids, FORGET_PLANE_CONCURRENCY, (id) => deps.readEntry(id));
	const read = entries.map((entry) => classify(entry, marker));

	// 2. Mark, first: from here on the index no longer serves these entries.
	const openIds = input.entry_ids.filter((_, index) => read[index]?.kind === "open");
	const changed = new Set(openIds.length > 0 ? await deps.markForgotten(openIds, marker) : []);
	const states = await mapBounded(read, FORGET_PLANE_CONCURRENCY, async (state, index): Promise<Resolved> => {
		if (state.kind !== "open") return state;
		const id = input.entry_ids[index] as string;
		if (changed.has(id)) return { kind: "marked", entry: state.entry };
		// The statement did not change an id that was open at the read: it was closed in between (another writer
		// superseded it, or a duplicate call marked it). Read it again and classify what is there now.
		const again = classify(await deps.readEntry(id), marker);
		if (again.kind === "open") {
			throw new ForgetError("store_inconsistent", "entry_ids", `entry ${id} is still in force although the mark did not change it; re-run the same request`);
		}
		return again;
	});

	// 3. Plane deletes, bounded. Only entries this call (or an earlier call with the same id) forgot.
	const reports = await mapBounded(input.entry_ids, FORGET_PLANE_CONCURRENCY, async (id, index): Promise<ForgetEntryReport> => {
		const state = states[index] as Resolved;
		switch (state.kind) {
			case "marked":
				return { id, outcome: "marked", plane: await deletePlane(deps, state.entry) };
			case "own":
				return { id, outcome: "already_forgotten", forgotten_by: forgetId, plane: await deletePlane(deps, state.entry) };
			case "other":
				return { id, outcome: "already_forgotten", forgotten_by: state.forgottenBy, plane: { status: "skipped", reason: "forgotten-by-another-call" } };
			case "superseded":
				return { id, outcome: "already_superseded", superseded_by: state.by, plane: { status: "skipped", reason: "superseded" } };
			case "missing":
				return { id, outcome: "missing", plane: { status: "skipped", reason: "missing" } };
		}
	});

	const counts = Object.fromEntries(FORGET_ENTRY_OUTCOMES.map((key) => [key, 0])) as Record<ForgetEntryOutcome, number>;
	const plane = Object.fromEntries(FORGET_PLANE_STATUSES.map((key) => [key, 0])) as Record<ForgetPlaneStatus, number>;
	for (const report of reports) {
		counts[report.outcome] += 1;
		plane[report.plane.status] += 1;
	}

	// 4. One note for the call. Built before the try: the payload is bounded by construction (ids <= 128 characters,
	// at most 50 of them), so a build failure is a bug and must surface, not be swallowed with the emit.
	const draft = buildForgetEvent({
		forget_id: forgetId,
		reason: input.reason,
		actor: input.actor,
		entry_count: input.entry_ids.length,
		entry_ids: input.entry_ids.slice(0, FORGET_PAYLOAD_ENTRY_IDS),
		counts,
		plane,
		...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
		...(input.checkpoint_id !== undefined ? { checkpoint_id: input.checkpoint_id } : {}),
		...(input.rollback_id !== undefined ? { rollback_id: input.rollback_id } : {}),
	});
	let ledger: ForgetReport["ledger"];
	try {
		await deps.emit(draft.payload, draft.summary, { idempotency_key: draft.idempotency_key });
		ledger = { emitted: true, idempotency_key: draft.idempotency_key };
	} catch (cause) {
		// Reported, not thrown: the index marks and plane deletions are done and cannot be undone by a ledger failure,
		// so the caller must still learn what happened. The caller decides whether to re-run (which re-emits).
		ledger = { emitted: false, reason: clip(`emit failed: ${cause instanceof Error ? cause.message : String(cause)}`) };
	}

	return {
		forget_id: forgetId,
		marker,
		reason: input.reason,
		at: startedAt,
		entry_count: input.entry_ids.length,
		counts,
		plane,
		plane_pending: plane.pending,
		entries: reports,
		ledger,
	};
}

// ---------------------------------------------------------------------------
// selectForRollback
// ---------------------------------------------------------------------------

export interface RollbackSelectDeps {
	/**
	 * Entries of `sessionId` (and, when given, `graphId`) created strictly after `afterIso` (and, when `untilIso` is
	 * not null, at or before it) that are not superseded, ordered by created then id, at most `limit`, with `truncated`
	 * true when more matched. `IndexStore.memoryEntriesCreatedAfter`.
	 */
	entriesCreatedAfter(
		sessionId: string,
		afterIso: string,
		graphId: string | null,
		limit: number,
		untilIso: string | null,
		writer?: string | null,
	): Promise<{ entries: ReadonlyArray<Pick<MemoryEntry, "id">>; truncated: boolean }>;
}

export interface RollbackSelectRequest {
	session_id: string;
	/** The rollback point: an ISO instant (the checkpoint's cut: the earlier of its event `ts` and the time it was taken). */
	after: string;
	graph_id?: string;
	/** Default {@link DEFAULT_ROLLBACK_SELECT_LIMIT}, at most {@link MAX_ROLLBACK_SELECT_LIMIT}. */
	limit?: number;
	/**
	 * The newest instant the selection reaches (inclusive, ISO): memory the session wrote AFTER the rollback began
	 * belongs to the new timeline and is never selected. Absent means no upper bound (everything up to now). It must
	 * not be before `after`.
	 */
	until?: string;
	/**
	 * Only entries this surface wrote. The writer is part of the query, ahead of the limit: filtered afterwards, a page
	 * full of another surface's rows would hide the caller's own and the selection would look complete when it is not.
	 */
	writer?: string;
}

export interface RollbackSelection {
	/** Ordered by created then id: feed them to `forgetEntries` in batches of {@link MAX_FORGET_ENTRIES}. */
	entry_ids: string[];
	/** True when more entries matched than `limit`: forget these, then select again (forgotten entries drop out of the next selection). */
	truncated: boolean;
	/** The instant as compared: whole milliseconds, UTC. */
	after: string;
}

/**
 * The entries a rollback to `after` should forget: written in the session (and graph) STRICTLY after the instant and
 * not already superseded, and, with `until`, at or before that instant. The comparison is in whole milliseconds, the
 * precision of an event `ts`, so an entry created in the same millisecond as the rollback point is KEPT: a tie keeps
 * the entry. Entries already superseded or already forgotten are never selected, which is what makes "select, forget,
 * select again" terminate.
 */
export async function selectForRollback(deps: RollbackSelectDeps, request: RollbackSelectRequest): Promise<RollbackSelection> {
	const rec = asRecord(request, "request");
	assertKeys(rec, "", ["session_id", "after"], ["graph_id", "limit", "until", "writer"]);
	const sessionId = sessionIdField(rec["session_id"], "session_id");
	const afterRaw = parseString(rec["after"], "after", 1, 64);
	if (!ISO_INSTANT.test(afterRaw) || Number.isNaN(Date.parse(afterRaw))) {
		throw new ForgetError("format", "after", "must be an ISO 8601 instant such as 2026-10-26T12:00:00.000Z");
	}
	const after = new Date(Date.parse(afterRaw)).toISOString();
	let until: string | null = null;
	if (rec["until"] !== undefined) {
		const untilRaw = parseString(rec["until"], "until", 1, 64);
		if (!ISO_INSTANT.test(untilRaw) || Number.isNaN(Date.parse(untilRaw))) {
			throw new ForgetError("format", "until", "must be an ISO 8601 instant such as 2026-10-26T12:00:00.000Z");
		}
		until = new Date(Date.parse(untilRaw)).toISOString();
		if (Date.parse(until) < Date.parse(after)) throw new ForgetError("range", "until", "must not be before after");
	}
	const graphId = rec["graph_id"] === undefined ? null : sessionIdField(rec["graph_id"], "graph_id");
	let limit = DEFAULT_ROLLBACK_SELECT_LIMIT;
	if (rec["limit"] !== undefined) {
		const value = rec["limit"];
		if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ForgetError("type", "limit", "must be an integer");
		if (value < 1 || value > MAX_ROLLBACK_SELECT_LIMIT) throw new ForgetError("range", "limit", `must be between 1 and ${MAX_ROLLBACK_SELECT_LIMIT}`);
		limit = value;
	}
	const writer = rec["writer"] === undefined ? null : parseString(rec["writer"], "writer", 1, 64);
	const found = await deps.entriesCreatedAfter(sessionId, after, graphId, limit, until, writer);
	// A store that returned more than asked (a bug on its side) is trimmed here and reported as truncated.
	const ids = [...new Set(found.entries.map((entry) => entry.id))];
	return { entry_ids: ids.slice(0, limit), truncated: found.truncated || ids.length > limit, after };
}
