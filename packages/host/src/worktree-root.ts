// The host's one resolution of the worktree root. Same rule as the dispatcher's creation_root() in
// packages/dispatcher/src/substrate_dispatcher/worktree.py: the first absolute entry of
// SUBSTRATE_WORKTREE_ROOTS, else the default. Node built-ins only, so bun:test loads this without rivet.
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_WORKTREES_ROOT = "/var/lib/substrate/worktrees";

export type EnvLike = Record<string, string | undefined>;

/** Where worktrees are created and bound on this host. */
export function worktreeRoot(env: EnvLike = process.env): string {
	const raw = env.SUBSTRATE_WORKTREE_ROOTS;
	if (raw !== undefined) {
		for (const part of raw.split(":")) {
			const entry = part.trim();
			if (entry !== "" && isAbsolute(entry)) return resolve(entry);
		}
	}
	return DEFAULT_WORKTREES_ROOT;
}
