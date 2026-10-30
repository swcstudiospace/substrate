/**
 * `substrate corpus reflect`: build one digest per repository from the planning files in its working tree, and send them
 * to the server (v1.7 phase 66).
 *
 * Discovery and reading happen here, where the files are; the server never reads a path. A repository is digested only
 * when it has a readable `.planning/STATE.md`. A planning file that exists but cannot be read leaves its repository out of
 * the run with a closed reason, so a digest is never built from half of its sources and stored over a complete one.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	CORPUS_PROTOCOL,
	MAX_REFLECT_DIGESTS,
	buildDigest,
	defaultGitRunner,
	defaultLstat,
	discoverRepos,
	isValidRepo,
	loadDocument,
	type CorpusReflectResultItem,
	type DigestSource,
	type FileStat,
	type GitRunner,
	type LoadedDocument,
	type ReflectStatus,
	type RepoDigest,
} from "@substrate/corpus";
import type { ClientError, CorpusClient } from "./client.ts";
import { readFilePrefix } from "./neardup.ts";

/** The planning files a digest reads, relative to the repository root. */
const PLANNING_FILES = [
	{ label: "state", path: ".planning/STATE.md" },
	{ label: "roadmap", path: ".planning/ROADMAP.md" },
	{ label: "project", path: ".planning/PROJECT.md" },
] as const;

export interface ReflectSkip {
	repo: string;
	/** A closed code: `bad-repo`, `duplicate-label`, `not-found`, `no-state`, or `<file>-<why>` such as `roadmap-too-large`. */
	reason: string;
}

export interface ReflectCollection {
	digests: RepoDigest[];
	skipped: ReflectSkip[];
	notes: string[];
	/** Checkouts found under the roots, before any filter. */
	checkouts: number;
}

export interface CollectOptions {
	roots: readonly string[];
	/** Repository labels to digest; empty means every repository that has a STATE. */
	repos: readonly string[];
	maxBytes: number;
	depth?: number | undefined;
	runner?: GitRunner | undefined;
	readFile?: ((path: string) => Uint8Array) | undefined;
	lstat?: ((path: string) => FileStat | null) | undefined;
}

/** The refusal `loadDocument` would report, as a value: the digest reader and its confinement answer in one shape. */
type Refused = Extract<LoadedDocument, { ok: false }>;

