/**
 * Applying restore operations to the filesystem, one idempotent operation at a time.
 *
 * Every operation first checks whether its destination already holds the target state and then does
 * nothing, so a plan can be re-run after a crash. Content is written to
 * `<dest>.substrate-<id>.tmp` in the destination's own directory (so the final rename never crosses
 * a filesystem), fsynced, given its mode, and renamed over the destination: a reader sees the old
 * file or the new one, never half of either.
 *
 * Paths are checked before every touch: no `..`, no absolute path, no `.git` segment, and no write
 * or delete THROUGH a symlink (a parent component that is a symlink is refused, even one that
 * points inside the worktree). A symlink that is itself part of the snapshot is created as a
 * symlink and never followed.
 *
 * Empty directories are not part of a git tree and are not restored. Directories that became empty
 * because their last file was deleted, and that the target tree has no entry under, are removed.
 */

import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PathConflictError, UnsupportedPathError } from "./errors.ts";
import {
	algorithmFor,
	ancestorsOf,
	assertSafeRelativePath,
	blobIdOf,
	blobIdOfFile,
	type HashAlgorithm,
	tempName,
} from "./paths.ts";
import { git, type RepoContext } from "./runner.ts";
import type { EntryMode, RestoreHooks, RestoreOperation, WriteOperation } from "./types.ts";

export type ApplyContext = {
	repo: RepoContext;
	/** The restore id; part of every temporary file name. */
	id: string;
	algorithm: HashAlgorithm;
	/** Directories whose entries changed; fsynced after the plan. */
	touchedDirs: Set<string>;
	/** Files removed by delete operations, for pruning emptied directories. */
	deleted: string[];
};

export function makeApplyContext(repo: RepoContext, id: string, anyObjectId: string): ApplyContext {
	return { repo, id, algorithm: algorithmFor(anyObjectId), touchedDirs: new Set(), deleted: [] };
}

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		// ENOTDIR means a parent component is now a regular file (a directory the plan turned into a file), so nothing can
		// exist at this path: the same answer as ENOENT. Pruning stats ancestors of deleted files after such a retype.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
}

/**
 * The absolute destination of a worktree-relative path after checking every parent component:
 * each must be a real directory. With `create`, missing parents are created; otherwise a missing
 * parent returns null (nothing to delete).
 */
function resolveDestination(ctx: ApplyContext, path: string, create: boolean): string | null {
	assertSafeRelativePath(path);
	let current = ctx.repo.root;
	for (const segment of path.split("/").slice(0, -1)) {
		current = join(current, segment);
		const stat = lstatOrNull(current);
		if (stat === null) {
			if (!create) return null;
			mkdirSync(current);
			ctx.touchedDirs.add(dirname(current));
			continue;
		}
		if (stat.isSymbolicLink()) throw new UnsupportedPathError(path, "passes through a symlink");
		if (!stat.isDirectory()) throw new PathConflictError(path, "a parent component is not a directory");
	}
	return join(ctx.repo.root, path);
}

/** Remove a directory tree that holds only empty directories; any file in it is a conflict. */
function removeEmptyTree(absolute: string, path: string): void {
	for (const name of readdirSync(absolute)) {
		const child = join(absolute, name);
		if (lstatSync(child).isDirectory()) removeEmptyTree(child, `${path}/${name}`);
		else throw new PathConflictError(path, "a directory holds files that are not part of the snapshot (excluded or skipped)");
	}
	rmdirSync(absolute);
}

async function contentMatches(ctx: ApplyContext, destination: string, stat: Stats, operation: WriteOperation): Promise<boolean> {
	if (operation.mode === "120000") {
		if (!stat.isSymbolicLink()) return false;
		return blobIdOf(readlinkSync(destination, { encoding: "buffer" }), ctx.algorithm) === operation.sha;
	}
	if (!stat.isFile()) return false;
	return (await blobIdOfFile(destination, stat.size, ctx.algorithm)) === operation.sha;
}

function matchMode(destination: string, stat: Stats, mode: EntryMode): void {
	if (mode === "120000" || !stat.isFile()) return;
	const executable = (stat.mode & 0o100) !== 0;
	if (executable === (mode === "100755")) return;
	// Same rule as git: the execute bits follow the read bits.
	const next = executable ? stat.mode & ~0o111 : stat.mode | ((stat.mode & 0o444) >> 2);
	chmodSync(destination, next & 0o7777);
}

