/**
 * Graph attribution from a worktree path. The dispatcher gives each graph one
 * worktree at `<WORKTREE_ROOT>/<graph_id>` (dispatcher worktree.py), so a path
 * inside it names its graph. This is string work only: nothing here touches the
 * disk, so a symlink is read as the path it was written under.
 */
import { posix } from "node:path";

/** Where the dispatcher creates per-Graph-ID worktrees. Keep in step with worktree.py. */
export const WORKTREE_ROOT = "/var/lib/substrate/worktrees";

/** The shape a graph id may take. It is also a directory name under the root, so no separators or dots-first. */
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The graph a path belongs to, or null. The first segment under `root` is the id.
 * The root itself, a path outside it, a traversal that leaves it, a relative
 * path, and a segment that is not a plain id all name no graph.
 */
export function graphIdForWorktree(path: string | null | undefined, root: string = WORKTREE_ROOT): string | null {
	if (!path || !posix.isAbsolute(path)) return null;
	const relative = posix.relative(root, posix.normalize(path));
	if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) return null;
	const graphId = relative.split("/")[0] ?? "";
	return GRAPH_ID.test(graphId) ? graphId : null;
}
