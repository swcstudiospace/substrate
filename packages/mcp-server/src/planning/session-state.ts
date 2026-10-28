/**
 * The one steering state model (phase 58, success criterion 2).
 *
 * Two mechanisms steer a live session: the `docs_steering_session` state machine (ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED,
 * `steeringStateTransition` in `event.ts`) and the planning inbox (`steering.ts`, queued directives a session acknowledges).
 * This registry is the place they meet. It holds the live sessions `docs_steering_session` writes, and it implements the
 * {@link SessionStatePort} the acknowledgement path drives, so an applied pause or redirect moves the same session that
 * `docs_steering_session` reads and writes. It adds no second state machine: every move goes through `nextSteeringSession`,
 * so the transition rules are the ones `docs_steering_session` already enforces.
 *
 * Sessions are keyed `${surface}:${session_id}`, as `docs_steering_session` holds them: a session belongs to the surface that
 * wrote it. A directive names only a session id (the inbox knows no surfaces), so the registry also indexes session id to keys.
 * The two id spaces are one when the caller uses the session's own id for both: `SESSION_ID_RE` (`presence.ts`) is the shape a
 * directive's target must have, and `docs_steering_session` accepts any string, so any session id the inbox can target is also
 * one the registry can hold. A session whose id the inbox cannot target simply never receives a directive.
 *
 * Process-local: a restart forgets the sessions, and past the cap the oldest is forgotten. The ledger keeps every transition as
 * an event. A directive acknowledged for a session the registry does not hold is refused by the port (the acknowledgement
 * stands); the registry cannot seed a session of its own because it does not know the session's repo.
 */
import { nextSteeringSession, steeringSessionPayload, type SteeringSession, type SteeringSessionState } from "../event.ts";
import type { EventInput, Surface } from "../types.ts";
import type { SessionStateName, SessionStatePort, SessionTransitionContext, SessionTransitionResult } from "./steering-delivery.ts";

/** The most sessions held. Past it the oldest is forgotten. */
export const STEERING_SESSION_CAP = 1000;

/** `payload.via` of a transition an acknowledgement drove. A transition `docs_steering_session` made carries no `via`. */
export const STEERING_ACKNOWLEDGE_VIA = "steering_acknowledge";

/** The store key of one session: the surface that holds it and its id. */
export function steeringSessionKey(surface: Surface, sessionId: string): string {
	return `${surface}:${sessionId}`;
}

/**
 * The one non-blocking `docs.steering` note a transition records: the existing steering payload, plus `extra` for a transition
 * an acknowledgement drove. A pause is a `warning`, every other state a `note`.
 */
export function steeringSessionEvent(surface: Surface, session: SteeringSession, previous: SteeringSessionState | undefined, extra: Record<string, unknown> = {}): EventInput {
	return {
		surface,
		kind: session.state === "PAUSED" ? "warning" : "note",
		summary: `docs steering ${previous ?? "none"} -> ${session.state} for ${session.repo_id}`,
		session_id: session.session_id,
		repo: session.repo_id,
		payload: { ...steeringSessionPayload(session, previous), ...extra },
	};
}

/** What the registry holds for one session id: nothing, several surfaces' sessions (no one can be chosen), or exactly one. */
export type SteeringSessionLookup = { status: "none" } | { status: "ambiguous" } | { status: "one"; surface: Surface; session: SteeringSession };

interface Held {
	surface: Surface;
	sessionId: string;
	session: SteeringSession;
}

export interface SteeringSessionRegistryDeps {
	/** Records the note a driven transition makes. A failure never undoes the transition: the registry absorbs it. */
	emit: (event: EventInput) => Promise<unknown>;
	nowMs?: () => number;
	/** Test seam; defaults to {@link STEERING_SESSION_CAP}. */
	cap?: number;
}

export class SteeringSessionRegistry implements SessionStatePort {
	private readonly held = new Map<string, Held>();
	/** Session id to the keys that hold it, so a directive (which names no surface) finds its session. */
	private readonly byId = new Map<string, Set<string>>();
	private readonly emit: (event: EventInput) => Promise<unknown>;
	private readonly nowMs: () => number;
	private readonly cap: number;

	constructor(deps: SteeringSessionRegistryDeps) {
		this.emit = deps.emit;
		this.nowMs = deps.nowMs ?? (() => Date.now());
		this.cap = deps.cap ?? STEERING_SESSION_CAP;
	}

	get size(): number {
		return this.held.size;
	}

	get(surface: Surface, sessionId: string): SteeringSession | undefined {
		return this.held.get(steeringSessionKey(surface, sessionId))?.session;
	}

	/** Stores or replaces one session and makes it the newest. Past the cap the oldest is forgotten. */
	put(surface: Surface, sessionId: string, session: SteeringSession): void {
		const key = steeringSessionKey(surface, sessionId);
		this.held.delete(key);
		if (this.held.size >= this.cap) {
			const oldest = this.held.keys().next();
			if (!oldest.done) this.forget(oldest.value);
		}
		this.held.set(key, { surface, sessionId, session });
		const keys = this.byId.get(sessionId) ?? new Set<string>();
		keys.add(key);
		this.byId.set(sessionId, keys);
	}

	/** The session an id names, across surfaces. A read: it changes nothing. */
	lookup(sessionId: string): SteeringSessionLookup {
		const keys = this.byId.get(sessionId);
		if (keys === undefined || keys.size === 0) return { status: "none" };
		if (keys.size > 1) return { status: "ambiguous" };
		const [key] = keys;
		const held = key === undefined ? undefined : this.held.get(key);
		return held === undefined ? { status: "none" } : { status: "one", surface: held.surface, session: held.session };
	}

	/**
	 * Moves the session a directive targets to `target`, by the state machine's own rules, and records one `docs.steering` note
	 * that names the directive. A session the registry does not hold, a session id two surfaces hold, and a transition the rules
	 * refuse are all refused and change nothing. `sessionKey` is the directive's target session id.
	 */
	async applyTransition(sessionKey: string, target: SessionStateName, context: SessionTransitionContext): Promise<SessionTransitionResult> {
		const found = this.lookup(sessionKey);
		if (found.status === "none") return { ok: false, reason: "session not registered" };
		if (found.status === "ambiguous") return { ok: false, reason: "ambiguous" };
		const { surface, session } = found;
		const next = nextSteeringSession(
			session,
			{
				session_id: session.session_id,
				repo_id: session.repo_id,
				state: target,
				...(session.planning_hash !== undefined ? { planning_hash: session.planning_hash } : {}),
				...(session.steering !== undefined ? { steering: session.steering } : {}),
			},
			this.nowMs(),
		);
		if (!next.ok) return { ok: false, reason: next.reason };
		this.put(surface, session.session_id, next.session);
		try {
			await this.emit(steeringSessionEvent(surface, next.session, next.previous, { directive_id: context.directiveId, via: STEERING_ACKNOWLEDGE_VIA }));
		} catch {
			// The transition is stored and the acknowledgement is audited; a note the ledger cannot take is not a refusal.
		}
		return { ok: true };
	}

	private forget(key: string): void {
		const held = this.held.get(key);
		this.held.delete(key);
		if (held === undefined) return;
		const keys = this.byId.get(held.sessionId);
		if (keys === undefined) return;
		keys.delete(key);
		if (keys.size === 0) this.byId.delete(held.sessionId);
	}
}
