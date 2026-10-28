/** Shared types for `@substrate/worktree-snapshot`. */

export type Clock = () => Date;

export type EntryMode = "100644" | "100755" | "120000";

export type SkipReason = "secret-pattern" | "too-large" | "unsupported-submodule" | "unsupported-filetype";

export type SkippedPath = { path: string; reason: SkipReason };

export type IgnoredPath = { path: string; reason: "secret-pattern" | "excluded" };

export type SnapshotEntry = { path: string; mode: EntryMode; type: "blob"; sha: string };

/**
 * An exact file-state snapshot. `tree` is a git tree object in the repository's object database;
 * `manifestSha256` hashes the sorted entries (see `manifestOf`). `createdAt` comes from the injected
 * clock and is not part of any hash.
 */
export type Snapshot = {
	version: 1;
	tree: string;
	headCommit: string | null;
	branch: string | null;
	manifestSha256: string;
	entries: SnapshotEntry[];
	skipped: SkippedPath[];
	createdAt: string;
};

/** What a snapshot includes. Defaults are always on: callers can only add exclusions. */
export type SnapshotPolicy = {
	/** Files above this size are skipped with reason too-large. Default 50 MiB. */
	maxFileBytes?: number;
	/** Extra basename globs (or root-relative path globs when they contain a slash) treated as secrets. */
	extraSecretPatterns?: readonly string[];
	/** Extra directory names excluded at any depth. */
	extraExcludeDirs?: readonly string[];
	/** Extra globs excluded silently (like `*.log`). */
	extraExcludeGlobs?: readonly string[];
	/** Ignored (gitignored, untracked) paths that are still snapshotted. Default `[".planning/"]`. */
	ignoredAllowlist?: readonly string[];
};

/** A policy with every default applied. Serialisable (stored in the restore journal). */
export type ResolvedPolicy = {
	maxFileBytes: number;
	secretPatterns: string[];
	excludeDirs: string[];
	excludeGlobs: string[];
	ignoredAllowlist: string[];
};

export type WriteOperation = {
	op: "add" | "modify" | "chmod" | "retype";
	path: string;
	/** Target mode. */
	mode: EntryMode;
	/** Target blob. */
	sha: string;
	/** Mode in the current tree (absent for add). */
	previousMode?: EntryMode;
};

export type DeleteOperation = { op: "delete"; path: string; previousMode: EntryMode };

export type RestoreOperation = WriteOperation | DeleteOperation;

export type OperationCounts = {
	add: number;
	modify: number;
	delete: number;
	chmod: number;
	retype: number;
	total: number;
};

export type RestorePlan = {
	currentTree: string;
	targetTree: string;
	/** In execution order: conflicting deletes, then writes, then the remaining deletes. */
	operations: RestoreOperation[];
	counts: OperationCounts;
	/** Operations that turn `expectedCurrentTree` into the current tree: changes made outside the session. */
	drift: RestoreOperation[];
	/** Paths the policy excludes by name; they are neither written nor deleted. */
	ignored: IgnoredPath[];
	/**
	 * Paths the target snapshot skipped when it was taken (too large, secret, ...) that exist in the
	 * worktree now. They are absent from the target tree because they were never captured, so a restore
	 * leaves them exactly as they are (it neither deletes nor overwrites them): `skipped-in-snapshot`.
	 */
	skippedInSnapshot: SkippedPath[];
};

export type RestoreHooks = {
	/** Called before each operation of the forward apply with its index in `plan.operations`. */
	beforeOp?: (index: number, op: RestoreOperation) => void | Promise<void>;
};

export type RestoreResult = {
	id: string;
	targetTree: string;
	safety: Snapshot;
	safetyRef: string;
	plan: RestorePlan;
	verifiedTree: string;
};

export type RecoverResult =
	| { recovered: false }
	| {
			recovered: true;
			id: string;
			/** `forward` completed the restore to the target; `rollback` completed an interrupted rollback. */
			direction: "forward" | "rollback";
			tree: string;
			operations: RestoreOperation[];
			counts: OperationCounts;
			safetyRef: string;
	  };

export type PinResult = { ref: string; commit: string };
