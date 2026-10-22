/**
 * Session view STATES (phase 54, SOTA-10).
 *
 * One pure function turns what the planning view knows into exactly one state with a
 * human-readable line. Nothing here reads a clock, an env var or a store: the caller
 * passes the facts in. Precedence, first match wins:
 *
 *   ERROR → LOADING → DEGRADED → EMPTY → STALE → SUCCESS
 *
 * A session classified `unknown` (its record could not be read) does not make the view
 * STALE: it is not known to be stale, and `presence.ts` never guesses. The text is never
 * blank, whatever the input.
 */

export const SESSION_STATES = ["LOADING", "EMPTY", "STALE", "DEGRADED", "ERROR", "SUCCESS"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionClassification = "active" | "stale" | "unknown";

export interface SessionViewInput {
	/** Whether the view has finished its first read. */
	loaded: boolean;
	/** One entry per session the view lists. */
	sessions: readonly SessionClassification[];
	/** Names of capabilities that are switched off or unavailable. Blank names are ignored. */
	disabledCapabilities: readonly string[];
	/** A failure message from the read, or null/undefined when the read did not fail. Blank means no failure. */
	error?: string | null;
}

export interface SessionViewState {
	state: SessionState;
	text: string;
}

function present(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** The single state a session view is in, with the line a person reads for it. */
export function deriveSessionState(input: SessionViewInput): SessionViewState {
	const error = present(input.error);
	if (error !== null) return { state: "ERROR", text: `Error: the session view failed to load (${error}).` };

	if (!input.loaded) return { state: "LOADING", text: "Loading sessions." };

	const disabled = input.disabledCapabilities.map((name) => name.trim()).filter((name) => name !== "");
	if (disabled.length > 0) {
		return { state: "DEGRADED", text: `Degraded: ${disabled.join(", ")} ${disabled.length === 1 ? "is" : "are"} disabled, so this view is partial.` };
	}

	if (input.sessions.length === 0) return { state: "EMPTY", text: "No sessions have sent a heartbeat yet." };

	const stale = input.sessions.filter((status) => status === "stale").length;
	if (stale > 0) {
		return { state: "STALE", text: `${stale} of ${input.sessions.length} ${input.sessions.length === 1 ? "session is" : "sessions are"} stale: no heartbeat within the freshness window.` };
	}

	const active = input.sessions.filter((status) => status === "active").length;
	const unknown = input.sessions.length - active;
	const noun = active === 1 ? "session is" : "sessions are";
	if (unknown === 0) return { state: "SUCCESS", text: `${active} ${noun} active.` };
	return { state: "SUCCESS", text: `${active} ${noun} active; ${unknown} could not be classified.` };
}
