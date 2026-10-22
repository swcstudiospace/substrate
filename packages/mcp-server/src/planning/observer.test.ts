/**
 * The planning observer (phase 52, SOTA-08): the only writer of the planning plane. A scan publishes a complete change once,
 * with the sha256 before and after for each path, and heartbeats the checkout it saw change. A scan that sees no change
 * writes nothing. Each test runs on an in-memory tree and a recording presence backend.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EventInput } from "../types.ts";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { PLANNING_MAX_FILES_ENV, PLANNING_ROOT_ENV, loadPlanningSettings } from "./config.ts";
import type { SessionRecord } from "./presence.ts";
import { PlanningReader, type PlanningSessionsView } from "./read.ts";
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

	test("the observer's timer is refused while the plane is disabled, and runs only between start and stop", () => {
		const disabled = new PlanningObserver({
			settings: loadPlanningSettings({}),
			fs: new FakeTree({}),
			presence: null,
			emit: async () => true,
		});
		expect(disabled.start()).toBe(false);

		const { observer } = observerOver(new FakeTree({}));
		expect(observer.start(60_000)).toBe(true);
		expect(observer.start(60_000)).toBe(true);
		observer.stop();
		expect(observer.start(60_000)).toBe(true);
		observer.stop();
	});
});

const SERVER_NOW = 1_000_000;
const PLAN = `${PHASE}/52-PLAN.md`;

/** An observer with a document cap, for the watcher-gap tests. Every write is stored. */
function gapObserver(tree: FakeTree, presence: DragonflyPresenceStore, maxFiles: string): PlanningObserver {
	return new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, [PLANNING_MAX_FILES_ENV]: maxFiles }),
		fs: tree,
		presence,
		emit: async () => true,
	});
}

/** An observer that records every attempted write and reports each one as stored or refused. */
function announcingObserver(tree: FakeTree, presence: DragonflyPresenceStore, attempts: EventInput[], stored: boolean): PlanningObserver {
	return new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
		fs: tree,
		presence,
		emit: async (event) => {
			attempts.push(event);
			return stored;
		},
	});
}

function planningReaderOver(tree: FakeTree, presence: DragonflyPresenceStore): PlanningReader {
	return new PlanningReader({ settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }), fs: tree, presence });
}

/** A session that claims `activePhase` and reports `phases`, with its planning report known at the server's clock. */
function claimed(backend: RecordingPresenceBackend, sessionId: string, activePhase: string, phases: Array<[string, string[]]>): SessionRecord {
	return {
		sessionId,
		worktree: `/work/${sessionId}`,
		branch: `gsd/${sessionId}`,
		activePhase,
		lastHeartbeatMs: backend.clockMs,
		planning: { status: "known", scannedAtMs: backend.clockMs, phases: phases.map(([phase, plans]) => ({ phase, plans })) },
	};
}

function planningOf(view: PlanningSessionsView, sessionId: string) {
	if (view.state !== "ok") throw new Error(`planning_sessions is ${view.state}`);
	return view.sessions.find((row) => row.sessionId === sessionId)?.planning;
}

