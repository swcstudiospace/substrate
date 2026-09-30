/**
 * The Postgres index.
 *
 * A cache over Notion and Linear so the brief does not call either API on every
 * prompt. It is written by ultrathink's kickoff/sync skills (via graph.register),
 * by hermes-linear-poller events and by substrate-dispatcher. It is never the
 * source of truth — a disagreement is resolved by refreshing from Notion/Linear.
 */
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { normalizeIdentifier } from "./event.ts";
import { needsReverification } from "./memory-policy.ts";
import {
	DERIVED_KEY_WINDOW_MS,
	IN_FLIGHT_TIMEOUT_MS,
	type ClaimResult,
	type MemoryStore,
	type NewMemoryEntry,
	type WriteRecord,
} from "./memory-write.ts";
import type {
	Actor,
	EdgeKind,
	GovernanceQueueRow,
	GraphEdge,
	GraphIndexRow,
	GraphNode,
	GraphStep,
	GraphView,
	MemoryEntry,
	MemoryWriteOutcome,
	NodeState,
	QuarantineReason,
	Surface,
} from "./types.ts";
import { EDGE_KINDS } from "./types.ts";
import {
	DEFAULT_LEASE_TTL_SECONDS,
	decideClaim,
	decideHeartbeat,
	decideRelease,
	leaseView,
	normalizeTtlSeconds,
	type ClaimDecision,
	type HeartbeatDecision,
	type LeaseHolder,
	type LeaseSnapshot,
	type LeaseView,
	type ReleaseDecision,
} from "./lease.ts";
import { redact } from "./redact.ts";

/**
 * Statuses that mean a graph is finished, so it is no longer "open" in a brief.
 * These are exactly Notion's `complete` status group on the Agent Task Graph —
 * a shorter list leaves Closed and Resolved graphs showing up as live work.
 */
const TERMINAL_STATUSES = ["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"];

/**
 * How many times a claim re-reads and retries after losing the compare-and-swap.
 *
 * More than one because the state it lost to may itself be a lease that has
 * since lapsed; bounded because a node that changes hands three times while one
 * agent is asking for it is contended, and the honest answer is the holder's name.
 */
const CLAIM_ATTEMPTS = 3;

export class IndexStore implements MemoryStore {
	private readonly sql: SQL;

	constructor(connectionString: string) {
		this.sql = new SQL(connectionString);
	}

	/** Idempotent DDL, run on boot. */
	async migrate(): Promise<void> {
		await this.sql`
			create table if not exists graph_index (
				graph_id          text primary key,
				notion_task_page  text,
				repo              text,
				branch            text,
				surface           text,
				status            text,
				pr_url            text,
				created           timestamptz default now(),
				updated           timestamptz default now()
			)`;
		await this.sql`
			create table if not exists graph_nodes (
				graph_id          text not null references graph_index(graph_id) on delete cascade,
				node_id           text not null,
				linear_issue_id   text,
				linear_identifier text,
				notion_page       text,
				state             text,
				claimed_by        text,
				claimed_at        timestamptz,
				claim_session     text,
				primary key (graph_id, node_id)
			)`;
		// Leases were added after the table shipped, so the columns are added rather
		// than declared: `create table if not exists` is a no-op against the Phase 0
		// table and would leave a live index without them.
		await this.sql`alter table graph_nodes add column if not exists lease_id text`;
		await this.sql`alter table graph_nodes add column if not exists lease_expires_at timestamptz`;
		await this.sql`alter table graph_nodes add column if not exists lease_heartbeat_at timestamptz`;
		await this.sql`alter table graph_nodes add column if not exists lease_epoch bigint not null default 0`;
		await this.sql`
			create table if not exists graph_edges (
				graph_id  text not null,
				from_node text not null,
				to_node   text not null,
				kind      text not null,
				primary key (graph_id, from_node, to_node, kind)
			)`;
		await this.sql`
			create table if not exists graph_steps (
				graph_id            text not null,
				node_id             text not null,
				step                int  not null,
				linear_sub_issue_id text,
				notion_page         text,
				state               text,
				primary key (graph_id, node_id, step)
			)`;
		await this.sql`
			create table if not exists memory_entries (
				id           text primary key,
				scope        text not null,
				kind         text not null,
				body         text not null,
				source_event text,
				writer       text not null,
				trust        text not null default 'agent-claimed',
				ttl          text not null default 'permanent',
				created      timestamptz not null default now()
			)`;

		// Governance columns, added rather than declared: `memory_entries` predates the
		// gate and is live, so every one of these has to be safe on a table that
		// already holds rows. The defaults are what an ungoverned Phase 0 entry
		// honestly was — one version, written by an agent, superseding nothing.
		await this.sql`
			alter table memory_entries
				add column if not exists subject         text,
				add column if not exists actor           text not null default 'agent',
				add column if not exists session_id      text,
				add column if not exists graph_id        text,
				add column if not exists repo            text,
				add column if not exists conflict_key    text,
				add column if not exists version         int not null default 1,
				add column if not exists supersedes      text,
				add column if not exists superseded_by   text,
				add column if not exists entry_hash      text,
				add column if not exists reverify_after  timestamptz,
				add column if not exists idempotency_key text`;

		// The idempotency ledger. One row per key ever spent; `claimed` is what makes
		// an abandoned in-flight claim recoverable and a derived key expire.
		await this.sql`
			create table if not exists memory_writes (
				idempotency_key text primary key,
				explicit        boolean not null default false,
				outcome         text not null,
				entry_id        text,
				entry_hash      text not null,
				request_hash    text,
				holder          text,
				claimed         timestamptz not null default now()
			)`;
		// Insurance for anyone who ran an earlier build of this migration, where the claim
		// had no fencing token.
		await this.sql`alter table memory_writes add column if not exists holder text`;
		await this.sql`alter table memory_writes add column if not exists request_hash text`;

		// Parked writes. Both tables hold the *redacted* body: a quarantined secret is
		// quarantined so a reviewer can see what was attempted, never so the substrate
		// can keep the credential.
		await this.sql`
			create table if not exists memory_quarantine (
				id           text primary key,
				scope        text not null,
				kind         text not null,
				body         text not null,
				subject      text,
				writer       text not null,
				source_event text,
				session_id   text,
				graph_id     text,
				repo         text,
				entry_hash   text not null,
				reason       text not null,
				detail       text not null,
				created      timestamptz not null default now()
			)`;
		await this.sql`
			create table if not exists memory_reviews (
				id              text primary key,
				scope           text not null,
				kind            text not null,
				body            text not null,
				subject         text,
				writer          text not null,
				source_event    text,
				session_id      text,
				graph_id        text,
				repo            text,
				ttl             text not null default 'permanent',
				entry_hash      text not null,
				reason          text not null,
				state           text not null default 'pending',
				entry_id        text,
				decided         timestamptz,
				decided_by      text,
				created         timestamptz not null default now()
			)`;

		await this.sql`create index if not exists graph_index_repo_idx on graph_index (repo)`;
		await this.sql`create index if not exists graph_nodes_claimed_idx on graph_nodes (claimed_by)`;
		await this.sql`create index if not exists graph_nodes_lease_idx on graph_nodes (lease_expires_at)`;
		await this.sql`create index if not exists graph_edges_graph_idx on graph_edges (graph_id)`;
		await this.sql`create index if not exists memory_scope_idx on memory_entries (scope)`;
		await this.sql`create index if not exists memory_fts_idx on memory_entries using gin (to_tsvector('english', body))`;
		// The identity the lww and versioned strategies resolve against: one standing
		// entry per conflict key, enforced rather than merely selected for.
		await this.sql`
			create unique index if not exists memory_standing_idx on memory_entries (conflict_key)
			where conflict_key is not null and superseded_by is null`;
		await this.sql`create index if not exists memory_reverify_idx on memory_entries (reverify_after)`;
		// What makes parking idempotent: a retried write finds its own parked row
		// instead of adding another for a reviewer to wade through.
		await this.sql`create unique index if not exists memory_quarantine_hash_idx on memory_quarantine (entry_hash)`;
		await this.sql`create unique index if not exists memory_reviews_hash_idx on memory_reviews (entry_hash, state)`;
	}

