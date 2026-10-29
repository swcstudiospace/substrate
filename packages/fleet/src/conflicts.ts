/**
 * A forecast of which worktrees of one repository will collide when merged, made without touching any of them.
 *
 * For each worktree: the files it changed against its merge base plus its uncommitted changes. For each
 * pair that changed a common file: a textual prediction from `git merge-tree --write-tree --name-only`
 * on the two HEAD commits (exit 1 means conflicts, and the output lists the files). That command needs
 * git 2.38 or newer and writes only tree objects into the object store; neither working tree nor index
 * is read or changed. An older git reports `unavailable`, never a guess.
 *
 * Limits, stated rather than hidden: the prediction compares committed HEADs, so uncommitted edits
 * count toward the overlap list but not toward the prediction; a clean textual merge can still break
 * the build (semantic conflicts); and only pairs are predicted, not the cumulative result of merging
 * three branches in a row.
 */
import type { GitRunner } from "./git.ts";
import { mapLimit } from "./pool.ts";

export interface ForecastWorktree {
	path: string;
	branch: string | null;
	head: string;
	base: string | null;
}

export type PairPrediction = "clean" | "conflict" | "unavailable" | "error";

export interface OverlapPair {
	a: string;
	b: string;
	/** Files both worktrees changed. */
	files: string[];
	prediction: PairPrediction;
	/** Files git says conflict; empty unless the prediction is `conflict`. */
	conflicted_files: string[];
	detail: string | null;
}

export interface ForecastEntry extends ForecastWorktree {
	files: string[];
	notes: string[];
}

export interface MergeStep {
	position: number;
	path: string;
	changed_files: number;
	overlaps_with: string[];
}

export interface RebaseNeed {
	/** The worktree that merges later and must rebase onto the earlier one's result. */
	path: string;
	after: string;
	files: string[];
}

export interface MergeOrder {
	order: MergeStep[];
	rebase: RebaseNeed[];
}

export interface ConflictForecast extends MergeOrder {
	worktrees: ForecastEntry[];
	overlaps: OverlapPair[];
	merge_tree: "available" | "unavailable";
	/** True when any worktree's changed files could not be listed completely: the lists and overlaps may be missing files. */
	incomplete: boolean;
	notes: string[];
}

export interface ForecastOptions {
	git: GitRunner;
	/** Pairs predicted before the rest are reported `unavailable`. Default 300. */
	maxPairs?: number;
	concurrency?: number;
}

export const MIN_MERGE_TREE_VERSION: readonly [number, number] = [2, 38];
const DEFAULT_MAX_PAIRS = 300;
const DEFAULT_CONCURRENCY = 4;

/** `[major, minor]` from `git version 2.43.0`, or null. */
export function parseGitVersion(text: string): [number, number] | null {
	const match = /(\d+)\.(\d+)/.exec(text);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2])];
}

export function supportsMergeTree(version: readonly [number, number] | null): boolean {
	if (version === null) return false;
	return version[0] > MIN_MERGE_TREE_VERSION[0] || (version[0] === MIN_MERGE_TREE_VERSION[0] && version[1] >= MIN_MERGE_TREE_VERSION[1]);
}

/** Paths from `git status --porcelain=v1 -z`: `XY path` entries, NUL separated (renames are disabled, so one path each). */
export function parseStatusZ(text: string): string[] {
	const paths: string[] = [];
	for (const entry of text.split("\0")) {
		if (entry.length > 3) paths.push(entry.slice(3));
	}
	return paths;
}

function splitNul(text: string): string[] {
	return text.split("\0").filter((part) => part !== "");
}

async function changedFiles(wt: ForecastWorktree, git: GitRunner): Promise<{ files: string[]; notes: string[] }> {
	const files = new Set<string>();
	const notes: string[] = [];
	if (wt.base === null) notes.push("no merge base: only uncommitted changes are listed");
	else {
		const diff = await git(["diff", "--name-only", "--no-renames", "-z", `${wt.base}...HEAD`], wt.path);
		if (diff.code === 0) for (const path of splitNul(diff.stdout)) files.add(path);
		else notes.push(`git diff failed: ${diff.stderr.trim().slice(0, 120)}`);
	}
	const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], wt.path);
	if (status.code === 0) for (const path of parseStatusZ(status.stdout)) files.add(path);
	else notes.push(`git status failed: ${status.stderr.trim().slice(0, 120)}`);
	return { files: [...files].sort(), notes };
}

