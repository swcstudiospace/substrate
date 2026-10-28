/**
 * Session checkpoint and rollback event contracts (v1.6, phase 55).
 *
 * Three append-only ledger events describe a session's checkpoints and its
 * rollbacks, using existing kinds only (no kind and no surface is added):
 *
 * - `session.checkpoint`       — kind `note`,    `payload.action: "session.checkpoint"`
 * - `session.rollback`         — kind `note`,    `payload.action: "session.rollback"`
 * - `session.rollback.refused` — kind `warning`, `payload.action: "session.rollback.refused"`
 *
 * A rollback is a NEW event that points at an earlier one (`target_event_id`
 * and `target_hash`); the ledger is never mutated. Payloads carry ids, counts
 * and digests, never file, transcript or memory content (the no-content rule
 * of `docs/event-vocabulary.md`).
 *
 * Pure by construction: no I/O, no clock, no randomness of its own (ids take an
 * injected random-bytes function), no service, MCP or HTTP wiring. The builders
 * return the `kind`, `summary`, `payload` and `idempotency_key` of an
 * `EventInput`; the caller adds its own authenticated `surface`, the target
 * `session_id` (so the event chains into that session) and, for a replay, the
 * original `ts`. Under `SUBSTRATE_EVENT_IDEMPOTENCY=off` (the default) the
 * ledger ignores the key, so a replay dedupes only under `accept` or `enforce`.
 */
import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_PATTERN } from "./event.ts";
import { SURFACES, type EventInput, type EventKind, type Surface } from "./types.ts";

/** The ledger's per-event payload cap (`MAX_PAYLOAD_BYTES` in `event.ts`): a larger payload is replaced by a marker. */
export const LEDGER_PAYLOAD_MAX_BYTES = 16_000;

export const SESSION_CHECKPOINT_ACTION = "session.checkpoint";
export const SESSION_ROLLBACK_ACTION = "session.rollback";
export const SESSION_ROLLBACK_REFUSED_ACTION = "session.rollback.refused";

export const CHECKPOINT_TRIGGERS = ["turn", "plan-step", "steering", "manual", "pre-restore", "baseline"] as const;
export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

export const ROLLBACK_TRANSCRIPT_OUTCOMES = ["moved-leaf", "marker-only", "unsupported", "stale"] as const;
export type RollbackTranscriptOutcome = (typeof ROLLBACK_TRANSCRIPT_OUTCOMES)[number];

export const ROLLBACK_REFUSAL_REASONS = [
	"not-authorized",
	"session-busy",
	"target-not-found",
	"chain-unverified",
	"hash-mismatch",
	"drift-detected",
	"ledger-down",
	"blob-missing",
	"transcript-stale",
	"invalid-request",
] as const;
export type RollbackRefusalReason = (typeof ROLLBACK_REFUSAL_REASONS)[number];

/** Which rule a validation failure broke; a closed set so callers can branch on it. */
export type SessionEventRule =
	| "not_object"
	| "not_json"
	| "payload_too_large"
	| "content_key"
	| "unknown_key"
	| "missing"
	| "type"
	| "format"
	| "range"
	| "too_long"
	| "enum"
	| "at_least_one_of";

/** A contract violation. `path` names the offending field (`transcript_ref.session_locator`), `rule` the rule broken. */
export class SessionEventError extends Error {
	readonly rule: SessionEventRule;
	readonly path: string;
	constructor(rule: SessionEventRule, path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "SessionEventError";
		this.rule = rule;
		this.path = path;
	}
}

export interface TranscriptRef {
	/** A `SURFACES` member: which agent's transcript this points into. */
	surface: Surface;
	/** An OPAQUE id (a session uuid or conversation id), never a path. */
	session_locator: string;
	entry_id?: string;
	turn_no?: number;
	parent_entry_id?: string;
	/** sha256 of the transcript prefix the checkpoint covers. */
	prefix_sha256?: string;
}

