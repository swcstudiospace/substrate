/**
 * Steering delivery (phase 58, live steering): how a queued directive reaches its session, and what an acknowledgement does.
 *
 * The inbox (`steering.ts`) is pull-only: a directive sat queued until its session called `steering_list`. This module is
 * the push half, and it adds no second inbox, no second state machine and no table:
 *
 * - {@link steeringNoticeFor}: the small `steering` notice a `docs_search` reply carries for the calling session. A count and
 *   at most {@link STEERING_NOTICE_MAX_ENTRIES} entries read from the one inbox. Nothing is read from the ledger.
 * - {@link sessionStateForAcknowledgement}: the pure mapping from an acknowledged directive to the live session state it
 *   asks for. `pause` + `applied` is `PAUSED`, `redirect` + `applied` is `CONTEXT_REFRESH`, and nothing else moves a
 *   session: an `annotate`, and every `declined` outcome (including the system's `timeout`), change nothing.
 * - {@link acknowledgeSteeringWithState}: the acknowledgement path. It runs the audited acknowledgement first, then asks a
 *   {@link SessionStatePort} to apply the mapped state. The port owns the transition rules: an illegal transition is
 *   REFUSED by it and reported, never forced, and it never undoes the acknowledgement (that is already audited).
 * - {@link SteeringHintAnnouncer}: one wake-up hint per queued directive. The hint rides the existing event bus as a stored
 *   `note` (`payload.action` `steering.queued`): the bus carries hints only, so neither the event nor the hint holds the body.
 * - {@link SteeringExpirySweeper}: the unref'd timer that closes directives nobody acknowledged (`expireStale`).
 *
 * The port is optional. Production wiring injects the live session registry (`session-state.ts`, `SteeringSessionRegistry`) as
 * the port whenever steering is on, so an applied pause or redirect moves the same session `docs_steering_session` reads and
 * writes: the two mechanisms share one state model. A caller that injects no port (a test seam) gets a plain acknowledgement
 * that changes no session state and says nothing about one.
 */
import { redact } from "../redact.ts";
import type { EventInput } from "../types.ts";
import type { PlanningTimerHandle, PlanningTimers } from "./observer.ts";
import type { SteeringDirective, SteeringExpiryReport, SteeringInbox, SteeringOutcome, SteeringPriority } from "./steering.ts";
import { acknowledgeSteering, type SteeringAcknowledgeInput, type SteeringCaller, type SteeringWiring, type SteeringWriteResult } from "./steering-tools.ts";

/** The most directives a notice lists. The count still states every queued directive. */
export const STEERING_NOTICE_MAX_ENTRIES = 3;
/** The longest body a notice entry carries, after redaction. */
export const STEERING_NOTICE_BODY_MAX = 200;

/** The framing every notice carries: the directive text is an operator's, described to the session and not obeyed on sight. */
export const STEERING_NOTICE_FRAMING =
	"Queued steering directives for this session, described and not executed: the session decides, then answers each with steering_acknowledge.";

export interface SteeringNoticeEntry {
	id: string;
	action: SteeringDirective["action"];
	priority: SteeringPriority;
	/** Milliseconds since the directive was queued, never negative. */
	age_ms: number;
	/** The directive body, redacted and cut to {@link STEERING_NOTICE_BODY_MAX} characters. */
	body: string;
}

/** What `docs_search` carries as `steering`: present only while at least one directive is queued for the calling session. */
export interface SteeringNotice {
	/** Every directive queued for the session, listed or not. */
	count: number;
	/** The first {@link STEERING_NOTICE_MAX_ENTRIES}, highest priority first, then oldest. */
	entries: SteeringNoticeEntry[];
	untrusted: string;
}

/**
 * The notice for one session, or null when nothing is queued for it. A read: it changes nothing in the inbox. `nowMs` is the
 * caller's clock, so the age is the caller's to inject.
 */