	// ── graph ──────────────────────────────────────────────────────────────────

	/** Upsert a whole graph. Idempotent by Graph ID, so a re-run never duplicates. */
	async registerGraph(plan: {
		graph_id: string;
		notion_task_page?: string | null;
		repo?: string | null;
		branch?: string | null;
		surface?: Surface | null;
		status?: string | null;
		pr_url?: string | null;
		nodes?: Array<Partial<GraphNode> & { node_id: string }>;
		steps?: Array<Partial<GraphStep> & { node_id: string; step: number }>;
		edges?: Array<{ from_node: string; to_node: string; kind: EdgeKind }>;
	}): Promise<GraphView> {
		await this.sql`
			insert into graph_index (graph_id, notion_task_page, repo, branch, surface, status, pr_url, updated)
			values (${plan.graph_id}, ${plan.notion_task_page ?? null}, ${plan.repo ?? null}, ${plan.branch ?? null},
			        ${plan.surface ?? null}, ${plan.status ?? null}, ${plan.pr_url ?? null}, now())
			on conflict (graph_id) do update set
				notion_task_page = coalesce(excluded.notion_task_page, graph_index.notion_task_page),
				repo             = coalesce(excluded.repo,             graph_index.repo),
				branch           = coalesce(excluded.branch,           graph_index.branch),
				surface          = coalesce(excluded.surface,          graph_index.surface),
				status           = coalesce(excluded.status,           graph_index.status),
				pr_url           = coalesce(excluded.pr_url,           graph_index.pr_url),
				updated          = now()`;

		for (const node of plan.nodes ?? []) {
			await this.sql`
				insert into graph_nodes (graph_id, node_id, linear_issue_id, linear_identifier, notion_page, state)
				values (${plan.graph_id}, ${node.node_id}, ${node.linear_issue_id ?? null},
				        ${node.linear_identifier ?? null}, ${node.notion_page ?? null}, ${node.state ?? null})
				on conflict (graph_id, node_id) do update set
					linear_issue_id   = coalesce(excluded.linear_issue_id,   graph_nodes.linear_issue_id),
					linear_identifier = coalesce(excluded.linear_identifier, graph_nodes.linear_identifier),
					notion_page       = coalesce(excluded.notion_page,       graph_nodes.notion_page),
					state             = coalesce(excluded.state,             graph_nodes.state)`;
		}

		for (const step of plan.steps ?? []) {
			await this.sql`
				insert into graph_steps (graph_id, node_id, step, linear_sub_issue_id, notion_page, state)
				values (${plan.graph_id}, ${step.node_id}, ${step.step}, ${step.linear_sub_issue_id ?? null},
				        ${step.notion_page ?? null}, ${step.state ?? null})
				on conflict (graph_id, node_id, step) do update set
					linear_sub_issue_id = coalesce(excluded.linear_sub_issue_id, graph_steps.linear_sub_issue_id),
					notion_page         = coalesce(excluded.notion_page,         graph_steps.notion_page),
					state               = coalesce(excluded.state,               graph_steps.state)`;
		}

		// Edges replace rather than accumulate, and only when the caller supplies
		// them. Nodes and steps upsert field by field because a partial register
		// should not erase what it does not mention — but an edge has no fields to
		// merge: it either holds or it does not. Insert-only meant a dependency
		// removed in Linear could never be removed here, and every later drift scan
		// went on reporting a held node as blocked by a relation that no longer
		// existed. So `edges` present is the authoritative set for this graph, and
		// `edges` absent leaves them untouched.
		if (plan.edges) {
			// An unknown kind is dropped rather than stored: `drift_scan` reads these
			// to decide whether a claim is premature, and a kind it cannot interpret
			// would be silently ignored there instead of here.
			const edges = plan.edges.filter((edge) => (EDGE_KINDS as readonly string[]).includes(edge.kind));
			// In one transaction, so a drift scan reading concurrently sees the old set
			// or the new one and never an empty moment in between — which would read as
			// "this held node has no dependencies" and suppress a real finding.
			await this.sql.begin(async (tx) => {
				// Serialised on the graph's own row first. Without it, two registers
				// racing on a graph whose edge set is empty both delete nothing and then
				// both insert, and the result is the *union* of two authoritative
				// replacements — so a dependency one caller removed stays live. A DELETE
				// that matches no row locks nothing, so the lock has to come from
				// somewhere that does exist, and the parent row always does by here.
				await tx`select graph_id from graph_index where graph_id = ${plan.graph_id} for update`;
				await tx`delete from graph_edges where graph_id = ${plan.graph_id}`;
				for (const edge of edges) {
					await tx`
						insert into graph_edges (graph_id, from_node, to_node, kind)
						values (${plan.graph_id}, ${edge.from_node}, ${edge.to_node}, ${edge.kind})
						on conflict (graph_id, from_node, to_node, kind) do nothing`;
				}
			});
		}

		const view = await this.getGraph(plan.graph_id);
		if (!view) throw new Error(`graph ${plan.graph_id} vanished after register`);
		return view;
	}

