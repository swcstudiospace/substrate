/**
 * One inventory from every requested source: the filesystem scan, the GitHub repositories without a local clone and a
 * Greptile export, merged into one sorted entry list and one report, plus the coverage a plan may judge.
 *
 * The coverage names only (repository, source) pairs that source read completely. A repository that failed to read, a
 * truncated tree, a repository cut by `--max-repos`, a source that was not asked for, or one that never reached a given
 * repository leave their pair out, so a narrower or failed scan cannot make the server tombstone documents it did not cover.
 */
import {
	buildScope,
	compareEntries,
	type AdapterResult,
	type CorpusEntry,
	type CorpusScope,
	type CorpusSource,
	type DocTier,
	type GhRunner,
	type GitRunner,
	type ScanReport,
	type SkipReason,
	SKIP_REASONS,
	type SkippedFile,
	type RepoReport,
	MAX_LISTED_SKIPS,
	documentKey,
	isValidPath,
	isValidRepo,
	scanGithub,
	scanGreptileExport,
	scanRoots,
} from "@substrate/corpus";

export interface InventoryOptions {
	roots: string[];
	maxTier: DocTier;
	maxBytes: number;
	sources: CorpusSource[];
	greptileDir?: string | undefined;
	githubOwner?: string | undefined;
	/** Bounds the GitHub and Greptile sources; the filesystem scan is not capped. */
	maxRepos: number;
	depth?: number | undefined;
	runner?: GitRunner | undefined;
	gh?: GhRunner | undefined;
	readFile?: ((path: string) => Uint8Array) | undefined;
	/** Receives the text of each GitHub document as it is fetched; set only when the bodies will be sent. */
	onBody?: ((entry: CorpusEntry, body: string) => void | Promise<void>) | undefined;
}

export interface InventoryReport {
	checkouts: number;
	repos: RepoReport[];
	collapsed: ScanReport["collapsed"];
	skipped: SkippedFile[];
	skippedByReason: Partial<Record<SkipReason, number>>;
	/** Repositories read completely that hold no eligible document: still covered, so their old rows are tombstoned. */
	emptyCollections: number;
	notes: string[];
}

export interface Inventory {
	entries: CorpusEntry[];
	report: InventoryReport;
	/** Where the bytes of a filesystem or Greptile entry live, keyed by `documentKey`. */
	paths: Map<string, string>;
	sources: CorpusSource[];
	maxTier: DocTier;
	scope: CorpusScope;
}

const EMPTY_COLLAPSED: ScanReport["collapsed"] = { clones: 0, worktrees: 0, identical: 0, identicalGroups: 0, identicalCopies: [] };

export async function collectInventory(opts: InventoryOptions): Promise<Inventory> {
	const results: AdapterResult[] = [];
	let checkouts = 0;
	let collapsed = EMPTY_COLLAPSED;
	const notes: string[] = [];
	const localRepos = new Set<string>();

	if (opts.sources.includes("fs")) {
		const scan = await scanRoots({
			roots: opts.roots,
			maxTier: opts.maxTier,
			maxBytes: opts.maxBytes,
			depth: opts.depth,
			runner: opts.runner,
			readFile: opts.readFile,
		});
		checkouts = scan.report.checkouts;
		collapsed = scan.report.collapsed;
		notes.push(...scan.report.notes);
		for (const repo of scan.report.repos) localRepos.add(repo.repo);
		results.push({
			entries: scan.entries,
			repos: scan.report.repos,
			skipped: scan.report.skipped,
			skippedByReason: scan.report.skippedByReason,
			notes: [],
			paths: scan.paths,
		});
	}
	if (opts.sources.includes("github") && opts.githubOwner !== undefined) {
		results.push(
			await scanGithub({
				owner: opts.githubOwner,
				maxTier: opts.maxTier,
				maxBytes: opts.maxBytes,
				maxRepos: opts.maxRepos,
				// A repository with a local clone was read from disk; reading it again through the API would only duplicate it.
				skipRepos: [...localRepos],
				gh: opts.gh,
				onBody: opts.onBody,
			}),
		);
	}
	if (opts.sources.includes("greptile") && opts.greptileDir !== undefined) {
		results.push(
			await scanGreptileExport(opts.greptileDir, {
				maxTier: opts.maxTier,
				maxBytes: opts.maxBytes,
				maxRepos: opts.maxRepos,
				readFile: opts.readFile,
			}),
		);
	}

	const entries: CorpusEntry[] = [];
	const seen = new Set<string>();
	const paths = new Map<string, string>();
	const skipped: SkippedFile[] = [];
	const skippedByReason: Partial<Record<SkipReason, number>> = {};
	const repos: RepoReport[] = [];
	for (const result of results) {
		notes.push(...result.notes);
		repos.push(...result.repos);
		for (const entry of result.entries) {
			// The server refuses a whole plan request for one entry whose label or path breaks its rules, so such an entry is left out here, counted and listed.
			if (!isValidRepo(entry.repo) || !isValidPath(entry.path)) {
				skippedByReason["bad-path"] = (skippedByReason["bad-path"] ?? 0) + 1;
				if (skipped.length < MAX_LISTED_SKIPS) skipped.push({ repo: entry.repo, path: entry.path, reason: "bad-path" });
				continue;
			}
			const key = documentKey(entry.repo, entry.path);
			if (seen.has(key)) {
				notes.push(`${key} was found by more than one source; the first one is kept`);
				continue;
			}
			seen.add(key);
			entries.push(entry);
			const location = result.paths.get(key);
			if (location !== undefined) paths.set(key, location);
		}
		for (const reason of SKIP_REASONS) {
			const count = result.skippedByReason[reason];
			if (count !== undefined) skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
		}
		for (const skip of result.skipped) if (skipped.length < MAX_LISTED_SKIPS) skipped.push(skip);
	}
	entries.sort(compareEntries);
	repos.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

	return {
		entries,
		paths,
		sources: opts.sources,
		maxTier: opts.maxTier,
		report: { checkouts, repos, collapsed, skipped, skippedByReason, emptyCollections: repos.filter((repo) => repo.complete && repo.files === 0).length, notes },
		scope: buildScope({ reports: repos, maxTier: opts.maxTier }),
	};
}
