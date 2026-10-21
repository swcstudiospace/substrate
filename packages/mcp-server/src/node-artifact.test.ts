/**
 * The per-node artifact (phase 38, B-D3): one node's claim, Linear, Notion and DoD steps, grouped from the events the
 * ledger recorded with that node's id. Nothing is inferred: a step appears only if an event says so.
 */
import { describe, expect, test } from "bun:test";
import { type ArtifactEvent, nodeArtifact } from "./node-artifact.ts";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, 0, ms)).toISOString();

/** A lease decision the ledger recorded for a node (claim, release, or expiry). */
function lease(node: string | null, ms: number, action: string): ArtifactEvent {
	return { node_id: node, ts: at(ms), payload: { action, lease_epoch: 1 } };
}

/** A mirror outcome. Without a status it is a failure, as a `mirror.failed` warning is. */
function mirrorEvent(
	node: string,
	ms: number,
	target: "linear" | "notion",
	op: string,
	status?: "ok",
	reason?: string,
	relation?: { blocker: string; kind: string },
): ArtifactEvent {
	return {
		node_id: node,
		ts: at(ms),
		payload: {
			action: "mirror",
			target,
			op,
			...(status ? { status } : {}),
			...(reason ? { reason } : {}),
			...(relation ? { blocker_node: relation.blocker, edge_kind: relation.kind } : {}),
		},
	};
}

function dodEvent(node: string, ms: number, fields: Record<string, unknown>): ArtifactEvent {
	return { node_id: node, ts: at(ms), payload: { action: "dod", ...fields } };
}

describe("the per-node artifact", () => {
	test("groups one node's lease decisions, Linear, Notion and DoD steps in time order", () => {
		const events: ArtifactEvent[] = [
			lease("n1", 1, "granted"),
			mirrorEvent("n1", 2, "linear", "claim", "ok"),
			mirrorEvent("n1", 3, "notion", "claim", "ok"),
			dodEvent("n1", 5, { status: "approved", already_done: false }),
			mirrorEvent("n1", 6, "linear", "done", "ok"),
			lease("n1", 7, "released"),
		];

		const artifact = nodeArtifact(events, "n1");

		expect(artifact.claim).toEqual([
			{ ts: at(1), action: "granted" },
			{ ts: at(7), action: "released" },
		]);
		expect(artifact.linear).toEqual([
			{ ts: at(2), op: "claim", status: "ok", reason: null, blocker_node: null, edge_kind: null },
			{ ts: at(6), op: "done", status: "ok", reason: null, blocker_node: null, edge_kind: null },
		]);
		expect(artifact.notion).toEqual([{ ts: at(3), op: "claim", status: "ok", reason: null }]);
		expect(artifact.dod).toEqual([{ ts: at(5), status: "approved", reason: null }]);
	});

	test("a node's lease decisions are its claim steps even when no tracker is bound", () => {
		const events: ArtifactEvent[] = [lease("n1", 1, "granted"), lease("n1", 2, "denied"), lease("n1", 3, "released")];

		const artifact = nodeArtifact(events, "n1");

		expect(artifact.claim.map((step) => step.action)).toEqual(["granted", "denied", "released"]);
		expect(artifact.linear).toEqual([]);
		expect(artifact.notion).toEqual([]);
	});

	test("a relation outcome keeps its blocker and edge kind on the Linear step, and a failed one keeps its reason", () => {
		const events: ArtifactEvent[] = [
			mirrorEvent("n2", 1, "linear", "relate", "ok", undefined, { blocker: "n1", kind: "blocks" }),
			mirrorEvent("n2", 2, "linear", "relate", undefined, "timeout", { blocker: "n3", kind: "requires" }),
		];

		const artifact = nodeArtifact(events, "n2");

		expect(artifact.linear).toEqual([
			{ ts: at(1), op: "relate", status: "ok", reason: null, blocker_node: "n1", edge_kind: "blocks" },
			{ ts: at(2), op: "relate", status: "failed", reason: "timeout", blocker_node: "n3", edge_kind: "requires" },
		]);
	});

	test("another node's events, and events with no node, never reach the artifact", () => {
		const events: ArtifactEvent[] = [
			lease("n2", 1, "granted"),
			mirrorEvent("n2", 2, "linear", "claim", "ok"),
			lease(null, 3, "granted"),
			{ node_id: null, ts: at(4), payload: { action: "mirror", target: "linear", op: "claim", status: "ok" } },
		];

		const artifact = nodeArtifact(events, "n1");

		expect(artifact).toEqual({ node_id: "n1", claim: [], linear: [], notion: [], dod: [] });
	});

	test("a failed target keeps its reason, and a target that wrote cleanly reads ok", () => {
		const events: ArtifactEvent[] = [
			mirrorEvent("n1", 1, "linear", "claim", undefined, "timeout"),
			mirrorEvent("n1", 2, "notion", "claim", "ok"),
		];

		const artifact = nodeArtifact(events, "n1");

		expect(artifact.linear).toEqual([
			{ ts: at(1), op: "claim", status: "failed", reason: "timeout", blocker_node: null, edge_kind: null },
		]);
		expect(artifact.notion).toEqual([{ ts: at(2), op: "claim", status: "ok", reason: null }]);
	});

	test("a DoD refusal reads refused, and any other gate warning reads warning", () => {
		const events: ArtifactEvent[] = [
			dodEvent("n1", 1, { reason: "dod-refused" }),
			dodEvent("n1", 2, { reason: "linear-changed" }),
		];

		expect(nodeArtifact(events, "n1").dod).toEqual([
			{ ts: at(1), status: "refused", reason: "dod-refused" },
			{ ts: at(2), status: "warning", reason: "linear-changed" },
		]);
	});

	test("events in one millisecond follow the chain that links them, whatever order the ledger returned them in", () => {
		const review = { ...mirrorEvent("n1", 5, "linear", "review", "ok"), hash: "h2", prev: "h1" };
		const claim = { ...mirrorEvent("n1", 5, "linear", "claim", "ok"), hash: "h1", prev: null };

		expect(nodeArtifact([review, claim], "n1").linear.map((step) => step.op)).toEqual(["claim", "review"]);
	});

	test("events in one millisecond that the chain does not link keep the order they were given", () => {
		const review = mirrorEvent("n1", 5, "linear", "review", "ok");
		const claim = mirrorEvent("n1", 5, "linear", "claim", "ok");

		expect(nodeArtifact([review, claim], "n1").linear.map((step) => step.op)).toEqual(["review", "claim"]);
	});
});
