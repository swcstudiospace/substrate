import { describe, expect, spyOn, test } from "bun:test";
import type { SteeringSessionState } from "../event.ts";
import type { EventInput } from "../types.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import { LiveSessionStatePort, steeringSessionEvent, STEERING_ACKNOWLEDGE_VIA } from "./session-state.ts";

const OWNER = { surface: "cursor", isOperator: false } as const;
const OPERATOR = { surface: "omp", isOperator: true } as const;

async function fixture(state: SteeringSessionState = "ACTIVE", failEmit = false) {
	const authority = createTestLiveSessionAuthority();
	const row = await issueLiveSession(authority, { caller: OWNER, state, steering: "PRIVATE-DIRECTION", planningHash: "PRIVATE-PLAN" });
	const events: EventInput[] = [];
	const port = new LiveSessionStatePort({ authority, emit: async event => {
		if (failEmit) throw new Error("test ledger unavailable");
		events.push(event);
	} });
	const context = { caller: OPERATOR, sessionId: row.sessionId, directiveId: "directive-1", operation: "operator-ack" as const };
	return { authority, row, events, port, context };
}

describe("authority-backed acknowledgement transitions", () => {
	for (const [initial, target] of [["ACTIVE", "PAUSED"], ["RESUMED", "PAUSED"], ["ACTIVE", "CONTEXT_REFRESH"]] as const) {
		test(`${initial} to ${target} commits canonical state and emits only public metadata`, async () => {
			const h = await fixture(initial);
			expect(await h.port.applyTransition(h.row.sessionId, target, h.context)).toEqual({ ok: true, changed: true });
			const checked = await h.authority.read(h.row.access, "private-read");
			expect(checked).toMatchObject({ ok: true, snapshot: { session: { state: target, steering: "PRIVATE-DIRECTION", planning_hash: "PRIVATE-PLAN" } } });
			expect(h.events).toHaveLength(1);
			expect(h.events[0]).toMatchObject({ surface: "cursor", kind: target === "PAUSED" ? "warning" : "note", session_id: h.row.sessionId, repo: "owner/name" });
			expect(h.events[0]?.payload).toEqual({ action: "docs.steering", session_id: h.row.sessionId, repo_id: "owner/name", state: target, updated_at: h.row.snapshot.session.updated_at, previous_state: initial, directive_id: "directive-1", via: STEERING_ACKNOWLEDGE_VIA, non_blocking: true });
			expect(JSON.stringify(h.events)).not.toContain("PRIVATE-");
			expect(JSON.stringify(h.events)).not.toContain(h.row.sessionBinding);
		});
	}

	test("an invalid transition leaves state and event history unchanged", async () => {
		const h = await fixture("PAUSED");
		expect(await h.port.applyTransition(h.row.sessionId, "CONTEXT_REFRESH", h.context)).toEqual({ ok: false, reason: "invalid-transition" });
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "PAUSED" } } });
		expect(h.events).toEqual([]);
	});

	for (const state of ["PAUSED", "CONTEXT_REFRESH"] as const) test(`repeated ${state} is unchanged with no fabricated note`, async () => {
		const h = await fixture(state);
		expect(await h.port.applyTransition(h.row.sessionId, state, h.context)).toEqual({ ok: true, changed: false });
		expect(h.events).toEqual([]);
	});

	test("a failed note cannot undo committed state", async () => {
		const h = await fixture("ACTIVE", true);
		expect(await h.port.applyTransition(h.row.sessionId, "PAUSED", h.context)).toEqual({ ok: true, changed: true });
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "PAUSED" } } });
	});

	for (const failure of ["close", "outage"] as const) test(`committed state transition is not reported refused when ${failure} wins during its event append`, async () => {
		const h = await fixture();
		const transition = spyOn(h.authority, "transition");
		const port = new LiveSessionStatePort({ authority: h.authority, emit: async event => {
			h.events.push(event);
			if (failure === "close") await h.authority.close(h.row.access);
			else h.authority.unavailable = true;
		} });
		expect(await port.applyTransition(h.row.sessionId, "PAUSED", h.context)).toEqual({ ok: true, changed: true });
		expect(transition).toHaveBeenCalledTimes(1);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.payload).toMatchObject({ state: "PAUSED", previous_state: "ACTIVE" });
		expect(await h.authority.read(h.row.access, "private-read")).toEqual({ ok: false, error: { code: failure === "close" ? "not-found" : "session-unavailable" } });
	});

	test("session key mismatch and untrusted nonoperator context cannot move either identity", async () => {
		const h = await fixture();
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		expect(await h.port.applyTransition(sibling.sessionId, "PAUSED", h.context)).toEqual({ ok: false, reason: "not-found" });
		expect(await h.port.applyTransition(h.row.sessionId, "PAUSED", { ...h.context, caller: OWNER, sessionBinding: sibling.sessionBinding })).toEqual({ ok: false, reason: "not-found" });
		for (const row of [h.row, sibling]) expect(await h.authority.read(row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "ACTIVE" } } });
		expect(h.events).toEqual([]);
	});

	for (const terminal of ["closed", "expired", "unknown"] as const) test(`${terminal} is not found even for operator acknowledgement`, async () => {
		const h = await fixture();
		if (terminal === "closed") await h.authority.close(h.row.access);
		if (terminal === "expired") h.authority.advance(3600_000);
		const sessionId = terminal === "unknown" ? `ls_${"f".repeat(64)}` : h.row.sessionId;
		expect(await h.port.applyTransition(sessionId, "PAUSED", { ...h.context, sessionId })).toEqual({ ok: false, reason: "not-found" });
		expect(h.events).toEqual([]);
	});

	test("missing or failed authority is not a successful transition", async () => {
		const h = await fixture();
		h.authority.unavailable = true;
		expect(await h.port.applyTransition(h.row.sessionId, "PAUSED", h.context)).toEqual({ ok: false, reason: "session-unavailable" });
		const missing = new LiveSessionStatePort({ authority: null, emit: async event => { h.events.push(event); } });
		expect(await missing.applyTransition(h.row.sessionId, "PAUSED", h.context)).toEqual({ ok: false, reason: "session-unavailable" });
		expect(h.events).toEqual([]);
	});
});

test("public transition producer never spreads arbitrary private extras", async () => {
	const h = await fixture();
	const event = steeringSessionEvent("cursor", h.row.snapshot.session, undefined, { steering: "EXTRA-PRIVATE", session_binding: h.row.sessionBinding, nested: { secret: "NESTED-PRIVATE" }, directive_id: "public-directive", via: "untrusted-via" });
	expect(event.payload).toEqual({ action: "docs.steering", session_id: h.row.sessionId, repo_id: "owner/name", state: "ACTIVE", updated_at: h.row.snapshot.session.updated_at, non_blocking: true, directive_id: "public-directive" });
	expect(JSON.stringify(event)).not.toContain("PRIVATE");
	expect(JSON.stringify(event)).not.toContain(h.row.sessionBinding);
});
