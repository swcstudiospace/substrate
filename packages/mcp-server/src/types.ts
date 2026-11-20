/** Shared shapes for the substrate. Mirrors Notion §5.2 and §5.3. */

/**
 * The 30 Agent Swarm agents, A01..A30 in order, one surface each.
 *
 * Real surfaces rather than one shared `swarm` surface: memory RBAC is default-deny
 * per surface and a lease holder is (surface, session_id), so a shared surface would
 * make all 30 agents one memory writer and one lease holder. Server-side each has its
 * own `SUBSTRATE_TOKEN_<SURFACE>`; see `docs/swarm-correlation.md`.
 */
export const SWARM_SURFACES = [
	"swarm-a01-orch",
	"swarm-a02-req",
	"swarm-a03-arch",
	"swarm-a04-uxd",
	"swarm-a05-be",
	"swarm-a06-fe",
	"swarm-a07-data",
	"swarm-a08-qa",
	"swarm-a09-rev",
	"swarm-a10-sec",
	"swarm-a11-devops",
	"swarm-a12-rel",
	"swarm-a13-obs",
	"swarm-a14-maint",
	"swarm-a15-doc",
	"swarm-a16-cloud",
	"swarm-a17-plat",
	"swarm-a18-supply",
	"swarm-a19-event",
	"swarm-a20-finops",
	"swarm-a21-k8s",
	"swarm-a22-gitops",
	"swarm-a23-mesh",
	"swarm-a24-ksec",
	"swarm-a25-resil",
	"swarm-a26-sol",
	"swarm-a27-audit",
	"swarm-a28-chain",
	"swarm-a29-dapp",
	"swarm-a30-custody",
] as const;
export type SwarmSurface = (typeof SWARM_SURFACES)[number];

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
	...SWARM_SURFACES,
	// Phase 17 (2026-10-08 operator decision): host jobs (anchor, skills sync,
	// dispatcher) emit under this reviewed system surface with payload.runtime
	// naming the job. EVENT_KINDS is unchanged. See docs/event-vocabulary.md.
	"substrate",
] as const;
export type Surface = (typeof SURFACES)[number];

export function isSwarmSurface(surface: string | null | undefined): surface is SwarmSurface {
	return typeof surface === "string" && (SWARM_SURFACES as readonly string[]).includes(surface);
}

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

/**
 * `SUBSTRATE_EVENT_IDEMPOTENCY` (U5-4a). `off` ignores `idempotency_key` and the replay marker;
 * `accept` stores a valid key and looks it up only for a replay-marked request; `enforce` looks
 * up every keyed request.
 */
export const EVENT_IDEMPOTENCY_MODES = ["off", "accept", "enforce"] as const;
export type EventIdempotencyMode = (typeof EVENT_IDEMPOTENCY_MODES)[number];

/** An event as a collector submits it. `id`, `ts`, `hash` and `prev` are filled in on ingest. */
export interface EventInput {
	surface: Surface;
	kind: EventKind;
	summary: string;
	session_id?: string | undefined;
	graph_id?: string | undefined;
	node_id?: string | undefined;
	linear_identifier?: string | undefined;
	step?: number | undefined;
	repo?: string | undefined;
	branch?: string | undefined;
	actor?: Actor | undefined;
	payload?: Record<string, unknown> | undefined;
	/** Collector-supplied timestamp; defaults to ingest time. */
	ts?: string | undefined;
	/**
	 * Optional replay key (U5-4a): 8-128 characters from `[A-Za-z0-9._:-]`. Honoured only under
	 * `SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce`, where it is stored as the reserved payload
	 * key `_ik`; under `off` it is ignored unread. See `docs/greptime-ledger.md`.
	 */
	idempotency_key?: string | undefined;
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

/**
 * What a serving read does with an entry past its `ttl` (uplift-3 N4,
 * `SUBSTRATE_MEMORY_EXPIRY`): `report` serves it tagged `expired`; `enforce`
 * leaves it out unless the caller asked for expired entries.
 */
export const MEMORY_EXPIRY_MODES = ["report", "enforce"] as const;
export type MemoryExpiryMode = (typeof MEMORY_EXPIRY_MODES)[number];

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
	subject?: string | undefined;
	actor?: Actor | undefined;
	source_event?: string | undefined;
	session_id?: string | undefined;
	graph_id?: string | undefined;
	repo?: string | undefined;
	trust?: Trust | undefined;
	ttl?: string | undefined;
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
	/**
	 * Derived on read from `ttl` (uplift-3 N4): true once the entry is past its
	 * lifetime, by `memoryExpiry`. Set by every index read that serves entries;
	 * absent on one that came another way — a write's reply, a fixture.
	 */
	expired?: boolean;
	/** When a `30d` entry expires, ISO. A `graph` entry's end is an event and carries none. */
	expires_at?: string;
	idempotency_key?: string;
}

