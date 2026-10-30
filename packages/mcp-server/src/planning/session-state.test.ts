/**
 * The steering session registry (phase 58, criterion 2): the live sessions `docs_steering_session` holds, driven by an
 * acknowledged directive through the one state machine. In-memory fakes, an injected clock and an injected `emit`: no network.
 */
import { describe, expect, test } from "bun:test";
import type { SteeringSession, SteeringSessionState } from "../event.ts";
import type { EventInput } from "../types.ts";
import { SteeringSessionRegistry, steeringSessionEvent, STEERING_ACKNOWLEDGE_VIA } from "./session-state.ts";

const T0 = 1_800_000_000_000;

function session(sessionId: string, state: SteeringSessionState, extra: Partial<SteeringSession> = {}): SteeringSession {
	return { session_id: sessionId, repo_id: "owner/name", state, updated_at: new Date(T0).toISOString(), ...extra };
}

function registry(options: { cap?: number; failEmit?: boolean } = {}) {
	const events: EventInput[] = [];
	const reg = new SteeringSessionRegistry({
		emit: async (event) => {
			if (options.failEmit === true) throw new Error("ledger down");
			events.push(event);
			return { stored: true };
		},
		nowMs: () => T0 + 5_000,
		...(options.cap !== undefined ? { cap: options.cap } : {}),
	});
	return { reg, events };
}

describe("get, put and lookup", () => {
	test("a session is held under its surface and found by its id across surfaces", () => {
		const { reg } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		expect(reg.get("omp", "s-1")?.state).toBe("ACTIVE");
		expect(reg.get("cursor", "s-1")).toBeUndefined();
		expect(reg.lookup("s-1")).toMatchObject({ status: "one", surface: "omp", session: { state: "ACTIVE" } });
		expect(reg.lookup("s-2")).toEqual({ status: "none" });
	});

	test("two surfaces holding one id make it ambiguous, and a replace keeps one entry per surface", () => {
		const { reg } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		reg.put("omp", "s-1", session("s-1", "PAUSED"));
		expect(reg.size).toBe(1);
		expect(reg.lookup("s-1")).toMatchObject({ status: "one", session: { state: "PAUSED" } });
		reg.put("cursor", "s-1", session("s-1", "ACTIVE"));
		expect(reg.lookup("s-1")).toEqual({ status: "ambiguous" });
	});
});

describe("applyTransition", () => {
	test("a pause from ACTIVE applies, and records exactly one docs.steering note naming the directive", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE", { steering: "stay on the slice", planning_hash: "plan-a" }));

		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-1" })).toEqual({ ok: true, changed: true });

		expect(reg.get("omp", "s-1")).toMatchObject({ state: "PAUSED", steering: "stay on the slice", planning_hash: "plan-a", updated_at: new Date(T0 + 5_000).toISOString() });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ surface: "omp", kind: "warning", session_id: "s-1", repo: "owner/name" });
		expect(events[0]?.payload).toMatchObject({
			action: "docs.steering",
			repo_id: "owner/name",
			session_id: "s-1",
			state: "PAUSED",
			previous_state: "ACTIVE",
			directive_id: "dir-1",
			via: STEERING_ACKNOWLEDGE_VIA,
			non_blocking: true,
			steering: "stay on the slice",
			planning_hash: "plan-a",
		});
	});

	test("a pause from RESUMED applies", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "RESUMED"));
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-2" })).toEqual({ ok: true, changed: true });
		expect(reg.get("omp", "s-1")?.state).toBe("PAUSED");
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({ previous_state: "RESUMED", directive_id: "dir-2" });
	});

	test("a redirect moves ACTIVE to CONTEXT_REFRESH as a note, not a warning", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		expect(await reg.applyTransition("s-1", "CONTEXT_REFRESH", { directiveId: "dir-3" })).toEqual({ ok: true, changed: true });
		expect(reg.get("omp", "s-1")?.state).toBe("CONTEXT_REFRESH");
		expect(events[0]?.kind).toBe("note");
	});

	test("a redirect for a PAUSED session is refused by the state machine, changes nothing and records nothing", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "PAUSED"));
		expect(await reg.applyTransition("s-1", "CONTEXT_REFRESH", { directiveId: "dir-4" })).toEqual({ ok: false, reason: "steering transition PAUSED -> CONTEXT_REFRESH refused" });
		expect(reg.get("omp", "s-1")?.state).toBe("PAUSED");
		expect(events).toEqual([]);
	});

	test("a session the registry does not hold is refused, and nothing is seeded", async () => {
		const { reg, events } = registry();
		expect(await reg.applyTransition("ghost", "PAUSED", { directiveId: "dir-5" })).toEqual({ ok: false, reason: "session not registered" });
		expect(reg.size).toBe(0);
		expect(events).toEqual([]);
	});

	test("a session id two surfaces hold is refused as ambiguous, and neither session moves", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		reg.put("cursor", "s-1", session("s-1", "ACTIVE"));
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-6" })).toEqual({ ok: false, reason: "ambiguous" });
		expect(reg.get("omp", "s-1")?.state).toBe("ACTIVE");
		expect(reg.get("cursor", "s-1")?.state).toBe("ACTIVE");
		expect(events).toEqual([]);
	});

	test("a ledger that cannot take the note never undoes the transition", async () => {
		const { reg } = registry({ failEmit: true });
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-7" })).toEqual({ ok: true, changed: true });
		expect(reg.get("omp", "s-1")?.state).toBe("PAUSED");
	});

	test("a pause for an already PAUSED session and a redirect for an already CONTEXT_REFRESH session succeed unchanged: nothing stored, no note", async () => {
		const { reg, events } = registry();
		const paused = session("s-1", "PAUSED");
		const refreshing = session("s-2", "CONTEXT_REFRESH");
		reg.put("omp", "s-1", paused);
		reg.put("omp", "s-2", refreshing);
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-8" })).toEqual({ ok: true, changed: false });
		expect(await reg.applyTransition("s-2", "CONTEXT_REFRESH", { directiveId: "dir-9" })).toEqual({ ok: true, changed: false });
		expect(reg.get("omp", "s-1")).toBe(paused);
		expect(reg.get("omp", "s-2")).toBe(refreshing);
		expect(events).toEqual([]);
	});
});

