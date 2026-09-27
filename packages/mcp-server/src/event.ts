/**
 * Event normalisation and the hash chain.
 *
 * Phase 6 anchors hourly Merkle roots to Solana devnet, but the chain has to be
 * correct from the first event written — you cannot retrofit integrity onto an
 * append-only log. So `hash` and `prev` are computed here, on ingest, from day one.
 */
import { randomUUID } from "node:crypto";
import { redact, redactValue } from "./redact.ts";
import {
	EVENT_KINDS,
	SURFACES,
	type Actor,
	type EventInput,
	type EventKind,
	type SubstrateEvent,
	type Surface,
} from "./types.ts";

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

/** Cap on a single summary, so one runaway collector cannot flood the log. */
const MAX_SUMMARY = 2000;

/**
 * Validate, redact and chain an incoming event.
 *
 * Redaction happens here rather than in each collector's own code path: a
 * collector may forget, but nothing reaches storage without passing through this.
 *
 * `ingestedAt` (ISO) is given by the ingest chain from the Phase 6 cutover on: it becomes the
 * hashed `ingested_at` and the default `ts`. Without it the event has no `ingested_at` key at
 * all and hashes exactly as before the cutover. The stored object is built field by field, so
 * an input that also carries `id`, `hash`, `prev` or `ingested_at` cannot set them.
 */
export function normalizeEvent(input: EventInput, prev: string | null, ingestedAt?: string): SubstrateEvent {
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

	const ingested = ingestedAt === undefined ? undefined : new Date(ingestedAt);
	if (ingested && Number.isNaN(ingested.getTime())) throw new Error(`invalid ingestedAt: ${ingestedAt}`);
	const ts = input.ts ? new Date(input.ts) : (ingested ?? new Date());
	if (Number.isNaN(ts.getTime())) throw new InvalidEventError(`invalid ts: ${String(input.ts)}`);

	const unhashed: Omit<SubstrateEvent, "hash"> = {
		id: `evt_${randomUUID().replace(/-/g, "")}`,
		ts: ts.toISOString(),
		surface: input.surface,
		session_id: input.session_id ?? null,
		graph_id: input.graph_id ?? null,
		node_id: input.node_id ?? null,
		linear_identifier: input.linear_identifier ?? null,
		step: typeof input.step === "number" ? input.step : null,
		repo: input.repo ?? null,
		branch: input.branch ?? null,
		actor: input.actor === "human" ? "human" : "agent",
		kind: input.kind,
		summary: redact(input.summary).slice(0, MAX_SUMMARY),
		payload: redactValue(input.payload ?? {}),
		prev,
	};
	if (ingested) unhashed.ingested_at = ingested.toISOString();

	return { ...unhashed, hash: eventHash(unhashed) };
}

/**
 * Greptime gives back loosely typed rows; rebuild the exact shape that was hashed.
 *
 * `ingested_at` is set only when the column is non-null. A pre-cutover row reads NULL there and
 * must hash without the key — `"ingested_at": null` would change every historical digest.
 */
export function rowToEvent(row: Record<string, unknown>): SubstrateEvent {
	const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
	let payload: Record<string, unknown> = {};
	try {
		payload = row.payload ? (JSON.parse(String(row.payload)) as Record<string, unknown>) : {};
	} catch {
		payload = {};
	}
	const event: SubstrateEvent = {
		id: String(row.id),
		// The chain hashed ISO strings; Greptime returns epoch millis.
		ts: new Date(Number(row.ts)).toISOString(),
		surface: String(row.surface) as Surface,
		session_id: text(row.session_id),
		graph_id: text(row.graph_id),
		node_id: text(row.node_id),
		linear_identifier: text(row.linear_identifier),
		step: row.step === null || row.step === undefined ? null : Number(row.step),
		repo: text(row.repo),
		branch: text(row.branch),
		actor: String(row.actor) as Actor,
		kind: String(row.kind) as EventKind,
		summary: String(row.summary),
		payload,
		hash: String(row.hash),
		prev: text(row.prev),
	};
	if (row.ingested_at !== null && row.ingested_at !== undefined) {
		event.ingested_at = new Date(Number(row.ingested_at)).toISOString();
	}
	return event;
}

export type ChainResult = { ok: true } | { ok: false; brokenAt: string; reason: string };

/**
 * Recompute a per-session chain and report the first event that does not verify. The first
 * event's `prev` is not checked: before the cutover a session's chain has no fixed start.
 */
export function verifyChain(events: SubstrateEvent[]): ChainResult {
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
 * Pre-cutover rows: `prev` chains within a session, so events are grouped by session (null
 * sessions together) and each group is checked in the order given. Interleaving two sessions
 * into one sequence would report a break that is not there.
 */
export function verifySessions(events: SubstrateEvent[]): ChainResult {
	const bySession = new Map<string, SubstrateEvent[]>();
	for (const event of events) {
		const key = event.session_id ?? "";
		const bucket = bySession.get(key);
		if (bucket) bucket.push(event);
		else bySession.set(key, [event]);
	}
	for (const group of bySession.values()) {
		const result = verifyChain(group);
		if (!result.ok) return result;
	}
	return { ok: true };
}

/**
 * Post-cutover rows: one global chain in ingest order. `events` is a contiguous stretch of it
 * (a whole ingest hour, ordered by ingested_at, id) and `boundaryPrev` the hash of the event
 * ingested just before the stretch — null when the stretch starts at the genesis.
 *
 * A consistent rewrite (content changed, every hash and prev recomputed in order) passes here;
 * only an external anchor of the stretch could catch that.
 */
export function verifyGlobalChain(events: SubstrateEvent[], boundaryPrev: string | null): ChainResult {
	const earlier = new Set<string>();
	let expectedPrev = boundaryPrev;
	for (const event of events) {
		const { hash, ...rest } = event;
		if (eventHash(rest) !== hash) {
			return { ok: false, brokenAt: event.id, reason: "hash does not match contents" };
		}
		if (event.prev !== expectedPrev) {
			const reason =
				event.prev === null
					? "chain reset: null prev after genesis"
					: earlier.has(event.prev)
						? "fork: prev names an earlier event (ambiguous insert timeout)"
						: "prev does not match the preceding event";
			return { ok: false, brokenAt: event.id, reason };
		}
		earlier.add(hash);
		expectedPrev = hash;
	}
	return { ok: true };
}
