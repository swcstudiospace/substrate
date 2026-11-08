/**
 * Read the documentation of an owner's GitHub repositories through the `gh` CLI (v1.7 phase 63).
 *
 * Repositories come from `gh repo list`; archived ones and ones with a local clone are skipped. For each of the first
 * `maxRepos` the default branch's tree is read (`gh api .../git/trees/<ref>?recursive=1`), the documentation paths that
 * classify at or below `maxTier` are kept and each blob is fetched and decoded. Entries have `source: "github"` and the
 * commit sha of the branch head. Bodies go to the optional `onBody` callback; the entries never carry them.
 *
 * Every `gh` call goes through an injected runner with bounded concurrency. A repository that fails is reported in
 * `skipped` and `repos` (not complete) and never aborts the scan.
 */
import { execFile } from "node:child_process";
import { classify } from "../classify.ts";
import { isRecord } from "../guards.ts";
import { isValidPath } from "../names.ts";
import type { CorpusEntry, DocTier } from "../protocol.ts";
import {
	type AdapterResult,
	compareEntries,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TIER,
	inspectBytes,
	type RepoReport,
	type SkippedFile,
	SkipLog,
} from "../scan.ts";
import { entrySupersededBy } from "../supersession.ts";

export const DEFAULT_GITHUB_MAX_REPOS = 50;
const DEFAULT_GITHUB_CONCURRENCY = 4;
/** The `-L` of `gh repo list`: how many repositories of the owner are listed before the cap and the filters apply. */
const DEFAULT_GITHUB_LIST_LIMIT = 1000;

const GH_MAX_BUFFER = 256 * 1024 * 1024;
/** A GitHub account name; it may not start with a hyphen, so it can never be read as a flag by `gh`. */
const NAME_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SYMLINK_MODE = "120000";

export interface GhResult {
	code: number;
	stdout: string;
}

/** Runs `gh <args>`. Never a shell string; a non-zero `code` means gh failed. */
export type GhRunner = (args: string[]) => Promise<GhResult>;

const defaultGhRunner: GhRunner = (args) => {
	const { promise, resolve } = Promise.withResolvers<GhResult>();
	execFile("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER }, (error, stdout) => {
		resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout });
	});
	return promise;
};

interface GithubScanOptions {
	owner: string;
	/** Repositories read, after archived and skipped ones are removed, in `owner/name` order. Default 50. */
	maxRepos?: number | undefined;
	/** `-L` of the repository listing. Default 1000. */
	listLimit?: number | undefined;
	maxTier?: DocTier | undefined;
	maxBytes?: number | undefined;
	/** Repositories (`owner/name`, any case) that have a local clone and are read from disk instead. */
	skipRepos?: Iterable<string> | undefined;
	/** Simultaneous `gh` calls. Default 4. */
	concurrency?: number | undefined;
	gh?: GhRunner | undefined;
	/** Receives each document's text as it is fetched, so the caller can keep it for a later send. */
	onBody?: ((entry: CorpusEntry, body: string) => void | Promise<void>) | undefined;
}

interface ListedRepo {
	slug: string;
	archived: boolean;
	branch: string | null;
}

interface TreeItem {
	path: string;
	type: string;
	sha: string;
	mode: string | undefined;
	size: number | undefined;
}

interface Tree {
	truncated: boolean;
	items: TreeItem[];
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A non-JSON answer is the caller's "unreadable" case, not an exception.
		return null;
	}
}

function parseRepoList(text: string): ListedRepo[] | null {
	const raw = parseJson(text);
	if (!Array.isArray(raw)) return null;
	const repos: ListedRepo[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.nameWithOwner !== "string" || !SLUG.test(item.nameWithOwner)) continue;
		const ref = item.defaultBranchRef;
		const branch = isRecord(ref) && typeof ref.name === "string" && ref.name !== "" ? ref.name : null;
		repos.push({ slug: item.nameWithOwner, archived: item.isArchived === true, branch });
	}
	return repos;
}

function parseTree(text: string): Tree | null {
	const raw = parseJson(text);
	if (!isRecord(raw) || !Array.isArray(raw.tree)) return null;
	const items: TreeItem[] = [];
	for (const item of raw.tree) {
		if (!isRecord(item) || typeof item.path !== "string" || typeof item.type !== "string" || typeof item.sha !== "string") continue;
		items.push({
			path: item.path,
			type: item.type,
			sha: item.sha,
			mode: typeof item.mode === "string" ? item.mode : undefined,
			size: typeof item.size === "number" ? item.size : undefined,
		});
	}
	return { truncated: raw.truncated === true, items };
}

function parseBlob(text: string): Uint8Array | null {
	const raw = parseJson(text);
	if (!isRecord(raw) || typeof raw.content !== "string" || raw.encoding !== "base64") return null;
	return Buffer.from(raw.content.replace(/\s+/g, ""), "base64");
}

