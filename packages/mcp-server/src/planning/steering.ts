/**
 * The steering inbox (phase 53, SOTA-09): directives from a principal to a planning session.
 *
 * What it guarantees:
 * - Human-only authorisation. An agent-kind author is always refused. A human author must be on
 *   the allowlist from `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`; an empty allowlist refuses everyone.
 * - Audit before effect. Every `queued` and `acknowledged` transition is appended to the injected
 *   history sink first, with a bounded retry of two attempts. The transition takes effect only
 *   after the append succeeds. If both attempts fail, the directive is held: a queue that cannot be
 *   audited stores nothing, and an acknowledgement that cannot be audited leaves the directive queued.
 * - A rate limit per target session: a token bucket driven by the injected clock. The default is
 *   ten directives per minute. A refused directive is not queued and not audited.
 * - A directive that conflicts with the target's active plan cannot be acknowledged as `applied`
 *   without an explicit `confirm: true` in the acknowledgement. A declined outcome needs no confirm.
 * - Restart safety and an acknowledgement deadline. The append-only audit log is the durable record, so a restarted
 *   process rebuilds the inbox with {@link SteeringInbox.restore} from rows the sink read back, and never re-audits
 *   them. {@link SteeringInbox.expireStale} closes every directive that stayed queued past the acknowledgement TTL
 *   with a system acknowledgement (`declined`, reason `timeout`), audited before the directive leaves the pending set.
 * - No file writes. Nothing in this module touches the filesystem.
 *
 * Every mutating call runs under one lock, so audit order, rate tokens and state never interleave.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { IDEMPOTENCY_KEY_PATTERN } from "../event.ts";
import { redact } from "../redact.ts";
import { errnoCode } from "./index.ts";
import { SESSION_ID_RE } from "./presence.ts";

export const STEERING_ENABLED_ENV = "SUBSTRATE_PLANNING_STEERING";
export const STEERING_PRINCIPALS_ENV = "SUBSTRATE_PLANNING_STEERING_PRINCIPALS";
export const STEERING_RATE_PER_MIN_ENV = "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN";

export const DEFAULT_STEERING_RATE_PER_MIN = 10;
/** Inclusive bounds. Outside them the value is refused, not clamped. */
const STEERING_RATE_BOUNDS = { min: 1, max: 1_000 } as const;
/** The body limit applies to the input and again after redaction. */
export const STEERING_BODY_MAX = 4_096;
/** One attempt plus one retry for every audit write. */
export const STEERING_AUDIT_ATTEMPTS = 2;

export const STEERING_ACK_TTL_ENV = "SUBSTRATE_PLANNING_STEERING_ACK_TTL_S";
export const STEERING_EXPIRY_SWEEP_ENV = "SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S";

/** A queued directive nobody acknowledged within this many seconds expires as `declined:timeout`. One day. */
const DEFAULT_STEERING_ACK_TTL_S = 86_400;
/** Inclusive bounds, in seconds: one minute to thirty days. Outside them the value is refused, not clamped. */
export const STEERING_ACK_TTL_BOUNDS_S = { min: 60, max: 2_592_000 } as const;
/** How often the owner of the inbox should call {@link SteeringInbox.expireStale}, in seconds. */
const DEFAULT_STEERING_EXPIRY_SWEEP_S = 60;
export const STEERING_EXPIRY_SWEEP_BOUNDS_S = { min: 1, max: 3_600 } as const;
/** One expiry pass closes at most this many directives, so the inbox lock is never held for an unbounded run. */
export const STEERING_EXPIRY_BATCH = 100;

/** Keyed-queue replay retention, in whole seconds, from `SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S`. A retry within it returns the original reply and writes nothing. */
export const STEERING_IDEMPOTENCY_TTL_ENV = "SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S";
export const DEFAULT_STEERING_IDEMPOTENCY_TTL_S = 86_400;
/** Inclusive bounds, in seconds: one minute to thirty days. Outside them the value is refused, not clamped. */
const STEERING_IDEMPOTENCY_TTL_BOUNDS_S = { min: 60, max: 2_592_000 } as const;
/** The most keyed queues the replay store keeps, from `SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_CAP`. At the cap the oldest is forgotten first. */
export const STEERING_IDEMPOTENCY_CAP_ENV = "SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_CAP";
export const DEFAULT_STEERING_IDEMPOTENCY_CAP = 10_000;
/** Inclusive bounds. Outside them the value is refused, not clamped. */
const STEERING_IDEMPOTENCY_CAP_BOUNDS = { min: 1, max: 1_000_000 } as const;

const RATE_WINDOW_MS = 60_000;
const DIRECTIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
const PLAN_ID_MAX = 64;

/** Accepted boolean spellings for the enable flag, lowercased. */
const TRUE_WORDS: Record<string, true> = { "1": true, true: true, yes: true, on: true };
const FALSE_WORDS: Record<string, true> = { "0": true, false: true, no: true, off: true };

export const STEERING_PRIORITIES = ["low", "normal", "high"] as const;
export const STEERING_ACTIONS = ["pause", "redirect", "annotate"] as const;
export const STEERING_OUTCOMES = ["applied", "declined"] as const;

export type SteeringPriority = (typeof STEERING_PRIORITIES)[number];
export type SteeringOutcome = (typeof STEERING_OUTCOMES)[number];

/** Why a system closed a directive. A human acknowledgement carries no reason. */
const STEERING_ACK_REASONS = ["timeout"] as const;
export type SteeringAckReason = (typeof STEERING_ACK_REASONS)[number];

const PRIORITY_RANK: Record<SteeringPriority, number> = { high: 0, normal: 1, low: 2 };

