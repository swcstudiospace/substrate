/**
 * Map Grok Build session events onto substrate events.
 *
 * Grok writes `~/.grok/sessions/<urlencoded-cwd>/<session-uuid>/events.jsonl`.
 * Across 89 sessions on this host the log is dominated by noise — 52,621
 * `phase_changed` against 2,550 real tool calls — so the mapper is a filter
 * first and a translator second. Emitting everything would bury the brief.
 */
import type { EventInput } from "../../mcp-server/src/types.ts";

export interface GrokEvent {
	ts?: string;
	type?: string;
	tool_name?: string;
	outcome?: string;
	duration_ms?: number;
	tool_call_id?: string;
	decision?: string;
	wait_ms?: number;
	session_id?: string;
	turn_number?: number;
	model_id?: string;
	server_name?: string;
	error_message?: string;
	[key: string]: unknown;
}

export interface GrokContext {
	/** Session UUID — the directory name, which is more reliable than the field. */
	sessionId: string;
	repo?: string | undefined;
	branch?: string | undefined;
}

/**
 * Types deliberately dropped, with the reason:
 *
 *   phase_changed    52,621 of them; UI spinner state, no semantic content
 *   first_token      per-turn latency marker
 *   loop_started     internal agent loop, not an action
 *   mcp_health_check periodic probe
 *   tool_started     always paired with tool_completed, which also carries the
 *                    outcome — emitting both doubles volume for no information
 *   permission_requested  paired with permission_resolved, which has the decision
 */
const DROPPED = new Set([
	"phase_changed",
	"first_token",
	"loop_started",
	"mcp_health_check",
	"tool_started",
	"permission_requested",
	"mcp_config_resolved",
	"mcp_init_completed",
	"mcp_init_cancelled",
	"mcp_server_starting",
	"mcp_server_connected",
]);

/** `%2Froot%2Fsrc%2Frepos` → `/root/src/repos` */
export function decodeSessionCwd(dirName: string): string | null {
	try {
		const decoded = decodeURIComponent(dirName);
		return decoded.startsWith("/") ? decoded.replace(/\/+$/, "") || "/" : null;
	} catch {
		// Not percent-encoded: not a session directory name, so there is no cwd.
		return null;
	}
}

/**
 * One Grok event → one substrate event, or null to drop it.
 *
 * Returning null is the common case and is not a failure.
 */
export function mapGrokEvent(event: GrokEvent, context: GrokContext): EventInput | null {
	const type = event.type;
	if (!type || DROPPED.has(type)) return null;

	const base = {
		surface: "grok-build" as const,
		session_id: context.sessionId,
		...(context.repo === undefined ? {} : { repo: context.repo }),
		...(context.branch === undefined ? {} : { branch: context.branch }),
		...(event.ts === undefined ? {} : { ts: event.ts }),
	};

	switch (type) {
		case "tool_completed": {
			const tool = event.tool_name ?? "unknown tool";
			const failed = event.outcome !== undefined && event.outcome !== "success";
			const duration = typeof event.duration_ms === "number" ? ` (${event.duration_ms}ms)` : "";
			return {
				...base,
				kind: "tool.call",
				summary: `${tool}${failed ? ` failed: ${event.outcome}` : ""}${duration}`,
				payload: {
					tool: tool,
					outcome: event.outcome,
					duration_ms: event.duration_ms,
					tool_call_id: event.tool_call_id,
				},
			};
		}

		case "turn_started":
			return {
				...base,
				kind: "prompt",
				summary: `turn ${event.turn_number ?? "?"} started${event.model_id ? ` on ${event.model_id}` : ""}`,
				payload: { turn: event.turn_number, model: event.model_id },
			};

		case "turn_ended":
			return {
				...base,
				kind: "note",
				summary: `turn ended: ${event.outcome ?? "unknown"}`,
				payload: { outcome: event.outcome },
			};

		// An allowed permission is the overwhelming default and says nothing. A
		// denial is a human intervening, which every other agent should see.
		case "permission_resolved": {
			if (event.decision === "allow") return null;
			return {
				...base,
				kind: "warning",
				summary: `permission ${event.decision ?? "unresolved"} for ${event.tool_name ?? "a tool"}`,
				payload: { tool: event.tool_name, decision: event.decision, wait_ms: event.wait_ms },
			};
		}

		case "mcp_server_failed":
			return {
				...base,
				kind: "warning",
				summary: `MCP server ${event.server_name ?? "?"} failed: ${event.error_message ?? "no detail"}`,
				payload: { server: event.server_name, error: event.error_message },
			};

		case "mcp_tool_call_started":
			return null; // paired with completed, same reasoning as tool_started

		case "mcp_tool_call_completed":
			return {
				...base,
				kind: "tool.call",
				summary: `mcp ${event.server_name ?? "?"}/${event.tool_name ?? "?"}`,
				payload: { server: event.server_name, tool: event.tool_name, outcome: event.outcome },
			};

		default:
			// An unrecognised type is recorded rather than dropped: Grok adds event
			// types over time and silent loss is worse than a low-value note.
			return { ...base, kind: "note", summary: `grok ${type}` };
	}
}
