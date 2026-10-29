/**
 * Signed handoff packets.
 *
 * A handoff between two agents is the moment most likely to lose work, because
 * everything the receiver needs lives in the sender's context and none of it is
 * written down. A `handoff` event with a one-line summary — Phase 0's version —
 * tells the next agent that a handoff happened, not what it was.
 *
 * A packet is that context, written down and closed over:
 *
 *   - **goal** — what the receiver is to achieve, in the sender's words.
 *   - **files** — the paths the work touches, so the receiver does not rediscover
 *     them by grep.
 *   - **dod** — the Definition of Done, as checkable lines. This is the same gate
 *     `hermes-linear-connector` applies on completion, stated up front.
 *   - **blockers** — what is known to be in the way. An empty list is a claim,
 *     not an omission.
 *   - **prev_event_hash** — the sender's chain tip at the moment of handoff. It
 *     ties the packet to the trail: the receiver can verify every event that led
 *     here, and a packet quoting a hash the ledger does not have is a packet
 *     from a session that did not happen as described.
 *
 * **Signed** because a packet is acted on by an agent that did not see it
 * written. The substrate signs on ingest with a key from
 * `/etc/substrate/substrate.env`, over the canonical JSON of everything above,
 * so a packet replayed out of the ledger can be checked rather than trusted.
 * Signing happens *after* redaction and size-fitting, so the bytes signed are
 * the bytes stored — a signature that only verified before storage would be
 * worse than none.
 *
 * Fail open, like the rest of the substrate: with no key configured a packet is
 * emitted unsigned and says so, rather than the handoff failing.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./event.ts";
import { redact } from "./redact.ts";
import type { Surface } from "./types.ts";

export const HANDOFF_VERSION = 1 as const;
export const HANDOFF_ALG = "hmac-sha256" as const;

/** Per-field caps, so one packet cannot fill the payload budget on its own. */
const MAX_GOAL = 1200;
const MAX_LINE = 400;
const MAX_FILES = 40;
const MAX_DOD = 24;
const MAX_BLOCKERS = 16;
const MAX_NOTES = 1200;

/**
 * The byte budget a signed packet has to fit in.
 *
 * `normalizeEvent` replaces a payload over 16 kB outright, which would drop the
 * packet from the very event that carries it. Fitting under that here — with
 * room for the event's own fields — means a stored handoff is always the packet
 * that was signed, and any trimming is recorded in the packet rather than
 * discovered later.
 */
const MAX_PACKET_BYTES = 12_000;

/** What a signature adds to a packet: an algorithm name, a key id, a timestamp and a hex digest, with room to spare. */
const MAX_SIGNATURE_BYTES = 1_024;

export interface HandoffParty {
	surface: Surface;
	session_id: string | null;
}

export interface HandoffSignature {
	alg: typeof HANDOFF_ALG;
	key_id: string;
	signed_at: string;
	/** Hex HMAC over the canonical JSON of the packet with this field removed. */
	value: string;
}

export interface HandoffPacket {
	version: typeof HANDOFF_VERSION;
	handoff_id: string;
	ts: string;
	from: HandoffParty;
	to: HandoffParty;
	graph_id: string | null;
	node_id: string | null;
	linear_identifier: string | null;
	repo: string | null;
	branch: string | null;
	/** What the receiver is to achieve. */
	goal: string;
	/** Paths the work touches, repo-relative. */
	files: string[];
	/** Definition of Done, one checkable line each. */
	dod: string[];
	/** What is known to be in the way. Empty means "nothing known". */
	blockers: string[];
	/**
	 * The sender's hash-chain tip at handoff, or null if it had emitted nothing.
	 *
	 * Always read from the ledger by the substrate, never accepted from the
	 * caller: a hash nothing checked would be signed and then believed.
	 */
	prev_event_hash: string | null;
	/**
	 * Whether the sender meant to hand its lease on `node_id` over.
	 *
	 * Named for the intent, not an outcome, because an outcome cannot honestly go
	 * in here. The packet is signed before the release is attempted — it has to
	 * be, since the release must not happen until the packet is durable — and it
	 * is then immutable, while a lease's state is not: a packet asserting "this
	 * node is free" would be stale the moment another agent claimed it.
	 *
	 * And not the lease id: the packet is replayable by every agent through
	 * `coord_handoff_list`, and the id is the one part of a lease that only its
	 * holder may see. The id the sender quoted is a request field for the release,
	 * never signed or stored.
	 *
	 * So a receiver replaying this does not read the node's state off the packet.
	 * It calls `graph_claim`, which answers authoritatively and is what the
	 * receiver has to do anyway. Whether the sender's release landed is a separate
	 * fact in the same ledger — `releaseNode` appends its own event — and the
	 * reply to the handoff call reports it as `lease_released` for the sender.
	 *
	 * Optional on this type because it is the type packets are *read* as, and the
	 * ledger is append-only: a packet signed before this field existed does not
	 * have it, and adding it would break its signature. `buildHandoff` always
	 * writes it. Absent means a legacy packet; such a packet may carry
	 * `handover_lease_id` instead, whose presence is the same intent.
	 */
	lease_handover?: boolean;
	/**
	 * The lease id itself, as packets signed before `lease_handover` carried it.
	 * Never written now. Typed so a replayed old packet reads as what it is; its
	 * signature covers the field, so it is left exactly as stored.
	 */
	handover_lease_id?: string | null;
	notes: string | null;
	/** What had to be trimmed to fit the payload budget. Absent when nothing was. */
	truncated?: { files?: number; dod?: number; blockers?: number; notes?: true };
	/** Null when no signing key is configured. */
	signature: HandoffSignature | null;
}