export const SteeringDirectiveSchema = z
	.object({
		id: z.string().regex(DIRECTIVE_ID_RE),
		author: z
			.object({
				principalId: z.string().regex(PRINCIPAL_RE),
				kind: z.enum(["human", "agent"]),
			})
			.strict(),
		createdAtMs: z.number().int().nonnegative(),
		priority: z.enum(STEERING_PRIORITIES),
		targetSessionId: z.string().regex(SESSION_ID_RE),
		action: z.enum(STEERING_ACTIONS),
		body: z
			.string()
			.min(1)
			.max(STEERING_BODY_MAX)
			.transform((text) => redact(text))
			.pipe(z.string().min(1).max(STEERING_BODY_MAX)),
		planRef: z
			.object({
				phase: z.string().min(1).max(PLAN_ID_MAX),
				plan: z.string().min(1).max(PLAN_ID_MAX),
			})
			.strict()
			.optional(),
		conflictsWithActivePlan: z.boolean(),
	})
	.strict();

export type SteeringDirective = z.infer<typeof SteeringDirectiveSchema>;

const SteeringAcknowledgementSchema = z
	.object({
		directiveId: z.string().regex(DIRECTIVE_ID_RE),
		sessionId: z.string().regex(SESSION_ID_RE),
		outcome: z.enum(STEERING_OUTCOMES),
		confirm: z.boolean().optional(),
	})
	.strict();

type SteeringAcknowledgement = z.infer<typeof SteeringAcknowledgementSchema>;

/** The stored form of an acknowledgement, as the audit log holds it. A human acknowledgement has no `reason`. */
const SteeringStoredAcknowledgementSchema = z
	.object({
		atMs: z.number().int().nonnegative(),
		outcome: z.enum(STEERING_OUTCOMES),
		confirmed: z.boolean(),
		reason: z.enum(STEERING_ACK_REASONS).nullish(),
	})
	.strict();

/** One directive as read back from the audit log: its snapshot, the time it was queued, and its acknowledgement if any. */
const SteeringRestoreEntrySchema = z
	.object({
		directive: SteeringDirectiveSchema,
		queuedAtMs: z.number().int().nonnegative(),
		acknowledgement: SteeringStoredAcknowledgementSchema.nullish(),
		sequence: z.number().int().positive().nullish(),
	})
	.strict();

type SteeringStoredAcknowledgement = z.infer<typeof SteeringStoredAcknowledgementSchema>;

export type SteeringRecord =
	| { state: "queued"; directive: SteeringDirective; queuedAtMs: number }
	| {
			state: "acknowledged";
			directive: SteeringDirective;
			queuedAtMs: number;
			acknowledgedAtMs: number;
			outcome: SteeringOutcome;
			confirmed: boolean;
			/** Present only on a system acknowledgement. */
			reason?: SteeringAckReason;
			/**
			 * True only when the acknowledgement actually moved the session's state (see `noteSessionMoved`). Memory only: the audit
			 * log does not hold a transition result, so a record restored from it, or one the move was refused for, never carries it.
			 */
			sessionMoved?: boolean;
	  };

/** What the audit sink receives. Only the directive snapshot carries content, and it is already redacted. */
export type SteeringAuditEntry =
	| { event: "queued"; atMs: number; directive: SteeringDirective; sequence?: number }
	| {
			event: "acknowledged";
			atMs: number;
			directiveId: string;
			targetSessionId: string;
			outcome: SteeringOutcome;
			confirmed: boolean;
			/** Present only on a system acknowledgement. It is part of the audited payload, so a changed reason under the same key is a conflict. */
			reason?: SteeringAckReason;
	  };

/** An opaque unit of work the idempotency store opens for a keyed queue (a transaction on Postgres). Only the store that opened it reads it. */
export type SteeringUnit = unknown;

/** The append-only history port (the `HistorySink` shape of phase 52, typed for steering entries). */
export interface SteeringHistorySink {
	/**
	 * Writes one transition. `unit` is the store's open unit of work for a keyed queue: the write uses it, so it commits or rolls back with
	 * the replay claim. Absent, the write stands alone.
	 */
	append(entry: SteeringAuditEntry, unit?: SteeringUnit): Promise<void>;
	/**
	 * The time a transition was saved with, or null when none was. A retry reuses it, so the audit content is unchanged.
	 * Optional: a sink with no durable store has none, and every attempt takes a fresh time. A rejection is an audit failure.
	 */
	savedAtMs?(event: "queued" | "acknowledged", directiveId: string): Promise<number | null>;
	/**
	 * The acknowledgement already saved for a directive, or null when none is. Used to adopt another process's
	 * acknowledgement when an expiry loses a race to it. Optional: a sink with no durable store has none. A rejection is reported, never guessed.
	 */
	readAcknowledgement?(directiveId: string): Promise<unknown>;
}

export interface SteeringClock {
	nowMs(): number;
}

interface SteeringPolicy {
	/** Principal ids allowed to author directives. Empty refuses everyone. */
	allowlist: readonly string[];
	/** Directives per minute per target session. */
	ratePerMin: number;
	/**
	 * The acknowledgement deadline in milliseconds after a directive was queued. Absent, nothing ever expires:
	 * {@link SteeringInbox.expireStale} reports `ttlMs: null` and changes nothing.
	 */
	ackTtlMs?: number;
}

interface SteeringInboxDeps {
	history: SteeringHistorySink;
	clock: SteeringClock;
	policy: SteeringPolicy;
	/** The durable sequence counter and replay records. Absent, the inbox keeps both in memory: one process, and nothing survives a restart. */
	store?: SteeringIdempotencyStore;
	/** Keyed-queue replay retention and capacity. Absent, the defaults of this module are used. */
	idempotency?: SteeringIdempotencySettings;
}

type SimpleSteeringCode =
	| "agent-author-refused"
	| "principal-not-allowed"
	| "duplicate-directive"
	| "not-found"
	| "wrong-session"
	| "already-acknowledged"
	| "confirmation-required"
	| "idempotency-conflict";

export type SteeringError =
	| { code: "invalid-directive" | "invalid-acknowledgement"; issues: string[] }
	| { code: "rate-limited"; retryAfterMs: number }
	| { code: "audit-unavailable"; attempts: number; lastErrorCode: string }
	| { code: SimpleSteeringCode };

type SteeringResult<T> = { ok: true; value: T } | { ok: false; error: SteeringError };

type SteeringRestoreSkipCode = "invalid-entry" | "agent-author-refused";

