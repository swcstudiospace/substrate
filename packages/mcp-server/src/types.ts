/** Shared shapes for the substrate. Mirrors Notion §5.2 and §5.3. */

export const SURFACES = [
	"claude-code",
	"cursor",
	"hermes",
	"omp",
	"muse",
	"grok-build",
	"grok-bot",
	"codex",
	"opencode",
	"pi",
	"rivet-agentos",
] as const;
export type Surface = (typeof SURFACES)[number];

export const EVENT_KINDS = [
	"session.start",
	"prompt",
	"claim",
	"tool.call",
	"file.edit",
	"shell",
	"commit",
	"pr",
	"handoff",
	"session.end",
	"note",
	"warning",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ACTORS = ["agent", "human"] as const;
export type Actor = (typeof ACTORS)[number];

/** An event as a collector submits it. `id`, `ts`, `hash` and `prev` are filled in on ingest. */
export interface EventInput {
	surface: Surface;
	kind: EventKind;
	summary: string;
	session_id?: string;
	graph_id?: string;
	node_id?: string;
	linear_identifier?: string;
	step?: number;
	repo?: string;
	branch?: string;
	actor?: Actor;
	payload?: Record<string, unknown>;
	/** Collector-supplied timestamp; defaults to ingest time. */
	ts?: string;
}

/** An event as stored. Every field below `hash` participates in the chain. */
export interface SubstrateEvent {
	id: string;
	ts: string;
	surface: Surface;
	session_id: string | null;
	graph_id: string | null;
	node_id: string | null;
	linear_identifier: string | null;
	step: number | null;
	repo: string | null;
	branch: string | null;
	actor: Actor;
	kind: EventKind;
	summary: string;
	payload: Record<string, unknown>;
	/** sha256 over the canonical JSON of every other field, including `prev`. */
	hash: string;
	/** Hash of the previous event in this session; null for the first. */
	prev: string | null;
}

export const MEMORY_KINDS = ["decision", "fact", "warning", "handoff", "todo"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TRUST_LEVELS = ["agent-claimed", "human-confirmed", "verified-by-test"] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

/** Retention, which is a different question from trust — see `TRUST_SHELF_LIFE_DAYS`. */
export const MEMORY_TTLS = ["graph", "30d", "permanent"] as const;
export type MemoryTtl = (typeof MEMORY_TTLS)[number];

/** The five scope families. RBAC is granted per family, never per literal scope string. */
export const MEMORY_SCOPE_CLASSES = ["graph", "repo", "global", "agent", "person"] as const;
export type MemoryScopeClass = (typeof MEMORY_SCOPE_CLASSES)[number];

export interface MemoryScope {
	class: MemoryScopeClass;
	/** The part after the colon; null for `global`. */
	id: string | null;
	/** The form that is stored and queried, e.g. `repo:swcstudiospace/agent-substrate`. */
	canonical: string;
}

/**
 * How a write that collides with an entry already in force is resolved.
 *
 * `append` is the absence of a collision rule: without a `subject` there is no
 * identity to collide on, so the entry simply lands alongside its predecessors.
 */
export const CONFLICT_STRATEGIES = ["append", "lww", "versioned", "require-review"] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const MEMORY_WRITE_OUTCOMES = ["accepted", "conflict", "quarantined", "denied"] as const;
export type MemoryWriteOutcome = (typeof MEMORY_WRITE_OUTCOMES)[number];

export const QUARANTINE_REASONS = ["secret", "pii", "speculative"] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export interface MemoryEntryInput {
	/** `graph:<id>` | `repo:<name>` | `global` | `agent:<surface>` | `person:<name>` */
	scope: string;
	kind: MemoryKind;
	text: string;
	writer: Surface | string;
	/**
	 * A stable name for what this entry is *about*.
	 *
	 * Two entries sharing a subject at the same scope and kind are the same claim
	 * over time, which is the identity the `lww` and `versioned` strategies resolve
	 * against. Without one a write has nothing to collide with and is appended.
	 */
	subject?: string;
	actor?: Actor;
	source_event?: string;
	session_id?: string;
	graph_id?: string;
	repo?: string;
	trust?: Trust;
	ttl?: string;
}

export interface MemoryEntry extends MemoryEntryInput {
	id: string;
	actor: Actor;
	trust: Trust;
	ttl: string;
	created: string;
	/** 1 for a first write; incremented by the `versioned` strategy. */
	version: number;
	/** The entry this one replaced, under `lww` or `versioned`. */
	supersedes?: string;
	/** Set once a later write replaced this entry. Superseded rows are not briefed. */
	superseded_by?: string;
	/** sha256 over the governed content. `verified_persisted` compares against it. */
	entry_hash: string;
	/** When this entry's trust expires and it must be re-verified before being acted on. */
	reverify_after?: string;
	/** Derived on read from `reverify_after`: true once the trust has decayed. */
	needs_reverification: boolean;
	idempotency_key?: string;
}

/** One parked write, as a reviewer's queue lists it. */
export interface GovernanceQueueRow {
	id: string;
	scope: string;
	kind: MemoryKind;
	writer: string;
	/** Why it is parked: a quarantine class, or what requires the review. */
	reason: string;
	created: string;
	/**
	 * The redacted body, and the subject it was filed under.
	 *
	 * Withheld from a caller that presents no reviewer token. Redaction strips
	 * credentials, not the email address or phone number that caused a PII quarantine —
	 * so a queue that showed every body to every agent would publish exactly what
	 * quarantining it was meant to contain.
	 */
	text?: string;
	subject?: string;
	/** Which pattern fired. Names no value, so it is safe to show unauthorised. */
	detail?: string;
}

export interface GovernanceQueue {
	/** False when bodies and subjects were withheld for want of a reviewer token. */
	authorized: boolean;
	reviews: GovernanceQueueRow[];
	quarantined: GovernanceQueueRow[];
}

/** A `memory.write` as it arrives at the governance gate. */
export interface MemoryWriteRequest extends MemoryEntryInput {
	/**
	 * Caller-chosen key that makes the write exactly-once. Supplying one is the
	 * only way to get that guarantee across an arbitrary gap; without one the gate
	 * derives a key from the content and dedupes retries for a day.
	 */
	idempotency_key?: string;
	/**
	 * The version the caller believes it is replacing, required by the `versioned`
	 * strategy. A mismatch is a `conflict`, never a silent overwrite.
	 */
	expected_version?: number;
	/**
	 * A reviewer's token. It is the only thing that releases a `require-review`
	 * scope, vouches for `human-confirmed` trust or an `actor: "human"` claim, and
	 * lifts a reviewable quarantine. Never stored, never echoed.
	 */
	review_token?: string;
}

/**
 * What `memory.write` answers.
 *
 * `outcome` is the governance decision; `verified_persisted` is durability, and
 * the two are deliberately separate — the same split as `EmitResult.stored`.
 * **A consumer that other agents will act on must require
 * `outcome === "accepted" && verified_persisted`**: an accepted write whose
 * read-back did not come back may or may not be in the index, and treating it as
 * durable is the failure this gate exists to prevent.
 */
export interface MemoryWriteResult {
	outcome: MemoryWriteOutcome;
	/** Stable, machine-readable, e.g. `rbac.no-grant` or `quarantine.secret`. */
	reason: string;
	/** One sentence the caller can act on. Always present, including on success. */
	remedy: string;
	/** True only when the row was read back from the index and matched its hash. */
	verified_persisted: boolean;
	/**
	 * The key this write was recorded under, derived when the caller sent none.
	 * Empty where the write was refused before any key was spent.
	 */
	idempotency_key: string;
	/**
	 * The surface the write was attributed to, and the one RBAC was decided on.
	 *
	 * Always reported, because it is not always what the caller asked for: a bearer
	 * token overrides a caller-named surface, and a silently ignored parameter is how
	 * an agent ends up believing it wrote as somebody else.
	 */
	writer: string;
	/** The stored entry, on `accepted`. */
	entry?: MemoryEntry;
	/** Set when the key had already been spent: this reply is a replay, not a write. */
	deduplicated?: boolean;
	strategy?: ConflictStrategy;
	/** The entry a `conflict` collided with, or the one an `lww` write replaced. */
	conflict_with?: string;
	/** Where a parked or refused write went, so a reviewer can find it. */
	review_id?: string;
	quarantine_id?: string;
	quarantine_reason?: QuarantineReason;
	/** Set when the gate would not honour the trust the caller asked for. */
	trust_downgraded_from?: Trust;
	/** Which rule allowed the write, for the audit trail. Null on a denial. */
	grant?: string | null;
}

/** Linear workflow states, as mapped in ~/.config/hermes-linear/config.yaml. */
export const NODE_STATES = [
	"backlog",
	"unstarted",
	"started",
	"started_review",
	"completed",
	"canceled",
	"duplicate",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export interface GraphNode {
	graph_id: string;
	node_id: string;
	linear_issue_id: string | null;
	linear_identifier: string | null;
	notion_page: string | null;
	state: NodeState | null;
	claimed_by: Surface | null;
	claimed_at: string | null;
	claim_session: string | null;
	/** The current lease's id, or null when nothing holds the node. See `lease.ts`. */
	lease_id: string | null;
	/** When the lease lapses. A row claimed before leases existed has none. */
	lease_expires_at: string | null;
	lease_heartbeat_at: string | null;
	/** Monotonic per node, bumped on every change of holder. The CAS token. */
	lease_epoch: number;
}

/**
 * Edges between Graph-of-Thought nodes, mirroring the Linear sub-issue
 * relations the same nodes carry.
 *
 * `requires`: `from_node` cannot proceed until `to_node` completes.
 * `blocks`:   the inverse, written from the blocking side.
 * `gated_by`: `from_node` waits on `to_node` for a reason outside the work
 *             itself — a review, a deploy, a human decision.
 *
 * They are held here so a claim can be checked against them without a Linear
 * round-trip on the critical path; Linear remains the source of truth.
 */
export const EDGE_KINDS = ["requires", "blocks", "gated_by"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface GraphEdge {
	graph_id: string;
	from_node: string;
	to_node: string;
	kind: EdgeKind;
}

export interface GraphStep {
	graph_id: string;
	node_id: string;
	step: number;
	linear_sub_issue_id: string | null;
	notion_page: string | null;
	state: NodeState | null;
}

export interface GraphIndexRow {
	graph_id: string;
	notion_task_page: string | null;
	repo: string | null;
	branch: string | null;
	surface: Surface | null;
	status: string | null;
	pr_url: string | null;
	created: string | null;
	updated: string | null;
}

export interface GraphView extends GraphIndexRow {
	nodes: GraphNode[];
	steps: GraphStep[];
	edges: GraphEdge[];
}
