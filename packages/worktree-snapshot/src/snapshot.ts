import { refFor, pinTree, readPinnedSnapshotIn } from "./pin.ts";
import { validateTarget } from "./plan.ts";
import { resolvePolicy } from "./policy.ts";
import { openRepo, type Runner } from "./runner.ts";
import { buildSnapshot } from "./tree.ts";
import type { Clock, PinResult, Snapshot, SnapshotPolicy } from "./types.ts";

export type SnapshotParams = { worktree: string; policy?: SnapshotPolicy; now?: Clock; run?: Runner };

/**
 * Snapshot the exact file state of a worktree: tracked, modified and untracked files, executable
 * bits and symlinks. The real index, HEAD, branch, stash and refs are not touched; the only side
 * effects are new objects in the object database and a temporary index that is removed again.
 */
export async function snapshot(params: SnapshotParams): Promise<Snapshot> {
	const ctx = await openRepo(params);
	return buildSnapshot(ctx, resolvePolicy(params.policy));
}

export type PinParams = { worktree: string; snapshot: Snapshot; id: string; now?: Clock; run?: Runner };

/**
 * Make a snapshot durable under `refs/substrate/checkpoints/<id>` (see pin.ts for the warning about
 * pushing that namespace). Idempotent for the same id and tree.
 */
export async function pinSnapshot(params: PinParams): Promise<PinResult> {
	const ctx = await openRepo(params);
	const tree = await validateTarget(ctx, params.snapshot);
	refFor("checkpoints", params.id);
	return pinTree(ctx, "checkpoints", params.id, tree);
}

export type ReadPinnedParams = { worktree: string; ref: string; now?: Clock; run?: Runner };

/** Rebuild a Snapshot from a pinned ref such as `refs/substrate/safety/<id>`. */
export async function readPinnedSnapshot(params: ReadPinnedParams): Promise<Snapshot> {
	const ctx = await openRepo(params);
	return readPinnedSnapshotIn(ctx, params.ref);
}
