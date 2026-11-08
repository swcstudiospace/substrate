/**
 * The `owner/name` of a worktree's origin remote, the way `substrate brief` and the other commands name a repository
 * (docs/coordination.md). Used by the `context` hook trigger, which runs git through the hook's injected runner.
 */
import type { Runner } from "../../../worktree-snapshot/src/index.ts";

/** `owner/name` from a remote URL (ssh or https, with or without `.git`), or undefined. */
function repoSlugFromRemote(url: string): string | undefined {
	return url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

/** The repo slug of the worktree's `origin`, or undefined when there is none or git cannot run. Never throws. */
export async function repoSlugOfWorktree(worktree: string, run: Runner): Promise<string | undefined> {
	try {
		const result = await run(["git", "-C", worktree, "remote", "get-url", "origin"]);
		if (result.code !== 0) return undefined;
		return repoSlugFromRemote(result.stdout.toString("utf8"));
	} catch {
		// git could not run or there is no origin remote: the slug is unknown.
		return undefined;
	}
}
