/**
 * Event normalisation and the hash chain.
 *
 * Phase 6 anchors hourly Merkle roots to Solana devnet, but the chain has to be
 * correct from the first event written — you cannot retrofit integrity onto an
 * append-only log. So `hash` and `prev` are computed here, on ingest, from day one.
 */
import { randomUUID } from "node:crypto";
import { redact, redactValue } from "./redact.ts";
import { EVENT_KINDS, SURFACES, type EventInput, type SubstrateEvent } from "./types.ts";

/**
 * Deterministic JSON: object keys sorted recursively, so two encoders agree.
 * Arrays keep their order — it is meaningful.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
	return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

/**
 * Hash every field except `hash` itself — `prev` included, which is what binds
 * the chain. Omitting `prev` from the digest would let events be reordered
 * without detection.
 */
export function eventHash(event: Omit<SubstrateEvent, "hash">): string {
	return sha256Hex(canonicalJson(event));
}

function isSurface(value: string): value is SubstrateEvent["surface"] {
	return (SURFACES as readonly string[]).includes(value);
}

function isKind(value: string): value is SubstrateEvent["kind"] {
	return (EVENT_KINDS as readonly string[]).includes(value);
}

export class InvalidEventError extends Error {}

/**
 * Idempotent replay (U5-4a). The contract is `docs/greptime-ledger.md` § Idempotent replay.
 *
 * A key is 8-128 characters of `[A-Za-z0-9._:-]`. The alphabet is the reason the ledger lookup can
 * embed it in a `LIKE` pattern without quoting trouble: no quote, backslash or `%` can appear.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** The reserved payload key a stored idempotency key lives under. Callers can never set it: it is stripped first. */
export const IDEMPOTENCY_PAYLOAD_KEY = "_ik";

/** A replay stamped further than this past the server's clock is refused: a client clock that far ahead is a bug, not a late replay. */
export const REPLAY_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * The closed set of rule names an idempotency refusal carries, so a client (and the replay
 * counter) can tell them apart without parsing prose. The message never quotes the caller's
 * value: an invalid key is arbitrary text.
 */
export const IDEMPOTENCY_RULES = ["idempotency_key_type", "idempotency_key_format", "replay_ts_missing", "replay_ts_future"] as const;
export type IdempotencyRule = (typeof IDEMPOTENCY_RULES)[number];

/** A 400 on the idempotency rules. Still an `InvalidEventError`, so every existing 400 path handles it. */
export class IdempotencyRefusal extends InvalidEventError {
	constructor(
		readonly rule: IdempotencyRule,
		detail: string,
	) {
		super(`${rule}: ${detail}`);
	}
}

/**
 * The key a request carries: `null` when it carries none (`undefined` or JSON `null`), the key when
 * it is well formed, a refusal otherwise. Only called when the mode is not `off`.
 */
export function checkIdempotencyKey(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string") throw new IdempotencyRefusal("idempotency_key_type", "idempotency_key must be a string");
	if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
		throw new IdempotencyRefusal("idempotency_key_format", "idempotency_key must be 8-128 characters from A-Z a-z 0-9 . _ : -");
	}
	return raw;
}

/**
 * The `ts` rules of a replay-marked request. Only called when the mode is not `off` and the request
 * is marked.
 *
 * A keyed replay MUST carry the original attempt's `ts`: the lookup matches the exact normalised
 * `ts`, and `normalizeEvent` would stamp a missing one with the server's clock, so such a replay
 * could never match and would append a duplicate while looking like a normal miss. Missing is
 * whatever `normalizeEvent` treats as absent (any falsy `ts`). A marker without a key has nothing to
 * match, so it is held only to the future bound.
 *
 * The future bound reads `ts` the way `normalizeEvent` does for the two types a client sends — a
 * string or a JSON number, both through `new Date(ts)` — so a numeric far-future `ts` cannot slip
 * past it. Other types and unparseable values pass here: they are the ordinary `invalid ts`
 * refusal `normalizeEvent` raises.
 */
export function checkReplayTs(ts: unknown, now: number, keyed: boolean): void {
	if (!ts) {
		if (keyed) throw new IdempotencyRefusal("replay_ts_missing", "a replay must carry the original attempt's ts");
		return;
	}
	if (typeof ts !== "string" && typeof ts !== "number") return;
	const at = new Date(ts).getTime();
	if (Number.isNaN(at)) return;
	if (at > now + REPLAY_MAX_FUTURE_MS) {
		throw new IdempotencyRefusal("replay_ts_future", "a replay's ts may not be more than 24 hours in the future");
	}
}

