/**
 * The per-node artifact (phase 38, B-D3): one node's claim, Linear, Notion and DoD steps, grouped from the events the
 * mirror and the DoD gate recorded with that node's id. Nothing is inferred: a step appears only if an event says so.
 */
import { describe, expect, test } from "bun:test";
import { type ArtifactEvent, nodeArtifact } from "./node-artifact.ts";

function mirrorEvent(node: string, ts: string, target: "linear" | "notion", op: string, status?: "ok", reason?: string): ArtifactEvent {
	return {
		node_id: node,
		ts,
		payload: { action: "mirror", target, op, ...(status ? { status } : {}), ...(reason ? { reason } : {}) },
	};
}

function dodEvent(node: string, ts: string, fields: Record<string, unknown>): ArtifactEvent {
	return { node_id: node, ts, payload: { action: "dod", ...fields } };
}

describe("the per-node artifact", () => {
	test("groups one node's claim, Linear, Notion and DoD steps in chain order", () => {
		const events: ArtifactEvent[] = [
			mirrorEvent("n1", "t1", "linear", "claim", "ok"),
			mirrorEvent("n1", "t2", "notion", "claim", "ok"),
			mirrorEvent("n1", "t3", "linear", "review", "ok"),
			mirrorEvent("n1", "t4", "notion", "review", "ok"),
			dodEvent("n1", "t5", { status: "approved", already_done: false }),
			mirrorEvent("n1", "t6", "linear", "done", "ok"),
		];
		const artifact = nodeArtifact(events, "n1");
		expect(artifact.claim.map((step) => step.op)).toEqual(["claim", "review", "done"]);
		expect(artifact.linear.map((step) => [step.op, step.status])).toEqual([
			["claim", "ok"],
			["review", "ok"],
			["done", "ok"],
		]);
		expect(artifact.notion.map((step) => [step.op, step.status])).toEqual([
			["claim", "ok"],
			["review", "ok"],
		]);
		expect(artifact.dod).toEqual([{ ts: "t5", status: "approved", reason: null }]);
	});

	test("a repeat of the same lease op is one claim step, and a node's events never reach another node's artifact", () => {
		const events: ArtifactEvent[] = [
			mirrorEvent("n1", "t1", "linear", "release", "ok"),
			mirrorEvent("n1", "t2", "notion", "release", "ok"),
			mirrorEvent("n2", "t3", "linear", "claim", "ok"),
			{ node_id: null, ts: "t4", payload: { action: "mirror", target: "linear", op: "claim", status: "ok" } },
		];
		const artifact = nodeArtifact(events, "n1");
		expect(artifact.claim.map((step) => step.op)).toEqual(["release"]);
		expect(artifact.linear).toHaveLength(1);
		expect(artifact.notion).toHaveLength(1);
	});

	test("a failed target keeps its reason, and a target that wrote cleanly reads ok", () => {
		const events: ArtifactEvent[] = [
			mirrorEvent("n1", "t1", "linear", "claim", undefined, "timeout"),
			mirrorEvent("n1", "t2", "notion", "claim", "ok"),
		];
		const artifact = nodeArtifact(events, "n1");
		expect(artifact.linear).toEqual([{ ts: "t1", op: "claim", status: "failed", reason: "timeout" }]);
		expect(artifact.notion).toEqual([{ ts: "t2", op: "claim", status: "ok", reason: null }]);
	});

	test("a DoD refusal reads refused, and a warning the gate raised along the way is not called a refusal", () => {
		const events: ArtifactEvent[] = [
			dodEvent("n1", "t1", { reason: "dod-refused" }),
			dodEvent("n1", "t2", { reason: "linear-changed" }),
		];
		const artifact = nodeArtifact(events, "n1");
		expect(artifact.dod).toEqual([
			{ ts: "t1", status: "refused", reason: "dod-refused" },
			{ ts: "t2", status: "warning", reason: "linear-changed" },
		]);
	});
});