export interface HandoffInput {
	from: HandoffParty;
	to: HandoffParty;
	goal: string;
	files?: string[] | undefined;
	dod?: string[] | undefined;
	blockers?: string[] | undefined;
	graph_id?: string | null | undefined;
	node_id?: string | null | undefined;
	linear_identifier?: string | null | undefined;
	repo?: string | null | undefined;
	branch?: string | null | undefined;
	prev_event_hash?: string | null;
	/** The sender's lease on `node_id`, for the release only: it is not put in the packet. */
	handover_lease_id?: string | null;
	notes?: string | null | undefined;
	ts?: string | undefined;
	handoff_id?: string | undefined;
}

export class InvalidHandoffError extends Error {}

/** Passes of redaction that settle a text, and tries that make its cut text stable. Redaction converges in a pass or two on any real text; a bound keeps a hostile one from looping. */
const SETTLE_PASSES = 8;
const STABLE_CUT_ATTEMPTS = 32;

/** The text after redaction has run until another pass changes nothing, or null when it never does. */
function settle(text: string): string | null {
	let current = redact(text).trim();
	for (let pass = 0; pass < SETTLE_PASSES; pass++) {
		const next = redact(current).trim();
		if (next === current) return current;
		current = next;
	}
	return null;
}

/**
 * One line of a packet: redacted, capped, and stable.
 *
 * Redact first, then cap: truncating first can cut a token in half so its own pattern no longer matches, and the fragment would
 * be signed and stored. Then make it stable, because the event layer redacts every stored string again and the text that was
 * signed has to be the text that is stored:
 * - redaction is settled before the cap, so a second pass over the whole text (one that, say, drops a comma after a marker)
 *   changes nothing later;
 * - a cap that falls inside a marker (`[REDACTE`) or a value (`password=[REDA`) is completed or replaced by that second pass. If
 *   the result still fits, it is the form that is kept; if it outgrew the cap, the cut moves back from where it was (never from
 *   the start) until a second pass changes nothing.
 * Text that cannot be made stable is not carried, rather than carried in a form that differs from what was signed.
 */
function line(value: unknown, limit: number): string | null {
	if (typeof value !== "string") return null;
	let text = settle(value);
	if (text === null) return null;
	let cut = Math.min(text.length, limit);
	for (let attempt = 0; attempt < STABLE_CUT_ATTEMPTS; attempt++) {
		const candidate = text.slice(0, cut).trim();
		const again = redact(candidate);
		if (again === candidate) return candidate.length > 0 ? candidate : null;
		if (again.length <= limit) {
			text = again.trim();
			cut = Math.min(text.length, limit);
			continue;
		}
		cut = Math.max(0, cut - Math.max(2, again.length - candidate.length + 1));
		if (cut === 0) return null;
	}
	return null;
}

function lines(value: unknown, maxItems: number): { kept: string[]; dropped: number } {
	if (!Array.isArray(value)) return { kept: [], dropped: 0 };
	const cleaned = value.map((item) => line(item, MAX_LINE)).filter((item): item is string => item !== null);
	return { kept: cleaned.slice(0, maxItems), dropped: Math.max(0, cleaned.length - maxItems) };
}

function packetBytes(packet: HandoffPacket): number {
	return Buffer.byteLength(canonicalJson(packet));
}

/**
 * Trim a packet until it fits, cheapest loss first, and record what went.
 *
 * Order matters: notes are prose the receiver can live without, file paths are
 * recoverable from the diff, blockers and the Definition of Done are the parts
 * that make the packet actionable and go last. Nothing is dropped silently —
 * `truncated` is part of the signed body, so a receiver reading a trimmed packet
 * knows it is reading a trimmed packet.
 */
