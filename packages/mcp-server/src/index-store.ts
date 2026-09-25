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
import type {
	GraphIndexRow,
	GraphNode,
	GraphStep,
	GraphView,
	MemoryEntry,
	MemoryEntryInput,
	NodeState,
	Surface,
} from "./types.ts";
import { redact } from "./redact.ts";

/**
 * Statuses that mean a graph is finished, so it is no longer "open" in a brief.
 * These are exactly Notion's `complete` status group on the Agent Task Graph —
 * a shorter list leaves Closed and Resolved graphs showing up as live work.
 */
const TERMINAL_STATUSES = ["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"];

/** A node joined to its graph's repo, branch and status — what a Linear → node lookup returns. */
export type LinearNodeMatch = GraphNode & { repo: string | null; branch: string | null; graph_status: string | null };

export class IndexStore {
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
		await this.sql`create index if not exists graph_index_repo_idx on graph_index (repo)`;
		await this.sql`create index if not exists graph_nodes_claimed_idx on graph_nodes (claimed_by)`;
		await this.sql`create index if not exists memory_scope_idx on memory_entries (scope)`;
		await this.sql`create index if not exists memory_fts_idx on memory_entries using gin (to_tsvector('english', body))`;
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

		const view = await this.getGraph(plan.graph_id);
		if (!view) throw new Error(`graph ${plan.graph_id} vanished after register`);
		return view;
	}

	async getGraph(graphId: string): Promise<GraphView | null> {
		const rows = (await this.sql`select * from graph_index where graph_id = ${graphId}`) as GraphIndexRow[];
		const row = rows[0];
		if (!row) return null;
		const nodes = (await this.sql`
			select * from graph_nodes where graph_id = ${graphId} order by node_id`) as GraphNode[];
		const steps = (await this.sql`
			select * from graph_steps where graph_id = ${graphId} order by node_id, step`) as GraphStep[];
		return { ...row, nodes, steps };
	}

	/**
	 * Nodes that own a Linear issue, by UUID first and then by identifier (backfilled
	 * nodes carry only the identifier). At most two rows: the caller only needs to
	 * tell one match from an ambiguous one.
	 */
	async findNodesByLinear(ref: { linearIssueId?: string; linearIdentifier?: string }): Promise<LinearNodeMatch[]> {
		if (ref.linearIssueId) {
			const rows = (await this.sql`
				select n.*, g.repo, g.branch, g.status as graph_status
				from graph_nodes n join graph_index g on g.graph_id = n.graph_id
				where n.linear_issue_id = ${ref.linearIssueId}
				limit 2`) as LinearNodeMatch[];
			if (rows.length > 0) return rows;
		}
		if (!ref.linearIdentifier) return [];
		return (await this.sql`
			select n.*, g.repo, g.branch, g.status as graph_status
			from graph_nodes n join graph_index g on g.graph_id = n.graph_id
			where n.linear_identifier = ${ref.linearIdentifier}
			limit 2`) as LinearNodeMatch[];
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
			const nodes = (await this.sql`
				select * from graph_nodes where graph_id = ${row.graph_id} order by node_id`) as GraphNode[];
			out.push({ ...row, nodes, steps: [] });
		}
		return out;
	}

	/**
	 * Claim a node for a surface. Returns the existing claim instead of
	 * overwriting it, so two agents racing for the same node both learn the truth.
	 */
	async claimNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
	): Promise<{ claimed: boolean; node: GraphNode }> {
		const rows = (await this.sql`
			update graph_nodes
			set claimed_by = ${surface}, claimed_at = now(), claim_session = ${sessionId}
			where graph_id = ${graphId} and node_id = ${nodeId}
			  and (claimed_by is null or claimed_by = ${surface})
			returning *`) as GraphNode[];
		const claimed = rows[0];
		if (claimed) return { claimed: true, node: claimed };

		const existing = (await this.sql`
			select * from graph_nodes where graph_id = ${graphId} and node_id = ${nodeId}`) as GraphNode[];
		const node = existing[0];
		if (!node) throw new Error(`unknown node ${graphId}/${nodeId}`);
		return { claimed: false, node };
	}

	/**
	 * Clear a claim only if it is still this surface's and session's: the
	 * caller's ownership check read an earlier snapshot, and a re-claim may have
	 * landed since. Returns the rows released — 0 means the claim changed.
	 */
	async releaseNode(graphId: string, nodeId: string, surface: Surface, sessionId: string): Promise<number> {
		const rows = (await this.sql`
			update graph_nodes set claimed_by = null, claimed_at = null, claim_session = null
			where graph_id = ${graphId} and node_id = ${nodeId}
			  and claimed_by = ${surface} and claim_session = ${sessionId}
			returning node_id`) as Array<{ node_id: string }>;
		return rows.length;
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

	async writeMemory(entry: MemoryEntryInput): Promise<MemoryEntry> {
		const id = `mem_${randomUUID().replace(/-/g, "")}`;
		const rows = (await this.sql`
			insert into memory_entries (id, scope, kind, body, source_event, writer, trust, ttl)
			values (${id}, ${entry.scope}, ${entry.kind}, ${redact(entry.text)}, ${entry.source_event ?? null},
			        ${entry.writer}, ${entry.trust ?? "agent-claimed"}, ${entry.ttl ?? "permanent"})
			returning id, scope, kind, body, source_event, writer, trust, ttl, created`) as Array<
			Record<string, unknown>
		>;
		return toMemoryEntry(rows[0]!);
	}

	async searchMemory(query: string, scope?: string, limit = 20): Promise<MemoryEntry[]> {
		const rows = (await this.sql`
			select id, scope, kind, body, source_event, writer, trust, ttl, created
			from memory_entries
			where (${scope ?? null}::text is null or scope = ${scope ?? null})
			  and (${query ?? ""} = '' or to_tsvector('english', body) @@ plainto_tsquery('english', ${query}))
			order by created desc
			limit ${limit}`) as Array<Record<string, unknown>>;
		return rows.map(toMemoryEntry);
	}

	/** Entries relevant to a brief: this graph, this repo, and globals. */
	async memoryForBrief(repo: string | null, graphId: string | null, limit = 10): Promise<MemoryEntry[]> {
		const scopes = ["global", ...(repo ? [`repo:${repo}`] : []), ...(graphId ? [`graph:${graphId}`] : [])];
		// `in ${sql(array)}` is the form Bun's SQL expands to a value list. Passing
		// the array straight to `any()` stringifies it into a malformed array literal.
		const rows = (await this.sql`
			select id, scope, kind, body, source_event, writer, trust, ttl, created
			from memory_entries
			where scope in ${this.sql(scopes)}
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

function toMemoryEntry(row: Record<string, unknown>): MemoryEntry {
	return {
		id: String(row.id),
		scope: String(row.scope),
		kind: row.kind as MemoryEntry["kind"],
		text: String(row.body),
		source_event: row.source_event === null ? undefined : String(row.source_event),
		writer: String(row.writer),
		trust: row.trust as MemoryEntry["trust"],
		ttl: String(row.ttl),
		created: row.created instanceof Date ? row.created.toISOString() : String(row.created),
	};
}
