import { describe, expect, test } from "bun:test";
import { mapHerdrEvent, type HerdrEvent, type HerdrPane } from "./herdr-map.ts";

const pane: HerdrPane = {
	pane_id: "w1:p1",
	agent_status: "unknown",
	cwd: "/root/src/repos/agent-substrate",
	foreground_cwd: "/root/src/repos/agent-substrate",
	terminal_title: "root@vps: ~/src/repos",
	revision: 1,
};

describe("mapHerdrEvent — per event type", () => {
	test("Test 1: pane.agent_detected maps to agent.detected with surface herdr and pane_id in the payload", () => {
		const event: HerdrEvent = { type: "pane.agent_detected", pane_id: "w1:p1" };
		const out = mapHerdrEvent(event, pane);
		expect(out?.surface).toBe("herdr");
		expect(out?.kind).toBe("agent.detected");
		expect(out?.payload?.pane_id).toBe("w1:p1");
	});

	test("Test 2: pane.agent_status_changed maps to agent.status carrying the new status", () => {
		const event: HerdrEvent = { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "working" };
		const out = mapHerdrEvent(event, pane);
		expect(out?.kind).toBe("agent.status");
		expect(out?.payload?.status).toBe("working");
	});

	test("Test 3: pane.exited maps to agent.exited", () => {
		const event: HerdrEvent = { type: "pane.exited", pane_id: "w1:p1" };
		const out = mapHerdrEvent(event, pane);
		expect(out?.kind).toBe("agent.exited");
	});

	test("Test 4: pane.output_matched maps to note with matched text redacted before it becomes the summary", () => {
		// `matched_line` is the real wire field name (herdr api schema, 0.9.1's
		// SubscriptionEventData.PaneOutputMatchedEvent), confirmed live against
		// the running socket.
		const event: HerdrEvent = {
			type: "pane.output_matched",
			pane_id: "w1:p1",
			matched_line: "auth token tskey-abc123def456",
		};
		const out = mapHerdrEvent(event, pane);
		expect(out?.kind).toBe("note");
		expect(out?.summary).not.toContain("tskey-abc123def456");
		expect(out?.summary).toContain("[REDACTED_TSKEY]");
		expect(out?.payload?.matched).not.toContain("tskey-abc123def456");
	});

	test("Test 5: an unrecognised event type maps to a note rather than null", () => {
		const out = mapHerdrEvent({ type: "pane.some_future_event", pane_id: "w1:p1" }, pane);
		expect(out).not.toBeNull();
		expect(out?.kind).toBe("note");
		expect(out?.summary).toContain("pane.some_future_event");
	});

	test("Test 6: repo comes from the pane's cwd; a pane with no cwd yields repo undefined, never throws", () => {
		const withCwd = mapHerdrEvent({ type: "pane.exited", pane_id: "w1:p1" }, pane);
		expect(withCwd?.repo).toBe("/root/src/repos/agent-substrate");

		const noCwdPane: HerdrPane = { pane_id: "w2:p1" };
		expect(() => mapHerdrEvent({ type: "pane.exited", pane_id: "w2:p1" }, noCwdPane)).not.toThrow();
		const noCwd = mapHerdrEvent({ type: "pane.exited", pane_id: "w2:p1" }, noCwdPane);
		expect(noCwd?.repo).toBeUndefined();

		expect(() => mapHerdrEvent({ type: "pane.exited", pane_id: "w3:p1" }, undefined)).not.toThrow();
		const noPane = mapHerdrEvent({ type: "pane.exited", pane_id: "w3:p1" }, undefined);
		expect(noPane?.repo).toBeUndefined();
	});

	test("an event with no type at all is dropped", () => {
		expect(mapHerdrEvent({}, pane)).toBeNull();
	});
});
