/**
 * Deterministic memory capsules (v1.6, phase 60).
 *
 * A capsule is a portable, verifiable export of governed memory records. Its bytes are:
 *
 *   line 1      the manifest, canonical JSON
 *   lines 2..n  one record per line, canonical JSON, sorted by `id`
 *
 * Every line ends in `\n`. "Canonical" is `canonicalJson` from `event.ts` (sorted keys, no whitespace), so
 * the bytes depend on the records and the injected clock and on nothing else: not the input order, not
 * object insertion order, not the machine.
 *
 * The manifest binds the file three ways:
 * - `records_sha256`: SHA-256 of every byte after the manifest line. Any edit to any record changes it.
 * - `root_digest`: the RFC 6962 Merkle root (`@substrate/ledger`) over the records' CONTENT HASHES (the
 *   gate's `entry_hash`), in id order. It does not cover the record bodies directly, so redacting a body
 *   leaves it unchanged and the capsule stays verifiable.
 * - the capsule `digest` (SHA-256 of all bytes), which a `memory.capsule.export` ledger note records.
 *
 * What the hashes do NOT do: the manifest is not signed. Anyone who can rewrite the whole file can reseal
 * `records_sha256`, and provenance fields (writer, trust, source event, timestamps) are covered by that
 * digest only, not by the root. The defence is the ledger: the export note carries the digest, and the
 * ledger is anchored. A capsule is checked against a digest taken from the ledger, not from itself.
 *
 * Redaction replaces a record with `{ id, content_hash, tombstone }`. The hash stays so the root still
 * verifies; everything else about the record, content and provenance alike, is removed. A hash of
 * low-entropy content can confirm a guess, which is a limit of keeping the hash (see the nexus ADR).
 *
 * Pure: no I/O, no clock of its own (`now` is a parameter), no randomness.
 */
import { bytesToHex, hexToBytes, merkleRoot } from "@substrate/ledger";
import { canonicalJson } from "./event.ts";
import { matchEntryHash, type CapsuleRecord, type NexusContent, type TombstoneRecord } from "./memory-record.ts";
import { isMemoryKind } from "./memory-policy.ts";
import { ACTORS, TRUST_LEVELS, type Actor, type EventInput, type EventKind, type Trust } from "./types.ts";

export const CAPSULE_VERSION = 1;
export const CAPSULE_SCHEMA = "substrate.memory.capsule/1";
/** Largest capsule `importCapsule` and `tombstoneCapsule` will read. */
export const MAX_CAPSULE_BYTES = 64 * 1024 * 1024;
export const MAX_CAPSULE_RECORDS = 100_000;

export const CAPSULE_EXPORT_ACTION = "memory.capsule.export";
export const CAPSULE_REDACT_ACTION = "memory.capsule.redact";

export type CapsuleRule =
	| "not_object"
	| "unknown_key"
	| "missing"
	| "type"
	| "format"
	| "range"
	| "too_long"
	| "enum"
	| "empty"
	| "too_large"
	| "duplicate_id"
	| "unknown_id"
	| "bad_utf8"
	| "bad_json"
	| "not_canonical"
	| "order"
	| "manifest"
	| "count_mismatch"
	| "records_digest_mismatch"
	| "record_hash_mismatch"
	| "root_mismatch";

/** A capsule or capsule-event contract violation. `path` names the field, `rule` the rule broken. */
export class CapsuleError extends Error {
	readonly rule: CapsuleRule;
	readonly path: string;
	constructor(rule: CapsuleRule, path: string, message: string) {
		super(path === "" ? message : `${path}: ${message}`);
		this.name = "CapsuleError";
		this.rule = rule;
		this.path = path;
	}
}

export type CapsuleEntry = CapsuleRecord | TombstoneRecord;

export interface CapsuleManifest {
	capsule_version: typeof CAPSULE_VERSION;
	schema: typeof CAPSULE_SCHEMA;
	producer: string;
	/** ISO, from the injected clock at export. Unchanged by redaction. */
	created_at: string;
	count: number;
	records_sha256: string;
	root_digest: string;
}

export interface CapsuleOutput {
	manifest: CapsuleManifest;
	bytes: Uint8Array;
	/** SHA-256 hex of `bytes`. */
	digest: string;
}

export interface ImportedCapsule {
	manifest: CapsuleManifest;
	records: CapsuleEntry[];
	digest: string;
}

