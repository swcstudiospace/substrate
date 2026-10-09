/**
 * Dispatcher worktree gate (DISP-03).
 *
 * Pure function over injected dependencies: the caller supplies the roots,
 * a statfs probe, an argv git runner, and an existence check. This module
 * never touches the real git binary, never opens a shell, and never invents
 * a GitHub token or a network clone.
 *
 * Order of gates (each refusal precedes the next side effect):
 *   1. `graph_id` must match GRAPH_ID_PATTERN before any path join, and
 *      `repo` must be `owner/name` in the restricted charset (T-24-02a,
 *      T-24-02b). Failures throw before any filesystem, statfs, or git use.
 *   2. `statfs` free space (`bavail * bsize`) under 5 GiB refuses with
 *      `low-disk` before any git write (T-24-02c).
 *   3. An existing worktree path is reused only when
 *      `git -C <path> remote get-url origin` resolves to the same
 *      `owner/name` as `graph.repo`; anything else is `path-conflict`,
 *      never silent reuse (T-24-02d).
 *   4. A missing bare clone under `checkouts/<owner>/<name>` is
 *      `no-checkout`. A non-zero git exit (or a runner throw) is
 *      `git-failed`.
 */

import { join, resolve, sep } from "node:path";

/**
 * Graph-id gate, copied from `packages/mcp-server/src/service.ts:436`.
 * The dispatcher must not import that module (it drags the MCP server and
 * its dependencies); the literal is pinned by the test below.
 */
export const GRAPH_ID_PATTERN = /^ut-[a-z0-9]+-[0-9a-f]{8}$/;

/** `owner/name` segments accepted into a path join or an argv array. */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 5 GiB refusal threshold, in bytes. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;

/** Branch every Hermes session checkout lives on. */
export function worktreeBranch(graphId: string): string {
	return `substrate/${graphId}`;
}

export class InvalidGraphIdError extends Error {}
export class InvalidRepoError extends Error {}

/** DISP-02 outcomes this gate can produce. */
export type WorktreeOutcome = "low-disk" | "path-conflict" | "no-checkout" | "git-failed";

export type EnsureWorktreeResult =
	| { ok: true; path: string; reused: boolean }
	| { ok: false; outcome: WorktreeOutcome };

/** Minimal statfs view: free blocks for unprivileged callers times block size. */
export interface StatfsView {
	bavail: number;
	bsize: number;
}

export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Argv git runner. Arguments are passed as an array to the process spawner,
 * never through a shell. `cwd` selects the repository the command runs in.
 */
export type GitRunner = (args: string[], options?: { cwd?: string }) => Promise<GitResult> | GitResult;

export interface WorktreeDeps {
	/** Root of per-graph worktrees (production: `/var/lib/substrate/worktrees`). */
	worktreeRoot: string;
	/** Root of bare base clones (production: `/var/lib/substrate/checkouts`). */
	checkoutsRoot: string;
	/** Free-space probe of the worktree filesystem. */
	statfs: (path: string) => StatfsView;
	/** Existence check, so tests can point at tmp directories. */
	exists: (path: string) => boolean;
	/** Injected argv git runner; throwing is treated as `git-failed`. */
	runGit: GitRunner;
}

export interface EnsureWorktreeInput {
	graphId: string;
	/** GitHub `owner/name` (assumption A3); null means the graph has no repo. */
	repo: string | null;
}

/** Throw unless `graphId` matches GRAPH_ID_PATTERN. Runs before any join. */
export function assertValidGraphId(graphId: string): void {
	if (!GRAPH_ID_PATTERN.test(graphId)) {
		throw new InvalidGraphIdError("`graph_id` must match ut-<ts36>-<8hex>");
	}
}

