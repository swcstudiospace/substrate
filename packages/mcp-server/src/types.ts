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
	"herdr",
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
	"agent.detected",
	"agent.status",
	"agent.exited",
	"brief.delivered",
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

export const MEMORY_KINDS = ["decision", "fact", "warning", "handoff", "todo"] as const;
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