function unreadable(problem: string): Refused {
	return { ok: false, reason: "unreadable", problem };
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Whether `real` is below `root` by whole path segments (`/a/b-c` is not inside `/a/b`), and not `root` itself. */
function isBelow(root: string, real: string): boolean {
	const rel = relative(root, real);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Where a planning file of a checkout may be read from, or why it may not. The checkout root is resolved once; every directory
 * between it and the file must be a real directory (a symlinked `.planning` would otherwise lead into another checkout and its
 * private plans would be uploaded under this repository's name), and the file's resolved path must still be inside the root.
 * The file itself is judged by `loadDocument` (a symlink, a missing file, not a regular file). The path returned is under the
 * resolved root, so the read does not depend on the checkout's own path being a link.
 */
function confinedPath(dir: string, file: string, lstat: (path: string) => FileStat | null): { ok: true; path: string } | Refused {
	let root: string;
	try {
		root = realpathSync(dir);
	} catch (cause) {
		return unreadable(`cannot resolve the checkout: ${messageOf(cause)}`);
	}
	const parts = file.split("/");
	let at = root;
	for (const [index, part] of parts.entries()) {
		at = join(at, part);
		if (index === parts.length - 1) break;
		let stat: FileStat | null;
		try {
			stat = lstat(at);
		} catch (cause) {
			return unreadable(`cannot stat: ${messageOf(cause)}`);
		}
		// A missing directory is a missing file: the same answer as `loadDocument` gives, with no fault to report.
		if (stat === null) return { ok: false, reason: "missing" };
		if (stat.symlink) return unreadable(`${parts.slice(0, index + 1).join("/")} is a symbolic link`);
		if (stat.file) return unreadable(`${parts.slice(0, index + 1).join("/")} is not a directory`);
	}
	try {
		// The leaf may be a link or absent (then `loadDocument` says so); its parent directory is what must resolve inside the root.
		const parent = realpathSync(join(at, ".."));
		if (!isBelow(root, parent) && parent !== root) return unreadable("resolves outside the checkout");
	} catch (cause) {
		return unreadable(`cannot resolve: ${messageOf(cause)}`);
	}
	return { ok: true, path: at };
}

/** Digest every repository found under the roots that has a readable STATE, one per repository label. */
export function collectDigests(opts: CollectOptions): ReflectCollection {
	const found = discoverRepos(opts.roots, { run: opts.runner ?? defaultGitRunner, depth: opts.depth });
	// A label that several directories yield cannot be read as one repository: which copy is the repository is not known.
	const ambiguous = new Set(found.duplicates.map((duplicate) => duplicate.repo));
	const wanted = new Set(opts.repos);
	const io = { maxBytes: opts.maxBytes, readFile: opts.readFile ?? ((path: string) => readFilePrefix(path, opts.maxBytes + 1)), lstat: opts.lstat ?? defaultLstat };
	const digests: RepoDigest[] = [];
	const skipped: ReflectSkip[] = [];
	const reached = new Set<string>();
	let withoutState = 0;

	for (const checkout of found.checkouts) {
		if (wanted.size > 0 && !wanted.has(checkout.repo)) continue;
		reached.add(checkout.repo);
		if (!isValidRepo(checkout.repo)) {
			skipped.push({ repo: checkout.repo, reason: "bad-repo" });
			continue;
		}
		if (ambiguous.has(checkout.repo)) {
			skipped.push({ repo: checkout.repo, reason: "duplicate-label" });
			continue;
		}
		const sources: DigestSource[] = [];
		let failure: string | null = null;
		for (const file of PLANNING_FILES) {
			const confined = confinedPath(checkout.dir, file.path, io.lstat);
			const loaded = confined.ok ? loadDocument(confined.path, io) : confined;
			if (loaded.ok) {
				sources.push({ path: file.path, text: loaded.text });
			} else if (loaded.reason !== "missing") {
				failure = `${file.label}-${loaded.reason}`;
				break;
			} else if (file.label === "state") {
				failure = "no-state";
				break;
			}
		}
		if (failure === "no-state") {
			// A repository that was not asked for and has no STATE is simply not one that keeps a planning record.
			if (wanted.has(checkout.repo)) skipped.push({ repo: checkout.repo, reason: failure });
			else withoutState += 1;
			continue;
		}
		if (failure !== null) {
			skipped.push({ repo: checkout.repo, reason: failure });
			continue;
		}
		const digest = buildDigest(checkout.repo, sources);
		if (digest === null) skipped.push({ repo: checkout.repo, reason: "no-state" });
		else digests.push(digest);
	}
	for (const repo of [...wanted].sort()) {
		if (!reached.has(repo)) skipped.push({ repo, reason: "not-found" });
	}

	const notes = [...found.notes];
	if (withoutState > 0) notes.push(`${withoutState} checkout${withoutState === 1 ? "" : "s"} without .planning/STATE.md not reflected`);
	return { digests, skipped, notes, checkouts: found.found };
}

export interface ReflectProblem {
	repo: string;
	status: "refused" | "failed";
	reason?: string | undefined;
}

/** A digest the server stored whose Hindsight leg did not land as asked, with the server's closed reason (`hindsight:...`). */
export interface ReflectWarning {
	repo: string;
	reason: string;
}

export interface ReflectSummary {
	counts: Record<ReflectStatus, number>;
	/** Refused and failed digests, with the server's closed reason each. */
	problems: ReflectProblem[];
	/** Stored digests the server reported a reason for: the docs digest is saved but the memory write was refused, failed, or is pending. Not a failure. */
	warnings: ReflectWarning[];
	/** Digests never sent because an earlier request failed as a whole. */
	notSent: number;
	manifestVersion: number | null;
}

export interface ReflectOutcome {
	summary: ReflectSummary;
	fatal: ClientError | null;
}

/**
 * Send the digests in requests of at most `MAX_REFLECT_DIGESTS`. A request that fails as a whole stops the run and the
 * digests after it count as not sent; a digest the server answered nothing for is reported as failed, never as stored.
 */
export async function executeReflect(input: { digests: readonly RepoDigest[]; client: CorpusClient }): Promise<ReflectOutcome> {
	const summary: ReflectSummary = { counts: { stored: 0, unchanged: 0, refused: 0, failed: 0 }, problems: [], warnings: [], notSent: 0, manifestVersion: null };
	for (let start = 0; start < input.digests.length; start += MAX_REFLECT_DIGESTS) {
		const batch = input.digests.slice(start, start + MAX_REFLECT_DIGESTS);
		const answered = await input.client.reflect({
			protocol: CORPUS_PROTOCOL,
			digests: batch.map((digest) => ({ repo: digest.repo, text: digest.text, sha256: digest.sha256 })),
		});
		if (!answered.ok) {
			summary.notSent = input.digests.length - start;
			return { summary, fatal: answered.error };
		}
		summary.manifestVersion = answered.value.manifestVersion;
		const byRepo = new Map(answered.value.results.map((result): [string, CorpusReflectResultItem] => [result.repo, result]));
		for (const digest of batch) {
			const result = byRepo.get(digest.repo);
			if (result === undefined) {
				summary.counts.failed += 1;
				summary.problems.push({ repo: digest.repo, status: "failed", reason: "no-result" });
				continue;
			}
			summary.counts[result.status] += 1;
			if (result.status === "refused" || result.status === "failed") {
				summary.problems.push({ repo: digest.repo, status: result.status, reason: result.reason });
			} else if (result.status === "stored" && result.reason !== undefined) {
				summary.warnings.push({ repo: digest.repo, reason: result.reason });
			}
		}
	}
	return { summary, fatal: null };
}
