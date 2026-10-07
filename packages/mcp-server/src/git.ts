/**
 * Reading a local checkout, for `coord.drift_scan`.
 *
 * The substrate listens on 127.0.0.1 and the checkouts it compares against are
 * on the same host, so this is a local read — but the path arrives in a tool
 * argument, which is agent-supplied. Every call therefore:
 *
 *   - spawns `git` with a fixed argv and no shell, so nothing in a path can
 *     become a command;
 *   - requires an absolute path, so a leading `-` cannot become a `git` option;
 *   - is timed out and returns null rather than throwing, because a drift scan
 *     that cannot read the working tree should report that and carry on.
 *
 * This deliberately reads only. A scan tells you the trail and the tree
 * disagree; deciding what to do about it is the agent's.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 3000;

export interface GitTip {
	sha: string | null;
	short_sha: string | null;
	subject: string | null;
	committed_at: string | null;
	branch: string | null;
	/** Why the checkout could not be read. Absent on success. */
	unavailable?: string;
}

/** A path this process will run `git` in: absolute, present, and a repository. */
export function isReadableCheckout(path: string): boolean {
	if (typeof path !== "string" || !path.startsWith("/")) return false;
	if (path.includes("\0")) return false;
	// A worktree's `.git` is a file, not a directory, so existence is the test.
	return existsSync(path) && existsSync(join(path, ".git"));
}

function git(path: string, args: string[]): string | null {
	const run = Bun.spawnSync(["git", "-C", path, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	if (run.exitCode !== 0) return null;
	const out = run.stdout.toString().trim();
	return out.length > 0 ? out : null;
}

/** HEAD as the working tree has it, or a reason it could not be read. */
export function readGitTip(path: string): GitTip {
	const empty: GitTip = { sha: null, short_sha: null, subject: null, committed_at: null, branch: null };
	if (!isReadableCheckout(path)) {
		return { ...empty, unavailable: `not a readable git checkout: ${path}` };
	}
	// One call for the three values, so they cannot disagree about which commit
	// they describe — separate calls could straddle a commit landing.
	const head = git(path, ["log", "-1", "--pretty=%H%x00%h%x00%cI%x00%s"]);
	if (!head) return { ...empty, unavailable: `git log failed or the checkout has no commits: ${path}` };
	const [sha = null, short = null, committed = null, subject = null] = head.split("\0");
	return {
		sha,
		short_sha: short,
		subject,
		committed_at: committed,
		branch: git(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
	};
}

/**
 * Whether this checkout holds the commit the ledger names.
 *
 * `null` when the question could not be asked, which a scan reports differently
 * from "no": a missing commit is drift, an unreadable checkout is not.
 */
export function checkoutKnowsCommit(path: string, sha: string): boolean | null {
	if (!isReadableCheckout(path)) return null;
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
	const run = Bun.spawnSync(["git", "-C", path, "cat-file", "-e", `${sha}^{commit}`], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	// 128 is git's "not a valid object name"; any other non-zero is a failure to
	// answer rather than a negative answer.
	if (run.exitCode === 0) return true;
	return run.exitCode === 1 || run.exitCode === 128 ? false : null;
}