/**
 * A memory search as the index runs it: every field already validated, and
 * `subjectPrefix` already normalised the way the gate normalises a subject.
 */
export interface MemorySearch {
	/** Full-text over the body; absent or empty matches every body. */
	query?: string;
	scope?: string;
	limit?: number;
	includeSuperseded?: boolean;
	/** Only entries whose stored subject starts with this, literally. */
	subjectPrefix?: string;
	/** Only entries written by this surface, exactly. */
	writer?: string;
	/** Only entries of this memory kind. */
	kind?: MemoryKind;
	/** Only entries created before this ISO timestamp — or, with `beforeId`, at it with a smaller id. */
	before?: string;
	beforeId?: string;
}

/** A keyset cursor: the `(created, id)` of the last entry a page returned. */
export interface MemorySearchCursor {
	/** ISO-8601, to the microsecond the index stores. */
	before: string;
	before_id: string;
}

/**
 * One page of a paged `memory_search`, ordered `created desc, id desc`.
 *
 * `next` is the pair to pass back as `before` and `before_id` for the page after
 * this one: set whenever the page came back full, null otherwise, so null is the
 * end. Its `before` carries the microseconds the index stores; an entry's own
 * `created` is cut to the millisecond and is not a cursor.
 */
export interface MemorySearchPage {
	entries: MemoryEntry[];
	next: MemorySearchCursor | null;
}

/**
 * The per-call half of lifetime handling on a serving read (uplift-3 N4). The
 * mode itself is the store's; a caller can only widen a read to expired entries,
 * and only after the operator gate let it.
 */
