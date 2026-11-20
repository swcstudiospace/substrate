 /**
  * Phase 72: which repositories one session may address, and the credential each of those repositories is scoped to.
  *
 * HARD-S2 credential (owner decision 2026-11-12 grant model): least-privilege credentials are the surface bearer
 * plus its repository grant. A credential is scoped to one repository through the grant; repo A credentials cannot
 * authorize repo B. The per-repo SUBSTRATE_REPO_CREDENTIAL is injected only for an admitted git invocation under
 * the grant (see repo-executor and scopedGit). Session allowlist here supports cross-repo (phase 74) credential
 * resolution only; surface-scoped grants satisfy the roadmap allowlist wording (STATE 2026-11-16).
  *
  * `SUBSTRATE_REPO_ALLOWLIST` is JSON, read on each operation (not cached at boot): `{"<session id>": {"owner/name": "<ENV_VAR>"}}`. Each value names
  * the environment variable that holds that repository's credential, and only that repository's grant can resolve it.
  * Unset or blank is an empty allowlist: every session is denied every repository.
  *
  * A repository id is canonical `owner/name` (lowercase, see {@link scopeRepoId}). A session names only repositories in its
  * own entry. An unknown repository and a disallowed one throw the same {@link RepoNotAllowedError}, and neither error
  * carries the requested id, so a refusal never reveals whether a repository exists.
  *
  * This module decides and nothing else: it spawns no process. `repo-executor.ts` calls it before any git argv is spawned.
  */
import { scopeRepoId } from "./event.ts";

export const REPO_ALLOWLIST_ENV = "SUBSTRATE_REPO_ALLOWLIST";

const CREDENTIAL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Session id to the repositories it may address, each mapped to the environment variable name of its credential. */
export type RepoAllowlist = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A repository a session may address, with the credential reference scoped to that one repository. */
export interface RepoGrant {
	readonly sessionId: string;
	readonly repo: string;
	readonly credentialEnv: string;
}

/** Thrown for a repository the session may not address, whether it is unknown or merely not allowed. */
export class RepoNotAllowedError extends Error {
	readonly code = "repo-not-allowed" as const;

	constructor() {
		super("repository is not allowed for this session");
		this.name = "RepoNotAllowedError";
	}
}

/** Thrown when a grant for one repository is asked to resolve the credential of another. */
export class CredentialScopeError extends Error {
	readonly code = "credential-scope" as const;

	constructor() {
		super("credential is scoped to a different repository");
		this.name = "CredentialScopeError";
	}
}

export const EMPTY_REPO_ALLOWLIST: RepoAllowlist = new Map();
const EMPTY_SESSION_REPOS: ReadonlyMap<string, string> = new Map();

export type RepoAllowlistParse = { ok: true; value: RepoAllowlist } | { ok: false; problem: string };

/** Parses `SUBSTRATE_REPO_ALLOWLIST`. Unset or blank is the empty allowlist. A malformed value is a problem, never a partial allowlist. */
export function repoAllowlistFromEnv(env: Readonly<Record<string, string | undefined>>): RepoAllowlistParse {
	const raw = env[REPO_ALLOWLIST_ENV];
	if (raw === undefined || raw.trim() === "") return { ok: true, value: EMPTY_REPO_ALLOWLIST };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, problem: `${REPO_ALLOWLIST_ENV} is not valid JSON` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: `${REPO_ALLOWLIST_ENV} must be a JSON object` };
	const sessions = new Map<string, ReadonlyMap<string, string>>();
	for (const [sessionId, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (sessionId.trim() === "") return { ok: false, problem: `${REPO_ALLOWLIST_ENV} holds a session id that is empty` };
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, problem: `${REPO_ALLOWLIST_ENV} entries must map repository ids to credential names` };
		const repos = new Map<string, string>();
		for (const [repo, credentialEnv] of Object.entries(entry as Record<string, unknown>)) {
			if (scopeRepoId(repo) !== repo) return { ok: false, problem: `${REPO_ALLOWLIST_ENV} holds a repository id that is not canonical owner/name` };
			if (typeof credentialEnv !== "string" || !CREDENTIAL_ENV_NAME.test(credentialEnv)) return { ok: false, problem: `${REPO_ALLOWLIST_ENV} holds a repository without a valid credential variable name` };
			repos.set(repo, credentialEnv);
		}
		sessions.set(sessionId, repos);
	}
	return { ok: true, value: sessions };
}

/** The repositories `sessionId` may address, each mapped to its credential variable name. Empty for an unknown session. */
export function allowlistFor(allowlist: RepoAllowlist, sessionId: string): ReadonlyMap<string, string> {
	return allowlist.get(sessionId) ?? EMPTY_SESSION_REPOS;
}

/** The grant for `repoId` under `sessionId`. Throws {@link RepoNotAllowedError} for an unknown or a disallowed repository alike. */
export function assertRepoAllowed(allowlist: RepoAllowlist, sessionId: string, repoId: string): RepoGrant {
	const credentialEnv = allowlistFor(allowlist, sessionId).get(repoId);
	if (credentialEnv === undefined) throw new RepoNotAllowedError();
	return { sessionId, repo: repoId, credentialEnv };
}

/**
 * The credential value of `repoId`, read from `env`, under `grant`. Throws {@link CredentialScopeError} when `repoId` is not
 * the repository the grant was issued for, so one repository's credential cannot serve another.
 */
export function credentialValue(grant: RepoGrant, repoId: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	if (grant.repo !== repoId) throw new CredentialScopeError();
	return env[grant.credentialEnv];
}