/** An entry `restore` did not load. `issues` are field paths only: a value, and so a secret, is never echoed. */
interface SteeringRestoreSkip {
	index: number;
	/** The entry's directive id when it has a well-formed one, else null. */
	directiveId: string | null;
	code: SteeringRestoreSkipCode;
	issues: string[];
}

export interface SteeringRestoreReport {
	/** Directives loaded, or upgraded from queued to acknowledged. */
	restored: string[];
	/** Directives already held in the state the entry describes, or further along. Nothing changed. */
	unchanged: string[];
	skipped: SteeringRestoreSkip[];
}

interface SteeringExpiryFailure {
	directiveId: string;
	/** The audit failure's code. `AUDIT_CONFLICT` means the key holds a different acknowledgement that could not be read back. */
	lastErrorCode: string;
}

export interface SteeringExpiryReport {
	/** The TTL this pass used, or null when the policy has none (nothing expires). */
	ttlMs: number | null;
	/** Queued directives examined. */
	checked: number;
	/** Closed by this pass as `declined:timeout`. Includes one whose identical row was already saved by another process. */
	expired: string[];
	/** Closed by someone else first with a different acknowledgement; that acknowledgement was adopted. */
	adopted: string[];
	/** Still pending: the audit write failed or conflicted and the stored row could not be read. */
	failed: SteeringExpiryFailure[];
	/** Due but not attempted this pass, because of the batch bound or an audit outage that ended the pass. */
	deferred: number;
}

interface TokenBucket {
	tokens: number;
	updatedAtMs: number;
}

/** A keyed queue as the replay store keeps it: what it asked for, the directive it queued, its delivery sequence, and when its key stops replaying. */
export interface SteeringReplayRecord {
	scopeKey: string;
	fingerprint: string;
	directive: SteeringDirective;
	queuedAtMs: number;
	sequence: number;
	expiresAtMs: number;
}

/**
 * The durable side of the inbox's delivery order and replay: the per-session sequence counter and the keyed replay records. Production
 * keeps both in the steering store, so they survive a restart. Without a store the inbox keeps them in {@link MemorySteeringIdempotencyStore}.
 */
export interface SteeringIdempotencyStore {
	/** The next delivery sequence of a target session. A number is never handed out twice, across processes and restarts. */
	nextSequence(sessionId: string): Promise<number>;
	/** Makes the session's counter pass a sequence already in use, so the next number handed out is new. */
	advancePast(sessionId: string, sequence: number): Promise<void>;
	/** The live replay record for a scope key at `nowMs`, or null. A record at or past its expiry is not live. */
	findReplay(scopeKey: string, nowMs: number): Promise<SteeringReplayRecord | null>;
	/**
	 * Claims a keyed queue and runs its audit write in the same unit of work. The claim is taken first: when another call already holds the
	 * scope key, `queue` does not run and the holder's record comes back. Otherwise `queue(unit)` must write through `unit`, and the claim is
	 * kept only if it returns; a throw keeps nothing. Expired records are pruned, and at most `cap` records are kept.
	 */
	claimReplay(record: SteeringReplayRecord, nowMs: number, cap: number, queue: (unit: SteeringUnit) => Promise<void>): Promise<SteeringReplayClaim>;
}

/** The outcome of a keyed claim: this call holds the scope key, or another call already holds it and its record is returned. */
export type SteeringReplayClaim = { claimed: true } | { claimed: false; held: SteeringReplayRecord };

/** One process, no restart: the default store when none is injected. */
export class MemorySteeringIdempotencyStore implements SteeringIdempotencyStore {
	private readonly tails = new Map<string, number>();
	private readonly replays = new Map<string, SteeringReplayRecord>();

	async nextSequence(sessionId: string): Promise<number> {
		const next = (this.tails.get(sessionId) ?? 0) + 1;
		this.tails.set(sessionId, next);
		return next;
	}

	async advancePast(sessionId: string, sequence: number): Promise<void> {
		if ((this.tails.get(sessionId) ?? 0) < sequence) this.tails.set(sessionId, sequence);
	}

	async findReplay(scopeKey: string, nowMs: number): Promise<SteeringReplayRecord | null> {
		const held = this.replays.get(scopeKey);
		return held === undefined || held.expiresAtMs <= nowMs ? null : structuredClone(held);
	}

	async claimReplay(record: SteeringReplayRecord, nowMs: number, cap: number, queue: (unit: SteeringUnit) => Promise<void>): Promise<SteeringReplayClaim> {
		for (const [key, held] of this.replays) if (held.expiresAtMs <= nowMs) this.replays.delete(key);
		const held = this.replays.get(record.scopeKey);
		if (held !== undefined) return { claimed: false, held: structuredClone(held) };
		await queue(undefined);
		this.replays.set(record.scopeKey, structuredClone(record));
		while (this.replays.size > cap) {
			const oldest = this.replays.keys().next();
			if (oldest.done) break;
			this.replays.delete(oldest.value);
		}
		return { claimed: true };
	}
}

/** What a keyed queue asks for. A replay must match it. The id and clock are left out, since a replay never regenerates the id. */
function fingerprintOf(directive: SteeringDirective): string {
	return createHash("sha256").update(JSON.stringify([directive.action, directive.priority, directive.targetSessionId, directive.body, directive.planRef ?? null, directive.conflictsWithActivePlan])).digest("hex");
}
/** What a queue returns: the record, and whether the call replayed an earlier keyed queue. A replay wrote nothing, so it announces nothing. */
interface SteeringReceipt {
	record: SteeringRecord;
	replayed: boolean;
}

export class SteeringInbox {
	private readonly records = new Map<string, SteeringRecord>();
	private readonly buckets = new Map<string, TokenBucket>();
	/** The largest clock reading the limiter has seen. Buckets refill against it, so a clock that steps back never refills. */
	private highestMs = Number.NEGATIVE_INFINITY;
	private readonly allowlist: ReadonlySet<string>;
	private readonly capacity: number;
	private tail: Promise<unknown> = Promise.resolve();
	/** Delivery order, per target session: each session's directives take 1, 2, 3... in the order they enter this inbox. Never repeats, whatever the clock says. */
	private readonly sequences = new Map<string, number>();
	/** The number a queue took whose audit then failed, kept for the retry of the same directive: the committed row may already hold it. Cleared when that retry is audited. */
	private readonly reservedSequences = new Map<string, number>();
	private readonly store: SteeringIdempotencyStore;
	private readonly idempotency: SteeringIdempotencySettings;

