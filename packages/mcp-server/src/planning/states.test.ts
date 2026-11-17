/**
 * The session view state: one state per input, by fixed precedence (ERROR, LOADING, DEGRADED,
 * EMPTY, STALE, SUCCESS), with a non-blank line for each.
 */
import { describe, expect, test } from "bun:test";
import { SESSION_STATES, deriveSessionState, type SessionViewInput } from "./states.ts";

const READY: SessionViewInput = { loaded: true, sessions: ["active"], disabledCapabilities: [], error: null };

describe("deriveSessionState precedence", () => {
	test("an error wins over every other condition", () => {
		const view = deriveSessionState({ loaded: false, sessions: ["stale"], disabledCapabilities: ["presence"], error: "dragonfly timeout" });
		expect(view.state).toBe("ERROR");
	});

	test("loading wins over degraded, empty and stale", () => {
		expect(deriveSessionState({ loaded: false, sessions: [], disabledCapabilities: ["presence"] }).state).toBe("LOADING");
		expect(deriveSessionState({ loaded: false, sessions: ["stale"], disabledCapabilities: [] }).state).toBe("LOADING");
	});

	test("degraded wins over empty and stale", () => {
		expect(deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: ["history"] }).state).toBe("DEGRADED");
		expect(deriveSessionState({ loaded: true, sessions: ["stale"], disabledCapabilities: ["history"] }).state).toBe("DEGRADED");
	});

	test("no sessions is EMPTY", () => {
		expect(deriveSessionState({ ...READY, sessions: [] }).state).toBe("EMPTY");
	});

	test("any stale session is STALE, even beside active ones", () => {
		expect(deriveSessionState({ ...READY, sessions: ["active", "stale"] }).state).toBe("STALE");
	});

	test("an unknown session does not make the view STALE", () => {
		expect(deriveSessionState({ ...READY, sessions: ["unknown"] }).state).toBe("SUCCESS");
	});

	test("all active sessions are SUCCESS", () => {
		expect(deriveSessionState({ ...READY, sessions: ["active", "active"] }).state).toBe("SUCCESS");
	});

	test("a blank error is no error", () => {
		expect(deriveSessionState({ ...READY, error: "   " }).state).toBe("SUCCESS");
	});

	test("blank capability names are not disabled capabilities", () => {
		expect(deriveSessionState({ ...READY, disabledCapabilities: ["", "  "] }).state).toBe("SUCCESS");
	});
});

describe("deriveSessionState text", () => {
	test("every state has a non-blank line", () => {
		const inputs: SessionViewInput[] = [
			{ loaded: true, sessions: [], disabledCapabilities: [], error: "boom" },
			{ loaded: false, sessions: [], disabledCapabilities: [] },
			{ loaded: true, sessions: [], disabledCapabilities: ["history"] },
			{ loaded: true, sessions: [], disabledCapabilities: [] },
			{ loaded: true, sessions: ["stale"], disabledCapabilities: [] },
			{ loaded: true, sessions: ["active"], disabledCapabilities: [] },
		];
		const states = inputs.map((input) => deriveSessionState(input));
		expect(states.map((view) => view.state)).toEqual(["ERROR", "LOADING", "DEGRADED", "EMPTY", "STALE", "SUCCESS"]);
		for (const view of states) expect(view.text.trim()).not.toBe("");
	});

	test("every state name is one of the six", () => {
		expect([...SESSION_STATES].sort()).toEqual(["DEGRADED", "EMPTY", "ERROR", "LOADING", "STALE", "SUCCESS"]);
	});

	test("the error text carries the trimmed failure message", () => {
		expect(deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: "  store unreachable  " }).text).toBe(
			"Error: the session view failed to load (store unreachable).",
		);
	});

	test("the degraded text names the disabled capabilities and agrees on the verb", () => {
		expect(deriveSessionState({ ...READY, disabledCapabilities: ["presence"] }).text).toBe("Degraded: presence is disabled, so this view is partial.");
		expect(deriveSessionState({ ...READY, disabledCapabilities: ["presence", " history "] }).text).toBe(
			"Degraded: presence, history are disabled, so this view is partial.",
		);
	});

	test("the stale text states the stale count out of the total", () => {
		expect(deriveSessionState({ ...READY, sessions: ["active", "stale", "stale"] }).text).toBe(
			"2 of 3 sessions are stale: no heartbeat within the freshness window.",
		);
	});

	test("the success text counts unclassified sessions instead of calling them active", () => {
		expect(deriveSessionState({ ...READY, sessions: ["active", "unknown"] }).text).toBe("1 session is active; 1 could not be classified.");
		expect(deriveSessionState({ ...READY, sessions: ["active"] }).text).toBe("1 session is active.");
	});
});