	async getGraph(graphId: string): Promise<GraphView | null> {
		const rows = (await this.sql`select * from graph_index where graph_id = ${graphId}`) as GraphIndexRow[];
		const row = rows[0];
		if (!row) return null;
		const nodes = ((await this.sql`
			select * from graph_nodes where graph_id = ${graphId} order by node_id`) as GraphNode[]).map(toNode);
		const steps = (await this.sql`
			select * from graph_steps where graph_id = ${graphId} order by node_id, step`) as GraphStep[];
		const edges = (await this.sql`
			select * from graph_edges where graph_id = ${graphId} order by from_node, to_node, kind`) as GraphEdge[];
		return { ...row, nodes, steps, edges };
	}

	/** Graphs in a repo that are not finished — what "who else is working here" means. */
	async openGraphs(repo: string, excludeGraphId?: string): Promise<GraphView[]> {
		const rows = (await this.sql`
			select * from graph_index
			where repo = ${repo}
			  and (status is null or status not in ${this.sql(TERMINAL_STATUSES)})
			  and (${excludeGraphId ?? null}::text is null or graph_id <> ${excludeGraphId ?? null})
			order by updated desc
			limit 10`) as GraphIndexRow[];
		const out: GraphView[] = [];
		for (const row of rows) {
			const nodes = ((await this.sql`
				select * from graph_nodes where graph_id = ${row.graph_id} order by node_id`) as GraphNode[]).map(toNode);
			out.push({ ...row, nodes, steps: [], edges: [] });
		}
		return out;
	}

	// ── leases ─────────────────────────────────────────────────────────────────

	private async node(graphId: string, nodeId: string): Promise<GraphNode> {
		const rows = (await this.sql`
			select * from graph_nodes where graph_id = ${graphId} and node_id = ${nodeId}`) as GraphNode[];
		const node = rows[0];
		if (!node) throw new Error(`unknown node ${graphId}/${nodeId}`);
		return toNode(node);
	}

	/**
	 * Take or extend the lease on a node.
	 *
	 * Two writes decide who holds a node, and both are one statement:
	 *
	 *   - a change of hold is guarded on `lease_epoch`, the epoch the decision was
	 *     taken against. Of two agents that both read a free node, the second one's
	 *     UPDATE matches no row, so it is told who won rather than overwriting them.
	 *   - the same statement re-checks expiry against **Postgres' clock**, not the
	 *     caller's. A caller with a fast clock must not be able to declare someone
	 *     else's live lease expired and take the node.
	 *
	 * A lost CAS is retried, because the state it lost to may itself have been a
	 * lease that has since lapsed; after {@link CLAIM_ATTEMPTS} it reports the
	 * holder it found. `lease.ts` holds the decision rules and their tests.
	 */
	async claimNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<{ claimed: boolean; node: GraphNode; lease: LeaseView; decision: ClaimDecision }> {
		const ttl = normalizeTtlSeconds(ttlSeconds);
		let node = await this.node(graphId, nodeId);

		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			const decision = decideClaim(leaseSnapshot(node), { surface, session_id: sessionId, ttl_seconds: ttl }, Date.now());

			if (!decision.granted) {
				// Re-read before reporting a refusal: the lease may have lapsed between
				// the read and the decision, and telling an agent it is blocked by a
				// holder that is already gone is the drift this whole feature removes.
				node = await this.node(graphId, nodeId);
				if (decideClaim(leaseSnapshot(node), { surface, session_id: sessionId, ttl_seconds: ttl }, Date.now()).granted) {
					continue;
				}
				return { claimed: false, node, lease: leaseView(leaseSnapshot(node)), decision };
			}

			const rows =
				decision.action === "renewed"
					? // A renewal proves it is still the holder *and* that the lease has not
						// lapsed since the decision was taken. Without the second half, a
						// holder that decided "renewed" a moment before its expiry could land
						// this UPDATE after it, reviving a lapsed lease under its old id and
						// epoch — and every other reader had already been told the node was
						// free. Matching no row sends the loop back to re-read, where the same
						// request becomes a `reclaimed` with a fresh id.
						((await this.sql`
							update graph_nodes set
								lease_heartbeat_at = now(),
								lease_expires_at   = now() + make_interval(secs => ${ttl}),
								claimed_at         = coalesce(claimed_at, now())
							where graph_id = ${graphId} and node_id = ${nodeId}
							  and lease_id = ${decision.lease_id}
							  and coalesce(lease_expires_at, claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS}))
							      > now()
							returning *`) as GraphNode[])
					: // A change of hold is the compare-and-swap: the epoch must be the one
						// the decision saw, and the lease must be free or lapsed by the
						// server's own clock.
						((await this.sql`
							update graph_nodes set
								lease_id           = ${decision.lease_id},
								lease_epoch        = ${decision.epoch},
								lease_heartbeat_at = now(),
								lease_expires_at   = now() + make_interval(secs => ${ttl}),
								claimed_by         = ${surface},
								claim_session      = ${sessionId},
								claimed_at         = now()
							where graph_id = ${graphId} and node_id = ${nodeId}
							  and lease_epoch = ${decision.observed_epoch}
							  and (
								claimed_by is null
								or coalesce(lease_expires_at, claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS}))
								   <= now()
							  )
							returning *`) as GraphNode[]);

			const updated = rows[0];
			if (updated) return { claimed: true, node: toNode(updated), lease: leaseView(leaseSnapshot(updated)), decision };

			// Lost the race, or the server disagreed about expiry. Look again.
			node = await this.node(graphId, nodeId);
		}

