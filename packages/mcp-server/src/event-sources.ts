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
		carriesRepo: false,
		periodic: false,
		sample: () => ({
			surface: "claude-code",
			kind: "session.end",
			summary: "herdr pane-7 exited",
			session_id: "sess-p17-herdr-exited",
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
];
