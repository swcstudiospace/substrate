/**
 * What worktrees exist and what state each is in, found through git and not through a path convention.
 *
 * `discoverRepos` looks for repositories below the configured roots (a `.git` directory or gitfile) and
 * collapses every linked worktree to its common git dir, so one repository is one entry however many
 * of its worktrees sit under the roots. `listWorktrees` then asks git (`git worktree list
 * --porcelain -z`) for every worktree of that repository, including linked ones outside the roots. The
 * listing is NUL-delimited because a path may legally hold a newline.
 * `inspectWorktree` gathers the facts the classifier and the report need. Every unreadable fact becomes
 * null, false-for-clean is never assumed: a failed `git status` is reported as dirty.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, join, resolve } from "node:path";
import { normalizeWorktreeFiles, WORKTREE_FILE_MAX_CHARS, WORKTREE_FILES_MAX, WORKTREE_REPO_PATTERN } from "../../mcp-server/src/worktree-registry.ts";
import { changedFiles } from "./conflicts.ts";
import { type CommandRunner, type GitRunner, gitOut } from "./git.ts";
import { mapLimit } from "./pool.ts";
import { Gate, lookupPr, type PrState, PR_NONE, PR_UNKNOWN, type PrInfo, DEFAULT_PR_CONCURRENCY } from "./pr.ts";
import { findIgnoredWork } from "./ignored.ts";
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_MS, measureTree } from "./size.ts";

export interface WorktreeEntry {
	path: string;
	head: string | null;
	/** Short branch name, null when detached or bare. */
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
	/** Git lists the main working tree first. */
	primary: boolean;
}

/**
 * `git worktree list --porcelain -z`: each field is NUL-terminated and an empty field ends a record, so a path
 * or a lock reason that holds a newline stays in one piece.
 */
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const field of text.split("\0")) {
		if (field === "") {
			if (current !== null) entries.push(current);
			current = null;
			continue;
		}
		if (field.startsWith("worktree ")) {
			if (current !== null) entries.push(current);
			current = { path: field.slice("worktree ".length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, primary: entries.length === 0 };
			continue;
		}
		if (current === null) continue;
		if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length).trim();
		else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		else if (field === "detached") current.detached = true;
		else if (field === "bare") current.bare = true;
		else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
		else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
	}
	if (current !== null) entries.push(current);
	return entries;
}

/** Every worktree of the repository `repoDir` belongs to, or null when git could not list them. */
export async function listWorktrees(repoDir: string, git: GitRunner): Promise<WorktreeEntry[] | null> {
	const result = await git(["worktree", "list", "--porcelain", "-z"], repoDir);
	return result.code === 0 ? parseWorktreePorcelain(result.stdout) : null;
}

/**
 * The worktree at `path` as git lists it now, ready for `inspectWorktree`; null when git cannot list the
 * repository, no longer lists the path, or lists it as bare. Head, branch and detachment move whenever another
 * session commits or switches branch, so a decision that follows an earlier inventory must start from this and
 * never from the inventory's copy: a merge proof for an old head says nothing about the head that is there now.
 */
export async function reloadWorktree(path: string, repoDir: string, git: GitRunner): Promise<InspectInput | null> {
	const entry = (await listWorktrees(repoDir, git))?.find((item) => item.path === path);
	return entry === undefined || entry.bare ? null : { ...entry, repoDir };
}

export interface RepoRef {
	/** Absolute, resolved git common dir: the identity of the repository. */
	commonDir: string;
	/** A working directory to run git in; the primary checkout when one was found under the roots. */
	dir: string;
}

export interface DiscoverOptions {
	git: GitRunner;
	/** Directories below a root to look through; a root's own children are depth 1. Default 3. */
	maxDepth?: number;
	/** Directories visited across all roots before the scan stops with a note. Default 20000. */
	maxEntries?: number;
}

export interface Discovery {
	repos: RepoRef[];
	notes: string[];
}

