/**
 * Map herdr pane transitions onto substrate events.
 *
 * herdr 0.9.1 pushes lifecycle events, but those pushes are triggers only.
 * The collector diffs `session.snapshot` and calls `transitionToEvent` for
 * each real change. This module owns the pinned agent-to-surface table, the
 * wire-name normaliser, and the one redacted `pane.output_matched` mapping
 * the collector deliberately does not subscribe to.
 */
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput, Surface } from "../../mcp-server/src/types.ts";

/**
 * herdr 0.9.1 `IntegrationTarget` rows that have a substrate surface, plus
 * the separate `muse` row (not in the enum: Muse reports itself by that
 * free-form name).
 */
export const HERDR_AGENT_SURFACES = {
	claude: "claude-code",
	codex: "codex",
	opencode: "opencode",
	pi: "pi",
	omp: "omp",
	hermes: "hermes",
	cursor: "cursor",
	grok: "grok-build",
	muse: "muse",
} as const satisfies Record<string, Surface>;

/**
 * The rest of the 0.9.1 enum. These, and any id outside the enum, are
 * counted as unmapped and never emitted.
 */
export const HERDR_UNMAPPED_AGENTS = [
	"copilot",
	"devin",
	"droid",
	"kimi",
	"kilo",
	"qodercli",
	"qwen",
	"mastracode",
	"antigravity_cli",
] as const;

export const HERDR_UNMAPPED = new Set<string>(HERDR_UNMAPPED_AGENTS);

/** Underscore wire names (global lifecycle) to the dotted canonical names. */
const WIRE_TO_DOTTED: Record<string, string> = {
	pane_created: "pane.created",
	pane_closed: "pane.closed",
	pane_exited: "pane.exited",
	pane_agent_detected: "pane.agent_detected",
	pane_agent_status_changed: "pane.agent_status_changed",
	pane_output_changed: "pane.output_changed",
	pane_output_matched: "pane.output_matched",
};

/** A pane record as `session.snapshot` returns it. */
export interface HerdrPane {
	pane_id: string;
	terminal_id?: string;
	agent?: string | null;
	agent_status?: string;
	cwd?: string;
	foreground_cwd?: string;
	terminal_title?: string;
	revision?: number;
	agent_session?: unknown;
	workspace_id?: string;
	tab_id?: string;
}

/** One push envelope field set. Lifecycle pushes are not mapped from this. */
export interface HerdrEvent {
	type?: string;
	event?: string;
	pane_id?: string;
	released?: boolean;
	agent?: string;
	matched_line?: string;
	output_matched?: string;
	matched_text?: string;
	[key: string]: unknown;
}

export type HerdrRowId = "herdr.agent_detected" | "herdr.status_changed" | "herdr.pane_exited";

/** One reconciled transition, ready to become an event. */
export interface HerdrTransition {
	rowId: HerdrRowId;
	surface: Surface;
	agent: string;
	pane_id: string;
	terminal_id: string;
	session_id: string;
	repo?: string;
	branch?: string;
	status?: string;
	previous_status?: string;
	end_reason?: "pane_gone" | "agent_released";
	herdr_type: "pane.agent_detected" | "pane.agent_status_changed" | "pane.exited";
}

/** Map an underscore or dotted wire name onto the dotted canonical name. */
export function normalizeWireName(name: string): string {
	return WIRE_TO_DOTTED[name] ?? name;
}

/** `pane_agent_detected` with `released: true` is a release, not a detection. */
export function isRelease(data: unknown): boolean {
	return typeof data === "object" && data !== null && (data as { released?: unknown }).released === true;
}

/** The substrate surface for a herdr agent id, or null when it is not emitted. */
export function surfaceForHerdrAgent(agent: string | null | undefined): Surface | null {
	if (!agent) return null;
	const table: Record<string, Surface> = HERDR_AGENT_SURFACES;
	return Object.prototype.hasOwnProperty.call(table, agent) ? (table[agent] ?? null) : null;
}

/** One reconciled transition → one substrate event. Never throws. */
export function transitionToEvent(transition: HerdrTransition): EventInput {
	const payload: Record<string, unknown> = {
		runtime: "herdr",
		herdr_type: transition.herdr_type,
		pane_id: transition.pane_id,
		agent: transition.agent,
	};
	let summary: string;
	let kind: EventInput["kind"];
	if (transition.rowId === "herdr.agent_detected") {
		kind = "session.start";
		if (transition.status !== undefined) payload.status = transition.status;
		summary = `herdr detected ${transition.surface} in pane ${transition.pane_id}`;
	} else if (transition.rowId === "herdr.status_changed") {
		kind = "note";
		payload.status = transition.status;
		payload.previous_status = transition.previous_status;
		summary = `herdr: ${transition.previous_status ?? "unknown"} → ${transition.status ?? "unknown"} (pane ${transition.pane_id})`;
	} else {
		kind = "session.end";
		if (transition.end_reason) payload.end_reason = transition.end_reason;
		summary = `herdr pane ${transition.pane_id} exited`;
	}
	const event: EventInput = {
		surface: transition.surface,
		kind,
		summary,
		session_id: transition.session_id,
		actor: "agent",
		payload,
	};
	if (transition.repo) event.repo = transition.repo;
	if (transition.branch) event.branch = transition.branch;
	return event;
}

/**
 * The redacted `herdr.other` mapping for `pane.output_matched`.
 *
 * Lifecycle pushes return null: the reconciler, not the push, decides those.
 * A pane with no mapped agent emits nothing. The event never carries `repo`.
 */
export function mapHerdrEvent(event: HerdrEvent, pane: HerdrPane | undefined): EventInput | null {
	const raw = event.type ?? event.event;
	if (typeof raw !== "string" || raw.length === 0) return null;
	if (normalizeWireName(raw) !== "pane.output_matched") return null;
	const agent = typeof event.agent === "string" ? event.agent : pane?.agent ?? undefined;
	const surface = surfaceForHerdrAgent(agent ?? null);
	if (!agent || !surface) return null;
	const paneId = event.pane_id ?? pane?.pane_id;
	const matched = event.matched_line ?? event.output_matched ?? event.matched_text;
	const redacted = typeof matched === "string" ? redact(matched) : undefined;
	return {
		surface,
		kind: "note",
		actor: "agent",
		summary: redacted ? `pane ${paneId ?? "?"} matched: ${redacted}` : `pane ${paneId ?? "?"} output matched`,
		payload: {
			runtime: "herdr",
			herdr_type: "pane.output_matched",
			pane_id: paneId,
			agent,
			...(redacted !== undefined ? { matched: redacted } : {}),
		},
	};
}
