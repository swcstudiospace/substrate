import { steeringSessionPayload, type SteeringSession, type SteeringSessionState } from "../event.ts";
import type { EventInput, Surface } from "../types.ts";
import type { SessionStateName, SessionStatePort, SessionTransitionContext, SessionTransitionResult } from "./steering-delivery.ts";
import type { LiveSessionAccess, LiveSessionAuthority } from "./steering-sessions-store.ts";

export const STEERING_ACKNOWLEDGE_VIA = "steering_acknowledge";
export const STEERING_SESSION_ENDED_ACTION = "steering.session_ended";

/** Public metadata only. Never spread a snapshot or arbitrary transition extras into the shared ledger. */
export function steeringSessionEvent(surface: Surface, session: SteeringSession, previous: SteeringSessionState | undefined, extra: Record<string, unknown> = {}): EventInput {
	return {
		surface,
		kind: session.state === "PAUSED" ? "warning" : "note",
		summary: `docs steering ${previous ?? "none"} -> ${session.state} for ${session.repo_id}`,
		session_id: session.session_id,
		repo: session.repo_id,
		payload: {
			...steeringSessionPayload({ session_id: session.session_id, repo_id: session.repo_id, state: session.state, updated_at: session.updated_at }, previous),
			...(typeof extra.directive_id === "string" ? { directive_id: extra.directive_id } : {}),
			...(extra.via === STEERING_ACKNOWLEDGE_VIA ? { via: STEERING_ACKNOWLEDGE_VIA } : {}),
		},
	};
}

interface LiveSessionStatePortDeps {
	authority: LiveSessionAuthority | null;
	emit: (event: EventInput) => Promise<unknown>;
}

/** Acknowledgements drive the same locked SQL state as lifecycle calls, never a second memory state machine. */
export class LiveSessionStatePort implements SessionStatePort {
	constructor(private readonly deps: LiveSessionStatePortDeps) {}

	async applyTransition(sessionKey: string, target: SessionStateName, context: SessionTransitionContext): Promise<SessionTransitionResult> {
		if (sessionKey !== context.sessionId || context.operation !== "operator-ack") return { ok: false, reason: "not-found" };
		const authority = this.deps.authority;
		if (authority === null) return { ok: false, reason: "session-unavailable" };
		const access: LiveSessionAccess = { caller: context.caller, sessionId: context.sessionId, ...(context.sessionBinding === undefined ? {} : { sessionBinding: context.sessionBinding }) };
		try {
			const checked = await authority.read(access, "operator-ack");
			if (!checked.ok) return { ok: false, reason: checked.error.code };
			const moved = await authority.transition(access, { repoId: checked.snapshot.session.repo_id, state: target }, "operator-ack");
			if (!moved.ok) return { ok: false, reason: moved.error.code };
			const changed = moved.previous !== undefined && moved.previous !== moved.snapshot.session.state;
			if (changed) {
				try { await this.deps.emit(steeringSessionEvent(moved.snapshot.ownerSurface, moved.snapshot.session, moved.previous, { directive_id: context.directiveId, via: STEERING_ACKNOWLEDGE_VIA })); }
				catch { /* A failed note cannot undo committed state or an effective acknowledgement. */ }
			}
			return { ok: true, changed };
		} catch { return { ok: false, reason: "session-unavailable" }; }
	}
}
