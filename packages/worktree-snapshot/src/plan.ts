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

/** Paths in `changes` that the policy does not exclude by name, as sorted path strings. */
export function nonExcludedPaths(changes: readonly RawChange[], policy: ResolvedPolicy): string[] {
	return partition(changes, policy)
		.kept.map((change) => change.path)
		.sort(comparePaths);
}

/** The plan that turns `currentTree` into `targetTree`. `drift` is expected-to-current. */
export async function planBetween(
	ctx: RepoContext,
	policy: ResolvedPolicy,
	currentTree: string,
	targetTree: string,
	expectedCurrentTree?: string,
): Promise<RestorePlan> {
	const { kept, ignored } = partition(await diffTrees(ctx, currentTree, targetTree), policy);
	const operations = orderOperations(kept.map(toOperation));
	let drift: RestoreOperation[] = [];
	if (expectedCurrentTree !== undefined) {
		await assertTreeExists(ctx, expectedCurrentTree, "expectedCurrentTree");
		drift = partition(await diffTrees(ctx, expectedCurrentTree, currentTree), policy)
			.kept.map(toOperation)
			.sort((a, b) => comparePaths(a.path, b.path));
	}
	return {
		currentTree,
		targetTree,
		operations,
		counts: countOperations(operations),
		drift,
		ignored: ignored.sort((a, b) => comparePaths(a.path, b.path)),
	};
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
	return planBetween(ctx, policy, current.tree, targetTree, params.expectedCurrentTree);
}
