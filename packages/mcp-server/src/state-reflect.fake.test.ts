/**
 * Phase 100 (F1) fake tests: the STATE reflection event builder.
 * Pure module — no server, no I/O, no live LightRAG.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildStateReflectEvent, isStateReflectPath, STATE_REFLECT_BODY_MAX, summaryPhaseOf } from "./state-reflect.ts";

const LINEAGE = { graph_id: "checkout-a", phase: "100", commit: "abc123" };
const STATE_PATH = ".planning/STATE.md";
const SUMMARY_PATH = ".planning/phases/100-f1-live-state-reflection/100-SUMMARY.md";

describe("isStateReflectPath", () => {
	test("fires on STATE.md writes", () => {
		expect(isStateReflectPath(".planning/STATE.md")).toBe(true);
		expect(isStateReflectPath("other/.planning/STATE.md")).toBe(true);
	});

	test("fires on phase SUMMARY transitions only", () => {
		expect(isStateReflectPath(SUMMARY_PATH)).toBe(true);
		expect(isStateReflectPath(".planning/phases/100-x/NOTES.md")).toBe(false);
		expect(isStateReflectPath(".planning/phases/100-x/SUMMARY.md")).toBe(false);
		expect(isStateReflectPath(".planning/PLAN.md")).toBe(false);
	});

	test("rejects non-paths without throwing", () => {
		expect(isStateReflectPath(null)).toBe(false);
		expect(isStateReflectPath(undefined)).toBe(false);
		expect(isStateReflectPath("")).toBe(false);
		expect(isStateReflectPath(42)).toBe(false);
	});
});

describe("summaryPhaseOf", () => {
	test("reads the phase number from a SUMMARY path", () => {
		expect(summaryPhaseOf(SUMMARY_PATH)).toBe("100");
		expect(summaryPhaseOf(".planning/STATE.md")).toBeNull();
	});
});

describe("buildStateReflectEvent", () => {
	test("emits one event carrying lineage and a redacted body", () => {
		const body = "STATE is fresh.\nlogin: https://deploy:OLD-should-redact@example.com/hook\n";
		const outcome = buildStateReflectEvent({ path: STATE_PATH, body, lineage: LINEAGE });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.event.action).toBe("state.reflect");
		expect(outcome.event.path).toBe(STATE_PATH);
		expect(outcome.event.lineage).toEqual(LINEAGE);
		expect(outcome.event.body).not.toContain("OLD-should-redact");
		expect(outcome.event.content_sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
		expect(outcome.event.body_truncated).toBe(false);
	});

	test("caps an oversized body and marks the truncation", () => {
		const body = `x: ${"a".repeat(STATE_REFLECT_BODY_MAX + 100)}`;
		const outcome = buildStateReflectEvent({ path: STATE_PATH, body, lineage: LINEAGE });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.event.body_truncated).toBe(true);
		expect(outcome.event.body.length).toBeLessThan(body.length);
	});

	test("refuses a non-STATE path, missing lineage and an empty body without throwing", () => {
		expect(buildStateReflectEvent({ path: ".planning/PLAN.md", body: "x", lineage: LINEAGE }).ok).toBe(false);
		const badLineage = buildStateReflectEvent({ path: STATE_PATH, body: "x", lineage: { graph_id: "", phase: "100" } });
		expect(badLineage.ok).toBe(false);
		if (!badLineage.ok) expect(badLineage.code).toBe("state-reflect.bad-lineage");
		expect(buildStateReflectEvent({ path: STATE_PATH, body: "   ", lineage: LINEAGE }).ok).toBe(false);
		expect(buildStateReflectEvent({ path: STATE_PATH, body: null, lineage: null }).ok).toBe(false);
	});

	test("a hook throw never fails the write: garbage inputs are structured refusals", () => {
		const outcome = buildStateReflectEvent({ path: { nested: true }, body: 42, lineage: ["x"] });
		expect(outcome.ok).toBe(false);
	});
});
