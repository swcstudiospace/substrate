/**
 * Graph attribution from a worktree path. The dispatcher gives each graph one
 * worktree at `<root>/<graph_id>` (dispatcher worktree.py), so a path inside a
 * configured root names its graph. The roots are `SUBSTRATE_WORKTREE_ROOTS`
 * (colon separated), defaulting to the dispatcher's own directory. This is
 * string work only: nothing here touches the disk, so a symlink is read as the
 * path it was written under.
 */
import { isAbsolute, posix } from "node:path";

/** Where the dispatcher creates per-Graph-ID worktrees, and the root when none is configured. Keep in step with worktree.py. */
export const WORKTREE_ROOT = "/var/lib/substrate/worktrees";

/** The shape a graph id may take. It is also a directory name under the root, so no separators or dots-first. */
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The configured roots: absolute entries of `SUBSTRATE_WORKTREE_ROOTS` in the order written, or
 * `[WORKTREE_ROOT]` when it is unset or holds no usable entry. A relative entry is dropped, not guessed at.
 */
export function worktreeRoots(env: Record<string, string | undefined> = process.env): string[] {
	const roots: string[] = [];
	for (const part of (env.SUBSTRATE_WORKTREE_ROOTS ?? "").split(":")) {
		const entry = part.trim();
		if (entry === "" || !isAbsolute(entry)) continue;
		const normal = posix.resolve(entry);
		if (!roots.includes(normal)) roots.push(normal);
	}
	return roots.length > 0 ? roots : [WORKTREE_ROOT];
}

function graphIdUnder(path: string, root: string): string | null {
	const relative = posix.relative(root, posix.normalize(path));
	if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) return null;
	const graphId = relative.split("/")[0] ?? "";
	return GRAPH_ID.test(graphId) ? graphId : null;
}

/**
 * The graph a path belongs to, or null. The first segment under the first root that contains the
 * path is the id. A root itself, a path outside every root, a traversal that leaves it, a relative
 * path, and a segment that is not a plain id all name no graph. `roots` defaults to the configured ones.
 */
export function graphIdForWorktree(path: string | null | undefined, roots: string | readonly string[] = worktreeRoots()): string | null {
	if (!path || !posix.isAbsolute(path)) return null;
	for (const root of typeof roots === "string" ? [roots] : roots) {
		const relative = posix.relative(root, posix.normalize(path));
		// The first root that contains the path decides: a later root does not get a second opinion.
		if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) continue;
		return graphIdUnder(path, root);
	}
	return null;
}
