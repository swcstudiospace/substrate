/**
 * Phase 72: which repositories a surface may address, and where each repository lives on this host.
 *
 * Two operator variables, both JSON, both read once at boot:
 *
 * - `SUBSTRATE_REPO_REGISTRY`: `{"owner/name": {"checkouts": [DIR...], "worktrees": [DIR...]}}`. Each directory is
 *   absolute. A registration is the only way the substrate knows that a path belongs to a repository, so a git call
 *   names a path that this table has already placed. Two repositories may not share or nest a directory.
 * - `SUBSTRATE_REPO_SCOPES`: `{"<surface>": ["owner/name", ...]}`. Unset means scoping is off: every caller may address
 *   every repository, which is today's behaviour. Set means enforcement: a surface missing from the object, and every
 *   anonymous caller, is granted nothing.
 *
 * The decisions are pure given `realpath`. A path is resolved through symlinks, and through its nearest existing
 * ancestor when the path is new, before it is compared with a registered directory, so `..` and symlinks cannot leave a
 * registration. A refusal names a reason code only; it never carries the requested path, which the audit records as a
 * digest (see {@link repoRefusalPayload}).
 */
import { createHmac, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { scopeRepoId } from "./event.ts";
import { SURFACES, type Surface } from "./types.ts";

export { scopeRepoId };

export const REPO_REGISTRY_ENV = "SUBSTRATE_REPO_REGISTRY";
export const REPO_SCOPES_ENV = "SUBSTRATE_REPO_SCOPES";

export interface RepoRegistration {
	readonly repo: string;
	readonly checkouts: readonly string[];
	readonly worktrees: readonly string[];
}

export interface RepoScope {
	/** False: scoping is off and every caller may address every repository (grants are not consulted). */
	readonly enforced: boolean;
	/** Canonical `owner/name` to its registration. */
	readonly registry: ReadonlyMap<string, RepoRegistration>;
	/** Surface to the canonical repositories it is granted. Empty when scoping is off. */
	readonly grants: ReadonlyMap<Surface, ReadonlySet<string>>;
}

export const REPO_SCOPE_OFF: RepoScope = { enforced: false, registry: new Map(), grants: new Map() };

/** Why a repository or path is refused. Closed; the audit and the HTTP body carry these codes and nothing else. */
export type RepoRefusalReason = "repo-not-granted" | "repo-not-registered" | "path-not-registered" | "path-repo-mismatch" | "all-repos-not-granted" | "graph-repo-unresolved" | "graph-repo-mismatch" | "not-declared-for-scope";

export const REPO_REFUSAL_MESSAGES: Readonly<Record<RepoRefusalReason, string>> = {
	"repo-not-granted": "the caller is not granted this repository",
	"repo-not-registered": "the repository has no registered checkout on this host",
	"path-not-registered": "the path is not inside a directory registered for any repository",
	"path-repo-mismatch": "the path belongs to a different repository than the one named",
	"all-repos-not-granted": "the request reads every repository, and the caller is granted only some of them",
	"graph-repo-unresolved": "the graph has no resolvable repository, so it cannot be placed in a grant",
	"graph-repo-mismatch": "the named graph belongs to a different repository than the one named",
	"not-declared-for-scope": "this route or tool is not declared for scoped callers, so it is refused until it is",
};

export type RepoGate = { ok: true; repo: string | null; target: string | null } | { ok: false; reason: RepoRefusalReason };

/** A refused repository request as the doors answer it: 403, the reason code and its fixed message. Never the requested value. */
export interface RepoScopeRefusal {
	ok: false;
	status: 403;
	body: { error: RepoRefusalReason; problem: string };
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

function refuse(reason: RepoRefusalReason): { ok: false; reason: RepoRefusalReason } {
	return { ok: false, reason };
}

function parseObject(raw: string, name: string): ParseOutcome<Record<string, unknown>> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, problem: `${name} is not valid JSON` };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: `${name} must be a JSON object` };
	return { ok: true, value: value as Record<string, unknown> };
}

function parseDirectories(value: unknown, where: string): ParseOutcome<string[]> {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return { ok: false, problem: `${where} must be a list of strings` };
	const directories: string[] = [];
	for (const entry of value as string[]) {
		if (!isAbsolute(entry) || entry.includes("\0")) return { ok: false, problem: `${where} holds an entry that is not an absolute directory` };
		const normal = resolve(entry);
		if (!directories.includes(normal)) directories.push(normal);
	}
	return { ok: true, value: directories };
}