export const DEFAULT_DISCOVER_DEPTH = 3;
export const DEFAULT_DISCOVER_ENTRIES = 20_000;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);
const GIT_CONCURRENCY = 6;

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export async function discoverRepos(roots: readonly string[], options: DiscoverOptions): Promise<Discovery> {
	const maxDepth = options.maxDepth ?? DEFAULT_DISCOVER_DEPTH;
	const maxEntries = options.maxEntries ?? DEFAULT_DISCOVER_ENTRIES;
	const notes: string[] = [];
	const candidates: Array<{ dir: string; gitIsDir: boolean }> = [];
	let visited = 0;
	for (const root of roots) {
		if (!existsSync(root)) {
			notes.push(`root ${root} does not exist`);
			continue;
		}
		const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
		while (queue.length > 0) {
			const item = queue.shift();
			if (item === undefined) break;
			visited += 1;
			if (visited > maxEntries) {
				notes.push(`repository scan stopped after ${maxEntries} directories`);
				break;
			}
			const gitPath = join(item.dir, ".git");
			let gitStat: Stats | null = null;
			try {
				gitStat = lstatSync(gitPath);
			} catch {
				gitStat = null;
			}
			if (gitStat !== null) {
				candidates.push({ dir: item.dir, gitIsDir: gitStat.isDirectory() });
				continue;
			}
			if (item.depth >= maxDepth) continue;
			let children: string[];
			try {
				children = readdirSync(item.dir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
					.map((entry) => join(item.dir, entry.name))
					.sort();
			} catch {
				notes.push(`could not read ${item.dir}`);
				continue;
			}
			for (const child of children) queue.push({ dir: child, depth: item.depth + 1 });
		}
	}
	const resolved = await mapLimit(candidates, GIT_CONCURRENCY, async (candidate) => {
		if (candidate.gitIsDir) return { dir: candidate.dir, commonDir: canonical(join(candidate.dir, ".git")), primary: true };
		const out = await gitOut(options.git, ["rev-parse", "--git-common-dir"], candidate.dir);
		if (out === null || out === "") {
			notes.push(`${candidate.dir} has a .git entry but git could not resolve it`);
			return null;
		}
		return { dir: candidate.dir, commonDir: canonical(resolve(candidate.dir, out)), primary: false };
	});
	const byCommon = new Map<string, { ref: RepoRef; primary: boolean }>();
	for (const entry of resolved) {
		if (entry === null) continue;
		const existing = byCommon.get(entry.commonDir);
		if (existing === undefined || (entry.primary && !existing.primary)) byCommon.set(entry.commonDir, { ref: { commonDir: entry.commonDir, dir: entry.dir }, primary: entry.primary });
	}
	return { repos: [...byCommon.values()].map((value) => value.ref).sort((a, b) => a.commonDir.localeCompare(b.commonDir)), notes };
}

export interface WorktreeInfo {
	path: string;
	/** `owner/name` from origin, else `local/<directory>` (see `localRepoLabel` for directories the registry would refuse). */
	repo: string;
	/** The primary checkout of the repository: where git commands about this worktree run. */
	repo_dir: string;
	branch: string | null;
	head: string;
	base: string | null;
	dirty: boolean;
	ahead: number | null;
	behind: number | null;
	last_commit_at: string | null;
	/** Newest file modification time; null when it could not be established completely. */
	last_activity_at: string | null;
	size_bytes: number | null;
	locked: boolean;
	primary: boolean;
	pr_state: PrState;
	detached: boolean;
	/** Git lists the worktree but its directory is gone. */
	prunable: boolean;
	default_ref: string | null;
	/** `origin/<branch>` contains HEAD, or HEAD is in the default branch. */
	pushed: boolean;
	/** HEAD is an ancestor of the default branch; null when that could not be asked. */
	merged: boolean | null;
	pr_number: number | null;
	pr_head_sha: string | null;
	/** Head commits of the merged pull requests that merged into the default branch: a head merged only into another base is not merged here. */
	pr_merged_heads: string[];
	/** Ignored, non-regenerable files that the primary checkout does not hold identically; removal would delete them. */
	ignored_work: string[];
	/**
	 * The files this worktree changed against its merge base plus its uncommitted changes, sorted, at most `WORKTREE_FILES_MAX`.
	 * Absent: not asked for (`InspectOptions.files`) or not listed because the directory is gone. `null`: asked and the listing
	 * failed (no merge base, a failed git command), which is unknown and never "touches nothing"; `notes` says why.
	 */
	files?: string[] | null;
	/** True when more than `WORKTREE_FILES_MAX` paths were changed and `files` holds the first of them. */
	files_truncated?: boolean;
	notes: string[];
}

export interface PrShared {
	run: CommandRunner;
	cache: Map<string, Promise<PrInfo>>;
	gate: Gate;
}

export function createPrShared(run: CommandRunner, concurrency = DEFAULT_PR_CONCURRENCY): PrShared {
	return { run, cache: new Map(), gate: new Gate(concurrency) };
}

interface RepoFacts {
	repo: string;
	defaultRef: string | null;
}

export interface InspectOptions {
	git: GitRunner;
	/** Pull-request lookups; absent means `pr_state` is `unknown` for every worktree. */
	pr?: PrShared;
	/** Measure size and last activity (default true). */
	measure?: boolean;
	/** Look for ignored files that hold work (default true); only prune decisions need it. */
	ignored?: boolean;
	/** List the changed files for the registry report (default false: it costs two more git calls per worktree). */
	files?: boolean;
	maxEntries?: number;
	maxMs?: number;
	now?: () => number;
	/** Shared per-repository facts, so a repository's remote and default branch are asked once. */
	facts?: Map<string, Promise<RepoFacts>>;
}

export interface InspectInput extends WorktreeEntry {
	/** Primary checkout of the repository this worktree belongs to. */
	repoDir: string;
}

const SLUG_PATTERN = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/;

/** The name part of a repository label holds at most this many characters (the registry pattern's `{1,100}`). */
const LOCAL_NAME_MAX = 100;
const LOCAL_HASH_CHARS = 8;

/**
 * A label for a checkout with no origin that the registry accepts: `local/<directory>` when that already fits
 * the registry's repository pattern, else `local/<slug>-<8 hex of sha256 of the directory name>`. The slug keeps
 * `[A-Za-z0-9._-]`, replaces every other character with `-`, drops leading dots and dashes and is never empty,
 * so two directories whose names differ only in the replaced characters still get different labels.
 */
export function localRepoLabel(directory: string): string {
	const plain = `local/${directory}`;
	if (WORKTREE_REPO_PATTERN.test(plain)) return plain;
	const slug = directory.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[.-]+/, "") || "repo";
	const digest = createHash("sha256").update(directory).digest("hex").slice(0, LOCAL_HASH_CHARS);
	return `local/${slug.slice(0, LOCAL_NAME_MAX - LOCAL_HASH_CHARS - 1)}-${digest}`;
}