export function steeringNoticeFor(inbox: SteeringInbox, sessionId: string, nowMs: number): SteeringNotice | null {
	const queued = inbox.recordsFor(sessionId).filter((record) => record.state === "queued");
	if (queued.length === 0) return null;
	return {
		count: queued.length,
		entries: queued.slice(0, STEERING_NOTICE_MAX_ENTRIES).map((record) => ({
			id: record.directive.id,
			action: record.directive.action,
			priority: record.directive.priority,
			age_ms: Math.max(0, nowMs - record.queuedAtMs),
			body: redact(record.directive.body).slice(0, STEERING_NOTICE_BODY_MAX),
		})),
		untrusted: STEERING_NOTICE_FRAMING,
	};
}

/** The live session states, by name. The names are the live steering session's own; this module owns no state machine over them. */
export const SESSION_STATE_NAMES = ["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"] as const;
export type SessionStateName = (typeof SESSION_STATE_NAMES)[number];

/**
 * The state an acknowledged directive asks the session to move to, or null when it asks for none.
 *
 * | action   | outcome            | state           |
 * | -------- | ------------------ | --------------- |
 * | pause    | applied            | PAUSED          |
 * | redirect | applied            | CONTEXT_REFRESH |
 * | annotate | applied            | (unchanged)     |
 * | any      | declined / timeout | (unchanged)     |
 *
 * `CONTEXT_REFRESH` returns to `ACTIVE` by the live session machine's own rules; this function never asks for `ACTIVE` or `RESUMED`.
 */
export function sessionStateForAcknowledgement(ack: { action: SteeringDirective["action"]; outcome: SteeringOutcome; reason?: "timeout" | null }): SessionStateName | null {
	if (ack.outcome !== "applied") return null;
	switch (ack.action) {
		case "pause":
			return "PAUSED";
		case "redirect":
			return "CONTEXT_REFRESH";
		case "annotate":
			return null;
	}
}

export type SessionTransitionResult = { ok: true } | { ok: false; reason: string };

/** What the acknowledgement tells the port about the transition it asks for: the directive that drives it. */
export interface SessionTransitionContext {
	directiveId: string;
}

/**
 * The live session state, as the acknowledgement path sees it. `applyTransition` moves one session to `target` through the
 * state machine's own transition rules, and refuses (`ok: false`) what they refuse. It must not force a transition.
 * `sessionKey` is the directive's target session id; the adapter derives its own store key from it. The result may be a promise:
 * an adapter that records the transition in the ledger awaits that record.
 */
export interface SessionStatePort {
	applyTransition(sessionKey: string, target: SessionStateName, context: SessionTransitionContext): SessionTransitionResult | Promise<SessionTransitionResult>;
}

/** What the acknowledgement did to the session state. Absent from a reply when no port is wired. */
export type SessionStateOutcome = { status: "unchanged" } | { status: "applied"; state: SessionStateName } | { status: "refused"; state: SessionStateName; reason: string };

/**
 * A hint to the acknowledging session (its hook or agent), never an action of the server's, which stays read-only on worktrees:
 * the session moved to PAUSED or CONTEXT_REFRESH by a directive, so it may take a checkpoint with trigger `steering`.
 */
export interface SteeringCheckpointHint {
	trigger: "steering";
	directive_id: string;
}

export type SteeringAcknowledgeReply = SteeringWriteResult & { session_state?: SessionStateOutcome; checkpoint_hint?: SteeringCheckpointHint };

/**
 * Acknowledge a directive, then drive the session state from the outcome. The acknowledgement is audited first and stands
 * whatever the port says: a refused transition is reported in `session_state`, not rolled back. An applied pause or redirect
 * that moved the session also carries `checkpoint_hint` (the session may checkpoint). With no port the reply is exactly the acknowledgement's.
 */