	constructor(private readonly deps: SteeringInboxDeps) {
		const { ratePerMin } = deps.policy;
		if (!Number.isSafeInteger(ratePerMin) || ratePerMin < STEERING_RATE_BOUNDS.min || ratePerMin > STEERING_RATE_BOUNDS.max) {
			throw new RangeError("ratePerMin must be an integer within the steering rate bounds");
		}
		const { ackTtlMs } = deps.policy;
		if (ackTtlMs !== undefined && (!Number.isSafeInteger(ackTtlMs) || ackTtlMs < 1)) {
			throw new RangeError("ackTtlMs must be a positive integer number of milliseconds");
		}
		this.capacity = ratePerMin;
		this.allowlist = new Set(deps.policy.allowlist);
		this.store = deps.store ?? new MemorySteeringIdempotencyStore();
		const idempotency = deps.idempotency ?? { ttlMs: DEFAULT_STEERING_IDEMPOTENCY_TTL_S * 1_000, cap: DEFAULT_STEERING_IDEMPOTENCY_CAP };
		if (!Number.isSafeInteger(idempotency.ttlMs) || idempotency.ttlMs < 1 || !Number.isSafeInteger(idempotency.cap) || idempotency.cap < 1) {
			throw new RangeError("idempotency ttlMs and cap must be positive integers");
		}
		this.idempotency = idempotency;
	}

	/**
	 * Validate, authorise, then replay or rate-limit, audit, and queue. With an `idempotencyKey`, a repeat of a queue this inbox
	 * accepted within the replay retention returns the original record and writes nothing. The key is scoped to the author and
	 * target session, and a repeat that asks for something different is refused `idempotency-conflict`. Only accepted queues are
	 * kept, so a refused attempt is a fresh attempt on retry.
	 */
	enqueue(input: unknown, idempotencyKey?: string): Promise<SteeringResult<SteeringRecord>> {
		return this.exclusive(async () => {
			const receipt = await this.doEnqueue(input, idempotencyKey);
			return receipt.ok ? { ok: true, value: receipt.value.record } : receipt;
		});
	}

	/** As {@link SteeringInbox.enqueue}, and it says whether the call was a replay. */
	enqueueReceipt(input: unknown, idempotencyKey?: string): Promise<SteeringResult<SteeringReceipt>> {
		return this.exclusive(() => this.doEnqueue(input, idempotencyKey));
	}

	/** Validate, check the session and the confirm rule, audit, then record the outcome. */
	acknowledge(input: unknown): Promise<SteeringResult<SteeringRecord>> {
		return this.exclusive(() => this.doAcknowledge(input));
	}

	/** A copy of the stored record. Mutating it changes nothing in the inbox. */
	get(directiveId: string): SteeringRecord | null {
		const record = this.records.get(directiveId);
		return record === undefined ? null : structuredClone(record);
	}

	/**
	 * Remembers that the acknowledgement of this directive really changed its session's state, which is the one fact a
	 * `checkpoint_hint` rests on. A no-op for an id the inbox does not hold or one that is not acknowledged. Returns whether it was set.
	 */
	noteSessionMoved(directiveId: string): boolean {
		const record = this.records.get(directiveId);
		if (record === undefined || record.state !== "acknowledged") return false;
		record.sessionMoved = true;
		return true;
	}

	/**
	 * The delivery sequence of a directive: a number that grows with every directive that enters this inbox (queued here, or
	 * restored at boot in restore order), whatever the clock says. Null for an id the inbox does not hold.
	 */
	sequenceOf(directiveId: string): number | null {
		return this.sequences.get(directiveId) ?? null;
	}

	/**
	 * The delivery sequence of a directive this inbox holds for `sessionId`, or null. Another session's directive gives null
	 * too: a wait cursor is a position in its own session's queue, so an id from elsewhere must not filter it.
	 */
	sequenceOfFor(sessionId: string, directiveId: string): number | null {
		if (this.records.get(directiveId)?.directive.targetSessionId !== sessionId) return null;
		return this.sequences.get(directiveId) ?? null;
	}

	/** The queued directives of one session with their delivery sequence, lowest sequence first. A read: it changes nothing. */
	queuedFor(sessionId: string): Array<{ sequence: number; record: Extract<SteeringRecord, { state: "queued" }> }> {
		const queued: Array<{ sequence: number; record: Extract<SteeringRecord, { state: "queued" }> }> = [];
		for (const record of this.records.values()) {
			if (record.state !== "queued" || record.directive.targetSessionId !== sessionId) continue;
			queued.push({ sequence: this.sequences.get(record.directive.id) ?? Number.MAX_SAFE_INTEGER, record: structuredClone(record) });
		}
		return queued.sort((a, b) => a.sequence - b.sequence);
	}

	/** Queued directives for one session, highest priority first, then oldest, then by id. */
	pendingFor(sessionId: string): SteeringDirective[] {
		const pending: SteeringDirective[] = [];
		for (const record of this.records.values()) {
			if (record.state === "queued" && record.directive.targetSessionId === sessionId) pending.push(structuredClone(record.directive));
		}
		return pending.sort(compareDirectives);
	}

	/** Every directive for one session, queued or acknowledged, in the order `pendingFor` uses. A read: it changes nothing. */
	recordsFor(sessionId: string): SteeringRecord[] {
		const records: SteeringRecord[] = [];
		for (const record of this.records.values()) {
			if (record.directive.targetSessionId === sessionId) records.push(structuredClone(record));
		}
		return records.sort((a, b) => compareDirectives(a.directive, b.directive));
	}

	/**
	 * Loads directives read back from the audit log. Never audits, never throws, and is idempotent: an entry for a
	 * directive already held changes nothing, except that a queued record is upgraded when the entry is acknowledged.
	 * An entry that fails the directive schema is skipped and reported, not loaded.
	 */
	restore(entries: readonly unknown[]): Promise<SteeringRestoreReport> {
		return this.exclusive(async () => this.doRestore(entries));
	}