/** The default branch to compare against: origin's HEAD, else `main`, else `master`. */
export async function resolveDefaultRef(repoDir: string, git: GitRunner): Promise<string | null> {
	const origin = await gitOut(git, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], repoDir);
	if (origin !== null && origin !== "" && (await git(["rev-parse", "--verify", "-q", `refs/remotes/${origin}`], repoDir)).code === 0) return origin;
	for (const name of ["main", "master"]) {
		if ((await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`], repoDir)).code === 0) return name;
	}
	return null;
}

async function repoFacts(repoDir: string, options: InspectOptions): Promise<RepoFacts> {
	const load = async (): Promise<RepoFacts> => {
		const url = await gitOut(options.git, ["remote", "get-url", "origin"], repoDir);
		const slug = url === null ? null : SLUG_PATTERN.exec(url)?.[1] ?? null;
		return { repo: slug ?? localRepoLabel(basename(repoDir)), defaultRef: await resolveDefaultRef(repoDir, options.git) };
	};
	if (options.facts === undefined) return load();
	const cached = options.facts.get(repoDir);
	if (cached !== undefined) return cached;
	const pending = load();
	options.facts.set(repoDir, pending);
	return pending;
}

async function exitCodeOf(git: GitRunner, args: string[], cwd: string): Promise<number> {
	return (await git(args, cwd)).code;
}

function isoFromSeconds(text: string | null): string | null {
	if (text === null) return null;
	const seconds = Number(text);
	return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

const ZERO_SHA = "0".repeat(40);

export async function inspectWorktree(wt: InspectInput, options: InspectOptions): Promise<WorktreeInfo> {
	const facts = await repoFacts(wt.repoDir, options);
	const base: WorktreeInfo = {
		path: wt.path,
		repo: facts.repo,
		repo_dir: wt.repoDir,
		branch: wt.branch,
		head: wt.head ?? ZERO_SHA,
		base: null,
		dirty: false,
		ahead: null,
		behind: null,
		last_commit_at: null,
		last_activity_at: null,
		size_bytes: null,
		locked: wt.locked,
		primary: wt.primary,
		pr_state: "unknown",
		detached: wt.detached,
		prunable: wt.prunable,
		default_ref: facts.defaultRef,
		pushed: false,
		merged: null,
		pr_number: null,
		pr_head_sha: null,
		pr_merged_heads: [],
		ignored_work: [],
		notes: [],
	};
	if (wt.prunable || !existsSync(wt.path)) {
		base.prunable = true;
		base.notes.push("the worktree directory is missing");
		return base;
	}

	const git = options.git;
	const cwd = wt.path;
	const defaultRef = facts.defaultRef;
	const defaultName = defaultRef?.replace(/^origin\//, "") ?? null;
	// A detached HEAD or the default branch itself has no pull request of its own to ask about.
	const noPullRequest = wt.branch === null || wt.detached || wt.branch === defaultName;
	const wantPr = options.pr !== undefined && !noPullRequest && !wt.primary;
	const [status, mergeBase, counts, commitTime, ancestorOfDefault, ancestorOfRemote, remoteContains, pr, measurement, ignoredWork] = await Promise.all([
		// `--untracked-files=all` overrides `status.showUntrackedFiles`, which a user may set to hide new files.
		git(["status", "--porcelain", "--untracked-files=all"], cwd),
		defaultRef === null ? Promise.resolve(null) : gitOut(git, ["merge-base", defaultRef, "HEAD"], cwd),
		defaultRef === null ? Promise.resolve(null) : gitOut(git, ["rev-list", "--left-right", "--count", `${defaultRef}...HEAD`], cwd),
		gitOut(git, ["log", "-1", "--format=%ct", "HEAD"], cwd),
		defaultRef === null ? Promise.resolve(null) : exitCodeOf(git, ["merge-base", "--is-ancestor", "HEAD", defaultRef], cwd),
		wt.branch === null ? Promise.resolve(null) : exitCodeOf(git, ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${wt.branch}`], cwd),
		wt.branch === null ? gitOut(git, ["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/remotes"], cwd) : Promise.resolve(null),
		wantPr && options.pr !== undefined && wt.branch !== null
			? lookupPr(wt.branch, { run: options.pr.run, cwd: wt.repoDir, cache: options.pr.cache, gate: options.pr.gate })
			: Promise.resolve(noPullRequest ? PR_NONE : PR_UNKNOWN),
		options.measure === false
			? Promise.resolve(null)
			: measureTree(cwd, { maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES, maxMs: options.maxMs ?? DEFAULT_MAX_MS, ...(options.now === undefined ? {} : { now: options.now }) }),
		// The primary checkout has no removal to lose files in; every other worktree is compared against it.
		wt.primary || options.ignored === false ? Promise.resolve<string[]>([]) : findIgnoredWork(cwd, wt.repoDir, git),
	]);

	if (status.code !== 0) {
		// An unreadable status is never a clean one.
		base.dirty = true;
		base.notes.push(`git status failed: ${status.stderr.trim().slice(0, 120)}`);
	} else base.dirty = status.stdout.trim() !== "";

	base.base = mergeBase === "" ? null : mergeBase;
	if (counts !== null) {
		const [behind, ahead] = counts.split(/\s+/).map(Number);
		if (behind !== undefined && ahead !== undefined && Number.isFinite(behind) && Number.isFinite(ahead)) {
			base.behind = behind;
			base.ahead = ahead;
		}
	}
	base.last_commit_at = isoFromSeconds(commitTime);
	base.merged = ancestorOfDefault === null ? null : ancestorOfDefault === 0 ? true : ancestorOfDefault === 1 ? false : null;
	const remoteHasHead = wt.branch !== null ? ancestorOfRemote === 0 : remoteContains !== null && remoteContains !== "";
	base.pushed = remoteHasHead || base.merged === true;
	base.pr_state = pr.state;
	base.pr_number = pr.number;
	base.pr_head_sha = pr.headSha;
	base.pr_merged_heads = defaultName === null ? [] : pr.mergedHeads.filter((merged) => merged.baseRef === defaultName).map((merged) => merged.headSha);
	base.ignored_work = ignoredWork;
	if (measurement !== null) {
		base.size_bytes = measurement.bytes;
		base.last_activity_at = measurement.lastActivityMs === null ? null : new Date(measurement.lastActivityMs).toISOString();
		if (measurement.note !== null) base.notes.push(measurement.note);
	} else base.notes.push("size and activity were not measured");
	if (options.files === true) {
		const listing = await changedFiles({ path: cwd, base: base.base }, git);
		if (listing.notes.length > 0) {
			// A partial listing would read as "touches less than it does": unknown, with the reason conflicts would give.
			base.files = null;
			base.notes.push(...listing.notes);
		} else {
			const reportable = normalizeWorktreeFiles(listing.files);
			if (reportable.length < listing.files.length) {
				base.notes.push(`${listing.files.length - reportable.length} changed paths were not reported (absolute, over ${WORKTREE_FILE_MAX_CHARS} characters, or holding a control character)`);
			}
			base.files = reportable.slice(0, WORKTREE_FILES_MAX);
			base.files_truncated = reportable.length > WORKTREE_FILES_MAX;
		}
	}
	if (defaultRef === null) base.notes.push("no default branch found (origin/HEAD, main, master)");
	return base;
}

