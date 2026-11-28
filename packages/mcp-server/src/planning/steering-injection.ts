/**
 * Event-driven steering injection (phase 104, F5 steering injection v2).
 *
 * Omp injects event updates into live sessions' TODO inboxes: only subscribed
 * sessions receive them, each event injects at most once per session, and every
 * failure is visible with a retry path. No new inbox, table, or coordination
 * store: the existing {@link SteeringInbox} holds directives, the phase-77
 * keyed idempotency names them, and the audit sink keeps the trail.
 *
 * - Key: `injectionKey(eventId, sessionId)` = the keyed directive id for
 *   surface `steering-injection` over `sessionId:eventId`. A duplicate delivery
 *   replays the stored reply (inbox row, then durable keyed row) — never a
 *   second directive.
 * - Ordering: per-session lane plus a short hold-back buffer. Concurrent
 *   arrivals settle into `(occurred_at, seq)` order before they enter the
 *   inbox, so `queuedFor` reads back in event order. Sequential arrivals keep
 *   arrival order (the producer's order).
 * - Failures: every attempt ends `injected | filtered | failed-visible`.
 *   `failed-visible` is kept in the per-session failure log (queryable via
 *   `failuresFor` / `failureCountFor`) and retried with the SAME key, so a
 *   retry can never duplicate.
 *
 * Safety (phase 104 addendum, enforced here):
 * - Allowlisted actions only (`annotate`, `redirect`); anything else filters.
 * - Bodies capped at {@link STEERING_INJECTION_BODY_MAX} and redacted.
 * - Instruction-injection patterns in the event summary filter the event.
 * - Propose-only: the injector queues, never acknowledges. One-step revert is
 *   `revertInjection` (acknowledge `declined`).
 * - Per-session rate limit plus a kill switch (`setEnabled(false)`).
 * - Loop guards: steering's own events never match (see subscriptions), and an
 *   event naming its own injection directive filters as a loop.
 */
import { redact } from "../redact.ts";
import { keyedDirectiveId, queueFingerprint, SteeringIdempotency } from "./steering-idempotency.ts";
import { STEERING_BODY_MAX, type SteeringInbox, type SteeringDirective } from "./steering.ts";
import type { SteeringDurableReplies, SteeringKeyedQueueSaved } from "./steering-store.ts";
import { matchesSubscription, type SteeringSubscriptions, type SteeringSourceEvent } from "./steering-subscriptions.ts";

/** Idempotency surface: the injector's key namespace. */
export const STEERING_INJECTION_SURFACE = "steering-injection";

/** The keyed directive id for one event in one session. Duplicates replay, never re-queue. */
export function injectionKey(eventId: string, sessionId: string): string {
	return keyedDirectiveId(STEERING_INJECTION_SURFACE, `${sessionId}:${eventId}`);
}

/** Post-redaction body cap for injected directives (well under the inbox 4k limit). */
export const STEERING_INJECTION_BODY_MAX = 1_024;

/** Actions the injector may queue. `pause` stays operator-only: never auto-proposed. */
export const INJECTION_ALLOWED_ACTIONS = ["annotate", "redirect"] as const;
export type InjectionAction = (typeof INJECTION_ALLOWED_ACTIONS)[number];

/** First subscribed kind this injector consumes (phase 102 refresh events). Extensible per kind. */
export const INJECTION_DEFAULT_KINDS = ["planning.changed"] as const;
/** Kind to queued action. Unknown kinds propose `annotate`: every value here must stay allowlisted. */
const ACTION_BY_KIND: Record<string, InjectionAction> = { "planning.changed": "annotate" };

/** Retry budget: one attempt plus this many retries, then the failure stays terminal-visible. */
export const STEERING_INJECTION_MAX_ATTEMPTS = 3;

/** Summaries matching this are instruction-injection attempts, not steering content. */
const INJECTION_HAZARD_RE =
	/ignore\s+(all\s+)?(previous|prior)\s+instructions|disregard\s+(all\s+)?(prior|previous|system)|system\s+prompt|exfiltrat|disable\s+safet/i;

export type InjectionResult =
	| { status: "injected"; directiveId: string; sessionId: string; duplicate: boolean }
	| { status: "filtered"; sessionId: string; eventId: string; reason: string }
	| { status: "failed-visible"; sessionId: string; eventId: string; reason: string; attempts: number };

export interface InjectionFailure {
	sessionId: string;
	eventId: string;
	kind: string;
	reason: string;
	attempts: number;
	atMs: number;
	state: "terminal";
	event: SteeringSourceEvent;
}