export interface CheckpointPayload {
	action: typeof SESSION_CHECKPOINT_ACTION;
	ckpt_id: string;
	seq: number;
	trigger: CheckpointTrigger;
	git_tree: string;
	git_base_commit?: string;
	branch?: string;
	manifest_sha256: string;
	file_count: number;
	skipped_count: number;
	transcript_ref?: TranscriptRef;
	chain_head?: { event_id: string; hash: string };
	plan_ref?: { phase?: string; step?: string };
	prev_ckpt_id?: string;
	/**
	 * When the snapshot was pinned on the client, in epoch milliseconds. A checkpoint recorded late (offline, synced
	 * hours afterwards) is cut in time at this instant, not at its ledger record time. The server honours it only
	 * within its window around the record time and says so when it does not (`session-rollback.ts`).
	 */
	taken_at_ms?: number;
}

export interface RollbackPayload {
	action: typeof SESSION_ROLLBACK_ACTION;
	rollback_id: string;
	from_ckpt_id: string;
	to_ckpt_id: string;
	target_event_id: string;
	target_hash: string;
	pre_restore_tree: string;
	pre_restore_ckpt_id: string;
	files_added: number;
	files_modified: number;
	files_deleted: number;
	memory: { superseded_entries: number; forgotten_documents: number };
	transcript: RollbackTranscriptOutcome;
}

export interface RefusedPayload {
	action: typeof SESSION_ROLLBACK_REFUSED_ACTION;
	reason: RollbackRefusalReason;
	to_ckpt_id?: string;
	detail?: string;
}

export type SessionEventPayload = CheckpointPayload | RollbackPayload | RefusedPayload;

/** What a builder returns: the part of an `EventInput` this contract owns. `surface`, `session_id` and `ts` stay the caller's. */
export type SessionEventDraft<P extends SessionEventPayload> = Pick<EventInput, "summary"> & {
	kind: Extract<EventKind, "note" | "warning">;
	payload: P;
	/** Absent for a refusal: a repeated refusal is a new fact, not a replay. */
	idempotency_key?: string;
};

// ---------------------------------------------------------------------------
// Primitive rules
// ---------------------------------------------------------------------------

const CKPT_ID = /^ckpt_[0-9a-z]{26}$/;
const ROLLBACK_ID = /^rb_[0-9a-z]{26}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const GIT_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Opaque ids: no slash, backslash, space or `~`, so a path can never pass as one. */
const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: detects C0/DEL control characters in untrusted ids
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SURFACE_SET: ReadonlySet<string> = new Set(SURFACES);

/** Key names that look like content. Exact, after lower-casing and snake-casing. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
	"body",
	"content",
	"contents",
	"text",
	"bytes",
	"diff",
	"patch",
	"file_content",
	"file_contents",
	"file_body",
	"file_bytes",
	"blob",
	"image",
	"png",
]);
/** `foo_content`, `old_text`, `raw_bytes`, `unified_diff`, `git_patch`: the hashed forms (`content_sha256`, `text_len`) do not end this way. */
const CONTENT_SUFFIX = /_(?:content|contents|body|text|bytes|diff|patch)$/;

function looksLikeContentKey(key: string): boolean {
	const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
	return CONTENT_KEYS.has(snake) || CONTENT_SUFFIX.test(snake);
}

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function asRecord(value: unknown, path: string): Rec {
	if (!isPlainObject(value)) throw new SessionEventError("not_object", path, "must be a JSON object");
	return value;
}

/** Reject any key that looks like content, at any depth. Input is already size-capped, so the walk is bounded. */
function assertNoContentKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((inner, i) => {
			assertNoContentKeys(inner, `${path}[${i}]`);
		});
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, inner] of Object.entries(value)) {
		const here = path === "" ? key : `${path}.${key}`;
		if (looksLikeContentKey(key)) {
			throw new SessionEventError("content_key", here, "content-bearing keys are never allowed; carry a digest and a length instead");
		}
		assertNoContentKeys(inner, here);
	}
}

/** Throw unless `payload` serialises to at most `LEDGER_PAYLOAD_MAX_BYTES` UTF-8 bytes. Exported so the boundary is testable. */
export function assertPayloadWithinLedgerCap(payload: unknown): void {
	let json: string | undefined;
	try {
		json = JSON.stringify(payload);
	} catch {
		throw new SessionEventError("not_json", "payload", "must be JSON-serialisable");
	}
	if (json === undefined) throw new SessionEventError("not_json", "payload", "must be JSON-serialisable");
	const bytes = Buffer.byteLength(json);
	if (bytes > LEDGER_PAYLOAD_MAX_BYTES) {
		throw new SessionEventError("payload_too_large", "payload", `${bytes} bytes exceeds the ${LEDGER_PAYLOAD_MAX_BYTES}-byte ledger cap`);
	}
}

