/**
 * The ledger actions an ordinary caller may not write through `events_emit` or `POST /events`.
 *
 * A reader of the ledger trusts some notes by their `payload.action` alone: a signer rotation retires a key, a forget batch
 * names memory to forget, a checkpoint or a rollback note is the record a rollback is judged by. The event carries no proof of
 * who wrote it (its `surface` is attribution a non-swarm token may choose, its `actor` is self-declared), so the only point
 * that can keep those notes honest is the door callers write through. These actions are written by the server itself
 * (`Substrate.emit` from `session_checkpoint`, `session_rollback_commit` and `memoryForget`, which do not pass this check) or,
 * for the signer rotation and the re-anchor record, by an operator; a tokened caller that is not an operator is refused, and an operator is held to its
 * own authenticated surface (the surface `operatorSurfaces` reads rotations and re-anchors from).
 * The docs canary's report (`docs.canary`) is the one host-job action: only the `substrate` token acting as itself may write it.
 * The cross-layer reconcile's records (`reconcile.plan`, `reconcile.applied`) are written only by the reconcile run, straight to the ledger; no caller emits them through this door, an operator included.
 *
 * ONE list: add an action here when a reader starts to treat it as authoritative.
 */
import { ANCHOR_SIGNER_ROTATE_ACTION } from "@substrate/ledger";
import { RECONCILE_APPLIED_ACTION, RECONCILE_PLAN_ACTION } from "./cross-layer-reconcile.ts";
import { DOCS_CANARY_ACTION, DOCS_CANARY_SURFACE } from "./corpus/slo.ts";
import { CORPUS_ROOT_ACTION } from "./corpus/root.ts";
import { FORGET_ACTION } from "./memory-forget.ts";
import { ANCHOR_REANCHOR_ACTION } from "./reanchor-plan.ts";
import { SESSION_CHECKPOINT_ACTION, SESSION_ROLLBACK_ACTION, SESSION_ROLLBACK_REFUSED_ACTION } from "./session-events.ts";
import { FORGET_BATCH_ACTION } from "./session-rollback.ts";

export const RESERVED_NOTE_ACTIONS: ReadonlySet<string> = new Set([
	ANCHOR_SIGNER_ROTATE_ACTION,
	ANCHOR_REANCHOR_ACTION,
	SESSION_CHECKPOINT_ACTION,
	SESSION_ROLLBACK_ACTION,
	SESSION_ROLLBACK_REFUSED_ACTION,
	FORGET_BATCH_ACTION,
	FORGET_ACTION,
	DOCS_CANARY_ACTION,
	CORPUS_ROOT_ACTION,
	RECONCILE_PLAN_ACTION,
	RECONCILE_APPLIED_ACTION,
]);

/**
 * The reserved actions a host job writes with its own surface token rather than an operator: action to the one surface that may
 * write it. The `substrate` surface is never an operator (`isOperator` in `config.ts`), so the operator rule cannot cover it. The
 * docs canary's readings feed the recall gauge and the `corpus` fabric row, so a breach must not be hideable by any other caller.
 */
const HOST_JOB_ACTIONS: ReadonlyMap<string, string> = new Map([[DOCS_CANARY_ACTION, DOCS_CANARY_SURFACE]]);

/** The reconcile's own records. The reconcile run appends them straight to the ledger, which is not this door, so no caller may emit them here, an operator included. */
const RECONCILE_ACTIONS: ReadonlySet<string> = new Set([RECONCILE_PLAN_ACTION, RECONCILE_APPLIED_ACTION]);

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
	if (RECONCILE_ACTIONS.has(action)) return `reserved-action: "${action}" is written by the substrate's cross-layer reconcile run itself, so this caller cannot emit it; nothing was written`;
	// A host job's report: its own token, acting as itself, is the one authority. An operator is not (its event would carry no
	// weight with the reader), except a bare local run, which has no token to check.
	const hostJob = HOST_JOB_ACTIONS.get(action);
	if (hostJob !== undefined) {
		if (input.callerSurface === hostJob && input.surface === hostJob) return null;
		if (input.callerSurface === null && input.isOperator) return null;
		return `reserved-action: "${action}" is written by the substrate itself or by the ${hostJob} host job's own token, so this token cannot emit it; nothing was written`;
	}
	if (!input.isOperator) return `reserved-action: "${action}" is written by the substrate itself or by an operator, so this token cannot emit it; nothing was written`;
	if (input.callerSurface !== null && input.surface !== input.callerSurface) {
		return `reserved-action: "${action}" is attributed to the operator's own surface ${input.callerSurface}, not ${input.surface}; nothing was written`;
	}
	return null;
}
