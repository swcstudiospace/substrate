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
 * - No file writes. Nothing in this module touches the filesystem. Records live in memory; a
 *   durable store is a later wiring step.
 *
 * Every mutating call runs under one lock, so audit order, rate tokens and state never interleave.
 */
import { z } from "zod";
import { redact } from "../redact.ts";
import { errnoCode } from "./index.ts";
import { SESSION_ID_RE } from "./presence.ts";

export const STEERING_ENABLED_ENV = "SUBSTRATE_PLANNING_STEERING";
export const STEERING_PRINCIPALS_ENV = "SUBSTRATE_PLANNING_STEERING_PRINCIPALS";
export const STEERING_RATE_PER_MIN_ENV = "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN";

export const DEFAULT_STEERING_RATE_PER_MIN = 10;
/** Inclusive bounds. Outside them the value is refused, not clamped. */
export const STEERING_RATE_BOUNDS = { min: 1, max: 1_000 } as const;
/** The body limit applies to the input and again after redaction. */
export const STEERING_BODY_MAX = 4_096;
/** One attempt plus one retry for every audit write. */
export const STEERING_AUDIT_ATTEMPTS = 2;

/** The most retry times each retry map keeps. Past it the oldest is dropped, so a sink that stays down cannot grow memory. */
export const STEERING_RETRY_STATE_MAX = 256;

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

export const SteeringAcknowledgementSchema = z
	.object({
		directiveId: z.string().regex(DIRECTIVE_ID_RE),
		sessionId: z.string().regex(SESSION_ID_RE),
		outcome: z.enum(STEERING_OUTCOMES),
		confirm: z.boolean().optional(),
	})
	.strict();

export type SteeringAcknowledgement = z.infer<typeof SteeringAcknowledgementSchema>;

export type SteeringRecord =
	| { state: "queued"; directive: SteeringDirective; queuedAtMs: number }
	| {
			state: "acknowledged";
			directive: SteeringDirective;
			queuedAtMs: number;
			acknowledgedAtMs: number;
			outcome: SteeringOutcome;
			confirmed: boolean;
	  };

/** What the audit sink receives. Only the directive snapshot carries content, and it is already redacted. */
export type SteeringAuditEntry =
	| { event: "queued"; atMs: number; directive: SteeringDirective }
	| {
			event: "acknowledged";
			atMs: number;
			directiveId: string;
			targetSessionId: string;
			outcome: SteeringOutcome;
			confirmed: boolean;
	  };

/** The append-only history port (the `HistorySink` shape of phase 52, typed for steering entries). */
export interface SteeringHistorySink {
	append(entry: SteeringAuditEntry): Promise<void>;
}

export interface SteeringClock {
	nowMs(): number;
}

export interface SteeringPolicy {
	/** Principal ids allowed to author directives. Empty refuses everyone. */
	allowlist: readonly string[];
	/** Directives per minute per target session. */
	ratePerMin: number;
}

export interface SteeringInboxDeps {
	history: SteeringHistorySink;
	clock: SteeringClock;
	policy: SteeringPolicy;
}

type SimpleSteeringCode =
	| "agent-author-refused"
	| "principal-not-allowed"
	| "duplicate-directive"
	| "not-found"
	| "wrong-session"
	| "already-acknowledged"
	| "confirmation-required";

export type SteeringError =
	| { code: "invalid-directive" | "invalid-acknowledgement"; issues: string[] }
	| { code: "rate-limited"; retryAfterMs: number }
	| { code: "audit-unavailable"; attempts: number; lastErrorCode: string }
	| { code: SimpleSteeringCode };

export type SteeringResult<T> = { ok: true; value: T } | { ok: false; error: SteeringError };

interface TokenBucket {
	tokens: number;
	updatedAtMs: number;
}

