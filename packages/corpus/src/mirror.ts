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

export const MIRROR_ABSENT_REASONS = ["no-origin", "not-created", "clone-failed", "clone-timeout", "mirror-dir-unusable"] as const;
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
	// A relative path is relative to the checkout, and the clone runs elsewhere.
	return url.startsWith("./") || url.startsWith("../") ? resolve(repoDir, url) : url;
}

/** The mirror's directory name: a readable slug and a hash of the origin without credentials, so it never changes for one origin. */
export function mirrorName(origin: string): string {
	const stripped = stripCredentials(origin).replace(/\/+$/, "").replace(/\.git$/, "");
	const readable = (githubSlug(origin) ?? basename(stripped)).replace("/", "-");
	const slug = readable
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, NAME_SLUG_LENGTH);
	const hash = createHash("sha256").update(stripped).digest("hex").slice(0, NAME_HASH_LENGTH);
	return `${slug === "" ? "repo" : slug}-${hash}`;
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
 * The mirror directory for this checkout. The mirror name is a hash of the origin. A mirror is never chosen because it
 * happens to contain a commit: a fork can share that commit with an upstream mirror, and returning it would let a later
 * fetch rewrite the upstream mirror's origin. A checkout whose origin URL moved therefore gets a second mirror.
 */
function mirrorForCheckout(_repoDir: string, mirrorRoot: string, origin: string, _run: GitBytesRunner): string | null {
	const named = mirrorPath(mirrorRoot, origin);
	if (existsSync(named)) return named;
	return null;
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
	const dest = found ?? mirrorPath(root, origin);
	const present = found !== null;
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
