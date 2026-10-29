/**
 * `substrate corpus reflect`: build one digest per repository from the planning files in its working tree, and send them
 * to the server (v1.7 phase 66).
 *
 * Discovery and reading happen here, where the files are; the server never reads a path. A repository is digested only
 * when it has a readable `.planning/STATE.md`. A planning file that exists but cannot be read leaves its repository out of
 * the run with a closed reason, so a digest is never built from half of its sources and stored over a complete one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	type ReflectStatus,
	type RepoDigest,
} from "@substrate/corpus";
import type { ClientError, CorpusClient } from "./client.ts";

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

/** Digest every repository found under the roots that has a readable STATE, one per repository label. */
export function collectDigests(opts: CollectOptions): ReflectCollection {
	const found = discoverRepos(opts.roots, { run: opts.runner ?? defaultGitRunner, depth: opts.depth });
	// A label that several directories yield cannot be read as one repository: which copy is the repository is not known.
	const ambiguous = new Set(found.duplicates.map((duplicate) => duplicate.repo));
	const wanted = new Set(opts.repos);
	const io = { maxBytes: opts.maxBytes, readFile: opts.readFile ?? ((path: string) => readFileSync(path)), lstat: opts.lstat ?? defaultLstat };
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
			const loaded = loadDocument(join(checkout.dir, file.path), io);
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

export interface ReflectSummary {
	counts: Record<ReflectStatus, number>;
	/** Refused and failed digests, with the server's closed reason each. */
	problems: ReflectProblem[];
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
	const summary: ReflectSummary = { counts: { stored: 0, unchanged: 0, refused: 0, failed: 0 }, problems: [], notSent: 0, manifestVersion: null };
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
			}
		}
	}
	return { summary, fatal: null };
}