async function writeTarget(ctx: ApplyContext, operation: WriteOperation): Promise<void> {
	const destination = resolveDestination(ctx, operation.path, true);
	if (destination === null) throw new PathConflictError(operation.path, "the parent directory could not be created");
	const stat = lstatOrNull(destination);
	if (stat?.isDirectory()) {
		removeEmptyTree(destination, operation.path);
	} else if (stat !== null) {
		if (await contentMatches(ctx, destination, stat, operation)) {
			matchMode(destination, stat, operation.mode);
			return;
		}
		if (operation.op === "add") {
			throw new PathConflictError(
				operation.path,
				"exists and differs from the snapshot although the snapshot baseline has no such path (excluded or skipped?)",
			);
		}
	}
	const temporary = tempName(destination, ctx.id);
	rmSync(temporary, { force: true });
	try {
		if (operation.mode === "120000") {
			symlinkSync(await git(ctx.repo, ["cat-file", "blob", operation.sha]), temporary);
		} else {
			await git(ctx.repo, ["cat-file", "blob", operation.sha], {
				stdoutFile: temporary,
				stdoutMode: operation.mode === "100755" ? 0o777 : 0o666,
			});
		}
		renameSync(temporary, destination);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	ctx.touchedDirs.add(dirname(destination));
}

function deleteTarget(ctx: ApplyContext, path: string): void {
	const destination = resolveDestination(ctx, path, false);
	if (destination === null) return;
	const stat = lstatOrNull(destination);
	if (stat === null) return;
	if (stat.isDirectory()) throw new PathConflictError(path, "expected a file or symlink but found a directory");
	unlinkSync(destination);
	ctx.touchedDirs.add(dirname(destination));
	ctx.deleted.push(path);
}

/** Apply one operation; safe to repeat. */
export async function applyOperation(ctx: ApplyContext, operation: RestoreOperation): Promise<void> {
	if (operation.op === "delete") deleteTarget(ctx, operation.path);
	else await writeTarget(ctx, operation);
}

/** Remove directories that deletions emptied and that the target tree has no entry under. */
function pruneDirectories(ctx: ApplyContext, keep: ReadonlySet<string>): void {
	const candidates = new Set<string>();
	for (const path of ctx.deleted) for (const dir of ancestorsOf(path)) candidates.add(dir);
	// Deepest first, so a parent is examined after the children that may have emptied it.
	const ordered = [...candidates].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1));
	for (const dir of ordered) {
		if (keep.has(dir)) continue;
		const absolute = join(ctx.repo.root, dir);
		const stat = lstatOrNull(absolute);
		if (stat === null || !stat.isDirectory()) continue;
		if (readdirSync(absolute).length === 0) {
			rmdirSync(absolute);
			ctx.touchedDirs.add(dirname(absolute));
		}
	}
	ctx.deleted = [];
}

function syncDirectories(ctx: ApplyContext): void {
	for (const dir of ctx.touchedDirs) {
		try {
			const fd = openSync(dir, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Directory fsync is best effort: a removed directory or a filesystem without support
			// only weakens durability across power loss, never correctness of the final state.
		}
	}
	ctx.touchedDirs.clear();
}

/** Apply every operation in order, then prune emptied directories and fsync the touched ones. */
export async function applyOperations(
	ctx: ApplyContext,
	operations: readonly RestoreOperation[],
	keepDirectories: ReadonlySet<string>,
	hooks?: RestoreHooks,
): Promise<void> {
	for (const [index, operation] of operations.entries()) {
		await hooks?.beforeOp?.(index, operation);
		await applyOperation(ctx, operation);
	}
	pruneDirectories(ctx, keepDirectories);
	syncDirectories(ctx);
}

/** Remove leftover `.substrate-<id>.tmp` files of the given paths (after a crash). */
export function removeTemporaries(ctx: ApplyContext, paths: Iterable<string>): void {
	for (const path of paths) {
		let destination: string | null;
		try {
			destination = resolveDestination(ctx, path, false);
		} catch (error) {
			// A parent that is now a file or a symlink cannot hold a temporary file this restore wrote.
			if (error instanceof PathConflictError || error instanceof UnsupportedPathError) continue;
			throw error;
		}
		if (destination !== null) rmSync(tempName(destination, ctx.id), { force: true });
	}
}