export interface InventoryOptions extends InspectOptions {
	maxDepth?: number;
	concurrency?: number;
}

export interface Inventory {
	worktrees: WorktreeInfo[];
	repos: RepoRef[];
	notes: string[];
}

const INSPECT_CONCURRENCY = 4;

/** Discover repositories under `roots`, list every worktree of each, inspect each once. */
export async function collectInventory(roots: readonly string[], options: InventoryOptions): Promise<Inventory> {
	const discovery = await discoverRepos(roots, { git: options.git, ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }) });
	const notes = [...discovery.notes];
	const facts = options.facts ?? new Map<string, Promise<RepoFacts>>();
	const inputs: InspectInput[] = [];
	const claimed = new Set<string>();
	for (const repo of discovery.repos) {
		const listed = await listWorktrees(repo.dir, options.git);
		if (listed === null) {
			notes.push(`git worktree list failed in ${repo.dir}`);
			continue;
		}
		const primary = listed[0];
		if (primary === undefined) continue;
		for (const entry of listed) {
			if (entry.bare) continue;
			const key = canonical(entry.path);
			if (claimed.has(key)) continue;
			claimed.add(key);
			inputs.push({ ...entry, repoDir: primary.path });
		}
	}
	const worktrees = await mapLimit(inputs, options.concurrency ?? INSPECT_CONCURRENCY, (input) => inspectWorktree(input, { ...options, facts }));
	worktrees.sort((a, b) => a.path.localeCompare(b.path));
	return { worktrees, repos: discovery.repos, notes };
}
