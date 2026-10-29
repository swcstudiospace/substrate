/**
 * Scan the documentation of every repository below a set of roots (v1.7 phase 63).
 *
 * For a git checkout the candidates are the tracked files (`git ls-files -z`); for a copy collection they are the files
 * of a tree walk. Every candidate is classified, filtered by tier, read, checked (not a symlink, not empty, not too
 * large, no NUL byte, valid UTF-8) and hashed. The result is deterministic: the same tree always gives the same output,
 * entries sorted by `(repo, path)`.
 *
 * Each repository reports whether it was read completely. The CLI lists only the complete (repository, source) pairs as
 * the plan's coverage, so a failed read never lets the server tombstone what the scan did not see.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, isExcludedSegment } from "./classify.ts";
import { isValidPath } from "./names.ts";
import {
	type Checkout,
	type Collection,
	type DirEntry,
	DUPLICATE_LABEL,
	defaultGitRunner,
	directoryLabel,
	discoverRepos,
	type GitRunner,
	hasGitEntry,
	readEntries,
} from "./discover.ts";
import {
	type CorpusCoverage,
	type CorpusEntry,
	type CorpusScope,
	type CorpusSource,
	type DocTier,
	documentKey,
} from "./protocol.ts";

export const DEFAULT_MAX_TIER: DocTier = 2;
export const DEFAULT_MAX_BYTES = 1_000_000;

/** The most skipped files listed individually; the per-reason counts always cover all of them. */
export const MAX_LISTED_SKIPS = 1000;

/** A tree walk never goes deeper than this, so a directory loop that slipped past the symlink rule cannot run forever. */
const MAX_WALK_DEPTH = 64;