		return {
			claimed: false,
			node,
			lease: leaseView(leaseSnapshot(node)),
			decision: decideClaim(leaseSnapshot(node), { surface, session_id: sessionId, ttl_seconds: ttl }, Date.now()),
		};
	}

	/**
	 * Extend a lease this holder still holds.
	 *
	 * Fenced on `lease_id`: a holder whose lease lapsed and was taken over cannot
	 * extend the lease that replaced it, because the id it remembers is gone. The
	 * expiry predicate is the server's, for the same reason as in `claimNode`.
	 */
	async heartbeatNode(
		graphId: string,
		nodeId: string,
		leaseId: string,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<{ ok: boolean; node: GraphNode; lease: LeaseView; decision: HeartbeatDecision }> {
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const observed = await this.node(graphId, nodeId);
		const decision = decideHeartbeat(leaseSnapshot(observed), { lease_id: leaseId, ttl_seconds: ttl }, Date.now());
		if (!decision.ok) return { ok: false, node: observed, lease: leaseView(leaseSnapshot(observed)), decision };

		const rows = (await this.sql`
			update graph_nodes set
				lease_heartbeat_at = now(),
				lease_expires_at   = now() + make_interval(secs => ${ttl})
			where graph_id = ${graphId} and node_id = ${nodeId}
			  and lease_id = ${leaseId}
			  and coalesce(lease_expires_at, claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS})) > now()
			returning *`) as GraphNode[];

		const updated = rows[0];
		if (updated) return { ok: true, node: toNode(updated), lease: leaseView(leaseSnapshot(updated)), decision };

		// The statement matched nothing, so the lease went between the read and the
		// write. Report what is true now rather than the decision that is no longer.
		const fresh = await this.node(graphId, nodeId);
		return {
			ok: false,
			node: fresh,
			lease: leaseView(leaseSnapshot(fresh)),
			decision: decideHeartbeat(leaseSnapshot(fresh), { lease_id: leaseId, ttl_seconds: ttl }, Date.now()),
		};
	}

	/**
	 * Drop the lease on a node.
	 *
	 * `lease_id` fences it: a stale holder cannot release — or, through
	 * `completeNode`, close — a node that someone else has since claimed. `force`
	 * is the operator's lever for a holder that is gone, and is reported as a
	 * forced release rather than an ordinary one.
	 */
	async releaseNode(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean } = {},
		/** Written in the same statement as the release, for `completeNode`. */
		alsoSetState?: NodeState,
	): Promise<{ released: boolean; node: GraphNode; decision: ReleaseDecision }> {
		const observed = await this.node(graphId, nodeId);
		const decision = decideRelease(leaseSnapshot(observed), request, Date.now());
		if (!decision.ok) return { released: false, node: observed, decision };
		if (decision.action === "noop") return { released: true, node: observed, decision };

		// The epoch is left alone: it is monotonic per node, so the next claim cannot
		// reuse a token some stale holder still remembers.
		//
		// The state is written *here* rather than by a second statement, because a
		// second statement would not be fenced: between a release and an unguarded
		// `setNodeState`, another agent can claim the node that has just been freed,
		// and the state write would then mark that agent's live node completed.
		const rows = (await this.sql`
			update graph_nodes set
				claimed_by = null, claimed_at = null, claim_session = null,
				lease_id = null, lease_expires_at = null, lease_heartbeat_at = null,
				state = coalesce(${alsoSetState ?? null}, state)
			where graph_id = ${graphId} and node_id = ${nodeId}
			  and lease_epoch = ${decision.observed_epoch}
			  and (${decision.lease_id ?? null}::text is null or lease_id = ${decision.lease_id ?? null})
			returning *`) as GraphNode[];

		const updated = rows[0];
		if (updated) return { released: true, node: toNode(updated), decision };
		const fresh = await this.node(graphId, nodeId);
		return {
			released: false,
			node: fresh,
			decision: { ok: false, reason: "stale-lease", holder: leaseView(leaseSnapshot(fresh)).holder, observed_epoch: fresh.lease_epoch },
		};
	}

	/**
	 * Clear every lapsed lease and say whose they were.
	 *
	 * Expiry is already honoured lazily — every reader treats a lapsed lease as
	 * free — so this is not what makes the auto-release correct. It is what makes
	 * it *visible*: the rows stop showing a holder that is gone, and the caller
	 * gets a list it can turn into events, which is how another agent learns that
	 * a node it wanted is free again.
	 */
	async reapExpiredLeases(
		repo?: string | null,
	): Promise<Array<{ graph_id: string; node_id: string; linear_identifier: string | null; holder: LeaseHolder | null; lease_id: string | null; expired_at: string | null }>> {
		// The holders are read in a CTE rather than out of `returning`: an UPDATE's
		// RETURNING gives the *new* row, where `claimed_by` is already NULL, so the
		// reaper would clear the leases and then report that nobody held any of them.
		//
		// The update is also a compare-and-swap, on the exact lease *and the exact
		// expiry* each row was observed with. The lease id alone is not enough: a
		// heartbeat that commits between this statement's snapshot and its write
		// extends `lease_expires_at` without touching `lease_id` or `claimed_by`, so
		// a CAS on those two would let the reaper clear a lease that had just been
		// renewed — taking the node off a holder that is alive and doing the work.
		// A heartbeat always moves the expiry, so fencing on it is what makes this
		// safe, and expiry racing the claim it exists to enable is ruled out the same
		// way.
		const rows = (await this.sql`
			with expiring as (
				select graph_id, node_id, linear_identifier, claimed_by, claim_session, lease_id,
				       lease_expires_at, lease_heartbeat_at
				from graph_nodes
				where claimed_by is not null
				  and coalesce(lease_expires_at, claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS})) <= now()
				  and (${repo ?? null}::text is null
				       or graph_id in (select graph_id from graph_index where repo = ${repo ?? null}))
			),
			cleared as (
				update graph_nodes n set
					claimed_by = null, claimed_at = null, claim_session = null,
					lease_id = null, lease_expires_at = null, lease_heartbeat_at = null
				from expiring e
				where n.graph_id = e.graph_id and n.node_id = e.node_id
				  and n.lease_id is not distinct from e.lease_id
				  and n.claimed_by is not distinct from e.claimed_by
				  and n.lease_expires_at is not distinct from e.lease_expires_at
				  and n.lease_heartbeat_at is not distinct from e.lease_heartbeat_at
				returning n.graph_id, n.node_id
			)
			select e.* from expiring e
			join cleared c on c.graph_id = e.graph_id and c.node_id = e.node_id`) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			graph_id: String(row.graph_id),
			node_id: String(row.node_id),
			linear_identifier: row.linear_identifier === null ? null : String(row.linear_identifier),
			holder: row.claimed_by ? { surface: row.claimed_by as Surface, session_id: String(row.claim_session ?? "") } : null,
			lease_id: row.lease_id === null ? null : String(row.lease_id),
			expired_at: isoOrNull(row.lease_expires_at),
		}));
	}

	/**
	 * Make a lease lapse now, leaving its holder recorded.
	 *
	 * Deliberately weaker than a forced release, and more useful for the case it
	 * exists for: an operator who knows a session is dead hands the node back
	 * through the *normal* expiry path, so `reapExpiredLeases` clears it and emits
	 * the warning that names who was evicted, rather than the node going quiet.
	 *
	 * It is also how the live lease tests reach expiry: `now()` is the server's,
	 * and no caller can talk the server out of it, so a test cannot fake a lapse
	 * from outside — it would have to wait out a whole TTL.
	 */
	async expireLease(graphId: string, nodeId: string): Promise<void> {
		await this.sql`
			update graph_nodes set lease_expires_at = now()
			where graph_id = ${graphId} and node_id = ${nodeId} and claimed_by is not null`;
	}

	/** Every node in this repo that something holds — the claims a drift scan compares against. */
	async claimedNodesForRepo(repo: string): Promise<Array<GraphNode & { repo: string | null; branch: string | null }>> {
		const rows = (await this.sql`
			select n.*, g.repo, g.branch
			from graph_nodes n join graph_index g using (graph_id)
			where g.repo = ${repo} and n.claimed_by is not null
			order by n.graph_id, n.node_id`) as Array<GraphNode & { repo: string | null; branch: string | null }>;
		return rows.map((row) => ({ ...row, ...toNode(row) }));
	}

	/** Every node in this repo, claimed or not, for the edge checks a drift scan runs. */
	async nodesForRepo(repo: string): Promise<GraphNode[]> {
		return ((await this.sql`
			select n.* from graph_nodes n join graph_index g using (graph_id)
			where g.repo = ${repo}
			order by n.graph_id, n.node_id`) as GraphNode[]).map(toNode);
	}

	async edgesForRepo(repo: string): Promise<GraphEdge[]> {
		return (await this.sql`
			select e.* from graph_edges e join graph_index g using (graph_id)
			where g.repo = ${repo}
			order by e.graph_id, e.from_node`) as GraphEdge[];
	}

	async setNodeState(graphId: string, nodeId: string, state: NodeState): Promise<void> {
		await this.sql`update graph_nodes set state = ${state} where graph_id = ${graphId} and node_id = ${nodeId}`;
	}

	async setGraphStatus(graphId: string, status: string, prUrl?: string | null): Promise<void> {
		await this.sql`
			update graph_index set status = ${status}, pr_url = coalesce(${prUrl ?? null}, pr_url), updated = now()
			where graph_id = ${graphId}`;
	}

	// ── memory ─────────────────────────────────────────────────────────────────
	//
	// Every write below is reached through `governMemoryWrite` — the gate in
	// `memory-write.ts` decides RBAC, quarantine, idempotency and conflicts, and
	// these methods are the thin, boring half. There is deliberately no ungoverned
	// `writeMemory` here any more: the reason the gate cannot be forgotten is that
	// there is no second door past it, the same argument that keeps the ledger
	// client inside its own file. (Naming that client here would trip the lock's
	// other rule: a file in this package that both says its name and sends a
	// statement is how a second SQL door onto the ledger would look.)

	/**
	 * Claim an idempotency key, or report the record that already holds it.
	 *
	 * The only place in the gate where two concurrent writes have to be ordered, so it
	 * runs as a transaction over a locked row rather than as one clever statement: the
	 * decision has three cases and a reviewer has to be able to check them.
	 *
	 * The claim is handed over when the key is fresh; when the previous attempt was
	 * refused, so nothing was written and re-asking is allowed; when an in-flight claim
	 * was abandoned; or when a derived key's dedup window has passed. An `accepted`
	 * explicit key is never handed over — that is what "exactly once" means.
	 *
	 * Every hand-over mints a new `holder`, and `finishWrite` and `releaseWrite` match
	 * on it. Without that, an attempt that merely ran slow past the in-flight timeout
	 * could come back and finish — or delete — the claim that replaced it.
	 */
	async claimWrite(input: {
		key: string;
		explicit: boolean;
		entryHash: string;
		requestHash: string;
		entryId: string;
	}): Promise<ClaimResult> {
		const holder = `hold_${randomUUID().replace(/-/g, "")}`;
		const inFlightSeconds = IN_FLIGHT_TIMEOUT_MS / 1000;
		const derivedSeconds = DERIVED_KEY_WINDOW_MS / 1000;

		return (await this.sql.begin(async (tx: SQL) => {
			const fresh = (await tx`
				insert into memory_writes (
					idempotency_key, explicit, outcome, entry_id, entry_hash, request_hash, holder, claimed)
				values (${input.key}, ${input.explicit}, 'in-flight', ${input.entryId}, ${input.entryHash},
				        ${input.requestHash}, ${holder}, now())
				on conflict (idempotency_key) do nothing
				returning idempotency_key`) as Array<Record<string, unknown>>;
			if (fresh.length > 0) return { claimed: true as const, holder, tookOverFrom: null };

			// The key is held. Lock the row before judging it, so two retries cannot both
			// conclude that one abandoned claim is theirs. Staleness is computed by the
			// database, against its own clock — the server's may not agree.
			const rows = (await tx`
				select outcome, explicit, entry_id, entry_hash, request_hash,
				       claimed < now() - make_interval(secs => ${inFlightSeconds}::float8) as in_flight_stale,
				       claimed < now() - make_interval(secs => ${derivedSeconds}::float8) as derived_stale
				from memory_writes where idempotency_key = ${input.key}
				for update`) as Array<Record<string, unknown>>;
			const row = rows[0];
			// It cleared between the two statements: nothing holds the key, so treat it as
			// ours rather than reporting a holder that is not there.
			if (!row) return { claimed: true as const, holder, tookOverFrom: null };

			const outcome = String(row.outcome);
			const inFlight = outcome === "in-flight";
			const priorEntry = row.entry_id === null || row.entry_id === undefined ? null : String(row.entry_id);

			// What the claim's reservation actually holds — nothing, while the row it names is
			// still only reserved.
			//
			// Read under the lock the hand-over already takes, which is what makes it a fact
			// rather than a guess: `insertEntry` locks this same row before writing its entry,
			// so the reserved row either exists by the time we look or belongs to an attempt
			// that is about to find itself fenced out. Only an in-flight claim can pass its
			// reservation on, so only that case pays for the read.
			const reserved =
				inFlight && priorEntry
					? ((await tx`select entry_hash from memory_entries where id = ${priorEntry}`) as Array<
							Record<string, unknown>
						>)
					: [];
			const reservedHash = optional(reserved[0]?.entry_hash);

			// Whether the held claim was taken out for *this* request.
			//
			// It gates the in-flight hand-over alone, because that is the one hand-over that
			// keeps the previous attempt's `entry_id`. Handing that reservation to a different
			// request, while replacing the hashes with the new one's, makes the record say a
			// row holding A's content is what this key spent itself on B for: the successor
			// recovers A, and B's next retry reads `accepted` off that record and is told its
			// own write is `verified_persisted`. It never was.
			//
			// So a key spent on a different ask is spent — the same answer `replay` gives for a
			// finished record. Whether the attempt that spent it acknowledged itself or died
			// still holding the key does not change what the key promised.
			const heldFor = optional(row.request_hash);
			const sameAsk = heldFor !== undefined && heldFor === input.requestHash;

			// A record written before `request_hash` existed records no identity, and no
			// identity is *unknown*, not "matches whoever asks". Reading it as a wildcard was
			// how a legacy claim stranded the write that made it: any request could take the
			// claim over, stamp its own hashes on it and keep the reservation; the gate then
			// refused to hand back the row that reservation named — rightly, it was someone
			// else's — and left the rewritten claim in flight. The write that committed that
			// row came back to a key spent on another ask, was told `idempotency.reused`, and
			// had no way left to reach its own entry.
			//
			// So an unidentified claim is handed over only where the hand-over can strand
			// nothing: its reservation names no row yet, or names one already holding this
			// write's content — which is the write that made it, retrying.
			const reservationIsOurs = reservedHash === undefined || reservedHash === input.entryHash;
			const legacyRecoverable = heldFor === undefined && reservationIsOurs;
			const takeable =
				(outcome !== "accepted" && !inFlight) ||
				// `reservationIsOurs` is redundant beside `sameAsk` — one request has one
				// content hash — and kept because it is the invariant the inherited `entry_id`
				// below actually depends on, which a record left inconsistent by an older
				// hand-over would otherwise break silently.
				(inFlight && row.in_flight_stale === true && (sameAsk || legacyRecoverable) && reservationIsOurs) ||
				(outcome === "accepted" && row.explicit !== true && row.derived_stale === true);

			if (!takeable) {
				return {
					claimed: false as const,
					existing: {
						idempotency_key: input.key,
						explicit: row.explicit === true,
						outcome: outcome as WriteRecord["outcome"],
						entry_id: row.entry_id === null || row.entry_id === undefined ? null : String(row.entry_id),
						entry_hash: String(row.entry_hash),
						request_hash: optional(row.request_hash) ?? null,
					},
				};
			}

			// Only an abandoned *in-flight* claim can have left a row behind unacknowledged.
			// A finished attempt recorded its outcome, and an aged-out derived key belongs to
			// a write we are deliberately allowing to happen again — so its `entry_id` names
			// a row that is still in force and must not be reused.
			const tookOverFrom = inFlight ? priorEntry : null;

			await tx`
				update memory_writes set
					outcome    = 'in-flight',
					explicit   = ${input.explicit},
					entry_hash   = ${input.entryHash},
					request_hash = ${input.requestHash},
					-- An in-flight claim's reservation is KEPT, not replaced. It may point at a
					-- row that already exists, and the successor has to resolve that before the
					-- pointer can be thrown away; overwriting it here would orphan the row and
					-- the retry after this one would duplicate it. Safe to inherit only because
					-- the tests above let this hand-over through for a retry of the same request,
					-- or for one whose content the reservation already holds: either way the
					-- reserved row is this write's own, never a stranger's.
					entry_id   = ${tookOverFrom ?? input.entryId},
					holder     = ${holder},
					claimed    = now()
				where idempotency_key = ${input.key}`;

			return { claimed: true as const, holder, tookOverFrom };
		})) as ClaimResult;
	}

	/** Conditional on `holder`: a claim that was taken over is no longer this one's to finish. */
	async finishWrite(key: string, holder: string, outcome: MemoryWriteOutcome, entryId: string | null): Promise<void> {
		await this.sql`
			update memory_writes set outcome = ${outcome}, entry_id = ${entryId}, claimed = now()
			where idempotency_key = ${key} and holder = ${holder}`;
	}

	/**
	 * Hand a taken-over claim back to the write that reserved it.
	 *
	 * The counterpart to `releaseWrite` for a claim that carries a reservation: deleting
	 * the record would throw the pointer away with it, and the owner's retry would then
	 * find a fresh key, look for nothing, and insert a second copy of the row it already
	 * committed. So the record stays, restored to what the reservation says — that row,
	 * its content, and an identity this attempt has no right to speak for.
	 *
	 * The holder is rotated to one nobody holds, and `claimed` backdated past the
	 * in-flight timeout, so the claim is takeable again immediately rather than after
	 * another wait. Conditional on `holder`, like every other statement about a claim.
	 */
	async restoreWrite(key: string, holder: string, reserved: { entryId: string; entryHash: string }): Promise<void> {
		const staleSeconds = IN_FLIGHT_TIMEOUT_MS / 1000 + 1;
		await this.sql`
			update memory_writes set
				outcome      = 'in-flight',
				entry_id     = ${reserved.entryId},
				entry_hash   = ${reserved.entryHash},
				request_hash = null,
				holder       = ${`hold_${randomUUID().replace(/-/g, "")}`},
				claimed      = now() - make_interval(secs => ${staleSeconds}::float8)
			where idempotency_key = ${key} and holder = ${holder} and outcome = 'in-flight'`;
	}

	/** Only an in-flight claim this holder still owns — a finished record is the audit trail. */
	async releaseWrite(key: string, holder: string): Promise<void> {
		await this.sql`
			delete from memory_writes
			where idempotency_key = ${key} and holder = ${holder} and outcome = 'in-flight'`;
	}

	async standingEntry(conflictKey: string): Promise<MemoryEntry | null> {
		const rows = (await this.sql`
			select * from memory_entries
			where conflict_key = ${conflictKey} and superseded_by is null
			order by version desc, created desc
			limit 1`) as Array<Record<string, unknown>>;
		const row = rows[0];
		return row ? toMemoryEntry(row) : null;
	}

	/**
	 * Insert an entry, retiring the one it supersedes in the same transaction.
	 *
	 * `memory_standing_idx` makes "one entry in force per conflict key" a database
	 * invariant rather than a convention, which means the retire and the insert
	 * cannot be two statements: either order leaves a window where the invariant is
	 * false. So they are one.
	 *
	 * The claim check is inside that same transaction, and takes the same row lock
	 * `claimWrite` takes. That is what makes the fencing real rather than advisory: a
	 * takeover and an insert under the one key serialise on the `memory_writes` row,
	 * so either the takeover goes first and this insert finds a stranger's holder and
	 * writes nothing, or this insert goes first and the takeover sees the entry it
	 * reserved and recovers it. Checking ownership before the transaction would leave
	 * exactly the window the fencing token exists to close.
	 */
	async insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" }> {
		return (await this.sql.begin(async (tx: SQL) => {
			const held = (await tx`
				select holder, outcome from memory_writes where idempotency_key = ${claim.key}
				for update`) as Array<Record<string, unknown>>;
			const owner = held[0];
			// No row means the claim was released; a different holder means it was taken
			// over. Both say the same thing: this attempt is no longer the one writing.
			if (!owner || owner.holder !== claim.holder || String(owner.outcome) !== "in-flight") {
				return { ok: false as const, reason: "claim-lost" as const };
			}
			if (row.supersedes) {
				const retired = (await tx`
					update memory_entries set superseded_by = ${row.id}
					where id = ${row.supersedes} and superseded_by is null
					returning id`) as Array<Record<string, unknown>>;
				// Somebody else replaced it while this write was in flight. Rolling back is
				// the honest answer; the gate turns it into a conflict.
				if (retired.length === 0) return { ok: false as const, reason: "standing-moved" as const };
			}
			const inserted = (await tx`
				insert into memory_entries (
					id, scope, kind, body, subject, source_event, writer, actor, trust, ttl,
					session_id, graph_id, repo, conflict_key, version, supersedes, entry_hash,
					reverify_after, idempotency_key)
				values (
					${row.id}, ${row.scope}, ${row.kind}, ${redact(row.text)}, ${row.subject}, ${row.source_event},
					${row.writer}, ${row.actor}, ${row.trust}, ${row.ttl}, ${row.session_id}, ${row.graph_id},
					${row.repo}, ${row.conflict_key}, ${row.version}, ${row.supersedes}, ${row.entry_hash},
					${row.reverify_after}, ${row.idempotency_key})
				returning *`) as Array<Record<string, unknown>>;
			return { ok: true as const, entry: toMemoryEntry(inserted[0]!) };
		})) as { ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" };
	}

	async readEntry(id: string): Promise<MemoryEntry | null> {
		const rows = (await this.sql`
			select * from memory_entries where id = ${id}`) as Array<
			Record<string, unknown>
		>;
		const row = rows[0];
		return row ? toMemoryEntry(row) : null;
	}

	/** Park a classified write. Idempotent on the content hash. */
	async quarantineEntry(row: NewMemoryEntry & { reason: QuarantineReason; detail: string }): Promise<string> {
		const inserted = (await this.sql`
			insert into memory_quarantine (
				id, scope, kind, body, subject, writer, source_event, session_id, graph_id, repo,
				entry_hash, reason, detail)
			values (
				${row.id}, ${row.scope}, ${row.kind}, ${redact(row.text)}, ${row.subject}, ${row.writer},
				${row.source_event}, ${row.session_id}, ${row.graph_id}, ${row.repo}, ${row.entry_hash},
				${row.reason}, ${row.detail})
			on conflict (entry_hash) do nothing
			returning id`) as Array<Record<string, unknown>>;
		if (inserted[0]) return String(inserted[0].id);
		const existing = (await this.sql`
			select id from memory_quarantine where entry_hash = ${row.entry_hash}`) as Array<Record<string, unknown>>;
		return existing[0] ? String(existing[0].id) : row.id;
	}

	/** Park a proposal for review. Idempotent on the content hash while pending. */
	async enqueueReview(row: NewMemoryEntry & { reason: string }): Promise<string> {
		const inserted = (await this.sql`
			insert into memory_reviews (
				id, scope, kind, body, subject, writer, source_event, session_id, graph_id, repo, ttl,
				entry_hash, reason, state)
			values (
				${row.id}, ${row.scope}, ${row.kind}, ${redact(row.text)}, ${row.subject}, ${row.writer},
				${row.source_event}, ${row.session_id}, ${row.graph_id}, ${row.repo}, ${row.ttl},
				${row.entry_hash}, ${row.reason}, 'pending')
			on conflict (entry_hash, state) do nothing
			returning id`) as Array<Record<string, unknown>>;
		if (inserted[0]) return String(inserted[0].id);
		const existing = (await this.sql`
			select id from memory_reviews where entry_hash = ${row.entry_hash} and state = 'pending'`) as Array<
			Record<string, unknown>
		>;
		return existing[0] ? String(existing[0].id) : row.id;
	}

	/** Close the loop: a reviewed write that landed resolves the proposal it came from. */
	async releaseReviews(entryHash: string, entryId: string, decidedBy: string): Promise<number> {
		const rows = (await this.sql`
			update memory_reviews
			set state = 'approved', entry_id = ${entryId}, decided = now(), decided_by = ${decidedBy}
			where entry_hash = ${entryHash} and state = 'pending'
			returning id`) as Array<Record<string, unknown>>;
		return rows.length;
	}

	/**
	 * What a reviewer has to look at. Nothing here is briefed or searchable.
	 *
	 * Returns the bodies; withholding them from an unauthorised caller is the
	 * service's job, because whether a caller holds reviewer authority is not
	 * something the index knows.
	 */
	async governanceQueue(limit = 20): Promise<{ reviews: GovernanceQueueRow[]; quarantined: GovernanceQueueRow[] }> {
		const reviews = (await this.sql`
			select id, scope, kind, body, subject, writer, reason, created
			from memory_reviews where state = 'pending'
			order by created desc limit ${limit}`) as Array<Record<string, unknown>>;
		const quarantined = (await this.sql`
			select id, scope, kind, body, subject, writer, reason, detail, created
			from memory_quarantine
			order by created desc limit ${limit}`) as Array<Record<string, unknown>>;
		return { reviews: reviews.map(toQueueRow), quarantined: quarantined.map(toQueueRow) };
	}

	/**
	 * Full-text search. Superseded entries are excluded by default: an agent asking
	 * what is true wants what is in force, not every version of it. A decision log is
	 * still readable — `includeSuperseded` is how you read it.
	 */
	async searchMemory(query: string, scope?: string, limit = 20, includeSuperseded = false): Promise<MemoryEntry[]> {
		const rows = (await this.sql`
			select *
			from memory_entries
			where (${scope ?? null}::text is null or scope = ${scope ?? null})
			  and (${includeSuperseded}::boolean or superseded_by is null)
			  and (${query ?? ""} = '' or to_tsvector('english', body) @@ plainto_tsquery('english', ${query}))
			order by created desc
			limit ${limit}`) as Array<Record<string, unknown>>;
		return rows.map(toMemoryEntry);
	}

	/**
	 * Entries relevant to a brief: this graph, this repo, and globals.
	 *
	 * The scope strings are built with `normalizeIdentifier`, because the gate stores
	 * them that way — querying the raw spelling would match nothing, the same trap
	 * `emit` fell into with session ids.
	 */
	async memoryForBrief(repo: string | null, graphId: string | null, limit = 10): Promise<MemoryEntry[]> {
		const normalizedRepo = normalizeIdentifier(repo);
		const normalizedGraph = normalizeIdentifier(graphId);
		const scopes = [
			"global",
			...(normalizedRepo ? [`repo:${normalizedRepo}`] : []),
			...(normalizedGraph ? [`graph:${normalizedGraph}`] : []),
		];
		// `in ${sql(array)}` is the form Bun's SQL expands to a value list. Passing
		// the array straight to `any()` stringifies it into a malformed array literal.
		const rows = (await this.sql`
			select *
			from memory_entries
			where scope in ${this.sql(scopes)}
			  and superseded_by is null
			order by created desc
			limit ${limit}`) as Array<Record<string, unknown>>;
		return rows.map(toMemoryEntry);
	}

	async ping(): Promise<boolean> {
		try {
			await this.sql`select 1`;
			return true;
		} catch {
			return false;
		}
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}

