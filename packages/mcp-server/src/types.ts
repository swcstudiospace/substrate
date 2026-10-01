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

export type Actor = "agent" | "human";

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

export const MEMORY_KINDS = ["decision", "fact", "warning", "handoff", "todo", "teachable"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TRUST_LEVELS = ["agent-claimed", "human-confirmed", "verified-by-test"] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

export interface MemoryEntryInput {
	/** `graph:<id>` | `repo:<name>` | `global` | `agent:<surface>` | `person:<name>` */
	scope: string;
	kind: MemoryKind;
	text: string;
	writer: Surface | string;
	source_event?: string;
	trust?: Trust;
	/** `graph` | `30d` | `permanent` */
	ttl?: string;
}

export interface MemoryEntry extends MemoryEntryInput {
	id: string;
	trust: Trust;
	ttl: string;
	created: string;
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
	lease_expires_at: string | null;
	lease_heartbeat_at: string | null;
	lease_token: string | null;
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
}

/** A2A Agent Card (Linux Foundation draft + user Teachable Moments). */
export interface AgentCard {
  agent: string;
  surface: Surface;
  version: string;
  skills: Array<{ name: string; framing: string; tags: string[] }>;
  teachables: TeachableMoment[];
}

/** Teachable Moment: reverse skill from session (observations, edge cases, learnings) — not recall. */
export interface TeachableMoment {
  graph_id: string;
  node_id?: string;
  framing: string;           // short name for AgentCard.skills[]
  observations: string[];
  edges: string[];
  learnings: string[];
  session_summary?: string;
  prev_event_hash?: string;
  solana_anchor?: string;    // tx sig or memo id on devnet
  ts: string;
}

/** Return codes for the memory policy gate (v0.3 contract). memory_write now returns one of these. */
export type MemoryWriteStatus = "accepted" | "conflict" | "quarantined" | "denied";

/** Result wrapper returned by gated memory writes. Non-accepted outcomes carry diagnostic info instead of (or in addition to) an entry. */
export interface MemoryWriteResult {
	status: MemoryWriteStatus;
	/** The stored entry. Only populated for "accepted" (and some "conflict" cases that resolve to a winner). */
	entry?: MemoryEntry;
	/** Why the gate produced a non-accepted status. */
	reason?: string;
	/** Actionable guidance back to the caller. */
	remedy?: string;
}

/** In-memory representation of the memory governance policy. Default-deny RBAC over surface×scope×kind. */
export interface MemoryPolicy {
	version: string;
	defaultAction: "deny";
	rules: Array<{
		surface: Surface | "*";
		scope: string | "*";
		kind: MemoryKind | "*";
		action: "allow" | MemoryWriteStatus;
	}>;
	conflictStrategy: Partial<Record<MemoryKind, "last-write-wins" | "versioned" | "require-review">>;
}

/** Signature for the policy loader (implemented in config; real version will read YAML without adding runtime deps for the skeleton). */
export type PolicyLoader = (env?: Record<string, string | undefined>) => MemoryPolicy;