export const SKIP_REASONS = [
	"symlink",
	"empty",
	"too-large",
	"binary",
	"invalid-utf8",
	"missing",
	"not-a-file",
	"unreadable",
	"fetch-failed",
	"bad-path",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface SkippedFile {
	repo: string;
	path: string;
	reason: SkipReason;
}

export interface RepoReport {
	repo: string;
	/** The directory read, or `github:<slug>` for a repository read through the API. */
	dir: string;
	source: CorpusSource;
	files: number;
	bytes: number;
	/** False when the repository was not read completely (a read error, a truncated tree); see `incomplete`. */
	complete: boolean;
	incomplete?: string | undefined;
}

/** One canonical entry and the byte-identical copies in other repositories that collapsed into it (keys are `repo:path`). */
export interface IdenticalGroup {
	keep: string;
	copies: string[];
}

export const MAX_IDENTICAL_GROUPS = 200;
export const MAX_IDENTICAL_COPIES = 20;

export interface ScanReport {
	/** Checkouts found before clones and worktrees collapsed. */
	checkouts: number;
	repos: RepoReport[];
	collapsed: {
		clones: number;
		worktrees: number;
		/** Entries dropped because a byte-identical copy in another `local/*` repository is the canonical one. */
		identical: number;
		/** How many canonical entries stand for dropped copies; `identicalCopies` lists at most the first 200. */
		identicalGroups: number;
		identicalCopies: IdenticalGroup[];
	};
	/** Up to `MAX_LISTED_SKIPS` skipped files. */
	skipped: SkippedFile[];
	skippedByReason: Partial<Record<SkipReason, number>>;
	/** Repositories read completely that hold no eligible document (an emptied collection or checkout); they are still covered. */
	emptyCollections: number;
	notes: string[];
}

/** What a source adapter (Greptile export, GitHub) returns: entries and the same report pieces a filesystem scan has. */
export interface AdapterResult {
	entries: CorpusEntry[];
	repos: RepoReport[];
	skipped: SkippedFile[];
	skippedByReason: Partial<Record<SkipReason, number>>;
	notes: string[];
	/** Where each entry's bytes live on disk (the Greptile export); empty for the GitHub adapter, which hands bodies to `onBody`. */
	paths: Map<string, string>;
}

export interface ScanResult {
	entries: CorpusEntry[];
	report: ScanReport;
	/** Where each entry's bytes live, keyed by `documentKey(repo, path)`, so a later step can read the body. */
	paths: Map<string, string>;
}

export interface FileStat {
	symlink: boolean;
	file: boolean;
	size: number;
}

export interface ScanOptions {
	roots: string[];
	/** Entries above this tier are dropped. Default 2. */
	maxTier?: DocTier | undefined;
	/** Files over this many bytes are skipped. Default 1,000,000. */
	maxBytes?: number | undefined;
	/** How deep below a root checkouts are searched for. Default 3. */
	depth?: number | undefined;
	runner?: GitRunner | undefined;
	readFile?: ((path: string) => Uint8Array) | undefined;
	/** Returns null for a path that does not exist and throws for any other failure. */
	lstat?: ((path: string) => FileStat | null) | undefined;
}

export type Inspected =
	| { ok: true; sha256: string; bytes: number; text: string }
	| { ok: false; reason: "empty" | "too-large" | "binary" | "invalid-utf8" };

// `ignoreBOM` keeps a leading byte-order mark in the text: the sha256 covers the original bytes, so the body sent to the
// server must hash to the same value.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The size, NUL and UTF-8 rules every adapter applies, and the sha256 of the raw bytes. */
export function inspectBytes(data: Uint8Array, maxBytes: number): Inspected {
	if (data.byteLength === 0) return { ok: false, reason: "empty" };
	if (data.byteLength > maxBytes) return { ok: false, reason: "too-large" };
	if (data.includes(0)) return { ok: false, reason: "binary" };
	let text: string;
	try {
		text = decoder.decode(data);
	} catch {
		// The fatal decoder throws on invalid UTF-8; the reason is the result.
		return { ok: false, reason: "invalid-utf8" };
	}
	return { ok: true, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength, text };
}

export function defaultLstat(path: string): FileStat | null {
	try {
		const stat = lstatSync(path);
		return { symlink: stat.isSymbolicLink(), file: stat.isFile(), size: stat.size };
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
		throw cause;
	}
}

export interface FileIo {
	maxBytes: number;
	readFile: (path: string) => Uint8Array;
	lstat: (path: string) => FileStat | null;
}

export type LoadedDocument =
	| { ok: true; sha256: string; bytes: number; text: string }
	| {
			ok: false;
			reason: SkipReason;
			/** Set when the file could not be read (as opposed to being refused by a rule): the repository is then incomplete. */
			problem?: string | undefined;
	  };

/**
 * Stat, read and check one file: not missing, not a symlink, a regular file, within the size cap, then the byte rules of
 * `inspectBytes`. The size is checked before the read, so an over-size file is never loaded.
 */
export function loadDocument(path: string, io: FileIo): LoadedDocument {
	let stat: FileStat | null;
	try {
		stat = io.lstat(path);
	} catch (cause) {
		return { ok: false, reason: "unreadable", problem: `cannot stat: ${cause instanceof Error ? cause.message : String(cause)}` };
	}
	if (stat === null) return { ok: false, reason: "missing" };
	if (stat.symlink) return { ok: false, reason: "symlink" };
	if (!stat.file) return { ok: false, reason: "not-a-file" };
	if (stat.size > io.maxBytes) return { ok: false, reason: "too-large" };
	let data: Uint8Array;
	try {
		data = io.readFile(path);
	} catch (cause) {
		return { ok: false, reason: "unreadable", problem: `cannot read: ${cause instanceof Error ? cause.message : String(cause)}` };
	}
	return inspectBytes(data, io.maxBytes);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order of the manifest key: repo, then path, by code unit so the order does not depend on a locale. */
export function compareEntries(a: { repo: string; path: string }, b: { repo: string; path: string }): number {
	return compareText(a.repo, b.repo) || compareText(a.path, b.path);
}

/**
 * The (repository, source) pairs a scan may let the server judge: those every report of which is complete. A pair read by
 * a source that was requested but never reported (a cap, a skipped export) contributes nothing, and a repository that one
 * source read completely is not thereby covered for another.
 */
export function buildScope(input: { reports: readonly RepoReport[]; maxTier: DocTier }): CorpusScope {
	const pairs = new Map<string, { coverage: CorpusCoverage; complete: boolean }>();
	for (const report of input.reports) {
		const key = `${report.source}\0${report.repo}`;
		const known = pairs.get(key);
		if (known === undefined) pairs.set(key, { coverage: { repo: report.repo, source: report.source }, complete: report.complete });
		else known.complete = known.complete && report.complete;
	}
	return {
		coverage: [...pairs.values()]
			.filter((pair) => pair.complete)
			.map((pair) => pair.coverage)
			.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.source, b.source)),
		maxTier: input.maxTier,
	};
}

/** Counts skips by reason and keeps the first `MAX_LISTED_SKIPS` for display. */
export class SkipLog {
	readonly listed: SkippedFile[] = [];
	readonly byReason: Partial<Record<SkipReason, number>> = {};

