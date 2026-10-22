/**
 * The planning observer (phase 52, SOTA-08): the only writer of the planning plane. A scan publishes a complete change once,
 * with the sha256 before and after for each path, and heartbeats the checkout it saw change. A scan that sees no change
 * writes nothing. Each test runs on an in-memory tree and a recording presence backend.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EventInput } from "../types.ts";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { PLANNING_ROOT_ENV, PLANNING_SCAN_INTERVAL_ENV, loadPlanningSettings } from "./config.ts";
import { PLANNING_OBSERVER_SESSION, PlanningObserver } from "./observer.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX } from "./presence-dragonfly.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const PHASE = `${TREE_ROOT}/.planning/phases/52-planning-awareness-core`;
const CONTEXT = ".planning/phases/52-planning-awareness-core/52-CONTEXT.md";
const REPO = "swcstudiospace/agent-substrate";
const BRANCH = "gsd/p52-wiring";
const GIT: Record<string, string> = {
	[`${TREE_ROOT}/.git/config`]: `[remote "origin"]\n\turl = git@github.com:${REPO}.git\n`,
	[`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n`,
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function observerOver(
	tree: FakeTree,
	options: { presence?: DragonflyPresenceStore | null; accept?: () => boolean } = {},
): { observer: PlanningObserver; events: EventInput[] } {
	const events: EventInput[] = [];
	const observer = new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
		fs: tree,
		presence: options.presence ?? null,
		emit: async (event) => {
			const stored = options.accept ? options.accept() : true;
			if (stored) events.push(event);
			return stored;
		},
	});
	return { observer, events };
}

function storedSession(backend: RecordingPresenceBackend): Record<string, unknown> {
	const key = backend.writes[0]?.key ?? "";
	return JSON.parse(backend.values.get(key) ?? "{}") as Record<string, unknown>;
}

describe("the observer's scans", () => {
	test("the first scan is a baseline: it publishes nothing and writes no heartbeat", async () => {
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" }), {
			presence: new DragonflyPresenceStore(backend),
		});
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "baseline", heartbeat: { state: "not-due" } });
		expect(events).toEqual([]);
		expect(backend.writes).toEqual([]);
	});

	test("an unchanged scan publishes nothing and writes nothing", async () => {
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" }), {
			presence: new DragonflyPresenceStore(backend),
		});
		await observer.scan();
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(events).toEqual([]);
		expect(backend.writes).toEqual([]);
	});

	test("an edit is published once, with the sha256 before and after, and the observed checkout heartbeats", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "published", heartbeat: { state: "written" } });

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			surface: "substrate",
			kind: "note",
			repo: REPO,
			session_id: PLANNING_OBSERVER_SESSION,
			payload: {
				kind: "planning.changed",
				repo: REPO,
				sessionId: PLANNING_OBSERVER_SESSION,
				added: [],
				removed: [],
				changed: [{ path: CONTEXT, before: sha256("# context\n"), after: sha256("# context, edited\n") }],
			},
		});
		expect(JSON.stringify(events)).not.toContain("context, edited");
	});

	test("an add and a removal carry the hash on the side that has one, and no file body", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const { observer, events } = observerOver(tree);
		await observer.scan();

		tree.setContent(`${PHASE}/52-PLAN.md`, "# plan BODY-NEW-FILE\n");
		tree.remove(`${PHASE}/52-CONTEXT.md`);
		await observer.scan();

		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			added: [{ path: ".planning/phases/52-planning-awareness-core/52-PLAN.md", before: null, after: sha256("# plan BODY-NEW-FILE\n") }],
			removed: [{ path: CONTEXT, before: sha256("# context\n"), after: null }],
			changed: [],
		});
		expect(JSON.stringify(events)).not.toContain("BODY-NEW-FILE");
	});

	test("an incremental scan reads and hashes only the document that changed", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n", [`${PHASE}/52-PLAN.md`]: "# plan\n" });
		const { observer } = observerOver(tree);
		await observer.scan();
		tree.returnedFrom.splice(0);

		tree.setContent(`${PHASE}/52-PLAN.md`, "# plan, edited\n");
		await observer.scan();
		expect(tree.returnedFrom).toEqual([`${PHASE}/52-PLAN.md`]);
	});

	test("a failed publish holds the baseline, and the next scan publishes the same change exactly once", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		let accept = false;
		const { observer, events } = observerOver(tree, { accept: () => accept });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(events).toEqual([]);

		accept = true;
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(events).toHaveLength(1);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});

	test("a change in a checkout with no git data is repo-unknown: nothing is published, and the heartbeat says why", async () => {
		const tree = new FakeTree({ [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "repo-unknown", heartbeat: { state: "failed", detail: "no-git-entry" } });
		expect(events).toEqual([]);
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
	});

	test("without a cache endpoint a change is still published, and the heartbeat says presence is unset", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const { observer, events } = observerOver(tree, { presence: null });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "published", heartbeat: { state: "presence-unset" } });
		expect(events).toHaveLength(1);
	});

	test("an unreadable root is unavailable, and it publishes and writes nothing", async () => {
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(new FakeTree({}), { presence: new DragonflyPresenceStore(backend) });
		expect(await observer.scan()).toEqual({ state: "unavailable", code: "root-unavailable" });
		expect(events).toEqual([]);
		expect(backend.writes).toEqual([]);
	});
});

describe("the observer's heartbeat", () => {
	test("an observed change writes the checkout's heartbeat under its session key, with its branch from HEAD", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		await observer.scan();

		expect(backend.writes).toHaveLength(1);
		expect(backend.writes[0]?.key.startsWith(PRESENCE_KEY_PREFIX)).toBe(true);
		expect(storedSession(backend)).toMatchObject({ worktree: TREE_ROOT, branch: BRANCH, activePhase: null, lastHeartbeatMs: backend.clockMs });
	});

	test("the scan is scheduled at the configured cadence: 15000 ms when unset, the set value otherwise, and not while disabled", () => {
		const scheduledWith = (env: Record<string, string>): number[] => {
			const delays: number[] = [];
			const handle = { id: "scan-timer" };
			const observer = new PlanningObserver({
				settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, ...env }),
				fs: new FakeTree({}),
				presence: null,
				emit: async () => true,
				timers: {
					setInterval: (_run, ms) => {
						delays.push(ms);
						return handle;
					},
					clearInterval: () => undefined,
				},
			});
			expect(observer.start()).toBe(true);
			observer.stop();
			return delays;
		};
		expect(scheduledWith({})).toEqual([15_000]);
		expect(scheduledWith({ [PLANNING_SCAN_INTERVAL_ENV]: "2500" })).toEqual([2_500]);

		const disabled = new PlanningObserver({ settings: loadPlanningSettings({}), fs: new FakeTree({}), presence: null, emit: async () => true });
		expect(disabled.start()).toBe(false);
	});
});