/** Whether `target` is `root` or lies beneath it. Both are normalised, absolute paths. */
function contains(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A registered directory as the overlap check compares it: its real location when it exists, else its normalised path. */
function canonicalDirectory(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * Parses `SUBSTRATE_REPO_REGISTRY`. Unset or blank is an empty registry. Every problem is reported, never skipped: a
 * registration that is silently dropped would make its repository look unregistered, which is the fail-closed answer,
 * but a directory that is silently dropped could widen another repository's reach.
 */
export function parseRepoRegistry(raw: string | undefined): ParseOutcome<Map<string, RepoRegistration>> {
	const registry = new Map<string, RepoRegistration>();
	if (raw === undefined || raw.trim() === "") return { ok: true, value: registry };
	const object = parseObject(raw, REPO_REGISTRY_ENV);
	if (!object.ok) return object;
	const owned: Array<{ repo: string; dir: string }> = [];
	for (const [key, value] of Object.entries(object.value)) {
		const repo = scopeRepoId(key);
		if (repo === "" || repo !== key) return { ok: false, problem: `${REPO_REGISTRY_ENV} keys must be lowercase owner/name` };
		if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: `${REPO_REGISTRY_ENV} entries must be objects` };
		const fields = value as Record<string, unknown>;
		const extra = Object.keys(fields).filter((field) => field !== "checkouts" && field !== "worktrees");
		if (extra.length > 0) return { ok: false, problem: `${REPO_REGISTRY_ENV} entries take only checkouts and worktrees` };
		const checkouts = parseDirectories(fields.checkouts ?? [], `${REPO_REGISTRY_ENV} checkouts`);
		if (!checkouts.ok) return checkouts;
		const worktrees = parseDirectories(fields.worktrees ?? [], `${REPO_REGISTRY_ENV} worktrees`);
		if (!worktrees.ok) return worktrees;
		for (const dir of [...checkouts.value, ...worktrees.value]) owned.push({ repo, dir: canonicalDirectory(dir) });
		registry.set(repo, { repo, checkouts: checkouts.value, worktrees: worktrees.value });
	}
	for (const a of owned) {
		for (const b of owned) {
			if (a.repo !== b.repo && contains(a.dir, b.dir)) {
				return { ok: false, problem: `${REPO_REGISTRY_ENV}: two repositories share or nest a directory` };
			}
		}
	}
	return { ok: true, value: registry };
}

/** Parses `SUBSTRATE_REPO_SCOPES`. A key that names no surface, or a value that is not a list of canonical repositories, is refused. */
export function parseRepoScopes(raw: string): ParseOutcome<Map<Surface, Set<string>>> {
	const grants = new Map<Surface, Set<string>>();
	const object = parseObject(raw, REPO_SCOPES_ENV);
	if (!object.ok) return object;
	for (const [surface, value] of Object.entries(object.value)) {
		if (!(SURFACES as readonly string[]).includes(surface)) return { ok: false, problem: `${REPO_SCOPES_ENV} names a surface that does not exist` };
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
			return { ok: false, problem: `${REPO_SCOPES_ENV} values must be lists of owner/name` };
		}
		const repos = new Set<string>();
		for (const entry of value as string[]) {
			const repo = scopeRepoId(entry);
			if (repo === "" || repo !== entry) return { ok: false, problem: `${REPO_SCOPES_ENV} repositories must be lowercase owner/name` };
			repos.add(repo);
		}
		grants.set(surface as Surface, repos);
	}
	return { ok: true, value: grants };
}

/**
 * The repository scope the two variables describe. Both unset is {@link REPO_SCOPE_OFF}. A registry with no scopes
 * variable is still parsed: `scopedGit` needs it whether or not grants are enforced.
 */
export function repoScopeFromEnv(env: Record<string, string | undefined>): ParseOutcome<RepoScope> {
	const registry = parseRepoRegistry(env[REPO_REGISTRY_ENV]);
	if (!registry.ok) return registry;
	const scopesRaw = env[REPO_SCOPES_ENV];
	if (scopesRaw === undefined) {
		return { ok: true, value: { enforced: false, registry: registry.value, grants: new Map() } };
	}
	const grants = parseRepoScopes(scopesRaw);
	if (!grants.ok) return grants;
	return { ok: true, value: { enforced: true, registry: registry.value, grants: grants.value } };
}

/**
 * The real location of `path`, resolving symlinks through its nearest existing ancestor. A path that does not exist yet
 * (a new worktree directory) resolves to its real ancestor plus the remaining names, which cannot hide a symlink because
 * nothing below it exists. Null for a relative path, a NUL byte, or a path with no existing ancestor.
 */