/** A queue that runs at most `max` tasks at once. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active < max) {
			active += 1;
		} else {
			// The slot is handed over by whoever finishes, so `active` never exceeds `max`.
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			await promise;
		}
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next === undefined) active -= 1;
			else next();
		}
	};
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export async function scanGithub(opts: GithubScanOptions): Promise<AdapterResult> {
	const gh = opts.gh ?? defaultGhRunner;
	const limit = createLimiter(Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_GITHUB_CONCURRENCY)));
	const call = (args: string[]): Promise<GhResult> => limit(() => gh(args));
	const maxTier = opts.maxTier ?? DEFAULT_MAX_TIER;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const notes: string[] = [];
	const entries: CorpusEntry[] = [];
	const reports: RepoReport[] = [];
	const skipped: SkippedFile[] = [];
	const finish = (): AdapterResult => {
		const log = new SkipLog();
		for (const skip of skipped.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.path, b.path))) log.add(skip);
		return {
			entries: entries.sort(compareEntries),
			repos: reports.sort((a, b) => compareText(a.repo, b.repo)),
			skipped: log.listed,
			skippedByReason: log.byReason,
			notes,
			paths: new Map(),
		};
	};

	if (!NAME_PART.test(opts.owner)) {
		notes.push(`github owner ${JSON.stringify(opts.owner)} is not a valid account name`);
		return finish();
	}
	const listLimit = Math.max(1, Math.floor(opts.listLimit ?? DEFAULT_GITHUB_LIST_LIMIT));
	const listed = await call([
		"repo",
		"list",
		opts.owner,
		"--json",
		"nameWithOwner,isArchived,defaultBranchRef",
		"-L",
		String(listLimit),
	]);
	const repos = listed.code === 0 ? parseRepoList(listed.stdout) : null;
	if (repos === null) {
		notes.push(`gh repo list ${opts.owner} failed (exit ${listed.code}); no repository of ${opts.owner} was read`);
		return finish();
	}
	if (repos.length >= listLimit) notes.push(`the listing of ${opts.owner} reached its limit of ${listLimit}; more repositories may exist`);

	const skip = new Set([...(opts.skipRepos ?? [])].map((slug) => slug.toLowerCase()));
	const active = repos.filter((repo) => !repo.archived);
	const withClone = active.filter((repo) => skip.has(repo.slug.toLowerCase()));
	notes.push(`${repos.length - active.length} archived and ${withClone.length} locally cloned repositories of ${opts.owner} were not read through the API`);
	const candidates = active.filter((repo) => !skip.has(repo.slug.toLowerCase())).sort((a, b) => compareText(a.slug, b.slug));
	const cap = Math.max(0, Math.floor(opts.maxRepos ?? DEFAULT_GITHUB_MAX_REPOS));
	const selected = candidates.slice(0, cap);
	if (candidates.length > selected.length) notes.push(`${candidates.length - selected.length} repositories of ${opts.owner} left unread by the repository cap`);

	await Promise.all(
		selected.map(async (repo) => {
			const problems: string[] = [];
			let files = 0;
			let bytes = 0;
			try {
				if (repo.branch === null) {
					notes.push(`${repo.slug} has no default branch, so it has no documents`);
				} else {
					const sha = await call(["api", "-H", "Accept: application/vnd.github.sha", `repos/${repo.slug}/commits/${encodeURIComponent(repo.branch)}`]);
					const commit = sha.code === 0 && COMMIT_SHA.test(sha.stdout.trim()) ? sha.stdout.trim() : undefined;
					if (commit === undefined) notes.push(`${repo.slug}: the head commit of ${repo.branch} could not be resolved, so its entries have no commit`);
					const treeResult = await call(["api", `repos/${repo.slug}/git/trees/${commit ?? encodeURIComponent(repo.branch)}?recursive=1`]);
					const tree = treeResult.code === 0 ? parseTree(treeResult.stdout) : null;
					if (tree === null) {
						problems.push(`the tree of ${repo.branch} could not be read (exit ${treeResult.code})`);
						skipped.push({ repo: repo.slug, path: "(tree)", reason: "fetch-failed" });
					} else {
						if (tree.truncated) problems.push("the tree is truncated by the API, so some documents were not listed");
						await Promise.all(
							tree.items.map(async (item) => {
								if (item.type !== "blob") return;
								const found = classify(item.path);
								if (found === null || found.tier > maxTier) return;
								const refuse = (reason: SkippedFile["reason"]): void => {
									skipped.push({ repo: repo.slug, path: item.path, reason });
								};
								if (!isValidPath(item.path)) return refuse("bad-path");
								if (item.mode === SYMLINK_MODE) return refuse("symlink");
								if (item.size === 0) return refuse("empty");
								if (item.size !== undefined && item.size > maxBytes) return refuse("too-large");
								const blob = await call(["api", `repos/${repo.slug}/git/blobs/${item.sha}`]);
								const data = blob.code === 0 ? parseBlob(blob.stdout) : null;
								if (data === null) {
									problems.push(`blob of ${item.path} could not be fetched`);
									return refuse("fetch-failed");
								}
								const inspected = inspectBytes(data, maxBytes);
								if (!inspected.ok) return refuse(inspected.reason);
								const supersededBy = entrySupersededBy(found.tier, inspected.text);
								const entry: CorpusEntry = {
									repo: repo.slug,
									path: item.path,
									kind: found.kind,
									tier: found.tier,
									sha256: inspected.sha256,
									bytes: inspected.bytes,
									source: "github",
									...(commit === undefined ? {} : { commit }),
									...(supersededBy === undefined ? {} : { supersededBy }),
								};
								entries.push(entry);
								files += 1;
								bytes += inspected.bytes;
								await opts.onBody?.(entry, inspected.text);
							}),
						);
					}
				}
			} catch (cause) {
				problems.push(`read failed: ${message(cause)}`);
				skipped.push({ repo: repo.slug, path: "(repository)", reason: "fetch-failed" });
			}
			reports.push({
				repo: repo.slug,
				dir: `github:${repo.slug}`,
				source: "github",
				files,
				bytes,
				complete: problems.length === 0,
				...(problems.length === 0 ? {} : { incomplete: problems.slice(0, 3).join("; ") }),
			});
		}),
	);
	return finish();
}
