/**
 * The live claims of one graph, for `GET /worktrees/claims` (phase 68, the prune guard).
 *
 * A session that reuses an old checkout and holds a lease on a node of its graph is at work even when it has
 * changed no file, so the prune command asks the server before it removes a worktree that belongs to a graph.
 * The answer is the unexpired leases among the graph's nodes, read through the index (`getGraph`, the same read
 * as the `graph_get` tool) and judged by `lease.ts`, so "live" means exactly what it means to every other
 * reader of a lease. No lease id leaves here: the caller learns who holds what and until when, never the fencing token.
 *
 * Unlike the registry routes this one reads existing graph data and writes nothing, so it does not depend on
 * `SUBSTRATE_WORKTREE_REGISTRY`.
 */
import { leaseExpiry, leaseState, type LeaseSnapshot } from "./lease.ts";
import type { GraphNode } from "./types.ts";
import type { Parsed, WorktreeRefusal } from "./worktree-registry.ts";

/** The shape a graph id may take: also a directory name under a worktree root (keep in step with `worktree-graph.ts`). */
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface WorktreeClaim {
	node_id: string;
	holder: { surface: string; session_id: string };
	/** When the lease lapses, ISO 8601. */
	expires_at: string;
}

export type WorktreeClaimsOutcome = { ok: true; graph_id: string; claims: WorktreeClaim[] } | WorktreeRefusal;

/** The `graph_id` of a claims request. A missing or malformed one is refused, never read as "every graph". */
export function parseClaimsQuery(graphId: string | undefined): Parsed<string> {
	if (graphId === undefined || !GRAPH_ID.test(graphId)) return { ok: false, problem: "graph_id must be 1 to 128 characters of letters, digits, dot, underscore or hyphen, starting with a letter or digit" };
	return { ok: true, value: graphId };
}

/** The nodes whose lease is held at `now` (epoch milliseconds), by node id. A free or lapsed node is not a claim. */
export function liveClaims(nodes: readonly GraphNode[], now: number): WorktreeClaim[] {
	const claims: WorktreeClaim[] = [];
	for (const node of nodes) {
		const snapshot: LeaseSnapshot = {
			lease_id: null,
			surface: node.claimed_by ?? null,
			session_id: node.claim_session ?? null,
			claimed_at: node.claimed_at ?? null,
			heartbeat_at: node.lease_heartbeat_at ?? null,
			expires_at: node.lease_expires_at ?? null,
			epoch: Number(node.lease_epoch ?? 0),
		};
		const expiry = leaseExpiry(snapshot);
		if (snapshot.surface === null || expiry === null || leaseState(snapshot, now) !== "held") continue;
		claims.push({ node_id: node.node_id, holder: { surface: snapshot.surface, session_id: snapshot.session_id ?? "" }, expires_at: new Date(expiry).toISOString() });
	}
	return claims.sort((a, b) => a.node_id.localeCompare(b.node_id));
}
