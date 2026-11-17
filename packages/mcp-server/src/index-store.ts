/**
 * The Postgres coordination index and durable live-session authority.
 *
 * Graph and tracker projections cache Notion/Linear state and are refreshed
 * when they disagree with those sources. Live-session bindings are different:
 * their immutable ownership, credential hashes, leases and terminal identities
 * are authoritative and cannot be reconstructed from tracker or cache rows.
 */
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { callPlane, type PlaneGate } from "@substrate/observability";
import { normalizeIdentifier } from "./event.ts";
import {
	TERMINAL_GRAPH_STATUSES,
	executeSweep,
	memoryLifecycleQuery,
	planSweep,
	sweepPolicyFromEnv,
	type SweepPolicy,
	type SweepReport,
	type SweepStatement,
} from "./index-sweep.ts";
import { exportedColumns, tableSpec, type ArchiveRow, type ArchiveTableSpec, type ColumnType } from "./index-archive-spec.ts";
import { grantedToCaller, memoryExpiry, memoryGraphId, needsReverification, type GraphLifetime } from "./memory-policy.ts";
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
	MemoryExpiryMode,
	MemoryKind,
	MemoryReadOptions,
	MemorySearch,
	MemorySearchPage,
	MemoryWriteOutcome,
	NodeState,
	QuarantineReason,
	Surface,
} from "./types.ts";
import { EDGE_KINDS } from "./types.ts";
import { SteeringAuditSink, bunSteeringAuditReadSql, bunSteeringAuditSql } from "./planning/steering-store.ts";
import { bunLiveSessionAuthority, type LiveSessionAuthority } from "./planning/steering-sessions-store.ts";
import { bunCorpusStore, type CorpusStore } from "./corpus/store.ts";
import { bunPlanningHashStore, type PlanningHashStore } from "./planning-hash-store.ts";
import { bunReflectStore, type ReflectStore } from "./corpus/reflect-store.ts";
import {
	DEFAULT_LEASE_TTL_SECONDS,
	decideClaim,
	decideHeartbeat,
	decideRelease,
	holderLeaseView,
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
import { FORGET_MARKER_PREFIX, isForgetMarker, MAX_FORGET_ENTRIES, MAX_ROLLBACK_SELECT_LIMIT } from "./memory-forget.ts";
import { transition, type SkillDecision, type SkillDecisionResult, type SkillRegistryRow, type SkillState } from "./skills/registry.ts";
import type { CrossRepoStore } from "./cross-repo-ops.ts";
import { PgCrossRepoStore } from "./cross-repo-store.ts";
import { PgWorktreeRegistry, type WorktreeRegistryStore } from "./worktree-registry.ts";

/** The most entry ids one `forgottenEntryIds` call reads (a recall fan-out holds a few hits per bank). */
const MAX_FORGET_LOOKUP_IDS = 500;

/**
 * Statuses that mean a graph is finished, so it is no longer "open" in a brief.
 * Shared with the sweeper, which retires graphs in exactly these statuses — a
 * shorter list here would leave Closed and Resolved graphs showing up as live
 * work, and a different list there would retire graphs a brief still shows.
 */
const TERMINAL_STATUSES: string[] = [...TERMINAL_GRAPH_STATUSES];

/**
 * Thrown by {@link IndexStore.node} for a node that is not in the index. Its own
 * class so the plane gate can tell it from a database failure: an unknown node is
 * an answer, not an outage, and must not count against the breaker.
 */
class UnknownNode extends Error {
	constructor(graphId: string, nodeId: string) {
		super(`unknown node ${graphId}/${nodeId}`);
		this.name = "UnknownNode";
	}
}

/** A store error for the breaker is anything that is not the index answering "no such node". */
const isStoreFailure = (error: unknown): boolean => !(error instanceof UnknownNode);

/** `application_name` on every connection, so `pg_stat_activity` names this client. */
export const INDEX_APPLICATION_NAME = "substrate-mcp";

/**
 * Connections are recycled after this long whatever their state. A proxy in front
 * of the database (Railway's TCP proxy is one) drops long-lived idle sockets
 * silently; a bounded lifetime turns that into a planned reconnect.
 */
export const INDEX_MAX_LIFETIME_S = 3600;

/** How long `ping` waits for `select 1` before calling the index unhealthy. */
export const INDEX_PING_TIMEOUT_MS = 1000;

/**
 * How long `migrate` waits to take its session advisory lock. Two boots creating
 * the same index otherwise deadlock; the loser gives up here instead of hanging
 * on the pool's 5s `statement_timeout`.
 */
export const INDEX_MIGRATE_LOCK_TIMEOUT_MS = 180000;

/** `statement_timeout` for the DDL itself, after the lock is held. */
export const INDEX_MIGRATE_STATEMENT_TIMEOUT_MS = 120000;

/**
 * `lock_timeout` for the DDL, set once the advisory lock is held. A table lock held by a long reader or writer fails the
 * step in seconds: `migrate` throws, the service reports the index as degraded, and boot continues. Without it the step
 * queues behind that holder for the advisory lock's {@link INDEX_MIGRATE_LOCK_TIMEOUT_MS}.
 */
export const INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS = 5000;

/**
 * The pool and the per-connection timeouts. Before these existed the client was
 * `new SQL(url)`: Bun's default pool of 10 per process, no connect timeout, no
 * `statement_timeout`, no name — and production showed 19 idle connections with
 * an empty `application_name` and a server-side `statement_timeout` of 0.
 */
export interface IndexPoolSettings {
	/** Pool size per process. */
	max: number;
	/** How long one connect may take. */
	connectTimeoutMs: number;
	/** `statement_timeout` and `idle_in_transaction_session_timeout` per connection; 0 leaves the server default. */
	statementTimeoutMs: number;
	/** Idle connections are closed after this long; 0 keeps them forever. */
	idleTimeoutS: number;
	/** Always {@link INDEX_APPLICATION_NAME}; carried here so the composed options are one object. */
	applicationName: string;
}

export const DEFAULT_INDEX_POOL_SETTINGS: IndexPoolSettings = {
	max: 8,
	connectTimeoutMs: 2000,
	statementTimeoutMs: 5000,
	idleTimeoutS: 300,
	applicationName: INDEX_APPLICATION_NAME,
};

/** An integer within bounds, or the fallback. Bad values never throw: the server must still boot. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const text = raw?.trim();
	if (!text || !/^\d+$/.test(text)) return fallback;
	const value = Number(text);
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * `SUBSTRATE_PG_POOL_MAX` (1..50), `SUBSTRATE_PG_CONNECT_TIMEOUT_MS` (200..60000),
 * `SUBSTRATE_PG_STATEMENT_TIMEOUT_MS` (0 = unset, ≤ 600000) and
 * `SUBSTRATE_PG_IDLE_TIMEOUT_S` (0 = never, ≤ 86400). Out-of-range values clamp
 * and unparseable ones fall back to the defaults.
 */
export function indexPoolSettingsFromEnv(env: Record<string, string | undefined> = process.env): IndexPoolSettings {
	return {
		max: boundedInt(env.SUBSTRATE_PG_POOL_MAX, DEFAULT_INDEX_POOL_SETTINGS.max, 1, 50),
		connectTimeoutMs: boundedInt(env.SUBSTRATE_PG_CONNECT_TIMEOUT_MS, DEFAULT_INDEX_POOL_SETTINGS.connectTimeoutMs, 200, 60_000),
		statementTimeoutMs: boundedInt(env.SUBSTRATE_PG_STATEMENT_TIMEOUT_MS, DEFAULT_INDEX_POOL_SETTINGS.statementTimeoutMs, 0, 600_000),
		idleTimeoutS: boundedInt(env.SUBSTRATE_PG_IDLE_TIMEOUT_S, DEFAULT_INDEX_POOL_SETTINGS.idleTimeoutS, 0, 86_400),
		applicationName: INDEX_APPLICATION_NAME,
	};
}

/** The options object handed to Bun's `SQL`, as the constructor composes it. */
export interface IndexSqlOptions {
	max: number;
	/** Seconds: Bun's unit for every pool timeout. */
	connectionTimeout: number;
	idleTimeout: number;
	maxLifetime: number;
	/** Startup parameters, sent with every connection so no `set` round-trip is needed. */
	connection: Record<string, string>;
}

/**
 * Pure, so a test can assert the composed options without opening a connection.
 * `statement_timeout` and `idle_in_transaction_session_timeout` travel as startup
 * parameters (Bun's `connection` option), which Postgres applies before the
 * first statement — a `set` after connect would leave the first query unbounded.
 * The idle-in-transaction bound is the same value: a transaction left open by a
 * crashed caller holds row locks the sweeper and the lease CAS would wait on.
 */
export function indexSqlOptions(settings: Partial<IndexPoolSettings> = {}): IndexSqlOptions {
	const merged = { ...DEFAULT_INDEX_POOL_SETTINGS, ...settings, applicationName: INDEX_APPLICATION_NAME };
	const connection: Record<string, string> = { application_name: merged.applicationName };
	if (merged.statementTimeoutMs > 0) {
		connection.statement_timeout = String(merged.statementTimeoutMs);
		connection.idle_in_transaction_session_timeout = String(merged.statementTimeoutMs);
	}
	return {
		max: merged.max,
		connectionTimeout: merged.connectTimeoutMs / 1000,
		idleTimeout: merged.idleTimeoutS,
		maxLifetime: INDEX_MAX_LIFETIME_S,
		connection,
	};
}

/** One expired entry a serving read met, and what the read did with it (uplift-3 N4). */
export interface MemoryExpiredSample {
	/** The caller the read was for; `unattributed` when the read did not say. */
	surface: string;
	kind: MemoryKind;
	mode: "served" | "hidden";
}

/**
 * How the store's serving reads treat entries past their `ttl` (uplift-3 N4).
 * `report` serves them tagged; `enforce` leaves them out unless the read asked
 * for them. `observe` is called once per expired entry met, in either mode.
 */
export interface MemoryExpirySettings {
	mode: MemoryExpiryMode;
	observe?: (sample: MemoryExpiredSample) => void;
}

export interface IndexStoreOptions {
	/** Overrides on top of `indexPoolSettingsFromEnv(process.env)`. */
	pool?: Partial<IndexPoolSettings>;
	/** The index plane's breaker and observer. Absent means every call runs unwrapped, as before. */
	gate?: PlaneGate | null;
	/** Lifetime handling on serving reads. Absent is `report`, uncounted: what every read did before N4, plus the tag. */
	memoryExpiry?: MemoryExpirySettings;
	/** `SUBSTRATE_INDEX_TUNE=apply` (uplift-4 S2): apply the lease-table storage tune once at the end of `migrate()`. Absent is `off`. */
	tune?: "off" | "apply";
	/** Test seam: a client to use instead of `new SQL(connectionString, …)`, so `migrate()` can run against a recording fake. Production never sets it. */
	sql?: SQL;
	/** Migrations gated behind an opt-in (see {@link MigrationOptIn}). Absent is every opt-in off. */
	migrationOptIns?: MigrationOptIns;
}

/** What `/healthz` reports about the database's size, from `capacity()`. */
export interface IndexCapacity {
	databaseBytes: number;
	/** The ten largest relations outside Timescale's own schemas. */
	tables: Array<{ name: string; totalBytes: number; liveRows: number; deadRows: number }>;
	/** `graph_nodes` lease-table bloat (uplift-4 S2), `null` when the table is absent: `n_tup_hot_upd / n_tup_upd` and `n_dead_tup / (n_live_tup + n_dead_tup)`, each `null` while its denominator is 0. */
	graphNodes?: { hotUpdateRatio: number | null; deadRatio: number | null } | null;
}

/** Rejects with an error named `TimeoutError`, which the plane gate samples as a timeout. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new Error(`${what} timed out after ${ms} ms`);
			error.name = "TimeoutError";
			reject(error);
		}, ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

/**
 * How many times a claim re-reads and retries after losing the compare-and-swap.
 *
 * More than one because the state it lost to may itself be a lease that has
 * since lapsed; bounded because a node that changes hands three times while one
 * agent is asking for it is contended, and the honest answer is the holder's name.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * Carries "the standing identity is already taken" out of `insertEntry`'s
 * transaction, rolling it back on the way.
 *
 * A sentinel rather than a returned value because the transaction has to *not*
 * commit: the insert declines quietly under `on conflict … do nothing`, and a
 * retire in the same transaction would otherwise be committed without the row it
 * was making way for. Private to this file, so it can never be confused with a
 * store error a caller has to handle.
 */
class StandingTaken extends Error {
	constructor() {
		super("the standing entry for this conflict key was written by another writer");
		this.name = "StandingTaken";
	}
}

/**
 * What a correlation bind answers. `graph_id` is always the stored winner, and
 * `conflict` is true when that is not the Graph ID the caller offered.
 */
export interface GraphBindResult {
	status: "created" | "existing";
	correlation_id: string;
	graph_id: string;
	conflict: boolean;
}

/** A node row joined to its graph's repo, branch and status, for `graph_find`. */
export type LinearNodeMatch = GraphNode & { repo: string | null; branch: string | null; graph_status: string | null };

/**
 * One boot DDL step. `down` and `phase` are the expand-then-contract convention:
 * `down` is operator-run documentation only (the statements that undo what `sql`
 * created) and is NEVER executed at boot; `phase` says whether the step expands
 * the schema (additive, safe under the previous release) or contracts it (removes
 * what a release ago stopped using). Every step from {@link FIRST_REVERSIBLE_VERSION}
 * on declares both; `index-store.migrate-contract.test.ts` enforces it.
 * `optIn` names the opt-in a step is gated behind (see {@link MigrationOptIn}); absent is always run.
 */
export interface MigrationStep {
	version: number;
	name: string;
	sql: string;
	down?: string;
	phase?: "expand" | "contract";
	optIn?: MigrationOptIn;
	/**
	 * `false`: `migrate()` runs the step outside any transaction, one statement at a time, and ledgers it after the last one. For
	 * DDL Postgres refuses inside a transaction block, such as `create index concurrently`. Absent is transactional.
	 */
	transactional?: false;
}

/** The first version that must declare `down` and `phase`. Steps 1..32 predate the convention and are frozen as they are. */
export const FIRST_REVERSIBLE_VERSION = 33;

/**
 * A migration that runs only when its named opt-in is on. While the opt-in is off, `migrate()` neither runs
 * nor ledgers the step, so turning the opt-in on later applies it on the next boot.
 */
export type MigrationOptIn = "steering-audit" | "steering-sessions";

/** Which opt-in migrations run. A missing key is off. */
export type MigrationOptIns = Readonly<Partial<Record<MigrationOptIn, boolean>>>;

const MIGRATION_OPT_INS_OFF: MigrationOptIns = { "steering-audit": false, "steering-sessions": false };

/**
 * Boot DDL in application order. Versions are contiguous and never renumbered:
 * a database stamps a version only after that statement commits. `tuneGraphNodes`
 * is not a step — it stays opt-in inside `migrate` and is not ledgered.
 */
export const MIGRATION_STEPS: ReadonlyArray<MigrationStep> = [
	{
		version: 1,
		name: "graph_index",
		sql: `
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
			)`,
	},
	{
		version: 2,
		name: "graph_nodes",
		sql: `
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
			)`,
	},
	// Leases were added after the table shipped, so the columns are added rather
	// than declared: `create table if not exists` is a no-op against the Phase 0
	// table and would leave a live index without them.
	{ version: 3, name: "graph_nodes_lease_id", sql: `alter table graph_nodes add column if not exists lease_id text` },
	{ version: 4, name: "graph_nodes_lease_expires_at", sql: `alter table graph_nodes add column if not exists lease_expires_at timestamptz` },
	{ version: 5, name: "graph_nodes_lease_heartbeat_at", sql: `alter table graph_nodes add column if not exists lease_heartbeat_at timestamptz` },
	{ version: 6, name: "graph_nodes_lease_epoch", sql: `alter table graph_nodes add column if not exists lease_epoch bigint not null default 0` },
	{
		version: 7,
		name: "graph_edges",
		sql: `
			create table if not exists graph_edges (
				graph_id  text not null,
				from_node text not null,
				to_node   text not null,
				kind      text not null,
				primary key (graph_id, from_node, to_node, kind)
			)`,
	},
	{
		version: 8,
		name: "graph_steps",
		sql: `
			create table if not exists graph_steps (
				graph_id            text not null,
				node_id             text not null,
				step                int  not null,
				linear_sub_issue_id text,
				notion_page         text,
				state               text,
				primary key (graph_id, node_id, step)
			)`,
	},
	// A swarm run's correlation_id bound to exactly one Graph ID. The primary key is
	// what makes two runs racing one correlation_id resolve to a winner and a reader;
	// no foreign key to graph_index, because a run binds before it registers its nodes.
	{
		version: 9,
		name: "graph_bindings",
		sql: `
			create table if not exists graph_bindings (
				correlation_id text primary key,
				graph_id       text not null,
				bound_by       text,
				created        timestamptz not null default now()
			)`,
	},
	{
		version: 10,
		name: "memory_entries",
		sql: `
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
			)`,
	},
	// Governance columns, added rather than declared: `memory_entries` predates the
	// gate and is live, so every one of these has to be safe on a table that
	// already holds rows. The defaults are what an ungoverned Phase 0 entry
	// honestly was — one version, written by an agent, superseding nothing.
	{
		version: 11,
		name: "memory_entries_governance_columns",
		sql: `
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
				add column if not exists idempotency_key text`,
	},
	// The idempotency ledger. One row per key ever spent; `claimed` is what makes
	// an abandoned in-flight claim recoverable and a derived key expire.
	{
		version: 12,
		name: "memory_writes",
		sql: `
			create table if not exists memory_writes (
				idempotency_key text primary key,
				explicit        boolean not null default false,
				outcome         text not null,
				entry_id        text,
				entry_hash      text not null,
				request_hash    text,
				holder          text,
				claimed         timestamptz not null default now()
			)`,
	},
	// Insurance for anyone who ran an earlier build of this migration, where the claim
	// had no fencing token.
	{ version: 13, name: "memory_writes_holder", sql: `alter table memory_writes add column if not exists holder text` },
	{ version: 14, name: "memory_writes_request_hash", sql: `alter table memory_writes add column if not exists request_hash text` },
	// Parked writes. Both tables hold the *redacted* body: a quarantined secret is
	// quarantined so a reviewer can see what was attempted, never so the substrate
	// can keep the credential.
	{
		version: 15,
		name: "memory_quarantine",
		sql: `
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
			)`,
	},
	{
		version: 16,
		name: "memory_reviews",
		sql: `
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
			)`,
	},
	// Skills governance (uplift-5 S5a). The registry of which merged skill pull request an
	// operator approved, declined or retired. A row is never deleted; see skills/registry.ts.
	{
		version: 17,
		name: "skills_registry",
		sql: `
			create table if not exists skills_registry (
				repo            text not null,
				name            text not null,
				pr_number       integer not null,
				content_sha256  text not null default '',
				state           text not null check (state in ('proposed', 'approved', 'declined', 'retired')),
				proposed_by     text,
				pr_url          text,
				branch          text,
				merge_sha       text,
				decided_by      text,
				decided_at      timestamptz,
				reason          text,
				created         timestamptz not null default now(),
				updated         timestamptz not null default now(),
				primary key (repo, name, pr_number)
			)`,
	},
	{ version: 18, name: "skills_registry_state_idx", sql: `create index if not exists skills_registry_state_idx on skills_registry (repo, state, name)` },
	{ version: 19, name: "graph_index_repo_idx", sql: `create index if not exists graph_index_repo_idx on graph_index (repo)` },
	{ version: 20, name: "graph_nodes_claimed_idx", sql: `create index if not exists graph_nodes_claimed_idx on graph_nodes (claimed_by)` },
	{ version: 21, name: "graph_nodes_lease_idx", sql: `create index if not exists graph_nodes_lease_idx on graph_nodes (lease_expires_at)` },
	{ version: 22, name: "graph_edges_graph_idx", sql: `create index if not exists graph_edges_graph_idx on graph_edges (graph_id)` },
	{ version: 23, name: "graph_bindings_graph_idx", sql: `create index if not exists graph_bindings_graph_idx on graph_bindings (graph_id)` },
	{ version: 24, name: "memory_scope_idx", sql: `create index if not exists memory_scope_idx on memory_entries (scope)` },
	// Seek directly to a scoped page boundary in its output order, including history.
	{
		version: 25,
		name: "memory_scope_created_id_idx",
		sql: `
			create index if not exists memory_scope_created_id_idx
			on memory_entries (scope, created desc, id desc)`,
	},
	{ version: 26, name: "memory_fts_idx", sql: `create index if not exists memory_fts_idx on memory_entries using gin (to_tsvector('english', body))` },
	// The identity the lww and versioned strategies resolve against: one standing
	// entry per conflict key, enforced rather than merely selected for.
	{
		version: 27,
		name: "memory_standing_idx",
		sql: `
			create unique index if not exists memory_standing_idx on memory_entries (conflict_key)
			where conflict_key is not null and superseded_by is null`,
	},
	{ version: 28, name: "memory_reverify_idx", sql: `create index if not exists memory_reverify_idx on memory_entries (reverify_after)` },
	// What makes parking idempotent: a retried write finds its own parked row
	// instead of adding another for a reviewer to wade through.
	{ version: 29, name: "memory_quarantine_hash_idx", sql: `create unique index if not exists memory_quarantine_hash_idx on memory_quarantine (entry_hash)` },
	// One *pending* proposal per content, and nothing said about the decided ones.
	//
	// It used to be unique on `(entry_hash, state)`, which also forbade a second
	// approved row — and that is a rule nobody wanted. Content approved once can be
	// proposed again (the derived key for an unreviewed write is spent on a refusal,
	// so re-asking is allowed by design), and approving that second proposal moves it
	// to `approved` beside the first. Under the old index that UPDATE raised a
	// duplicate key *after* the entry had already committed: the gate's catch held
	// the claim, the caller was told the write failed, and the entry was sitting in
	// the index all along. Uniqueness over the pending rows is what parking actually
	// needs; the decided rows are an audit trail and may repeat.
	{
		version: 30,
		name: "memory_reviews_pending_idx",
		sql: `
			create unique index if not exists memory_reviews_pending_idx on memory_reviews (entry_hash)
			where state = 'pending'`,
	},
	// The index behind the agent-scope read rule, which matches `repo` on every `agent:` row. The column is
	// migration 11's and legacy rows keep NULL, so they match no caller. Nothing is backfilled.
	{ version: 31, name: "memory_entries_repo_idx", sql: `create index if not exists memory_entries_repo_idx on memory_entries (repo)` },
	// The skill's version, monotonic per (repo, name): the proposal that created the row took max + 1
	// (`upsertProposedSkill`). Legacy rows read as 0 — "recorded before versions existed".
	{
		version: 32,
		name: "skills_registry_version",
		sql: `alter table skills_registry add column if not exists version integer not null default 0`,
	},
	// Steering audit (phase 53, SOTA-09): the append-only record of every queued and acknowledged directive.
	// Created only under the opt-in SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE: while it is off, migrate() skips this
	// step and does not ledger it. The unique key makes a same-payload repeat a no-op and a different payload under
	// a saved key a conflict. Rows are never updated or deleted by the application.
	// Append-only is enforced by the application only; a DB-level REVOKE or trigger is an operator decision, and this
	// step adds neither.
	// OPERATORS: rehearse this step on a restored dump before applying it to production. It is additive and
	// idempotent; it creates one new table and touches no existing row.
	{
		version: 33,
		name: "planning_steering_audit",
		optIn: "steering-audit",
		phase: "expand",
		down: `drop table if exists planning_steering_audit`,
		sql: `
			create table if not exists planning_steering_audit (
				id                         bigint generated by default as identity primary key,
				directive_id               text not null,
				transition                 text not null check (transition in ('queued', 'acknowledged')),
				outcome                    text check (outcome in ('applied', 'declined')),
				confirmed                  boolean,
				author_principal           text,
				author_kind                text check (author_kind in ('human', 'agent')),
				target_session_id          text not null,
				body_redacted              text,
				action                     text check (action in ('pause', 'redirect', 'annotate')),
				priority                   text check (priority in ('low', 'normal', 'high')),
				plan_phase                 text,
				plan_plan                  text,
				conflicts_with_active_plan boolean,
				directive_created_at_ms    bigint,
				payload_sha256             text not null,
				recorded_at                timestamptz not null,
				constraint planning_steering_audit_directive_transition_key unique (directive_id, transition),
				constraint planning_steering_audit_shape check (
					(transition = 'queued' and outcome is null and confirmed is null
						and author_principal is not null and author_kind is not null and body_redacted is not null
						and action is not null and priority is not null and conflicts_with_active_plan is not null
						and directive_created_at_ms is not null and ((plan_phase is null) = (plan_plan is null)))
					or (transition = 'acknowledged' and outcome is not null and confirmed is not null
						and author_principal is null and author_kind is null and body_redacted is null
						and action is null and priority is null and plan_phase is null and plan_plan is null
						and conflicts_with_active_plan is null and directive_created_at_ms is null)
				)
			)`,
	},
	// Steering audit reason (phase 58, live steering): why a system closed a directive. A queued directive nobody
	// acknowledged in time is closed by an acknowledged row with outcome 'declined' and reason 'timeout'; a human
	// acknowledgement leaves it NULL. Same opt-in as step 33: with SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE off this
	// step is skipped and not ledgered, and the table it alters does not exist.
	// Additive and idempotent: one nullable column added `if not exists`, with its check inline so it is added only with
	// the column. No existing row is touched, and existing rows keep their payload hash because a NULL reason is left
	// out of the hash. The shape check of step 33 is left as it is: it does not mention the column.
	// OPERATORS: rehearse on a restored dump before production, like step 33.
	{
		version: 34,
		name: "planning_steering_audit_reason",
		optIn: "steering-audit",
		phase: "expand",
		down: `alter table planning_steering_audit drop column if exists reason`,
		sql: `
			alter table planning_steering_audit
				add column if not exists reason text
				constraint planning_steering_audit_reason_check check (
					reason is null or (transition = 'acknowledged' and outcome = 'declined' and reason = 'timeout')
				)`,
	},
	// Corpus manifest (v1.7 phase 63): one row per documentation file the bulk ingest has seen, keyed by (repo, path).
	// `manifest_seq` is an identity column, so the table owns its sequence and `down` drops both; a write that changes a
	// row takes the next value (`nextval(pg_get_serial_sequence(...))`), which makes the maximum a version that only grows.
	// `signals` is reserved for phase 66 (ranking); nothing writes it yet. Always run (no opt-in): the ingest routes stay
	// closed while SUBSTRATE_CORPUS is off, so an empty table costs nothing.
	// Additive and idempotent: one new table and three indexes, no existing row touched. An older release never names
	// the table. OPERATORS: rehearse on a restored dump before production, like steps 33 and 34.
	{
		version: 35,
		name: "corpus_documents",
		phase: "expand",
		down: `drop table if exists corpus_documents`,
		sql: `
			create table if not exists corpus_documents (
				repo              text not null,
				path              text not null,
				kind              text not null,
				tier              smallint not null check (tier between 1 and 3),
				sha256            text not null,
				bytes             integer not null,
				source            text not null,
				commit_sha        text,
				state             text not null default 'active' check (state in ('active', 'tombstoned')),
				docs_document_id  text,
				signals           jsonb not null default '{}',
				manifest_seq      bigint generated by default as identity,
				ingested_at       timestamptz,
				tombstoned_at     timestamptz,
				created_at        timestamptz not null default now(),
				updated_at        timestamptz not null default now(),
				primary key (repo, path)
			);
			create index if not exists corpus_documents_repo_state_idx on corpus_documents (repo, state);
			create index if not exists corpus_documents_sha256_idx on corpus_documents (sha256);
			create index if not exists corpus_documents_docs_document_id_idx on corpus_documents (docs_document_id)`,
	},
	// Phase 68 (FLEET-02): the worktree registry, one row per (host, path) as the latest report left it. Additive: a new table and
	// its index, nothing existing is touched, and an older release never names either. The table holds what reporters sent
	// (paths, branches, heads, counts), not content. `is_primary` is the report's `primary`, which is a reserved word in SQL.
	// It is not in the index archive's closed table list: the registry is rebuilt by the next report from each host, so an
	// archive of it would only restore stale paths.
	{
		version: 36,
		name: "worktrees",
		phase: "expand",
		down: `drop table if exists worktrees`,
		sql: `
			create table if not exists worktrees (
				host text not null,
				path text not null,
				repo text not null,
				branch text,
				head text not null,
				base text,
				dirty boolean not null default false,
				ahead integer,
				behind integer,
				last_commit_at timestamptz,
				size_bytes bigint,
				locked boolean not null default false,
				is_primary boolean not null default false,
				pr_state text not null default 'unknown',
				session_id text,
				graph_id text,
				first_seen_at timestamptz not null,
				last_seen_at timestamptz not null,
				reported_at timestamptz not null,
				primary key (host, path)
			);
			create index if not exists worktrees_repo_seen_idx on worktrees (repo, last_seen_at)`,
	},
	// Steering sessions (phase 67, live steering GA): the durable copy of the live steering session registry, so a
	// session's state, steering text and planning hash survive a restart. Created only under the opt-in
	// SUBSTRATE_STEERING_SESSIONS_TABLE: while it is off, migrate() skips this step and does not ledger it.
	// The application upserts one row per (surface, session_id) and drops rows past the TTL when it loads them at boot.
	// Additive and idempotent: one new table and its index, nothing existing is touched.
	// OPERATORS: rehearse this step on a restored dump before applying it to production.
	{
		version: 37,
		name: "steering_sessions",
		optIn: "steering-sessions",
		phase: "expand",
		down: `drop table if exists steering_sessions`,
		sql: `
			create table if not exists steering_sessions (
				surface        text not null,
				session_id     text not null,
				repo_id        text not null,
				state          text not null check (state in ('ACTIVE', 'CONTEXT_REFRESH', 'PAUSED', 'RESUMED')),
				steering       text,
				planning_hash  text,
				updated_at     timestamptz not null,
				primary key (surface, session_id)
			);
			create index if not exists steering_sessions_repo_updated_idx on steering_sessions (repo_id, updated_at)`,
	},
	// Corpus reflect (v1.7 phase 66): what the docs RAG learns from use. `superseded_by` is the explicit marker of a document
	// that a newer one replaces (a repo-relative path of the same repository, null when there is none). `corpus_retrievals`
	// is one bounded, redacted row per `docs_search` while SUBSTRATE_DOCS_TELEMETRY is on (a query hash, a capped redacted
	// text, at most ten returned document keys with scores, no snippet); a bounded sweep deletes rows past the retention.
	// `corpus_feedback` is one verdict per (document, session), an upsert. Always run (no opt-in): both tables stay empty
	// while the flags and the corpus are off, and an older release never names them.
	// `degraded` marks a search the plane could not answer: it is not a gap in the corpus, so the gap report leaves it out.
	// `rerank` is set only while SUBSTRATE_DOCS_RERANK=shadow: the order the re-rank would have answered and how many positions moved.
	// Additive and idempotent: one nullable column, two tables and three indexes, no existing row touched.
	// Numbered 38: step 37 is steering_sessions (live steering), so this branch's step follows it.
	// OPERATORS: rehearse on a restored dump before production, like steps 33 to 36.
	{
		version: 38,
		name: "corpus_reflect",
		phase: "expand",
		down: `drop table if exists corpus_feedback; drop table if exists corpus_retrievals; alter table corpus_documents drop column if exists superseded_by`,
		sql: `
			alter table corpus_documents add column if not exists superseded_by text;
			create table if not exists corpus_retrievals (
				id              bigint generated by default as identity primary key,
				at              timestamptz not null default now(),
				surface         text not null,
				query_hash      text not null,
				query_text      text,
				backend         text not null,
				returned        jsonb not null,
				top_score       real,
				returned_count  integer not null,
				degraded        boolean not null default false,
				rerank          jsonb
			);
			create index if not exists corpus_retrievals_at_idx on corpus_retrievals (at);
			create index if not exists corpus_retrievals_query_hash_idx on corpus_retrievals (query_hash);
			create table if not exists corpus_feedback (
				document_key  text not null,
				session_id    text not null,
				verdict       text not null check (verdict in ('helpful', 'unhelpful', 'stale', 'wrong', 'duplicate')),
				surface       text not null,
				at            timestamptz not null default now(),
				primary key (document_key, session_id)
			);
			create index if not exists corpus_feedback_document_idx on corpus_feedback (document_key)`,
	},
	// v1.7 phase 65 (doc watch): the planning refresh's per-page content hashes, so a restart ingests only the pages that
	// changed. One row per docs-plane destination and `.planning/` path. `destination` is a hash of the configured docs URL,
	// never the URL. A cutover to another plane misses the old rows and ingests. Written only while
	// `SUBSTRATE_PLANNING_HASH_STORE=on` (the default is off, and an empty table costs nothing, so the step always runs, like
	// step 35). It takes version 39, after step 38 `corpus_reflect`.
	// Additive and idempotent: one new table, no existing row touched. An older release never names it. OPERATORS: rehearse on a
	// restored dump before production, like steps 33 to 35.
	{
		version: 39,
		name: "planning_page_hashes",
		phase: "expand",
		down: `drop table if exists planning_page_hashes`,
		sql: `
			create table if not exists planning_page_hashes (
				destination text not null,
				path        text not null,
				sha256      text not null,
				updated_at  timestamptz not null default now(),
				primary key (destination, path)
			)`,
	},
	// Worktree overlap in the brief (phase 68, FLEET-06): the paths each worktree last reported touching, so `memory_brief`
	// can name another session's worktree that edits the same files. Additive: two nullable-or-defaulted columns on the
	// registry table (step 36), runs with the registry and is not opt-in. NULL means the last report carried no list (an
	// older reporter, or a listing that failed), never "touches nothing".
	// OPERATORS: rehearse this step on a restored dump before applying it to production. It rewrites no row.
	{
		version: 40,
		name: "worktrees_changed_files",
		phase: "expand",
		down: `alter table worktrees drop column if exists changed_files; alter table worktrees drop column if exists files_truncated`,
		sql: `
			alter table worktrees add column if not exists changed_files jsonb;
			alter table worktrees add column if not exists files_truncated boolean not null default false`,
	},
	// candidates() filters lower(repo) and orders by last_seen_at. worktrees_repo_seen_idx is (repo, last_seen_at) and cannot
	// serve lower(repo). This index is its own step: step 40's contract is the two columns only.
	// OPERATORS: rehearse this step on a restored dump before applying it to production.
	{
		version: 41,
		name: "worktrees_repo_lower_seen_idx",
		phase: "expand",
		down: `drop index if exists worktrees_repo_lower_seen_idx`,
		sql: `
			create index if not exists worktrees_repo_lower_seen_idx on worktrees (lower(repo), last_seen_at desc)`,
	},
	// Security authority, not restart cache: retain terminal identities permanently. Native PostgreSQL backups must
	// include this table. Documentary down destroys non-reuse evidence and is never an automatic rollback action.
	{
		version: 42,
		name: "live_session_bindings",
		phase: "expand",
		down: `drop table if exists live_session_bindings`,
		sql: `
			create table if not exists live_session_bindings (
				session_id text primary key,
				owner_surface text not null,
				repo_id text not null,
				binding_proof_hash text not null,
				issued_at timestamptz not null,
				last_seen_at timestamptz not null,
				expires_at timestamptz not null,
				updated_at timestamptz not null,
				closed_at timestamptz,
				close_reason text,
				state text not null,
				steering text,
				planning_hash text
			);
			create index if not exists live_session_bindings_owner_repo_id_idx
				on live_session_bindings (owner_surface, repo_id, session_id) where closed_at is null;
			create index if not exists live_session_bindings_repo_id_idx
				on live_session_bindings (repo_id, session_id) where closed_at is null`,
	},
	// Cross-repository operations (phase 74): one row per operation key, and one row per repository step of it. The steps are
	// written before each git effect (`applying`, `compensating`) and after its outcome, so a crash leaves the state the retry
	// reads. Additive: two new tables; nothing existing is touched and an older release never names them. Always on, like step
	// 36: an empty table costs nothing. Not in the archive's closed table list: an operation is re-run, not restored.
	// OPERATORS: rehearse on a restored dump before production, like step 36.
	{
		version: 43,
		name: "cross_repo_operations",
		phase: "expand",
		down: `drop table if exists cross_repo_steps; drop table if exists cross_repo_operations`,
		sql: `
			create table if not exists cross_repo_operations (
				op_key       text primary key,
				fingerprint  text not null,
				branch       text not null,
				status       text not null check (status in ('running', 'done', 'rolled-back', 'needs-attention')),
				created_at   timestamptz not null,
				updated_at   timestamptz not null
			);
			create table if not exists cross_repo_steps (
				op_key      text not null references cross_repo_operations (op_key),
				idx         integer not null check (idx >= 0),
				repo        text not null,
				base_ref    text not null,
				planned_sha text not null,
				state       text not null check (state in ('pending', 'applying', 'applied', 'compensating', 'compensated', 'failed', 'parked')),
				detail      text,
				updated_at  timestamptz not null,
				primary key (op_key, idx)
			)`,
	},
	// Steering delivery order and durable command keys (phase 77, L77-01 to L77-04). Every queued row takes the directive's
	// delivery sequence, so the order a restart restores is the order the inbox gave, and the sequence never ties across a
	// restart. A keyed command stores its caller surface, key and request fingerprint on its row, so the unique key
	// `(transition, surface, key)` is the durable index a replay is answered from after a restart. Null on every unkeyed row.
	// Additive and idempotent: nullable columns and a partial unique index, no existing row touched. Rows written before this
	// step keep a null sequence and no key. OPERATORS: rehearse on a restored dump before production, like steps 33 to 34.
	{
		version: 44,
		name: "planning_steering_audit_delivery",
		optIn: "steering-audit",
		phase: "expand",
		down: `drop index if exists planning_steering_audit_idempotency_key; alter table planning_steering_audit drop column if exists idempotency_fingerprint; alter table planning_steering_audit drop column if exists idempotency_key; alter table planning_steering_audit drop column if exists idempotency_surface; alter table planning_steering_audit drop column if exists delivery_sequence`,
		sql: `
			alter table planning_steering_audit
				add column if not exists delivery_sequence bigint
				constraint planning_steering_audit_delivery_sequence_check check (
					delivery_sequence is null or (transition = 'queued' and delivery_sequence >= 1)
				);
			alter table planning_steering_audit add column if not exists idempotency_surface text;
			alter table planning_steering_audit add column if not exists idempotency_key text;
			alter table planning_steering_audit
				add column if not exists idempotency_fingerprint text
				constraint planning_steering_audit_idempotency_check check (
					(idempotency_key is null) = (idempotency_surface is null)
					and (idempotency_key is null) = (idempotency_fingerprint is null)
				);
			create unique index if not exists planning_steering_audit_idempotency_key
				on planning_steering_audit (transition, idempotency_surface, idempotency_key)
				where idempotency_key is not null`,
	},
	// Steering session movements (phase 77 replays, phase 67 restart hint): the committed result of the session-state step of
	// each acknowledgement. One row per acknowledged directive, written once after the session port answers, and never updated.
	// `session_status` is the reply's `session_state` status: `applied` is a movement the session committed (the one fact a
	// `checkpoint_hint` rests on), `unchanged` and `refused` moved nothing. `checkpoint_hint` records whether the reply named a
	// hint, so a restored listing and a replayed reply say what the first one said. Keyed on the directive, not the key, so it
	// serves restart listings too. Opt-in with step 33: it is written only while the audit table is on.
	// Additive and idempotent: one new table and its checks. An acknowledgement with no row (a crash between the audit row and
	// this write) carries no session state and no hint after a restart, which fails safe. OPERATORS: rehearse on a restored dump
	// before production, like steps 33 to 34.
	{
		version: 45,
		name: "planning_steering_movements",
		optIn: "steering-audit",
		phase: "expand",
		down: `drop table if exists planning_steering_movements`,
		sql: `
			create table if not exists planning_steering_movements (
				directive_id     text primary key,
				session_status   text not null check (session_status in ('unchanged', 'applied', 'refused')),
				session_state    text check (session_state in ('ACTIVE', 'CONTEXT_REFRESH', 'PAUSED', 'RESUMED')),
				refusal_reason   text,
				checkpoint_hint  boolean not null,
				recorded_at      timestamptz not null,
				constraint planning_steering_movements_shape check (
					(session_status = 'unchanged' and session_state is null and refusal_reason is null and not checkpoint_hint)
					or (session_status = 'applied' and session_state is not null and refusal_reason is null)
					or (session_status = 'refused' and session_state is not null and refusal_reason is not null and not checkpoint_hint)
				)
			)`,
	},
	// Corpus marker path (phase 66 closure): the explicit supersession marker of a document, a repo-relative path. It takes its
	// own column because `superseded_by` (step 38) is also the citation field's name for a document key. The rename is an
	// expand: a rename is not additive and the rollback contract forbids it, so the old column stays, unread and unwritten,
	// until a later contract step drops it. No backfill: the manifest is rebuilt by the corpus scan, and a row whose marker
	// differs from its stored value is rewritten on the next ingest. Always run (no opt-in), like step 35.
	// OPERATORS: rehearse on a restored dump before production, like steps 35 to 38.
	{
		version: 46,
		name: "corpus_documents_superseded_by_path",
		phase: "expand",
		down: `alter table corpus_documents drop column if exists superseded_by_path`,
		sql: `alter table corpus_documents add column if not exists superseded_by_path text`,
	},
	// Forget time (v1.8 phase 78, the index-to-ledger direction of the cross-layer reconcile). A forget sets `superseded_by` to its
	// marker and nothing else records when it happened, so an index forget could not be windowed against the ledger's `memory.forget`
	// notes. `markMemoryForgotten` sets the column. A row forgotten before this step has no time, so it is in no window and the
	// reconcile does not judge it. OPERATORS: rehearse this step on a restored dump before applying it to production.
	{
		version: 47,
		name: "memory_entries_forgotten_at",
		phase: "expand",
		down: `alter table memory_entries drop column if exists forgotten_at`,
		sql: `
			alter table memory_entries add column if not exists forgotten_at timestamptz;
			create index if not exists memory_forgotten_at_idx on memory_entries (forgotten_at) where forgotten_at is not null`,
	},
	// Forgotten-at index built without a table lock (v1.8 phase 78, after step 47). Step 47 builds the same index non-concurrently
	// inside its transaction, which holds ACCESS EXCLUSIVE on `memory_entries` for the build. This step builds it CONCURRENTLY, outside
	// any transaction (`transactional: false`), and is a no-op where a valid index already exists. A failed concurrent build leaves an
	// INVALID index that `if not exists` would skip. This step never drops an index: it raises when it finds one INVALID, so the migration
	// is refused and nothing is skipped silently. The operator drops that index by hand (docs/runbooks/rollback-compat.md, "forget time"), then
	// restarts; the build below then runs. The ledger row is written after the build succeeds, so a failure is retried on the next boot.
	// Step 47 is unchanged: its text is digest-pinned.
	// OPERATORS: the build can outlast migrate's statement_timeout on a large table; then it fails and leaves an invalid index, and every
	// boot refuses until an operator runs `drop index concurrently if exists memory_forgotten_at_idx`. Rehearse on a restored dump before production.
	{
		version: 48,
		name: "memory_entries_forgotten_at_index_concurrent",
		transactional: false,
		phase: "expand",
		down: `drop index if exists memory_forgotten_at_idx`,
		sql: `
			do $$
			begin
				if exists (
					select 1
					from pg_index
					join pg_class on pg_class.oid = pg_index.indexrelid
					where pg_class.relname = 'memory_forgotten_at_idx' and not pg_index.indisvalid
				) then
					raise exception 'memory_forgotten_at_idx is INVALID after a failed concurrent build; the migration is refused until an operator drops it: drop index concurrently if exists memory_forgotten_at_idx (see docs/runbooks/rollback-compat.md, forget time)';
				end if;
			end
			$$;
			create index concurrently if not exists memory_forgotten_at_idx on memory_entries (forgotten_at) where forgotten_at is not null`,
	},
	// Context matrix entries: one row per candidate decision, fact, warning or todo extracted from a planning source document.
	// A row is written as `candidate` and moves to `accepted` or `superseded`; `superseded_by` names the entry that replaced it.
	// `source_sha256` is the digest of the source file the row was extracted from. Additive: one new table and two indexes.
	// Writes no rows and changes no existing row. Rollback (additive table, no data migration): DROP TABLE IF EXISTS context_matrix_entries.
	// OPERATORS: rehearse on a restored dump before production, like the other expand steps.
	{
		version: 49,
		name: "context_matrix_entries",
		phase: "expand",
		down: `drop table if exists context_matrix_entries`,
		sql: `
			create table if not exists context_matrix_entries (
				entry_id         text primary key,
				realm            text not null default 'default',
				milestone        text not null,
				phase            text not null,
				source_path      text not null,
				source_sha256    text not null,
				entry_kind       text not null check (entry_kind in ('decision', 'fact', 'warning', 'todo')),
				body_redacted    text not null,
				status           text not null default 'candidate' check (status in ('candidate', 'accepted', 'superseded')),
				superseded_by    text null,
				created_at       timestamptz not null default now()
			);
			create index if not exists context_matrix_entries_realm_milestone_phase_idx
				on context_matrix_entries (realm, milestone, phase);
			create index if not exists context_matrix_entries_source_sha256_idx
				on context_matrix_entries (source_sha256)`,
	},
];

/** The steps `migrate()` runs for these opt-ins, in version order. A step whose opt-in is off is left out and not ledgered. */
export function applicableMigrationSteps(optIns: MigrationOptIns): ReadonlyArray<(typeof MIGRATION_STEPS)[number]> {
	return MIGRATION_STEPS.filter((step) => step.optIn === undefined || optIns[step.optIn]);
}

/**
 * The statements of a step's `sql`, split on `;` outside `'…'` literals and `$tag$…$tag$` bodies, so a `do $$ … $$` block stays
 * whole. Each is trimmed and empty ones are dropped. A non-transactional step is sent one statement at a time with this: a
 * multi-statement simple query runs as one implicit transaction, and `create index concurrently` refuses to run inside one.
 */
export function migrationStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	for (const token of sql.match(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|[\s\S]/g) ?? []) {
		if (token === ";") {
			statements.push(current);
			current = "";
		} else current += token;
	}
	statements.push(current);
	return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * Not ledgered. Step 39 creates `planning_page_hashes` with primary key `(destination, path)`. A database that applied
 * an earlier path-only key still has that key, and `ON CONFLICT (destination, path)` does not catch it. Drop that old
 * table and recreate it. A fresh database already has `destination` in the primary key, so the drop does not run.
 */
export const PLANNING_HASH_TABLE_REPAIR = `
	do $$
	begin
		if to_regclass('planning_page_hashes') is not null
			and not exists (
				select 1
				from pg_constraint
				join pg_attribute
					on pg_attribute.attrelid = pg_constraint.conrelid
					and pg_attribute.attnum = any (pg_constraint.conkey)
				where pg_constraint.conrelid = to_regclass('planning_page_hashes')
					and pg_constraint.contype = 'p'
					and pg_attribute.attname = 'destination'
			) then
			drop table planning_page_hashes;
		end if;
	end
	$$;
	create table if not exists planning_page_hashes (
		destination text not null,
		path        text not null,
		sha256      text not null,
		updated_at  timestamptz not null default now(),
		primary key (destination, path)
	);
	create unique index if not exists planning_page_hashes_destination_path_idx on planning_page_hashes (destination, path);
`;


export class IndexStore implements MemoryStore {
	private readonly sql: SQL;
	private readonly gate: PlaneGate | null;
	private readonly expiry: MemoryExpirySettings;
	readonly poolSettings: IndexPoolSettings;
	/** `SUBSTRATE_INDEX_TUNE`: `apply` runs {@link IndexStore.tuneGraphNodes} at the end of `migrate()`; `off` (the default) never alters a table. */
	readonly tune: "off" | "apply";
	/** The opt-in migrations `migrate()` runs. Every opt-in off by default, so a gated step is neither run nor ledgered. */
	readonly migrationOptIns: MigrationOptIns;

	constructor(connectionString: string, options: IndexStoreOptions = {}) {
		this.poolSettings = { ...indexPoolSettingsFromEnv(), ...options.pool, applicationName: INDEX_APPLICATION_NAME };
		this.sql = options.sql ?? new SQL(connectionString, indexSqlOptions(this.poolSettings));
		this.gate = options.gate ?? null;
		this.expiry = options.memoryExpiry ?? { mode: "report" };
		this.tune = options.tune ?? "off";
		this.migrationOptIns = options.migrationOptIns ?? MIGRATION_OPT_INS_OFF;
	}

	/** One index call under the plane gate. Without a gate it is just `fn()`. */
	private plane<T>(op: string, fn: () => Promise<T>): Promise<T> {
		return callPlane(this.gate, op, fn, { isFailure: isStoreFailure });
	}

	/**
	 * The cross-repository operation log over this store's pool (phase 74): the operation and per-repository step state a
	 * branch fan-out writes before each effect. It only builds the adapter; no statement runs until an operation uses it, and
	 * the tables are created by migration step 43.
	 */
	crossRepoStore(): CrossRepoStore {
		return new PgCrossRepoStore(this.sql, (op, fn) => this.plane(op, fn));
	}

	/**
	 * The steering audit sink over this store's pool (phase 58, live steering): the append-only `planning_steering_audit`
	 * writes and the bounded reads that restore the inbox after a restart. It only builds the sink; no statement runs until
	 * the inbox uses it, and the table exists only when the `steering-audit` opt-in ran its migration steps.
	 */
	steeringAudit(): SteeringAuditSink {
		return new SteeringAuditSink(bunSteeringAuditSql(this.sql), bunSteeringAuditReadSql(this.sql));
	}

	/**
	 * The corpus manifest over this store's pool (v1.7 phase 63). It only builds the store; no statement runs until the
	 * corpus service uses it, and the table exists after migration step 35.
	 */
	corpusStore(): CorpusStore {
		return bunCorpusStore(this.sql);
	}

	/** Mandatory durable security authority over this pool; historical restart-cache rows cannot grant access. */
	liveSessions(options: { leaseSeconds: number }): LiveSessionAuthority {
		return bunLiveSessionAuthority(this.sql, options);
	}

	/**
	 * The worktree registry over this store's pool (phase 68): the upsert-and-sweep report and the filtered listing. It only
	 * builds the adapter; no statement runs until a report or a listing is served, and the table is created by step 36.
	 */
	worktreeRegistry(): WorktreeRegistryStore {
		return new PgWorktreeRegistry(this.sql, (op, fn) => this.plane(op, fn));
	}

	/**
	 * The planning refresh's page hashes over this store's pool (v1.7 phase 65). `destination` is a hash of the configured
	 * docs URL. It only builds the store; no statement runs until the refresh loads it, and the table exists after migration step 39.
	 */
	planningHashStore(destination: string): PlanningHashStore {
		const sql = this.sql;
		return bunPlanningHashStore((strings, ...values) => sql(strings, ...values), destination);
	}

	/**
	 * Retrieval telemetry, feedback and the gap aggregate over this store's pool (v1.7 phase 66). It only builds the store; no
	 * statement runs until the docs reflect code uses it, and the tables exist after migration step 38.
	 */
	reflectStore(): ReflectStore {
		return bunReflectStore(this.sql);
	}

	/**
	 * Idempotent DDL, run on boot. One reserved connection holds a session advisory
	 * lock so two boots cannot deadlock on `CREATE INDEX`. Versions already in
	 * `schema_migrations` are skipped; a missing version still runs, so an index
	 * that booted before the ledger still receives later statements.
	 * A table lock that stays busy longer than {@link INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS} rejects `migrate` with Postgres' lock-timeout error; the caller reports it and boot continues.
	 */
	async migrate(): Promise<void> {
		const reserved = await this.sql.reserve();
		let migrateFailed = false;
		let unlockFailure: { cause: unknown } | undefined;
		try {
			// SET does not accept bind parameters. The timeouts are numeric constants.
			await reserved.unsafe(`SET lock_timeout = ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`);
			await reserved.unsafe(`SET statement_timeout = ${INDEX_MIGRATE_LOCK_TIMEOUT_MS}`);
			await reserved`select pg_advisory_lock(hashtextextended(${indexMigrateLockKey()}::text, 0))`;
			// The DDL below takes table locks. Bound each wait for one here: the advisory lock's 180s is for two boots, not for a table.
			await reserved.unsafe(`SET lock_timeout = ${INDEX_MIGRATE_DDL_LOCK_TIMEOUT_MS}`);
			await reserved.unsafe(`SET statement_timeout = ${INDEX_MIGRATE_STATEMENT_TIMEOUT_MS}`);
			await reserved`
				create table if not exists schema_migrations (
					version int primary key,
					name text not null,
					applied_at timestamptz not null default now()
				)`;
			for (const step of applicableMigrationSteps(this.migrationOptIns)) {
				const present = await reserved`select version from schema_migrations where version = ${step.version}`;
				if (present.length > 0) continue;
				if (step.transactional === false) {
					// Outside any transaction: each statement is sent alone (see migrationStatements). The DDL lock_timeout set above applies.
					for (const statement of migrationStatements(step.sql)) await reserved.unsafe(statement);
					await reserved`insert into schema_migrations (version, name) values (${step.version}, ${step.name})`;
					continue;
				}
				await reserved`begin`;
				try {
					await reserved.unsafe(step.sql);
					await reserved`insert into schema_migrations (version, name) values (${step.version}, ${step.name})`;
					await reserved`commit`;
				} catch (cause) {
					try {
						await reserved`rollback`;
					} catch {
						// The session may already be aborted; the statement error is the one to surface.
					}
					throw cause;
				}
			}
			// Not ledgered. A database can regain this index after the first boot (an old
			// unique index on `(entry_hash, state)` rejects a second approval). `IF EXISTS`
			// makes every later boot a no-op once it is gone.
			await reserved.unsafe(`drop index if exists memory_reviews_hash_idx`);
			// Not ledgered. See {@link PLANNING_HASH_TABLE_REPAIR}.
			await reserved.unsafe(PLANNING_HASH_TABLE_REPAIR);
		} catch (cause) {
			migrateFailed = true;
			throw cause;
		} finally {
			try {
				await reserved`select pg_advisory_unlock(hashtextextended(${indexMigrateLockKey()}::text, 0))`;
				await reserved.unsafe("RESET lock_timeout");
				await reserved.unsafe("RESET statement_timeout");
				reserved.release();
			} catch (cause) {
				// A failed unlock leaves the session lock on this connection. Returning it
				// to the pool would pin that lock for the next borrower, so discard it.
				try {
					await reserved.close({ timeout: 0 });
				} catch {
					// Already dead. The session lock dies with the connection.
				}
				unlockFailure = { cause };
			}
		}
		// Reached only when the migration itself succeeded: a failed migration's error is already propagating.
		if (unlockFailure !== undefined) throw unlockFailure.cause;
		// After the reserved connection is back in the pool. `tuneGraphNodes` uses
		// `this.sql`, so running it while `reserve()` holds the only connection
		// (`SUBSTRATE_PG_POOL_MAX=1`) waits on itself and boot never finishes.
		if (!migrateFailed) {
			// Opt-in, once: a failed tune must not stop the service booting on a schema that is already complete.
			if (this.tune === "apply") {
				try {
					await this.tuneGraphNodes();
				} catch (cause) {
					process.stderr.write(`[substrate] index tune not applied: ${redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 200)}\n`);
				}
			}
		}
	}

	// ── graph ──────────────────────────────────────────────────────────────────

	/** Upsert a whole graph. Idempotent by Graph ID, so a re-run never duplicates. */
	async registerGraph(plan: {
		graph_id: string;
		notion_task_page?: string | null | undefined;
		repo?: string | null | undefined;
		branch?: string | null | undefined;
		surface?: Surface | null | undefined;
		status?: string | null | undefined;
		pr_url?: string | null | undefined;
		// The plan arrives parsed from a tool call, whose absent fields may be `undefined`.
		nodes?: Array<{ [K in keyof GraphNode]?: GraphNode[K] | undefined } & { node_id: string }> | undefined;
		steps?: Array<{ [K in keyof GraphStep]?: GraphStep[K] | undefined } & { node_id: string; step: number }> | undefined;
		edges?: Array<{ from_node: string; to_node: string; kind: EdgeKind }> | undefined;
	}): Promise<GraphView & { removed: GraphEdge[] }> {
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
		// `removed` is what this replace dropped: the edges stored before it that are absent from the new set. The
		// caller takes the matching Linear relations down with them. Empty when `edges` is absent.
		let removed: GraphEdge[] = [];
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
				const before = (await tx`
					select graph_id, from_node, to_node, kind from graph_edges where graph_id = ${plan.graph_id}`) as GraphEdge[];
				await tx`delete from graph_edges where graph_id = ${plan.graph_id}`;
				for (const edge of edges) {
					await tx`
						insert into graph_edges (graph_id, from_node, to_node, kind)
						values (${plan.graph_id}, ${edge.from_node}, ${edge.to_node}, ${edge.kind})
						on conflict (graph_id, from_node, to_node, kind) do nothing`;
				}
				const kept = new Set(edges.map((edge) => JSON.stringify([edge.from_node, edge.to_node, edge.kind])));
				removed = before.filter((edge) => !kept.has(JSON.stringify([edge.from_node, edge.to_node, edge.kind])));
			});
		}

		const view = await this.getGraph(plan.graph_id);
		if (!view) throw new Error(`graph ${plan.graph_id} vanished after register`);
		return { ...view, removed };
	}

	async getGraph(graphId: string): Promise<GraphView | null> {
		return this.plane("graph.get", async () => {
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
		});
	}

	/**
	 * The graph as a brief reads it (uplift-5 U5-3, `SUBSTRATE_BRIEF_GRAPH_READ=lite`): the
	 * `graph_index` row and the `graph_nodes` rows, issued together, with `steps` and `edges`
	 * left empty. The brief prints status, surface, pr_url and the nodes and nothing else, so two
	 * statements in one round trip replace `getGraph`'s four in sequence, and the view is
	 * `openGraphs`' own shape. Same answers as `getGraph` where the brief looks: no row is `null`
	 * (whatever the nodes read did), a failed index read throws, and a failed node read throws
	 * only when there is a row to attach its nodes to.
	 */
	async getGraphForBrief(graphId: string): Promise<GraphView | null> {
		return this.plane("graph.brief", async () => {
			const [indexRead, nodesRead] = await Promise.allSettled([
				this.sql`select * from graph_index where graph_id = ${graphId}`,
				this.sql`select * from graph_nodes where graph_id = ${graphId} order by node_id`,
			]);
			if (indexRead.status === "rejected") throw indexRead.reason;
			const row = (indexRead.value as GraphIndexRow[])[0];
			if (!row) return null;
			if (nodesRead.status === "rejected") throw nodesRead.reason;
			return { ...row, nodes: (nodesRead.value as GraphNode[]).map(toNode), steps: [], edges: [] };
		});
	}

	/**
	 * Graphs in a repo that are not finished — what "who else is working here" means.
	 *
	 * Two round trips, however many graphs are open: one `graph_index` select for
	 * the (at most ten) open rows, then one `graph_nodes` select for all of them,
	 * grouped per graph here. The brief runs this under a shared budget, and in
	 * production every round trip crosses a public proxy — a query per open graph
	 * spent the whole budget on nodes alone. Zero open graphs means one trip. Per
	 * graph the nodes keep `node_id` order; a graph with no nodes has `nodes: []`.
	 */
	async openGraphs(repo: string, excludeGraphId?: string): Promise<GraphView[]> {
		return this.plane("graph.open", async () => {
			const rows = (await this.sql`
				select * from graph_index
				where repo = ${repo}
				  and (status is null or status not in ${this.sql(TERMINAL_STATUSES)})
				  and (${excludeGraphId ?? null}::text is null or graph_id <> ${excludeGraphId ?? null})
				order by updated desc
				limit 10`) as GraphIndexRow[];
			if (rows.length === 0) return [];
			const ids = rows.map((row) => row.graph_id);
			// The list helper, as above for the statuses: handing the driver a bare
			// array stringifies it into a literal Postgres rejects.
			const nodeRows = (await this.sql`
				select * from graph_nodes where graph_id in ${this.sql(ids)} order by graph_id, node_id`) as GraphNode[];
			const nodesByGraph = new Map<string, GraphNode[]>();
			for (const node of nodeRows) {
				const list = nodesByGraph.get(node.graph_id);
				if (list) list.push(toNode(node));
				else nodesByGraph.set(node.graph_id, [toNode(node)]);
			}
			return rows.map((row) => ({ ...row, nodes: nodesByGraph.get(row.graph_id) ?? [], steps: [], edges: [] }));
		});
	}

	// ── leases ─────────────────────────────────────────────────────────────────

	/**
	 * One node as stored, or null when it is unknown. Unlike `getNode` this
	 * throws on a database failure, so completion gating can tell "no such
	 * node" (fall through to the fenced path, which refuses in its own words)
	 * from "the read failed" (refuse: an unread node must never complete
	 * without the gate that a Linear reference would require).
	 */
	async readNode(graphId: string, nodeId: string): Promise<GraphNode | null> {
		const rows = (await this.sql`
			select * from graph_nodes where graph_id = ${graphId} and node_id = ${nodeId}`) as GraphNode[];
		const row = rows[0];
		return row ? toNode(row) : null;
	}

	private async node(graphId: string, nodeId: string): Promise<GraphNode> {
		const found = await this.readNode(graphId, nodeId);
		if (!found) throw new UnknownNode(graphId, nodeId);
		return found;
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
	 *
	 * `caller` is the token's surface, null on an anonymous run. A claim naming
	 * the current holder from another surface's token is denied `not-holder`
	 * without touching the row: renewing is the holder's act, not anyone's who
	 * can read its public session id.
	 */
	async claimNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
		caller: Surface | null,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<{ claimed: boolean; node: GraphNode; lease: LeaseView; decision: ClaimDecision }> {
		return this.plane("lease.claim", () => this.claimNodeUnguarded(graphId, nodeId, surface, sessionId, caller, ttlSeconds));
	}

	private async claimNodeUnguarded(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
		caller: Surface | null,
		ttlSeconds: number,
	): Promise<{ claimed: boolean; node: GraphNode; lease: LeaseView; decision: ClaimDecision }> {
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const request = { surface, session_id: sessionId, ttl_seconds: ttl, caller };
		let node = await this.node(graphId, nodeId);

		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			const decision = decideClaim(leaseSnapshot(node), request, Date.now());

			if (!decision.granted) {
				// Re-read before reporting a refusal: the lease may have lapsed between
				// the read and the decision, and telling an agent it is blocked by a
				// holder that is already gone is the drift this whole feature removes.
				node = await this.node(graphId, nodeId);
				if (decideClaim(leaseSnapshot(node), request, Date.now()).granted) {
					continue;
				}
				// The public view: the loser learns who holds it and until when, never the id.
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
			if (updated) return { claimed: true, node: toNode(updated), lease: holderLeaseView(leaseSnapshot(updated)), decision };

			// Lost the race, or the server disagreed about expiry. Look again.
			node = await this.node(graphId, nodeId);
		}

		return {
			claimed: false,
			node,
			lease: leaseView(leaseSnapshot(node)),
			decision: decideClaim(leaseSnapshot(node), request, Date.now()),
		};
	}

	/**
	 * Extend a lease this holder still holds.
	 *
	 * Fenced on `lease_id`: a holder whose lease lapsed and was taken over cannot
	 * extend the lease that replaced it, because the id it remembers is gone. The
	 * expiry predicate is the server's, for the same reason as in `claimNode`.
	 *
	 * `caller` is the token's surface (null on an anonymous run), and the holder
	 * check is made against the observed row only. That is enough without a
	 * `claimed_by` predicate in the UPDATE: a change of holder always mints a new
	 * lease id, so the `lease_id` fence already pins the holder the decision saw.
	 */
	async heartbeatNode(
		graphId: string,
		nodeId: string,
		leaseId: string,
		caller: Surface | null,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<{ ok: boolean; node: GraphNode; lease: LeaseView; decision: HeartbeatDecision }> {
		return this.plane("lease.heartbeat", () => this.heartbeatNodeUnguarded(graphId, nodeId, leaseId, caller, ttlSeconds));
	}

	private async heartbeatNodeUnguarded(
		graphId: string,
		nodeId: string,
		leaseId: string,
		caller: Surface | null,
		ttlSeconds: number,
	): Promise<{ ok: boolean; node: GraphNode; lease: LeaseView; decision: HeartbeatDecision }> {
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const request = { lease_id: leaseId, ttl_seconds: ttl, caller };
		const observed = await this.node(graphId, nodeId);
		const decision = decideHeartbeat(leaseSnapshot(observed), request, Date.now());
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
		if (updated) return { ok: true, node: toNode(updated), lease: holderLeaseView(leaseSnapshot(updated)), decision };

		// The statement matched nothing, so the lease went between the read and the
		// write. Report what is true now rather than the decision that is no longer.
		const fresh = await this.node(graphId, nodeId);
		return {
			ok: false,
			node: fresh,
			lease: leaseView(leaseSnapshot(fresh)),
			decision: decideHeartbeat(leaseSnapshot(fresh), request, Date.now()),
		};
	}

	/**
	 * One node as stored, or null when it is unknown. A read for completion
	 * gating (does the node link Linear, who holds it); never a write.
	 */
	async getNode(graphId: string, nodeId: string): Promise<GraphNode | null> {
		return this.node(graphId, nodeId).catch(() => null);
	}

	/**
	 * The registered nodes behind a Linear reference, for `graph_find`. The
	 * id is matched first, then the identifier; each query stops at 2 rows,
	 * which is all an ambiguity report needs. Never a write.
	 */
	async findNodesByLinear(ref: { linearIssueId?: string; linearIdentifier?: string }): Promise<LinearNodeMatch[]> {
		if (ref.linearIssueId) {
			const rows = (await this.sql`
				select n.*, g.repo, g.branch, g.status as graph_status
				from graph_nodes n join graph_index g on g.graph_id = n.graph_id
				where n.linear_issue_id = ${ref.linearIssueId}
				limit 2`) as LinearNodeMatch[];
			if (rows.length > 0) return rows.map(toLinearNodeMatch);
		}
		if (!ref.linearIdentifier) return [];
		return (
			(await this.sql`
			select n.*, g.repo, g.branch, g.status as graph_status
			from graph_nodes n join graph_index g on g.graph_id = n.graph_id
			where n.linear_identifier = ${ref.linearIdentifier}
			limit 2`) as LinearNodeMatch[]
		).map(toLinearNodeMatch);
	}

	/**
	 * Mark a node under review for the DoD gate, in one fenced statement.
	 *
	 * The only new state write of the claim-mirror phase: it sets
	 * `started_review` under the caller's lease — fenced on `lease_id`,
	 * unexpired, with the holder check `decideHeartbeat` makes — and extends
	 * the lease by the TTL, because the gate may take up to 35 s. A refusal
	 * (`not-holder`, `lost`, `expired`, `unheld`) returns the heartbeat refusal
	 * shape and writes nothing, including no tracker.
	 */
	async reviewNode(
		graphId: string,
		nodeId: string,
		leaseId: string,
		caller: Surface | null,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<{ ok: boolean; node: GraphNode; lease: LeaseView; decision: HeartbeatDecision }> {
		return this.plane("lease.review", () => this.reviewNodeUnguarded(graphId, nodeId, leaseId, caller, ttlSeconds));
	}

	private async reviewNodeUnguarded(
		graphId: string,
		nodeId: string,
		leaseId: string,
		caller: Surface | null,
		ttlSeconds: number,
	): Promise<{ ok: boolean; node: GraphNode; lease: LeaseView; decision: HeartbeatDecision }> {
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const request = { lease_id: leaseId, ttl_seconds: ttl, caller };
		const observed = await this.node(graphId, nodeId);
		const decision = decideHeartbeat(leaseSnapshot(observed), request, Date.now());
		if (!decision.ok) return { ok: false, node: observed, lease: leaseView(leaseSnapshot(observed)), decision };

		const rows = (await this.sql`
			update graph_nodes set
				state = 'started_review',
				lease_heartbeat_at = now(),
				lease_expires_at   = now() + make_interval(secs => ${ttl})
			where graph_id = ${graphId} and node_id = ${nodeId}
			  and lease_id = ${leaseId}
			  and coalesce(lease_expires_at, claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS})) > now()
			returning *`) as GraphNode[];

		const updated = rows[0];
		if (updated) return { ok: true, node: toNode(updated), lease: holderLeaseView(leaseSnapshot(updated)), decision };

		// The statement matched nothing, so the lease went between the read and
		// the write. Report what is true now rather than the decision that is
		// no longer.
		const fresh = await this.node(graphId, nodeId);
		return {
			ok: false,
			node: fresh,
			lease: leaseView(leaseSnapshot(fresh)),
			decision: decideHeartbeat(leaseSnapshot(fresh), request, Date.now()),
		};
	}

	/**
	 * Drop the lease on a node.
	 *
	 * `lease_id` fences it: a stale holder cannot release — or, through
	 * `completeNode`, close — a node that someone else has since claimed. `force`
	 * is the operator's lever for a holder that is gone, and is reported as a
	 * forced release rather than an ordinary one. `caller` is the token's surface,
	 * held to the holder's as in `heartbeatNode`.
	 */
	async releaseNode(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean },
		caller: Surface | null,
		/** Written in the same statement as the release, for `completeNode`. */
		alsoSetState?: NodeState,
	): Promise<{ released: boolean; node: GraphNode; decision: ReleaseDecision }> {
		return this.plane("lease.release", () => this.releaseNodeUnguarded(graphId, nodeId, request, caller, alsoSetState));
	}

	private async releaseNodeUnguarded(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean },
		caller: Surface | null,
		alsoSetState?: NodeState,
	): Promise<{ released: boolean; node: GraphNode; decision: ReleaseDecision }> {
		const observed = await this.node(graphId, nodeId);
		const decision = decideRelease(leaseSnapshot(observed), { ...request, caller }, Date.now());
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
	 * a node it wanted is free again. The list names the epoch, not the lease id:
	 * it goes to whoever asked and into the ledger, and neither is the holder.
	 */
	async reapExpiredLeases(
		repo?: string | null,
	): Promise<Array<{ graph_id: string; node_id: string; linear_issue_id: string | null; linear_identifier: string | null; notion_page: string | null; holder: LeaseHolder | null; lease_epoch: number; expired_at: string | null }>> {
		return this.plane("lease.reap", () => this.reapExpiredLeasesUnguarded(repo));
	}

	private async reapExpiredLeasesUnguarded(
		repo?: string | null,
	): Promise<Array<{ graph_id: string; node_id: string; linear_issue_id: string | null; linear_identifier: string | null; notion_page: string | null; holder: LeaseHolder | null; lease_epoch: number; expired_at: string | null }>> {
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
			select graph_id, node_id, linear_issue_id, linear_identifier, notion_page,
			       claimed_by, claim_session, lease_id, lease_epoch,
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
			linear_issue_id: row.linear_issue_id === null ? null : String(row.linear_issue_id),
			linear_identifier: row.linear_identifier === null ? null : String(row.linear_identifier),
			notion_page: row.notion_page === null ? null : String(row.notion_page),
			holder: row.claimed_by ? { surface: row.claimed_by as Surface, session_id: String(row.claim_session ?? "") } : null,
			lease_epoch: Number(row.lease_epoch ?? 0),
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

	// There is deliberately no `setNodeState`.
	//
	// It was the unconditional state write that made a completion unfenced, and it
	// has no caller left: `releaseNode` writes the state inside the same guarded
	// UPDATE that proves the hold. Leaving it exported would leave the hazard one
	// call away — the next thing that needs to write a node's state would reach for
	// it and lose the fence again, which is exactly how the completion path came to
	// mark a second agent's live node completed. A state write that cannot name the
	// lease it is writing under does not belong on this store.

	async setGraphStatus(graphId: string, status: string, prUrl?: string | null): Promise<void> {
		await this.sql`
			update graph_index set status = ${status}, pr_url = coalesce(${prUrl ?? null}, pr_url), updated = now()
			where graph_id = ${graphId}`;
	}

	// ── correlation bindings ───────────────────────────────────────────────────

	/**
	 * Bind a correlation id to a Graph ID, or report the Graph ID it is already bound to.
	 *
	 * `insert … on conflict do nothing` rather than select-then-insert: the unique key is
	 * the arbiter, so of two concurrent binds exactly one inserts (`created`) and the other
	 * waits on the winner's commit, inserts nothing and reads the stored row (`existing`).
	 * The returned `graph_id` is always the stored one; `conflict` says it is not the one
	 * offered, and the caller must adopt it.
	 */
	async bindCorrelation(correlationId: string, graphId: string, boundBy: string | null): Promise<GraphBindResult> {
		// A second pass is only ever needed if the winning row vanished between the insert
		// and the read, which nothing in this codebase does — bounded rather than assumed.
		for (let attempt = 0; attempt < 3; attempt++) {
			const inserted = (await this.sql`
				insert into graph_bindings (correlation_id, graph_id, bound_by)
				values (${correlationId}, ${graphId}, ${boundBy})
				on conflict (correlation_id) do nothing
				returning graph_id`) as Array<{ graph_id: string }>;
			if (inserted[0]) {
				return { status: "created", correlation_id: correlationId, graph_id: inserted[0].graph_id, conflict: false };
			}
			const stored = await this.graphForCorrelation(correlationId);
			if (stored !== null) {
				return { status: "existing", correlation_id: correlationId, graph_id: stored, conflict: stored !== graphId };
			}
		}
		throw new Error(`correlation ${correlationId} could be neither bound nor read back`);
	}

	/** The Graph ID a correlation id is bound to, or null. */
	async graphForCorrelation(correlationId: string): Promise<string | null> {
		const rows = (await this.sql`
			select graph_id from graph_bindings where correlation_id = ${correlationId}`) as Array<{ graph_id: string }>;
		return rows[0]?.graph_id ?? null;
	}

	/** Every correlation id bound to a Graph ID, oldest first. */
	async correlationsForGraph(graphId: string): Promise<string[]> {
		const rows = (await this.sql`
			select correlation_id from graph_bindings
			where graph_id = ${graphId}
			order by created, correlation_id`) as Array<{ correlation_id: string }>;
		return rows.map((row) => row.correlation_id);
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
		alsoEntryHash?: string | null;
		alsoRequestHash?: string | null;
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
			const alsoRequest = input.alsoRequestHash ?? null;
			const sameAsk =
				heldFor !== undefined && (heldFor === input.requestHash || (alsoRequest !== null && heldFor === alsoRequest));

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
			const alsoEntry = input.alsoEntryHash ?? null;
			const reservationIsOurs =
				reservedHash === undefined ||
				reservedHash === input.entryHash ||
				(alsoEntry !== null && reservedHash === alsoEntry);
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
	 *
	 * The insert itself is `on conflict … do nothing` over `memory_standing_idx`, which
	 * is what makes a *first* write for an identity safe to race. Two writers under
	 * different keys both read no standing entry, so neither retires anything and
	 * neither `standing-moved` check fires; without the clause the second insert raised
	 * a duplicate key, the gate could not tell a rolled-back statement from a committed
	 * one, and it held the loser's idempotency key in flight until the takeover timeout
	 * — blocking the retry the answer was asking for. With it, the loser blocks on the
	 * index until the winner commits and then writes nothing and says `standing-exists`,
	 * which the gate reports as an ordinary conflict and the loser can retry at once.
	 */
	async insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<
		{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" | "standing-exists" }
	> {
		try {
			return await this.insertEntryTx(row, claim);
		} catch (cause) {
			// Rolled back by the throw that carried it out of the transaction — which is
			// the point of throwing rather than returning: a `do nothing` insert leaves the
			// retire above it committable, and committing a retire whose replacement never
			// landed would take the standing entry out of force and put nothing in its place.
			if (cause instanceof StandingTaken) return { ok: false as const, reason: "standing-exists" as const };
			throw cause;
		}
	}

	/** The transaction itself. It never *returns* `standing-exists` — it throws it. */
	private async insertEntryTx(
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
				-- The arbiter is memory_standing_idx, named by restating its predicate.
				-- What it catches is an identity this write believed free — usually one with
				-- no predecessor to retire, so nothing above it fired — that another writer
				-- filled first.
				on conflict (conflict_key) where conflict_key is not null and superseded_by is null
				do nothing
				returning *`) as Array<Record<string, unknown>>;
			if (!inserted[0]) throw new StandingTaken();
			return { ok: true as const, entry: toMemoryEntry(inserted[0]) };
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

	/**
	 * Take entries out of force WITHOUT deleting them (v1.6 phase 57, the forget primitive). One statement sets
	 * `superseded_by` to a forget marker (`forgotten:<forget_id>`, see `memory-forget.ts`) on every named row that
	 * has none, so the brief, `memory_search` (without `include_superseded`), the standing-entry lookup, the sweeper's
	 * lifetime classes and the retain replay all stop seeing the row at once, while the row stays for audit and for a
	 * `include_superseded` read. Returns the ids this call changed: a row that is already superseded or forgotten is
	 * never overwritten (its real superseder is kept) and a missing id is simply absent, so a second call changes
	 * nothing. The marker is validated here too: nothing but a well-formed one is ever written into the column.
	 */
	async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		if (!isForgetMarker(marker)) throw new Error(`markMemoryForgotten: "${marker.slice(0, 80)}" is not a forget marker (forgotten:fg_ + 26 hex)`);
		const distinct = [...new Set(ids)];
		if (distinct.length === 0) return [];
		if (distinct.length > MAX_FORGET_ENTRIES) {
			throw new Error(`markMemoryForgotten: ${distinct.length} ids exceeds the ${MAX_FORGET_ENTRIES}-id bound; forget in batches`);
		}
		return this.plane("memory.forget", async () => {
			const rows = (await this.sql`
				update memory_entries set superseded_by = ${marker}, forgotten_at = now()
				where id in ${this.sql(distinct)} and superseded_by is null
				returning id`) as Array<Record<string, unknown>>;
			return rows.map((row) => String(row.id));
		});
	}

	/**
	 * The entries of a session (and, when given, one graph) created STRICTLY AFTER an instant that no write has
	 * superseded or forgotten: what a rollback to that instant should forget. Ordered by `created` then `id`, at
	 * most `limit` of them, with `truncated` true when more matched.
	 *
	 * The instant and `created` are compared in whole milliseconds (`created` is truncated to the millisecond, the
	 * precision of an event `ts`), so a tie keeps the entry: one written in the same millisecond as the rollback point
	 * is not selected. `session` and `graphId` go through `normalizeIdentifier`, the form the gate stores them in.
	 * There is no index on `session_id`; the scan is bounded by the session's own rows being few, and the limit.
	 *
	 * `untilIso`, when not null, is an INCLUSIVE upper bound (whole milliseconds): an entry created after it belongs to
	 * the timeline the session began once the rollback started, so a rollback delivered late never reaches it. Null
	 * means no upper bound. It must not be before `afterIso`.
	 *
	 * `writer`, when not null, keeps only that surface's entries, in the query and so ahead of the limit.
	 */
	async memoryEntriesCreatedAfter(
		session: string,
		afterIso: string,
		graphId: string | null = null,
		limit = 1000,
		untilIso: string | null = null,
		writer: string | null = null,
	): Promise<{ entries: MemoryEntry[]; truncated: boolean }> {
		const sessionId = normalizeIdentifier(session);
		if (sessionId === null) throw new Error("memoryEntriesCreatedAfter: session is required");
		const graph = graphId === null ? null : normalizeIdentifier(graphId);
		if (graphId !== null && graph === null) throw new Error("memoryEntriesCreatedAfter: graphId is empty after normalisation");
		const afterMs = Date.parse(afterIso);
		if (Number.isNaN(afterMs)) throw new Error(`memoryEntriesCreatedAfter: "${afterIso.slice(0, 40)}" is not an instant`);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROLLBACK_SELECT_LIMIT) {
			throw new Error(`memoryEntriesCreatedAfter: limit must be an integer from 1 to ${MAX_ROLLBACK_SELECT_LIMIT}`);
		}
		const after = new Date(afterMs).toISOString();
		let until: string | null = null;
		if (untilIso !== null) {
			const untilMs = Date.parse(untilIso);
			if (Number.isNaN(untilMs)) throw new Error(`memoryEntriesCreatedAfter: "${untilIso.slice(0, 40)}" is not an instant`);
			if (untilMs < afterMs) throw new Error("memoryEntriesCreatedAfter: the upper bound is before the lower bound");
			until = new Date(untilMs).toISOString();
		}
		return this.plane("memory.forget.select", async () => {
			const rows = (await this.sql`
				select * from memory_entries
				where session_id = ${sessionId}
				  ${graph === null ? this.sql`` : this.sql`and graph_id = ${graph}`}
				  ${writer === null ? this.sql`` : this.sql`and writer = ${writer}`}
				  and superseded_by is null
				  and date_trunc('milliseconds', created) > ${after}::timestamptz
				  ${until === null ? this.sql`` : this.sql`and date_trunc('milliseconds', created) <= ${until}::timestamptz`}
				order by created asc, id asc
				limit ${limit + 1}`) as Array<Record<string, unknown>>;
			return { entries: rows.slice(0, limit).map((row) => toMemoryEntry(row)), truncated: rows.length > limit };
		});
	}

	/**
	 * True when ANOTHER entry in force shares this entry's plane document. A subject-addressed entry's document id is
	 * derived from (scope, kind, subject) (`retainDocumentId`) and lives in its WRITER's bank (`bankForSurface`), so
	 * every live entry of the same writer with that triple writes to one document; deleting it for a forgotten entry
	 * would remove memory that is still in force. A live entry of another writer has its own document in its own
	 * bank and does not share this one. A subject-less entry has a document of its own and is never shared. The
	 * `documentShared` dependency of `forgetEntries`; the service asks it inside the document's retain queue.
	 */
	async memoryDocumentShared(entry: Pick<MemoryEntry, "id" | "scope" | "kind" | "subject" | "writer">): Promise<boolean> {
		const subject = entry.subject;
		if (subject === undefined || subject.length === 0) return false;
		return this.plane("memory.forget.shared", async () => {
			const rows = (await this.sql`
				select 1 as shared from memory_entries
				where scope = ${entry.scope} and kind = ${entry.kind} and subject = ${subject} and writer = ${entry.writer}
				  and id <> ${entry.id} and superseded_by is null
				limit 1`) as Array<Record<string, unknown>>;
			return rows.length > 0;
		});
	}

	/**
	 * The `superseded_by` of each id that has a row: null for a row still in force, otherwise the forget marker or the
	 * superseder. An id with no row is absent from the map. Read for the cross-layer reconcile; at most
	 * {@link MAX_FORGET_LOOKUP_IDS} ids.
	 */
	async memoryMarkers(ids: readonly string[]): Promise<Map<string, string | null>> {
		const distinct = [...new Set(ids)];
		const markers = new Map<string, string | null>();
		if (distinct.length === 0) return markers;
		if (distinct.length > MAX_FORGET_LOOKUP_IDS) throw new Error(`memoryMarkers: ${distinct.length} ids exceeds the ${MAX_FORGET_LOOKUP_IDS}-id bound`);
		return this.plane("memory.reconcile", async () => {
			const rows = (await this.sql`
				select id, superseded_by from memory_entries where id in ${this.sql(distinct)}`) as Array<Record<string, unknown>>;
			for (const row of rows) {
				markers.set(String(row.id), row.superseded_by === null || row.superseded_by === undefined ? null : String(row.superseded_by));
			}
			return markers;
		});
	}

	/**
	 * The forget marks set in a window: every row whose `superseded_by` is a forget marker and whose `forgotten_at` (set by
	 * {@link markMemoryForgotten}) lies in [sinceIso, untilIso] to the millisecond, oldest first. At most `limit` rows, with
	 * `truncated` true when more matched. A row forgotten before migration 47 has no `forgotten_at` and is in no window.
	 * Read for the cross-layer reconcile.
	 */
	async forgetMarksBetween(sinceIso: string, untilIso: string, limit: number): Promise<{ marks: Array<{ entryId: string; marker: string }>; truncated: boolean }> {
		const sinceMs = Date.parse(sinceIso);
		const untilMs = Date.parse(untilIso);
		if (Number.isNaN(sinceMs) || Number.isNaN(untilMs) || untilMs < sinceMs) throw new Error("forgetMarksBetween: the window is not an ordered pair of instants");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FORGET_LOOKUP_IDS) throw new Error(`forgetMarksBetween: limit must be an integer from 1 to ${MAX_FORGET_LOOKUP_IDS}`);
		const since = new Date(sinceMs).toISOString();
		const until = new Date(untilMs).toISOString();
		return this.plane("memory.reconcile", async () => {
			const rows = (await this.sql`
				select id, superseded_by from memory_entries
				where date_trunc('milliseconds', forgotten_at) >= ${since}::timestamptz
				  and date_trunc('milliseconds', forgotten_at) <= ${until}::timestamptz
				  and superseded_by like ${`${FORGET_MARKER_PREFIX}%`}
				order by forgotten_at asc, id asc
				limit ${limit + 1}`) as Array<Record<string, unknown>>;
			return {
				marks: rows.slice(0, limit).map((row) => ({ entryId: String(row.id), marker: String(row.superseded_by) })),
				truncated: rows.length > limit,
			};
		});
	}

	/**
	 * Which of these entry ids are forgotten (their `superseded_by` is a forget marker). The recall leg uses it to drop
	 * a Hindsight hit whose document outlived the forget (a pending plane deletion): the text of a forgotten entry
	 * must not be served from the plane while its deletion is retried. An id with no row, or one that is current or
	 * really superseded, is not in the answer. At most {@link MAX_FORGET_LOOKUP_IDS} ids are read.
	 */
	async forgottenEntryIds(ids: readonly string[]): Promise<Set<string>> {
		const distinct = [...new Set(ids)];
		if (distinct.length === 0) return new Set();
		if (distinct.length > MAX_FORGET_LOOKUP_IDS) throw new Error(`forgottenEntryIds: ${distinct.length} ids exceeds the ${MAX_FORGET_LOOKUP_IDS}-id bound`);
		return this.plane("memory.forget.lookup", async () => {
			const rows = (await this.sql`
				select id from memory_entries
				where id in ${this.sql(distinct)} and superseded_by like ${`${FORGET_MARKER_PREFIX}%`}`) as Array<Record<string, unknown>>;
			return new Set(rows.map((row) => String(row.id)));
		});
	}

	/**
	 * Record a source on an entry that has none. The retain replay reads this
	 * column, so a retry that only reports the source leaves the queued lesson
	 * unsourced. A row that already has this source is unchanged; a different
	 * source is left alone and reported as not saved.
	 */
	async attachSource(id: string, sourceEvent: string): Promise<MemoryEntry | null> {
		const updated = (await this.sql`
			update memory_entries
			set source_event = ${sourceEvent}
			where id = ${id} and source_event is null
			returning *`) as Array<Record<string, unknown>>;
		const row = updated[0];
		if (row) return toMemoryEntry(row);
		const current = await this.readEntry(id);
		if (current && (current.source_event ?? null) === sourceEvent) return current;
		return null;
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

	/** The claim row for a key, or null. Does not take the lock and does not insert. */
	async findWrite(key: string): Promise<WriteRecord | null> {
		const rows = (await this.sql`
			select idempotency_key, explicit, outcome, entry_id, entry_hash, request_hash
			from memory_writes where idempotency_key = ${key}`) as Array<Record<string, unknown>>;
		const row = rows[0];
		if (row === undefined) return null;
		return {
			idempotency_key: String(row.idempotency_key),
			explicit: row.explicit === true,
			outcome: String(row.outcome) as WriteRecord["outcome"],
			entry_id: row.entry_id === null || row.entry_id === undefined ? null : String(row.entry_id),
			entry_hash: String(row.entry_hash),
			request_hash: row.request_hash === null || row.request_hash === undefined ? null : String(row.request_hash),
		};
	}

	/** One column: the quarantine row whose `entry_hash` is this digest, if any. */
	async findQuarantineByHash(entryHash: string): Promise<string | null> {
		const rows = (await this.sql`
			select id from memory_quarantine where entry_hash = ${entryHash}`) as Array<Record<string, unknown>>;
		return rows[0] ? String(rows[0].id) : null;
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
			-- memory_reviews_pending_idx, named by restating its predicate: a retry finds
			-- the proposal it already parked, and a decided row never blocks a new one.
			on conflict (entry_hash) where state = 'pending' do nothing
			returning id`) as Array<Record<string, unknown>>;
		if (inserted[0]) return String(inserted[0].id);
		const existing = (await this.sql`
			select id from memory_reviews where entry_hash = ${row.entry_hash} and state = 'pending'`) as Array<
			Record<string, unknown>
		>;
		return existing[0] ? String(existing[0].id) : row.id;
	}

	/** One column: the pending review whose `entry_hash` is this digest, if any. */
	async findPendingReviewByHash(entryHash: string): Promise<string | null> {
		const rows = (await this.sql`
			select id from memory_reviews where entry_hash = ${entryHash} and state = 'pending'`) as Array<
			Record<string, unknown>
		>;
		return rows[0] ? String(rows[0].id) : null;
	}

	/**
	 * Close the loop: a reviewed write that landed resolves the proposal it came from.
	 *
	 * Safe to run when this content was approved once before — the uniqueness on
	 * `memory_reviews` covers the pending rows only, so a second approval lands beside
	 * the first instead of raising a duplicate key on a write that has already
	 * committed.
	 */
	async releaseReviews(entryHash: string, entryId: string, decidedBy: string): Promise<number> {
		const rows = (await this.sql`
			update memory_reviews r
			set state = 'approved', entry_id = ${entryId}, decided = now(), decided_by = ${decidedBy}
			from memory_entries e
			where e.id = ${entryId}
			  and r.entry_hash = ${entryHash} and r.state = 'pending'
			  -- Content alone is not enough to say this entry answers this proposal, and
			  -- resolving one it does not answer takes a live request out of a reviewer's
			  -- queue without installing what it asked for.
			  --
			  -- Parked before the entry was written: a proposal raised afterwards is a new
			  -- ask about the same words, and cannot have been the one this entry came
			  -- from. Without it, any later write for this content — a replay, or a
			  -- recovery — silently approves it.
			  and r.created <= e.created
			  -- And asking for the retention the entry actually has. entry_hash covers
			  -- the words, not how long they are kept, so a proposal for 30d is not
			  -- answered by a permanent entry. It is the only part of the ask the queue
			  -- records — a parked row always carries the unreviewed trust and actor,
			  -- because a reviewer decides those.
			  and r.ttl = e.ttl
			returning r.id`) as Array<Record<string, unknown>>;
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
			select id, scope, kind, body, subject, writer, reason, ttl, created
			from memory_reviews where state = 'pending'
			order by created desc limit ${limit}`) as Array<Record<string, unknown>>;
		const quarantined = (await this.sql`
			select id, scope, kind, body, subject, writer, reason, detail, created
			from memory_quarantine
			order by created desc limit ${limit}`) as Array<Record<string, unknown>>;
		return { reviews: reviews.map(toQueueRow), quarantined: quarantined.map(toQueueRow) };
	}

	// ── skills registry (uplift-5 S5a) ─────────────────────────────────────────
	//
	// One row per (repo, name, pr_number); rows are never deleted. The state machine and the
	// reasons behind it are in `skills/registry.ts`; this is the storage half.

	/**
	 * Record that `skills_propose` opened (or found) a pull request. Idempotent: a row that exists
	 * is left as it is, except that a row an approval created before the proposal was recorded
	 * (no content hash) learns it. State is never touched here, so a retry after a decision cannot
	 * move a decided row back to `proposed`.
	 * A row it creates takes the name's next version (see `skillVersion`), under the decision lock.
	 */
	async upsertProposedSkill(input: {
		repo: string;
		name: string;
		pr_number: number;
		pr_url: string;
		branch: string | null;
		content_sha256: string;
		proposed_by: string;
	}): Promise<void> {
		await this.plane("skills.propose", async () =>
			this.sql.begin(async (tx: SQL) => {
				// Serialised with decisions on the same (repo, name), so the version a new row takes is the true next one.
				await tx`select pg_advisory_xact_lock(hashtextextended(${skillDecisionLockKey(input.repo, input.name)}::text, 0))`;
				await tx`
					insert into skills_registry (repo, name, pr_number, content_sha256, state, proposed_by, pr_url, branch, version)
					values (${input.repo}, ${input.name}, ${input.pr_number}, ${input.content_sha256}, 'proposed',
					        ${input.proposed_by}, ${input.pr_url}, ${input.branch},
					        (select coalesce(max(version), 0) + 1 from skills_registry where repo = ${input.repo} and name = ${input.name}))
					on conflict (repo, name, pr_number) do update
					set content_sha256 = excluded.content_sha256,
					    proposed_by = coalesce(skills_registry.proposed_by, excluded.proposed_by),
					    branch = coalesce(skills_registry.branch, excluded.branch),
					    updated = now()
					where skills_registry.content_sha256 = ''`;
			}),
		);
	}

	/**
	 * The version a proposal of `name` would revise: the highest version recorded for it, in any state,
	 * so a pending proposal counts. Null when no row exists (nothing recorded, e.g. governance off).
	 */
	async skillVersion(repo: string, name: string): Promise<{ version: number; pr_url: string | null } | null> {
		return this.plane("skills.version", async () => {
			const rows = (await this.sql`
				select version, pr_url from skills_registry
				where repo = ${repo} and name = ${name}
				order by version desc, pr_number desc limit 1`) as Array<Record<string, unknown>>;
			const row = rows[0];
			return row ? { version: Number(row.version), pr_url: row.pr_url === null || row.pr_url === undefined ? null : String(row.pr_url) } : null;
		});
	}

	/**
	 * Apply one operator decision to the registry, atomically. Decisions are serialised per (repo, name) by a
	 * transaction-scoped advisory lock taken first, so `remaining_approved` is the true post-decision total of
	 * the name. Then the row is locked, the pure `transition` judges it, and only an `apply` writes: `exists`
	 * leaves the row (and so the caller emits nothing), a refusal leaves it too. A row that does not exist yet
	 * is created in the decided state, which is how a pull request proposed while the registry was off is
	 * approved.
	 */
	async decideSkill(input: {
		repo: string;
		name: string;
		pr_number: number;
		decision: SkillDecision;
		/** The merge commit an approve is about; null for decline and retire. */
		merge_sha: string | null;
		pr_url: string | null;
		branch: string | null;
		/** `proposed_by` for a row this decision creates. */
		proposed_by: string | null;
		decided_by: string;
		reason: string | null;
	}): Promise<SkillDecisionResult> {
		return this.plane("skills.decide", async () =>
			this.sql.begin(async (tx: SQL) => {
				// How many approved rows the name has once this decision stands, in the same transaction.
				const remaining = async (): Promise<number> => {
					const counted = (await tx`
						select count(*)::int as n from skills_registry
						where repo = ${input.repo} and name = ${input.name} and state = 'approved'`) as Array<Record<string, unknown>>;
					return Number(counted[0]?.n ?? 0);
				};
				// Serialise decisions per (repo, name) BEFORE locking the row or counting: the row lock below is one
				// pull request's, but `remaining` counts every approved row of the name, so two concurrent decisions on
				// different pull requests of one name could each see the other's row still approved and both answer a
				// count that is not the final total. The transaction-scoped advisory lock (released at commit or
				// rollback) makes the count the true post-decision total. The key is a stable 64-bit hash of repo+name
				// (a collision only makes two unrelated names wait for each other).
				await tx`select pg_advisory_xact_lock(hashtextextended(${skillDecisionLockKey(input.repo, input.name)}::text, 0))`;
				for (let attempt = 0; attempt < 2; attempt++) {
					const found = (await tx`
						select * from skills_registry
						where repo = ${input.repo} and name = ${input.name} and pr_number = ${input.pr_number}
						for update`) as Array<Record<string, unknown>>;
					const current = found[0] ? toSkillRow(found[0]) : null;
					const verdict = transition(current, input.decision, input.merge_sha);
					if (verdict.kind === "exists" && current) return { outcome: "exists" as const, row: current, remaining_approved: await remaining() };
					if (verdict.kind === "refuse") return { outcome: "refused" as const, rule: verdict.rule, row: current };
					if (verdict.kind !== "apply") continue;
					if (current) {
						const updated = (await tx`
							update skills_registry
							set state = ${verdict.to},
							    merge_sha = coalesce(${input.merge_sha}::text, merge_sha),
							    pr_url = coalesce(${input.pr_url}::text, pr_url),
							    branch = coalesce(${input.branch}::text, branch),
							    decided_by = ${input.decided_by}, decided_at = now(), reason = ${input.reason},
							    updated = now()
							where repo = ${input.repo} and name = ${input.name} and pr_number = ${input.pr_number}
							returning *`) as Array<Record<string, unknown>>;
						return { outcome: "applied" as const, row: toSkillRow(updated[0] as Record<string, unknown>), remaining_approved: await remaining() };
					}
					const inserted = (await tx`
						insert into skills_registry (
							repo, name, pr_number, content_sha256, state, proposed_by, pr_url, branch, merge_sha,
							decided_by, decided_at, reason, version)
						values (${input.repo}, ${input.name}, ${input.pr_number}, '', ${verdict.to}, ${input.proposed_by},
						        ${input.pr_url}, ${input.branch}, ${input.merge_sha}, ${input.decided_by}, now(), ${input.reason},
						        (select coalesce(max(version), 0) + 1 from skills_registry where repo = ${input.repo} and name = ${input.name}))
						on conflict (repo, name, pr_number) do nothing
						returning *`) as Array<Record<string, unknown>>;
					// A concurrent decision created the row between the select and the insert: judge it on the next pass.
					if (inserted[0]) return { outcome: "applied" as const, row: toSkillRow(inserted[0]), remaining_approved: await remaining() };
				}
				throw new Error("skills registry row kept changing under the decision");
			}) as Promise<SkillDecisionResult>,
		);
	}

	/**
	 * What `skills_list` reads, at most `limit` entries, ordered by name in code-unit order
	 * (`collate "C"`, so `a-b` sorts before `ab`, as a JS string compare does; the database's own
	 * collation ignores the hyphen at the first level).
	 *
	 * `state` `approved` is BY NAME: one row per name, its most recent approved row (latest
	 * `decided_at`, then highest pull request number), because a reader builds a set of names and a
	 * name stays approved while any of its rows is. Any other `state` (null is every state) is every
	 * matching row by name then pull request number. Callers ask for `LIST_MAX + 1` to learn whether
	 * the answer was cut.
	 */
	async listSkills(repo: string, state: SkillState | null, limit: number): Promise<SkillRegistryRow[]> {
		return this.plane("skills.list", async () => {
			const rows = (
				state === "approved"
					? await this.sql`
						select * from (
							select distinct on (name) *
							from skills_registry
							where repo = ${repo} and state = 'approved'
							order by name, decided_at desc nulls last, pr_number desc
						) latest
						order by name collate "C" asc
						limit ${limit}`
					: await this.sql`
						select * from skills_registry
						where repo = ${repo} and (${state}::text is null or state = ${state})
						order by name collate "C" asc, pr_number asc
						limit ${limit}`
			) as Array<Record<string, unknown>>;
			return rows.map(toSkillRow);
		});
	}

	/**
	 * Full-text search. Superseded entries are excluded by default: an agent asking
	 * what is true wants what is in force, not every version of it. A decision log is
	 * still readable — `includeSuperseded` is how you read it.
	 *
	 * The newest `limit` matches and nothing more; `searchMemoryPage` is how a caller
	 * reads past them.
	 */
	async searchMemory(
		query: string,
		scope?: string,
		limit = 20,
		includeSuperseded = false,
		read?: MemoryReadOptions,
	): Promise<MemoryEntry[]> {
		return (await this.searchMemoryPage({ query, ...(scope === undefined ? {} : { scope }), limit, includeSuperseded }, read)).entries;
	}

	/**
	 * One page of a search, newest first, and the cursor for the page after it.
	 *
	 * Ordered `created desc, id desc`. `created` alone is not an order: `now()` is the
	 * transaction's start, so every entry one transaction writes shares it, and a
	 * cursor on the timestamp alone would skip or repeat whichever of them a page
	 * boundary fell between. `id` breaks the tie, and the cursor is the pair.
	 *
	 * The cursor's timestamp is rendered here, to the microsecond Postgres stores,
	 * rather than taken from the entry's `created` — that is a JS `Date`, cut to the
	 * millisecond, and a cursor cut short sits *after* the entries it was cut from,
	 * so the next page would skip any of them the boundary had not yet reached.
	 *
	 * `subjectPrefix` arrives normalised and is matched with `left()`, so `%`, `_`
	 * and `\` in it are the characters they are rather than LIKE patterns.
	 *
	 * Lifetime (uplift-3 N4) is judged after the page is read — see
	 * {@link IndexStore.servable}. The cursor is taken from the page as the
	 * database returned it, before any expired entry is left out, so a page
	 * `enforce` thinned stays a page: `next` still points past every row it
	 * covered and nothing is skipped or repeated. A page may therefore come back
	 * shorter than `limit` with `next` set; only a short *raw* page is the end.
	 */
	async searchMemoryPage(search: MemorySearch, read?: MemoryReadOptions): Promise<MemorySearchPage> {
		const limit = search.limit ?? 20;
		const query = search.query ?? "";
		const prefix = search.subjectPrefix ?? null;
		const before = search.before ?? null;
		const beforeId = search.beforeId ?? null;
		// Emit predicates, not nullable OR wrappers: even a generic prepared plan can
		// use scope equality and the row comparison as a single B-tree index bound.
		const cursor = before === null
			? this.sql``
			: beforeId === null
				? this.sql`and created < ${before}::timestamptz`
				: this.sql`and (created, id) < (${before}::timestamptz, ${beforeId}::text)`;
		// `agent:` rows belong to one surface and to the repo they were written for. A caller sees its own
		// surface's rows in its own repo; a caller that names no repo sees none. `visibleToCaller` applies the
		// same rule to derived hits. An internal read with no `read` is unfiltered, as the write gate's own
		// lookups have always been.
		const agentScope = read === undefined ? null : `agent:${(normalizeIdentifier(read.surface) ?? "unattributed").toLowerCase()}`;
		const agentRepo = read === undefined ? null : normalizeIdentifier(read.repo);
		// A `graph:` row is served by a search only while its graph has a graph_index row, as a brief serves it (`memoryForBrief`), whatever its ttl.
		// A graph that is gone or was never registered names no graph, so its rows are hidden. Only a serving read (`read` given) is filtered:
		// the consistency run reads unfiltered to find orphaned documents, so it must still see every row.
		return this.plane("memory.search", async () => {
			const rows = (await this.sql`
				select *, to_char(created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created
				from memory_entries
				where true
				  ${search.scope == null ? this.sql`` : this.sql`and scope = ${search.scope}`}
				  ${search.includeSuperseded ? this.sql`` : this.sql`and superseded_by is null`}
				  ${query === "" ? this.sql`` : this.sql`and to_tsvector('english', body) @@ plainto_tsquery('english', ${query})`}
				  ${prefix === null ? this.sql`` : this.sql`and left(subject, char_length(${prefix}::text)) = ${prefix}::text`}
				  ${search.writer == null ? this.sql`` : this.sql`and writer = ${search.writer}`}
				  ${search.kind == null ? this.sql`` : this.sql`and kind = ${search.kind}`}
				  ${agentScope === null ? this.sql`` : agentRepo === null ? this.sql`and lower(scope) not like 'agent:%'` : this.sql`and (lower(scope) not like 'agent:%' or (lower(scope) = ${agentScope} and repo = ${agentRepo}))`}
				  ${read === undefined ? this.sql`` : this.sql`and (scope not like 'graph:%' or exists (select 1 from graph_index g where g.graph_id = substring(memory_entries.scope from 7)))`}
				  ${cursor}
				order by created desc, id desc
				limit ${limit}`) as Array<Record<string, unknown>>;
			const last = rows.length === limit ? rows[rows.length - 1] : undefined;
			return {
				entries: await this.servable(rows, read),
				next: last ? { before: String(last.cursor_created), before_id: String(last.id) } : null,
			};
		});
	}

	/**
	 * Entries relevant to a brief: this graph, this repo, and globals.
	 *
	 * The scope strings are built with `normalizeIdentifier`, because the gate stores
	 * them that way — querying the raw spelling would match nothing, the same trap
	 * `emit` fell into with session ids.
	 */
	async memoryForBrief(repo: string | null, graphId: string | null, limit = 10, read?: MemoryReadOptions): Promise<MemoryEntry[]> {
		const normalizedRepo = normalizeIdentifier(repo);
		const normalizedGraph = normalizeIdentifier(graphId);
		const scopes = [
			"global",
			...(normalizedRepo ? [`repo:${normalizedRepo}`] : []),
			...(normalizedGraph ? [`graph:${normalizedGraph}`] : []),
		];
		// `in ${sql(array)}` is the form Bun's SQL expands to a value list. Passing
		// the array straight to `any()` stringifies it into a malformed array literal.
		return this.plane("memory.brief", async () => {
			// A row under a `graph:` scope is served by a brief only while its graph has a graph_index row, whatever its ttl. A graph that is gone,
			// or was never registered, names no graph, so none of its entries is read here: a permanent one is hidden as much as a `ttl: graph` one.
			// A registered graph is unaffected. Rows under other scopes are not checked against graph_index.
			const rows = (await this.sql`
				select *
				from memory_entries
				where scope in ${this.sql(scopes)}
				  and superseded_by is null
				  and (scope not like 'graph:%' or exists (select 1 from graph_index g where g.graph_id = substring(memory_entries.scope from 7)))
				order by created desc
				limit ${limit}`) as Array<Record<string, unknown>>;
			const entries = await this.servable(rows, read);
			// A `global` row names no repository in its scope, so the scope list alone let an ungranted repository's row through: the row's own repository is checked too.
			// A `graph:` row is judged here by its own repository only: a graph row that names no repository is kept, as memoryReplyInGrant keeps it.
			// Its graph is checked by the query above, and the caller's grant on that graph by scopedBriefRefusal before the page is read.
			const granted = read?.granted;
			return granted === undefined ? entries : entries.filter((entry) => grantedToCaller(entry.scope?.startsWith("graph:") ? undefined : entry.scope, entry.repo, granted));
		});
	}

	/**
	 * The in-force rows of one graph's own scope (`graph:<id>`), newest first, at most `limit`. Unlike `memoryForBrief`, which
	 * shares its page with the global and repo scopes, this reads only the graph's scope, so a busy global scope cannot push a
	 * graph's rows off the page. `truncated` is true when the scope holds more rows than `limit`: a full page is never read as
	 * the graph's whole provenance. Rows go through `servable`, so the expiry rule is the one a brief applies.
	 */
	async memoryForGraphScope(graphId: string, limit: number): Promise<{ entries: MemoryEntry[]; truncated: boolean }> {
		const normalizedGraph = normalizeIdentifier(graphId);
		if (normalizedGraph === null) throw new Error("memoryForGraphScope: graphId is empty after normalisation");
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("memoryForGraphScope: limit must be a positive integer");
		const scope = `graph:${normalizedGraph}`;
		return this.plane("memory.brief", async () => {
			const rows = (await this.sql`
				select *
				from memory_entries
				where scope = ${scope}
				  and superseded_by is null
				order by created desc, id desc
				limit ${limit + 1}`) as Array<Record<string, unknown>>;
			return { entries: await this.servable(rows.slice(0, limit), undefined), truncated: rows.length > limit };
		});
	}

	/**
	 * What `graph_index` holds for each graph, one round trip for the whole list;
	 * an id with no row is absent from the map. The list is a page's distinct
	 * graph ids, so it is bounded by the page. The list goes through the
	 * tagged-template helper: a bare array parameter is the malformed-literal
	 * quirk `memoryForBrief` notes.
	 */
	private async graphLifetimes(graphIds: readonly string[]): Promise<Map<string, GraphLifetime>> {
		if (graphIds.length === 0) return new Map();
		const rows = (await this.sql`
			select graph_id, status from graph_index where graph_id in ${this.sql([...graphIds])}`) as Array<Record<string, unknown>>;
		return new Map(rows.map((row) => [String(row.graph_id), { status: row.status == null ? null : String(row.status) }]));
	}

	/** The graph a `ttl: graph` entry lives for, as the index knows it now; null when it has no row. Under the plane gate. */
	async graphLifetime(entry: Pick<MemoryEntry, "scope" | "graph_id">): Promise<GraphLifetime | null> {
		const graphId = memoryGraphId(entry);
		if (graphId === null) return null;
		return this.plane("memory.expiry", async () => (await this.graphLifetimes([graphId])).get(graphId) ?? null);
	}

	/**
	 * The rows a serving read hands out, judged by `memoryExpiry` (uplift-3 N4).
	 *
	 * One extra bounded query: the `graph_index` status of every distinct graph
	 * the page's `ttl: graph` entries name, which is what the predicate needs and
	 * nothing a `30d` or `permanent` entry does — a page without graph entries
	 * costs no second round trip. Every entry is then tagged `expired` (and
	 * `expires_at` where the class has one), in both modes, so a reader can see
	 * what `enforce` would hide before turning it on. Under `report` the tagged
	 * page is returned whole; under `enforce` an expired entry is left out unless
	 * the read asked for it. Each expired entry met is reported once, as `served`
	 * or `hidden`, which is the series the rollout watches.
	 *
	 * Shared by `searchMemoryPage` (so `memory_search`, the subject listings and
	 * the agent card) and `memoryForBrief`, so the brief and a search can never
	 * disagree about whether an entry is alive. `readEntry` is not a serving read
	 * — it is the gate's read-back of a row it just wrote — and stays untouched.
	 */
	private async servable(rows: Array<Record<string, unknown>>, read: MemoryReadOptions | undefined): Promise<MemoryEntry[]> {
		const now = Date.now();
		const entries = rows.map((row) => toMemoryEntry(row, now));
		const graphIds = new Set<string>();
		for (const entry of entries) {
			if (entry.ttl !== "graph") continue;
			const graphId = memoryGraphId(entry);
			if (graphId !== null) graphIds.add(graphId);
		}
		const graphs = await this.graphLifetimes([...graphIds]);
		const hide = this.expiry.mode === "enforce" && read?.includeExpired !== true;
		const surface = read?.surface ?? "unattributed";
		const served: MemoryEntry[] = [];
		for (const entry of entries) {
			const graph = entry.ttl === "graph" ? (graphs.get(memoryGraphId(entry) ?? "") ?? null) : null;
			const verdict = memoryExpiry(entry, graph, now);
			if (verdict.expired) this.expiry.observe?.({ surface, kind: entry.kind, mode: hide ? "hidden" : "served" });
			if (verdict.expired && hide) continue;
			served.push({
				...entry,
				expired: verdict.expired,
				...(verdict.expires_at === null ? {} : { expires_at: verdict.expires_at }),
			});
		}
		return served;
	}

	/**
	 * Whether the index answers `select 1` inside `timeoutMs`. Bounded, because
	 * `/healthz` used to wait on this for as long as a cold connect took (a second
	 * over the proxy, unbounded when the host was gone) and the whole probe hung
	 * on it. A timeout is `false`, and under a gate it is sampled as one.
	 */
	async ping(timeoutMs = INDEX_PING_TIMEOUT_MS): Promise<boolean> {
		try {
			await this.plane("ping", () => withTimeout(this.sql`select 1`.then(() => undefined), timeoutMs, "index ping"));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Database size and the ten largest relations, for `/healthz`. Timescale's own
	 * schemas are excluded so the list names this repo's tables, not chunk
	 * bookkeeping; `pg_total_relation_size` includes indexes and TOAST, which is
	 * what the volume actually fills with.
	 */
	async capacity(): Promise<IndexCapacity> {
		return this.plane("capacity", async () => {
			// Three independent reads, issued together: `/healthz` bounds this whole call at one second and every
			// serial statement costs a proxy round trip, so the lease-table row must not add one.
			const [size, tables, nodes] = (await Promise.all([
				this.sql`
					select pg_database_size(current_database())::text as bytes`,
				// `pg_total_relation_size` once per relation. The order is on `relations.total_bytes`, the number: a bare
				// `total_bytes` would name the text output column and sort "9" above "10".
				this.sql`
					select name,
					       total_bytes::text as total_bytes,
					       live_rows::text as live_rows,
					       dead_rows::text as dead_rows
					from (
						select relname as name,
						       pg_total_relation_size(relid) as total_bytes,
						       n_live_tup as live_rows,
						       n_dead_tup as dead_rows
						from pg_stat_user_tables
						where left(schemaname, 13) <> '_timescaledb_'
					) as relations
					order by relations.total_bytes desc
					limit 10`,
				// Lease-table bloat, visibility only: how many updates were HOT (no new
				// index entries) and how much of the heap is dead. `null` ratios while the
				// table has no updates or no rows yet.
				this.sql`
					select n_tup_upd::text as upd, n_tup_hot_upd::text as hot, n_live_tup::text as live, n_dead_tup::text as dead
					from pg_stat_user_tables
					where relname = 'graph_nodes' and schemaname = current_schema()`,
			])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
			const node = nodes[0];
			const updates = Number(node?.upd ?? 0);
			const rowsTotal = Number(node?.live ?? 0) + Number(node?.dead ?? 0);
			return {
				databaseBytes: Number(size[0]?.bytes ?? 0),
				tables: tables.map((row) => ({
					name: String(row.name),
					totalBytes: Number(row.total_bytes ?? 0),
					liveRows: Number(row.live_rows ?? 0),
					deadRows: Number(row.dead_rows ?? 0),
				})),
				graphNodes:
					node === undefined
						? null
						: {
								hotUpdateRatio: updates > 0 ? Number(node.hot ?? 0) / updates : null,
								deadRatio: rowsTotal > 0 ? Number(node.dead ?? 0) / rowsTotal : null,
							},
			};
		});
	}

	/**
	 * Apply (or only report) the documented retention — `index-sweep.ts` holds the
	 * classes, the thresholds and the SQL. A dry-run runs the COUNT statements on
	 * the pool. An apply runs everything inside one transaction: the counts, then
	 * the batched deletes, so a failure half way commits nothing.
	 *
	 * `expiry` is explicit, not the store's own setting: the sweep is a one-shot
	 * job and the operator's `SUBSTRATE_MEMORY_EXPIRY` reaches it through the
	 * runner's config. Absent means `report` — the `ttl` classes only count.
	 */
	async sweep(options: { apply?: boolean; now?: number; policy?: SweepPolicy; expiry?: MemoryExpiryMode } = {}): Promise<SweepReport> {
		const policy = options.policy ?? sweepPolicyFromEnv();
		const now = options.now ?? Date.now();
		const expiry = options.expiry ?? "report";
		const steps = planSweep(policy, now, { expiry });
		const run = (sql: SQL) => async (statement: SweepStatement) =>
			(await sql.unsafe(statement.text, statement.params as unknown[])) as Array<Record<string, unknown>>;
		if (!options.apply) return executeSweep(run(this.sql), steps, { apply: false, batch: policy.batch, now, expiry });
		return (await this.sql.begin((tx: SQL) =>
			executeSweep(run(tx), steps, { apply: true, batch: policy.batch, now, expiry }),
		)) as SweepReport;
	}

	/**
	 * One read of the two ttl classes `memoryLifecycleQuery` names. The sweep's
	 * deletes are untouched. Same `sql.unsafe` path as a dry-run count.
	 */
	/**
	 * One scratch row for the opt-in index drill. The rehearsal script must not
	 * name `insertEntry` or a memory table: both are locked to this file and
	 * `memory-write.ts`. The id is the text, so a restore can read it back.
	 */
	async recordDrillFact(id: string, text: string): Promise<void> {
		const claim = await this.claimWrite({
			key: id,
			explicit: true,
			entryHash: id,
			requestHash: id,
			entryId: id,
		});
		if (!claim.claimed) throw new Error("index drill could not claim the scratch memory row");
		const inserted = await this.insertEntry(
			{
				id,
				scope: "global",
				kind: "fact",
				subject: null,
				text,
				writer: "rehearsal",
				actor: "agent",
				trust: "agent-claimed",
				ttl: "permanent",
				source_event: null,
				session_id: null,
				graph_id: null,
				repo: null,
				conflict_key: null,
				version: 1,
				supersedes: null,
				entry_hash: id,
				reverify_after: new Date(Date.now() + 86_400_000).toISOString(),
				idempotency_key: id,
			},
			{ key: id, holder: claim.holder },
		);
		if (!inserted.ok) throw new Error(`index drill insert refused: ${inserted.reason}`);
		await this.finishWrite(id, claim.holder, "accepted", id);
	}

	/** The stored text of one memory row, or null when that id is absent. */
	async readMemoryText(id: string): Promise<string | null> {
		const rows = (await this.sql`select body from memory_entries where id = ${id}`) as Array<{ body?: string }>;
		const body = rows[0]?.body;
		return typeof body === "string" ? body : null;
	}

	async memoryLifecycleCandidates(options: { now?: number; policy?: SweepPolicy } = {}): Promise<Array<Record<string, unknown>>> {
		const policy = options.policy ?? sweepPolicyFromEnv();
		const now = options.now ?? Date.now();
		const statement = memoryLifecycleQuery(policy, now);
		return (await this.sql.unsafe(statement.text, statement.params as unknown[])) as Array<Record<string, unknown>>;
	}

	/**
	 * Run `work` against one consistent view of every archived table: a single
	 * REPEATABLE READ READ ONLY transaction on one connection, so the pages of
	 * every table are read at the same instant and nothing here can write. The
	 * connection holds the transaction open for as long as `work` runs; the
	 * runner bounds that by its own deadline and the connection's
	 * `statement_timeout`. Not under the plane gate: it is the archive job's
	 * own connection, never the server's request path.
	 */
	async withExportSnapshot<T>(work: (reader: IndexSnapshotReader) => Promise<T>): Promise<T> {
		return (await this.sql.begin("isolation level repeatable read read only", (tx: SQL) => work(archiveAccess(tx)))) as T;
	}

	/** Run `work` in one read-write transaction on this (scratch) database; a throw rolls everything back. */
	async withRestoreTransaction<T>(work: (tx: IndexRestoreTx) => Promise<T>): Promise<T> {
		return (await this.sql.begin((tx: SQL) => work(archiveAccess(tx)))) as T;
	}

	/**
	 * The lease-table storage tune (`SUBSTRATE_INDEX_TUNE=apply`): a lower
	 * fillfactor leaves room on each page for heartbeat updates, and a lower
	 * autovacuum scale factor vacuums the small, hot table sooner. Idempotent: it
	 * reads `reloptions` first and issues the `alter table` only when either
	 * option is not already set, so a boot that runs it every time changes
	 * nothing after the first. It touches new pages only — rewriting existing
	 * ones is the operator's `VACUUM FULL`, never this. No index is dropped.
	 */
	async tuneGraphNodes(): Promise<"applied" | "already"> {
		const rows = (await this.sql`
			select array_to_string(reloptions, ',') as options from pg_class where oid = 'graph_nodes'::regclass`) as Array<Record<string, unknown>>;
		const have = String(rows[0]?.options ?? "").split(",");
		if (have.includes("fillfactor=70") && have.includes("autovacuum_vacuum_scale_factor=0.02")) return "already";
		await this.sql`alter table graph_nodes set (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02)`;
		return "applied";
	}

	/** `timeout` in seconds, as Bun's `end` takes it; 0 drops in-flight statements instead of waiting on them. */
	async close(options?: { timeout?: number }): Promise<void> {
		await this.sql.end(options);
	}
}

// ── archive (uplift-4 S2) ────────────────────────────────────────────────────

/** Rows one export page may carry at most; the archive asks for far fewer. */
export const MAX_ARCHIVE_PAGE_ROWS = 5000;

/** The most rows one restore `insert` carries, so the statement stays under the driver's parameter limit. */
const RESTORE_BATCH_ROWS = 200;

/** The Postgres type a column type is cast to when a restore binds it. */
const PG_TYPE: Record<ColumnType, string> = { text: "text", int: "int", bigint: "bigint", bool: "boolean", timestamptz: "timestamptz" };

/** One REPEATABLE READ READ ONLY view of the archived tables: every read through it sees the same instant. */
export interface IndexSnapshotReader {
	/** Postgres `server_version`. */
	serverVersion(): Promise<string>;
	/** Rows in a whitelisted table in this view. */
	count(table: string): Promise<number>;
	/** The next `limit` rows of a whitelisted table in key order, strictly after `after` (the key values of the last row read), or from the start when `null`. */
	page(table: string, after: ReadonlyArray<string | number> | null, limit: number): Promise<ArchiveRow[]>;
}

/** One read-write transaction on a scratch database: the reader plus the loader. */
export interface IndexRestoreTx extends IndexSnapshotReader {
	/** Insert rows of a whitelisted table; withheld columns are refilled from the spec's placeholders. */
	insert(table: string, rows: readonly ArchiveRow[]): Promise<void>;
}

/**
 * The select list of an export page: the exported columns only, timestamps
 * rendered by Postgres to the microsecond in UTC (a JS `Date` would cut them
 * to the millisecond and the restore would not reproduce the instant), and
 * `bigint` as text. Every identifier comes from the closed spec.
 */
function exportSelectList(spec: ArchiveTableSpec): string {
	return exportedColumns(spec)
		.map((column) => {
			const quoted = `"${column.name}"`;
			if (column.type === "timestamptz") return `to_char(${quoted} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${quoted}`;
			if (column.type === "bigint") return `${quoted}::text as ${quoted}`;
			return quoted;
		})
		.join(", ");
}

/** The archive's reads and loads over one connection (a transaction handle). */
function archiveAccess(sql: SQL): IndexRestoreTx {
	return {
		async serverVersion() {
			const rows = (await sql`select current_setting('server_version') as version`) as Array<Record<string, unknown>>;
			return String(rows[0]?.version ?? "");
		},
		async count(table) {
			const spec = tableSpec(table);
			const rows = (await sql.unsafe(`select count(*)::text as n from "${spec.name}"`)) as Array<Record<string, unknown>>;
			return Number(rows[0]?.n ?? 0);
		},
		async page(table, after, limit) {
			const spec = tableSpec(table);
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARCHIVE_PAGE_ROWS) throw new Error(`archive page size must be 1..${MAX_ARCHIVE_PAGE_ROWS}`);
			const keys = spec.key.map((name) => `"${name}"`).join(", ");
			let where = "";
			if (after !== null) {
				if (after.length !== spec.key.length) throw new Error(`${spec.name}: cursor has ${after.length} values for a ${spec.key.length}-column key`);
				const bound = spec.key.map((name, i) => `$${i + 1}::${PG_TYPE[spec.columns.find((column) => column.name === name)?.type ?? "text"]}`).join(", ");
				where = ` where (${keys}) > (${bound})`;
			}
			const rows = (await sql.unsafe(`select ${exportSelectList(spec)} from "${spec.name}"${where} order by ${keys} limit ${limit}`, after === null ? [] : [...after])) as Array<
				Record<string, unknown>
			>;
			// Rebuilt as plain objects in column order, so the NDJSON line (and its digest) never depends on the driver's row type.
			return rows.map((row) => {
				const out: ArchiveRow = {};
				for (const column of exportedColumns(spec)) out[column.name] = (row[column.name] ?? null) as string | number | boolean | null;
				return out;
			});
		},
		async insert(table, rows) {
			const spec = tableSpec(table);
			const columns: Array<{ name: string; type: ColumnType; value: (row: ArchiveRow) => string | number | boolean | null }> = exportedColumns(spec).map((column) => ({
				name: column.name,
				type: column.type,
				value: (row) => row[column.name] ?? null,
			}));
			for (const name of spec.withheld) {
				const placeholder = spec.placeholders[name] ?? null;
				if (placeholder !== null) columns.push({ name, type: "text", value: () => placeholder });
			}
			for (let from = 0; from < rows.length; from += RESTORE_BATCH_ROWS) {
				const batch = rows.slice(from, from + RESTORE_BATCH_ROWS);
				const params: Array<string | number | boolean | null> = [];
				const tuples = batch.map((row) => `(${columns.map((column) => `$${params.push(column.value(row))}::${PG_TYPE[column.type]}`).join(", ")})`);
				await sql.unsafe(`insert into "${spec.name}" (${columns.map((column) => `"${column.name}"`).join(", ")}) values ${tuples.join(", ")}`, params);
			}
		},
	};
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
/**
 * A `findNodesByLinear` row as `graph_find` types it: the node columns
 * through `toNode` (Postgres hands `lease_epoch` back as a string, which
 * would otherwise serialise beside the numeric `lease.epoch` as a second
 * value for the same thing), with the joined graph columns carried across.
 * Exported for the mapping test: the SQL itself needs a live Postgres.
 */
export function toLinearNodeMatch(row: LinearNodeMatch): LinearNodeMatch {
	const { repo, branch, graph_status } = row;
	return { ...toNode(row), repo, branch, graph_status };
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
	const subject = optional(row.subject);
	const ttl = optional(row.ttl);
	const detail = optional(row.detail);
	return {
		id: String(row.id),
		scope: String(row.scope),
		kind: row.kind as MemoryEntry["kind"],
		writer: String(row.writer),
		reason: String(row.reason),
		created: timestamp(row.created),
		text: String(row.body),
		...(subject ? { subject } : {}),
		// Review rows only: the quarantine table holds no retention, because a
		// quarantined write never got as far as being kept for anything.
		...(ttl ? { ttl } : {}),
		...(detail ? { detail } : {}),
	};
}

/**
 * The text `decideSkill` hashes into its per-(repo, name) advisory lock key:
 * `pg_advisory_xact_lock(hashtextextended(<this>::text, 0))`. Exported so the live test holds the very same
 * key and proves the lock is what serialises decisions.
 */
export function skillDecisionLockKey(repo: string, name: string): string {
	return `${repo}\n${name}`;
}

/**
 * The text `migrate` hashes into its session advisory lock:
 * `pg_advisory_lock(hashtextextended(<this>::text, 0))`. One boot at a time.
 */
export function indexMigrateLockKey(): string {
	return "substrate.index.migrate";
}

function toSkillRow(row: Record<string, unknown>): SkillRegistryRow {
	const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
	const time = (value: unknown): string | null => (value === null || value === undefined ? null : timestamp(value));
	return {
		repo: String(row.repo),
		name: String(row.name),
		pr_number: Number(row.pr_number),
		// '' is a value here (a pull request not proposed through the substrate), not "unset".
		content_sha256: String(row.content_sha256),
		state: String(row.state) as SkillState,
		proposed_by: text(row.proposed_by),
		pr_url: text(row.pr_url),
		branch: text(row.branch),
		merge_sha: text(row.merge_sha),
		decided_by: text(row.decided_by),
		decided_at: time(row.decided_at),
		reason: text(row.reason),
		version: Number(row.version),
		created: timestamp(row.created),
		updated: timestamp(row.updated),
	};
}

export function toMemoryEntry(row: Record<string, unknown>, now = Date.now()): MemoryEntry {
	const reverifyAfter = optional(row.reverify_after);
	const subject = optional(row.subject);
	const sourceEvent = optional(row.source_event);
	const sessionId = optional(row.session_id);
	const graphId = optional(row.graph_id);
	const repo = optional(row.repo);
	const supersedes = optional(row.supersedes);
	const supersededBy = optional(row.superseded_by);
	const idempotencyKey = optional(row.idempotency_key);
	return {
		id: String(row.id),
		scope: String(row.scope),
		kind: row.kind as MemoryEntry["kind"],
		text: String(row.body),
		...(subject === undefined ? {} : { subject }),
		...(sourceEvent === undefined ? {} : { source_event: sourceEvent }),
		...(sessionId === undefined ? {} : { session_id: sessionId }),
		...(graphId === undefined ? {} : { graph_id: graphId }),
		...(repo === undefined ? {} : { repo }),
		writer: String(row.writer),
		actor: (row.actor === "human" ? "human" : "agent") as Actor,
		trust: row.trust as MemoryEntry["trust"],
		ttl: String(row.ttl),
		created: timestamp(row.created),
		// `version` predates the gate on rows written in Phase 0, where the column
		// default backfilled it to 1 — which is what those entries honestly were.
		version: Number(row.version ?? 1),
		...(supersedes === undefined ? {} : { supersedes }),
		...(supersededBy === undefined ? {} : { superseded_by: supersededBy }),
		entry_hash: String(row.entry_hash ?? ""),
		...(reverifyAfter ? { reverify_after: reverifyAfter } : {}),
		// Derived, not stored: an entry decays where it sits, without a sweeper job.
		needs_reverification: needsReverification(reverifyAfter, now),
		...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
	};
}