export interface SteeringInjectorDeps {
	inbox: SteeringInbox;
	subscriptions: SteeringSubscriptions;
	clock: { nowMs(): number };
	operatorSurface?: string | undefined;
	durable?: Pick<SteeringDurableReplies, "savedKeyedQueue"> | null | undefined;
	lane?: SteeringIdempotency<InjectionResult> | undefined;
	orderHoldMs?: number | undefined;
	sleep?: ((ms: number) => Promise<void>) | undefined;
	maxAttempts?: number | undefined;
	backoffMs?: ((attempt: number) => number) | undefined;
	ratePerMin?: number | undefined;
}

function compareEvents(a: SteeringSourceEvent, b: SteeringSourceEvent): number {
	return a.occurredAtMs - b.occurredAtMs || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function errnoOf(cause: unknown): string {
	if (typeof cause === "object" && cause !== null && "code" in cause) {
		const code: unknown = cause.code;
		if (typeof code === "string") return code;
	}
	return "UNKNOWN";
}

export class SteeringInjector {
	private readonly inbox: SteeringInbox;
	private readonly subscriptions: SteeringSubscriptions;
	private readonly clock: { nowMs(): number };
	private readonly operatorSurface: string;
	private readonly durable: Pick<SteeringDurableReplies, "savedKeyedQueue"> | null;
	private readonly lane: SteeringIdempotency<InjectionResult>;
	private readonly orderHoldMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly maxAttempts: number;
	private readonly backoffMs: (attempt: number) => number;
	private readonly ratePerMin: number;
	private enabled = true;
	private readonly applied = new Set<string>();
	private readonly buffers = new Map<string, Map<string, SteeringSourceEvent>>();
	private readonly failures = new Map<string, InjectionFailure>();
	private readonly rates = new Map<string, { windowStartMs: number; count: number }>();

	constructor(deps: SteeringInjectorDeps) {
		this.inbox = deps.inbox;
		this.subscriptions = deps.subscriptions;
		this.clock = deps.clock;
		this.operatorSurface = deps.operatorSurface ?? "omp";
		this.durable = deps.durable ?? null;
		this.lane = deps.lane ?? new SteeringIdempotency<InjectionResult>();
		this.orderHoldMs = deps.orderHoldMs ?? 0;
		const sleep = deps.sleep;
		this.sleep =
			sleep ??
			((ms) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				return promise;
			});
		this.maxAttempts = deps.maxAttempts ?? STEERING_INJECTION_MAX_ATTEMPTS;
		this.backoffMs = deps.backoffMs ?? ((attempt) => Math.min(100 * 2 ** (attempt - 1), 1_000));
		this.ratePerMin = deps.ratePerMin ?? 30;
	}

	/** Kill switch: false filters every event (visible as `kill-switch`), true restores. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/** Injects one event into every matching subscribed session. Never throws. */
	async maybeInject(event: SteeringSourceEvent): Promise<InjectionResult[]> {
		const matches = this.subscriptions.active().filter((sub) => matchesSubscription(sub, event));
		if (!this.enabled) {
			return matches.map((sub) => ({ status: "filtered", sessionId: sub.sessionId, eventId: event.id, reason: "kill-switch" }) as const);
		}
		if (matches.length === 0) return [];
		// Buffer first so concurrent arrivals settle into (occurred_at, seq) order at drain time.
		for (const sub of matches) {
			let buffer = this.buffers.get(sub.sessionId);
			if (buffer === undefined) {
				buffer = new Map();
				this.buffers.set(sub.sessionId, buffer);
			}
			if (!this.applied.has(this.keyOf(sub.sessionId, event.id))) buffer.set(event.id, event);
		}
		// Hold-back lets co-arrivals land before the lane drains in event order.
		await this.sleep(this.orderHoldMs);
		const results: InjectionResult[] = [];
		for (const sub of matches) {
			results.push(await this.lane.serialize(STEERING_INJECTION_SURFACE, sub.sessionId, () => this.drainSession(sub.sessionId, event.id)));
		}
		return results;
	}

	/** Re-enters one terminal failure with the SAME key: a retry can never duplicate. */
	async retry(sessionId: string, eventId: string): Promise<InjectionResult> {
		const failure = this.failures.get(this.keyOf(sessionId, eventId));
		if (failure === undefined) {
			return { status: "filtered", sessionId, eventId, reason: "no-such-failure" };
		}
		return this.lane.serialize(STEERING_INJECTION_SURFACE, sessionId, () => this.attempt(failure.event, sessionId));
	}

	/** One-step revert of a proposed injection: acknowledges the directive `declined`. Never throws. */
	async revertInjection(sessionId: string, eventId: string): Promise<boolean> {
		try {
			const result = await this.inbox.acknowledge({
				directiveId: injectionKey(eventId, sessionId),
				sessionId,
				outcome: "declined",
			});
			return result.ok;
		} catch {
			return false;
		}
	}

	/** Terminal-visible failures for one session, oldest first. A read: changes nothing. */
	failuresFor(sessionId: string): InjectionFailure[] {
		return [...this.failures.values()]
			.filter((failure) => failure.sessionId === sessionId)
			.sort((a, b) => a.atMs - b.atMs || (a.eventId < b.eventId ? -1 : 1))
			.map((failure) => structuredClone(failure));
	}

	/** How many terminal failures one session holds: the notice-count hook. */
	failureCountFor(sessionId: string): number {
		let count = 0;
		for (const failure of this.failures.values()) if (failure.sessionId === sessionId) count += 1;
		return count;
	}

	private keyOf(sessionId: string, eventId: string): string {
		return `${sessionId}\0${eventId}`;
	}

	/** Drains one session's buffer in (occurred_at, seq) order. Runs inside the session lane. */
	private async drainSession(sessionId: string, eventId: string): Promise<InjectionResult> {
		const buffer = this.buffers.get(sessionId);
		const ordered = [...(buffer?.values() ?? [])].sort(compareEvents);
		let mine: InjectionResult = { status: "filtered", sessionId, eventId, reason: "superseded" };
		for (const next of ordered) {
			const result = await this.attempt(next, sessionId);
			buffer?.delete(next.id);
			if (next.id === eventId) mine = result;
		}
		if (buffer?.size === 0) this.buffers.delete(sessionId);
		// The caller's event may have been drained by a co-arrival: report the applied truth.
		if (mine.status === "filtered" && mine.reason === "superseded" && this.applied.has(this.keyOf(sessionId, eventId))) {
			return { status: "injected", directiveId: injectionKey(eventId, sessionId), sessionId, duplicate: true };
		}
		return mine;
	}

	private async attempt(event: SteeringSourceEvent, sessionId: string): Promise<InjectionResult> {
		const key = this.keyOf(sessionId, event.id);
		if (this.applied.has(key)) {
			return { status: "injected", directiveId: injectionKey(event.id, sessionId), sessionId, duplicate: true };
		}
		const precheck = this.precheck(event, sessionId);
		if (precheck !== null) return precheck;
		const id = injectionKey(event.id, sessionId);
		const body = this.bodyFor(event);
		const action: InjectionAction = ACTION_BY_KIND[event.kind] ?? "annotate";
		const fingerprint = queueFingerprint({
			action,
			priority: "normal",
			targetSessionId: sessionId,
			body,
			planRef: null,
			conflictsWithActivePlan: false,
		});
		const keyed = { surface: STEERING_INJECTION_SURFACE, key: `${sessionId}:${event.id}`, fingerprint };

		// Replay path: the open row answers first, then the durable keyed row (restart).
		const held = this.inbox.get(id);
		if (held !== null) {
			if (fingerprint !== queueFingerprint(recordFieldsOf(held.directive))) {
				return this.recordFailure(event, sessionId, "idempotency-conflict", this.maxAttempts);
			}
			this.applied.add(key);
			this.failures.delete(key);
			return { status: "injected", directiveId: id, sessionId, duplicate: true };
		}
		if (this.durable !== null) {
			let saved: SteeringKeyedQueueSaved | null;
			try {
				saved = await this.durable.savedKeyedQueue(STEERING_INJECTION_SURFACE, `${sessionId}:${event.id}`);
			} catch (cause) {
				return this.recordFailure(event, sessionId, `durable-unavailable:${errnoOf(cause)}`, 1);
			}
			if (saved !== null) {
				if (fingerprint !== saved.fingerprint) {
					return this.recordFailure(event, sessionId, "idempotency-conflict", this.maxAttempts);
				}
				this.applied.add(key);
				this.failures.delete(key);
				return { status: "injected", directiveId: saved.directiveId, sessionId, duplicate: true };
			}
		}

		let attempts = 0;
		for (;;) {
			attempts += 1;
			try {
				const result = await this.inbox.enqueue(
					{
						id,
						author: { principalId: this.operatorSurface, kind: "human" },
						createdAtMs: this.clock.nowMs(),
						priority: "normal",
						targetSessionId: sessionId,
						action,
						body,
						conflictsWithActivePlan: false,
					},
					keyed,
				);
				if (result.ok) {
					this.applied.add(key);
					this.failures.delete(key);
					this.noteRate(sessionId);
					return { status: "injected", directiveId: id, sessionId, duplicate: false };
				}
				if (result.error.code === "duplicate-directive") {
					this.applied.add(key);
					this.failures.delete(key);
					return { status: "injected", directiveId: id, sessionId, duplicate: true };
				}
				if (result.error.code === "rate-limited") {
					return { status: "filtered", sessionId, eventId: event.id, reason: "rate-limited" };
				}
				if (attempts >= this.maxAttempts) {
					return this.recordFailure(event, sessionId, `enqueue-${result.error.code}`, attempts);
				}
			} catch (cause) {
				if (attempts >= this.maxAttempts) {
					return this.recordFailure(event, sessionId, `enqueue-threw:${errnoOf(cause)}`, attempts);
				}
			}
			await this.sleep(this.backoffMs(attempts));
		}
	}

	/** Pure safety gate: kill switch, allowlist, loop, injection-hazard, rate. Null means proceed. */
	private precheck(event: SteeringSourceEvent, sessionId: string): InjectionResult | null {
		if (!this.enabled) return { status: "filtered", sessionId, eventId: event.id, reason: "kill-switch" };
		if (!INJECTION_ALLOWED_ACTIONS.includes(ACTION_BY_KIND[event.kind] ?? "annotate")) {
			return { status: "filtered", sessionId, eventId: event.id, reason: "action-not-allowed" };
		}
		if (event.summary !== undefined && INJECTION_HAZARD_RE.test(event.summary)) {
			return { status: "filtered", sessionId, eventId: event.id, reason: "instruction-injection" };
		}
		if (event.summary?.includes(STEERING_INJECTION_SURFACE) === true) {
			return { status: "filtered", sessionId, eventId: event.id, reason: "loop-guard" };
		}
		if (this.overRate(sessionId)) {
			return { status: "filtered", sessionId, eventId: event.id, reason: "rate-limited" };
		}
		return null;
	}

	private bodyFor(event: SteeringSourceEvent): string {
		const where = [event.repo, event.path ?? event.graph].filter((part) => part !== undefined && part !== "").join(" ");
		const raw = `Steering update ${event.kind}${where === "" ? "" : ` ${where}`} (event ${event.id}): ${event.summary ?? "planning state changed"}`;
		return redact(raw).slice(0, STEERING_INJECTION_BODY_MAX);
	}

	private overRate(sessionId: string): boolean {
		const now = this.clock.nowMs();
		const windowStart = now - (now % 60_000);
		const bucket = this.rates.get(sessionId);
		if (bucket === undefined || bucket.windowStartMs !== windowStart) return false;
		return bucket.count >= this.ratePerMin;
	}

	private noteRate(sessionId: string): void {
		const now = this.clock.nowMs();
		const windowStart = now - (now % 60_000);
		const bucket = this.rates.get(sessionId);
		if (bucket === undefined || bucket.windowStartMs !== windowStart) {
			this.rates.set(sessionId, { windowStartMs: windowStart, count: 1 });
		} else {
			bucket.count += 1;
		}
	}

	private recordFailure(event: SteeringSourceEvent, sessionId: string, reason: string, attempts: number): InjectionResult {
		const key = this.keyOf(sessionId, event.id);
		this.failures.set(key, {
			sessionId,
			eventId: event.id,
			kind: event.kind,
			reason,
			attempts,
			atMs: this.clock.nowMs(),
			state: "terminal",
			event: structuredClone(event),
		});
		return { status: "failed-visible", sessionId, eventId: event.id, reason, attempts };
	}
}

function recordFieldsOf(directive: SteeringDirective): {
	action: string;
	priority: string;
	targetSessionId: string;
	body: string;
	planRef: { phase: string; plan: string } | null;
	conflictsWithActivePlan: boolean;
} {
	return {
		action: directive.action,
		priority: directive.priority,
		targetSessionId: directive.targetSessionId,
		body: directive.body,
		planRef: directive.planRef ?? null,
		conflictsWithActivePlan: directive.conflictsWithActivePlan,
	};
}

/** Re-export for tests: the fingerprint input width the injector commits to. */
export { STEERING_BODY_MAX };