/** Postgres hands back `Date`; every surface that reports a lease wants ISO. */
function isoOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	return String(value);
}

/**
 * A node row as the rest of the substrate types it.
 *
 * Two driver quirks are corrected here rather than at each reader. Postgres
 * hands back a BIGINT as a *string*, so `lease_epoch` would arrive as `"1"` —
 * which serialises into the MCP reply beside a numeric `lease.epoch` and reads
 * as two different values for one thing. And timestamps arrive as `Date`, which
 * every caller either has to normalise or accidentally compares as an object.
 */
function toNode(row: GraphNode): GraphNode {
	return {
		...row,
		claimed_at: isoOrNull(row.claimed_at),
		lease_expires_at: isoOrNull(row.lease_expires_at),
		lease_heartbeat_at: isoOrNull(row.lease_heartbeat_at),
		lease_epoch: Number(row.lease_epoch ?? 0),
	};
}

/** The lease columns of a node row, in the shape `lease.ts` reasons about. */
export function leaseSnapshot(node: GraphNode): LeaseSnapshot {
	return {
		lease_id: node.lease_id ?? null,
		surface: node.claimed_by ?? null,
		session_id: node.claim_session ?? null,
		claimed_at: node.claimed_at ?? null,
		heartbeat_at: node.lease_heartbeat_at ?? null,
		expires_at: node.lease_expires_at ?? null,
		// A row written before the column existed reads as NULL through the driver.
		epoch: Number(node.lease_epoch ?? 0),
	};
}