/** `.` and `..` are charset-legal and still walk out of the checkout root. */
function isSafeRepo(repo: string): boolean {
	if (!REPO_SLUG_PATTERN.test(repo)) return false;
	const [owner, name] = repo.split("/");
	return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

/** Throw unless `repo` is `owner/name` in the restricted charset. */
export function assertValidRepo(repo: string): string {
	if (!isSafeRepo(repo)) {
		throw new InvalidRepoError("`repo` must be owner/name of [A-Za-z0-9_.-]+");
	}
	return repo;
}

/**
 * Normalize a git origin URL to lowercase `owner/name`, or null when the
 * URL is not a recognized GitHub form. Accepts both
 * `https://github.com/<repo>.git` (with or without `.git`, with or without
 * a trailing slash) and `git@github.com:<repo>.git` per assumption A3.
 */
export function parseGitHubSlug(originUrl: string): string | null {
	const trimmed = originUrl.trim();
	let path: string | null = null;
	const https = /^https:\/\/github\.com\/(.+?)\/?$/.exec(trimmed);
	if (https) {
		path = https[1] ?? null;
	} else {
		const ssh = /^git@github\.com:(.+?)\/?$/.exec(trimmed);
		if (ssh) path = ssh[1] ?? null;
	}
	if (path === null || path.length === 0) return null;
	if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -".git".length);
	if (!isSafeRepo(path)) return null;
	return path.toLowerCase();
}

/** Join `root` with segments that are already validated; belt-and-braces containment. */
function joinContained(root: string, ...segments: string[]): string {
	const joined = join(root, ...segments);
	const base = resolve(root) + sep;
	if (resolve(joined) !== resolve(root) && !resolve(joined).startsWith(base)) {
		throw new InvalidGraphIdError("joined path escapes its root");
	}
	return joined;
}

/**
 * Ensure the verified worktree for one graph. Returns the path with whether
 * it was reused, or the DISP-02 outcome the dispatcher must comment.
 */
export async function ensureWorktree(input: EnsureWorktreeInput, deps: WorktreeDeps): Promise<EnsureWorktreeResult> {
	assertValidGraphId(input.graphId);
	if (input.repo === null || input.repo.trim().length === 0) {
		return { ok: false, outcome: "no-checkout" };
	}
	const repo = assertValidRepo(input.repo.trim());
	const expectedSlug = repo.toLowerCase();

	const worktreePath = joinContained(deps.worktreeRoot, input.graphId);
	const [owner, name] = repo.split("/");
	if (owner === undefined || name === undefined) {
		throw new InvalidRepoError("`repo` must be owner/name of [A-Za-z0-9_.-]+");
	}
	const checkoutPath = joinContained(deps.checkoutsRoot, owner, name);

	const stat = deps.statfs(deps.worktreeRoot);
	if (stat.bavail * stat.bsize < MIN_FREE_BYTES) {
		return { ok: false, outcome: "low-disk" };
	}

	if (deps.exists(worktreePath)) {
		let current: GitResult;
		try {
			current = await deps.runGit(["-C", worktreePath, "remote", "get-url", "origin"]);
		} catch {
			return { ok: false, outcome: "git-failed" };
		}
		if (current.status !== 0) {
			return { ok: false, outcome: "git-failed" };
		}
		const currentSlug = parseGitHubSlug(current.stdout);
		if (currentSlug === null || currentSlug !== expectedSlug) {
			return { ok: false, outcome: "path-conflict" };
		}
		return { ok: true, path: worktreePath, reused: true };
	}

	if (!deps.exists(checkoutPath)) {
		return { ok: false, outcome: "no-checkout" };
	}

	let added: GitResult;
	try {
		added = await deps.runGit(
			["worktree", "add", "-B", worktreeBranch(input.graphId), worktreePath, "origin/main"],
			{ cwd: checkoutPath },
		);
	} catch {
		return { ok: false, outcome: "git-failed" };
	}
	if (added.status !== 0) {
		return { ok: false, outcome: "git-failed" };
	}
	return { ok: true, path: worktreePath, reused: false };
}
