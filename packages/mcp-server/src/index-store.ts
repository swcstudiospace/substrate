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
	GovernanceQueueRow,
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
import { redact } from "./redact.ts";

/**
 * Statuses that mean a graph is finished, so it is no longer "open" in a brief.
 * These are exactly Notion's `complete` status group on the Agent Task Graph —
 * a shorter list leaves Closed and Resolved graphs showing up as live work.
 */
const TERMINAL_STATUSES = ["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"];

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
				holder          text,
				claimed         timestamptz not null default now()
			)`;
		// Insurance for anyone who ran an earlier build of this migration, where the claim
		// had no fencing token.
		await this.sql`alter table memory_writes add column if not exists holder text`;

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

	async releaseNode(graphId: string, nodeId: string): Promise<void> {
		await this.sql`
			update graph_nodes set claimed_by = null, claimed_at = null, claim_session = null
			where graph_id = ${graphId} and node_id = ${nodeId}`;
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
	// there is no second door past it, the same argument that keeps the Greptime
	// client inside this package.

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
	async claimWrite(input: { key: string; explicit: boolean; entryHash: string; entryId: string }): Promise<ClaimResult> {
		const holder = `hold_${randomUUID().replace(/-/g, "")}`;
		const inFlightSeconds = IN_FLIGHT_TIMEOUT_MS / 1000;
		const derivedSeconds = DERIVED_KEY_WINDOW_MS / 1000;

		return (await this.sql.begin(async (tx: SQL) => {
			const fresh = (await tx`
				insert into memory_writes (idempotency_key, explicit, outcome, entry_id, entry_hash, holder, claimed)
				values (${input.key}, ${input.explicit}, 'in-flight', ${input.entryId}, ${input.entryHash},
				        ${holder}, now())
				on conflict (idempotency_key) do nothing
				returning idempotency_key`) as Array<Record<string, unknown>>;
			if (fresh.length > 0) return { claimed: true as const, holder, tookOverFrom: null };

			// The key is held. Lock the row before judging it, so two retries cannot both
			// conclude that one abandoned claim is theirs. Staleness is computed by the
			// database, against its own clock — the server's may not agree.
			const rows = (await tx`
				select outcome, explicit, entry_id, entry_hash,
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
			const takeable =
				(outcome !== "accepted" && !inFlight) ||
				(inFlight && row.in_flight_stale === true) ||
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
					},
				};
			}

			// Only an abandoned *in-flight* claim can have left a row behind unacknowledged.
			// A finished attempt recorded its outcome, and an aged-out derived key belongs to
			// a write we are deliberately allowing to happen again — so its `entry_id` names
			// a row that is still in force and must not be reused.
			const priorEntry = row.entry_id === null || row.entry_id === undefined ? null : String(row.entry_id);
			const tookOverFrom = inFlight ? priorEntry : null;

			await tx`
				update memory_writes set
					outcome    = 'in-flight',
					explicit   = ${input.explicit},
					entry_hash = ${input.entryHash},
					-- An in-flight claim's reservation is KEPT, not replaced. It may point at a
					-- row that already exists, and the successor has to resolve that before the
					-- pointer can be thrown away; overwriting it here would orphan the row and
					-- the retry after this one would duplicate it.
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
	 */
	async insertEntry(row: NewMemoryEntry): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" }> {
		return (await this.sql.begin(async (tx: SQL) => {
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
		})) as { ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" };
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