/** What `normalizeEvent` needs when the idempotency mode is not `off`: the validated key, or `null` for none. */
export interface EventIdempotency {
	key: string | null;
}

/**
 * Caps on a single event, so one runaway collector cannot flood a log that
 * nothing will ever compact or delete.
 */
const MAX_SUMMARY = 2000;
const MAX_FIELD = 512;
const MAX_PAYLOAD_STRING = 4000;
const MAX_PAYLOAD_BYTES = 16_000;

/**
 * Redact, then cap, then treat empty as absent.
 *
 * The order matters: truncating first could cut a token in half so that its own
 * pattern no longer matches, and the fragment would be stored. An empty result
 * becomes `null` so the column is NULL rather than an empty string, which the
 * brief's filters would otherwise treat as a value.
 */
function clean(value: string | null | undefined, limit: number): string | null {
	if (value === undefined || value === null) return null;
	const redacted = redact(value).slice(0, limit);
	return redacted.length > 0 ? redacted : null;
}

/**
 * Normalise an identifier the same way `normalizeEvent` stores it.
 *
 * `session_id`, `graph_id` and `repo` are query keys as well as stored values —
 * `emit` looks up the previous hash by session, `verifyGraph` reads by graph, the
 * brief reads by repo. Cleaning them on the write path but querying with the raw
 * value would mean a lookup that never matches: every event would restart its
 * session's chain, and verification would find no rows at all. Anything that
 * reads by one of these columns goes through here, so the two agree by
 * construction rather than by both remembering to.
 */
export function normalizeIdentifier(value: string | null | undefined): string | null {
	return clean(value, MAX_FIELD);
}

/** Cap every string inside a JSON-shaped value. */
function capStrings(value: unknown, limit: number): unknown {
	if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value;
	if (Array.isArray(value)) return value.map((inner) => capStrings(inner, limit));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			out[key] = capStrings(inner, limit);
		}
		return out;
	}
	return value;
}

/**
 * Redact the payload, cap each string in it, then cap the whole thing.
 *
 * A collector that attaches a full diff or a command's entire stdout writes it
 * into a log nothing can ever reclaim. Per-string capping keeps the useful keys
 * intact; if the result is still oversized the payload is replaced outright,
 * because a silently half-written object reads as complete and a marker does not.
 */
function normalizePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
	const capped = capStrings(redactValue(payload ?? {}), MAX_PAYLOAD_STRING) as Record<string, unknown>;
	const bytes = Buffer.byteLength(JSON.stringify(capped) ?? "{}");
	if (bytes <= MAX_PAYLOAD_BYTES) return capped;
	return { _dropped: `payload exceeded ${MAX_PAYLOAD_BYTES} bytes`, _bytes: bytes };
}

/** A caller's payload without the reserved `_ik`. Anything that is not a plain object is left for `normalizePayload` as it always was. */
function withoutReservedKey(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
	if (!Object.hasOwn(payload, IDEMPOTENCY_PAYLOAD_KEY)) return payload;
	const { [IDEMPOTENCY_PAYLOAD_KEY]: _ignored, ...rest } = payload;
	return rest;
}

/**
 * The stored payload. Under `off` (`idempotency` absent) this is `normalizePayload` and nothing
 * else, byte for byte. Otherwise a caller-supplied `_ik` is stripped first and never trusted, and
 * a valid key is added AFTER the payload is redacted and capped: it is server-validated text from a
 * 128-character alphabet, so redaction has nothing to find, and a payload replaced for its size
 * (`_dropped`) must still carry the key or its replay would append a second row. It is always the
 * LAST key, which is what lets the ledger lookup anchor its pattern at the end of the stored text
 * and so never match a nested `_ik` a caller buried in the payload. It adds at most ~140 bytes
 * beyond the payload cap.
 */
function normalizedPayload(input: EventInput, idempotency: EventIdempotency | undefined): Record<string, unknown> {
	if (idempotency === undefined) return normalizePayload(input.payload);
	const payload = normalizePayload(withoutReservedKey(input.payload));
	if (idempotency.key === null) return payload;
	// A scalar or array payload is wrong on the wire but stored today as given; spreading it would scramble it.
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { _payload: payload, [IDEMPOTENCY_PAYLOAD_KEY]: idempotency.key };
	return { ...payload, [IDEMPOTENCY_PAYLOAD_KEY]: idempotency.key };
}

/**
 * Validate, redact and chain an incoming event.
 *
 * Redaction happens here rather than in each collector's own code path: a
 * collector may forget, but nothing reaches storage without passing through
 * this. Every free-text field is redacted, not just the summary — a branch name
 * or a session id is agent-supplied too, and there is no second chance once a
 * row is in an append-only log.
 */
