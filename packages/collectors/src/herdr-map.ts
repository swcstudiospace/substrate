/**
 * Map herdr pane events onto substrate events.
 *
 * herdr 0.9.1's socket seam pushes per-pane lifecycle events once a pane is
 * individually subscribed (see herdr.ts — a wildcard `agent_status_changed`
 * subscription is impossible, `pane_id` is a required field). This mapper
 * turns one such event, plus the pane record the collector holds from its
 * last `session.snapshot`, into one substrate `EventInput`.
 */
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";

export interface HerdrEvent {
	type?: string;
	pane_id?: string;
	/** New status carried by `pane.agent_status_changed`. */
	agent_status?: string;
	/** Terminal text a `pane.output_matched` event matched against. */
	output_matched?: string;
	matched_text?: string;
	[key: string]: unknown;
}

/** A pane record as `session.snapshot` returns it. */
export interface HerdrPane {
	pane_id: string;
	agent_status?: string;
	cwd?: string;
	foreground_cwd?: string;
	terminal_title?: string;
	revision?: number;
}

/** The pane's cwd is what attributes an event to a repo (D-02 addendum). */
function repoFor(pane: HerdrPane | undefined): string | undefined {
	return pane?.cwd ?? pane?.foreground_cwd ?? undefined;
}

/**
 * One herdr pane event → one substrate event, or null to drop it.
 *
 * `pane` is the current snapshot record for `event.pane_id`, or undefined
 * when the collector has no record for it yet — this must never throw.
 */
export function mapHerdrEvent(event: HerdrEvent, pane: HerdrPane | undefined): EventInput | null {
	const type = event.type;
	if (!type) return null;

	const paneId = event.pane_id ?? pane?.pane_id;
	const repo = repoFor(pane);
	const base = {
		surface: "herdr" as const,
		repo,
	};

	switch (type) {
		case "pane.agent_detected":
			return {
				...base,
				kind: "agent.detected",
				summary: `agent detected on pane ${paneId ?? "?"}`,
				payload: { pane_id: paneId },
			};

		case "pane.agent_status_changed": {
			const status = event.agent_status ?? pane?.agent_status;
			return {
				...base,
				kind: "agent.status",
				summary: `pane ${paneId ?? "?"} agent status: ${status ?? "unknown"}`,
				payload: { pane_id: paneId, status },
			};
		}

		case "pane.exited":
			return {
				...base,
				kind: "agent.exited",
				summary: `pane ${paneId ?? "?"} exited`,
				payload: { pane_id: paneId },
			};

		case "pane.output_matched": {
			const matched = event.output_matched ?? event.matched_text;
			const redacted = typeof matched === "string" ? redact(matched) : undefined;
			return {
				...base,
				kind: "note",
				summary: redacted ? `pane ${paneId ?? "?"} matched: ${redacted}` : `pane ${paneId ?? "?"} output matched`,
				payload: { pane_id: paneId, matched: redacted },
			};
		}

		default:
			// herdr adds event types over time; silent loss is worse than a thin
			// note, matching grok-map.ts's deliberate default.
			return { ...base, kind: "note", summary: `herdr ${type} on pane ${paneId ?? "?"}` };
	}
}
