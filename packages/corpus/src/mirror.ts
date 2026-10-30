/**
 * The Substrate-managed mirror of a repository's origin (v1.7 phase 65, decision D65-4).
 *
 * A fetch moves refs and never the working tree, and a fetch inside the user's clone writes into that clone's `.git`. So the
 * default triggers keep their own bare, blobless mirror of the origin (`git clone --mirror --filter=blob:none`, then
 * `git fetch --prune` inside it) under a directory the caller chooses, and the view (`view.ts`) reads that mirror's default
 * branch. The only command that touches the user's repository is `git remote get-url origin`, a read of its configuration.
 *
 * A failed fetch leaves the mirror at its last successful state: the result says `stale` with a closed reason and the view
 * keeps reading what is there, so an offline run never replaces newer indexed text with an older checkout. A repository that
 * has never had a mirror is `absent`, and only then is it read from its working tree alone.
 *
 * Pure of the environment: the mirror directory, the timeouts and the runner are parameters.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { githubSlug, stripCredentials } from "./discover.ts";
import { type GitBytesRunner, outputText } from "./gitio.ts";

/** A clone moves the whole history without its file contents. */
export const MIRROR_CLONE_TIMEOUT_MS = 600_000;
export const MIRROR_FETCH_TIMEOUT_MS = 120_000;
/** A read of the checkout's configuration is instant; the bound only guards against a wedged process. */
const CONFIG_TIMEOUT_MS = 30_000;

/** Hex digits of the origin hash kept in the mirror's directory name. */
const NAME_HASH_LENGTH = 12;
const NAME_SLUG_LENGTH = 60;

export const MIRROR_STALE_REASONS = ["fetch-failed", "fetch-timeout"] as const;
export type MirrorStaleReason = (typeof MIRROR_STALE_REASONS)[number];

export const MIRROR_ABSENT_REASONS = ["no-origin", "not-created", "clone-failed", "clone-timeout", "mirror-dir-unusable", "mirror-unmatched"] as const;
export type MirrorAbsentReason = (typeof MIRROR_ABSENT_REASONS)[number];

/**
 * - `fetched`: the mirror was created or updated by this run.
 * - `unfetched`: it exists and this run did not fetch (`fetch: false`); it may be behind the origin.
 * - `stale`: the fetch failed; the mirror is at its last successful state and is still read.
 * - `absent`: there is no mirror, so the repository can only be read from its working tree.
 */
export type MirrorState =
	| { status: "fetched"; mirrorDir: string; created: boolean }
	| { status: "unfetched"; mirrorDir: string }
	| { status: "stale"; mirrorDir: string; reason: MirrorStaleReason }
	| { status: "absent"; reason: MirrorAbsentReason };

export interface MirrorOptions {
	/** False reads an existing mirror as it is and never touches the network (no clone, no fetch). */
	fetch: boolean;
	cloneTimeoutMs?: number | undefined;
	fetchTimeoutMs?: number | undefined;
}

/** The origin URL exactly as the checkout configures it, or null when it has none. Read-only. */
export function readOrigin(repoDir: string, run: GitBytesRunner): string | null {
	const result = run({ args: ["remote", "get-url", "origin"], cwd: repoDir, timeoutMs: CONFIG_TIMEOUT_MS });
	const url = outputText(result).trim();
	if (result.code !== 0 || url === "") return null;
	// A relative path is relative to the checkout. The clone runs from the mirror, so every local path is resolved here.
	// Remote forms (`scheme://`, `host:path`, `user@host:path`) are left unchanged.
	return isLocalOrigin(url) ? resolve(repoDir, url) : url;
}

