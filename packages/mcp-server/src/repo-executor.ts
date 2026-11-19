/**
 * The scoped git executor (phase 72): the one entry point that runs git against a registered repository.
 *
 * {@link scopedGit} decides first and spawns second. The decision (`repo-scope.ts`) places the working directory inside a
 * registered repository and checks the surface's grant; only then does the runner receive the call. A refusal returns
 * before the runner is called, so no git process starts and no byte of the repository is read.
 *
 * Git runs with `cwd` set to the resolved target (the real path the request named, or the registered checkout) and with
 * `GIT_CEILING_DIRECTORIES` set to the parent of the registered directory that holds it, so git's upward search for an
 * enclosing repository stops inside the scope and cannot reach another repository through a parent. The arguments are an
 * argv array; nothing is joined into a shell string.
 *
 * Phase 74 calls this entry point for cross-repository steps. It does not re-implement the checks.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { isGranted, locateRepoPath, realDirectoryOrNull, type RepoRefusalReason, type RepoScope, scopeRepoId } from "./repo-scope.ts";
import type { Surface } from "./types.ts";

export interface ScopedGitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one git call in `cwd` with `env` added. Injected so tests observe the call without spawning git. */
export type ScopedGitRunner = (args: readonly string[], cwd: string, env: Record<string, string>) => ScopedGitResult;

export interface ScopedGitRequest {
	scope: RepoScope;
	/** The caller's surface, or null for an anonymous caller. */
	surface: Surface | null;
	/** The repository the caller names, as `owner/name`. Optional when `path` is given. */
	repo: string | null;
	/** A directory inside the repository. Null means the registered checkout of `repo`. */
	path: string | null;
	args: readonly string[];
}

/** Where a git call runs: the resolved target, and the registered directory that contains it. */
export interface ScopedLocation {
	repo: string;
	root: string;
	target: string;
}

export type ScopedGitOutcome = ({ ok: true; result: ScopedGitResult } & ScopedLocation) | { ok: false; reason: RepoRefusalReason };

/** The default runner: argv, no shell, git's own locks and prompts off. */
export const defaultScopedGitRunner: ScopedGitRunner = (args, cwd, env) => {
	const run = spawnSync("git", [...args], {
		cwd,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", ...env },
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
	return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

/** The registered checkout of `repo` that exists on this host. Refused when the repository is unregistered or none of its checkouts exist. */
function checkoutOf(scope: RepoScope, repo: string): { ok: true; location: ScopedLocation } | { ok: false; reason: RepoRefusalReason } {
	const registration = scope.registry.get(repo);
	if (registration === undefined) return { ok: false, reason: "repo-not-registered" };
	for (const dir of registration.checkouts) {
		const root = realDirectoryOrNull(dir);
		if (root !== null) return { ok: true, location: { repo, root, target: root } };
	}
	return { ok: false, reason: "repo-not-registered" };
}

/** Where the request points: a registered path, or the registered checkout of a named repository. */
function locate(request: ScopedGitRequest, named: string | null): { ok: true; location: ScopedLocation } | { ok: false; reason: RepoRefusalReason } {
	if (request.path !== null) {
		const located = locateRepoPath(request.scope, request.path);
		return located === null ? { ok: false, reason: "path-not-registered" } : { ok: true, location: located };
	}
	return named === null ? { ok: false, reason: "repo-not-registered" } : checkoutOf(request.scope, named);
}

/**
 * Runs `args` in a registered repository if the surface may address it. A refusal returns before `run` is called.
 *
 * Unlike the API's path gate, the executor always requires a registration, even when grants are not enforced: a
 * cross-repository step must run in a checkout the operator placed, never in a directory it found.
 */
export function scopedGit(request: ScopedGitRequest, run: ScopedGitRunner): ScopedGitOutcome {
	const named = request.repo === null ? null : scopeRepoId(request.repo);
	if (request.repo !== null && named === "") return { ok: false, reason: "repo-not-registered" };
	const located = locate(request, named);
	if (!located.ok) return located;
	const { repo, root, target } = located.location;
	if (!isGranted(request.scope, request.surface, repo)) return { ok: false, reason: "repo-not-granted" };
	if (named !== null && named !== repo) return { ok: false, reason: "path-repo-mismatch" };
	const result = run(request.args, target, { GIT_CEILING_DIRECTORIES: dirname(root) });
	return { ok: true, repo, root, target, result };
}
