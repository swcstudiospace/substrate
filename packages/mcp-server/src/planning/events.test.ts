/**
 * Planning-change events: the existing vocabulary, paths and never file text, redacted, capped,
 * published only as a hint over the injected bus.
 */
import { describe, expect, test } from "bun:test";
import type { EventHint } from "../event-bus.ts";
import { EVENT_KINDS } from "../types.ts";
import { diffPlanningIndex, type PlanningDiff } from "./diff.ts";
import { MAX_EVENT_PATHS, PLANNING_CHANGED, busPublisher, emitPlanningChange, planningChangeEvent, type PlanningPublisher } from "./events.ts";
import { buildPlanningIndex } from "./index.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const REPO = "swcstudiospace/agent-substrate";
const SESSION = "sess-p52-events";
const BODY_MARKER = "BODY-MARKER-never-in-an-event";
const DIFF: PlanningDiff = { complete: true, added: [".planning/phases/52-x/PLAN.md"], removed: [], changed: [".planning/STATE.md"] };

function recordingPublisher(result = true): PlanningPublisher & { events: unknown[] } {
	const events: unknown[] = [];
	return {
		events,
		async publish(event) {
			events.push(event);
			return result;
		},
	};
}

describe("planningChangeEvent", () => {
	test("uses an existing kind on the substrate surface and the planning payload shape", () => {
		const event = planningChangeEvent({ repo: REPO, sessionId: SESSION, diff: DIFF });
		expect(event).not.toBeNull();
		const kinds: readonly string[] = EVENT_KINDS;
		expect(kinds).toContain(event?.kind ?? "");
		expect(event).toMatchObject({ surface: "substrate", kind: "note", repo: REPO, session_id: SESSION });
		expect(event?.payload).toEqual({
			kind: PLANNING_CHANGED,
			repo: REPO,
			sessionId: SESSION,
			added: [".planning/phases/52-x/PLAN.md"],
			removed: [],
			changed: [".planning/STATE.md"],
		});
		expect(PLANNING_CHANGED).toBe("planning.changed");
	});

	test("an unchanged diff produces no event", () => {
		expect(planningChangeEvent({ repo: REPO, sessionId: SESSION, diff: { complete: true, added: [], removed: [], changed: [] } })).toBeNull();
	});

	test("a malformed repo or session id is a TypeError, not an event", () => {
		expect(() => planningChangeEvent({ repo: "not-a-repo", sessionId: SESSION, diff: DIFF })).toThrow(TypeError);
		expect(() => planningChangeEvent({ repo: REPO, sessionId: "bad id", diff: DIFF })).toThrow(TypeError);
	});

	test("no file text reaches the event: a diff built from documents with a body marker carries only paths", async () => {
		const files = {
			[`${TREE_ROOT}/.planning/STATE.md`]: `# State\n${BODY_MARKER}\n`,
			[`${TREE_ROOT}/.planning/ROADMAP.md`]: "# Roadmap\n",
		};
		const before = await buildPlanningIndex(TREE_ROOT, { fs: new FakeTree(files), limits: { maxFiles: 500, maxBytes: 262_144 } });
		const after = await buildPlanningIndex(TREE_ROOT, {
			fs: new FakeTree({ ...files, [`${TREE_ROOT}/.planning/STATE.md`]: `# State\n${BODY_MARKER} changed\n` }),
			limits: { maxFiles: 500, maxBytes: 262_144 },
		});
		if (!before.ok || !after.ok) throw new Error("index failed");
		const diff = diffPlanningIndex(
			{ records: before.index.records, truncated: before.index.truncated },
			{ records: after.index.records, truncated: after.index.truncated },
		);
		expect(diff.changed).toEqual([".planning/STATE.md"]);

		const event = planningChangeEvent({ repo: REPO, sessionId: SESSION, diff });
		expect(JSON.stringify(event)).not.toContain(BODY_MARKER);
	});

	test("a secret-shaped path is redacted in the payload and the summary", () => {
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const event = planningChangeEvent({
			repo: REPO,
			sessionId: SESSION,
			diff: { added: [`.planning/phases/52-x/${token}.md`], removed: [], changed: [] },
		});
		expect(JSON.stringify(event)).not.toContain(token);
		expect(event?.summary).not.toContain(token);
		expect(JSON.stringify(event?.payload)).toContain("[REDACTED]");
	});

	test("a list longer than the cap is cut to the cap, and the summary says so with the full count", () => {
		const added = Array.from({ length: MAX_EVENT_PATHS + 50 }, (_, index) => `.planning/phases/52-x/doc-${index}.md`);
		const event = planningChangeEvent({ repo: REPO, sessionId: SESSION, diff: { complete: true, added, removed: [], changed: [] } });
		const payload = event?.payload as { added: string[] } | undefined;
		expect(payload?.added).toHaveLength(MAX_EVENT_PATHS);
		expect(event?.summary).toContain(`${MAX_EVENT_PATHS + 50} added`);
		expect(event?.summary).toContain(`lists capped at ${MAX_EVENT_PATHS}`);
	});
});

describe("emitPlanningChange and the bus publisher", () => {
	test("an unchanged diff is 'unchanged' and never reaches the publisher", async () => {
		const publisher = recordingPublisher();
		expect(await emitPlanningChange(publisher, { repo: REPO, sessionId: SESSION, diff: { complete: true, added: [], removed: [], changed: [] } })).toBe(
			"unchanged",
		);
		expect(publisher.events).toEqual([]);
	});

	test("a partial diff is 'incomplete': nothing is published, and the event builder refuses it", async () => {
		const publisher = recordingPublisher(true);
		const partialDiff: PlanningDiff = { complete: false, added: [], removed: null, changed: [".planning/STATE.md"] };
		expect(await emitPlanningChange(publisher, { repo: REPO, sessionId: SESSION, diff: partialDiff })).toBe("incomplete");
		expect(publisher.events).toEqual([]);
		expect(() => planningChangeEvent({ repo: REPO, sessionId: SESSION, diff: partialDiff })).toThrow(TypeError);
	});

	test("a changed diff is published once and reported as published", async () => {
		const publisher = recordingPublisher(true);
		expect(await emitPlanningChange(publisher, { repo: REPO, sessionId: SESSION, diff: DIFF })).toBe("published");
		expect(publisher.events).toHaveLength(1);
	});

	test("a publisher that reports failure is 'not-published', and nothing is thrown", async () => {
		expect(await emitPlanningChange(recordingPublisher(false), { repo: REPO, sessionId: SESSION, diff: DIFF })).toBe("not-published");
	});

	test("the bus receives only the six hint fields: the summary and payload never cross", async () => {
		const hints: EventHint[] = [];
		const publisher = busPublisher(
			{
				async publish(hint) {
					hints.push(hint);
					return true;
				},
			},
			{ newId: () => "evt-p52-1", nowIso: () => "2026-10-21T00:00:00.000Z" },
		);
		const event = planningChangeEvent({ repo: REPO, sessionId: SESSION, diff: DIFF });
		if (event === null) throw new Error("expected an event");
		expect(await publisher.publish(event)).toBe(true);
		expect(hints).toEqual([
			{ v: 1, id: "evt-p52-1", kind: "note", surface: "substrate", graph_id: null, ts: "2026-10-21T00:00:00.000Z" },
		]);
		expect(Object.keys(hints[0] ?? {}).sort()).toEqual(["graph_id", "id", "kind", "surface", "ts", "v"]);
	});
});