	add(skip: SkippedFile): void {
		this.byReason[skip.reason] = (this.byReason[skip.reason] ?? 0) + 1;
		if (this.listed.length < MAX_LISTED_SKIPS) this.listed.push(skip);
	}
}

interface Reader {
	maxTier: DocTier;
	maxBytes: number;
	readFile: (path: string) => Uint8Array;
	lstat: (path: string) => FileStat | null;
	skips: SkipLog;
	entries: CorpusEntry[];
	paths: Map<string, string>;
}

interface RepoState {
	repo: string;
	dir: string;
	commit: string | undefined;
	problems: string[];
	/** Paths left unread because an earlier directory of the same label already supplied them. */
	shadowed: number;
}

function readCandidate(reader: Reader, state: RepoState, rel: string, abs: string): void {
	const found = classify(rel);
	if (found === null || found.tier > reader.maxTier) return;
	// The server refuses a whole plan for one path that breaks its rules, so such a file is skipped here, before any copy collapse can let it hide a valid copy.
	if (!isValidPath(rel)) {
		reader.skips.add({ repo: state.repo, path: rel, reason: "bad-path" });
		return;
	}
	// Another directory under the same label already supplied this path (root order decides): it is counted, never read twice.
	if (reader.paths.has(documentKey(state.repo, rel))) {
		state.shadowed += 1;
		return;
	}
	const loaded = loadDocument(abs, reader);
	if (!loaded.ok) {
		reader.skips.add({ repo: state.repo, path: rel, reason: loaded.reason });
		if (loaded.problem !== undefined) state.problems.push(`${rel}: ${loaded.problem}`);
		return;
	}
	reader.entries.push({
		repo: state.repo,
		path: rel,
		kind: found.kind,
		tier: found.tier,
		sha256: loaded.sha256,
		bytes: loaded.bytes,
		source: "fs",
		...(state.commit === undefined ? {} : { commit: state.commit }),
	});
	reader.paths.set(documentKey(state.repo, rel), abs);
}

function scanCheckout(reader: Reader, checkout: Checkout, run: GitRunner): RepoState {
	const state: RepoState = {
		repo: checkout.repo,
		dir: checkout.dir,
		commit: checkout.head ?? undefined,
		problems: [],
		shadowed: 0,
	};
	const listed = run(["ls-files", "-z"], checkout.dir);
	if (listed.code !== 0) {
		state.problems.push(`git ls-files failed in ${checkout.dir} (exit ${listed.code})`);
		return state;
	}
	for (const rel of listed.stdout.split("\0")) {
		if (rel !== "") readCandidate(reader, state, rel, join(checkout.dir, rel));
	}
	return state;
}

function scanCollection(reader: Reader, collection: Collection): RepoState {
	const state: RepoState = { repo: collection.repo, dir: collection.dir, commit: undefined, problems: [], shadowed: 0 };
	const walk = (dir: string, prefix: string, depth: number): void => {
		let entries: DirEntry[];
		try {
			entries = readEntries(dir);
		} catch (cause) {
			state.problems.push(`cannot read directory ${prefix === "" ? "." : prefix}: ${cause instanceof Error ? cause.message : String(cause)}`);
			return;
		}
		for (const entry of entries) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			const abs = join(dir, entry.name);
			if (entry.kind === "dir") {
				// A nested checkout is a repository of its own, found by discovery, so its files are not read twice.
				if (depth < MAX_WALK_DEPTH && !isExcludedSegment(entry.name) && !hasGitEntry(abs)) walk(abs, rel, depth + 1);
			} else if (entry.kind === "file" || entry.kind === "symlink") {
				readCandidate(reader, state, rel, abs);
			}
		}
	};
	walk(collection.dir, "", 0);
	return state;
}

/**
 * Entries byte-identical across different `local/*` repositories collapse to the smallest `(repo, path)`. The groups say
 * which copies each kept entry stands for, so a collapsed copy can be told from a deleted file.
 */