	/**
	 * Closes every queued directive older than the acknowledgement TTL with `declined:timeout`, appended through the
	 * sink before the directive leaves the pending set. The audited time is the deadline (`queuedAtMs + ttl`), not
	 * `nowMs`, so two processes expiring one directive write the same payload and the second sees a same-hash repeat.
	 * A directive is due when `nowMs - queuedAtMs >= ttl`. Running it again changes nothing.
	 */
	expireStale(nowMs: number): Promise<SteeringExpiryReport> {
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError("nowMs must be a non-negative integer");
		return this.exclusive(() => this.doExpireStale(nowMs));
	}

	private async doEnqueue(input: unknown, idempotencyKey: string | undefined): Promise<SteeringResult<SteeringReceipt>> {
		const parsed = SteeringDirectiveSchema.safeParse(input);
		if (!parsed.success) return fail({ code: "invalid-directive", issues: issuePaths(parsed.error) });
		const directive = parsed.data;
		if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return fail({ code: "invalid-directive", issues: ["idempotency_key"] });

		if (directive.author.kind === "agent") return fail({ code: "agent-author-refused" });
		if (!this.allowlist.has(directive.author.principalId)) return fail({ code: "principal-not-allowed" });

		const seenMs = this.limiterNowMs();
		const replay = idempotencyKey === undefined ? null : { scopeKey: JSON.stringify([directive.author.principalId, directive.targetSessionId, idempotencyKey]), fingerprint: fingerprintOf(directive) };
		if (replay !== null) {
			const held = await this.storeCall(() => this.store.findReplay(replay.scopeKey, seenMs));
			if (!held.ok) return held;
			if (held.value !== null) return this.replayOf(held.value, replay.fingerprint);
		}

		if (this.records.has(directive.id)) return fail({ code: "duplicate-directive" });

		const bucket = this.refilled(directive.targetSessionId, seenMs);
		if (bucket.tokens < 1) {
			const retryAfterMs = Math.ceil(((1 - bucket.tokens) * RATE_WINDOW_MS) / this.capacity);
			return fail({ code: "rate-limited", retryAfterMs });
		}

		const saved = await this.savedTransitionAtMs("queued", directive.id);
		if (!saved.ok) return saved;
		const nowMs = saved.value ?? this.deps.clock.nowMs();
		const reserved = this.reservedSequences.get(directive.id);
		const sequenced = reserved === undefined ? await this.storeCall(() => this.store.nextSequence(directive.targetSessionId)) : { ok: true as const, value: reserved };
		if (!sequenced.ok) return sequenced;
		const sequence = sequenced.value;
		const entry: SteeringAuditEntry = { event: "queued", atMs: nowMs, directive, sequence };

		if (replay === null) {
			const audited = await this.audit(entry);
			if (!audited.ok) {
				this.reservedSequences.set(directive.id, sequence);
				return audited;
			}
			return this.acceptQueued(directive, nowMs, sequence, bucket);
		}
		// The audit row and the replay claim commit as one unit. A refused audit keeps no claim; a claim another call holds queues nothing here.
		const claim = await this.claimKeyed({ scopeKey: replay.scopeKey, fingerprint: replay.fingerprint, directive, queuedAtMs: nowMs, sequence, expiresAtMs: nowMs + this.idempotency.ttlMs }, seenMs, entry);
		if (!claim.ok) return claim;
		if (!claim.value.claimed) return this.replayOf(claim.value.held, replay.fingerprint);
		return this.acceptQueued(directive, nowMs, sequence, bucket);
	}

	/** A store call as a typed result: a failure is `audit-unavailable` with the driver's code, and is never thrown into the queue. */
	private async storeCall<T>(run: () => Promise<T>): Promise<SteeringResult<T>> {
		try {
			return { ok: true, value: await run() };
		} catch (cause) {
			return fail({ code: "audit-unavailable", attempts: 1, lastErrorCode: errnoCode(cause) });
		}
	}

	/** Records an accepted queue: the bucket spends its token, and the record and its sequence are held. Its audit row is already committed. */
	private acceptQueued(directive: SteeringDirective, nowMs: number, sequence: number, bucket: TokenBucket): SteeringResult<SteeringReceipt> {
		this.reservedSequences.delete(directive.id);
		this.buckets.set(directive.targetSessionId, { tokens: bucket.tokens - 1, updatedAtMs: bucket.updatedAtMs });
		const record: SteeringRecord = { state: "queued", directive, queuedAtMs: nowMs };
		this.records.set(directive.id, record);
		this.sequences.set(directive.id, sequence);
		return { ok: true, value: { record: structuredClone(record), replayed: false } };
	}

	/** The reply to a keyed queue already held: the same record with `replayed` set, or a conflict when the content differs. Writes nothing. */
	private replayOf(held: SteeringReplayRecord, fingerprint: string): SteeringResult<SteeringReceipt> {
		if (held.fingerprint !== fingerprint) return fail({ code: "idempotency-conflict" });
		if (!this.sequences.has(held.directive.id)) this.sequences.set(held.directive.id, held.sequence);
		return { ok: true, value: { record: { state: "queued", directive: held.directive, queuedAtMs: held.queuedAtMs }, replayed: true } };
	}

	/**
	 * Claims a keyed queue and audits it in one unit of work: the store runs the audit write inside the claim, and a refused write rolls
	 * the claim back. A store failure is `audit-unavailable` with its driver code, never thrown into the queue.
	 */
	private async claimKeyed(record: SteeringReplayRecord, nowMs: number, entry: SteeringAuditEntry): Promise<SteeringResult<SteeringReplayClaim>> {
		try {
			const claim = await this.store.claimReplay(record, nowMs, this.idempotency.cap, async (unit) => {
				const audited = await this.audit(entry, unit);
				if (!audited.ok) throw new AuditRefused(audited.error);
			});
			return { ok: true, value: claim };
		} catch (cause) {
			if (cause instanceof AuditRefused) return fail(cause.refusal);
			return fail({ code: "audit-unavailable", attempts: 1, lastErrorCode: errnoCode(cause) });
		}
	}