export async function acknowledgeSteeringWithState(
	wiring: SteeringWiring,
	caller: SteeringCaller,
	input: SteeringAcknowledgeInput,
	port: SessionStatePort | null,
): Promise<SteeringAcknowledgeReply> {
	const result = await acknowledgeSteering(wiring, caller, input);
	if (result.status !== "acknowledged" || port === null || wiring.inbox === null) return result;
	const record = wiring.inbox.get(result.directive_id);
	if (record === null || record.state !== "acknowledged") return result;
	const target = sessionStateForAcknowledgement({ action: record.directive.action, outcome: record.outcome, reason: record.reason ?? null });
	if (target === null) return { ...result, session_state: { status: "unchanged" } };
	try {
		const moved = await port.applyTransition(record.directive.targetSessionId, target, { directiveId: result.directive_id });
		if (!moved.ok) return { ...result, session_state: { status: "refused", state: target, reason: redact(moved.reason).slice(0, 200) } };
		return { ...result, session_state: { status: "applied", state: target }, checkpoint_hint: { trigger: "steering", directive_id: result.directive_id } };
	} catch (cause) {
		// The acknowledgement is already audited and effective; a port that throws must not turn it into a failed call.
		// It is reported as a refused transition, with the cause redacted and cut.
		return { ...result, session_state: { status: "refused", state: target, reason: redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200) } };
	}
}

/** `payload.action` of the hint note. Added to the event vocabulary (`event-sources.ts`, `docs/event-vocabulary.md`). */
export const STEERING_QUEUED_ACTION = "steering.queued";

/**
 * The note a queued directive publishes: kind `note` on the `substrate` surface, so no kind and no surface is added. It names
 * the directive and its target and carries no body; the bus hint made from it is only the stored event's identity.
 */
export function steeringQueuedEvent(directive: Pick<SteeringDirective, "id" | "targetSessionId" | "action" | "priority">): EventInput {
	return {
		surface: "substrate",
		kind: "note",
		summary: `steering ${directive.action} queued for ${directive.targetSessionId}`,
		session_id: directive.targetSessionId,
		payload: {
			action: STEERING_QUEUED_ACTION,
			directive_id: directive.id,
			target_session_id: directive.targetSessionId,
			steering_action: directive.action,
			priority: directive.priority,
		},
	};
}

export type SteeringAnnounceOutcome = "announced" | "duplicate" | "not-stored" | "failed";

/** How many directive ids the announcer remembers. Past it the oldest is forgotten; a directive id is never reused, so this only bounds memory. */
export const ANNOUNCED_MAX = 10_000;

export interface SteeringHintAnnouncerDeps {
	/** The ledger ingest (`Substrate.emit`), which also publishes the bus hint of a stored event. Resolves true when stored. */
	emit: (event: EventInput) => Promise<boolean>;
	/** Where a failure is reported. Omitted: stderr. */
	report?: (line: string) => void;
}

/** One hint per directive id, per process. Never throws: a hint is a wake-up, and the directive is already queued and audited. */
export class SteeringHintAnnouncer {
	private readonly announced = new Set<string>();

	constructor(private readonly deps: SteeringHintAnnouncerDeps) {}

	async announce(directive: Pick<SteeringDirective, "id" | "targetSessionId" | "action" | "priority">): Promise<SteeringAnnounceOutcome> {
		if (this.announced.has(directive.id)) return "duplicate";
		this.remember(directive.id);
		try {
			if (await this.deps.emit(steeringQueuedEvent(directive))) return "announced";
			this.announced.delete(directive.id);
			return "not-stored";
		} catch (cause) {
			// Fail-open: the queue write was audited before this ran, so a hint that could not be sent costs the session one
			// poll interval (it still sees the directive on its next docs_search or steering_list), never the directive.
			this.announced.delete(directive.id);
			(this.deps.report ?? stderrReport)(`[substrate] steering hint failed: ${redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`);
			return "failed";
		}
	}

	private remember(id: string): void {
		this.announced.add(id);
		if (this.announced.size > ANNOUNCED_MAX) {
			const oldest = this.announced.values().next();
			if (!oldest.done) this.announced.delete(oldest.value);
		}
	}
}