/** The origin URL without credentials, a trailing slash, or a `.git` suffix. This is the pre-canonical hash input. */
function strippedOrigin(origin: string): string {
	return stripCredentials(origin).replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * One identity for equivalent origin URLs. GitHub https, ssh and scp forms of one slug share it, as do `https://host/path`
 * and `git@host:path` on any other host. A local path is left as its stripped form, so an existing path-named mirror is
 * still found. A fork is a different slug and stays a different identity. Distinct ports are distinct hosts.
 */
function isLocalOrigin(origin: string): boolean {
	if (origin.includes("://")) return false;
	// `user@host:path` is scp even when the path is absolute (`git@host:/srv/git/repo.git`).
	if (/^[^/\s]+@[^:\s]+:/.test(origin)) return false;
	// `host:relative/path` is scp. A slash before the colon, or an absolute path with no user, is local.
	return !/^[^:/\s]+:[^/]/.test(origin);
}

function originIdentity(origin: string): string {
	const slug = githubSlug(origin);
	if (slug !== null) return `github.com/${slug}`;
	const stripped = strippedOrigin(origin);
	const withUser = /^([^@/\s]+)@([^:/\s]+):\/?(.*)$/.exec(stripped);
	if (withUser && !stripped.includes("://")) return `${(withUser[2] ?? "").toLowerCase()}/${withUser[3] ?? ""}`;
	const scp = /^([^:/\s]+):([^/].*)$/.exec(stripped);
	if (scp && !stripped.includes("://")) return `${(scp[1] ?? "").toLowerCase()}/${scp[2] ?? ""}`;
	try {
		const url = new URL(stripped);
		// `host` keeps a non-default port; `hostname` would make :8443 and :9443 share a mirror. A default port `URL` omits stays omitted.
		if (url.host !== "") return `${url.host.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
	} catch {
		// A local path is not a URL. Its stripped form is the identity.
	}
	return stripped;
}

/** Directory name for one hash input. The readable slug stays the GitHub name when there is one. */
function mirrorNameFrom(origin: string, hashed: string): string {
	const readable = (githubSlug(origin) ?? basename(strippedOrigin(origin))).replace("/", "-");
	const slug = readable
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, NAME_SLUG_LENGTH);
	const hash = createHash("sha256").update(hashed).digest("hex").slice(0, NAME_HASH_LENGTH);
	return `${slug === "" ? "repo" : slug}-${hash}`;
}

/** The mirror's directory name: a readable slug and a hash of the origin identity, so equivalent URLs share one mirror. */
export function mirrorName(origin: string): string {
	return mirrorNameFrom(origin, originIdentity(origin));
}

/** The directory name a mirror created before identity canonicalization still has: a hash of the stripped URL. */
function legacyMirrorName(origin: string): string {
	return mirrorNameFrom(origin, strippedOrigin(origin));
}

/** URL spellings that used to name their own mirror for this origin. The current spelling is included. */
function equivalentOrigins(origin: string): string[] {
	const forms = [origin];
	const slug = githubSlug(origin);
	if (slug !== null) {
		forms.push(
			`https://github.com/${slug}`,
			`https://github.com/${slug}.git`,
			`git@github.com:${slug}`,
			`git@github.com:${slug}.git`,
			`ssh://git@github.com/${slug}`,
			`ssh://git@github.com/${slug}.git`,
		);
		return forms;
	}
	const identity = originIdentity(origin);
	const slash = identity.indexOf("/");
	if (slash > 0 && identity !== strippedOrigin(origin)) {
		const host = identity.slice(0, slash);
		const path = identity.slice(slash + 1);
		forms.push(`https://${host}/${path}`, `https://${host}/${path}.git`, `git@${host}:${path}`, `git@${host}:${path}.git`, `ssh://git@${host}/${path}`, `ssh://git@${host}/${path}.git`);
	}
	return forms;
}

/** The directory the mirror of `origin` lives in, below `mirrorRoot`. */
export function mirrorPath(mirrorRoot: string, origin: string): string {
	return join(resolve(mirrorRoot), mirrorName(origin));
}

function isUsableMirror(dir: string, run: GitBytesRunner): boolean {
	const result = run({ args: ["rev-parse", "--is-bare-repository"], cwd: dir, timeoutMs: CONFIG_TIMEOUT_MS });
	return result.code === 0 && outputText(result).trim() === "true";
}

/** Points the mirror's origin at the checkout's current URL. The URL is an argument only; it is never written to a reason. */
function pointOrigin(dir: string, origin: string, run: GitBytesRunner): boolean {
	const result = run({ args: ["remote", "set-url", "origin", origin], cwd: dir, timeoutMs: CONFIG_TIMEOUT_MS });
	return result.code === 0;
}
/** The origin URL stored on a mirror, unchanged. Unlike {@link readOrigin} it is not resolved against a checkout. */
function storedOrigin(dir: string, run: GitBytesRunner): string | null {
	const result = run({ args: ["remote", "get-url", "origin"], cwd: dir, timeoutMs: CONFIG_TIMEOUT_MS });
	const url = outputText(result).trim();
	return result.code === 0 && url !== "" ? url : null;
}

/** The identity used before the port was part of the key, or null when this origin has no explicit port. */
function portlessIdentity(origin: string): string | null {
	let url: URL;
	try {
		url = new URL(strippedOrigin(origin));
	} catch {
		return null;
	}
	if (url.hostname === "" || url.port === "") return null;
	return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
}


const BRANCH_REF = /^refs\/heads\/([A-Za-z0-9._/-]+)$/;

/**
 * Moves the mirror HEAD onto the origin's current default branch. `empty` is an origin with no branch yet.
 * A failure leaves HEAD untouched so the caller can refuse to treat the old branch as current.
 */
function refreshDefaultHead(dir: string, run: GitBytesRunner): "refreshed" | "empty" | "failed" {
	const remote = run({ args: ["ls-remote", "--symref", "origin", "HEAD"], cwd: dir, timeoutMs: CONFIG_TIMEOUT_MS });
	if (remote.code !== 0) return "failed";
	const match = /^ref: (refs\/heads\/\S+)\tHEAD/m.exec(outputText(remote));
	if (match === null) return "empty";
	const ref = match[1] ?? "";
	const name = BRANCH_REF.exec(ref)?.[1];
	if (name === undefined || name.includes("..") || name.endsWith("/")) return "failed";
	const pointed = run({ args: ["symbolic-ref", "HEAD", ref], cwd: dir, timeoutMs: CONFIG_TIMEOUT_MS });
	return pointed.code === 0 ? "refreshed" : "failed";
}

