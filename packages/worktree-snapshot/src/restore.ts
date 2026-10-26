/**
 * Journaled, verified restore of a worktree to a snapshot.
 *
 * Sequence: lock the worktree; plan; refuse on drift (changes made outside the session) unless
 * `force`; take and pin a SAFETY snapshot (`refs/substrate/safety/<id>`) before any change; write
 * the journal; apply the operations one by one; verify that the worktree tree equals the target
 * tree; on any handled failure reverse-apply the safety snapshot; remove the journal; release the
 * lock.
 *
 * What this does and does not promise (read this before relying on it):
 *
 *  - The restore is CRASH-RECOVERABLE and VERIFIED. It is not instantaneous-atomic across files.
 *    Each file is replaced atomically (temp file, fsync, rename), but the set of files changes one
 *    at a time. If the process dies half way, the worktree is partially restored until
 *    `recoverRestore` runs; it finds the journal and completes the restore forward to the target
 *    (every operation is idempotent). The safety snapshot ref is always available and restores the
 *    pre-restore state with a second `restore` call.
 *  - It restores file state only: contents, executable bit and symlinks. The real index, HEAD,
 *    branch and stash are never modified. Empty directories are not restored (git does not track
 *    them); directories emptied by a deletion that the target has no entry under are removed.
 *  - Paths the policy excludes (secrets, node_modules, build output, `*.log`, files above
 *    maxFileBytes, nested repositories) are in neither tree, so a restore neither writes nor deletes
 *    them. A target path that would have to overwrite or replace such an excluded file or directory
 *    fails the restore (and rolls it back) instead.
 *  - Conversion attributes (`text`, `eol`, `filter`) in `.gitattributes` are applied by git when it
 *    hashes the worktree. If they make the re-hash of a restored file differ from its blob,
 *    verification fails and the restore is rolled back; it never reports a false success.
 *  - A file written between the safety snapshot and the end of the restore by another process is
 *    not protected (the lock only serialises restores).
 */

import {
	RestoreDriftError,
	RestoreFailedError,
	RestoreRecoveryRequiredError,
	RestoreVerifyError,
	SimulatedCrash,
	SnapshotPolicyError,
} from "./errors.ts";
import { type Journal, journalExists, readJournal, removeJournal, resolveJournalDir, writeJournal } from "./journal.ts";
import { acquireWorktreeLock } from "./lock.ts";
import { applyOperations, makeApplyContext, removeTemporaries } from "./apply.ts";
import { deletePin, pinTree, refFor } from "./pin.ts";
import { isValidId } from "./paths.ts";
import { countOperations, nonExcludedPaths, planBetween, validateTarget } from "./plan.ts";
import { resolvePolicy } from "./policy.ts";
import { openRepo, type RepoContext, type Runner } from "./runner.ts";
import { assertTreeExists, buildSnapshot, buildTree, diffTrees, directoriesOf, lsTree } from "./tree.ts";
import type {
	Clock,
	RecoverResult,
	ResolvedPolicy,
	RestoreHooks,
	RestorePlan,
	RestoreResult,
	Snapshot,
	SnapshotPolicy,
} from "./types.ts";

class VerifyMismatch extends Error {
	readonly paths: readonly string[];

	constructor(paths: readonly string[]) {
		super(`${paths.length} path(s) differ after the restore`);
		this.paths = paths;
	}
}

/** An error message with the worktree's absolute path replaced, so messages name relative paths only. */
function describe(error: unknown, root: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(root).join("<worktree>");
}

/** Require the worktree tree to equal `goalTree` on every path the policy lets us touch. */
async function verifyTree(ctx: RepoContext, policy: ResolvedPolicy, goalTree: string): Promise<void> {
	const after = await buildTree(ctx, policy);
	if (after.tree === goalTree) return;
	const paths = nonExcludedPaths(await diffTrees(ctx, after.tree, goalTree), policy);
	if (paths.length > 0) throw new VerifyMismatch(paths);
}

