/**
 * The scoped git executor (phase 72): the one entry point that runs git against a registered repository.
 *
 * {@link scopedGit} decides first and spawns second. The decision places the working directory inside a registered
 * repository, checks the surface's grant (`repo-scope.ts`) and, for a session-scoped call, checks the session's allowlist
 * and resolves that repository's credential (`repo-allowlist.ts`). Only then does the runner receive the call. A refusal
 * returns before the runner is called, so no git process starts and no byte of the repository is read.
 *
 * Git runs with `cwd` set to the resolved target (the real path the request named, or the registered checkout) and with
 * `GIT_CEILING_DIRECTORIES` set to the parent of the registered directory that holds it, so git's upward search for an
 * enclosing repository stops inside the scope and cannot reach another repository through a parent. The arguments are an
 * argv array; nothing is joined into a shell string.
 *
 * Phase 74 calls this entry point for cross-repository steps. It does not re-implement the checks. A session-scoped call
 * refuses every unknown, unregistered and disallowed repository with the same reason, so the answer leaks no existence.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { assertRepoAllowed, credentialValue, RepoNotAllowedError, type RepoAllowlist, type RepoGrant } from "./repo-allowlist.ts";
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
	/** The allowlist session this call runs for. Omitted: only the surface grant applies. Given: the allowlist is checked first. */
	session?: ScopedSession;
}

/** A session whose call is checked against the repository allowlist (`repo-allowlist.ts`). */
export interface ScopedSession {
	id: string;
	allowlist: RepoAllowlist;
}

/** Where a git call runs: the resolved target, and the registered directory that contains it. */
export interface ScopedLocation {
	repo: string;
	root: string;
	target: string;
}

export type ScopedGitOutcome = ({ ok: true; result: ScopedGitResult } & ScopedLocation) | { ok: false; reason: RepoRefusalReason };

/**
 * The variables a git child inherits from the server environment. Everything else is withheld, so a git call for one
 * repository never receives another repository's credential variable. The call's own variables, git's fixed flags and the
 * admitted repository's `SUBSTRATE_REPO_CREDENTIAL`, are added on top by {@link childEnvironment}.
 */
const INHERITED_ENV_NAMES = ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const;

/** The child environment: the inherited allowlist, git's fixed flags, then the variables this call was given. */
function childEnvironment(env: Record<string, string>): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const name of INHERITED_ENV_NAMES) {
		const value = process.env[name];
		if (value !== undefined) inherited[name] = value;
	}
	return { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", ...env };
}

/** The default runner: argv, no shell, git's own locks and prompts off. */
export const defaultScopedGitRunner: ScopedGitRunner = (args, cwd, env) => {
	const run = spawnSync("git", [...args], {
		cwd,
		env: childEnvironment(env),
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
 * The session's grant for every repository this call touches, or null when any of them is refused. A path the registry does
 * not place, an unknown repository and a disallowed one all return null, so the caller answers them alike.
 */
function sessionGrant(session: ScopedSession, scope: RepoScope, path: string | null, named: string | null): RepoGrant | null {
	const pathRepo = path === null ? null : (locateRepoPath(scope, path)?.repo ?? null);
	if (path !== null && pathRepo === null) return null;
	const touched = [named, pathRepo].filter((repo): repo is string => repo !== null);
	if (touched.length === 0) return null;
	const grants = touched.map((repo) => grantOrNull(session, repo));
	if (grants.some((grant) => grant === null)) return null;
	return grants[0] ?? null;
}

function grantOrNull(session: ScopedSession, repo: string): RepoGrant | null {
	try {
		return assertRepoAllowed(session.allowlist, session.id, repo);
	} catch (error) {
		if (error instanceof RepoNotAllowedError) return null;
		throw error;
	}
}

/**
 * Runs `args` in a registered repository if the surface may address it. A refusal returns before `run` is called.
 *
 * A session-scoped call is admitted by its allowlist first. Then, for the admitted repository only, the executor passes the
 * repository's credential to the runner as `SUBSTRATE_REPO_CREDENTIAL`. Nothing else about the credential reaches the call.
 *
 * Unlike the API's path gate, the executor always requires a registration, even when grants are not enforced: a
 * cross-repository step must run in a checkout the operator placed, never in a directory it found.
 */
export function scopedGit(request: ScopedGitRequest, run: ScopedGitRunner): ScopedGitOutcome {
	const named = request.repo === null ? null : scopeRepoId(request.repo);
	let grant: RepoGrant | null = null;
	if (request.session !== undefined) {
		grant = sessionGrant(request.session, request.scope, request.path, named);
		if (grant === null) return { ok: false, reason: "repo-not-granted" };
	}
	if (request.repo !== null && named === "") return { ok: false, reason: "repo-not-registered" };
	const located = locate(request, named);
	if (!located.ok) return located;
	const { repo, root, target } = located.location;
	if (!isGranted(request.scope, request.surface, repo)) return { ok: false, reason: "repo-not-granted" };
	if (named !== null && named !== repo) return { ok: false, reason: "path-repo-mismatch" };
	const env: Record<string, string> = { GIT_CEILING_DIRECTORIES: dirname(root) };
	if (grant !== null) {
		const credential = credentialValue(grant, repo, process.env);
		if (credential !== undefined) env.SUBSTRATE_REPO_CREDENTIAL = credential;
	}
	const result = run(request.args, target, env);
	return { ok: true, repo, root, target, result };
}
