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

/**
 * Validate, redact and chain an incoming event.
 *
 * Redaction happens here rather than in each collector's own code path: a
 * collector may forget, but nothing reaches storage without passing through
 * this. Every free-text field is redacted, not just the summary — a branch name
 * or a session id is agent-supplied too, and there is no second chance once a
 * row is in an append-only log.
 */
export function normalizeEvent(input: EventInput, prev: string | null): SubstrateEvent {
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
		session_id: clean(input.session_id, MAX_FIELD),
		graph_id: clean(input.graph_id, MAX_FIELD),
		node_id: clean(input.node_id, MAX_FIELD),
		linear_identifier: clean(input.linear_identifier, MAX_FIELD),
		// A fractional or infinite step would reach a BIGINT column.
		step: typeof input.step === "number" && Number.isFinite(input.step) ? Math.trunc(input.step) : null,
		repo: clean(input.repo, MAX_FIELD),
		branch: clean(input.branch, MAX_FIELD),
		actor: input.actor === "human" ? "human" : "agent",
		kind: input.kind,
		summary: clean(input.summary, MAX_SUMMARY) ?? "",
		payload: normalizePayload(input.payload),
		prev,
	};

	return { ...unhashed, hash: eventHash(unhashed) };
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
