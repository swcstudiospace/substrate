/**
 * The dry run. Nothing here writes to the worktree; the only side effect is the temporary index
 * `buildTree` creates and removes inside the git directory.
 */

import { SnapshotPolicyError, UnsupportedPathError } from "./errors.ts";
import { ancestorsOf, comparePaths, isObjectId } from "./paths.ts";
import { excludedByName, resolvePolicy } from "./policy.ts";
import { openRepo, type RepoContext, type Runner } from "./runner.ts";
import { assertTreeExists, buildTree, diffTrees, lsTree, manifestOf, type RawChange } from "./tree.ts";
import type {
	Clock,
	EntryMode,
	IgnoredPath,
	OperationCounts,
	ResolvedPolicy,
	RestoreOperation,
	RestorePlan,
	SkippedPath,
	SkipReason,
	Snapshot,
	SnapshotPolicy,
	WriteOperation,
} from "./types.ts";

function entryMode(mode: string, path: string): EntryMode {
	if (mode === "100644" || mode === "100755" || mode === "120000") return mode;
	throw new UnsupportedPathError(path, `unsupported entry mode ${mode}`);
}

function toOperation(change: RawChange): RestoreOperation {
	const { path } = change;
	if (change.status === "D") return { op: "delete", path, previousMode: entryMode(change.srcMode, path) };
	const base = { path, mode: entryMode(change.dstMode, path), sha: change.dstSha };
	if (change.status === "A") return { op: "add", ...base };
	const previousMode = entryMode(change.srcMode, path);
	if (change.status === "T") return { op: "retype", ...base, previousMode };
	return { op: change.srcSha === change.dstSha ? "chmod" : "modify", ...base, previousMode };
}

/**
 * Execution order: (1) deletes that make room for a write (a file that becomes a directory, the
 * files of a directory that becomes a file), (2) writes, (3) the remaining deletes. Within each
 * group paths are in byte order. Empty directories are pruned after (3); they are not operations.
 */
export function orderOperations(operations: readonly RestoreOperation[]): RestoreOperation[] {
	const writes = operations.filter((operation): operation is WriteOperation => operation.op !== "delete");
	const deletes = operations.filter((operation) => operation.op === "delete");
	const writePaths = new Set(writes.map((operation) => operation.path));
	const writeAncestors = new Set(writes.flatMap((operation) => ancestorsOf(operation.path)));
	const blocking = (operation: RestoreOperation): boolean =>
		writeAncestors.has(operation.path) || ancestorsOf(operation.path).some((dir) => writePaths.has(dir));
	const byPath = (a: RestoreOperation, b: RestoreOperation): number => comparePaths(a.path, b.path);
	return [
		...deletes.filter(blocking).sort(byPath),
		...writes.sort(byPath),
		...deletes.filter((operation) => !blocking(operation)).sort(byPath),
	];
}

export function countOperations(operations: readonly RestoreOperation[]): OperationCounts {
	const counts: OperationCounts = { add: 0, modify: 0, delete: 0, chmod: 0, retype: 0, total: operations.length };
	for (const operation of operations) counts[operation.op]++;
	return counts;
}

/** Split changes into the ones the policy lets us touch and the ones it excludes by name. */
function partition(changes: readonly RawChange[], policy: ResolvedPolicy): { kept: RawChange[]; ignored: IgnoredPath[] } {
	const kept: RawChange[] = [];
	const ignored: IgnoredPath[] = [];
	for (const change of changes) {
		const verdict = excludedByName(change.path, policy);
		if (verdict === null) kept.push(change);
		else ignored.push({ path: change.path, reason: verdict === "secret-pattern" ? "secret-pattern" : "excluded" });
	}
	return { kept, ignored };
}

/**
 * A lookup from a path to the skipped entry that covers it: an exact entry, or, for a skipped nested
 * repository (`unsupported-submodule`), anything under its directory. Undefined when nothing covers it.
 */
function skippedMatcher(skipped: readonly SkippedPath[]): (path: string) => SkippedPath | undefined {
	if (skipped.length === 0) return () => undefined;
	const exact = new Map<string, SkippedPath>();
	const directories: SkippedPath[] = [];
	for (const entry of skipped) {
		exact.set(entry.path, entry);
		if (entry.reason === "unsupported-submodule") directories.push(entry);
	}
	return (path) => exact.get(path) ?? directories.find((dir) => path.startsWith(`${dir.path}/`));
}

/**
 * Deletions of paths the snapshot SKIPPED (too large, secret, submodule, unsupported type) are not
 * deletions at all: a skipped path is absent from the target tree because it was never captured, not
 * because it did not exist. They are split out of `changes` so a restore leaves them as they are.
 * A skipped directory (a nested repository) covers everything under it.
 */
function protectSkipped(
	changes: readonly RawChange[],
	skipped: readonly SkippedPath[],
): { kept: RawChange[]; skippedInSnapshot: SkippedPath[] } {
	if (skipped.length === 0) return { kept: [...changes], skippedInSnapshot: [] };
	const covering = skippedMatcher(skipped);
	const kept: RawChange[] = [];
	const skippedInSnapshot: SkippedPath[] = [];
	for (const change of changes) {
		const entry = change.status === "D" ? covering(change.path) : undefined;
		if (entry === undefined) kept.push(change);
		else skippedInSnapshot.push({ path: change.path, reason: entry.reason });
	}
	return { kept, skippedInSnapshot };
}

/** Paths in `changes` that the policy does not exclude by name and the snapshot did not skip, as sorted path strings. */
export function nonExcludedPaths(
	changes: readonly RawChange[],
	policy: ResolvedPolicy,
	skipped: readonly SkippedPath[] = [],
): string[] {
	return protectSkipped(partition(changes, policy).kept, skipped)
		.kept.map((change) => change.path)
		.sort(comparePaths);
}

