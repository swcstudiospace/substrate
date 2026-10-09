/**
 * The v1.3 event-source mapping, encoded once as a typed table.
 *
 * Every event source v1.3 adds maps onto the existing 12 `EVENT_KINDS` and
 * onto `SURFACES` — no kind is added, and the only surface added is the
 * reviewed host-job surface `substrate` (Phase 17, operator 2026-10-08).
 * Later phases implement against this table instead of inventing kinds, and
 * `docs/event-vocabulary.md` holds the same mapping as a reviewed document;
 * `event-sources.test.ts` asserts the two cannot drift.
 *
 * Side-effect-free by construction: this module imports only `./types.ts`, so
 * collectors and the projector can import it the way `grok-map.ts` imports
 * `types.ts` without dragging in the write path.
 */
import type { EventInput, EventKind, Surface } from "./types.ts";

/**
 * How a row's sample surface is chosen.
 *
 * - `{ fixed: Surface }` — always this surface (`muse`, `cursor`,
 *   `claude-code` for Lane A, `substrate` for host jobs).
 * - `"herdr-agent"` — the agent herdr detected, mapped onto `SURFACES` by
 *   Phase 19's fixed table. Samples use a concrete surface.
 * - `"caller"` — the authenticated caller, never body-supplied.
 * - `"memory-writer"` — the memory's writer. Samples use `hermes`.
 * - `"lease-holder"` — the lease holder. Samples use `claude-code`.
 *
 * There is deliberately no `job-token` variant: host jobs emit as fixed
 * `substrate` (operator decision 2026-10-08), with `payload.runtime` naming
 * the job (`anchor`, `skills-sync`, `dispatcher`).
 */
export type SurfaceRule =
	| { fixed: Surface }
	| "herdr-agent"
	| "caller"
	| "memory-writer"
	| "lease-holder";

export interface EventSource {
	/** Stable key shared with `docs/event-vocabulary.md`. */
	id: string;
	/** The v1.3 phase that implements this source. */
	phase: number;
	/** Exactly one kind — a kind outside the enum is a type error. */
	kind: EventKind;
	surface: SurfaceRule;
	/** `payload.action` values this row may carry. Absent when the row has none. */
	actions?: readonly string[];
	/** `payload.runtime` for a non-agent producer. */
	runtime?: string;
	/** True only where the event is work in that repo. */
	carriesRepo: boolean;
	/** Job/timer emitter. A periodic row must not carry `repo`. */
	periodic: boolean;
	/** A concrete, deterministic `EventInput`. No `ts`: ingest stamps it. */
	sample(): EventInput;
}

/** A source that deliberately emits nothing (a read, or a self-triggering write). */
export interface SilentSource {
	id: string;
	phase: number;
	/** Why it emits nothing — the trail it leaves instead. */
	reason: string;
}

const HEX_64 = "0123456789abcdef".repeat(4);

