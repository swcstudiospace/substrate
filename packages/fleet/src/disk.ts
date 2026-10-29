/**
 * The free-disk floor for worktrees and the disk pressure they cause.
 *
 * `assertDiskFloor` is what `worktree provision` calls before it creates anything; the Python
 * dispatcher applies the same floor from the same flag. `diskPressure` is report-only: it is what the
 * doctor shows, and it never removes or changes anything.
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GitRunner } from "./git.ts";
import { collectInventory, type InventoryOptions } from "./inventory.ts";

const GIB = 1024 ** 3;

export class DiskFloorError extends Error {
	override readonly name = "DiskFloorError";
	constructor(
		readonly path: string,
		readonly freeBytes: number,
		readonly minFreeBytes: number,
	) {
		super(`only ${(freeBytes / GIB).toFixed(1)} GB free at ${path}; the floor is ${(minFreeBytes / GIB).toFixed(1)} GB`);
	}
}

/** Reads free bytes for the filesystem holding `path`; replaced in tests. */
export type FreeBytesFn = (path: string) => number;

/** The nearest existing directory at or above `path`, so a root that is not created yet still has a filesystem. */
function nearestExisting(path: string): string {
	let current = resolve(path);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}

/** Bytes available to an unprivileged writer on the filesystem that holds `path`. */
export const freeBytes: FreeBytesFn = (path) => {
	const stats = statfsSync(nearestExisting(path));
	return Number(stats.bavail) * Number(stats.bsize);
};

export function assertDiskFloor(path: string, minFreeGb: number, free: FreeBytesFn = freeBytes): void {
	const minFreeBytes = minFreeGb * GIB;
	const available = free(path);
	if (available < minFreeBytes) throw new DiskFloorError(path, available, minFreeBytes);
}

export interface DiskPressure {
	/** The least free space among the filesystems that hold the roots. */
	freeBytes: number;
	minFreeBytes: number;
	ok: boolean;
	/** Linked worktrees, largest first. `bytes` is null when the size walk hit a cap. */
	worktrees: Array<{ path: string; bytes: number | null }>;
}

export interface PressureOptions extends Omit<InventoryOptions, "git" | "measure"> {
	git: GitRunner;
	free?: FreeBytesFn;
}

export async function diskPressure(roots: readonly string[], minFreeGb: number, options: PressureOptions): Promise<DiskPressure> {
	const free = options.free ?? freeBytes;
	const minFreeBytes = minFreeGb * GIB;
	const lowest = roots.length === 0 ? 0 : Math.min(...roots.map((root) => free(root)));
	const inventory = await collectInventory(roots, { ...options, measure: true });
	const worktrees = inventory.worktrees
		.filter((wt) => !wt.primary)
		.map((wt) => ({ path: wt.path, bytes: wt.size_bytes }))
		.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path));
	return { freeBytes: lowest, minFreeBytes, ok: lowest >= minFreeBytes, worktrees };
}
