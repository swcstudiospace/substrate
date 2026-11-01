/**
 * Event normalisation and the hash chain.
 *
 * Phase 6 anchors hourly Merkle roots to Solana devnet, but the chain has to be
 * correct from the first event written — you cannot retrofit integrity onto an
 * append-only log. So `hash` and `prev` are computed here, on ingest, from day one.
 */
import { randomUUID } from "node:crypto";
import { merkleRootHex, type GraphHeadRecord } from "@substrate/ledger";
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
export const MAX_PAYLOAD_BYTES = 16_000;

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
export function inChainOrder<T extends { hash: string; prev: string | null }>(events: T[]): T[] {
	if (events.length < 2) return events;

	const next = new Map<string | null, T>();
	for (const event of events) if (!next.has(event.prev)) next.set(event.prev, event);
	const present = new Set(events.map((event) => event.hash));

	// The chain starts at the event with no predecessor, or — when the rows do not
	// reach back that far — at the one whose predecessor is not among them.
	const start =
		events.find((event) => event.prev === null) ?? events.find((event) => !present.has(event.prev ?? ""));
	if (!start) return events; // every event is claimed: a cycle, for verifyChain to report

	const ordered: T[] = [];
	const seen = new Set<string>();
	let current: T | undefined = start;
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

/** One stored chain leaf of an hour, as `graph_chain_leaves` holds it (D73-02). */
export interface StoredLeaf {
	graph_id: string;
	session_id: string;
	seq: number;
	event_id: string;
	hash: string;
}

/** What a ledger row contributes to a chain walk: its id, the hash its content gives, the hash its row stores, and its predecessor. */
export interface ChainLink {
	id: string;
	hash: string;
	storedHash: string;
	prev: string | null;
}

const HASH_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * The commitment one chain position contributes to the leaves root: the SHA-256 of the JSON `[event_id, hash]`. Committing to the id as
 * well as the hash means a stored `event_id` cannot change without changing the root (D73-02). `buildGraphHeads` uses the same function.
 */
export function chainLeafCommitment(eventId: string, hash: string): string {
	return sha256Hex(JSON.stringify([eventId, hash]));
}

/**
 * The leaves in seq order. The table is append-only with no key, so exact duplicates collapse. Two rows that disagree about one
 * seq, an event id that is not a non-empty string, a hash that is not 64 lowercase hex, or seqs that are not 0 … n-1 make the
 * stored chain invalid: null.
 */
export function orderedLeaves(leaves: readonly StoredLeaf[]): StoredLeaf[] | null {
	const bySeq = new Map<number, StoredLeaf>();
	for (const leaf of leaves) {
		if (typeof leaf.event_id !== "string" || leaf.event_id === "") return null;
		if (!HASH_HEX_RE.test(leaf.hash)) return null;
		const prior = bySeq.get(leaf.seq);
		if (prior === undefined) bySeq.set(leaf.seq, leaf);
		else if (prior.event_id !== leaf.event_id || prior.hash !== leaf.hash) return null;
	}
	const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	return ordered.every((leaf, i) => leaf.seq === i) ? ordered : null;
}

/**
 * The head record each (graph, session) pair's stored leaves give for one hour (D73-01), or null when any pair's leaves do not form
 * one chain. The records come out in input order; `headsRoot` sorts them.
 */
export function headRecordsFromLeaves(leaves: readonly StoredLeaf[], periodStartMs: number): GraphHeadRecord[] | null {
	const pairs = new Map<string, { graphId: string; sessionId: string; leaves: StoredLeaf[] }>();
	for (const leaf of leaves) {
		const key = JSON.stringify([leaf.graph_id, leaf.session_id]);
		const pair = pairs.get(key);
		if (pair) pair.leaves.push(leaf);
		else pairs.set(key, { graphId: leaf.graph_id, sessionId: leaf.session_id, leaves: [leaf] });
	}
	const records: GraphHeadRecord[] = [];
	for (const pair of pairs.values()) {
		const ordered = orderedLeaves(pair.leaves);
		const last = ordered?.at(-1);
		if (ordered === null || last === undefined || pair.graphId === "") return null;
		records.push({
			graphId: pair.graphId,
			sessionId: pair.sessionId,
			periodStartMs,
			count: ordered.length,
			leavesRootHex: merkleRootHex(ordered.map((leaf) => chainLeafCommitment(leaf.event_id, leaf.hash))),
			headEventId: last.event_id,
			headHashHex: last.hash,
		});
	}
	return records;
}

/** Where one (graph, session) pair's chain stands against its anchored leaves (D73-03). */
export type HeadComparison =
	| { ok: true }
	| { ok: false; kind: "stored-leaves-mismatch"; reason: string }
	| { ok: false; kind: "first-differing"; eventId: string }
	| { ok: false; kind: "first-missing"; eventId: string };

/**
 * D73-03 for one pair. `events` are the pair's ledger rows for the hour: `hash` is each one's recomputed content hash, `storedHash` the
 * hash its row holds. `leaves` are its stored leaves and `head` the anchored head. The stored leaves must reproduce the head first.
 * Then the committed order is walked: a leaf whose event is absent is first-missing; a leaf whose event's recomputed hash or stored
 * hash differs from the leaf hash is first-differing. Events the leaves do not name come after the chain's end, and the first of them,
 * in chain order, is first-differing too.
 */
export function compareToAnchoredHead(events: readonly ChainLink[], leaves: readonly StoredLeaf[], head: GraphHeadRecord): HeadComparison {
	const stored = orderedLeaves(leaves);
	const last = stored?.at(-1);
	if (
		stored === null ||
		last === undefined ||
		stored.length !== head.count ||
		merkleRootHex(stored.map((leaf) => chainLeafCommitment(leaf.event_id, leaf.hash))) !== head.leavesRootHex ||
		last.event_id !== head.headEventId ||
		last.hash !== head.headHashHex
	) {
		return { ok: false, kind: "stored-leaves-mismatch", reason: "the stored leaves do not reproduce the anchored head" };
	}
	const byId = new Map<string, ChainLink>();
	for (const event of events) {
		// Two rows under one id: the ledger holds an event the anchored chain does not.
		if (byId.has(event.id)) return { ok: false, kind: "first-differing", eventId: event.id };
		byId.set(event.id, event);
	}
	for (const leaf of stored) {
		const event = byId.get(leaf.event_id);
		if (event === undefined) return { ok: false, kind: "first-missing", eventId: leaf.event_id };
		if (event.hash !== leaf.hash || event.storedHash !== leaf.hash) return { ok: false, kind: "first-differing", eventId: leaf.event_id };
	}
	const committed = new Set(stored.map((leaf) => leaf.event_id));
	const extras = events.filter((event) => !committed.has(event.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const extra = inChainOrder(extras)[0];
	return extra === undefined ? { ok: true } : { ok: false, kind: "first-differing", eventId: extra.id };
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

/**
 * Live steering sessions (SPE-19390): planning updates propagate to open
 * sessions without blocking them. A session lives in one of four states;
 * the transition table keeps a stale writer from resurrecting a paused
 * session or skipping the refresh a planning change requires. States ride
 * on existing event kinds (`note`/`warning`) as payload — never a new
 * kind — so the hash chain and every existing reader are untouched.
 */
export type SteeringSessionState = "ACTIVE" | "CONTEXT_REFRESH" | "PAUSED" | "RESUMED";

/** The closed set of steering states an MCP or REST caller may name. */
export const STEERING_STATES: readonly SteeringSessionState[] = ["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"];

/** A live steering session: which repo it steers, where it stands, and what changed. */
export interface SteeringSession {
	session_id: string;
	repo_id: string;
	state: SteeringSessionState;
	planning_hash?: string;
	steering?: string;
	updated_at: string;
}

/** Whether `next` may follow `current`. Unknown states never transition. */
export function steeringStateTransition(current: SteeringSessionState, next: SteeringSessionState): boolean {
	if (current === next) return true;
	switch (current) {
		case "ACTIVE":
			return next === "CONTEXT_REFRESH" || next === "PAUSED";
		case "CONTEXT_REFRESH":
			return next === "ACTIVE" || next === "PAUSED";
		case "PAUSED":
			return next === "RESUMED";
		case "RESUMED":
			return next === "ACTIVE" || next === "PAUSED";
		default:
			return false;
	}
}

/**
 * A `owner/name` slug namespaced for multi-repo steering. Lowercased and
 * trimmed; anything else scopes to the empty (unscoped) repo rather than
 * throwing, so a bad caller degrades instead of failing the turn.
 */
export function scopeRepoId(repo: string | null | undefined): string {
	if (typeof repo !== "string") return "";
	const scoped = repo.trim().toLowerCase();
	return /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(scoped) ? scoped : "";
}

/** The `repo:`-prefixed scope one dataset or session is served under. */
export function repoScopePrefix(repoId: string): string {
	const scoped = scopeRepoId(repoId);
	return scoped === "" ? "" : `repo:${scoped}:`;
}

/**
 * The non-blocking context payload a steering transition carries on its
 * event: the action, the repo scope, both states and — on a planning
 * trigger — the old and new planning hashes. Emitting it never throws;
 * callers that cannot read it ignore unknown payload keys as before.
 */
export function steeringSessionPayload(session: SteeringSession, previous?: SteeringSessionState): Record<string, unknown> {
	return {
		action: "docs.steering",
		repo_id: session.repo_id,
		session_id: session.session_id,
		state: session.state,
		...(previous !== undefined ? { previous_state: previous } : {}),
		...(session.planning_hash !== undefined ? { planning_hash: session.planning_hash } : {}),
		...(session.steering !== undefined ? { steering: session.steering.slice(0, 2000) } : {}),
		non_blocking: true,
	};
}

/**
 * Build the next session record for a transition, or the reason it is
 * refused. Pure: the caller stores the session and emits the payload.
 */
export function nextSteeringSession(
	current: SteeringSession | null,
	input: { session_id: string; repo_id: string; state: SteeringSessionState; planning_hash?: string; steering?: string },
	nowMs: number = Date.now(),
): { ok: true; session: SteeringSession; previous?: SteeringSessionState } | { ok: false; reason: string } {
	const repoId = scopeRepoId(input.repo_id);
	if (repoId === "") return { ok: false, reason: "repo_id must be owner/name" };
	if (input.session_id.trim().length === 0) return { ok: false, reason: "session_id is required" };
	if (current !== null && current.session_id !== input.session_id) return { ok: false, reason: "session_id mismatch" };
	const previous = current?.state;
	if (previous !== undefined && !steeringStateTransition(previous, input.state)) {
		return { ok: false, reason: `steering transition ${previous} -> ${input.state} refused` };
	}
	return {
		ok: true,
		session: {
			session_id: input.session_id,
			repo_id: repoId,
			state: input.state,
			...(input.planning_hash !== undefined ? { planning_hash: input.planning_hash } : {}),
			...(input.steering !== undefined ? { steering: input.steering } : {}),
			updated_at: new Date(nowMs).toISOString(),
		},
		...(previous !== undefined ? { previous } : {}),
	};
}

/**
 * Live steering for the docs plane: a planning change re-ingests the
 * planning roots, nothing else.
 *
 * There is no `planning.updated` event kind — `EVENT_KINDS` is closed, and
 * the steering sessions above already ride `note`/`warning` payloads for
 * the same reason. Instead the trigger reads the paths an event already
 * carries: file edits name them, commits list them, notes quote them. Only
 * `.planning/` paths trigger, and the trigger names only the planning
 * roots, so a mixed change never re-ingests the full corpus ("planning
 * only update").
 *
 * Pure: the service maps a triggered result to a targeted `ingestDocs`
 * call over `roots` with pages swept from `paths`. The `log` writes the
 * one observable line per trigger, so the refresh is visible in the log
 * — or in a test — without running the ingest.
 */
export const PLANNING_INGEST_ROOTS: readonly string[] = [".planning/"];

/** What a planning change asks the docs plane to re-ingest. */
export interface PlanningIngestTrigger {
	triggered: boolean;
	roots: readonly string[];
	paths: string[];
	reason: string;
}

/** Payload keys that name changed paths on the existing event kinds. */
const PLANNING_PATH_KEYS: Record<string, true> = { path: true, real_path: true, paths: true, files: true, file: true };

/** A repo-relative `.planning/` path, or null for anything else. */
function cleanPlanningPath(value: string): string | null {
	const trimmed = value.trim().replace(/^\/+/, "").replace(/^\.\/+/, "");
	if (trimmed.startsWith(".planning/")) return trimmed;
	// Absolute checkouts end in the repo path; only the suffix matters.
	const at = trimmed.indexOf("/.planning/");
	if (at === -1) return null;
	return trimmed.slice(at + 1);
}

function collectPlanningPaths(payload: Record<string, unknown>, into: string[]): void {
	const seen = new Set<string>();
	const take = (value: unknown): void => {
		if (typeof value === "string") {
			const clean = cleanPlanningPath(value);
			if (clean !== null && !seen.has(clean)) {
				seen.add(clean);
				into.push(clean);
			}
		} else if (Array.isArray(value)) {
			for (const entry of value) take(entry);
		}
	};
	for (const [key, value] of Object.entries(payload)) {
		if (PLANNING_PATH_KEYS[key] === true) take(value);
		else if (typeof value === "string" && value.includes(".planning/")) take(value);
		else if (Array.isArray(value)) {
			for (const entry of value) if (typeof entry === "string" && entry.includes(".planning/")) take(entry);
		}
	}
}

/** The `.planning/` paths an event's payload names, deduplicated in order. */
export function planningPathsOf(input: Pick<EventInput, "payload">): string[] {
	const paths: string[] = [];
	if (input.payload !== undefined) collectPlanningPaths(input.payload, paths);
	return paths;
}

/** Whether an event names any planning path — the `planning.updated` signal, without a new kind. */
export function isPlanningUpdate(input: Pick<EventInput, "payload">): boolean {
	return planningPathsOf(input).length > 0;
}

/** The targeted re-ingest a planning change asks for; logs the one observable line when triggered. */
export function planningIngestTrigger(
	input: Pick<EventInput, "kind" | "summary" | "payload">,
	log: (line: string) => void = (line) => process.stderr.write(line),
): PlanningIngestTrigger {
	const paths = planningPathsOf(input);
	if (paths.length === 0) return { triggered: false, roots: [], paths: [], reason: "no-planning-paths" };
	const reason = `planning-paths:${paths.length}`;
	log(`[substrate] planning update (${input.kind}): re-ingesting ${paths.length} page(s) under .planning/\n`);
	return { triggered: true, roots: PLANNING_INGEST_ROOTS, paths, reason };
}