export const EVENT_SOURCES: readonly EventSource[] = [
	{
		id: "herdr.agent_detected",
		phase: 19,
		kind: "session.start",
		surface: "herdr-agent",
		runtime: "herdr",
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "session.start",
			summary: "herdr detected claude-code in pane-7",
			session_id: "sess-p17-herdr-detected",
			repo: "swcstudiospace/agent-substrate",
			payload: { runtime: "herdr", herdr_type: "pane.agent_detected", pane_id: "pane-7" },
		}),
	},
	{
		id: "herdr.status_changed",
		phase: 19,
		kind: "note",
		surface: "herdr-agent",
		runtime: "herdr",
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "herdr status change in pane-7: idle to working",
			session_id: "sess-p17-herdr-status",
			repo: "swcstudiospace/agent-substrate",
			payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", status: "working", pane_id: "pane-7" },
		}),
	},
	{
		id: "herdr.pane_exited",
		phase: 19,
		kind: "session.end",
		surface: "herdr-agent",
		runtime: "herdr",
		// Phase 19 (D19-11): the exit is found by events_query(repo=R). The
		// brief excludes session.start and session.end, so this does not crowd it.
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "session.end",
			summary: "herdr pane-7 exited",
			session_id: "sess-p17-herdr-exited",
			repo: "swcstudiospace/agent-substrate",
			payload: { runtime: "herdr", herdr_type: "pane.exited", pane_id: "pane-7" },
		}),
	},
	{
		id: "herdr.other",
		phase: 19,
		kind: "note",
		surface: "herdr-agent",
		runtime: "herdr",
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "herdr pane-7 output matched",
			session_id: "sess-p17-herdr-other",
			payload: { runtime: "herdr", herdr_type: "pane.output_matched", pane_id: "pane-7" },
		}),
	},
	{
		id: "skills.propose",
		phase: 21,
		kind: "note",
		surface: "caller",
		actions: ["skill.propose"],
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "proposed skill p17-demo: opened",
			session_id: "sess-p17-skills-propose",
			repo: "swcstudiospace/agent-skills",
			payload: {
				action: "skill.propose",
				name: "p17-demo",
				status: "opened",
				pr_url: "https://github.com/swcstudiospace/agent-skills/pull/12",
				content_sha256: HEX_64,
			},
		}),
	},
	{
		id: "skills.propose.refused",
		phase: 21,
		kind: "warning",
		surface: "caller",
		actions: ["skill.propose"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "refused skill proposal p17-demo: policy",
			session_id: "sess-p17-skills-propose",
			payload: { action: "skill.propose", status: "refused", reason: "policy", rules: ["skill-propose-policy"] },
		}),
	},
	{
		id: "skills.propose.failed",
		phase: 21,
		kind: "warning",
		surface: "caller",
		actions: ["skill.propose"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "skill proposal p17-demo failed: git push exited 1",
			session_id: "sess-p17-skills-propose",
			payload: { action: "skill.propose", status: "failed", name: "p17-demo", reason: "git push exited 1" },
		}),
	},
	{
		id: "skills.sync.refused",
		phase: 22,
		kind: "warning",
		surface: { fixed: "substrate" },
		actions: ["skills.sync"],
		runtime: "skills-sync",
		carriesRepo: false,
		periodic: true,
		sample: () => ({
			surface: "substrate",
			kind: "warning",
			summary: "skills sync refused: dirty",
			session_id: "skills-sync:2026-10-08T00",
			payload: { action: "skills.sync", runtime: "skills-sync", reason: "dirty" },
		}),
	},
	{
		id: "docs.search",
		phase: 25,
		kind: "note",
		surface: "caller",
		actions: ["docs.search"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "docs search returned 3 results",
			session_id: "sess-p17-docs-search",
			payload: { action: "docs.search", dataset_ids: ["ds-p17"], urls: ["https://example.com/p17"], count: 3 },
		}),
	},
	{
		id: "docs.search.failed",
		phase: 25,
		kind: "warning",
		surface: "caller",
		actions: ["docs.search"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "docs search failed: ragflow-unreachable",
			session_id: "sess-p17-docs-search",
			payload: { action: "docs.search", reason: "ragflow-unreachable" },
		}),
	},
	{
		id: "docs.ingest",
		phase: 25,
		kind: "note",
		surface: "caller",
		actions: ["docs.ingest"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "docs ingest uploaded ds-p17",
			session_id: "sess-p17-docs-ingest",
			payload: {
				action: "docs.ingest",
				dataset_id: "ds-p17",
				source_url: "https://example.com/p17",
				content_sha256: HEX_64,
				status: "uploaded",
			},
		}),
	},
	{
		id: "docs.ingest.refused",
		phase: 25,
		kind: "warning",
		surface: "caller",
		actions: ["docs.ingest"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "docs ingest refused: policy",
			session_id: "sess-p17-docs-ingest",
			payload: { action: "docs.ingest", status: "refused", reason: "policy", rules: ["docs-ingest-policy"] },
		}),
	},
	{
		id: "memory.retain.failed",
		phase: 26,
		kind: "warning",
		surface: "memory-writer",
		actions: ["memory.retain"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "hermes",
			kind: "warning",
			summary: "hindsight retain failed: store-unreachable",
			session_id: "sess-p17-memory-retain",
			payload: { action: "memory.retain", reason: "store-unreachable" },
		}),
	},
	{
		id: "desktop.action",
		phase: 30,
		kind: "tool.call",
		surface: "caller",
		actions: ["click", "type", "key", "screenshot"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "tool.call",
			summary: "desktop_run screenshot ok (120ms)",
			session_id: "sess-p17-desktop",
			payload: {
				tool: "desktop_run",
				action: "screenshot",
				run_id: "run-p17-1",
				i: 0,
				ok: true,
				ms: 120,
				sha256: HEX_64,
				width: 1280,
				height: 800,
			},
		}),
	},
	{
		id: "anchor.written",
		phase: 28,
		kind: "note",
		surface: { fixed: "substrate" },
		actions: ["anchor"],
		runtime: "anchor",
		carriesRepo: false,
		periodic: true,
		sample: () => ({
			surface: "substrate",
			kind: "note",
			summary: "anchored hour 2026-10-08T00: 41 events",
			session_id: "anchor:2026-10-08T00",
			payload: {
				action: "anchor",
				runtime: "anchor",
				period_start: "2026-10-08T00:00:00Z",
				period_end: "2026-10-08T01:00:00Z",
				root: HEX_64,
				event_count: 41,
				tx_sig: "5p17demoanchorTXsig11111111111111111111111111111111111",
				cluster: "devnet",
				adopted: false,
			},
		}),
	},
	{
		id: "anchor.failed",
		phase: 28,
		kind: "warning",
		surface: { fixed: "substrate" },
		actions: ["anchor"],
		runtime: "anchor",
		carriesRepo: false,
		periodic: true,
		sample: () => ({
			surface: "substrate",
			kind: "warning",
			summary: "anchor failed for hour 2026-10-08T00: send-failed",
			session_id: "anchor:2026-10-08T00",
			payload: { action: "anchor", runtime: "anchor", period_start: "2026-10-08T00:00:00Z", reason: "send-failed" },
		}),
	},
	{
		id: "teachable.accepted",
		phase: 29,
		kind: "note",
		surface: "memory-writer",
		actions: ["teachable"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "hermes",
			kind: "note",
			summary: "teachable accepted: retry-budget",
			session_id: "sess-p17-teachable",
			payload: { action: "teachable", memory_id: "mem-p17-1", subject: "retry-budget", content_sha256: HEX_64 },
		}),
	},
	{
		id: "mirror.failed",
		phase: 23,
		kind: "warning",
		surface: "lease-holder",
		actions: ["mirror"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "claim mirror failed: linear comment timed out",
			session_id: "sess-p17-mirror",
			graph_id: "ut-p17-mirror",
			payload: { action: "mirror", target: "linear", op: "comment", reason: "timeout" },
		}),
	},
	{
		id: "lease.release.dod",
		phase: 23,
		kind: "note",
		surface: "lease-holder",
		actions: ["released"],
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "released SPE-1",
			session_id: "sess-p17-dod",
			graph_id: "ut-p17-dod",
			node_id: "n2",
			repo: "swcstudiospace/agent-substrate",
			payload: { action: "released", lease_epoch: 3, dod: { checks: ["unit-tests-pass"] } },
		}),
	},
	{
		id: "dod.refused",
		phase: 23,
		kind: "warning",
		surface: "lease-holder",
		actions: ["dod"],
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "dod gate refused: checks-unmet",
			session_id: "sess-p17-dod",
			graph_id: "ut-p17-dod",
			node_id: "n2",
			payload: { action: "dod", reason: "checks-unmet" },
		}),
	},
	{
		id: "dispatch.outcome",
		phase: 24,
		kind: "note",
		surface: { fixed: "substrate" },
		actions: ["dispatch"],
		runtime: "dispatcher",
		carriesRepo: false,
		periodic: true,
		sample: () => ({
			surface: "substrate",
			kind: "note",
			summary: "dispatched ut-p17-dispatch: launched",
			session_id: "dispatch:ut-p17-dispatch:0",
			graph_id: "ut-p17-dispatch",
			payload: { action: "dispatch", runtime: "dispatcher", outcome: "launched", graph_id: "ut-p17-dispatch" },
		}),
	},
	{
		id: "dispatch.failed",
		phase: 24,
		kind: "warning",
		surface: { fixed: "substrate" },
		actions: ["dispatch"],
		runtime: "dispatcher",
		carriesRepo: false,
		periodic: true,
		sample: () => ({
			surface: "substrate",
			kind: "warning",
			summary: "dispatch failed for ut-p17-dispatch: no-capacity",
			session_id: "dispatch:ut-p17-dispatch:0",
			graph_id: "ut-p17-dispatch",
			payload: { action: "dispatch", runtime: "dispatcher", outcome: "failed", reason: "no-capacity" },
		}),
	},
	{
		id: "lanea.session_start",
		phase: 32,
		kind: "session.start",
		surface: { fixed: "claude-code" },
		runtime: "agentos",
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "session.start",
			summary: "lane A session opened for ut-p17-lanea",
			session_id: "sess-p17-lanea",
			graph_id: "ut-p17-lanea",
			payload: { runtime: "agentos", graph_id: "ut-p17-lanea", node_id: "n1" },
		}),
	},
	{
		id: "lanea.session_end",
		phase: 32,
		kind: "session.end",
		surface: { fixed: "claude-code" },
		runtime: "agentos",
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "session.end",
			summary: "lane A session closed for ut-p17-lanea",
			session_id: "sess-p17-lanea",
			graph_id: "ut-p17-lanea",
			payload: { runtime: "agentos", graph_id: "ut-p17-lanea", node_id: "n1" },
		}),
	},
	{
		id: "lanea.approval",
		phase: 33,
		kind: "note",
		surface: { fixed: "claude-code" },
		actions: ["approval"],
		runtime: "agentos",
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "note",
			summary: "lane A approval requested for ut-p17-lanea",
			session_id: "sess-p17-lanea-approval",
			graph_id: "ut-p17-lanea",
			payload: { action: "approval", runtime: "agentos", decision: "requested" },
		}),
	},
	{
		id: "lanea.approval.denied",
		phase: 33,
		kind: "warning",
		surface: { fixed: "claude-code" },
		actions: ["approval"],
		runtime: "agentos",
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "warning",
			summary: "lane A approval denied for ut-p17-lanea",
			session_id: "sess-p17-lanea-approval",
			graph_id: "ut-p17-lanea",
			payload: { action: "approval", runtime: "agentos", decision: "denied", reason: "operator-denied" },
		}),
	},
	{
		id: "muse.tool_call",
		phase: 19,
		kind: "tool.call",
		surface: { fixed: "muse" },
		carriesRepo: true,
		periodic: false,
		sample: () => ({
			surface: "muse",
			kind: "tool.call",
			summary: "Read succeeded (42ms)",
			session_id: "sess-p17-muse-tool",
			repo: "swcstudiospace/agent-substrate",
			branch: "main",
			payload: { tool: "Read", outcome: "success", duration_ms: 42, tool_call_id: "call-p17-1" },
		}),
	},
	{
		id: "cursor.stop",
		phase: 19,
		kind: "session.end",
		surface: { fixed: "cursor" },
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "cursor",
			kind: "session.end",
			summary: "cursor session ended",
			session_id: "sess-p17-cursor-stop",
			actor: "human",
			payload: { conversation_id: "conv-p17-1", transcript_ref: "cursor-transcript-conv-p17-1", status: "completed" },
		}),
	},
];

