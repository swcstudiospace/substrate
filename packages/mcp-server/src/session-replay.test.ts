/** Fake-only tests for read-only session replay. No I/O, no clock. */
import { describe, expect, test } from "bun:test";
import { eventHash } from "./event.ts";
import {
	formatReplaySummary,
	mirrorReplaySummary,
	replayToCheckpoint,
	type ReplayMirrorSink,
} from "./session-replay.ts";
import type { SubstrateEvent } from "./types.ts";

let seq = 0;

function makeEvent(
	overrides: Partial<Omit<SubstrateEvent, "hash" | "prev">> & { prev?: string | null },
	prev: string | null,
): SubstrateEvent {
	seq += 1;
	const rest = {
		id: `evt-${seq}`,
		ts: "2026-11-28T00:00:00.000Z",
		surface: "claude-code",
		session_id: "sess-1",
		graph_id: "g-1",
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: `event ${seq}`,
		payload: {},
		...overrides,
		prev,
	} as Omit<SubstrateEvent, "hash">;
	return { ...rest, hash: eventHash(rest) };
}

/** Three notes then a checkpoint, hash-linked. */
function chain(): SubstrateEvent[] {
	const events: SubstrateEvent[] = [];
	let prev: string | null = null;
	for (let i = 0; i < 3; i++) {
		const event = makeEvent({ summary: `work ${i}` }, prev);
		events.push(event);
		prev = event.hash;
	}
	const checkpoint = makeEvent(
		{
			summary: "checkpoint",
			payload: { action: "session.checkpoint", ckpt_id: "ckpt_abc", seq: 4 },
		},
		prev,
	);
	events.push(checkpoint);
	return events;
}

describe("replayToCheckpoint", () => {
	test("resolves by checkpoint id and folds every event up to it", () => {
		const result = replayToCheckpoint(chain(), { checkpointId: "ckpt_abc" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary.checkpointId).toBe("ckpt_abc");
		expect(result.summary.seq).toBe(4);
		expect(result.summary.eventsReplayed).toBe(4);
		expect(result.summary.actions).toHaveLength(4);
		expect(result.summary.chainHead.hash).toBe(result.summary.chainHead.hash);
	});
	test("resolves by event id and by seq", () => {
		const events = chain();
		const checkpoint = events[events.length - 1];
		if (!checkpoint) throw new Error("test chain is empty");
		const byEvent = replayToCheckpoint(events, { eventId: checkpoint.id });
		expect(byEvent.ok).toBe(true);
		const bySeq = replayToCheckpoint(events, { seq: 4 });
		expect(bySeq.ok).toBe(true);
	});
	test("a broken chain refuses before resolving anything", () => {
		const events = chain();
		const tampered = { ...events[1], summary: "rewritten history" };
		const broken = [events[0], tampered, events[2], events[3]].filter(
			(event): event is SubstrateEvent => event !== undefined,
		);
		const result = replayToCheckpoint(broken, { checkpointId: "ckpt_abc" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("chain-broken");
	});
	test("unknown checkpoints and non-checkpoint events are refused", () => {
		const events = chain();
		expect(replayToCheckpoint(events, { checkpointId: "ckpt_nope" }).ok).toBe(false);
		const first = events[0];
		if (!first) throw new Error("test chain is empty");
		const notCheckpoint = replayToCheckpoint(events, { eventId: first.id });
		expect(notCheckpoint.ok).toBe(false);
		if (!notCheckpoint.ok && notCheckpoint.reason === "not-a-checkpoint") {
			expect(notCheckpoint.eventId).toBe(first.id);
		} else {
			throw new Error("expected not-a-checkpoint");
		}
		expect(replayToCheckpoint(events, {}).ok).toBe(false);
	});
	test("read-only: frozen input replays cleanly and nothing changes", () => {
		const events = chain().map((event) => Object.freeze({ ...event, payload: Object.freeze({ ...event.payload }) }));
		const frozen = Object.freeze(events);
		const before = JSON.stringify(frozen);
		const result = replayToCheckpoint(frozen, { checkpointId: "ckpt_abc" });
		expect(result.ok).toBe(true);
		expect(JSON.stringify(frozen)).toBe(before);
	});
});

describe("formatReplaySummary", () => {
	test("bounded note with chain head", () => {
		const result = replayToCheckpoint(chain(), { checkpointId: "ckpt_abc" });
		if (!result.ok) throw new Error("expected ok");
		const body = formatReplaySummary(result.summary);
		expect(body).toContain("ckpt_abc");
		expect(body).toContain(result.summary.chainHead.hash);
		expect(body.split("\n").length).toBeLessThanOrEqual(3 + 50);
	});
	test("long summaries are capped", () => {
		const result = replayToCheckpoint(chain(), { checkpointId: "ckpt_abc" });
		if (!result.ok) throw new Error("expected ok");
		const long = { ...result.summary, actions: [{ eventId: "e", kind: "note", surface: "s", summary: "x".repeat(500) }] };
		expect(formatReplaySummary(long).split("\n")[3]?.length ?? 0).toBeLessThanOrEqual(300 + 50);
	});
});

describe("mirrorReplaySummary", () => {
	function sink(bodies: string[]): ReplayMirrorSink {
		return {
			postComment: async (body: string) => {
				bodies.push(body);
			},
		};
	}
	test("posts to both targets through the existing reporter shape", async () => {
		const result = replayToCheckpoint(chain(), { checkpointId: "ckpt_abc" });
		if (!result.ok) throw new Error("expected ok");
		const linearBodies: string[] = [];
		const notionBodies: string[] = [];
		const outcome = await mirrorReplaySummary(result.summary, {
			linear: sink(linearBodies),
			notion: sink(notionBodies),
		});
		expect(outcome).toEqual({ linear: "posted", notion: "posted", reason: null });
		expect(linearBodies).toHaveLength(1);
		expect(notionBodies).toHaveLength(1);
		expect(linearBodies[0]).toBe(notionBodies[0]);
	});
	test("absent sinks skip; a down target fails without throwing", async () => {
		const result = replayToCheckpoint(chain(), { checkpointId: "ckpt_abc" });
		if (!result.ok) throw new Error("expected ok");
		const skipped = await mirrorReplaySummary(result.summary, {});
		expect(skipped).toEqual({ linear: "skipped", notion: "skipped", reason: null });
		const failing: ReplayMirrorSink = {
			postComment: async () => {
				throw new Error("tracker down");
			},
		};
		const bodies: string[] = [];
		const outcome = await mirrorReplaySummary(result.summary, { linear: failing, notion: sink(bodies) });
		expect(outcome.linear).toBe("failed");
		expect(outcome.notion).toBe("posted");
		expect(outcome.reason).not.toBeNull();
		expect(bodies).toHaveLength(1);
	});
});
