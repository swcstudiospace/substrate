/**
 * The anchor signer set (v1.6, phase 59): which public keys may sign an hourly anchor, and over which
 * window of time. A signer rotation must not invalidate the anchors an earlier key wrote, so a key is
 * accepted by the BLOCK TIME of the anchor transaction, never by "is it the current key".
 *
 * Pure by construction: no I/O, no clock, no environment, no network. Public keys only; this module
 * never sees, stores or logs key material (a keypair path or secret is not representable here).
 *
 * Windows are half-open: a key signs at block time `t` when `valid_from_ms <= t < valid_until_ms`
 * (`valid_until_ms: null` is open-ended).
 *
 * Rotations travel as ledger events (`kind: note`, `payload.action: "anchor.signer.rotate"`).
 * `signerSetFromRotationEvents` folds them over a bootstrap set. The ledger is writable by any
 * authenticated caller, so a rotation event is only ever honoured when the caller supplies an
 * `authorize` predicate that says it came from an operator: the derivation fails closed without it.
 */
import { bs58decode } from "./rpc.ts";

export const SIGNER_SET_MAX_ENTRIES = 16;
export const ANCHOR_SIGNER_ROTATE_ACTION = "anchor.signer.rotate";
/** A rotation may be recorded after the fact (the operator rotates, then writes the event), but not by more than this. */
export const ROTATION_MAX_BACKDATE_MS = 24 * 3_600_000;
/** A rotation may be scheduled ahead, but not by more than this. */
export const ROTATION_MAX_FUTURE_MS = 30 * 24 * 3_600_000;

const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects C0 control characters and DEL in untrusted signer-set labels
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

type SignerSetRule =
	| "not_json"
	| "not_array"
	| "not_object"
	| "unknown_key"
	| "missing"
	| "type"
	| "format"
	| "range"
	| "too_many"
	| "overlap"
	| "enum";

/** A signer set or rotation payload that breaks a rule. `path` names the field, `rule` the rule broken. */
export class SignerSetError extends Error {
	override name = "SignerSetError";
	readonly rule: SignerSetRule;
	readonly path: string;
	constructor(rule: SignerSetRule, path: string, message: string) {
		super(`${path}: ${message}`);
		this.rule = rule;
		this.path = path;
	}
}

interface SignerEntry {
	/** Base58 ed25519 public key (32 bytes). */
	pubkey: string;
	/** Inclusive start of the window, epoch ms. */
	valid_from_ms: number;
	/** Exclusive end of the window, epoch ms; null = still valid. */
	valid_until_ms: number | null;
	label?: string;
}

export type SignerSet = readonly SignerEntry[];

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** True for a base58 string that decodes to exactly 32 bytes (a Solana public key). */
export function isBase58Pubkey(text: unknown): text is string {
	if (typeof text !== "string" || !BASE58_PUBKEY_RE.test(text)) return false;
	return bs58decode(text).length === 32;
}

function pubkeyField(value: unknown, path: string): string {
	if (typeof value !== "string") throw new SignerSetError("type", path, "must be a string");
	if (!isBase58Pubkey(value)) throw new SignerSetError("format", path, "must be a base58 public key that decodes to 32 bytes");
	return value;
}

function msField(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SignerSetError("type", path, "must be an integer (epoch milliseconds)");
	if (value < 0) throw new SignerSetError("range", path, "must not be negative");
	return value;
}

function labelField(value: unknown, path: string): string {
	if (typeof value !== "string") throw new SignerSetError("type", path, "must be a string");
	if (value.length < 1 || value.length > 64) throw new SignerSetError("range", path, "must be 1..64 characters");
	if (CONTROL_CHARS.test(value)) throw new SignerSetError("format", path, "must not contain control characters");
	return value;
}

function assertKeys(rec: Rec, path: string, required: readonly string[], optional: readonly string[]): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(rec)) {
		if (!allowed.has(key)) throw new SignerSetError("unknown_key", path === "" ? key : `${path}.${key}`, "is not an allowed key");
	}
	for (const key of required) {
		if (rec[key] === undefined) throw new SignerSetError("missing", path === "" ? key : `${path}.${key}`, "is required");
	}
}

function windowsOverlap(a: SignerEntry, b: SignerEntry): boolean {
	return a.valid_from_ms < (b.valid_until_ms ?? Number.POSITIVE_INFINITY) && b.valid_from_ms < (a.valid_until_ms ?? Number.POSITIVE_INFINITY);
}

function compareEntries(a: SignerEntry, b: SignerEntry): number {
	if (a.valid_from_ms !== b.valid_from_ms) return a.valid_from_ms - b.valid_from_ms;
	return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
}