export type ImportResult = { ok: true; capsule: ImportedCapsule } | { ok: false; error: CapsuleError };

export interface ExportOptions {
	/** Who produced the capsule, for instance `substrate-mcp`. */
	producer: string;
	/** The injected clock. */
	now: () => Date;
}

// ---------------------------------------------------------------------------
// Primitive rules
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PRODUCER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@ -]{0,79}$/;
/** A reason is a short label, not prose: it lands in a tombstone and in a ledger note, and must not carry content. */
const REASON_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_FIELD = 200;
const MAX_SCOPE = 500;
const MAX_SUBJECT = 2000;
const MAX_TEXT = 20_000;

type Rec = Record<string, unknown>;

function asRecord(value: unknown, path: string): Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CapsuleError("not_object", path, "must be a JSON object");
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new CapsuleError("not_object", path, "must be a plain JSON object");
	return value as Rec;
}

function assertKeys(rec: Rec, path: string, keys: readonly string[]): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(rec)) {
		if (!allowed.has(key)) throw new CapsuleError("unknown_key", join(path, key), `unknown key; allowed: ${keys.join(", ")}`);
	}
	for (const key of keys) {
		if (!(key in rec) || rec[key] === undefined) throw new CapsuleError("missing", join(path, key), "is required");
	}
}

