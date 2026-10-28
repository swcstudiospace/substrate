/**
 * When an automatic checkpoint is worth taking (v1.6, phase 61, success criterion 3).
 *
 * A checkpoint hashes the whole worktree (`snapshot` in `@substrate/worktree-snapshot`), and a hook can fire
 * many times a minute, so the policy bounds the cost: a rate limit per trigger, a skip when nothing changed
 * since the last checkpoint, and one checkpoint per steering directive. This module is pure: the caller reads
 * the clock and the local checkpoints and passes them in, so every row of the table is testable with numbers.
 *
 * The cost reasoning is ADR 0007 ("The hook contract every proposal shares", "Cost"). The limits are
 * conservative defaults, not measurements: the cost of a snapshot on a large worktree is still unmeasured.
 *
 *   trigger      rule
 *   manual       always (an operator or agent asked)
 *   pre-restore  always (a rollback takes it itself, before any file changes)
 *   baseline     only while the session has no checkpoint yet
 *   turn         at most one per TURN_MIN_INTERVAL_MS, and not when the tree is unchanged
 *   plan-step    at most one per PLAN_STEP_MIN_INTERVAL_MS, and not when the tree is unchanged
 *   steering     one per directive id, otherwise unlimited, and not when the tree is unchanged
 */
import { createHash } from "node:crypto";
import type { CheckpointTrigger } from "../../../mcp-server/src/session-events.ts";

/**
 * One `turn` checkpoint a minute. A turn ends every few seconds in a busy session; a checkpoint per turn
 * would re-hash the worktree each time, and a rollback to "a minute ago" is as useful as one to "just now".
 */
export const TURN_MIN_INTERVAL_MS = 60_000;
/**
 * One `plan-step` checkpoint every ten seconds. Plan steps are rarer and each one is a place an operator
 * deliberately wants to return to, so the limit only absorbs a burst of steps completing together (a lane
 * ending, a commit hook firing twice).
 */
export const PLAN_STEP_MIN_INTERVAL_MS = 10_000;

/** The triggers a host hook may ask for (`manual` and `pre-restore` have their own commands). */
export const HOOK_TRIGGERS = ["turn", "plan-step", "steering", "baseline"] as const;
export type HookTrigger = (typeof HOOK_TRIGGERS)[number];

/** What the policy needs to know about an existing checkpoint of the session. */
export interface PolicyCheckpoint {
	/** The git tree id the checkpoint pinned. */
	treeId: string;
	/** Epoch milliseconds when it was pinned. Absent on a checkpoint pinned before the field existed. */
	takenAtMs?: number;
	trigger?: CheckpointTrigger;
}

export interface PolicyInput {
	trigger: CheckpointTrigger;
	nowMs: number;
	/** The session's newest checkpoint of any trigger: the baseline and unchanged-tree rules read it. */
	last?: PolicyCheckpoint;
	/**
	 * The session's newest checkpoint with THIS trigger: the rate limit reads it. When omitted, `last` is used
	 * if its trigger is this one (or unknown); a `last` of another trigger does not rate-limit.
	 */
	lastOfTrigger?: PolicyCheckpoint;
	/** Replaces the default interval of `turn` and `plan-step`. Ignored for every other trigger and when not a finite number >= 0. */
	minIntervalMs?: number;
	/** The worktree's tree id now. Leave it out to evaluate the cheap rules first, before paying for a snapshot. */
	currentTreeId?: string;
	/** `directiveKey(id)` of the steering directive being applied. */
	directiveKey?: string;
	/** The directive keys the session already has a steering checkpoint for. */
	seenDirectiveKeys?: ReadonlySet<string>;
}

export interface PolicyDecision {
	take: boolean;
	reason: string;
}

const take = (reason: string): PolicyDecision => ({ take: true, reason });
const skip = (reason: string): PolicyDecision => ({ take: false, reason });

/** The `plan_ref.step` that marks a checkpoint as the one for a steering directive (at most 64 characters, the contract's limit). */
export function directiveKey(directiveId: string): string {
	const key = `directive:${directiveId}`;
	return key.length <= 64 ? key : `directive:h.${createHash("sha256").update(directiveId).digest("hex").slice(0, 16)}`;
}

function intervalFor(trigger: CheckpointTrigger, override: number | undefined): number | undefined {
	const base = trigger === "turn" ? TURN_MIN_INTERVAL_MS : trigger === "plan-step" ? PLAN_STEP_MIN_INTERVAL_MS : undefined;
	if (base === undefined) return undefined;
	return override !== undefined && Number.isFinite(override) && override >= 0 ? override : base;
}

/** Decide whether an automatic checkpoint is worth taking now. Pure; never throws. */
export function shouldCheckpoint(input: PolicyInput): PolicyDecision {
	const { trigger, nowMs, last, currentTreeId } = input;
	if (trigger === "manual") return take("manual: an explicit request is always taken");
	if (trigger === "pre-restore") return take("pre-restore: a rollback always saves the state it replaces");
	if (trigger === "baseline") {
		return last === undefined ? take("baseline: the session has no checkpoint yet") : skip("baseline: the session already has a checkpoint");
	}
	if (trigger === "steering" && input.directiveKey !== undefined && input.seenDirectiveKeys?.has(input.directiveKey)) {
		return skip("steering: this directive already has a checkpoint");
	}
	const interval = intervalFor(trigger, input.minIntervalMs);
	if (interval !== undefined) {
		const reference = input.lastOfTrigger ?? (last !== undefined && (last.trigger === undefined || last.trigger === trigger) ? last : undefined);
		if (reference?.takenAtMs !== undefined) {
			const elapsed = nowMs - reference.takenAtMs;
			// A negative elapsed time is a clock that moved backwards: it proves nothing recent, so it does not suppress.
			if (elapsed >= 0 && elapsed < interval) return skip(`${trigger}: rate limited (${elapsed} ms since the last ${trigger} checkpoint, minimum ${interval} ms)`);
		}
	}
	if (currentTreeId !== undefined && last !== undefined && last.treeId === currentTreeId) {
		return skip(`${trigger}: the worktree is unchanged since the last checkpoint`);
	}
	return take(`${trigger}: due`);
}