describe("the cap", () => {
	test("past the cap the oldest session is forgotten, with its index entry", () => {
		const { reg } = registry({ cap: 2 });
		reg.put("omp", "a", session("a", "ACTIVE"));
		reg.put("omp", "b", session("b", "ACTIVE"));
		reg.put("omp", "c", session("c", "ACTIVE"));
		expect(reg.size).toBe(2);
		expect(reg.get("omp", "a")).toBeUndefined();
		expect(reg.lookup("a")).toEqual({ status: "none" });
		expect(reg.lookup("c")).toMatchObject({ status: "one" });
	});

	test("a write makes a session the newest, so the other one is the oldest", () => {
		const { reg } = registry({ cap: 2 });
		reg.put("omp", "a", session("a", "ACTIVE"));
		reg.put("omp", "b", session("b", "ACTIVE"));
		reg.put("omp", "a", session("a", "PAUSED"));
		reg.put("omp", "c", session("c", "ACTIVE"));
		expect(reg.get("omp", "b")).toBeUndefined();
		expect(reg.get("omp", "a")?.state).toBe("PAUSED");
		expect(reg.get("omp", "c")?.state).toBe("ACTIVE");
	});
});

describe("steeringSessionEvent", () => {
	test("without extra keys it is the note docs_steering_session has always recorded", () => {
		const event = steeringSessionEvent("omp", session("s-1", "ACTIVE"), undefined);
		expect(event).toMatchObject({ surface: "omp", kind: "note", summary: "docs steering none -> ACTIVE for owner/name", session_id: "s-1", repo: "owner/name" });
		expect(Object.hasOwn(event.payload ?? {}, "directive_id")).toBe(false);
		expect(Object.hasOwn(event.payload ?? {}, "via")).toBe(false);
	});
});

describe("end", () => {
	test("ending a session removes it from the registry and from every lookup", () => {
		const { reg } = registry();
		reg.put("claude-code", "s-1", session("s-1", "ACTIVE"));
		reg.put("claude-code", "s-2", session("s-2", "ACTIVE"));
		expect(reg.end("claude-code", "s-1")).toBe(true);
		expect(reg.get("claude-code", "s-1")).toBeUndefined();
		expect(reg.lookup("s-1")).toEqual({ status: "none" });
		expect(reg.entries().map((entry) => entry.session.session_id)).toEqual(["s-2"]);
		expect(reg.size).toBe(1);
	});

	test("a second end is a no-op, and a session of another surface with the same id is left alone", () => {
		const { reg } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		reg.put("cursor", "s-1", session("s-1", "ACTIVE"));
		expect(reg.end("omp", "s-1")).toBe(true);
		expect(reg.end("omp", "s-1")).toBe(false);
		expect(reg.get("cursor", "s-1")?.state).toBe("ACTIVE");
		expect(reg.lookup("s-1")).toMatchObject({ status: "one", surface: "cursor" });
	});

	test("an ended session cannot be moved: the transition is refused as not registered and records no note", async () => {
		const { reg, events } = registry();
		reg.put("omp", "s-1", session("s-1", "ACTIVE"));
		reg.end("omp", "s-1");
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-1" })).toEqual({ ok: false, reason: "session not registered" });
		expect(events).toHaveLength(0);
	});
});
