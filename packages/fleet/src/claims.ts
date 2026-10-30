/**
 * Live graph claims, the one fact that says a session is working in a checkout without touching its files.
 *
 * The dispatcher gives each graph one worktree at `<root>/<graph_id>`, and the session that claims a node of
 * that graph holds a lease the server keeps. A session may reuse an old, clean, merged checkout and leave it
 * unchanged for a while, so git and the file times alone cannot tell it from an abandoned one. Only the
 * server can: `GET /worktrees/claims?graph_id=` answers with the unexpired leases of one graph.
 *
 * Fail closed: a worktree that belongs to a graph is removable only after the server answered and named no
 * live claim. An unanswered question (no token, server down, refused, unreadable reply) is `unverified`, which
 * the classifier turns into `review`, never into `safe`.
 */
import { isWorktreeLabel } from "../../mcp-server/src/worktree-registry.ts";

export interface LiveClaim {
	node_id: string;
	holder: { surface: string; session_id: string } | null;
	/** When the lease lapses, ISO 8601. */
	expires_at: string | null;
}

/** What asking the server about one graph returned. */
export type ClaimsLookup = { ok: true; claims: LiveClaim[] } | { ok: false; error: string };

/** One question to the server: the live claims of `graphId`. Never throws. */
export type ClaimsFn = (graphId: string) => Promise<ClaimsLookup>;

/**
 * What is known about live claims on one worktree.
 *
 * - `not-checked`: the worktree is not a graph checkout (no graph id under the roots), or it was already
 *   ruled out for another reason, so nobody asked.
 * - `none`: the server answered and named no live claim.
 * - `live`: the server named at least one live claim; removal is forbidden.
 * - `unverified`: the question could not be answered; removal is not allowed on a guess.
 */
export type ClaimStatus =
	| { state: "not-checked" }
	| { state: "none"; graph_id: string }
	| { state: "live"; graph_id: string; claims: LiveClaim[] }
	| { state: "unverified"; graph_id: string; reason: string };

export const NOT_CHECKED: ClaimStatus = { state: "not-checked" };

function isHolder(value: unknown): value is { surface: string; session_id: string } {
	return typeof value === "object" && value !== null && "surface" in value && typeof value.surface === "string" && "session_id" in value && typeof value.session_id === "string";
}

function parseClaim(value: unknown): LiveClaim | null {
	if (typeof value !== "object" || value === null || !("node_id" in value) || typeof value.node_id !== "string") return null;
	const expires = "expires_at" in value ? value.expires_at : null;
	if (expires !== null && typeof expires !== "string") return null;
	const holder = "holder" in value ? value.holder : null;
	if (holder === null) return { node_id: value.node_id, holder: null, expires_at: expires };
	if (!isHolder(holder)) return null;
	return { node_id: value.node_id, holder: { surface: holder.surface, session_id: holder.session_id }, expires_at: expires };
}

/** The claims of a `GET /worktrees/claims` reply for `graphId`, or null when the body is not that shape (or names another graph). */
export function parseClaimsBody(body: unknown, graphId: string): LiveClaim[] | null {
	if (typeof body !== "object" || body === null || !("graph_id" in body) || body.graph_id !== graphId || !("claims" in body) || !Array.isArray(body.claims)) return null;
	const claims: LiveClaim[] = [];
	for (const item of body.claims) {
		const claim = parseClaim(item);
		if (claim === null) return null;
		claims.push(claim);
	}
	return claims;
}

/** Ask the server about `graphId` for a worktree and say what it means for removal. */
export async function claimStatus(graphId: string, lookup: ClaimsFn): Promise<ClaimStatus> {
	const answer = await lookup(graphId);
	if (!answer.ok) return { state: "unverified", graph_id: graphId, reason: answer.error };
	return answer.claims.length > 0 ? { state: "live", graph_id: graphId, claims: answer.claims } : { state: "none", graph_id: graphId };
}

/** Claim lookups in flight at once: prune's pool and the report's attribution share it. */
export const CLAIM_CONCURRENCY = 4;

/**
 * The one session a live claim status names, or null. Only a `live` status whose every claim has a holder, with
 * all holders carrying the same session id in the worktree registry's label shape (non-empty, at most 255 characters,
 * no control character — a swarm holder such as `A05@r1:ut-1` qualifies), attributes a worktree to a session. Two
 * sessions, a claim with no holder, an id the registry would refuse, or any other state is no attribution: a guess
 * here would put a worktree in the wrong session's conflict list.
 */
export function sessionOfClaims(status: ClaimStatus): string | null {
	if (status.state !== "live") return null;
	let session: string | null = null;
	for (const claim of status.claims) {
		if (claim.holder === null) return null;
		if (session !== null && claim.holder.session_id !== session) return null;
		session = claim.holder.session_id;
	}
	return session !== null && isWorktreeLabel(session) ? session : null;
}