/**
 * The set rules, applied to entries that already have the right shape: at most 16 entries, each
 * window well ordered, and no two windows of the SAME key overlapping (a key may reappear only after
 * its earlier window closed; two identical entries therefore overlap and are rejected). Returns a
 * fresh array sorted by (valid_from_ms, pubkey), so the same entries always give the same set.
 */
function validateEntries(entries: readonly SignerEntry[]): SignerEntry[] {
	if (entries.length > SIGNER_SET_MAX_ENTRIES) {
		throw new SignerSetError("too_many", "", `has ${entries.length} entries; at most ${SIGNER_SET_MAX_ENTRIES} are allowed`);
	}
	for (const [i, entry] of entries.entries()) {
		if (entry.valid_until_ms !== null && entry.valid_until_ms <= entry.valid_from_ms) {
			throw new SignerSetError("range", `[${i}].valid_until_ms`, "must be greater than valid_from_ms");
		}
	}
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i] as SignerEntry;
			const b = entries[j] as SignerEntry;
			if (a.pubkey === b.pubkey && windowsOverlap(a, b)) {
				throw new SignerSetError("overlap", `[${j}].pubkey`, `key ${b.pubkey} has overlapping validity windows (entries ${i} and ${j})`);
			}
		}
	}
	return entries.map((entry) => ({ ...entry })).sort(compareEntries);
}

/**
 * Parse and validate a signer set from JSON text or an already parsed value. Strict: an array of
 * `{ pubkey, valid_from_ms, valid_until_ms, label? }`, no other keys, at most 16 entries, no
 * overlapping windows for one key. Throws `SignerSetError`; nothing is trusted from the input.
 */
export function parseSignerSet(json: unknown): SignerSet {
	let value = json;
	if (typeof json === "string") {
		try {
			value = JSON.parse(json);
		} catch {
			throw new SignerSetError("not_json", "", "is not valid JSON");
		}
	}
	if (!Array.isArray(value)) throw new SignerSetError("not_array", "", "must be a JSON array of signer entries");
	if (value.length > SIGNER_SET_MAX_ENTRIES) {
		throw new SignerSetError("too_many", "", `has ${value.length} entries; at most ${SIGNER_SET_MAX_ENTRIES} are allowed`);
	}
	const entries = value.map((raw: unknown, i): SignerEntry => {
		const path = `[${i}]`;
		if (!isPlainObject(raw)) throw new SignerSetError("not_object", path, "must be a JSON object");
		assertKeys(raw, path, ["pubkey", "valid_from_ms", "valid_until_ms"], ["label"]);
		const until = raw["valid_until_ms"];
		return {
			pubkey: pubkeyField(raw["pubkey"], `${path}.pubkey`),
			valid_from_ms: msField(raw["valid_from_ms"], `${path}.valid_from_ms`),
			valid_until_ms: until === null ? null : msField(until, `${path}.valid_until_ms`),
			...(raw["label"] === undefined ? {} : { label: labelField(raw["label"], `${path}.label`) }),
		};
	});
	return validateEntries(entries);
}

type SignerAcceptance = { ok: true; entry: SignerEntry } | { ok: false; reason: string };

/** Is `pubkey` a valid anchor signer at `blockTimeMs` (the anchor transaction's block time)? */
export function acceptsSigner(set: SignerSet, pubkey: string, blockTimeMs: number): SignerAcceptance {
	if (!isBase58Pubkey(pubkey)) return { ok: false, reason: "signer is not a valid base58 public key" };
	if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs < 0) {
		return { ok: false, reason: "block time is not a non-negative integer, so no signer window can apply" };
	}
	const known = set.filter((entry) => entry.pubkey === pubkey);
	if (known.length === 0) return { ok: false, reason: `signer ${pubkey} is not in the signer set` };
	const hit = known.find((entry) => entry.valid_from_ms <= blockTimeMs && (entry.valid_until_ms === null || blockTimeMs < entry.valid_until_ms));
	if (hit) return { ok: true, entry: hit };
	const windows = known.map((entry) => `[${new Date(entry.valid_from_ms).toISOString()}, ${entry.valid_until_ms === null ? "open" : new Date(entry.valid_until_ms).toISOString()})`);
	return {
		ok: false,
		reason: `signer ${pubkey} signed at ${new Date(blockTimeMs).toISOString()}, outside its valid window ${windows.join(" and ")}`,
	};
}

// ---------------------------------------------------------------------------
// Rotation events (`anchor.signer.rotate`)
// ---------------------------------------------------------------------------

interface RotationPayload {
	action: typeof ANCHOR_SIGNER_ROTATE_ACTION;
	/** The key being retired from `effective_from_ms`; absent when a key is only added. */
	old_pubkey?: string;
	new_pubkey: string;
	effective_from_ms: number;
	reason: string;
}