/** Absent, null and the empty string all mean "not set" on the way out of Postgres. */
function optional(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	const text = value instanceof Date ? value.toISOString() : String(value);
	return text.length > 0 ? text : undefined;
}

function timestamp(value: unknown): string {
	return value instanceof Date ? value.toISOString() : String(value);
}

function toQueueRow(row: Record<string, unknown>): GovernanceQueueRow {
	return {
		id: String(row.id),
		scope: String(row.scope),
		kind: row.kind as MemoryEntry["kind"],
		writer: String(row.writer),
		reason: String(row.reason),
		created: timestamp(row.created),
		text: String(row.body),
		...(optional(row.subject) ? { subject: optional(row.subject) } : {}),
		...(optional(row.detail) ? { detail: optional(row.detail) } : {}),
	};
}

export function toMemoryEntry(row: Record<string, unknown>, now = Date.now()): MemoryEntry {
	const reverifyAfter = optional(row.reverify_after);
	return {
		id: String(row.id),
		scope: String(row.scope),
		kind: row.kind as MemoryEntry["kind"],
		text: String(row.body),
		subject: optional(row.subject),
		source_event: optional(row.source_event),
		session_id: optional(row.session_id),
		graph_id: optional(row.graph_id),
		repo: optional(row.repo),
		writer: String(row.writer),
		actor: (row.actor === "human" ? "human" : "agent") as Actor,
		trust: row.trust as MemoryEntry["trust"],
		ttl: String(row.ttl),
		created: timestamp(row.created),
		// `version` predates the gate on rows written in Phase 0, where the column
		// default backfilled it to 1 — which is what those entries honestly were.
		version: Number(row.version ?? 1),
		supersedes: optional(row.supersedes),
		superseded_by: optional(row.superseded_by),
		entry_hash: String(row.entry_hash ?? ""),
		...(reverifyAfter ? { reverify_after: reverifyAfter } : {}),
		// Derived, not stored: an entry decays where it sits, without a sweeper job.
		needs_reverification: needsReverification(reverifyAfter, now),
		idempotency_key: optional(row.idempotency_key),
	};
}