	private async doAcknowledge(input: unknown): Promise<SteeringResult<SteeringRecord>> {
		const parsed = SteeringAcknowledgementSchema.safeParse(input);
		if (!parsed.success) return fail({ code: "invalid-acknowledgement", issues: issuePaths(parsed.error) });
		const ack: SteeringAcknowledgement = parsed.data;

		const current = this.records.get(ack.directiveId);
		if (current === undefined) return fail({ code: "not-found" });
		if (current.state === "acknowledged") return fail({ code: "already-acknowledged" });
		const { directive } = current;
		if (directive.targetSessionId !== ack.sessionId) return fail({ code: "wrong-session" });

		const confirmed = ack.confirm === true;
		if (ack.outcome === "applied" && directive.conflictsWithActivePlan && !confirmed) {
			return fail({ code: "confirmation-required" });
		}

		const saved = await this.savedTransitionAtMs("acknowledged", directive.id);
		if (!saved.ok) return saved;
		const nowMs = saved.value ?? this.deps.clock.nowMs();
		const audited = await this.audit({
			event: "acknowledged",
			atMs: nowMs,
			directiveId: directive.id,
			targetSessionId: directive.targetSessionId,
			outcome: ack.outcome,
			confirmed,
		});
		if (!audited.ok) return audited;

		const record: SteeringRecord = {
			state: "acknowledged",
			directive,
			queuedAtMs: current.queuedAtMs,
			acknowledgedAtMs: nowMs,
			outcome: ack.outcome,
			confirmed,
		};
		this.records.set(directive.id, record);
		return { ok: true, value: structuredClone(record) };
	}

	private async doRestore(entries: readonly unknown[]): Promise<SteeringRestoreReport> {
		const report: SteeringRestoreReport = { restored: [], unchanged: [], skipped: [] };
		for (const [index, entry] of entries.entries()) {
			const parsed = SteeringRestoreEntrySchema.safeParse(entry);
			if (!parsed.success) {
				report.skipped.push({ index, directiveId: wellFormedDirectiveId(entry), code: "invalid-entry", issues: issuePaths(parsed.error) });
				continue;
			}
			const { directive, queuedAtMs, acknowledgement, sequence } = parsed.data;
			// No human flow can audit an agent author, so such a row did not come from this inbox. It is not loaded.
			if (directive.author.kind === "agent") {
				report.skipped.push({ index, directiveId: directive.id, code: "agent-author-refused", issues: [] });
				continue;
			}
			const current = this.records.get(directive.id);
			if (current !== undefined && (current.state === "acknowledged" || acknowledgement == null)) {
				report.unchanged.push(directive.id);
				continue;
			}
			// A directive this process has not seen keeps the sequence it was delivered with. An entry written before sequences were stored takes its session's next.
			// The number is read before either map is written, so a failed read leaves no record without its number.
			const known = this.sequences.get(directive.id);
			const assigned = known ?? (await this.restoredSequence(directive.targetSessionId, sequence ?? null));
			this.records.set(directive.id, recordFromStore(directive, queuedAtMs, acknowledgement ?? null));
			this.sequences.set(directive.id, assigned);
			report.restored.push(directive.id);
		}
		return report;
	}

	private async restoredSequence(sessionId: string, stored: number | null): Promise<number> {
		if (stored === null) return this.store.nextSequence(sessionId);
		await this.store.advancePast(sessionId, stored);
		return stored;
	}

	private async doExpireStale(nowMs: number): Promise<SteeringExpiryReport> {
		const ttlMs = this.deps.policy.ackTtlMs ?? null;
		const report: SteeringExpiryReport = { ttlMs, checked: 0, expired: [], adopted: [], failed: [], deferred: 0 };
		const due: Array<Extract<SteeringRecord, { state: "queued" }>> = [];
		for (const record of this.records.values()) {
			if (record.state !== "queued") continue;
			report.checked += 1;
			if (ttlMs !== null && nowMs - record.queuedAtMs >= ttlMs) due.push(record);
		}
		if (ttlMs === null) return report;
		due.sort((a, b) => a.queuedAtMs - b.queuedAtMs || compareText(a.directive.id, b.directive.id));

		let attempted = 0;
		for (const record of due.slice(0, STEERING_EXPIRY_BATCH)) {
			attempted += 1;
			const { directive } = record;
			const deadlineMs = record.queuedAtMs + ttlMs;
			const audited = await this.auditExpiry({
				event: "acknowledged",
				atMs: deadlineMs,
				directiveId: directive.id,
				targetSessionId: directive.targetSessionId,
				outcome: "declined",
				confirmed: false,
				reason: "timeout",
			});
			if (audited.ok) {
				this.records.set(
					directive.id,
					recordFromStore(directive, record.queuedAtMs, { atMs: deadlineMs, outcome: "declined", confirmed: false, reason: "timeout" }),
				);
				report.expired.push(directive.id);
				continue;
			}
			if (audited.lastErrorCode === AUDIT_CONFLICT_CODE) {
				// The key holds a different acknowledgement: another process closed this directive first. Take its word.
				const stored = await this.readStoredAcknowledgement(directive.id);
				if (stored !== null) {
					this.records.set(directive.id, recordFromStore(directive, record.queuedAtMs, stored));
					report.adopted.push(directive.id);
				} else {
					report.failed.push({ directiveId: directive.id, lastErrorCode: audited.lastErrorCode });
				}
				continue;
			}
			// The audit store is unavailable. The directive stays pending, and the pass ends so an outage is not hammered.
			report.failed.push({ directiveId: directive.id, lastErrorCode: audited.lastErrorCode });
			break;
		}
		report.deferred = due.length - attempted;
		return report;
	}

	/** Append with the bounded retry, except that a conflict is final: the same key and payload will conflict again. */
	private async auditExpiry(entry: SteeringAuditEntry): Promise<{ ok: true } | { ok: false; lastErrorCode: string }> {
		let lastErrorCode = "UNKNOWN";
		for (let attempt = 0; attempt < STEERING_AUDIT_ATTEMPTS; attempt++) {
			try {
				await this.deps.history.append(entry);
				return { ok: true };
			} catch (cause) {
				lastErrorCode = errnoCode(cause);
				if (lastErrorCode === AUDIT_CONFLICT_CODE) break;
			}
		}
		return { ok: false, lastErrorCode };
	}