/** Parse `git merge-tree --write-tree --name-only` output: the tree id, then conflicted paths, then a blank line and messages. */
export function parseMergeTree(stdout: string): string[] {
	const lines = stdout.split("\n");
	const files: string[] = [];
	for (const line of lines.slice(1)) {
		if (line === "") break;
		files.push(line);
	}
	return files;
}

async function predict(a: ForecastEntry, b: ForecastEntry, overlap: string[], git: GitRunner, available: boolean, within: boolean): Promise<OverlapPair> {
	const pair: OverlapPair = { a: a.path, b: b.path, files: overlap, prediction: "unavailable", conflicted_files: [], detail: null };
	if (!available) return { ...pair, detail: "git 2.38 or newer is needed for git merge-tree --write-tree" };
	if (!within) return { ...pair, detail: "pair limit reached" };
	const result = await git(["merge-tree", "--write-tree", "--name-only", a.head, b.head], a.path);
	if (result.code === 0) return { ...pair, prediction: "clean" };
	if (result.code === 1) return { ...pair, prediction: "conflict", conflicted_files: parseMergeTree(result.stdout) };
	return { ...pair, prediction: "error", detail: result.stderr.trim().slice(0, 160) || `git merge-tree exited ${result.code}` };
}

/**
 * Worktrees with no overlaps first, then fewer changed files, ties by path. A pair predicted to
 * conflict makes the later one need a rebase onto the earlier.
 */
export function suggestMergeOrder(entries: ReadonlyArray<{ path: string; files: readonly string[] }>, overlaps: readonly OverlapPair[]): MergeOrder {
	const partners = new Map<string, string[]>();
	for (const pair of overlaps) {
		partners.set(pair.a, [...(partners.get(pair.a) ?? []), pair.b]);
		partners.set(pair.b, [...(partners.get(pair.b) ?? []), pair.a]);
	}
	const sorted = [...entries].sort((x, y) => {
		const overlapX = (partners.get(x.path)?.length ?? 0) > 0 ? 1 : 0;
		const overlapY = (partners.get(y.path)?.length ?? 0) > 0 ? 1 : 0;
		return overlapX - overlapY || x.files.length - y.files.length || x.path.localeCompare(y.path);
	});
	const position = new Map<string, number>();
	const order: MergeStep[] = sorted.map((entry, index) => {
		position.set(entry.path, index + 1);
		return { position: index + 1, path: entry.path, changed_files: entry.files.length, overlaps_with: [...(partners.get(entry.path) ?? [])].sort() };
	});
	const rebase: RebaseNeed[] = [];
	for (const pair of overlaps) {
		if (pair.prediction !== "conflict") continue;
		const positionA = position.get(pair.a) ?? 0;
		const positionB = position.get(pair.b) ?? 0;
		const [earlier, later] = positionA <= positionB ? [pair.a, pair.b] : [pair.b, pair.a];
		rebase.push({ path: later, after: earlier, files: pair.conflicted_files });
	}
	return { order, rebase };
}

export async function forecastConflicts(worktrees: readonly ForecastWorktree[], options: ForecastOptions): Promise<ConflictForecast> {
	const git = options.git;
	const notes: string[] = [];
	const first = worktrees[0];
	const version = first === undefined ? null : parseGitVersion((await git(["version"], first.path)).stdout);
	const available = supportsMergeTree(version);
	if (!available) notes.push("git merge-tree --write-tree is unavailable (git 2.38 or newer is needed); overlaps are listed without a prediction");

	const entries: ForecastEntry[] = await mapLimit(worktrees, options.concurrency ?? DEFAULT_CONCURRENCY, async (wt) => {
		const changed = await changedFiles(wt, git);
		return { ...wt, files: changed.files, notes: changed.notes };
	});
	entries.sort((x, y) => x.path.localeCompare(y.path));

	const pending: Array<{ a: ForecastEntry; b: ForecastEntry; files: string[] }> = [];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i];
			const b = entries[j];
			if (a === undefined || b === undefined) continue;
			const inB = new Set(b.files);
			const files = a.files.filter((file) => inB.has(file));
			if (files.length > 0) pending.push({ a, b, files });
		}
	}
	const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS;
	if (pending.length > maxPairs) notes.push(`${pending.length} overlapping pairs; only the first ${maxPairs} were predicted`);
	const overlaps = await mapLimit(pending, options.concurrency ?? DEFAULT_CONCURRENCY, (item, index) => predict(item.a, item.b, item.files, git, available, index < maxPairs));
	const { order, rebase } = suggestMergeOrder(entries, overlaps);
	return { worktrees: entries, overlaps, order, rebase, merge_tree: available ? "available" : "unavailable", incomplete: entries.some((entry) => entry.notes.length > 0), notes };
}