export function resolveContained(path: string): string | null {
	if (path.includes("\0") || !isAbsolute(path)) return null;
	let current = resolve(path);
	const remaining: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(current);
			return remaining.length === 0 ? real : join(real, ...remaining.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			remaining.push(basename(current));
			current = parent;
		}
	}
}

export function realDirectoryOrNull(dir: string): string | null {
	try {
		return realpathSync(dir);
	} catch {
		return null;
	}
}

/** The registration whose registered directory contains `path`, with that directory's real location. The deepest match wins. */
export function locateRepoPath(scope: RepoScope, path: string): { repo: string; root: string; target: string } | null {
	const target = resolveContained(path);
	if (target === null) return null;
	let best: { repo: string; root: string; target: string } | null = null;
	for (const registration of scope.registry.values()) {
		for (const dir of [...registration.checkouts, ...registration.worktrees]) {
			const root = realDirectoryOrNull(dir);
			if (root === null || !contains(root, target)) continue;
			if (best === null || root.length > best.root.length) best = { repo: registration.repo, root, target };
		}
	}
	return best;
}

/** Whether `surface` holds a grant for the canonical `repo`. Anonymous callers hold none. Scoping off grants everything. */
export function isGranted(scope: RepoScope, surface: Surface | null, repo: string): boolean {
	if (!scope.enforced) return true;
	return surface !== null && scope.grants.get(surface)?.has(repo) === true;
}

/** The repositories a listing must be filtered to, or null when the caller is not scoped. An anonymous scoped caller gets an empty list. */
export function grantedRepos(scope: RepoScope, surface: Surface | null): readonly string[] | null {
	if (!scope.enforced) return null;
	if (surface === null) return [];
	return [...(scope.grants.get(surface) ?? [])].sort();
}

/** Gate for a repository named without a path. Scoping off returns the canonical name unchecked. */
export function authorizeRepo(scope: RepoScope, surface: Surface | null, named: string): RepoGate {
	const repo = scopeRepoId(named);
	if (!scope.enforced) return { ok: true, repo: repo === "" ? null : repo, target: null };
	if (repo === "" || !isGranted(scope, surface, repo)) return refuse("repo-not-granted");
	return { ok: true, repo, target: null };
}

/**
 * Gate for a path a git call would run in. Scoping off returns no repository and no root, which is today's behaviour;
 * scoping on requires the path to be inside a registration the surface is granted, and a repository the caller named
 * must be that registration.
 */
export function authorizeRepoPath(scope: RepoScope, surface: Surface | null, path: string, named: string | null): RepoGate {
	if (!scope.enforced) return { ok: true, repo: null, target: null };
	const located = locateRepoPath(scope, path);
	if (located === null) return refuse("path-not-registered");
	if (!isGranted(scope, surface, located.repo)) return refuse("repo-not-granted");
	if (named !== null && scopeRepoId(named) !== located.repo) return refuse("path-repo-mismatch");
	return { ok: true, repo: located.repo, target: located.target };
}

/**
 * The key the refusal digest is keyed with: random per process and never written anywhere. A digest of an unkeyed hash of a path
 * can be checked against guessed paths by anyone who reads the audit; a keyed one cannot, and a restart changes the key.
 */
const DIGEST_KEY = randomBytes(32);

/** A digest of the requested value for the refusal audit: enough to correlate a refusal, not enough to recover the path. */
export function refusalDigest(requested: string): string {
	return createHmac("sha256", DIGEST_KEY).update(requested).digest("hex").slice(0, 16);
}

/** The audit payload of one refusal. The surface is attached by the emitter; the requested value is digested, never stored. */
export function repoRefusalPayload(route: string, reason: RepoRefusalReason, requested: string): Record<string, unknown> {
	return { action: "repo.scope-refused", route, reason, requested_sha256: refusalDigest(requested) };
}

/**
 * The rows of a repository-keyed listing a scoped caller may see: those whose `repo` is granted. A row with no repository is in no
 * grant and is dropped. Scoping off returns every row. Applied to the rows before they become a reply.
 */
export function rowsInGrant<T extends { repo: string | null }>(rows: readonly T[], scope: RepoScope, surface: Surface | null): T[] {
	if (!scope.enforced) return [...rows];
	return rows.filter((row) => row.repo !== null && isGranted(scope, surface, scopeRepoId(row.repo)));
}

/** Whether a caller's surface name is a registered surface, so a grant can be looked up for it. A missing or unknown name has no grant. */
export function isSurfaceName(value: string | null): value is Surface {
	return value !== null && (SURFACES as readonly string[]).includes(value);
}