	/** The acknowledgement another process saved, validated at the edge. Null when the sink cannot read it or it is not well formed. */
	private async readStoredAcknowledgement(directiveId: string): Promise<SteeringStoredAcknowledgement | null> {
		const read = this.deps.history.readAcknowledgement;
		if (read === undefined) return null;
		try {
			const parsed = SteeringStoredAcknowledgementSchema.safeParse(await read.call(this.deps.history, directiveId));
			return parsed.success ? parsed.data : null;
		} catch {
			// A failed read leaves the directive pending; the caller reports it as failed, with the conflict code.
			return null;
		}
	}

	/**
	 * The time a transition was saved with, so a retry reuses it and its audit content is unchanged. A sink with no durable
	 * store has none, and every attempt takes a fresh time. A failed read is an audit failure, never a guess.
	 */
	private async savedTransitionAtMs(event: "queued" | "acknowledged", directiveId: string): Promise<SteeringResult<number | null>> {
		const history = this.deps.history;
		if (history.savedAtMs === undefined) return { ok: true, value: null };
		let lastErrorCode = "UNKNOWN";
		for (let attempt = 0; attempt < STEERING_AUDIT_ATTEMPTS; attempt++) {
			try {
				return { ok: true, value: await history.savedAtMs(event, directiveId) };
			} catch (cause) {
				lastErrorCode = errnoCode(cause);
			}
		}
		return fail({ code: "audit-unavailable", attempts: STEERING_AUDIT_ATTEMPTS, lastErrorCode });
	}

	/** Append with a bounded retry, inside `unit` when the store opened one. Failure is returned with the last error code, never swallowed. */
	private async audit(entry: SteeringAuditEntry, unit?: SteeringUnit): Promise<SteeringResult<void>> {
		let lastErrorCode = "UNKNOWN";
		for (let attempt = 0; attempt < STEERING_AUDIT_ATTEMPTS; attempt++) {
			try {
				await this.deps.history.append(entry, unit);
				return { ok: true, value: undefined };
			} catch (cause) {
				lastErrorCode = errnoCode(cause);
			}
		}
		return fail({ code: "audit-unavailable", attempts: STEERING_AUDIT_ATTEMPTS, lastErrorCode });
	}

	/** The bucket for a session with refill applied up to `nowMs`. Does not store the result. */
	private refilled(sessionId: string, nowMs: number): TokenBucket {
		const bucket = this.buckets.get(sessionId) ?? { tokens: this.capacity, updatedAtMs: nowMs };
		// A clock that moved backwards refills nothing; it never mints tokens.
		const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
		const tokens = Math.min(this.capacity, bucket.tokens + (elapsedMs * this.capacity) / RATE_WINDOW_MS);
		return { tokens, updatedAtMs: nowMs };
	}

	/** The time the limiter uses: the largest reading seen so far. A backwards step is ignored, so it refills nothing. */
	private limiterNowMs(): number {
		this.highestMs = Math.max(this.highestMs, this.deps.clock.nowMs());
		return this.highestMs;
	}

