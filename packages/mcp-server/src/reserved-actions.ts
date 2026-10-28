/**
 * The ledger actions an ordinary caller may not write through `events_emit` or `POST /events`.
 *
 * A reader of the ledger trusts some notes by their `payload.action` alone: a signer rotation retires a key, a forget batch
 * names memory to forget, a checkpoint or a rollback note is the record a rollback is judged by. The event carries no proof of
 * who wrote it (its `surface` is attribution a non-swarm token may choose, its `actor` is self-declared), so the only point
 * that can keep those notes honest is the door callers write through. These actions are written by the server itself
 * (`Substrate.emit` from `session_checkpoint`, `session_rollback_commit` and `memoryForget`, which do not pass this check) or,
 * for the signer rotation, by an operator; a tokened caller that is not an operator is refused, and an operator is held to its
 * own authenticated surface (the surface `operatorSurfaces` reads rotations from).
 *
 * ONE list: add an action here when a reader starts to treat it as authoritative.
 */
import { ANCHOR_SIGNER_ROTATE_ACTION } from "@substrate/ledger";
import { FORGET_ACTION } from "./memory-forget.ts";
import { SESSION_CHECKPOINT_ACTION, SESSION_ROLLBACK_ACTION, SESSION_ROLLBACK_REFUSED_ACTION } from "./session-events.ts";
import { FORGET_BATCH_ACTION } from "./session-rollback.ts";

export const RESERVED_NOTE_ACTIONS: ReadonlySet<string> = new Set([
	ANCHOR_SIGNER_ROTATE_ACTION,
	SESSION_CHECKPOINT_ACTION,
	SESSION_ROLLBACK_ACTION,
	SESSION_ROLLBACK_REFUSED_ACTION,
	FORGET_BATCH_ACTION,
	FORGET_ACTION,
]);

/** The reserved action a payload names, or null. `payload` is whatever the caller sent, so anything that is not an object names none. */
export function reservedActionOf(payload: unknown): string | null {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const action = (payload as Record<string, unknown>)["action"];
	return typeof action === "string" && RESERVED_NOTE_ACTIONS.has(action) ? action : null;
}

/**
 * Why an emit naming a reserved action is refused, or null when it may stand (not reserved, or an operator writing as itself).
 *
 * `surface` is the surface the event would be attributed to; `callerSurface` the token's own, null on an untokened local run.
 * Both refusals start with the stable name `reserved-action`, and nothing is written for either.
 */
export function reservedEmitRefusal(input: { payload: unknown; surface: string; callerSurface: string | null; isOperator: boolean }): string | null {
	const action = reservedActionOf(input.payload);
	if (action === null) return null;
	if (!input.isOperator) return `reserved-action: "${action}" is written by the substrate itself or by an operator, so this token cannot emit it; nothing was written`;
	if (input.callerSurface !== null && input.surface !== input.callerSurface) {
		return `reserved-action: "${action}" is attributed to the operator's own surface ${input.callerSurface}, not ${input.surface}; nothing was written`;
	}
	return null;
}