export class SteeringInbox {
	private readonly records = new Map<string, SteeringRecord>();
	private readonly buckets = new Map<string, TokenBucket>();
	/** The largest clock reading the limiter has seen. Buckets refill against it, so a clock that steps back never refills. */
	private highestMs = Number.NEGATIVE_INFINITY;
	/** The transition time of an acknowledgement whose audit has not yet succeeded. A retry reuses it, so its audit content is unchanged. */
	private readonly pendingAcknowledgeAtMs = new Map<string, number>();
	/** The audit time of a queue whose audit has not yet succeeded. A retry reuses it, so its audit content is unchanged. */
	private readonly pendingQueueAtMs = new Map<string, number>();
	private readonly allowlist: ReadonlySet<string>;
	private readonly capacity: number;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: SteeringInboxDeps) {
		const { ratePerMin } = deps.policy;
		if (!Number.isSafeInteger(ratePerMin) || ratePerMin < STEERING_RATE_BOUNDS.min || ratePerMin > STEERING_RATE_BOUNDS.max) {
			throw new RangeError("ratePerMin must be an integer within the steering rate bounds");
		}
		this.capacity = ratePerMin;
		this.allowlist = new Set(deps.policy.allowlist);
	}

	/** Validate, authorise, rate-limit, audit, then queue. */
	enqueue(input: unknown): Promise<SteeringResult<SteeringRecord>> {
		return this.exclusive(() => this.doEnqueue(input));
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

	/** How many retry times the inbox holds across both retry maps. Bounded by {@link STEERING_RETRY_STATE_MAX} per map. */
	retryStateSize(): number {
		return this.pendingQueueAtMs.size + this.pendingAcknowledgeAtMs.size;
	}

	private async doEnqueue(input: unknown): Promise<SteeringResult<SteeringRecord>> {
		const parsed = SteeringDirectiveSchema.safeParse(input);
		if (!parsed.success) return fail({ code: "invalid-directive", issues: issuePaths(parsed.error) });
		const directive = parsed.data;

		if (directive.author.kind === "agent") return fail({ code: "agent-author-refused" });
		if (!this.allowlist.has(directive.author.principalId)) return fail({ code: "principal-not-allowed" });
		if (this.records.has(directive.id)) return fail({ code: "duplicate-directive" });

		const nowMs = this.pendingQueueAtMs.get(directive.id) ?? this.deps.clock.nowMs();
		const bucket = this.refilled(directive.targetSessionId, this.limiterNowMs());
		if (bucket.tokens < 1) {
			const retryAfterMs = Math.ceil(((1 - bucket.tokens) * RATE_WINDOW_MS) / this.capacity);
			return fail({ code: "rate-limited", retryAfterMs });
		}

		rememberRetryTime(this.pendingQueueAtMs, directive.id, nowMs);
		const audited = await this.audit({ event: "queued", atMs: nowMs, directive });
		if (!audited.ok) return audited;
		this.pendingQueueAtMs.delete(directive.id);

		this.buckets.set(directive.targetSessionId, { tokens: bucket.tokens - 1, updatedAtMs: bucket.updatedAtMs });
		const record: SteeringRecord = { state: "queued", directive, queuedAtMs: nowMs };
		this.records.set(directive.id, record);
		return { ok: true, value: structuredClone(record) };
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

		const nowMs = this.pendingAcknowledgeAtMs.get(directive.id) ?? this.deps.clock.nowMs();
		rememberRetryTime(this.pendingAcknowledgeAtMs, directive.id, nowMs);
		const audited = await this.audit({
			event: "acknowledged",
			atMs: nowMs,
			directiveId: directive.id,
			targetSessionId: directive.targetSessionId,
			outcome: ack.outcome,
			confirmed,
		});
		if (!audited.ok) return audited;
		this.pendingAcknowledgeAtMs.delete(directive.id);

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

	/** Append with a bounded retry. Failure is returned with the last error code, never swallowed. */
	private async audit(entry: SteeringAuditEntry): Promise<SteeringResult<void>> {
		let lastErrorCode = "UNKNOWN";
		for (let attempt = 0; attempt < STEERING_AUDIT_ATTEMPTS; attempt++) {
			try {
				await this.deps.history.append(entry);
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

export type SteeringConfigReason = "not-boolean" | "not-integer" | "out-of-range" | "invalid-principal" | "empty-principal";

export interface SteeringConfigError {
	key: string;
	reason: SteeringConfigReason;
	/** Present for `out-of-range` only. The value itself is never echoed. */
	min?: number;
	max?: number;
}

export interface SteeringSettings extends SteeringPolicy {
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

function fail<T>(error: SteeringError): SteeringResult<T> {
	return { ok: false, error };
}

/**
 * Keeps the audit time of a write that has not yet succeeded, so a retry reuses it. Re-keying moves the entry to the newest
 * position, and the oldest entries are dropped past the cap. An entry dropped that way is simply not reused: its retry takes
 * a fresh time, which is safe whenever nothing was saved under the old one.
 */
function rememberRetryTime(states: Map<string, number>, directiveId: string, atMs: number): void {
	states.delete(directiveId);
	states.set(directiveId, atMs);
	for (const oldest of states.keys()) {
		if (states.size <= STEERING_RETRY_STATE_MAX) break;
		states.delete(oldest);
	}
}

/** Field paths only. Issue messages can echo input values, and a body may hold a secret. */
function issuePaths(error: z.ZodError): string[] {
	return error.issues.map((issue) => issue.path.map(String).join(".") || "(root)");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareDirectives(a: SteeringDirective, b: SteeringDirective): number {
	return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAtMs - b.createdAtMs || compareText(a.id, b.id);
}