	/**
	 * Runs one mutating call after the previous one settles. The tail never rejects, so one failed
	 * call cannot wedge the lock; the failure still reaches its own caller through the returned promise.
	 */
	private exclusive<T>(run: () => Promise<T>): Promise<T> {
		const next = this.tail.then(run);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

type SteeringConfigReason = "not-boolean" | "not-integer" | "out-of-range" | "invalid-principal" | "empty-principal";

export interface SteeringConfigError {
	key: string;
	reason: SteeringConfigReason;
	/** Present for `out-of-range` only. The value itself is never echoed. */
	min?: number;
	max?: number;
}

interface SteeringSettings extends SteeringPolicy {
	/** The enable flag. Default off. Nothing in this module reads it; wiring does. */
	enabled: boolean;
}

export type SteeringConfigResult = { ok: true; settings: SteeringSettings } | { ok: false; errors: SteeringConfigError[] };

/**
 * Steering settings from the environment. Every malformed value is a typed error, reported with its
 * key, and never a silent fallback. An unset key takes its default. A set key that is blank counts as
 * malformed, except the principal list, where blank means an empty list.
 */
export function loadSteeringSettings(env: Readonly<Record<string, string | undefined>>): SteeringConfigResult {
	const errors: SteeringConfigError[] = [];
	const enabled = booleanSetting(env, STEERING_ENABLED_ENV, false, errors);
	const allowlist = principalSetting(env, STEERING_PRINCIPALS_ENV, errors);
	const ratePerMin = integerSetting(env, STEERING_RATE_PER_MIN_ENV, DEFAULT_STEERING_RATE_PER_MIN, STEERING_RATE_BOUNDS, errors);

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, settings: { enabled, allowlist, ratePerMin } };
}

interface SteeringExpirySettings {
	/** Milliseconds a directive may stay queued before it expires as `declined:timeout`. */
	ackTtlMs: number;
	/** Milliseconds between {@link SteeringInbox.expireStale} passes, for the process that owns the timer. */
	expirySweepMs: number;
}

export type SteeringExpiryConfigResult = { ok: true; settings: SteeringExpirySettings } | { ok: false; errors: SteeringConfigError[] };

/**
 * The acknowledgement deadline and the sweep interval, from the environment. Both are whole seconds in the
 * environment. A malformed or out-of-range value is a typed error naming its key, never a fallback; an unset key
 * takes its default. Separate from {@link loadSteeringSettings} so that loader's result is unchanged.
 */
export function loadSteeringExpirySettings(env: Readonly<Record<string, string | undefined>>): SteeringExpiryConfigResult {
	const errors: SteeringConfigError[] = [];
	const ttlS = integerSetting(env, STEERING_ACK_TTL_ENV, DEFAULT_STEERING_ACK_TTL_S, STEERING_ACK_TTL_BOUNDS_S, errors);
	const sweepS = integerSetting(env, STEERING_EXPIRY_SWEEP_ENV, DEFAULT_STEERING_EXPIRY_SWEEP_S, STEERING_EXPIRY_SWEEP_BOUNDS_S, errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, settings: { ackTtlMs: ttlS * 1_000, expirySweepMs: sweepS * 1_000 } };
}

/** The keyed-queue replay retention and capacity the inbox runs with. */
interface SteeringIdempotencySettings {
	/** Milliseconds a keyed queue replays after it was queued. */
	ttlMs: number;
	/** The most keyed queues the store keeps. */
	cap: number;
}

export type SteeringIdempotencyConfigResult = { ok: true; settings: SteeringIdempotencySettings } | { ok: false; errors: SteeringConfigError[] };

/**
 * The keyed-queue replay retention and capacity, from the environment. The retention is whole seconds and the cap is whole records. A
 * malformed or out-of-range value is a typed error naming its key, never a fallback; an unset key takes its default.
 */
export function loadSteeringIdempotencySettings(env: Readonly<Record<string, string | undefined>>): SteeringIdempotencyConfigResult {
	const errors: SteeringConfigError[] = [];
	const ttlS = integerSetting(env, STEERING_IDEMPOTENCY_TTL_ENV, DEFAULT_STEERING_IDEMPOTENCY_TTL_S, STEERING_IDEMPOTENCY_TTL_BOUNDS_S, errors);
	const cap = integerSetting(env, STEERING_IDEMPOTENCY_CAP_ENV, DEFAULT_STEERING_IDEMPOTENCY_CAP, STEERING_IDEMPOTENCY_CAP_BOUNDS, errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, settings: { ttlMs: ttlS * 1_000, cap } };
}

/**
 * Whether the steering tools are registered. They are when the switch is on, and also when it is malformed: a
 * malformed switch is answered by `misconfigured` results, never hidden as an absent tool. An unset or off switch
 * registers nothing, so the default install is unchanged.
 */
export function steeringToolsRegistered(env: Readonly<Record<string, string | undefined>>): boolean {
	const raw = env[STEERING_ENABLED_ENV];
	if (raw === undefined) return false;
	return FALSE_WORDS[raw.trim().toLowerCase()] !== true;
}

function booleanSetting(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	fallback: boolean,
	errors: SteeringConfigError[],
): boolean {
	const raw = env[key];
	if (raw === undefined) return fallback;
	const word = raw.trim().toLowerCase();
	if (TRUE_WORDS[word] === true) return true;
	if (FALSE_WORDS[word] === true) return false;
	errors.push({ key, reason: "not-boolean" });
	return fallback;
}

function principalSetting(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	errors: SteeringConfigError[],
): string[] {
	const raw = env[key];
	if (raw === undefined || raw.trim() === "") return [];
	const principals = new Set<string>();
	for (const entry of raw.split(",")) {
		const id = entry.trim();
		if (id === "") {
			errors.push({ key, reason: "empty-principal" });
		} else if (!PRINCIPAL_RE.test(id)) {
			errors.push({ key, reason: "invalid-principal" });
		} else {
			principals.add(id);
		}
	}
	return [...principals].sort(compareText);
}

function integerSetting(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	fallback: number,
	bounds: { min: number; max: number },
	errors: SteeringConfigError[],
): number {
	const raw = env[key];
	if (raw === undefined) return fallback;
	if (!/^[0-9]+$/.test(raw)) {
		errors.push({ key, reason: "not-integer" });
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
		errors.push({ key, reason: "out-of-range", min: bounds.min, max: bounds.max });
		return fallback;
	}
	return value;
}

/** The code a conflicting append carries: the key holds a row with a different payload. */
const AUDIT_CONFLICT_CODE = "AUDIT_CONFLICT";

function recordFromStore(directive: SteeringDirective, queuedAtMs: number, ack: SteeringStoredAcknowledgement | null): SteeringRecord {
	if (ack === null) return { state: "queued", directive, queuedAtMs };
	const record: SteeringRecord = {
		state: "acknowledged",
		directive,
		queuedAtMs,
		acknowledgedAtMs: ack.atMs,
		outcome: ack.outcome,
		confirmed: ack.confirmed,
	};
	if (ack.reason != null) record.reason = ack.reason;
	return record;
}

/** The directive id of an unvalidated restore entry, only when it is well formed; else null. Never an arbitrary value. */
function wellFormedDirectiveId(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null || !("directive" in entry)) return null;
	const directive = entry.directive;
	if (typeof directive !== "object" || directive === null || !("id" in directive)) return null;
	return typeof directive.id === "string" && DIRECTIVE_ID_RE.test(directive.id) ? directive.id : null;
}

/** Thrown inside a keyed claim when its audit write is refused: the store rolls the claim back and rethrows it, and the inbox reports the refusal. */
class AuditRefused extends Error {
	constructor(readonly refusal: SteeringError) {
		super("steering audit refused");
		this.name = "AuditRefused";
	}
}

function fail<T>(error: SteeringError): SteeringResult<T> {
	return { ok: false, error };
}

/** Field paths only. Issue messages can echo input values, and a body may hold a secret. */
function issuePaths(error: z.ZodError): string[] {
	return error.issues.map((issue) => issue.path.map(String).join(".") || "(root)");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDirectives(a: SteeringDirective, b: SteeringDirective): number {
	return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAtMs - b.createdAtMs || compareText(a.id, b.id);
}

/**
 * Records read back from the durable audit history, validated by the schema `restore` uses but loaded into no inbox: an entry
 * that fails it, or names an agent as author, is left out. The caller merges them with what the inbox holds. Never throws.
 */
export function steeringRecordsFromEntries(entries: readonly unknown[]): SteeringRecord[] {
	const records: SteeringRecord[] = [];
	for (const entry of entries) {
		const parsed = SteeringRestoreEntrySchema.safeParse(entry);
		if (!parsed.success || parsed.data.directive.author.kind === "agent") continue;
		records.push(recordFromStore(parsed.data.directive, parsed.data.queuedAtMs, parsed.data.acknowledgement ?? null));
	}
	return records;
}
