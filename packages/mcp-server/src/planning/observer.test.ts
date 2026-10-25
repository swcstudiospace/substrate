/**
 * The planning observer (phase 52, SOTA-08): the only writer of the planning plane. A scan publishes a complete change once,
 * with the sha256 before and after for each path, and heartbeats the checkout it saw change. A scan that sees no change
 * writes nothing. Each test runs on an in-memory tree and a recording presence backend.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EventInput } from "../types.ts";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { DEFAULT_PRESENCE_TTL_S, PLANNING_ROOT_ENV, PLANNING_SCAN_INTERVAL_ENV, loadPlanningSettings } from "./config.ts";
import { PLANNING_OBSERVER_SESSION, PlanningObserver } from "./observer.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX } from "./presence-dragonfly.ts";
import type { PlanningFs } from "./index.ts";
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

/** A recording backend whose writes are refused while `refusesWrites` is set. The reads and the clock keep working, so a write can fail at a known server time. */
class RefusingWritesBackend extends RecordingPresenceBackend {
	refusesWrites = false;

	override async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		if (this.refusesWrites) throw new Error("SET refused");
		return super.setWithTtl(key, value, ttlSeconds);
	}
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

	test("a failed heartbeat is owed: the next scan retries it with nothing else changed, and it stops once written", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RefusingWritesBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		backend.refusesWrites = true; // the clock reads, so the observation is dated: only the write fails
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });
		expect(backend.writes).toEqual([]);

		backend.refusesWrites = false;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "written" } });
		expect(backend.writes).toHaveLength(1);

		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(backend.writes).toHaveLength(1);
	});

	test("an owed heartbeat recovered within the freshness window of its observation still writes", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RefusingWritesBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		const observedAtMs = backend.clockMs;
		const ttlMs = DEFAULT_PRESENCE_TTL_S * 1000;
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		backend.refusesWrites = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });

		backend.clockMs = observedAtMs + ttlMs - 1;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "failed" } });

		backend.clockMs = observedAtMs + ttlMs;
		backend.refusesWrites = false;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "written" } });
		expect(backend.writes).toHaveLength(1);
		expect(storedSession(backend)).toMatchObject({ lastHeartbeatMs: observedAtMs + ttlMs });
	});

	test("an owed heartbeat recovered after the freshness window of its observation writes nothing", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RefusingWritesBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		const observedAtMs = backend.clockMs;
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, first edit\n");
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });
		expect(backend.writes).toHaveLength(1);

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, second edit\n");
		backend.refusesWrites = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });

		backend.clockMs = observedAtMs + DEFAULT_PRESENCE_TTL_S * 1000 + 1;
		backend.refusesWrites = false;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(backend.writes).toHaveLength(1);
		expect(storedSession(backend)).toMatchObject({ lastHeartbeatMs: observedAtMs });
	});

	test("a change observed while the clock is unreadable is never written as active, even after the clock recovers", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, first edit\n");
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });
		const stored = storedSession(backend);

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, second edit\n");
		backend.clockFails = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });
		expect(backend.writes).toHaveLength(1);

		backend.clockFails = false;
		backend.clockMs += 1_000;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(backend.writes).toHaveLength(1);
		expect(storedSession(backend)).toEqual(stored);
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

describe("the observer under a change the ledger does not store, failure, load and shutdown", () => {
	/** A filesystem whose directory reads wait for `gate`, so a scan can be held in flight. */
	function gatedFs(tree: FakeTree, gate: Promise<unknown>): PlanningFs {
		return {
			probe: (path) => tree.probe(path),
			readDir: async (path) => {
				await gate;
				return tree.readDir(path);
			},
			statFile: (path) => tree.statFile(path),
			readFile: (path) => tree.readFile(path),
			openRead: (path, limit, accept, reuse) => tree.openRead(path, limit, accept, reuse),
			sha256: (bytes) => tree.sha256(bytes),
		};
	}

	test("a change the ledger does not store is heartbeated once, and the scans after it are quiet", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend), accept: () => false });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ outcome: "not-published", heartbeat: { state: "written" } });
		expect(await observer.scan()).toMatchObject({ outcome: "not-published", heartbeat: { state: "not-due" } });
		expect(await observer.scan()).toMatchObject({ heartbeat: { state: "not-due" } });
		expect(backend.writes).toHaveLength(1);
	});

	test("a failing scan is reported by the timer once, and the recovery is reported once", async () => {
		const lines: string[] = [];
		let tick: () => Promise<unknown> = async () => undefined;
		const tree = new FakeTree({});
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence: null,
			emit: async () => true,
			timers: {
				setInterval: (run: () => Promise<unknown>) => {
					tick = run;
					return "timer";
				},
				clearInterval: () => undefined,
			},
			report: (line) => lines.push(line),
		});
		expect(observer.start()).toBe(true);

		await tick();
		await tick();
		expect(lines).toEqual(["[substrate] planning observer: scan unavailable: root-unavailable"]);

		tree.setContent(`${TREE_ROOT}/.planning/STATE.md`, "# state\n");
		await tick();
		expect(lines).toEqual(["[substrate] planning observer: scan unavailable: root-unavailable", "[substrate] planning observer: scans succeed again"]);
		observer.stop();
	});

	test("a tick during a running scan shares that scan, and no second scan starts behind it", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let tick: () => Promise<unknown> = async () => undefined;
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: gatedFs(tree, gate),
			presence: null,
			emit: async () => true,
			timers: {
				setInterval: (run: () => Promise<unknown>) => {
					tick = run;
					return "timer";
				},
				clearInterval: () => undefined,
			},
			report: () => undefined,
		});
		observer.start();

		const ticks = [tick(), tick(), tick()];
		release();
		await Promise.all(ticks);
		expect(tree.probed.filter((path) => path === TREE_ROOT)).toHaveLength(1);

		await tick();
		expect(tree.probed.filter((path) => path === TREE_ROOT)).toHaveLength(2);
		observer.stop();
	});

	test("idle resolves only after the scan in flight has finished, so shutdown does not cut it off", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: gatedFs(tree, gate),
			presence: null,
			emit: async () => true,
		});
		let finished = false;
		const scanning = observer.scan().then((scan) => {
			finished = true;
			return scan;
		});
		const waiting = observer.idle();
		release();
		await waiting;
		expect(finished).toBe(true);
		expect(await scanning).toMatchObject({ state: "observed", outcome: "baseline" });
	});
});