describe("planning reports, watcher gaps and conflicts on the write path (phase 53, SOTA-09)", () => {
	test("a complete change stamps this checkout's report into its heartbeat, and another reader sees its plan ids", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const { observer } = observerOver(tree, { presence });
		await observer.scan();

		tree.setContent(PLAN, "---\nplan: 52-01\n---\nBODY, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published", heartbeat: { state: "written" } });
		const [record] = (await presence.listWithin(10)).records;
		expect(record?.planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW, phases: [{ phase: "52", plans: ["52-01"] }] });
	});

	test("a truncated scan opens the watcher gap: its heartbeat is unknown, and the read shows the same", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n", [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		expect(await gapObserver(tree, presence, "1").scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		const [stored] = (await presence.listWithin(10)).records;
		expect(stored?.planning).toEqual({ status: "unknown", scannedAtMs: SERVER_NOW, reason: "scan-truncated" });
		expect(planningOf(await planningReaderOver(tree, presence).sessions(), stored?.sessionId ?? "")).toEqual({ state: "unknown", reason: "scan-truncated" });
	});

	test("a later complete scan clears the gap and returns the checkout to known", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n", [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const observer = gapObserver(tree, presence, "1");
		await observer.scan();

		tree.remove(`${PHASE}/52-CONTEXT.md`);
		expect(await observer.scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		const [stored] = (await presence.listWithin(10)).records;
		expect(stored?.planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW, phases: [{ phase: "52", plans: ["52-01"] }] });
		expect(planningOf(await planningReaderOver(tree, presence).sessions(), stored?.sessionId ?? "")).toEqual({ state: "known", scannedAtMs: SERVER_NOW });
	});

	test("a session whose report is in a watcher gap takes no part in conflict detection until its report is complete again", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		await presence.touch({ ...claimed(backend, "alpha", "52", [["52", []]]), planning: { status: "unknown", scannedAtMs: SERVER_NOW, reason: "scan-truncated" } }, 90_000);
		await presence.touch(claimed(backend, "beta", "52", [["52", ["52-01"]]]), 90_000);
		const events: EventInput[] = [];
		const observer = announcingObserver(tree, presence, events, true);
		await observer.scan();
		expect(events).toEqual([]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({ state: "ok", conflicts: [] });

		await presence.touch(claimed(backend, "alpha", "52", [["52", ["52-01"]]]), 90_000);
		await observer.scan();
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({ kind: "planning.conflict", key: { by: "phase", phase: "52" } });
	});

	test("two known sessions on one phase emit one open event, and a second scan with the same state emits nothing more", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		await presence.touch(claimed(backend, "alpha", "53", [["53", ["53-01"]]]), 90_000);
		await presence.touch(claimed(backend, "beta", "53", [["53", ["53-01"]]]), 90_000);
		const events: EventInput[] = [];
		const observer = announcingObserver(tree, presence, events, true);
		await observer.scan();
		expect(events).toEqual([expect.objectContaining({ surface: "substrate", kind: "warning", payload: expect.objectContaining({ kind: "planning.conflict" }) })]);
		await observer.scan();
		expect(events).toHaveLength(1);
	});

	test("two known sessions on different phases that share a plan id emit one open plan event", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		await presence.touch(claimed(backend, "alpha", "53", [["53", ["shared-plan"]]]), 90_000);
		await presence.touch(claimed(backend, "beta", "54", [["54", ["shared-plan"]]]), 90_000);
		const events: EventInput[] = [];
		await announcingObserver(tree, presence, events, true).scan();
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({ key: { by: "plan", plan: "shared-plan" } });
	});

	test("a single session emits no event", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		await presence.touch(claimed(backend, "alpha", "53", [["53", ["53-01"]]]), 90_000);
		const events: EventInput[] = [];
		await announcingObserver(tree, presence, events, true).scan();
		expect(events).toEqual([]);
	});

	test("a conflict that clears and returns is announced again, and one the ledger did not store is retried on the next scan", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		await presence.touch(claimed(backend, "alpha", "53", [["53", []]]), 90_000);
		await presence.touch(claimed(backend, "beta", "53", [["53", []]]), 90_000);
		const attempts: EventInput[] = [];
		const refusing = announcingObserver(tree, presence, attempts, false);
		await refusing.scan();
		await refusing.scan();
		expect(attempts).toHaveLength(2);

		const accepting = announcingObserver(tree, presence, attempts, true);
		await accepting.scan();
		await accepting.scan();
		expect(attempts).toHaveLength(3);

		await presence.touch(claimed(backend, "beta", "54", [["54", []]]), 90_000);
		await accepting.scan();
		expect(attempts).toHaveLength(3);

		await presence.touch(claimed(backend, "beta", "53", [["53", []]]), 90_000);
		await accepting.scan();
		expect(attempts).toHaveLength(4);
	});

	test("two failed publishes hold the baseline, and the next scan publishes the change exactly once", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		let failures = 2;
		const events: EventInput[] = [];
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence: null,
			emit: async (event) => {
				if (failures > 0) {
					failures--;
					return false;
				}
				events.push(event);
				return true;
			},
		});
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(events).toEqual([]);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(events).toHaveLength(1);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});
});
