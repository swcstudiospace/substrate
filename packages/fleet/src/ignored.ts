/**
 * Ignored files that hold work, which `git worktree remove` would delete without a word.
 *
 * Git refuses to remove a worktree with tracked changes or untracked files, but it deletes ignored
 * files silently: a `.planning/` directory, `.env*` files and local notes live there. A worktree is
 * only as clean as its ignored files are replaceable. Regenerable directories (dependencies, build
 * output, caches) are skipped; every other ignored file counts unless the primary checkout holds the
 * same bytes at the same path. Anything this module cannot read or bound counts as work.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "./git.ts";

/** Directory names whose contents are rebuilt by a command, wherever they appear in a path. */
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "target", ".cache", "coverage", "__pycache__", ".venv", "venv", ".next", "vendor"]);

/** Files compared byte for byte are read in full only up to this size; a larger one counts as different. */
export const MAX_COMPARE_BYTES = 4 * 1024 * 1024;
/** Files examined inside ignored directories before the rest are assumed to be work. */
export const MAX_IGNORED_FILES = 5000;

export const UNKNOWN_IGNORED = "(ignored files could not be listed)";

function regenerable(path: string): boolean {
	return path.split("/").some((segment) => REGENERABLE_DIRS.has(segment));
}

/** True when `path` holds the same bytes (or the same link target) in both checkouts. */
export function sameContent(a: string, b: string): boolean {
	try {
		const left = lstatSync(a);
		const right = lstatSync(b);
		if (left.isSymbolicLink() && right.isSymbolicLink()) return readlinkSync(a) === readlinkSync(b);
		if (!left.isFile() || !right.isFile()) return false;
		if (left.size !== right.size || left.size > MAX_COMPARE_BYTES) return false;
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/** Files below `dir` (relative to `root`), skipping regenerable directories; `limit` bounds the count. */
function filesBelow(root: string, dir: string, out: string[], limit: number): boolean {
	let names: string[];
	try {
		names = readdirSync(join(root, dir));
	} catch {
		out.push(dir);
		return true;
	}
	for (const name of names) {
		const relative = `${dir}${name}`;
		if (REGENERABLE_DIRS.has(name)) continue;
		if (out.length >= limit) return false;
		let isDirectory = false;
		try {
			isDirectory = lstatSync(join(root, relative)).isDirectory();
		} catch {
			out.push(relative);
			continue;
		}
		if (isDirectory) {
			if (!filesBelow(root, `${relative}/`, out, limit)) return false;
		} else out.push(relative);
	}
	return true;
}

/**
 * Ignored, non-regenerable files of the worktree at `path` that the primary checkout at `primaryPath`
 * does not hold identically, as paths relative to the worktree. Empty means nothing would be lost.
 */
export async function findIgnoredWork(path: string, primaryPath: string, git: GitRunner): Promise<string[]> {
	const listing = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], path);
	if (listing.code !== 0) return [UNKNOWN_IGNORED];
	const candidates: string[] = [];
	let complete = true;
	for (const entry of listing.stdout.split("\0")) {
		if (entry === "" || regenerable(entry)) continue;
		if (entry.endsWith("/")) {
			if (!filesBelow(path, entry, candidates, MAX_IGNORED_FILES)) complete = false;
		} else candidates.push(entry);
	}
	const work = candidates.filter((file) => !regenerable(file) && !sameContent(join(path, file), join(primaryPath, file)));
	if (!complete) work.push(UNKNOWN_IGNORED);
	return work.sort();
}