const SKIP_REASONS: readonly string[] = ["secret-pattern", "too-large", "unsupported-submodule", "unsupported-filetype"];

function isSkipReason(value: unknown): value is SkipReason {
	return typeof value === "string" && SKIP_REASONS.includes(value);
}

/** A stored skipped list, validated entry by entry; anything that is not a well-formed `{path, reason}` is dropped. */
export function parseSkipped(list: unknown): SkippedPath[] {
	if (!Array.isArray(list)) return [];
	const out: SkippedPath[] = [];
	for (const entry of list as unknown[]) {
		if (typeof entry !== "object" || entry === null || !("path" in entry) || !("reason" in entry)) continue;
		const { path, reason } = entry;
		if (typeof path === "string" && path.length > 0 && isSkipReason(reason)) out.push({ path, reason });
	}
	return out;
}

/** A snapshot's skipped list; an old or hand-built snapshot may have none. */
export function skippedOf(snapshot: Pick<Snapshot, "skipped">): SkippedPath[] {
	return parseSkipped(snapshot.skipped);
}

/**
 * The plan that turns `currentTree` into `targetTree`. `drift` is expected-to-current. `skipped` is
 * what the target snapshot skipped when it was taken: those paths are left alone, never deleted.
 * `options.expectedSkipped` is what the snapshot that `expectedCurrentTree` stands for skipped: those
 * paths were never part of it, so a difference at one is not drift (see `skippedMatcher`).
 * `options.truncated` says the target's skipped list was capped when it was pinned; the plan repeats it.
 */
export async function planBetween(
	ctx: RepoContext,
	policy: ResolvedPolicy,
	currentTree: string,
	targetTree: string,
	expectedCurrentTree?: string,
	skipped: readonly SkippedPath[] = [],
	options: { expectedSkipped?: readonly SkippedPath[]; truncated?: { total: number } | null } = {},
): Promise<RestorePlan> {
	const { kept: named, ignored } = partition(await diffTrees(ctx, currentTree, targetTree), policy);
	const { kept, skippedInSnapshot } = protectSkipped(named, skipped);
	const operations = orderOperations(kept.map(toOperation));
	let drift: RestoreOperation[] = [];
	if (expectedCurrentTree !== undefined) {
		await assertTreeExists(ctx, expectedCurrentTree, "expectedCurrentTree");
		const expectedSkipped = skippedMatcher(options.expectedSkipped ?? []);
		drift = partition(await diffTrees(ctx, expectedCurrentTree, currentTree), policy)
			.kept.filter((change) => expectedSkipped(change.path) === undefined)
			.map(toOperation)
			.sort((a, b) => comparePaths(a.path, b.path));
	}
	return {
		currentTree,
		targetTree,
		operations,
		counts: countOperations(operations),
		drift,
		ignored: ignored.sort((a, b) => comparePaths(a.path, b.path)),
		skippedInSnapshot: skippedInSnapshot.sort((a, b) => comparePaths(a.path, b.path)),
		...(options.truncated ? { skippedTruncated: { recorded: skipped.length, total: options.truncated.total } } : {}),
	};
}

/**
 * True when `left` and `right` differ only at paths `skipped` covers: the paths a snapshot skipped are
 * not part of it, so a worktree that holds them (a restore leaves them in place) is still "at" that
 * snapshot. Any difference elsewhere, including a real edit to a captured file, makes this false.
 */
export async function treesMatchIgnoringSkipped(
	ctx: RepoContext,
	left: string,
	right: string,
	skipped: readonly SkippedPath[],
): Promise<boolean> {
	if (left === right) return true;
	if (skipped.length === 0) return false;
	const covered = skippedMatcher(skipped);
	return (await diffTrees(ctx, left, right)).every((change) => covered(change.path) !== undefined);
}

/** Check a snapshot's shape, that its tree exists, and that its manifest matches that tree. */
export async function validateTarget(ctx: RepoContext, target: Snapshot): Promise<string> {
	if (
		typeof target !== "object" ||
		target === null ||
		target.version !== 1 ||
		!isObjectId(target.tree) ||
		typeof target.manifestSha256 !== "string"
	) {
		throw new SnapshotPolicyError("target is not a version 1 snapshot");
	}
	await assertTreeExists(ctx, target.tree, "target tree");
	if (manifestOf(await lsTree(ctx, target.tree)) !== target.manifestSha256) {
		throw new SnapshotPolicyError("the snapshot manifest does not match its tree");
	}
	return target.tree;
}

export type PlanRestoreParams = {
	worktree: string;
	target: Snapshot;
	expectedCurrentTree?: string;
	/** What the snapshot behind `expectedCurrentTree` skipped: a difference at one of those paths is not drift. */
	expectedCurrentSkipped?: readonly SkippedPath[];
	policy?: SnapshotPolicy;
	now?: Clock;
	run?: Runner;
};

/**
 * Dry run: what `restore` would do, and what changed in the worktree outside the session
 * (`drift`, only when `expectedCurrentTree` is given). Writes nothing to the worktree.
 */
export async function planRestore(params: PlanRestoreParams): Promise<RestorePlan> {
	const ctx = await openRepo(params);
	const policy = resolvePolicy(params.policy);
	const targetTree = await validateTarget(ctx, params.target);
	const current = await buildTree(ctx, policy);
	return planBetween(ctx, policy, current.tree, targetTree, params.expectedCurrentTree, skippedOf(params.target), {
		expectedSkipped: params.expectedCurrentSkipped,
		truncated: params.target.skippedTruncated ?? null,
	});
}