/**
 * Validate a rotation payload. Throws `SignerSetError`; returns a fresh object in declared key order.
 * A payload read back from the ledger carries the reserved `_ik` key when it was written under an
 * idempotency mode; pass `stored: true` to drop it. A writer's payload never carries it.
 */
export function parseRotationPayload(input: unknown, options: { stored?: boolean } = {}): RotationPayload {
	let value = input;
	if (options.stored && isPlainObject(value) && Object.hasOwn(value, "_ik")) {
		const { _ik: _dropped, ...rest } = value;
		value = rest;
	}
	if (!isPlainObject(value)) throw new SignerSetError("not_object", "payload", "must be a JSON object");
	assertKeys(value, "", ["action", "new_pubkey", "effective_from_ms", "reason"], ["old_pubkey"]);
	if (value["action"] !== ANCHOR_SIGNER_ROTATE_ACTION) {
		throw new SignerSetError("enum", "action", `must be "${ANCHOR_SIGNER_ROTATE_ACTION}"`);
	}
	const reason = value["reason"];
	if (typeof reason !== "string") throw new SignerSetError("type", "reason", "must be a string");
	if (reason.length < 1 || reason.length > 200) throw new SignerSetError("range", "reason", "must be 1..200 characters");
	if (CONTROL_CHARS.test(reason)) throw new SignerSetError("format", "reason", "must not contain control characters");
	const new_pubkey = pubkeyField(value["new_pubkey"], "new_pubkey");
	const old = value["old_pubkey"] === undefined ? undefined : pubkeyField(value["old_pubkey"], "old_pubkey");
	if (old === new_pubkey) throw new SignerSetError("format", "old_pubkey", "must differ from new_pubkey");
	return {
		action: ANCHOR_SIGNER_ROTATE_ACTION,
		...(old === undefined ? {} : { old_pubkey: old }),
		new_pubkey,
		effective_from_ms: msField(value["effective_from_ms"], "effective_from_ms"),
		reason,
	};
}

/** The part of an `EventInput` this contract owns; `surface`, `session_id` and `ts` stay the caller's. */
interface SignerRotateEventDraft {
	kind: "note";
	summary: string;
	payload: RotationPayload;
	/** Stable per (new key, effective time): a replay of the same rotation is the same fact. */
	idempotency_key: string;
}

/** Build the `anchor.signer.rotate` event draft from a validated payload. Throws `SignerSetError`. */
export function buildSignerRotateEvent(input: Omit<RotationPayload, "action">): SignerRotateEventDraft {
	const payload = parseRotationPayload({ action: ANCHOR_SIGNER_ROTATE_ACTION, ...input });
	const effective = new Date(payload.effective_from_ms).toISOString();
	return {
		kind: "note",
		summary: `anchor signer rotation: ${payload.new_pubkey} from ${effective}`,
		payload,
		idempotency_key: `anchor-rotate:${payload.new_pubkey}:${payload.effective_from_ms}`,
	};
}

/** A ledger event as the derivation reads it: id, the substrate's own timestamp, its surface and payload. */
export interface RotationEventInput {
	event_id: string;
	/** The event's `ts` in epoch ms; bounds how far its `effective_from_ms` may sit from it. */
	ts_ms: number;
	surface?: string;
	payload: unknown;
}

type RotationIssueReason =
	| "unauthorized"
	| "invalid-event"
	| "invalid-payload"
	| "effective-time-out-of-bounds"
	| "duplicate-event-id"
	| "old-key-not-valid"
	| "new-key-overlaps"
	| "set-full";

interface RotationIssue {
	event_id: string;
	reason: RotationIssueReason;
	detail: string;
}

interface DerivedSignerSet {
	set: SignerSet;
	/** Rotation event ids folded into the set, in the order they were applied. */
	applied: string[];
	/** Every event that was ignored, ordered by (reason, event_id), so the report is deterministic too. */
	issues: RotationIssue[];
}

interface RotationOptions {
	/**
	 * REQUIRED. True only for an event an operator wrote. The ledger accepts events from any
	 * authenticated caller, so an unauthorised rotation would let an attacker's key sign anchors;
	 * there is no default and no way to skip it.
	 */
	authorize: (event: RotationEventInput) => boolean;
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The effective signer set: `bootstrap` plus every valid, authorised `anchor.signer.rotate` event.
 *
 * Deterministic whatever order `events` arrive in: valid rotations are applied sorted by
 * (`effective_from_ms`, `event_id`, canonical payload) and a repeated event id is applied once.
 * A rotation that names `old_pubkey` closes that key's window at `effective_from_ms` (the key must be
 * valid at that instant) and opens `new_pubkey` from the same instant, so there is no gap and no
 * overlap. Without `old_pubkey` the new key is added and nothing is retired. An event that cannot be
 * applied is ignored and reported in `issues`, never silently dropped and never thrown.
 */