function fitPacket(packet: HandoffPacket): HandoffPacket {
	const out: HandoffPacket = { ...packet };
	const truncated: NonNullable<HandoffPacket["truncated"]> = { ...(packet.truncated ?? {}) };

	if (out.notes && packetBytes(out) > MAX_PACKET_BYTES) {
		out.notes = null;
		truncated.notes = true;
	}
	for (const field of ["files", "blockers", "dod"] as const) {
		while (packetBytes(out) > MAX_PACKET_BYTES && out[field].length > 0) {
			out[field] = out[field].slice(0, -1);
			truncated[field] = (truncated[field] ?? 0) + 1;
		}
	}
	// The goal is the one thing a handoff cannot be without, so it is capped
	// rather than dropped — and the cap is already well inside the budget.
	if (packetBytes(out) > MAX_PACKET_BYTES) out.goal = out.goal.slice(0, 500);

	const any = Object.keys(truncated).length > 0;
	return any ? { ...out, truncated } : out;
}

/**
 * Build a packet from an agent's input: validated, redacted, capped and fitted.
 *
 * Unsigned — {@link signHandoff} is a separate step so the signature is always
 * taken over the final bytes.
 */
export function buildHandoff(input: HandoffInput): HandoffPacket {
	const goal = line(input.goal, MAX_GOAL);
	if (!goal) throw new InvalidHandoffError("a handoff needs a goal");
	if (!input.from?.surface) throw new InvalidHandoffError("a handoff needs a from.surface");
	if (!input.to?.surface) throw new InvalidHandoffError("a handoff needs a to.surface");

	const ts = input.ts ? new Date(input.ts) : new Date();
	if (Number.isNaN(ts.getTime())) throw new InvalidHandoffError(`invalid ts: ${String(input.ts)}`);

	const files = lines(input.files, MAX_FILES);
	const dod = lines(input.dod, MAX_DOD);
	const blockers = lines(input.blockers, MAX_BLOCKERS);
	const truncated: NonNullable<HandoffPacket["truncated"]> = {};
	if (files.dropped) truncated.files = files.dropped;
	if (dod.dropped) truncated.dod = dod.dropped;
	if (blockers.dropped) truncated.blockers = blockers.dropped;

	const packet: HandoffPacket = {
		version: HANDOFF_VERSION,
		handoff_id: input.handoff_id ?? `hof_${randomUUID().replace(/-/g, "")}`,
		ts: ts.toISOString(),
		from: { surface: input.from.surface, session_id: line(input.from.session_id, MAX_LINE) },
		to: { surface: input.to.surface, session_id: line(input.to.session_id, MAX_LINE) },
		graph_id: line(input.graph_id, MAX_LINE),
		node_id: line(input.node_id, MAX_LINE),
		linear_identifier: line(input.linear_identifier, MAX_LINE),
		repo: line(input.repo, MAX_LINE),
		branch: line(input.branch, MAX_LINE),
		goal,
		files: files.kept,
		dod: dod.kept,
		blockers: blockers.kept,
		prev_event_hash: line(input.prev_event_hash, MAX_LINE),
		lease_handover: line(input.handover_lease_id, MAX_LINE) !== null,
		notes: line(input.notes, MAX_NOTES),
		...(Object.keys(truncated).length > 0 ? { truncated } : {}),
		signature: null,
	};

	return fitPacket(packet);
}

/** The bytes a signature covers: the whole packet, with only `value` removed. */
function signingInput(packet: HandoffPacket, header: Omit<HandoffSignature, "value">): string {
	return canonicalJson({ ...packet, signature: header });
}

export interface SigningKey {
	key_id: string;
	key: string;
}

/**
 * Sign a packet, or return it unsigned when no key is configured.
 *
 * `signed_at` is inside the signed body, so a packet cannot be back-dated by
 * moving it, and the key id is too, so a verifier cannot be pointed at a
 * different key than the signer used.
 */
export function signHandoff(packet: HandoffPacket, signer: SigningKey | null, now = new Date()): HandoffPacket {
	if (!signer) return { ...packet, signature: null };
	const header = { alg: HANDOFF_ALG, key_id: signer.key_id, signed_at: now.toISOString() } as const;
	const value = createHmac("sha256", signer.key).update(signingInput(packet, header)).digest("hex");
	return { ...packet, signature: { ...header, value } };
}

export type HandoffVerdict =
	| { ok: true; key_id: string }
	| {
			ok: false;
			reason:
				| "unsigned"
				| "unknown-alg"
				| "unknown-key"
				| "no-keys-configured"
				| "bad-signature"
				| "malformed";
			detail?: string;
	  };

/**
 * Recompute a packet's signature.
 *
 * Constant-time comparison, because a handoff is replayed from an append-only
 * log that several agents can read: a timing oracle on this check would be a
 * way to forge a packet, and the comparison costs nothing.
 */