function assertKeys(rec: Rec, path: string, required: readonly string[], optional: readonly string[]): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(rec)) {
		if (!allowed.has(key)) {
			throw new SessionEventError("unknown_key", path === "" ? key : `${path}.${key}`, `unknown key; allowed: ${[...allowed].join(", ")}`);
		}
	}
	for (const key of required) {
		if (rec[key] === undefined) throw new SessionEventError("missing", path === "" ? key : `${path}.${key}`, "is required");
	}
}

function at(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

function parseString(value: unknown, path: string, min: number, max: number): string {
	if (typeof value !== "string") throw new SessionEventError("type", path, "must be a string");
	if (value.length < min) throw new SessionEventError("range", path, `must be at least ${min} character${min === 1 ? "" : "s"}`);
	if (value.length > max) throw new SessionEventError("too_long", path, `must be at most ${max} characters (got ${value.length})`);
	if (CONTROL_CHARS.test(value)) throw new SessionEventError("format", path, "must not contain control characters");
	return value;
}

function parseOpaqueId(value: unknown, path: string, max: number): string {
	const id = parseString(value, path, 1, max);
	if (!OPAQUE_ID.test(id)) {
		throw new SessionEventError("format", path, "must be an opaque id of A-Z a-z 0-9 . _ : - (never a path)");
	}
	return id;
}

function parseInteger(value: unknown, path: string, min: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SessionEventError("type", path, "must be an integer");
	if (value < min) throw new SessionEventError("range", path, `must be >= ${min}`);
	return value;
}

function parsePattern(value: unknown, path: string, pattern: RegExp, what: string): string {
	if (typeof value !== "string") throw new SessionEventError("type", path, "must be a string");
	if (!pattern.test(value)) throw new SessionEventError("format", path, `must be ${what}`);
	return value;
}

const sha256Field = (value: unknown, path: string) => parsePattern(value, path, HEX_64, "64 lowercase hex characters");
const gitHexField = (value: unknown, path: string) => parsePattern(value, path, GIT_HEX, "40 or 64 lowercase hex characters");
const ckptIdField = (value: unknown, path: string) => parsePattern(value, path, CKPT_ID, '"ckpt_" followed by 26 characters of 0-9 a-z');
const rollbackIdField = (value: unknown, path: string) => parsePattern(value, path, ROLLBACK_ID, '"rb_" followed by 26 characters of 0-9 a-z');

function parseEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string") throw new SessionEventError("type", path, "must be a string");
	if (!(allowed as readonly string[]).includes(value)) {
		throw new SessionEventError("enum", path, `must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

/** Parse `rec[key]` into `{ [key]: value }` only when the caller supplied it (absent = `undefined`; `null` is not absent). */
function optional<K extends string, T>(rec: Rec, key: K, path: string, parse: (value: unknown, path: string) => T): { [P in K]?: T } {
	if (rec[key] === undefined) return {};
	return { [key]: parse(rec[key], at(path, key)) } as { [P in K]?: T };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** Validate a transcript pointer. Throws `SessionEventError`. */
export function parseTranscriptRef(value: unknown, path = "transcript_ref"): TranscriptRef {
	const rec = asRecord(value, path);
	assertKeys(rec, path, ["surface", "session_locator"], ["entry_id", "turn_no", "parent_entry_id", "prefix_sha256"]);
	const surface = parseString(rec["surface"], at(path, "surface"), 1, 64);
	if (!SURFACE_SET.has(surface)) {
		throw new SessionEventError("enum", at(path, "surface"), "must be a member of SURFACES");
	}
	const session_locator = parseOpaqueId(rec["session_locator"], at(path, "session_locator"), 128);
	if (rec["entry_id"] === undefined && rec["turn_no"] === undefined) {
		throw new SessionEventError("at_least_one_of", path, "needs at least one of entry_id and turn_no");
	}
	return {
		surface: surface as Surface,
		session_locator,
		...optional(rec, "entry_id", path, (v, p) => parseOpaqueId(v, p, 64)),
		...optional(rec, "turn_no", path, (v, p) => parseInteger(v, p, 0)),
		...optional(rec, "parent_entry_id", path, (v, p) => parseOpaqueId(v, p, 64)),
		...optional(rec, "prefix_sha256", path, sha256Field),
	};
}

function parseChainHead(value: unknown, path: string): { event_id: string; hash: string } {
	const rec = asRecord(value, path);
	assertKeys(rec, path, ["event_id", "hash"], []);
	return {
		event_id: parseOpaqueId(rec["event_id"], at(path, "event_id"), 64),
		hash: sha256Field(rec["hash"], at(path, "hash")),
	};
}

function parsePlanRef(value: unknown, path: string): { phase?: string; step?: string } {
	const rec = asRecord(value, path);
	assertKeys(rec, path, [], ["phase", "step"]);
	return {
		...optional(rec, "phase", path, (v, p) => parseString(v, p, 1, 64)),
		...optional(rec, "step", path, (v, p) => parseString(v, p, 1, 64)),
	};
}

/** The shared front gate of every payload validator: JSON object, within the ledger cap, and free of content-shaped keys. */
function gate(value: unknown): Rec {
	const rec = asRecord(value, "payload");
	assertPayloadWithinLedgerCap(rec);
	assertNoContentKeys(rec, "");
	return rec;
}

function expectAction(rec: Rec, action: string): void {
	if (rec["action"] !== action) throw new SessionEventError("enum", "action", `must be "${action}"`);
}

/** Validate a `session.checkpoint` payload. Throws `SessionEventError`; returns a fresh object in declared key order. */
export function parseCheckpointPayload(value: unknown): CheckpointPayload {
	const rec = gate(value);
	assertKeys(
		rec,
		"",
		["action", "ckpt_id", "seq", "trigger", "git_tree", "manifest_sha256", "file_count", "skipped_count"],
		["git_base_commit", "branch", "transcript_ref", "chain_head", "plan_ref", "prev_ckpt_id", "taken_at_ms"],
	);
	expectAction(rec, SESSION_CHECKPOINT_ACTION);
	const ckpt_id = ckptIdField(rec["ckpt_id"], "ckpt_id");
	const out: CheckpointPayload = {
		action: SESSION_CHECKPOINT_ACTION,
		ckpt_id,
		seq: parseInteger(rec["seq"], "seq", 1),
		trigger: parseEnum(rec["trigger"], "trigger", CHECKPOINT_TRIGGERS),
		git_tree: gitHexField(rec["git_tree"], "git_tree"),
		...optional(rec, "git_base_commit", "", gitHexField),
		...optional(rec, "branch", "", (v, p) => parseString(v, p, 1, 200)),
		manifest_sha256: sha256Field(rec["manifest_sha256"], "manifest_sha256"),
		file_count: parseInteger(rec["file_count"], "file_count", 0),
		skipped_count: parseInteger(rec["skipped_count"], "skipped_count", 0),
		...optional(rec, "transcript_ref", "", parseTranscriptRef),
		...optional(rec, "chain_head", "", parseChainHead),
		...optional(rec, "plan_ref", "", parsePlanRef),
		...optional(rec, "prev_ckpt_id", "", ckptIdField),
		...optional(rec, "taken_at_ms", "", (v, p) => parseInteger(v, p, 0)),
	};
	if (out.prev_ckpt_id === ckpt_id) {
		throw new SessionEventError("format", "prev_ckpt_id", "must differ from ckpt_id");
	}
	return out;
}

/** Validate a `session.rollback` payload. Throws `SessionEventError`; returns a fresh object in declared key order. */
export function parseRollbackPayload(value: unknown): RollbackPayload {
	const rec = gate(value);
	assertKeys(
		rec,
		"",
		[
			"action",
			"rollback_id",
			"from_ckpt_id",
			"to_ckpt_id",
			"target_event_id",
			"target_hash",
			"pre_restore_tree",
			"pre_restore_ckpt_id",
			"files_added",
			"files_modified",
			"files_deleted",
			"memory",
			"transcript",
		],
		[],
	);
	expectAction(rec, SESSION_ROLLBACK_ACTION);
	const memory = asRecord(rec["memory"], "memory");
	assertKeys(memory, "memory", ["superseded_entries", "forgotten_documents"], []);
	return {
		action: SESSION_ROLLBACK_ACTION,
		rollback_id: rollbackIdField(rec["rollback_id"], "rollback_id"),
		from_ckpt_id: ckptIdField(rec["from_ckpt_id"], "from_ckpt_id"),
		to_ckpt_id: ckptIdField(rec["to_ckpt_id"], "to_ckpt_id"),
		target_event_id: parseOpaqueId(rec["target_event_id"], "target_event_id", 64),
		target_hash: sha256Field(rec["target_hash"], "target_hash"),
		pre_restore_tree: gitHexField(rec["pre_restore_tree"], "pre_restore_tree"),
		pre_restore_ckpt_id: ckptIdField(rec["pre_restore_ckpt_id"], "pre_restore_ckpt_id"),
		files_added: parseInteger(rec["files_added"], "files_added", 0),
		files_modified: parseInteger(rec["files_modified"], "files_modified", 0),
		files_deleted: parseInteger(rec["files_deleted"], "files_deleted", 0),
		memory: {
			superseded_entries: parseInteger(memory["superseded_entries"], "memory.superseded_entries", 0),
			forgotten_documents: parseInteger(memory["forgotten_documents"], "memory.forgotten_documents", 0),
		},
		transcript: parseEnum(rec["transcript"], "transcript", ROLLBACK_TRANSCRIPT_OUTCOMES),
	};
}

/** Validate a `session.rollback.refused` payload. Throws `SessionEventError`; returns a fresh object in declared key order. */
export function parseRefusedPayload(value: unknown): RefusedPayload {
	const rec = gate(value);
	assertKeys(rec, "", ["action", "reason"], ["to_ckpt_id", "detail"]);
	expectAction(rec, SESSION_ROLLBACK_REFUSED_ACTION);
	return {
		action: SESSION_ROLLBACK_REFUSED_ACTION,
		reason: parseEnum(rec["reason"], "reason", ROLLBACK_REFUSAL_REASONS),
		...optional(rec, "to_ckpt_id", "", ckptIdField),
		...optional(rec, "detail", "", (v, p) => parseString(v, p, 1, 300)),
	};
}

/**
 * Validate any of the three payloads by its `action`. A payload read back from the ledger carries the
 * reserved `_ik` as its last key when it was written under an idempotency mode; pass `stored: true` to
 * drop it. A writer's payload never carries it (the ledger strips it), so it stays refused by default.
 */
export function parseSessionEventPayload(value: unknown, options: { stored?: boolean } = {}): SessionEventPayload {
	let rec = asRecord(value, "payload");
	if (options.stored && Object.hasOwn(rec, "_ik")) {
		const { _ik: _dropped, ...rest } = rec;
		rec = rest;
	}
	switch (rec["action"]) {
		case SESSION_CHECKPOINT_ACTION:
			return parseCheckpointPayload(rec);
		case SESSION_ROLLBACK_ACTION:
			return parseRollbackPayload(rec);
		case SESSION_ROLLBACK_REFUSED_ACTION:
			return parseRefusedPayload(rec);
		default:
			throw new SessionEventError(
				"enum",
				"action",
				`must be one of: ${SESSION_CHECKPOINT_ACTION}, ${SESSION_ROLLBACK_ACTION}, ${SESSION_ROLLBACK_REFUSED_ACTION}`,
			);
	}
}

// ---------------------------------------------------------------------------
// Ids and idempotency keys
// ---------------------------------------------------------------------------

/** Random bytes source, injected so ids are deterministic in tests. Production passes `crypto.getRandomValues`. */
export type RandomBytes = (length: number) => Uint8Array;

/** 32 symbols of 0-9 a-z (no i, l, o, u), so five bits map to one symbol with no modulo bias. */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 26;

function randomToken(randomBytes: RandomBytes): string {
	const bytes = randomBytes(ID_LENGTH);
	if (!(bytes instanceof Uint8Array) || bytes.length < ID_LENGTH) {
		throw new SessionEventError("type", "randomBytes", `must return at least ${ID_LENGTH} bytes`);
	}
	let token = "";
	for (let i = 0; i < ID_LENGTH; i++) token += ID_ALPHABET.charAt((bytes[i] ?? 0) & 31);
	return token;
}

/** `ckpt_` plus 26 characters of 0-9 a-z, from the injected random bytes. */
export function newCheckpointId(randomBytes: RandomBytes): string {
	return `ckpt_${randomToken(randomBytes)}`;
}

/** `rb_` plus 26 characters of 0-9 a-z, from the injected random bytes. */
export function newRollbackId(randomBytes: RandomBytes): string {
	return `rb_${randomToken(randomBytes)}`;
}

const RAW_SESSION_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A session id as an idempotency-key segment. A session id that already fits the key alphabet (no colon) and
 * 64 characters is used as `s.<id>`; any other is `h.<first 16 hex of its sha256>`. The two prefixes differ in
 * their first character, so a raw id can never collide with a hashed one.
 */
function sessionToken(sessionId: string): string {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new SessionEventError("missing", "sessionId", "must be a non-empty string");
	}
	if (RAW_SESSION_TOKEN.test(sessionId)) return `s.${sessionId}`;
	return `h.${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function assertKey(key: string): string {
	// Unreachable by construction (every segment is validated above); kept so a future edit cannot emit a key the ledger would refuse.
	if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
		throw new SessionEventError("format", "idempotency_key", `${key} does not match the ledger key pattern`);
	}
	return key;
}

/** `ckpt:<session token>:<seq>`. Replays of the same checkpoint (same session, same seq) share it. */
export function checkpointIdempotencyKey(sessionId: string, seq: number): string {
	const token = sessionToken(sessionId);
	parseInteger(seq, "seq", 1);
	return assertKey(`ckpt:${token}:${seq}`);
}

/** `rb:<session token>:<rollback id>`. Replays of the same rollback share it. */
export function rollbackIdempotencyKey(sessionId: string, rollbackId: string): string {
	const token = sessionToken(sessionId);
	rollbackIdField(rollbackId, "rollback_id");
	return assertKey(`rb:${token}:${rollbackId}`);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a `session.checkpoint` event. `fields` is the payload without `action`. The summary is a fixed
 * shape over validated tokens, never caller free text.
 */
export function buildCheckpointEvent(sessionId: string, fields: Omit<CheckpointPayload, "action">): SessionEventDraft<CheckpointPayload> {
	const payload = parseCheckpointPayload({ ...fields, action: SESSION_CHECKPOINT_ACTION });
	return {
		kind: "note",
		summary: `session checkpoint ${payload.ckpt_id} #${payload.seq} (${payload.trigger})`,
		payload,
		idempotency_key: checkpointIdempotencyKey(sessionId, payload.seq),
	};
}

/** Build a `session.rollback` event. A rollback is a new event pointing at an earlier one; nothing is mutated. */
export function buildRollbackEvent(sessionId: string, fields: Omit<RollbackPayload, "action">): SessionEventDraft<RollbackPayload> {
	const payload = parseRollbackPayload({ ...fields, action: SESSION_ROLLBACK_ACTION });
	return {
		kind: "note",
		summary: `session rollback ${payload.rollback_id}: ${payload.from_ckpt_id} -> ${payload.to_ckpt_id}`,
		payload,
		idempotency_key: rollbackIdempotencyKey(sessionId, payload.rollback_id),
	};
}

/** Build a `session.rollback.refused` warning. It carries no idempotency key: a repeated refusal is a new fact. */
export function buildRollbackRefusedEvent(fields: Omit<RefusedPayload, "action">): SessionEventDraft<RefusedPayload> {
	const payload = parseRefusedPayload({ ...fields, action: SESSION_ROLLBACK_REFUSED_ACTION });
	return {
		kind: "warning",
		summary: `session rollback refused: ${payload.reason}${payload.to_ckpt_id ? ` (${payload.to_ckpt_id})` : ""}`,
		payload,
	};
}