/**
 * The mirror directory for this checkout. The name is a hash of the origin identity, so https and ssh of one repository
 * share it. A mirror created before that canonicalization is still found by the hash of an equivalent URL. A mirror is
 * never chosen because it happens to contain a commit: a fork can share that commit, and returning it would let a later
 * fetch rewrite the upstream mirror's origin.
 */
function mirrorForCheckout(_repoDir: string, mirrorRoot: string, origin: string, run: GitBytesRunner): { dir: string | null; unmatched: boolean } {
	const root = resolve(mirrorRoot);
	const named = join(root, mirrorName(origin));
	// Present but unusable is the caller's to refuse. Skipping it would clone over the directory.
	if (existsSync(named)) return { dir: named, unmatched: false };
	const seen = new Set<string>([mirrorName(origin)]);
	for (const form of equivalentOrigins(origin)) {
		const name = legacyMirrorName(form);
		if (seen.has(name)) continue;
		seen.add(name);
		const dir = join(root, name);
		if (existsSync(dir) && isUsableMirror(dir, run)) return { dir, unmatched: false };
	}
	// A mirror created by the hostname-only key is reused only when its stored origin is this server. Another port
	// that shared that key must not be read as this repository, and must not be replaced by a complete checkout read.
	const previous = portlessIdentity(origin);
	if (previous !== null) {
		const name = mirrorNameFrom(origin, previous);
		if (!seen.has(name)) {
			const dir = join(root, name);
			if (existsSync(dir) && isUsableMirror(dir, run)) {
				const stored = storedOrigin(dir, run);
				if (stored !== null && originIdentity(stored) === originIdentity(origin)) return { dir, unmatched: false };
				return { dir: null, unmatched: true };
			}
		}
	}
	return { dir: null, unmatched: false };
}

/**
 * Create or update the mirror of the checkout's origin. Never throws: every failure is a closed reason in the result.
 * With `fetch: false` an existing mirror is returned as it is and a missing one is reported `absent`/`not-created`.
 */
export function ensureMirror(repoDir: string, mirrorRoot: string, run: GitBytesRunner, options: MirrorOptions): MirrorState {
	const origin = readOrigin(repoDir, run);
	if (origin === null) return { status: "absent", reason: "no-origin" };
	const root = resolve(mirrorRoot);
	const found = mirrorForCheckout(repoDir, root, origin, run);
	if (found.unmatched && !options.fetch) return { status: "absent", reason: "mirror-unmatched" };
	const dest = found.dir ?? mirrorPath(root, origin);
	const present = found.dir !== null;
	if (present && !isUsableMirror(dest, run)) return { status: "absent", reason: "mirror-dir-unusable" };
	if (present) {
		if (!options.fetch) return { status: "unfetched", mirrorDir: dest };
		if (!pointOrigin(dest, origin, run)) return { status: "stale", mirrorDir: dest, reason: "fetch-failed" };
		const fetched = run({
			args: ["fetch", "--prune", "--quiet", "origin"],
			cwd: dest,
			timeoutMs: options.fetchTimeoutMs ?? MIRROR_FETCH_TIMEOUT_MS,
		});
		if (fetched.code !== 0) return { status: "stale", mirrorDir: dest, reason: fetched.timedOut ? "fetch-timeout" : "fetch-failed" };
		const head = refreshDefaultHead(dest, run);
		if (head === "failed") return { status: "stale", mirrorDir: dest, reason: "fetch-failed" };
		return { status: "fetched", mirrorDir: dest, created: false };
	}
	if (!options.fetch) return { status: "absent", reason: "not-created" };
	try {
		// The directory holds the origin URL (which may carry a credential), so only its owner can enter it.
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		return { status: "absent", reason: "mirror-dir-unusable" };
	}
	// A clone killed half way must not leave a directory that later looks like a mirror, so it lands under a temporary name.
	const partial = `${dest}.partial-${randomUUID()}`;
	const cloned = run({
		args: ["clone", "--mirror", "--filter=blob:none", "--quiet", "--", origin, partial],
		cwd: root,
		timeoutMs: options.cloneTimeoutMs ?? MIRROR_CLONE_TIMEOUT_MS,
	});
	if (cloned.code !== 0) {
		rmSync(partial, { recursive: true, force: true });
		return { status: "absent", reason: cloned.timedOut ? "clone-timeout" : "clone-failed" };
	}
	try {
		renameSync(partial, dest);
	} catch {
		// Another run finished the same clone first; its mirror is as good as this one.
		rmSync(partial, { recursive: true, force: true });
		if (!existsSync(dest)) return { status: "absent", reason: "mirror-dir-unusable" };
	}
	return { status: "fetched", mirrorDir: dest, created: true };
}