export interface MemoryReadOptions {
	/** Serve expired entries under `enforce` too. Gated on an operator token before it gets here. */
	includeExpired?: boolean;
	/** The caller, for the `substrate.memory.expired` series; `unattributed` when absent. */
	surface?: string;
	/**
	 * The repo the caller works in. An `agent:` row is read only in the repo it was written for, so a read that
	 * names none sees no agent row. Normalised with `normalizeIdentifier`, as the write stores it.
	 */
	repo?: string;
	/**
	 * Under repository scope, whether the caller is granted a repository. A row is returned only when its own repository and the
	 * repository its scope names are both granted. Absent while scoping is off, which grants every row.
	 */
	granted?: ((repo: string) => boolean) | undefined;
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
	/**
	 * The retention the proposal asked for, on a review row.
	 *
	 * A reviewer installs a proposal by re-submitting it with a token, and the write
	 * they send has to ask for what the proposal asked for — a `30d` proposal is not
	 * answered by a `permanent` entry, so leaving it out would install the wrong
	 * retention and leave the proposal pending with nothing in the queue to say why.
	 * Not withheld without a token: a retention class names no content.
	 */
	ttl?: string;
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
	idempotency_key?: string | undefined;
	/**
	 * The version the caller believes it is replacing, required by the `versioned`
	 * strategy. A mismatch is a `conflict`, never a silent overwrite.
	 */
	expected_version?: number | undefined;
	/**
	 * A reviewer's token. It is the only thing that releases a `require-review`
	 * scope, vouches for `human-confirmed` trust or an `actor: "human"` claim, and
	 * lifts a reviewable quarantine. Never stored, never echoed.
	 */
	review_token?: string | undefined;
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
	/**
	 * The version of the decision in force *now* for this write's subject, so a
	 * `versioned` conflict can be re-submitted without re-reading memory first.
	 *
	 * Present exactly on a `conflict` whose reason is `version.required`,
	 * `version.stale`, `version.raced` or `standing.raced`, for a write that resolves
	 * `versioned` (a `decision` with a subject), and only where the gate's lookup of
	 * the entry in force succeeded. `null` means no decision is in force for that
	 * subject, so the re-submit carries no `expected_version`. Absent on every other
	 * reply, including when the lookup failed — absence is never "nothing in force".
	 */
	current_version?: number | null;
	/** Where a parked or refused write went, so a reviewer can find it. */
	review_id?: string;
	quarantine_id?: string;
	quarantine_reason?: QuarantineReason;
	/** Set when the gate would not honour the trust the caller asked for. */
	trust_downgraded_from?: Trust;
	/** Which rule allowed the write, for the audit trail. Null on a denial. */
	grant?: string | null;
	/** Set only when the stored text was cut to the memory text cap. A cut is not a refusal. */
	truncated?: true;
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
	/**
	 * The current lease's id, or null when nothing holds the node. The index reads
	 * it; every reply nulls it, because only the holder may see it. See `lease.ts`.
	 */
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

/**
 * Which docs plane serves a retrieval. LightRAG backend.
 */
export const RETRIEVAL_BACKENDS = ["lightrag"] as const;
export type RetrievalBackend = (typeof RETRIEVAL_BACKENDS)[number];

/** LightRAG when configured, otherwise null. */
export function selectRetrievalBackend(
	available: { lightrag: boolean },
	prefer?: RetrievalBackend,
): RetrievalBackend | null {
	if (prefer !== undefined && available[prefer]) return prefer;
	if (available.lightrag) return "lightrag";
	return null;
}

/** One directed edge in a planning-graph hint: `source -[kind]-> target`. */
export interface PlanningGraphRelation {
	source: string;
	target: string;
	kind: string;
}

/**
 * Graph context a planning scan hands to ingest/retrieval so the LightRAG
 * plane can bias toward the entities and relations the plan actually names.
 * `phase` is the originating phase id (e.g. `"03-foundation"`); empty
 * entity/relation lists mean "no bias".
 */
export interface PlanningGraphHint {
	phase: string;
	entities: string[];
	relations: PlanningGraphRelation[];
}

/**
 * What the serving plane reports about graph coverage on a reply: the
 * entity/relation counts behind the citations. 0 means none or unknown.
 * Lives on `SearchReply.graph` (optional, LightRAG-served replies only).
 */
export interface SearchGraphStats {
	entities: number;
	relations: number;
}

/**
 * Which graph nodes back a citation: the matched entity names and, when the
 * backend reports it, how many relations support the chunk. Lives on
 * `SearchCitation.graph` (optional, LightRAG-served citations only; absent
 * on lightrag citations).
 */
export interface CitationGraphProvenance {
	entities: string[];
	relations?: number;
}
/**
 * Explicit RAG state machine for the GSD-Core optimization and RAG
 * replacement (SPE-19388, SPE-19384). The machine is owned by the serving
 * layer (`mcp.ts` singleton, shared with `server.ts` routes); the docs
 * search/ingest path only reports transitions, never mutates the machine
 * directly. Every transition is logged as one structured stderr line, and
 * the snapshot (with `stateHash` for polling change detection) is served
 * on `docs_rag_state` / `GET /rag/state`.
 */
export const RAG_STATES = ["IDLE", "STEERING", "CONTEXT_REFRESH", "DEGRADED", "ERROR"] as const;
export type RagState = (typeof RAG_STATES)[number];

/**
 * Allowed transitions. `IDLE` only steers; steering either refreshes
 * context or bails out; a refresh either lands or degrades; a degraded
 * plane may retry (steer again), recover, or trip the breaker to `ERROR`;
 * `ERROR` only leaves via a fresh steer or an explicit reset to `IDLE`.
 */
export const RAG_STATE_TRANSITIONS: Record<RagState, readonly RagState[]> = {
	IDLE: ["STEERING"],
	STEERING: ["CONTEXT_REFRESH", "IDLE", "DEGRADED"],
	CONTEXT_REFRESH: ["IDLE", "DEGRADED"],
	DEGRADED: ["STEERING", "ERROR", "IDLE"],
	ERROR: ["STEERING", "IDLE"],
};

/** Whether `from -> to` is an allowed transition. */
export function canTransitionRagState(from: RagState, to: RagState): boolean {
	return RAG_STATE_TRANSITIONS[from].includes(to);
}

/** Observable RAG machine snapshot. `stateHash` changes on every mutation. */
export interface RagStateSnapshot {
	state: RagState;
	updatedAt: string;
	consecutiveFailures: number;
	consecutiveSuccesses: number;
	lastReason?: string;
	stateHash: string;
}

/** Deterministic hash for snapshot change detection (FNV-1a, hex). */
export function ragStateHash(state: RagState, failures: number, successes: number, reason: string | undefined): string {
	const text = `${state}|${failures}|${successes}|${reason ?? ""}`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** One LightRAG REST `/query` hit, as the query surface serves it (REST/JSON). */
export interface RagLightragChunk {
	content: string;
	title: string;
	sourceUrl: string;
	score: number;
}

/**
 * What `docs_lightrag_query` / `POST /docs/lightrag/query` answers: the
 * LightRAG REST JSON result with graph coverage, the serving state, and —
 * when the plane failed and Hindsight answered instead — `fallback:
 * "hindsight"`. `degraded` is set only when nothing could be served.
 */
export interface RagLightragResult {
	backend: "lightrag";
	chunks: RagLightragChunk[];
	graph: SearchGraphStats;
	state: RagStateSnapshot;
	degraded?: true;
	reason?: string;
	fallback?: "hindsight";
}