/** Plan from the worktree as it is now to `goalTree`, apply, verify. No drift check, no hooks unless given. */
async function converge(
	ctx: RepoContext,
	policy: ResolvedPolicy,
	goalTree: string,
	id: string,
	options: { hooks?: RestoreHooks; cleanupPaths?: readonly string[] } = {},
): Promise<RestorePlan> {
	const apply = makeApplyContext(ctx, id, goalTree);
	// Leftovers of a crashed write would otherwise be read as untracked files and planned for deletion.
	removeTemporaries(apply, options.cleanupPaths ?? []);
	const current = await buildTree(ctx, policy);
	const plan = await planBetween(ctx, policy, current.tree, goalTree);
	const keep = directoriesOf(await lsTree(ctx, goalTree));
	await applyOperations(apply, plan.operations, keep, options.hooks);
	await verifyTree(ctx, policy, goalTree);
	return plan;
}

type RunState = {
	ctx: RepoContext;
	policy: ResolvedPolicy;
	journalDir: string;
	journal: Journal;
	/** Set when the journal (and the target pin) must outlive this call. */
	keepJournal: boolean;
};

/** Reverse-apply the safety snapshot and throw the failure that caused it. Never returns. */
async function rollBack(state: RunState, cause: unknown): Promise<never> {
	const { ctx, journal } = state;
	const fields = { modified: true, safetyRef: journal.safetyRef };
	// Keep the journal until the rollback is verified: any failure below must stay recoverable.
	state.keepJournal = true;
	writeJournal(state.journalDir, { ...journal, state: "rolling-back" });
	try {
		await converge(ctx, state.policy, journal.safetyTree, journal.id);
	} catch (rollbackError) {
		throw new RestoreFailedError(
			`the restore failed (${describe(cause, ctx.root)}) and rolling back to the safety snapshot also failed (${describe(rollbackError, ctx.root)}); run recoverRestore`,
			{ ...fields, rolledBack: false, cause: rollbackError },
		);
	}
	state.keepJournal = false;
	if (cause instanceof VerifyMismatch) throw new RestoreVerifyError(cause.paths, { ...fields, rolledBack: true, cause });
	throw new RestoreFailedError(`the restore failed and was rolled back: ${describe(cause, ctx.root)}`, {
		...fields,
		rolledBack: true,
		cause,
	});
}

async function finish(state: RunState): Promise<void> {
	if (state.keepJournal) return;
	removeJournal(state.journalDir);
	await dropTargetPin(state.ctx, state.journal.targetRef);
}

async function dropTargetPin(ctx: RepoContext, ref: string): Promise<void> {
	try {
		await deletePin(ctx, ref);
	} catch {
		// The target pin is only a gc guard; a leftover ref is harmless and the outcome stands.
	}
}

export type RestoreParams = {
	worktree: string;
	/** The snapshot to restore to. Its tree must be in the object database; its manifest must match. */
	target: Snapshot;
	/** Unique per restore: names the safety ref, the target pin and the temporary files. */
	id: string;
	/** The tree the session believes the worktree has; a difference is drift and refuses the restore. */
	expectedCurrentTree?: string;
	/** Proceed although the worktree changed outside the session. */
	force?: boolean;
	journalDir?: string;
	policy?: SnapshotPolicy;
	now?: Clock;
	run?: Runner;
	/** Test seam; see RestoreHooks. */
	hooks?: RestoreHooks;
};

