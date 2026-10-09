/**
 * Repo and branch attribution shared by every collector (D19-04).
 *
 * The same origin regex the CLI's `repoSlug` and grok's `repoFor` use:
 * `owner/name` from the origin remote, whatever the URL shape. The slug is
 * cached per directory; the branch is never cached, because a collector that
 * holds a stale branch attributes every later event to the wrong one.
 */
import { spawnSync } from "node:child_process";

const slugCache = new Map<string, string | undefined>();

/** `owner/name` for a working directory, or undefined when it has no origin. */
export function repoSlug(cwd: string): string | undefined {
	if (slugCache.has(cwd)) return slugCache.get(cwd);
	const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
	const slug =
		result.status === 0 ? result.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] : undefined;
	// A missing origin is never cached: adding one later must recover delivery.
	if (slug !== undefined) slugCache.set(cwd, slug);
	return slug;
}

/** Current branch for a working directory, or undefined on an unborn HEAD. */
export function branchFor(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const branch = result.stdout.trim();
	// An unborn branch answers either with a non-zero exit or with HEAD itself.
	return branch && branch !== "HEAD" ? branch : undefined;
}
