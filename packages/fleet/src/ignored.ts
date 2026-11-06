/**
 * Ignored files that hold work, which `git worktree remove` would delete without a word.
 *
 * Git refuses to remove a worktree with tracked changes or untracked files, but it deletes ignored
 * files silently: a `.planning/` directory, `.env*` files and local notes live there. A worktree is
 * only as clean as its ignored files are replaceable. Regenerable directories (dependencies, build
 * output, caches) are skipped; every other ignored file counts unless the primary checkout holds the
 * same bytes at the same path. The exemption is for directories only: a regular file or a link that
 * happens to be called `target` or `dist` is compared like any other. Anything this module cannot read
 * or bound counts as work, and the bounds cover everything visited (files and directories) and the
 * time spent, because the walk is synchronous and no outer timeout can interrupt it.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GitRunner } from "./git.ts";

/** Directory names whose contents are rebuilt by a command, wherever they appear in a path. */
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "target", ".cache", "coverage", "__pycache__", ".venv", "venv", ".next", "vendor"]);

/** Files compared byte for byte are read in full only up to this size; a larger one counts as different. */
export const MAX_COMPARE_BYTES = 4 * 1024 * 1024;
/** Files examined inside ignored directories before the rest are assumed to be work. */
export const MAX_IGNORED_FILES = 5000;
/** Entries (files and directories) visited inside ignored directories before the rest are assumed to be work. */
export const MAX_IGNORED_VISITED = 50_000;
/** Milliseconds one scan may take before the rest is assumed to be work. */
export const MAX_IGNORED_MS = 10_000;

export const UNKNOWN_IGNORED = "(ignored files could not be listed)";

export interface IgnoredOptions {
	maxFiles?: number;
	maxVisited?: number;
	maxMs?: number;
	/** Milliseconds clock; injected by tests. */
	now?: () => number;
}

/** What one scan may still spend. */
interface Budget {
	maxFiles: number;
	/** Count one more visited entry; false once the entry count or the time is used up. */
	visit: () => boolean;
}

function makeBudget(options: IgnoredOptions): Budget {
	const maxVisited = options.maxVisited ?? MAX_IGNORED_VISITED;
	const maxMs = options.maxMs ?? MAX_IGNORED_MS;
	const now = options.now ?? Date.now;
	const started = now();
	let visited = 0;
	return {
		maxFiles: options.maxFiles ?? MAX_IGNORED_FILES,
		visit: () => {
			visited += 1;
			return visited <= maxVisited && now() - started <= maxMs;
		},
	};
}

/** True when a directory segment of `path` is regenerable; `isDirectory` says whether the last segment is a directory too. */
function regenerable(path: string, isDirectory: boolean): boolean {
	const segments = path.split("/").filter((segment) => segment !== "");
	return (isDirectory ? segments : segments.slice(0, -1)).some((segment) => REGENERABLE_DIRS.has(segment));
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
		// Any stat or read failure: not known to be identical, so false.
		return false;
	}
}

/** The real path of `path`, symbolic links followed; the plain absolute path when it cannot be resolved. */
function realOrPlain(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True when `candidate` resolves, links followed, to `root` or a path below it: a "copy" that is the file itself, not a backup of it. */
function resolvesInside(candidate: string, root: string): boolean {
	const real = realOrPlain(candidate);
	return real === root || real.startsWith(`${root}${sep}`);
}

/** Files below `dir` (relative to `root`), skipping regenerable directories; false when a budget ran out. */
function filesBelow(root: string, dir: string, out: string[], budget: Budget): boolean {
	let names: string[];
	try {
		names = readdirSync(join(root, dir));
	} catch {
		out.push(dir);
		return true;
	}
	for (const name of names) {
		if (!budget.visit() || out.length >= budget.maxFiles) return false;
		const relative = `${dir}${name}`;
		let isDirectory = false;
		try {
			isDirectory = lstatSync(join(root, relative)).isDirectory();
		} catch {
			out.push(relative);
			continue;
		}
		if (isDirectory) {
			if (REGENERABLE_DIRS.has(name)) continue;
			if (!filesBelow(root, `${relative}/`, out, budget)) return false;
		} else out.push(relative);
	}
	return true;
}

/**
 * Ignored, non-regenerable files of the worktree at `path` that the primary checkout at `primaryPath`
 * does not hold identically, as paths relative to the worktree. Empty means nothing would be lost.
 */
export async function findIgnoredWork(path: string, primaryPath: string, git: GitRunner, options: IgnoredOptions = {}): Promise<string[]> {
	const listing = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], path);
	if (listing.code !== 0) return [UNKNOWN_IGNORED];
	const budget = makeBudget(options);
	const candidates: string[] = [];
	let complete = true;
	for (const entry of listing.stdout.split("\0")) {
		if (entry === "") continue;
		if (!budget.visit()) {
			complete = false;
			break;
		}
		// A trailing slash is git's mark for a collapsed directory; anything else is a file or a link.
		const isDirectory = entry.endsWith("/");
		if (regenerable(entry, isDirectory)) continue;
		if (isDirectory) {
			if (!filesBelow(path, entry, candidates, budget)) {
				complete = false;
				break;
			}
		} else candidates.push(entry);
	}
	const work: string[] = [];
	// A primary that shares a directory with the worktree through a link would "back up" the worktree's files with themselves.
	const worktreeReal = realOrPlain(path);
	for (const file of candidates) {
		// Comparing reads files, so it spends the same time budget; what is left unchecked counts as work.
		if (!budget.visit()) {
			complete = false;
			break;
		}
		const backup = join(primaryPath, file);
		if (resolvesInside(backup, worktreeReal) || !sameContent(join(path, file), backup)) work.push(file);
	}
	if (!complete) work.push(UNKNOWN_IGNORED);
	return work.sort();
}