export async function restore(params: RestoreParams): Promise<RestoreResult> {
	const { id } = params;
	if (!isValidId(id)) throw new SnapshotPolicyError("id must match ^[A-Za-z0-9._-]{8,64}$");
	const ctx = await openRepo(params);
	const policy = resolvePolicy(params.policy);
	const journalDir = resolveJournalDir(ctx, params.journalDir);
	const lock = acquireWorktreeLock(ctx.gitDir, ctx.now);
	let state: RunState | null = null;
	let targetPinned = false;
	try {
		if (journalExists(journalDir)) {
			throw new RestoreRecoveryRequiredError("a restore journal from an interrupted restore exists; run recoverRestore first");
		}
		const targetTree = await validateTarget(ctx, params.target);
		const current = await buildTree(ctx, policy);
		let plan = await planBetween(ctx, policy, current.tree, targetTree, params.expectedCurrentTree);
		if (plan.drift.length > 0 && params.force !== true) throw new RestoreDriftError(plan.drift);

		let safety: Snapshot;
		let safetyRef: string;
		const targetRef = refFor("restore-target", id);
		try {
			safety = await buildSnapshot(ctx, policy);
			safetyRef = (await pinTree(ctx, "safety", id, safety.tree)).ref;
			await pinTree(ctx, "restore-target", id, targetTree);
			targetPinned = true;
		} catch (cause) {
			throw new RestoreFailedError(
				`the safety snapshot could not be taken; no path was changed (${describe(cause, ctx.root)})`,
				{ rolledBack: false, modified: false, cause },
			);
		}
		if (safety.tree !== current.tree) {
			// The worktree changed while the safety snapshot was taken: plan against what was pinned.
			plan = await planBetween(ctx, policy, safety.tree, targetTree, params.expectedCurrentTree);
			if (plan.drift.length > 0 && params.force !== true) throw new RestoreDriftError(plan.drift);
		}

		const journal: Journal = {
			version: 1,
			id,
			state: "applying",
			startedAt: ctx.now().toISOString(),
			targetTree,
			safetyTree: safety.tree,
			safetyRef,
			targetRef,
			policy,
			operations: plan.operations.map((operation) => ({ op: operation.op, path: operation.path })),
		};
		const keep = directoriesOf(await lsTree(ctx, targetTree));
		writeJournal(journalDir, journal);
		state = { ctx, policy, journalDir, journal, keepJournal: false };

		try {
			const apply = makeApplyContext(ctx, id, targetTree);
			await applyOperations(apply, plan.operations, keep, params.hooks);
			await verifyTree(ctx, policy, targetTree);
		} catch (error) {
			if (error instanceof SimulatedCrash) {
				// A crash performs no rollback and keeps the journal for recoverRestore.
				state.keepJournal = true;
				throw error;
			}
			return await rollBack(state, error);
		}
		return { id, targetTree, safety, safetyRef, plan, verifiedTree: targetTree };
	} finally {
		try {
			if (state !== null) await finish(state);
			else if (targetPinned) await dropTargetPin(ctx, refFor("restore-target", id));
		} finally {
			lock.release();
		}
	}
}

export type RecoverParams = {
	worktree: string;
	journalDir?: string;
	now?: Clock;
	run?: Runner;
	hooks?: RestoreHooks;
};

/**
 * Finish a restore that a crashed process left behind. State `applying`: complete the restore
 * forward to the target (operations already done are skipped); if that fails, roll back to the
 * safety snapshot. State `rolling-back`: complete the rollback. Returns `{recovered: false}` when
 * there is no journal.
 */
export async function recoverRestore(params: RecoverParams): Promise<RecoverResult> {
	const ctx = await openRepo(params);
	const journalDir = resolveJournalDir(ctx, params.journalDir);
	const lock = acquireWorktreeLock(ctx.gitDir, ctx.now);
	let state: RunState | null = null;
	try {
		const journal = readJournal(journalDir);
		if (journal === null) return { recovered: false };
		await assertTreeExists(ctx, journal.targetTree, "journal target tree");
		await assertTreeExists(ctx, journal.safetyTree, "journal safety tree");
		state = { ctx, policy: journal.policy, journalDir, journal, keepJournal: false };
		const direction = journal.state === "rolling-back" ? "rollback" : "forward";
		const goal = direction === "forward" ? journal.targetTree : journal.safetyTree;
		const cleanupPaths = journal.operations.map((operation) => operation.path);
		let plan: RestorePlan;
		try {
			plan = await converge(ctx, journal.policy, goal, journal.id, { hooks: params.hooks, cleanupPaths });
		} catch (error) {
			if (error instanceof SimulatedCrash) {
				state.keepJournal = true;
				throw error;
			}
			if (direction === "rollback") {
				state.keepJournal = true;
				throw new RestoreFailedError(
					`recovering the interrupted rollback failed (${describe(error, ctx.root)}); the safety ref ${journal.safetyRef} is intact`,
					{ rolledBack: false, modified: true, safetyRef: journal.safetyRef, cause: error },
				);
			}
			return await rollBack(state, error);
		}
		return {
			recovered: true,
			id: journal.id,
			direction,
			tree: goal,
			operations: plan.operations,
			counts: countOperations(plan.operations),
			safetyRef: journal.safetyRef,
		};
	} finally {
		try {
			if (state !== null) await finish(state);
		} finally {
			lock.release();
		}
	}
}