export const SILENT_SOURCES: readonly SilentSource[] = [
	{
		id: "muse.brief_writer",
		phase: 19,
		reason: "Deliberately not an event: a note with repo per refresh would enter that repo's brief, change it, and re-trigger itself. The written BRIEF.md and local counters are its trail.",
	},
	{
		id: "memory.retain",
		phase: 26,
		reason: "A successful retain emits nothing; only a failure is a warning. Reads do not emit, like memory_search.",
	},
	{
		id: "memory.recall",
		phase: 26,
		reason: "A read inside an agent's turn; reads do not emit.",
	},
	{
		id: "agent_card",
		phase: 29,
		reason: "The Agent Card route is a read; it emits nothing.",
	},
	{
		id: "verify",
		phase: 28,
		reason: "Verification is a read; it emits nothing.",
	},
	{
		id: "issue_get",
		phase: 23,
		reason: "A read of untrusted tracker text; it emits nothing.",
	},
	{
		id: "graph_find",
		phase: 23,
		reason: "A read of the index; it emits nothing.",
	},
	{
		id: "skills.sync",
		phase: 22,
		reason: "A successful sync emits nothing; only a refusal is a warning. The synced tree is its trail.",
	},
	{
		id: "mirror",
		phase: 23,
		reason: "A successful mirror emits nothing; only a failure is a warning. The Linear comment is its trail.",
	},
];
