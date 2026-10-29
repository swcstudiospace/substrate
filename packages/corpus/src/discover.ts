/**
 * Find the repositories below a set of roots (v1.7 phase 63, decision D63-6).
 *
 * A checkout is a directory with a `.git` entry (a directory, or a file for a linked worktree). Linked worktrees of one
 * repository collapse to one checkout, and so do clones of one origin: the canonical checkout is the one on its default
 * branch with the newest HEAD commit. A directory with no `.git` that holds documentation is a copy collection and is
 * reported separately so the scan can walk it under its `localRepoId` label. A label that more than one directory yields
 * is reported in `duplicates`: the scan reads those directories but never covers the label.
 *
 * Git is reached through an injected runner that takes an argument vector, never a shell string.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hasDocExtension, isExcludedSegment } from "./classify.ts";
import { localRepoId } from "./names.ts";

export interface GitResult {
	code: number;
	stdout: string;
}

/** Runs `git <args>` in `cwd`. A result with a non-zero `code` means git refused; it never throws for that. */
export type GitRunner = (args: string[], cwd: string) => GitResult;

/** Output of `git ls-files` in a large checkout is long; the ceiling only guards against a runaway process. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export const defaultGitRunner: GitRunner = (args, cwd) => {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
	return { code: result.status ?? 1, stdout: result.stdout ?? "" };
};

export interface Checkout {
	dir: string;
	/** `owner/name` for a GitHub origin, else `local/<directory name>`. */
	repo: string;
	/** The origin URL with any credentials removed, or null when the checkout has no origin remote. */
	origin: string | null;
	/** The shared git directory; linked worktrees of one repository have the same one. */
	commonDir: string;
	head: string | null;
	/** The checked-out branch, or null when HEAD is detached. */
	branch: string | null;
	/** True for a linked worktree: its own git directory differs from the shared one. */
	linked: boolean;
	headTimeMs: number | null;
}

export interface Collection {
	dir: string;
	repo: string;
}

export interface CollapseRecord {
	kind: "worktree" | "clone";
	/** The directory that was folded away. */
	dir: string;
	/** The directory it was folded into. */
	into: string;
	repo: string;
}

/** One repository label that several directories under the selected roots yield. */
export interface DuplicateLabel {
	repo: string;
	/** Every directory that yields the label (checkouts and copy collections), in root order. */
	dirs: string[];
}

export interface DiscoverOptions {
	/** How many directory levels below a root are searched for `.git`. Default 3. */
	depth?: number | undefined;
	run?: GitRunner | undefined;
}

export interface DiscoverResult {
	/** The canonical checkouts, sorted by repo then directory. */
	checkouts: Checkout[];
	/** Copy collections to scan by walking, sorted by directory. */
	collections: Collection[];
	/** Labels yielded by more than one directory, sorted by label. Never covered; see {@link DuplicateLabel}. */
	duplicates: DuplicateLabel[];
	/** How many checkouts existed before collapsing. */
	found: number;
	collapsed: { clones: number; worktrees: number; records: CollapseRecord[] };
	notes: string[];
}

/** The reason a label is left out of the coverage and the word that starts its note. */
export const DUPLICATE_LABEL = "duplicate-label";

/** The last two components of a directory path: enough to tell two folders apart in a report, never an absolute path. */
export function directoryLabel(dir: string): string {
	const parent = basename(dirname(dir));
	return parent === "" ? basename(dir) : `${parent}/${basename(dir)}`;
}

export const DEFAULT_DISCOVER_DEPTH = 3;

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/** `owner/name` from a GitHub URL in https, ssh or scp form, or null when the URL is not a GitHub one. */
export function githubSlug(origin: string): string | null {
	const text = origin.trim();
	const forms = [
		/^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^/]*@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
		/^(?:[^@/\s]+@)?(?:www\.)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	];
	for (const form of forms) {
		const match = form.exec(text);
		const owner = match?.[1];
		const name = match?.[2];
		if (owner !== undefined && name !== undefined && GITHUB_NAME.test(owner) && GITHUB_NAME.test(name)) {
			return `${owner}/${name}`;
		}
	}
	return null;
}

/** `owner/name` for a GitHub origin, else the label of a plain directory (`localRepoId`). */
export function repoFromOrigin(origin: string | null, dirName: string): string {
	const slug = origin === null ? null : githubSlug(origin);
	return slug ?? localRepoId(dirName);
}

