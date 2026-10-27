import { encodeMetadata, listPinnedIn, type PinnedCheckpoint, pinTree, readPinnedSnapshotIn } from "./pin.ts";
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

export type PinParams = {
	worktree: string;
	snapshot: Snapshot;
	id: string;
	/**
	 * Optional metadata stored as a trailer in the pinned commit message, so it survives with the ref.
	 * A JSON object of at most 4 KiB of canonical JSON (sorted keys). Written when the pin is created;
	 * an idempotent re-pin of the same id and tree keeps the original.
	 */
	metadata?: Record<string, unknown>;
	now?: Clock;
	run?: Runner;
};

/**
 * Make a snapshot durable under `refs/substrate/checkpoints/<worktree scope>/<id>` (see pin.ts for the
 * scope and for the warning about pushing that namespace). Idempotent for the same id and tree.
 */
export async function pinSnapshot(params: PinParams): Promise<PinResult> {
	const ctx = await openRepo(params);
	const tree = await validateTarget(ctx, params.snapshot);
	const metadata = params.metadata === undefined ? undefined : encodeMetadata(params.metadata);
	return pinTree(ctx, "checkpoints", params.id, tree, metadata);
}

export type ListPinnedParams = { worktree: string; now?: Clock; run?: Runner };

/**
 * The pinned checkpoints of THIS worktree with their id, commit, tree and parsed metadata: its own
 * scope under `refs/substrate/checkpoints/`, plus, for the main worktree only, unscoped checkpoints
 * made before scoping. Another linked worktree's checkpoints are never listed. A corrupt metadata
 * trailer is reported on its entry, never thrown. These refs are the local checkpoint registry: they
 * work with no server.
 */
export async function listPinned(params: ListPinnedParams): Promise<PinnedCheckpoint[]> {
	return listPinnedIn(await openRepo(params));
}

export type ReadPinnedParams = { worktree: string; ref: string; now?: Clock; run?: Runner };

/** Rebuild a Snapshot from a pinned ref such as `refs/substrate/safety/<id>`. */
export async function readPinnedSnapshot(params: ReadPinnedParams): Promise<Snapshot> {
	const ctx = await openRepo(params);
	return readPinnedSnapshotIn(ctx, params.ref);
}
