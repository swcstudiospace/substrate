/**
 * Typed errors. Every class carries a stable `code` string callers can branch on. Messages name
 * paths relative to the worktree and never include file contents.
 */

import type { RestoreOperation } from "./types.ts";

export class WorktreeSnapshotError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/** A git command exited non-zero (or could not start). The message quotes at most 200 characters of stderr. */
export class GitCommandError extends WorktreeSnapshotError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("git-failed", message, options);
	}
}

/** The snapshot policy, an id, a ref or the snapshot itself is malformed or inconsistent. */
export class SnapshotPolicyError extends WorktreeSnapshotError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("snapshot-policy", message, options);
	}
}

/**
 * A path cannot be represented or cannot be written safely: not valid UTF-8, contains a newline,
 * contains `..`, is absolute, names `.git`, passes through a symlink, or is a gitlink entry.
 */
export class UnsupportedPathError extends WorktreeSnapshotError {
	readonly path: string;

	constructor(path: string, reason: string) {
		super("unsupported-path", `unsupported path ${JSON.stringify(path)}: ${reason}`);
		this.path = path;
	}
}

/** A destination holds something the restore plan did not expect and must not overwrite or remove. */
export class PathConflictError extends WorktreeSnapshotError {
	readonly path: string;

	constructor(path: string, reason: string) {
		super("path-conflict", `path conflict at ${JSON.stringify(path)}: ${reason}`);
		this.path = path;
	}
}

/** Another restore holds the worktree lock. */
export class WorktreeBusyError extends WorktreeSnapshotError {
	constructor(message: string) {
		super("worktree-busy", message);
	}
}

/** A journal from a crashed restore is present; run `recoverRestore` first. */
export class RestoreRecoveryRequiredError extends WorktreeSnapshotError {
	constructor(message: string) {
		super("restore-recovery-required", message);
	}
}

/** The worktree changed outside the session since `expectedCurrentTree`. `force: true` overrides. */
export class RestoreDriftError extends WorktreeSnapshotError {
	readonly drift: readonly RestoreOperation[];

	constructor(drift: readonly RestoreOperation[]) {
		const shown = drift
			.slice(0, 5)
			.map((op) => `${op.op} ${op.path}`)
			.join(", ");
		super(
			"restore-drift",
			`the worktree changed outside the session in ${drift.length} path(s) (${shown}${drift.length > 5 ? ", ..." : ""}); pass force to override`,
		);
		this.drift = drift;
	}
}

/**
 * The restore failed after the safety snapshot was taken or while taking it.
 * `modified` is false when no path was touched; `rolledBack` is true only when the safety snapshot
 * was reverse-applied and the pre-restore tree was verified again. When `rolledBack` is false and
 * `modified` is true the journal and the safety ref are kept: run `recoverRestore`.
 */
export class RestoreFailedError extends WorktreeSnapshotError {
	readonly rolledBack: boolean;
	readonly modified: boolean;
	readonly safetyRef: string | null;

	constructor(
		message: string,
		fields: { rolledBack: boolean; modified: boolean; safetyRef?: string | null; cause?: unknown },
		code = "restore-failed",
	) {
		super(code, message, { cause: fields.cause });
		this.rolledBack = fields.rolledBack;
		this.modified = fields.modified;
		this.safetyRef = fields.safetyRef ?? null;
	}
}

/** After applying, the worktree tree did not equal the target tree. The restore was rolled back. */
export class RestoreVerifyError extends RestoreFailedError {
	readonly paths: readonly string[];

	constructor(
		paths: readonly string[],
		fields: { rolledBack: boolean; modified: boolean; safetyRef?: string | null; cause?: unknown },
	) {
		super(
			`verification failed: ${paths.length} path(s) differ from the target (${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""})`,
			fields,
			"restore-verify",
		);
		this.paths = paths;
	}
}

/**
 * Test seam. Thrown from `hooks.beforeOp` it simulates a process crash: the restore stops where it
 * is, keeps the journal in state `applying`, performs no rollback and rethrows it. A real crash
 * additionally leaves a stale lock file, which the next lock attempt detects and breaks.
 */
export class SimulatedCrash extends Error {
	constructor(message = "simulated crash") {
		super(message);
		this.name = "SimulatedCrash";
	}
}
