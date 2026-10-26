/**
 * `@substrate/worktree-snapshot` — exact file-state snapshots of a git worktree with a journaled,
 * verified restore. The file half of session rollback.
 *
 * A pure local library: no network, no substrate imports. It shells out to `git` through an
 * injectable runner (argv arrays, never a shell) and never modifies the worktree's real index,
 * HEAD, branch or stash.
 *
 * Read the header of `restore.ts` for what the restore does and does not guarantee (it is
 * crash-recoverable and verified, not instantaneous-atomic) and the header of `pin.ts` for why
 * `refs/substrate/*` must never be pushed.
 */
export {
	GitCommandError,
	PathConflictError,
	RestoreDriftError,
	RestoreFailedError,
	RestoreRecoveryRequiredError,
	RestoreVerifyError,
	SimulatedCrash,
	SnapshotPolicyError,
	UnsupportedPathError,
	WorktreeBusyError,
	WorktreeSnapshotError,
} from "./errors.ts";
export { type PlanRestoreParams, planRestore } from "./plan.ts";
export {
	DEFAULT_EXCLUDE_DIRS,
	DEFAULT_EXCLUDE_GLOBS,
	DEFAULT_IGNORED_ALLOWLIST,
	DEFAULT_MAX_FILE_BYTES,
	DEFAULT_SECRET_PATTERNS,
	resolvePolicy,
} from "./policy.ts";
export { type RecoverParams, type RestoreParams, recoverRestore, restore } from "./restore.ts";
export type { GitOptions, RepoContext, RunOptions, RunResult, Runner } from "./runner.ts";
export { spawnRunner } from "./runner.ts";
export type { PinnedCheckpoint } from "./pin.ts";
export { MAX_METADATA_BYTES, METADATA_TRAILER } from "./pin.ts";
export {
	type ListPinnedParams,
	listPinned,
	type PinParams,
	pinSnapshot,
	type ReadPinnedParams,
	readPinnedSnapshot,
	type SnapshotParams,
	snapshot,
} from "./snapshot.ts";
export { manifestOf } from "./tree.ts";
export type {
	Clock,
	EntryMode,
	IgnoredPath,
	OperationCounts,
	PinResult,
	RecoverResult,
	ResolvedPolicy,
	RestoreHooks,
	RestoreOperation,
	RestorePlan,
	RestoreResult,
	SkippedPath,
	SkipReason,
	Snapshot,
	SnapshotEntry,
	SnapshotPolicy,
	WriteOperation,
	DeleteOperation,
} from "./types.ts";
