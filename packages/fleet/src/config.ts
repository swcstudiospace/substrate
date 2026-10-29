/**
 * The three settings the fleet reads, each as a function of an environment object so a test passes its own.
 *
 * - `SUBSTRATE_WORKTREE_ROOTS`: colon-separated absolute directories that hold worktrees. Unset (or with no
 *   absolute entry) means "no root configured" for the commands here and for the doctor: they say so and assume
 *   no location. The collector's graph attribution (`worktreeRoots` in collectors/worktree-graph.ts) reads the same
 *   variable but falls back to the dispatcher's directory, and the dispatcher does not read it at all.
 * - `SUBSTRATE_WORKTREE_MIN_FREE_GB`: the free-disk floor, shared with the Python dispatcher (default 5).
 *   A value that is not a positive number falls back to the default so a typo never switches the floor off.
 * - `SUBSTRATE_WORKTREE_IDLE_DAYS`: how long a worktree must be untouched before prune may call it safe (default 14).
 */
import { isAbsolute, resolve } from "node:path";

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_MIN_FREE_GB = 5;
export const DEFAULT_IDLE_DAYS = 14;

/** Absolute, normalised, de-duplicated roots in the order written. Relative entries are dropped, not guessed at. */
export function worktreeRootsFromEnv(env: EnvLike): string[] {
	const raw = env.SUBSTRATE_WORKTREE_ROOTS;
	if (raw === undefined) return [];
	const roots: string[] = [];
	for (const part of raw.split(":")) {
		const entry = part.trim();
		if (entry === "" || !isAbsolute(entry)) continue;
		const normal = resolve(entry);
		if (!roots.includes(normal)) roots.push(normal);
	}
	return roots;
}

function positiveNumber(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}

export function minFreeGbFromEnv(env: EnvLike): number {
	return positiveNumber(env.SUBSTRATE_WORKTREE_MIN_FREE_GB) ?? DEFAULT_MIN_FREE_GB;
}

export function idleDaysFromEnv(env: EnvLike): number {
	return positiveNumber(env.SUBSTRATE_WORKTREE_IDLE_DAYS) ?? DEFAULT_IDLE_DAYS;
}