function stderrReport(line: string): void {
	process.stderr.write(`${line}\n`);
}

const GLOBAL_TIMERS: PlanningTimers = {
	setInterval: (run, ms) => {
		const timer = setInterval(run, ms);
		timer.unref();
		return timer;
	},
	clearInterval: (timer: PlanningTimerHandle) => clearInterval(timer as NodeJS.Timeout),
};

export interface SteeringExpirySweeperDeps {
	inbox: SteeringInbox;
	/** Milliseconds between passes (`loadSteeringExpirySettings().expirySweepMs`). */
	intervalMs: number;
	/** The host clock in milliseconds. Omitted: `Date.now`. */
	nowMs?: () => number;
	/** The timers. Omitted: the global ones, unref'd. A test injects its own. */
	timers?: PlanningTimers;
	/** Where a pass that closed or failed to close a directive is reported. Omitted: stderr. */
	report?: (line: string) => void;
}

/**
 * Closes directives nobody acknowledged in time, on an unref'd timer. One pass at a time (a tick during a pass shares it),
 * no pass starts after `stop`, and `idle` waits for a pass in flight. A pass never rejects: a failure is reported once per
 * change of line, and the next pass tries again, since `expireStale` is idempotent.
 */
export class SteeringExpirySweeper {
	private timer: PlanningTimerHandle | undefined;
	private running: Promise<SteeringExpiryReport | null> | null = null;
	private stopped = false;
	private lastLine: string | null = null;
	private readonly timers: PlanningTimers;
	private readonly clock: () => number;
	private readonly reporter: (line: string) => void;

	constructor(private readonly deps: SteeringExpirySweeperDeps) {
		if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 1) throw new RangeError("intervalMs must be a positive integer number of milliseconds");
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.clock = deps.nowMs ?? Date.now;
		this.reporter = deps.report ?? stderrReport;
	}

	/** Start the timer. False when it is already started or has been stopped: a stopped sweeper never starts again. */
	start(): boolean {
		if (this.timer !== undefined || this.stopped) return false;
		this.timer = this.timers.setInterval(() => this.pass(), this.deps.intervalMs);
		return true;
	}

	/** Clear the timer and start no further pass. A pass in flight finishes; `idle` waits for it. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Resolves once no pass is in flight. Never rejects. */
	async idle(): Promise<void> {
		while (this.running !== null) await this.running;
	}

	/** One pass. A call during a pass shares it. After `stop` it does nothing and resolves null. */
	pass(): Promise<SteeringExpiryReport | null> {
		if (this.stopped) return Promise.resolve(null);
		if (this.running !== null) return this.running;
		const run = this.passOnce().finally(() => {
			this.running = null;
		});
		this.running = run;
		return run;
	}

	private async passOnce(): Promise<SteeringExpiryReport | null> {
		try {
			const report = await this.deps.inbox.expireStale(this.clock());
			this.note(report);
			return report;
		} catch (cause) {
			this.say(`[substrate] steering expiry pass failed: ${redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`);
			return null;
		}
	}

	private note(report: SteeringExpiryReport): void {
		const parts = [
			report.expired.length > 0 ? `${report.expired.length} expired as declined:timeout` : null,
			report.adopted.length > 0 ? `${report.adopted.length} adopted from another process` : null,
			report.failed.length > 0 ? `${report.failed.length} could not be closed (${[...new Set(report.failed.map((failure) => failure.lastErrorCode))].join(",")})` : null,
			report.deferred > 0 ? `${report.deferred} deferred` : null,
		].filter((part): part is string => part !== null);
		if (parts.length === 0) {
			this.lastLine = null;
			return;
		}
		this.say(`[substrate] steering expiry: ${parts.join("; ")}`);
	}

	/** A line is said when it differs from the last one, so a failure that repeats each pass is reported once. */
	private say(line: string): void {
		if (line === this.lastLine) return;
		this.lastLine = line;
		this.reporter(line);
	}
}