export function verifyHandoff(packet: unknown, keys: Map<string, string>): HandoffVerdict {
	if (!packet || typeof packet !== "object") return { ok: false, reason: "malformed" };
	const candidate = packet as HandoffPacket;
	const signature = candidate.signature;
	if (!signature || typeof signature !== "object") return { ok: false, reason: "unsigned" };
	if (signature.alg !== HANDOFF_ALG) {
		return { ok: false, reason: "unknown-alg", detail: String(signature.alg) };
	}
	if (typeof signature.value !== "string" || typeof signature.key_id !== "string") {
		return { ok: false, reason: "malformed" };
	}
	if (keys.size === 0) return { ok: false, reason: "no-keys-configured" };
	const key = keys.get(signature.key_id);
	if (!key) return { ok: false, reason: "unknown-key", detail: signature.key_id };

	const expected = createHmac("sha256", key)
		.update(signingInput(candidate, { alg: signature.alg, key_id: signature.key_id, signed_at: signature.signed_at }))
		.digest();
	let offered: Buffer;
	try {
		offered = Buffer.from(signature.value, "hex");
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (offered.length !== expected.length) return { ok: false, reason: "bad-signature" };
	return timingSafeEqual(offered, expected)
		? { ok: true, key_id: signature.key_id }
		: { ok: false, reason: "bad-signature" };
}

/** One line for the event summary and the brief. The packet holds the detail. */
export function handoffSummary(packet: HandoffPacket): string {
	const goal = packet.goal.split("\n")[0] ?? packet.goal;
	const blocked = packet.blockers.length > 0 ? ` (${packet.blockers.length} blocker${packet.blockers.length === 1 ? "" : "s"})` : "";
	return `handoff to ${packet.to.surface}: ${goal}${blocked}`;
}

/**
 * Whether a packet carries everything a receiver needs to start without asking.
 *
 * Reported rather than enforced: a handoff with no Definition of Done is still
 * better than one that was refused and so never written down at all. The
 * receiving agent is told what is thin, and can ask the sender while it is still
 * there to ask.
 */
export function handoffGaps(packet: HandoffPacket): string[] {
	const gaps: string[] = [];
	if (packet.dod.length === 0) gaps.push("no Definition of Done: the receiver cannot tell when it is finished");
	if (packet.files.length === 0) gaps.push("no files: the receiver has to rediscover the surface area");
	if (!packet.graph_id) gaps.push("no graph_id: this handoff is not attached to a task graph");
	if (!packet.prev_event_hash) {
		gaps.push("no prev_event_hash: the packet is not anchored to the sender's event trail");
	}
	return gaps;
}

/** A named own field of an object read back from storage, untyped. Absent is `undefined`. */
function storedField(value: object, key: string): unknown {
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function isStringList(value: unknown, maxItems: number): value is string[] {
	return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= MAX_LINE);
}

function isStoredParty(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const surface = storedField(value, "surface");
	return typeof surface === "string" && surface.length > 0 && surface.length <= MAX_LINE;
}

/**
 * Whether a `payload.handoff` read back from the ledger is a packet a reader may use. The ledger takes any payload from
 * `events_emit`, so a row of kind `handoff` can carry `{}`, a number or a megabyte string. A packet passes when it is an object
 * with a non-empty goal, `files`, `dod` and `blockers` as lists of strings, `from` and `to` naming a surface, and every field
 * inside the bounds `buildHandoff` applies (so a genuine packet always passes and a hostile one is the reader's to skip). The
 * signature is not judged here: an unsigned or unverifiable packet is still a packet, and `verifyHandoff` says what it is.
 */
export function isStoredHandoff(value: unknown): value is HandoffPacket {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const goal = storedField(value, "goal");
	if (typeof goal !== "string" || goal.trim().length === 0 || goal.length > MAX_GOAL) return false;
	if (!isStringList(storedField(value, "files"), MAX_FILES)) return false;
	if (!isStringList(storedField(value, "dod"), MAX_DOD)) return false;
	if (!isStringList(storedField(value, "blockers"), MAX_BLOCKERS)) return false;
	if (!isStoredParty(storedField(value, "from")) || !isStoredParty(storedField(value, "to"))) return false;
	const notes = storedField(value, "notes");
	if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > MAX_NOTES)) return false;
	const signature = storedField(value, "signature");
	if (signature !== undefined && signature !== null && (typeof signature !== "object" || Array.isArray(signature))) return false;
	try {
		// The builder fits the unsigned packet under the budget and signing adds the signature afterwards, so the two are measured
		// apart: the packet without its signature against the packet budget, the signature against a bound of its own.
		const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature"));
		if (Buffer.byteLength(canonicalJson(unsigned)) > MAX_PACKET_BYTES) return false;
		return signature === undefined || signature === null || Buffer.byteLength(canonicalJson(signature)) <= MAX_SIGNATURE_BYTES;
	} catch {
		// A payload that cannot be serialised is not a packet.
		return false;
	}
}