function join(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

function text(value: unknown, path: string, min: number, max: number): string {
	if (typeof value !== "string") throw new CapsuleError("type", path, "must be a string");
	if (value.length < min) throw new CapsuleError("range", path, `must be at least ${min} character${min === 1 ? "" : "s"}`);
	if (value.length > max) throw new CapsuleError("too_long", path, `must be at most ${max} characters`);
	return value;
}

function nullableText(value: unknown, path: string, max: number): string | null {
	return value === null ? null : text(value, path, 1, max);
}

function pattern(value: unknown, path: string, re: RegExp, what: string): string {
	const s = text(value, path, 1, 300);
	if (!re.test(s)) throw new CapsuleError("format", path, `must be ${what}`);
	return s;
}

function integer(value: unknown, path: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CapsuleError("type", path, "must be an integer");
	if (value < min || value > max) throw new CapsuleError("range", path, `must be between ${min} and ${max}`);
	return value;
}

function isoTime(value: unknown, path: string): string {
	const s = pattern(value, path, ISO_RE, "an ISO-8601 UTC timestamp ending in Z");
	if (Number.isNaN(Date.parse(s))) throw new CapsuleError("format", path, "is not a real timestamp");
	return s;
}

function idField(value: unknown, path: string): string {
	return pattern(value, path, ID_RE, "an id of 1-200 letters, digits, '.', '_', ':' or '-'");
}

function hexField(value: unknown, path: string): string {
	return pattern(value, path, HEX_64, "64 lowercase hex characters");
}

function reasonField(value: unknown, path: string): string {
	return pattern(value, path, REASON_RE, "a short label of letters, digits, space and . _ : / - (at most 120 characters), never prose or content");
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new CapsuleError("enum", path, `must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function isTombstone(entry: CapsuleEntry): entry is TombstoneRecord {
	return "tombstone" in entry;
}

const RECORD_KEYS = ["id", "content_hash", "version", "supersedes", "superseded_by", "forgotten_by", "state", "provenance", "content"] as const;
const PROVENANCE_KEYS = ["writer", "actor", "trust", "source_event", "session_id", "graph_id", "repo", "created"] as const;
const CONTENT_KEYS = ["scope", "kind", "subject", "text"] as const;
const TOMBSTONE_KEYS = ["id", "content_hash", "tombstone"] as const;

/**
 * Validate one capsule line's value and return a fresh object in declared key order. A full record's content
 * is rehashed against its `content_hash` here, so a record that does not hash to its own name never gets in.
 */
export function parseCapsuleRecord(value: unknown, path = "record"): CapsuleEntry {
	const rec = asRecord(value, path);
	if ("tombstone" in rec) {
		assertKeys(rec, path, TOMBSTONE_KEYS);
		const tomb = asRecord(rec["tombstone"], join(path, "tombstone"));
		assertKeys(tomb, join(path, "tombstone"), ["reason", "at"]);
		return {
			id: idField(rec["id"], join(path, "id")),
			content_hash: hexField(rec["content_hash"], join(path, "content_hash")),
			tombstone: { reason: reasonField(tomb["reason"], join(path, "tombstone.reason")), at: isoTime(tomb["at"], join(path, "tombstone.at")) },
		};
	}
	assertKeys(rec, path, RECORD_KEYS);
	const provenanceRec = asRecord(rec["provenance"], join(path, "provenance"));
	assertKeys(provenanceRec, join(path, "provenance"), PROVENANCE_KEYS);
	const contentRec = asRecord(rec["content"], join(path, "content"));
	assertKeys(contentRec, join(path, "content"), CONTENT_KEYS);

	const state = oneOf(rec["state"], join(path, "state"), ["current", "superseded"] as const);
	const supersededBy = rec["superseded_by"] === null ? null : idField(rec["superseded_by"], join(path, "superseded_by"));
	if ((state === "current") !== (supersededBy === null)) {
		throw new CapsuleError("format", join(path, "state"), "a current record has no superseded_by and a superseded one has one");
	}
	if (rec["forgotten_by"] !== null) {
		throw new CapsuleError("format", join(path, "forgotten_by"), "a forgotten entry is exported as a tombstone, never with content");
	}
	const kind = contentRec["kind"];
	if (!isMemoryKind(kind)) throw new CapsuleError("enum", join(path, "content.kind"), "is not a memory kind");
	const content: NexusContent = {
		scope: text(contentRec["scope"], join(path, "content.scope"), 1, MAX_SCOPE),
		kind,
		subject: nullableText(contentRec["subject"], join(path, "content.subject"), MAX_SUBJECT),
		text: text(contentRec["text"], join(path, "content.text"), 0, MAX_TEXT),
	};
	const provenance = {
		writer: text(provenanceRec["writer"], join(path, "provenance.writer"), 1, MAX_FIELD),
		actor: oneOf<Actor>(provenanceRec["actor"], join(path, "provenance.actor"), ACTORS),
		trust: oneOf<Trust>(provenanceRec["trust"], join(path, "provenance.trust"), TRUST_LEVELS),
		source_event: nullableText(provenanceRec["source_event"], join(path, "provenance.source_event"), MAX_FIELD),
		session_id: nullableText(provenanceRec["session_id"], join(path, "provenance.session_id"), MAX_FIELD),
		graph_id: nullableText(provenanceRec["graph_id"], join(path, "provenance.graph_id"), MAX_FIELD),
		repo: nullableText(provenanceRec["repo"], join(path, "provenance.repo"), MAX_FIELD),
		created: text(provenanceRec["created"], join(path, "provenance.created"), 1, 64),
	};
	const contentHash = hexField(rec["content_hash"], join(path, "content_hash"));
	if (matchEntryHash(content, provenance.writer, contentHash) === null) {
		throw new CapsuleError("record_hash_mismatch", join(path, "content_hash"), "the record's content does not hash to its content_hash");
	}
	return {
		id: idField(rec["id"], join(path, "id")),
		content_hash: contentHash,
		version: integer(rec["version"], join(path, "version"), 1, 1_000_000),
		supersedes: rec["supersedes"] === null ? null : idField(rec["supersedes"], join(path, "supersedes")),
		superseded_by: supersededBy,
		forgotten_by: null,
		state,
		provenance,
		content,
	};
}

// ---------------------------------------------------------------------------
// Build and read
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function compareIds(a: CapsuleEntry, b: CapsuleEntry): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The Merkle root over the content hashes of `entries`, in the order given. Never empty (the caller checked). */
function rootOf(entries: readonly CapsuleEntry[]): string {
	return bytesToHex(merkleRoot(entries.map((entry) => hexToBytes(entry.content_hash))));
}

/** SHA-256 hex of capsule bytes: the `digest` a capsule is known by. */
export function sha256Bytes(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function seal(fields: Omit<CapsuleManifest, "records_sha256" | "root_digest">, entries: readonly CapsuleEntry[]): CapsuleOutput {
	const recordsBytes = encoder.encode(`${entries.map((entry) => canonicalJson(entry)).join("\n")}\n`);
	const manifest: CapsuleManifest = { ...fields, records_sha256: sha256Bytes(recordsBytes), root_digest: rootOf(entries) };
	const head = encoder.encode(`${canonicalJson(manifest)}\n`);
	const bytes = new Uint8Array(head.length + recordsBytes.length);
	bytes.set(head, 0);
	bytes.set(recordsBytes, head.length);
	return { manifest, bytes, digest: sha256Bytes(bytes) };
}

/**
 * Export `records` as a capsule. The result is byte-identical for the same records and clock reading,
 * whatever order the records arrive in. Throws `CapsuleError` for an empty set, a duplicate id, a record
 * that is not the documented shape, or a record whose content does not hash to its `content_hash`.
 */
export function exportCapsule(records: readonly CapsuleEntry[], options: ExportOptions): CapsuleOutput {
	if (!Array.isArray(records) || records.length === 0) {
		throw new CapsuleError("empty", "records", "a capsule needs at least one record");
	}
	if (records.length > MAX_CAPSULE_RECORDS) {
		throw new CapsuleError("too_large", "records", `${records.length} records exceeds the ${MAX_CAPSULE_RECORDS} limit`);
	}
	const producer = pattern(options.producer, "producer", PRODUCER_RE, "1-80 characters of letters, digits and . _ : / @ space -");
	const createdAt = options.now().toISOString();
	const entries = records.map((record, i) => parseCapsuleRecord(record, `records[${i}]`)).sort(compareIds);
	for (let i = 1; i < entries.length; i++) {
		const previous = entries[i - 1] as CapsuleEntry;
		const current = entries[i] as CapsuleEntry;
		if (previous.id === current.id) throw new CapsuleError("duplicate_id", "records", `id ${current.id} appears twice`);
	}
	const out = seal({ capsule_version: CAPSULE_VERSION, schema: CAPSULE_SCHEMA, producer, created_at: createdAt, count: entries.length }, entries);
	if (out.bytes.byteLength > MAX_CAPSULE_BYTES) {
		throw new CapsuleError("too_large", "records", `the capsule is ${out.bytes.byteLength} bytes; the limit is ${MAX_CAPSULE_BYTES}`);
	}
	return out;
}

function parseManifest(line: string): CapsuleManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new CapsuleError("bad_json", "manifest", "the first line is not JSON");
	}
	const rec = asRecord(parsed, "manifest");
	assertKeys(rec, "manifest", ["capsule_version", "schema", "producer", "created_at", "count", "records_sha256", "root_digest"]);
	if (rec["capsule_version"] !== CAPSULE_VERSION) throw new CapsuleError("manifest", "manifest.capsule_version", `unsupported capsule version; this reader speaks ${CAPSULE_VERSION}`);
	if (rec["schema"] !== CAPSULE_SCHEMA) throw new CapsuleError("manifest", "manifest.schema", `unsupported schema; this reader speaks ${CAPSULE_SCHEMA}`);
	const manifest: CapsuleManifest = {
		capsule_version: CAPSULE_VERSION,
		schema: CAPSULE_SCHEMA,
		producer: pattern(rec["producer"], "manifest.producer", PRODUCER_RE, "1-80 characters of letters, digits and . _ : / @ space -"),
		created_at: isoTime(rec["created_at"], "manifest.created_at"),
		count: integer(rec["count"], "manifest.count", 1, MAX_CAPSULE_RECORDS),
		records_sha256: hexField(rec["records_sha256"], "manifest.records_sha256"),
		root_digest: hexField(rec["root_digest"], "manifest.root_digest"),
	};
	if (canonicalJson(manifest) !== line) throw new CapsuleError("not_canonical", "manifest", "the manifest line is not in canonical form");
	return manifest;
}

function decode(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CapsuleError("bad_utf8", path, "is not valid UTF-8");
	}
}

function readCapsule(bytes: Uint8Array): ImportedCapsule {
	if (!(bytes instanceof Uint8Array)) throw new CapsuleError("type", "bytes", "must be a Uint8Array");
	if (bytes.byteLength === 0) throw new CapsuleError("empty", "bytes", "the capsule is empty");
	if (bytes.byteLength > MAX_CAPSULE_BYTES) {
		throw new CapsuleError("too_large", "bytes", `${bytes.byteLength} bytes exceeds the ${MAX_CAPSULE_BYTES} limit`);
	}
	const newline = bytes.indexOf(10);
	if (newline < 0) throw new CapsuleError("manifest", "manifest", "the manifest line has no terminating newline");
	const manifest = parseManifest(decode(bytes.subarray(0, newline), "manifest"));

	const recordsBytes = bytes.subarray(newline + 1);
	if (sha256Bytes(recordsBytes) !== manifest.records_sha256) {
		throw new CapsuleError("records_digest_mismatch", "records", "the records do not match manifest.records_sha256: the capsule was edited after it was sealed");
	}
	const body = decode(recordsBytes, "records");
	if (!body.endsWith("\n")) throw new CapsuleError("not_canonical", "records", "the last record line has no terminating newline");
	const lines = body.slice(0, -1).split("\n");
	if (lines.length !== manifest.count) {
		throw new CapsuleError("count_mismatch", "records", `the manifest says ${manifest.count} records and the file has ${lines.length}`);
	}
	const records: CapsuleEntry[] = [];
	for (const [i, line] of lines.entries()) {
		const path = `records[${i}]`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new CapsuleError("bad_json", path, "is not JSON");
		}
		const entry = parseCapsuleRecord(parsed, path);
		if (canonicalJson(entry) !== line) throw new CapsuleError("not_canonical", path, "the line is not in canonical form");
		const previous = records[i - 1];
		if (previous !== undefined && !(previous.id < entry.id)) {
			throw new CapsuleError(previous.id === entry.id ? "duplicate_id" : "order", path, "records must be strictly ascending by id");
		}
		records.push(entry);
	}
	if (rootOf(records) !== manifest.root_digest) {
		throw new CapsuleError("root_mismatch", "manifest.root_digest", "the Merkle root over the content hashes does not match the manifest");
	}
	return { manifest, records, digest: sha256Bytes(bytes) };
}

/**
 * Verify and read a capsule: the manifest, `records_sha256`, the record count, each line's canonical form
 * and shape, id order, every full record's content hash, and the Merkle root. Returns the records or the
 * first typed error; it never throws for bad input.
 */
export function importCapsule(bytes: Uint8Array): ImportResult {
	try {
		return { ok: true, capsule: readCapsule(bytes) };
	} catch (error) {
		if (error instanceof CapsuleError) return { ok: false, error };
		throw error;
	}
}

export interface RedactedCapsule extends CapsuleOutput {
	/** Ids replaced by a tombstone by this call. Ids that were already tombstones are not listed. */
	redacted: string[];
}

/**
 * Redact `ids` from a capsule. Each named record is replaced by `{ id, content_hash, tombstone }`; the
 * manifest keeps `created_at`, `count` and `root_digest`, and `records_sha256` is recomputed. Throws
 * `CapsuleError` when the input is not a valid capsule, an id is not in it, or the reason is not a short
 * label. Redacting an id that is already a tombstone changes nothing, so the call is idempotent.
 */
export function tombstoneCapsule(bytes: Uint8Array, ids: readonly string[], reason: string, now: () => Date): RedactedCapsule {
	const reasonLabel = reasonField(reason, "reason");
	if (!Array.isArray(ids) || ids.length === 0) throw new CapsuleError("empty", "ids", "name at least one record id to redact");
	const wanted = new Set(ids.map((id, i) => idField(id, `ids[${i}]`)));
	const capsule = readCapsule(bytes);
	const known = new Set(capsule.records.map((record) => record.id));
	for (const id of wanted) {
		if (!known.has(id)) throw new CapsuleError("unknown_id", "ids", `record ${id} is not in this capsule`);
	}
	const at = now().toISOString();
	const redacted: string[] = [];
	const entries = capsule.records.map((entry): CapsuleEntry => {
		if (!wanted.has(entry.id) || isTombstone(entry)) return entry;
		redacted.push(entry.id);
		return { id: entry.id, content_hash: entry.content_hash, tombstone: { reason: reasonLabel, at } };
	});
	const { capsule_version, schema, producer, created_at, count } = capsule.manifest;
	const out = seal({ capsule_version, schema, producer, created_at, count }, entries);
	if (out.manifest.root_digest !== capsule.manifest.root_digest) {
		throw new CapsuleError("root_mismatch", "manifest.root_digest", "redaction changed the Merkle root; refusing to emit it");
	}
	return { ...out, redacted };
}

// ---------------------------------------------------------------------------
// Ledger notes
// ---------------------------------------------------------------------------

export interface CapsuleExportPayload {
	action: typeof CAPSULE_EXPORT_ACTION;
	/** SHA-256 of the capsule bytes. */
	digest: string;
	count: number;
	root_digest: string;
	/** Capsule size in bytes. */
	size: number;
}

export interface CapsuleRedactPayload {
	action: typeof CAPSULE_REDACT_ACTION;
	digest_before: string;
	digest_after: string;
	redacted_count: number;
	reason: string;
}

export type CapsuleEventPayload = CapsuleExportPayload | CapsuleRedactPayload;

/** What a builder returns: the part of an `EventInput` this contract owns. `surface`, `session_id` and `ts` stay the caller's. */
export type CapsuleEventDraft<P extends CapsuleEventPayload> = Pick<EventInput, "summary"> & {
	kind: Extract<EventKind, "note">;
	payload: P;
	idempotency_key: string;
};

/** Validate a `memory.capsule.export` payload. Strict: unknown keys are refused, so no content can ride along. */
export function parseCapsuleExportPayload(value: unknown): CapsuleExportPayload {
	const rec = asRecord(value, "payload");
	assertKeys(rec, "payload", ["action", "digest", "count", "root_digest", "size"]);
	if (rec["action"] !== CAPSULE_EXPORT_ACTION) throw new CapsuleError("enum", "action", `must be ${CAPSULE_EXPORT_ACTION}`);
	return {
		action: CAPSULE_EXPORT_ACTION,
		digest: hexField(rec["digest"], "digest"),
		count: integer(rec["count"], "count", 1, MAX_CAPSULE_RECORDS),
		root_digest: hexField(rec["root_digest"], "root_digest"),
		size: integer(rec["size"], "size", 1, MAX_CAPSULE_BYTES),
	};
}

/** Validate a `memory.capsule.redact` payload. Strict, like the export payload. */
export function parseCapsuleRedactPayload(value: unknown): CapsuleRedactPayload {
	const rec = asRecord(value, "payload");
	assertKeys(rec, "payload", ["action", "digest_before", "digest_after", "redacted_count", "reason"]);
	if (rec["action"] !== CAPSULE_REDACT_ACTION) throw new CapsuleError("enum", "action", `must be ${CAPSULE_REDACT_ACTION}`);
	const out: CapsuleRedactPayload = {
		action: CAPSULE_REDACT_ACTION,
		digest_before: hexField(rec["digest_before"], "digest_before"),
		digest_after: hexField(rec["digest_after"], "digest_after"),
		redacted_count: integer(rec["redacted_count"], "redacted_count", 1, MAX_CAPSULE_RECORDS),
		reason: reasonField(rec["reason"], "reason"),
	};
	if (out.digest_before === out.digest_after) {
		throw new CapsuleError("format", "digest_after", "must differ from digest_before: a redaction that changed nothing is not a redaction");
	}
	return out;
}

/** Build the `memory.capsule.export` note. The idempotency key is the capsule digest, so a replayed export dedupes. */
export function buildCapsuleExportEvent(fields: Omit<CapsuleExportPayload, "action">): CapsuleEventDraft<CapsuleExportPayload> {
	const payload = parseCapsuleExportPayload({ ...fields, action: CAPSULE_EXPORT_ACTION });
	return {
		kind: "note",
		summary: `memory capsule exported: ${payload.count} record${payload.count === 1 ? "" : "s"}, digest ${payload.digest.slice(0, 12)}`,
		payload,
		idempotency_key: `mce:${payload.digest}`,
	};
}

/** The export note for a capsule `exportCapsule` just returned. */
export function capsuleExportEvent(output: CapsuleOutput): CapsuleEventDraft<CapsuleExportPayload> {
	return buildCapsuleExportEvent({
		digest: output.digest,
		count: output.manifest.count,
		root_digest: output.manifest.root_digest,
		size: output.bytes.byteLength,
	});
}

/** Build the `memory.capsule.redact` note. The idempotency key joins both digests, so a replay dedupes and a different redaction does not. */
export function buildCapsuleRedactEvent(fields: Omit<CapsuleRedactPayload, "action">): CapsuleEventDraft<CapsuleRedactPayload> {
	const payload = parseCapsuleRedactPayload({ ...fields, action: CAPSULE_REDACT_ACTION });
	return {
		kind: "note",
		summary: `memory capsule redacted: ${payload.redacted_count} record${payload.redacted_count === 1 ? "" : "s"} (${payload.reason})`,
		payload,
		idempotency_key: `mcr:${payload.digest_before.slice(0, 32)}:${payload.digest_after.slice(0, 32)}`,
	};
}

/** The redact note for a `tombstoneCapsule` result, given the digest of the capsule it started from. */
export function capsuleRedactEvent(digestBefore: string, reason: string, result: RedactedCapsule): CapsuleEventDraft<CapsuleRedactPayload> {
	return buildCapsuleRedactEvent({
		digest_before: digestBefore,
		digest_after: result.digest,
		redacted_count: result.redacted.length,
		reason,
	});
}