export function signerSetFromRotationEvents(
	bootstrap: SignerSet,
	events: readonly RotationEventInput[],
	options: RotationOptions,
): DerivedSignerSet {
	if (typeof options?.authorize !== "function") {
		throw new TypeError("signerSetFromRotationEvents: options.authorize is required (rotation events are only honoured from an operator)");
	}
	const issues: RotationIssue[] = [];
	let entries: SignerEntry[] = validateEntries(bootstrap);

	type Candidate = { event: RotationEventInput; payload: RotationPayload; canonical: string };
	const candidates: Candidate[] = [];
	for (const event of events) {
		if (typeof event?.event_id !== "string" || !EVENT_ID_RE.test(event.event_id) || !Number.isSafeInteger(event.ts_ms) || event.ts_ms < 0) {
			issues.push({ event_id: typeof event?.event_id === "string" ? event.event_id.slice(0, 128) : "(no id)", reason: "invalid-event", detail: "needs an event_id of 1..128 [A-Za-z0-9._:-] and an integer ts_ms" });
			continue;
		}
		if (options.authorize(event) !== true) {
			issues.push({ event_id: event.event_id, reason: "unauthorized", detail: "the event was not written by an authorised operator" });
			continue;
		}
		let payload: RotationPayload;
		try {
			payload = parseRotationPayload(event.payload, { stored: true });
		} catch (cause) {
			issues.push({ event_id: event.event_id, reason: "invalid-payload", detail: cause instanceof Error ? cause.message : String(cause) });
			continue;
		}
		if (payload.effective_from_ms < event.ts_ms - ROTATION_MAX_BACKDATE_MS || payload.effective_from_ms > event.ts_ms + ROTATION_MAX_FUTURE_MS) {
			issues.push({
				event_id: event.event_id,
				reason: "effective-time-out-of-bounds",
				detail: `effective_from_ms must lie within ${ROTATION_MAX_BACKDATE_MS} ms before and ${ROTATION_MAX_FUTURE_MS} ms after the event's own time`,
			});
			continue;
		}
		candidates.push({ event, payload, canonical: JSON.stringify(payload) });
	}

	candidates.sort(
		(a, b) => a.payload.effective_from_ms - b.payload.effective_from_ms || cmp(a.event.event_id, b.event.event_id) || cmp(a.canonical, b.canonical),
	);

	const applied: string[] = [];
	const seen = new Set<string>();
	for (const { event, payload } of candidates) {
		if (seen.has(event.event_id)) {
			issues.push({ event_id: event.event_id, reason: "duplicate-event-id", detail: "an event with this id was already applied or considered" });
			continue;
		}
		seen.add(event.event_id);
		const at = payload.effective_from_ms;
		const next = entries.map((entry) => ({ ...entry }));
		if (payload.old_pubkey !== undefined) {
			const oldKey = next.find(
				(entry) => entry.pubkey === payload.old_pubkey && entry.valid_from_ms <= at && (entry.valid_until_ms === null || entry.valid_until_ms > at),
			);
			if (!oldKey) {
				issues.push({ event_id: event.event_id, reason: "old-key-not-valid", detail: `${payload.old_pubkey} is not a valid signer at ${new Date(at).toISOString()}` });
				continue;
			}
			if (oldKey.valid_from_ms >= at) {
				issues.push({ event_id: event.event_id, reason: "old-key-not-valid", detail: `${payload.old_pubkey} would get an empty window; rotate at a later time` });
				continue;
			}
			oldKey.valid_until_ms = at;
		}
		const created: SignerEntry = { pubkey: payload.new_pubkey, valid_from_ms: at, valid_until_ms: null };
		if (next.some((entry) => entry.pubkey === created.pubkey && windowsOverlap(entry, created))) {
			issues.push({ event_id: event.event_id, reason: "new-key-overlaps", detail: `${payload.new_pubkey} is already valid from ${new Date(at).toISOString()} onward` });
			continue;
		}
		if (next.length + 1 > SIGNER_SET_MAX_ENTRIES) {
			issues.push({ event_id: event.event_id, reason: "set-full", detail: `the set already holds ${SIGNER_SET_MAX_ENTRIES} entries` });
			continue;
		}
		next.push(created);
		entries = validateEntries(next);
		applied.push(event.event_id);
	}

	issues.sort((a, b) => cmp(a.reason, b.reason) || cmp(a.event_id, b.event_id) || cmp(a.detail, b.detail));
	return { set: entries, applied, issues };
}