export function normalizeEvent(input: EventInput, prev: string | null, idempotency?: EventIdempotency): SubstrateEvent {
	if (!input || typeof input !== "object") throw new InvalidEventError("event must be an object");
	if (typeof input.surface !== "string" || !isSurface(input.surface)) {
		throw new InvalidEventError(`unknown surface: ${String(input.surface)}`);
	}
	if (typeof input.kind !== "string" || !isKind(input.kind)) {
		throw new InvalidEventError(`unknown kind: ${String(input.kind)}`);
	}
	if (typeof input.summary !== "string" || input.summary.length === 0) {
		throw new InvalidEventError("summary is required");
	}

	const ts = input.ts ? new Date(input.ts) : new Date();
	if (Number.isNaN(ts.getTime())) throw new InvalidEventError(`invalid ts: ${String(input.ts)}`);

	const unhashed: Omit<SubstrateEvent, "hash"> = {
		id: `evt_${randomUUID().replace(/-/g, "")}`,
		ts: ts.toISOString(),
		surface: input.surface,
		session_id: normalizeIdentifier(input.session_id),
		graph_id: normalizeIdentifier(input.graph_id),
		node_id: normalizeIdentifier(input.node_id),
		linear_identifier: normalizeIdentifier(input.linear_identifier),
		// A fractional or infinite step would reach a BIGINT column.
		step: typeof input.step === "number" && Number.isFinite(input.step) ? Math.trunc(input.step) : null,
		repo: normalizeIdentifier(input.repo),
		branch: clean(input.branch, MAX_FIELD),
		actor: input.actor === "human" ? "human" : "agent",
		kind: input.kind,
		summary: clean(input.summary, MAX_SUMMARY) ?? "",
		payload: normalizedPayload(input, idempotency),
		prev,
	};

	return { ...unhashed, hash: eventHash(unhashed) };
}

/**
 * Put a session's events in chain order before verifying them.
 *
 * `ORDER BY "ts"` cannot do this on its own. `agent_events` is in append_mode, so
 * two events may share a millisecond and Greptime is free to return them in
 * either order — and `verifyChain` would then report a break in a chain that is
 * perfectly intact. `prev` carries the order the timestamp lost, so follow it.
 *
 * This does not weaken what verification catches. `verifyChain` recomputes every
 * hash, so tampering is still detected; an event spliced out leaves the events
 * after it unreachable from the walk, and they are appended unlinked so the
 * `prev` mismatch is still reported. A fork — two events claiming the same `prev`,
 * which concurrent appends in one session can still produce — likewise leaves one
 * branch unlinked and is reported. What it stops reporting is a database's
 * arbitrary tie-break, which was never an integrity property.
 */
export function inChainOrder(events: SubstrateEvent[]): SubstrateEvent[] {
	if (events.length < 2) return events;

	const next = new Map<string | null, SubstrateEvent>();
	for (const event of events) if (!next.has(event.prev)) next.set(event.prev, event);
	const present = new Set(events.map((event) => event.hash));

	// The chain starts at the event with no predecessor, or — when the rows do not
	// reach back that far — at the one whose predecessor is not among them.
	const start =
		events.find((event) => event.prev === null) ?? events.find((event) => !present.has(event.prev ?? ""));
	if (!start) return events; // every event is claimed: a cycle, for verifyChain to report

	const ordered: SubstrateEvent[] = [];
	const seen = new Set<string>();
	let current: SubstrateEvent | undefined = start;
	while (current && !seen.has(current.hash)) {
		ordered.push(current);
		seen.add(current.hash);
		current = next.get(current.hash);
	}
	// Whatever did not link in is a real break. Keep it, so it is reported rather
	// than quietly dropped from the count.
	for (const event of events) if (!seen.has(event.hash)) ordered.push(event);
	return ordered;
}

/**
 * Recompute a chain and report the first event that does not verify.
 * Used by `substrate verify <graph_id>`.
 */
export function verifyChain(events: SubstrateEvent[]): { ok: true } | { ok: false; brokenAt: string; reason: string } {
	let expectedPrev: string | null = null;
	for (const event of events) {
		const { hash, ...rest } = event;
		const recomputed = eventHash(rest);
		if (recomputed !== hash) {
			return { ok: false, brokenAt: event.id, reason: "hash does not match contents" };
		}
		if (expectedPrev !== null && event.prev !== expectedPrev) {
			return { ok: false, brokenAt: event.id, reason: "prev does not match the preceding event" };
		}
		expectedPrev = hash;
	}
	return { ok: true };
}