/** The origin URL without userinfo (`https://user:secret@host/x` becomes `https://host/x`); scp-style URLs are kept. */
export function stripCredentials(origin: string): string {
	return origin.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

export interface DirEntry {
	name: string;
	kind: "dir" | "file" | "symlink" | "other";
}

/** The entries of `dir` sorted by name, so every walk is deterministic. Throws what `readdir` throws. */
export function readEntries(dir: string): DirEntry[] {
	return readdirSync(dir, { withFileTypes: true })
		.map((entry): DirEntry => {
			const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
			return { name: entry.name, kind };
		})
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** True when `dir` has a `.git` entry of any kind. */
export function hasGitEntry(dir: string): boolean {
	try {
		lstatSync(join(dir, ".git"));
		return true;
	} catch {
		// No .git entry, or one that cannot be inspected: either way this is not a checkout this scan can use.
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		// A missing or unreadable root is reported by the caller as "not a directory".
		return false;
	}
}

/** True when the tree below `dir` holds a documentation file outside excluded directories and nested checkouts. */
function holdsDocs(dir: string): boolean {
	const stack = [dir];
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		let entries: DirEntry[];
		try {
			entries = readEntries(next);
		} catch {
			// An unreadable directory holds nothing this scan can read.
			continue;
		}
		for (const entry of entries) {
			if (entry.kind === "file" && hasDocExtension(entry.name)) return true;
			if (entry.kind === "dir" && !isExcludedSegment(entry.name) && !hasGitEntry(join(next, entry.name))) {
				stack.push(join(next, entry.name));
			}
		}
	}
	return false;
}

interface Walk {
	maxDepth: number;
	gitDirs: string[];
	collections: string[];
	notes: string[];
	/** The order each directory was first visited in: roots in the order given, then names inside a root. */
	order: Map<string, number>;
}

function explore(dir: string, depth: number, walk: Walk): void {
	if (!walk.order.has(dir)) walk.order.set(dir, walk.order.size);
	if (hasGitEntry(dir)) {
		walk.gitDirs.push(dir);
		return;
	}
	const gitsBefore = walk.gitDirs.length;
	const collectionsBefore = walk.collections.length;
	let entries: DirEntry[];
	try {
		entries = readEntries(dir);
	} catch (cause) {
		walk.notes.push(`cannot read ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`);
		return;
	}
	if (depth < walk.maxDepth) {
		for (const entry of entries) {
			if (entry.kind === "dir" && !isExcludedSegment(entry.name)) explore(join(dir, entry.name), depth + 1, walk);
		}
	}
	if (depth === 0) {
		// A root that holds checkouts is a container and its loose files are not scanned. A root with no checkout below it
		// and documentation files of its own is a plain pile and is one collection, subsuming the directories below it; a
		// root that only holds directories keeps those as the collections.
		const hasOwnDocs = entries.some((entry) => entry.kind === "file" && hasDocExtension(entry.name));
		if (walk.gitDirs.length === gitsBefore && hasOwnDocs) {
			walk.collections.length = collectionsBefore;
			walk.collections.push(dir);
		}
		return;
	}
	// The topmost directory that holds documentation owns everything below it, so a collection inside one is subsumed.
	if (holdsDocs(dir)) {
		walk.collections.length = collectionsBefore;
		walk.collections.push(dir);
		return;
	}
	// A readable immediate child of a root that holds no checkout and no documentation is a collection that was emptied:
	// it stays a collection so the scan covers it with zero entries and its old rows are tombstoned, instead of it
	// looking like a directory the scan never reached.
	if (depth === 1 && walk.gitDirs.length === gitsBefore) walk.collections.push(dir);
}

interface Ranked {
	checkout: Checkout;
	onDefault: boolean;
}

function inspectCheckout(dir: string, run: GitRunner): Ranked {
	const text = (args: string[]): string | null => {
		const result = run(args, dir);
		const value = result.stdout.trim();
		return result.code === 0 && value !== "" ? value : null;
	};
	const rawOrigin = text(["remote", "get-url", "origin"]);
	const origin = rawOrigin === null ? null : stripCredentials(rawOrigin);
	const dirs = (text(["rev-parse", "--git-dir", "--git-common-dir"]) ?? "").split("\n").map((line) => line.trim());
	const gitDir = resolve(dir, dirs[0] || ".git");
	const commonDir = resolve(dir, dirs[1] || dirs[0] || ".git");
	const head = text(["rev-parse", "--verify", "-q", "HEAD"]);
	const branch = text(["symbolic-ref", "--short", "-q", "HEAD"]);
	const seconds = head === null ? null : Number.parseInt(text(["log", "-1", "--format=%ct"]) ?? "", 10);
	const remoteHead = text(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	const defaultBranch =
		remoteHead !== null
			? remoteHead.replace(/^origin\//, "")
			: run(["show-ref", "--verify", "-q", "refs/heads/main"], dir).code === 0
				? "main"
				: "master";
	return {
		checkout: {
			dir,
			repo: repoFromOrigin(origin, basename(dir)),
			origin,
			commonDir,
			head,
			branch,
			linked: gitDir !== commonDir,
			headTimeMs: seconds !== null && Number.isFinite(seconds) ? seconds * 1000 : null,
		},
		onDefault: branch !== null && branch === defaultBranch,
	};
}

/** Negative when `a` is the better canonical checkout: on its default branch, newest HEAD, shortest path, then lexical. */
function rank(a: Ranked, b: Ranked): number {
	if (a.onDefault !== b.onDefault) return a.onDefault ? -1 : 1;
	const timeA = a.checkout.headTimeMs ?? Number.NEGATIVE_INFINITY;
	const timeB = b.checkout.headTimeMs ?? Number.NEGATIVE_INFINITY;
	if (timeA !== timeB) return timeB > timeA ? 1 : -1;
	if (a.checkout.dir.length !== b.checkout.dir.length) return a.checkout.dir.length - b.checkout.dir.length;
	return a.checkout.dir < b.checkout.dir ? -1 : a.checkout.dir > b.checkout.dir ? 1 : 0;
}

/** Groups by `keyOf`, keeps the best of each group and records the others as collapsed into it. */
function collapseBy(
	items: Ranked[],
	keyOf: (item: Ranked) => string | null,
	kind: "worktree" | "clone",
	describe: (kept: Checkout, folded: Checkout) => string,
	into: { records: CollapseRecord[]; notes: string[] },
): Ranked[] {
	const groups = new Map<string, Ranked[]>();
	const singles: Ranked[] = [];
	for (const item of items) {
		const key = keyOf(item);
		if (key === null) {
			singles.push(item);
			continue;
		}
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [item]);
		else group.push(item);
	}
	const kept = [...singles];
	for (const group of groups.values()) {
		const [best, ...rest] = [...group].sort(rank);
		if (best === undefined) continue;
		kept.push(best);
		for (const folded of rest) {
			into.records.push({ kind, dir: folded.checkout.dir, into: best.checkout.dir, repo: best.checkout.repo });
			into.notes.push(describe(best.checkout, folded.checkout));
		}
	}
	return kept;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Discover the checkouts and copy collections below `roots`. Roots that do not exist are noted and skipped. The same
 * directory reached through two roots is found once.
 */
export function discoverRepos(roots: readonly string[], opts: DiscoverOptions = {}): DiscoverResult {
	const run = opts.run ?? defaultGitRunner;
	const walk: Walk = {
		maxDepth: Math.max(0, Math.floor(opts.depth ?? DEFAULT_DISCOVER_DEPTH)),
		gitDirs: [],
		collections: [],
		notes: [],
		order: new Map(),
	};
	for (const root of new Set(roots.map((root) => resolve(root)))) {
		if (!isDirectory(root)) {
			walk.notes.push(`root ${root} is not a directory`);
			continue;
		}
		explore(root, 0, walk);
	}

	const inspected = [...new Set(walk.gitDirs)].map((dir) => inspectCheckout(dir, run));
	const records: CollapseRecord[] = [];
	const notes = [...walk.notes];
	const sink = { records, notes };
	const oneEach = collapseBy(
		inspected,
		(item) => item.checkout.commonDir,
		"worktree",
		(kept, folded) => `linked worktree ${folded.dir} collapsed into ${kept.dir} (shared git directory)`,
		sink,
	);
	// Clones of one origin, and checkouts with no origin that share a directory name and so a repo label.
	const survivors = collapseBy(
		oneEach,
		(item) => item.checkout.repo,
		"clone",
		(kept, folded) => `clone ${folded.dir} collapsed into ${kept.dir} (${kept.repo})`,
		sink,
	);
	const checkouts = survivors
		.map((item) => item.checkout)
		.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.dir, b.dir));

	// A label that more than one directory yields (two copy collections, or a checkout and a copy collection) cannot be
	// told apart from a live folder that happens to share a name, so it is reported and never covered: the scan reads every
	// directory that holds documents, an empty one shadows nothing, and no row under the label is judged removed.
	const collectionDirs = [...new Set(walk.collections)].sort(compareText);
	const dirsByLabel = new Map<string, string[]>();
	const claim = (repo: string, dir: string): void => {
		const dirs = dirsByLabel.get(repo);
		if (dirs === undefined) dirsByLabel.set(repo, [dir]);
		else dirs.push(dir);
	};
	for (const checkout of checkouts) claim(checkout.repo, checkout.dir);
	const collections: Collection[] = collectionDirs.map((dir) => ({ dir, repo: localRepoId(basename(dir)) }));
	for (const collection of collections) claim(collection.repo, collection.dir);
	const duplicates: DuplicateLabel[] = [];
	for (const [repo, dirs] of dirsByLabel) {
		if (dirs.length < 2) continue;
		// Root order, then discovery order inside a root: the first directory that holds a path wins it.
		dirs.sort((a, b) => (walk.order.get(a) ?? 0) - (walk.order.get(b) ?? 0));
		duplicates.push({ repo, dirs });
		notes.push(`${DUPLICATE_LABEL}: ${repo} is yielded by ${dirs.map(directoryLabel).join(" and ")}; it is read but left out of the coverage`);
	}
	duplicates.sort((a, b) => compareText(a.repo, b.repo));

	return {
		checkouts,
		collections,
		duplicates,
		found: inspected.length,
		collapsed: {
			clones: records.filter((record) => record.kind === "clone").length,
			worktrees: records.filter((record) => record.kind === "worktree").length,
			records,
		},
		notes,
	};
}