function collapseIdentical(entries: CorpusEntry[]): { kept: CorpusEntry[]; dropped: CorpusEntry[]; groups: IdenticalGroup[] } {
	const winners = new Map<string, CorpusEntry>();
	for (const entry of entries) {
		if (!entry.repo.startsWith("local/")) continue;
		const winner = winners.get(entry.sha256);
		if (winner === undefined || compareEntries(entry, winner) < 0) winners.set(entry.sha256, entry);
	}
	const kept: CorpusEntry[] = [];
	const dropped: CorpusEntry[] = [];
	const copiesOf = new Map<string, string[]>();
	for (const entry of entries) {
		const winner = entry.repo.startsWith("local/") ? winners.get(entry.sha256) : undefined;
		if (winner !== undefined && winner.repo !== entry.repo) {
			dropped.push(entry);
			const copies = copiesOf.get(winner.sha256) ?? [];
			copies.push(documentKey(entry.repo, entry.path));
			copiesOf.set(winner.sha256, copies);
		} else {
			kept.push(entry);
		}
	}
	const groups: IdenticalGroup[] = [];
	for (const [sha256, copies] of copiesOf) {
		const winner = winners.get(sha256);
		if (winner !== undefined) groups.push({ keep: documentKey(winner.repo, winner.path), copies: copies.sort(compareText) });
	}
	groups.sort((a, b) => compareText(a.keep, b.keep));
	return { kept, dropped, groups };
}

export async function scanRoots(opts: ScanOptions): Promise<ScanResult> {
	const run = opts.runner ?? defaultGitRunner;
	const found = discoverRepos(opts.roots, { run, depth: opts.depth });
	const reader: Reader = {
		maxTier: opts.maxTier ?? DEFAULT_MAX_TIER,
		maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
		readFile: opts.readFile ?? ((path) => readFileSync(path)),
		lstat: opts.lstat ?? defaultLstat,
		skips: new SkipLog(),
		entries: [],
		paths: new Map(),
	};

	// Directories that share a label are read in root order, so the first one that holds a path keeps it and an empty one
	// shadows nothing; every other directory keeps its own order.
	const duplicateOf = new Map(found.duplicates.map((duplicate) => [duplicate.repo, duplicate]));
	const readOrder = new Map(found.duplicates.flatMap((duplicate) => duplicate.dirs.map((dir, index): [string, number] => [dir, index])));
	const units = [
		...found.checkouts.map((checkout) => ({ dir: checkout.dir, read: () => scanCheckout(reader, checkout, run) })),
		...found.collections.map((collection) => ({ dir: collection.dir, read: () => scanCollection(reader, collection) })),
	];
	units.sort((a, b) => (readOrder.get(a.dir) ?? -1) - (readOrder.get(b.dir) ?? -1));
	const states = units.map((unit) => unit.read());
	const notes = [...found.notes];
	for (const state of states) {
		const duplicate = duplicateOf.get(state.repo);
		if (duplicate === undefined) continue;
		// Incomplete on purpose: the label is not a coverage pair, so nothing recorded under it is judged removed.
		state.problems.unshift(`${DUPLICATE_LABEL}: ${duplicate.dirs.map(directoryLabel).join(", ")}`);
		if (state.shadowed > 0) {
			notes.push(`${DUPLICATE_LABEL}: ${state.shadowed} document path(s) of ${directoryLabel(state.dir)} are also in an earlier directory labelled ${state.repo} and were not read`);
		}
	}

	const { kept, dropped, groups } = collapseIdentical(reader.entries);
	for (const entry of dropped) reader.paths.delete(documentKey(entry.repo, entry.path));
	kept.sort(compareEntries);

	const totals = new Map<string, { files: number; bytes: number }>();
	for (const entry of kept) {
		const total = totals.get(entry.repo) ?? { files: 0, bytes: 0 };
		total.files += 1;
		total.bytes += entry.bytes;
		totals.set(entry.repo, total);
	}
	const repos = states
		.map((state): RepoReport => {
			const total = totals.get(state.repo) ?? { files: 0, bytes: 0 };
			return {
				repo: state.repo,
				dir: state.dir,
				source: "fs",
				files: total.files,
				bytes: total.bytes,
				complete: state.problems.length === 0,
				...(state.problems.length === 0 ? {} : { incomplete: state.problems.slice(0, 3).join("; ") }),
			};
		})
		.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.dir, b.dir));

	return {
		entries: kept,
		paths: reader.paths,
		report: {
			checkouts: found.found,
			repos,
			collapsed: {
				clones: found.collapsed.clones,
				worktrees: found.collapsed.worktrees,
				identical: dropped.length,
				identicalGroups: groups.length,
				identicalCopies: groups.slice(0, MAX_IDENTICAL_GROUPS).map((group) => ({
					keep: group.keep,
					copies: group.copies.slice(0, MAX_IDENTICAL_COPIES),
				})),
			},
			skipped: reader.skips.listed,
			skippedByReason: reader.skips.byReason,
			emptyCollections: repos.filter((repo) => repo.complete && repo.files === 0).length,
			notes,
		},
	};
}
