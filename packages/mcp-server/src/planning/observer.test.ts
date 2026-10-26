/**
 * The planning observer (phase 52, SOTA-08): the only writer of the planning plane. A scan publishes a complete change once,
 * with the sha256 before and after for each path, and heartbeats the checkout it saw change. A scan that sees no change
 * writes nothing. Each test runs on an in-memory tree and a recording presence backend.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../types.ts";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { BaselineStoreError, FileBaselineStore, type BaselineLoad, type BaselineStore, type StoredBaseline } from "./baseline-store.ts";
import { DEFAULT_PRESENCE_TTL_S, PLANNING_MAX_FILES_ENV, PLANNING_PRESENCE_TTL_ENV, PLANNING_ROOT_ENV, PLANNING_SCAN_INTERVAL_ENV, loadPlanningSettings } from "./config.ts";
import { planningSessionId } from "./checkout.ts";
import { PLANNING_CONFLICT } from "./conflicts.ts";
import { classifySessions, type SessionRecord } from "./presence.ts";
import { PlanningReader, type PlanningSessionsView } from "./read.ts";
import {
	DEFAULT_LIVENESS_INTERVAL_MS,
	PLANNING_LIVENESS_INTERVAL_ENV,
	PLANNING_OBSERVER_SESSION,
	PlanningObserver,
	loadLivenessSettings,
	type PlanningObserverDeps,
} from "./observer.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, presenceRetentionS } from "./presence-dragonfly.ts";
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
		expect(storedSession(backend)).toMatchObject({ worktree: TREE_ROOT, branch: BRANCH, lastHeartbeatMs: backend.clockMs });
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

	test("a touched list past its cap holds the report unknown until the claims it could not keep have left the freshness window", async () => {
		const planOf = (i: number): string => `52-${String(i).padStart(3, "0")}`;
		const planFile = (i: number): string => `${PHASE}/${planOf(i)}-PLAN.md`;
		const planBody = (i: number, body: string): string => `---\nplan: ${planOf(i)}\n---\n${body}\n`;
		const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, k) => from + k);
		const ttlMs = DEFAULT_PRESENCE_TTL_S * 1000;
		const tree = new FakeTree({ ...GIT, ...Object.fromEntries(range(0, 500).map((i) => [planFile(i), planBody(i, "v0")])) });
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		backend.clockMs = SERVER_NOW;
		await observer.scan();

		// The 500 documents change at once: 500 touched pairs, which fit under the cap. The index holds 500 documents, the cap.
		for (const i of range(0, 500)) tree.setContent(planFile(i), planBody(i, "v1"));
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });

		// Twenty documents are replaced by twenty new plans: 40 pairs join the 480 kept ones, 520 in all, past the cap.
		backend.clockMs = SERVER_NOW + 1_000;
		for (const i of range(0, 20)) tree.remove(planFile(i));
		for (const i of range(500, 520)) tree.setContent(planFile(i), planBody(i, "v0"));
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toEqual({ status: "unknown", scannedAtMs: SERVER_NOW + 1_000, reason: "report-limit" });

		// Inside the window of that change, a small edit to a document that was not replaced: the claims that did not fit still hold the report.
		backend.clockMs = SERVER_NOW + 2_000;
		tree.setContent(planFile(100), planBody(100, "v2"));
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toEqual({ status: "unknown", scannedAtMs: SERVER_NOW + 2_000, reason: "report-limit" });

		// One millisecond past the window of the overflowing change, an unchanged scan reads the report known again.
		backend.clockMs = SERVER_NOW + 1_000 + ttlMs + 1;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toMatchObject({ status: "known", scannedAtMs: SERVER_NOW + 1_000 + ttlMs + 1 });
	});

	test("a written heartbeat carries activePhase null, which older readers require", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ heartbeat: { state: "written" } });
		expect(storedSession(backend)).toMatchObject({ activePhase: null });
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

	test("a change observed while the clock is unreadable is not claimed when the clock recovers, so a later write does not report it as fresh", async () => {
		const PHASE_53_CONTEXT = `${TREE_ROOT}/.planning/phases/53-steering/53-CONTEXT.md`;
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n", [PHASE_53_CONTEXT]: "# steering\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();

		// Scan A: an edit to phase 52 while the clock is unreadable is not claimed.
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited while unreadable\n");
		backend.clockFails = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });

		// The clock recovers past the freshness window: a claim made now would be fresh. Scan B sees no further change.
		backend.clockFails = false;
		backend.clockMs = SERVER_NOW + DEFAULT_PRESENCE_TTL_S * 1000 + 1;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });

		// Scan C: an unrelated edit to phase 53 at a readable clock. Only phase 53 may be touched.
		const recoveredAtMs = backend.clockMs;
		tree.setContent(PHASE_53_CONTEXT, "# steering, edited\n");
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual([{ phase: "53", plan: null, observedAtMs: recoveredAtMs }]);
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

	test("the scan timer starts once, stops, and starts again through the same seam", () => {
		const events: string[] = [];
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: new FakeTree({}),
			presence: null,
			emit: async () => true,
			timers: {
				setInterval: () => {
					events.push("set");
					return "handle";
				},
				clearInterval: (handle) => events.push(`clear:${String(handle)}`),
			},
		});
		expect(observer.start()).toBe(true);
		expect(observer.start()).toBe(true);
		observer.stop();
		expect(observer.start()).toBe(true);
		observer.stop();
		expect(events).toEqual(["set", "clear:handle", "set", "clear:handle"]);
	});
});

const SERVER_NOW = 1_000_000;
const PLAN = `${PHASE}/52-PLAN.md`;
const CHECKOUT_A = "/checkout-a";
const CHECKOUT_B = "/checkout-b";
const PHASE_53 = "53-steering";
const PHASE_54 = "54-review";
const TTL_60_S = "60";

/** An observer with a document cap, for the watcher-gap tests. Every write is stored. */
function gapObserver(tree: FakeTree, presence: DragonflyPresenceStore, maxFiles: string): PlanningObserver {
	return new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, [PLANNING_MAX_FILES_ENV]: maxFiles }),
		fs: tree,
		presence,
		emit: async () => true,
	});
}

/** An observer over one checkout that records every attempted conflict write and reports each one as stored or refused. */
function announcingObserver(tree: FakeTree, presence: DragonflyPresenceStore, attempts: EventInput[], stored: boolean, root: string = TREE_ROOT, ttlS?: string): PlanningObserver {
	return new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: root, ...(ttlS === undefined ? {} : { [PLANNING_PRESENCE_TTL_ENV]: ttlS }) }),
		fs: tree,
		presence,
		emit: async (event) => {
			attempts.push(event);
			return stored;
		},
	});
}

/** The conflict events an observer attempted: the `planning.conflict` payloads. A publish (`planning.changed` note) is not a conflict. */
function conflictEventsOf(events: readonly EventInput[]): EventInput[] {
	return events.filter((event) => (event.payload as { kind?: unknown } | undefined)?.kind === PLANNING_CONFLICT);
}

function planningReaderOver(tree: FakeTree, presence: DragonflyPresenceStore, ttlS?: string): PlanningReader {
	return new PlanningReader({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, ...(ttlS === undefined ? {} : { [PLANNING_PRESENCE_TTL_ENV]: ttlS }) }),
		fs: tree,
		presence,
	});
}

/** The record a checkout's last heartbeat stored under its session key. */
function storedRecord(backend: RecordingPresenceBackend, tree: FakeTree, root: string): SessionRecord {
	return JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}${planningSessionId(tree, root)}`) ?? "{}") as SessionRecord;
}

function planningOf(view: PlanningSessionsView, sessionId: string) {
	if (view.state !== "ok") throw new Error(`planning_sessions is ${view.state}`);
	return view.sessions.find((row) => row.sessionId === sessionId)?.planning;
}

/** A checkout's git data (origin and branch) and its files, under its own root. */
function checkoutOf(root: string, branch: string, files: Record<string, string>, repo: string = REPO): Record<string, string> {
	return {
		[`${root}/.git/config`]: `[remote "origin"]\n\turl = git@github.com:${repo}.git\n`,
		[`${root}/.git/HEAD`]: `ref: refs/heads/${branch}\n`,
		...files,
	};
}

/** A document in a checkout's phase directory. */
function phaseDoc(root: string, phaseDir: string, name: string): string {
	return `${root}/.planning/phases/${phaseDir}/${name}`;
}

/** Two checkouts on one tree, each with a context document in phase 53 and in phase 54. */
function twoCheckouts(): FakeTree {
	return new FakeTree({
		...checkoutOf(CHECKOUT_A, "gsd/p53-a", {
			[phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md")]: "# context\n",
			[phaseDoc(CHECKOUT_A, PHASE_54, "54-CONTEXT.md")]: "# context\n",
		}),
		...checkoutOf(CHECKOUT_B, "gsd/p53-b", {
			[phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md")]: "# context\n",
			[phaseDoc(CHECKOUT_B, PHASE_54, "54-CONTEXT.md")]: "# context\n",
		}),
	});
}

/** The two checkouts of `twoCheckouts`, the one with the smaller session id first: it is the announcer of their conflicts. */
function announcerFirst(tree: FakeTree): [string, string] {
	return planningSessionId(tree, CHECKOUT_A) < planningSessionId(tree, CHECKOUT_B) ? [CHECKOUT_A, CHECKOUT_B] : [CHECKOUT_B, CHECKOUT_A];
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
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		backend.clockMs = SERVER_NOW + 1_000;
		tree.deniedListings.add(`${CHECKOUT_A}/.planning/phases/${PHASE_54}`);
		await a.scan();
		backend.clockMs = SERVER_NOW + 2_000;
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(planningOf(await planningReaderOver(tree, presence).sessions(), planningSessionId(tree, CHECKOUT_A))).toEqual({ state: "unknown", reason: "scan-unlisted" });

		backend.clockMs = SERVER_NOW + 3_000;
		tree.deniedListings.delete(`${CHECKOUT_A}/.planning/phases/${PHASE_54}`);
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);
		expect(conflictEventsOf(attempts)[0]?.payload).toMatchObject({ kind: "planning.conflict", key: { by: "phase", phase: "53" } });
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

	test("a gap whose presence write fails is retried on the next identical scan (greptile gap-retry thread)", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n", [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const write = backend.setWithTtl.bind(backend);
		let down = true;
		backend.setWithTtl = async (key, value, ttlSeconds) => {
			if (down) throw new Error("presence unreachable");
			await write(key, value, ttlSeconds);
		};
		const presence = new DragonflyPresenceStore(backend);
		const observer = gapObserver(tree, presence, "1");
		expect(await observer.scan()).toMatchObject({ state: "observed", heartbeat: { state: "failed" } });

		down = false;
		expect(await observer.scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		const [stored] = (await presence.listWithin(10)).records;
		expect(stored?.planning).toEqual({ status: "unknown", scannedAtMs: SERVER_NOW, reason: "scan-truncated" });
	});

	test("a failed scan writes the unknown report, and the recovered complete scan writes the known one (greptile failed-scan thread)", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n", [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const { observer } = observerOver(tree, { presence });
		await observer.scan();

		tree.setContent(PLAN, "---\nplan: 52-01\n---\nBODY, edited\n");
		await observer.scan();
		const [known] = (await presence.listWithin(10)).records;
		expect(known?.planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW, phases: [{ phase: "52", plans: ["52-01"] }] });

		tree.remove(PLAN);
		tree.remove(`${PHASE}/52-CONTEXT.md`);
		backend.clockMs = SERVER_NOW + 1_000;
		expect(await observer.scan()).toMatchObject({ state: "unavailable", code: "planning-dir-unavailable" });
		const [failed] = (await presence.listWithin(10)).records;
		expect(failed?.planning).toEqual({ status: "unknown", scannedAtMs: SERVER_NOW + 1_000, reason: "scan-failed" });

		tree.setContent(PLAN, "---\nplan: 52-01\n---\nBODY, edited\n");
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context\n");
		backend.clockMs = SERVER_NOW + 2_000;
		expect(await observer.scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		const [recovered] = (await presence.listWithin(10)).records;
		expect(recovered?.planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW + 2_000, phases: [{ phase: "52", plans: ["52-01"] }] });
	});

	test("a publish held by the ledger is retried without renewing the touched time of the edit (greptile publish-retry thread)", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		let accept = false;
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence,
			emit: async () => accept,
		});
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		backend.clockMs = SERVER_NOW + 50_000;
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual([{ phase: "52", plan: null, observedAtMs: SERVER_NOW }]);

		accept = true;
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual([{ phase: "52", plan: null, observedAtMs: SERVER_NOW }]);
	});

	test("a restored edit is claimed when the file returns to its baseline content, so its pair is dated at the restore while the publish stays held", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence,
			emit: async () => false,
		});
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual([{ phase: "52", plan: null, observedAtMs: SERVER_NOW }]);

		// The first claim is past its window when the edit is restored, so only the restore's own claim can keep the pair touched.
		const restoredAtMs = SERVER_NOW + DEFAULT_PRESENCE_TTL_S * 1000 + 1;
		backend.clockMs = restoredAtMs;
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual([{ phase: "52", plan: null, observedAtMs: restoredAtMs }]);
	});

	test("a scan whose clock read fails withdraws its report, so the write that follows carries no stale known view, and the next clock reading restores it (greptile stale-report thread)", async () => {
		const tree = new FakeTree({ ...GIT, [PLAN]: "---\nplan: 52-01\n---\nBODY\n", [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const { observer } = observerOver(tree, { presence });
		await observer.scan();

		tree.setContent(PLAN, "---\nplan: 52-01\n---\nBODY, edited\n");
		await observer.scan();
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW, phases: [{ phase: "52", plans: ["52-01"] }] });

		// The scan's own clock read fails once; the heartbeat's read after it succeeds.
		const serverTime = backend.serverTimeMs.bind(backend);
		let scanClockFails = true;
		backend.serverTimeMs = async () => {
			if (scanClockFails) {
				scanClockFails = false;
				throw new Error("TIME is unavailable");
			}
			return serverTime();
		};
		backend.clockMs = SERVER_NOW + 1_000;
		tree.setContent(PLAN, "---\nplan: 52-01\n---\nBODY, edited again\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toBeUndefined();

		backend.clockMs = SERVER_NOW + 2_000;
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "unchanged", heartbeat: { state: "written" } });
		expect(storedRecord(backend, tree, TREE_ROOT).planning).toEqual({ status: "known", scannedAtMs: SERVER_NOW + 2_000, phases: [{ phase: "52", plans: ["52-01"] }] });
	});

	test("a new edit while a publish is held renews only its own touched pair, and the held pair keeps its first time (greptile publish-retry thread)", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n", [phaseDoc(TREE_ROOT, PHASE_53, "53-CONTEXT.md")]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		let accept = false;
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence,
			emit: async () => accept,
		});
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		backend.clockMs = SERVER_NOW + 50_000;
		tree.setContent(phaseDoc(TREE_ROOT, PHASE_53, "53-CONTEXT.md"), "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });

		const firstTimes = [
			{ phase: "52", plan: null, observedAtMs: SERVER_NOW },
			{ phase: "53", plan: null, observedAtMs: SERVER_NOW + 50_000 },
		];
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toHaveLength(2);
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual(expect.arrayContaining(firstTimes));

		accept = true;
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toHaveLength(2);
		expect(storedRecord(backend, tree, TREE_ROOT).touched).toEqual(expect.arrayContaining(firstTimes));
	});

	test("two checkouts whose origins differ only in letter case share one conflict, and exactly one announces it (greptile case thread)", async () => {
		const tree = new FakeTree({
			...checkoutOf(CHECKOUT_A, "gsd/p53-a", { [phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md")]: "# context\n" }, "SomeOrg/Repo"),
			...checkoutOf(CHECKOUT_B, "gsd/p53-b", { [phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md")]: "# context\n" }, "someorg/repo"),
		});
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(0);

		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		await a.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);

		await b.scan();
		expect(conflictEventsOf(attempts)).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ kind: "planning.conflict", key: { by: "phase", phase: "53" } }) }),
		]);
	});

	test("a timer tick that finds a scan still running starts no second scan (greptile slow-reads thread)", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
		let tick: (() => void) | undefined;
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence: null,
			emit: async () => {
				await blocked;
				return true;
			},
			timers: {
				setInterval: (run) => {
					tick = run;
					return "timer";
				},
				clearInterval: () => undefined,
			},
		});
		expect(observer.start()).toBe(true);
		await observer.scan();

		const scans: Promise<unknown>[] = [];
		const scanNow = observer.scan.bind(observer);
		observer.scan = () => {
			const run = scanNow();
			scans.push(run);
			return run;
		};
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		tick?.();
		tick?.();
		release();
		await Promise.all(scans);
		expect(new Set(scans).size).toBe(1);
	});
});

describe("touched pairs and conflicts in production (phase 53, SOTA-09)", () => {
	test("two checkouts whose complete observations change files of one phase produce one open conflict for that phase", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		expect(conflictEventsOf(attempts)).toEqual([]);

		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		await b.scan();
		await a.scan();

		const sessionIds = [planningSessionId(tree, CHECKOUT_A), planningSessionId(tree, CHECKOUT_B)].sort();
		expect(conflictEventsOf(attempts)).toEqual([
			expect.objectContaining({
				surface: "substrate",
				kind: "warning",
				payload: expect.objectContaining({ kind: "planning.conflict", key: { by: "phase", phase: "53" }, sessionIds }),
			}),
		]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({
			state: "ok",
			conflicts: [{ status: "open", key: { by: "phase", phase: "53" }, sessionIds }],
		});
	});

	test("a checkout whose complete observation changed only other phases produces no conflict", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_54, "54-CONTEXT.md"), "# context, b\n");
		await b.scan();

		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(storedRecord(backend, tree, CHECKOUT_A).touched).toEqual([{ phase: "53", plan: null, observedAtMs: SERVER_NOW }]);
		expect(storedRecord(backend, tree, CHECKOUT_B).touched).toEqual([{ phase: "54", plan: null, observedAtMs: SERVER_NOW }]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({ state: "ok", conflicts: [] });
	});

	test("a touched pair that falls outside the TTL no longer conflicts", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A, TTL_60_S);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B, TTL_60_S);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		backend.clockMs = SERVER_NOW + 45_000;
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_54, "54-CONTEXT.md"), "# context, a\n");
		await a.scan();
		backend.clockMs = SERVER_NOW + 70_000;
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();

		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(storedRecord(backend, tree, CHECKOUT_A).touched).toContainEqual({ phase: "53", plan: null, observedAtMs: SERVER_NOW });
		expect(await planningReaderOver(tree, presence, TTL_60_S).sessions()).toMatchObject({ state: "ok", conflicts: [] });
	});

	test("an incomplete observation neither adds nor removes touched pairs", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		await a.scan();
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		const touched = storedRecord(backend, tree, CHECKOUT_A).touched;
		expect(touched).toEqual([{ phase: "53", plan: null, observedAtMs: SERVER_NOW }]);

		backend.clockMs = SERVER_NOW + 10_000;
		tree.deniedListings.add(`${CHECKOUT_A}/.planning/phases/${PHASE_54}`);
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a again\n");
		expect(await a.scan()).toMatchObject({ state: "observed", outcome: "incomplete", heartbeat: { state: "written" } });

		expect(storedRecord(backend, tree, CHECKOUT_A)).toMatchObject({ touched, planning: { status: "unknown", reason: "scan-unlisted" } });
		expect(conflictEventsOf(attempts)).toEqual([]);
	});

	test("a conflict stays open, and nothing is closed or edited, when a side's later complete observation no longer touches the phase", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);
		const bRecord = backend.values.get(`${PRESENCE_KEY_PREFIX}${planningSessionId(tree, CHECKOUT_B)}`);

		backend.clockMs = SERVER_NOW + 5_000;
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_54, "54-CONTEXT.md"), "# context, a again\n");
		await a.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);
		expect(backend.values.get(`${PRESENCE_KEY_PREFIX}${planningSessionId(tree, CHECKOUT_B)}`)).toBe(bRecord);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({
			state: "ok",
			conflicts: [{ status: "open", key: { by: "phase", phase: "53" } }],
		});
	});

	test("two known sessions on different phases that share a plan id emit one open plan event", async () => {
		const tree = new FakeTree({
			...checkoutOf(CHECKOUT_A, "gsd/p53-a", { [phaseDoc(CHECKOUT_A, PHASE_53, "53-PLAN.md")]: "---\nplan: shared-plan\n---\nBODY\n" }),
			...checkoutOf(CHECKOUT_B, "gsd/p53-b", { [phaseDoc(CHECKOUT_B, PHASE_54, "54-PLAN.md")]: "---\nplan: shared-plan\n---\nBODY\n" }),
		});
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-PLAN.md"), "---\nplan: shared-plan\n---\nBODY, edited\n");
		await a.scan();
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_54, "54-PLAN.md"), "---\nplan: shared-plan\n---\nBODY, edited\n");
		await b.scan();
		await a.scan();

		expect(conflictEventsOf(attempts)).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ kind: "planning.conflict", key: { by: "plan", plan: "shared-plan" }, phases: ["53", "54"] }) }),
		]);
	});

	test("a single session emits no event", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		await a.scan();
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		await a.scan();

		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({ state: "ok", conflicts: [] });
	});

	test("a conflict that clears and returns is announced again, and one the ledger did not store is retried on the next scan", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const [announcer, other] = announcerFirst(tree);
		const attempts: EventInput[] = [];
		const refusing = announcingObserver(tree, presence, attempts, false, announcer);
		const second = announcingObserver(tree, presence, attempts, true, other);
		await refusing.scan();
		await second.scan();
		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await refusing.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await second.scan();
		await refusing.scan();
		await refusing.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(2);

		const accepting = announcingObserver(tree, presence, attempts, true, announcer);
		await accepting.scan();
		await accepting.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(3);

		backend.clockMs = SERVER_NOW + 100_000;
		await accepting.scan();
		await second.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(3);

		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, a again\n");
		await accepting.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, b again\n");
		await second.scan();
		await accepting.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(4);
	});

	test("of two observers over one conflict, only the one with the smallest session id announces it, once, however often both scan", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const [announcer, other] = announcerFirst(tree);
		const announced: EventInput[] = [];
		const silent: EventInput[] = [];
		const a = announcingObserver(tree, presence, announced, true, announcer);
		const b = announcingObserver(tree, presence, silent, true, other);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, announcer\n");
		await a.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, other\n");
		await b.scan();
		await a.scan();
		await b.scan();
		await a.scan();

		expect(conflictEventsOf(announced)).toHaveLength(1);
		expect(conflictEventsOf(silent)).toEqual([]);
	});

	test("the announcer announces a conflict again once it clears and returns, and the other observer announces neither time", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const [announcer, other] = announcerFirst(tree);
		const announced: EventInput[] = [];
		const silent: EventInput[] = [];
		const a = announcingObserver(tree, presence, announced, true, announcer);
		const b = announcingObserver(tree, presence, silent, true, other);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, announcer\n");
		await a.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, other\n");
		await b.scan();
		await a.scan();
		expect(conflictEventsOf(announced)).toHaveLength(1);

		backend.clockMs = SERVER_NOW + 100_000;
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(announced)).toHaveLength(1);

		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, announcer again\n");
		await a.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, other again\n");
		await b.scan();
		await a.scan();
		expect(conflictEventsOf(announced)).toHaveLength(2);
		expect(conflictEventsOf(silent)).toEqual([]);
	});

	test("an observer whose session is not the smallest emits nothing, though its own scan sees the conflict", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const [announcer, other] = announcerFirst(tree);
		const announced: EventInput[] = [];
		const silent: EventInput[] = [];
		const a = announcingObserver(tree, presence, announced, true, announcer);
		const b = announcingObserver(tree, presence, silent, true, other);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(announcer, PHASE_53, "53-CONTEXT.md"), "# context, announcer\n");
		await a.scan();
		tree.setContent(phaseDoc(other, PHASE_53, "53-CONTEXT.md"), "# context, other\n");
		await b.scan();

		expect(conflictEventsOf(silent)).toEqual([]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({
			state: "ok",
			conflicts: [{ status: "open", key: { by: "phase", phase: "53" } }],
		});
		await a.scan();
		expect(conflictEventsOf(announced)).toHaveLength(1);
	});

	test("two checkouts of unrelated repositories that touch the same phase number do not conflict (greptile repo thread)", async () => {
		const tree = new FakeTree({
			...checkoutOf(CHECKOUT_A, "gsd/p53-a", { [phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md")]: "# context\n" }, "owner/one"),
			...checkoutOf(CHECKOUT_B, "gsd/p53-b", { [phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md")]: "# context\n" }, "owner/two"),
		});
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();

		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({ state: "ok", conflicts: [] });
		expect(storedRecord(backend, tree, CHECKOUT_B)).toMatchObject({ repo: "owner/two" });
	});

	test("a peer that expires while the scan runs is not warned about (greptile expired-edits thread)", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		let expireDuringScan = false;
		const a = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: CHECKOUT_A }),
			fs: tree,
			presence,
			emit: async (event) => {
				attempts.push(event);
				// The publish takes longer than the freshness window: B's edit has expired by the time the scan judges peers.
				if (expireDuringScan) backend.clockMs += 91_000;
				return true;
			},
		});
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		expireDuringScan = true;
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();

		expect(conflictEventsOf(attempts)).toEqual([]);
		expect(await planningReaderOver(tree, presence).sessions()).toMatchObject({ state: "ok", conflicts: [] });
	});

	test("a checkout whose repository was unreadable during its edit is heartbeated once it reads again, keeping the edit's time (greptile recovered-sessions thread)", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();

		tree.denied.add(`${CHECKOUT_A}/.git/config`);
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		expect(storedRecord(backend, tree, CHECKOUT_A)).toMatchObject({ repo: null, touched: [{ phase: "53", plan: null, observedAtMs: SERVER_NOW }] });

		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		expect(conflictEventsOf(attempts)).toEqual([]);

		tree.denied.delete(`${CHECKOUT_A}/.git/config`);
		backend.clockMs = SERVER_NOW + 1_000;
		expect(await a.scan()).toMatchObject({ state: "observed", heartbeat: { state: "written" } });
		await b.scan();
		expect(storedRecord(backend, tree, CHECKOUT_A)).toMatchObject({ repo: REPO, touched: [{ phase: "53", plan: null, observedAtMs: SERVER_NOW }] });
		expect(conflictEventsOf(attempts)).toHaveLength(1);
	});

	test("a truncated listing does not repeat the warning for a conflict that stays open (greptile partial-listing thread)", async () => {
		const tree = twoCheckouts();
		const backend = new RecordingPresenceBackend();
		backend.clockMs = SERVER_NOW;
		const presence = new DragonflyPresenceStore(backend);
		const attempts: EventInput[] = [];
		const a = announcingObserver(tree, presence, attempts, true, CHECKOUT_A);
		const b = announcingObserver(tree, presence, attempts, true, CHECKOUT_B);
		await a.scan();
		await b.scan();
		tree.setContent(phaseDoc(CHECKOUT_B, PHASE_53, "53-CONTEXT.md"), "# context, b\n");
		await b.scan();
		tree.setContent(phaseDoc(CHECKOUT_A, PHASE_53, "53-CONTEXT.md"), "# context, a\n");
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);

		// 255 more sessions sort before the two conflicting ones and push the listing past its bound: one of them is not listed.
		const filler = (n: number): string => `aa-${String(n).padStart(3, "0")}`;
		for (let n = 0; n < 255; n += 1) {
			backend.values.set(`${PRESENCE_KEY_PREFIX}${filler(n)}`, JSON.stringify({ sessionId: filler(n), worktree: `/work/${filler(n)}`, branch: "gsd/aa", lastHeartbeatMs: SERVER_NOW }));
		}
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);

		for (let n = 0; n < 255; n += 1) backend.values.delete(`${PRESENCE_KEY_PREFIX}${filler(n)}`);
		await a.scan();
		await b.scan();
		expect(conflictEventsOf(attempts)).toHaveLength(1);
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

const PLAN_PATH = ".planning/phases/52-planning-awareness-core/52-PLAN.md";
const HOUR_MS = 3_600_000;

/** An observer over `tree` that stores what it publishes in `events`. `extra` overrides any dependency, `env` any planning setting. */
function liveObserver(tree: FakeTree, events: EventInput[], extra: Partial<PlanningObserverDeps> = {}, env: Record<string, string> = {}): PlanningObserver {
	return new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, ...env }),
		fs: tree,
		presence: null,
		emit: async (event) => {
			events.push(event);
			return true;
		},
		...extra,
	});
}

/** A baseline store in memory. A test sets how it answers a load, whether its saves fail, and whether they wait on a gate. */
class MemoryBaselines implements BaselineStore {
	readonly files = new Map<string, StoredBaseline>();
	loads: BaselineLoad | "throws" | null = null;
	failSaves = false;
	gate: Promise<void> | null = null;
	attempts = 0;
	saves = 0;

	async load(key: string): Promise<BaselineLoad> {
		if (this.loads === "throws") throw new BaselineStoreError("invalid-key", null);
		if (this.loads !== null) return this.loads;
		const held = this.files.get(key);
		return held === undefined ? { state: "none" } : { state: "loaded", baseline: held };
	}

	async save(key: string, baseline: StoredBaseline): Promise<void> {
		this.attempts += 1;
		if (this.gate !== null) await this.gate;
		if (this.failSaves) throw new BaselineStoreError("write-failed", "EIO");
		this.files.set(key, baseline);
		this.saves += 1;
	}
}

/** How much an observer holds on to: every object, array element, map and set entry it reaches, outside its dependencies. */
function retainedNodes(observer: PlanningObserver): number {
	const seen = new Set<object>();
	const walk = (value: unknown): number => {
		if (typeof value !== "object" || value === null || seen.has(value)) return 0;
		seen.add(value);
		let nodes = 1;
		if (value instanceof Map) for (const [key, entry] of value) nodes += 1 + walk(key) + walk(entry);
		else if (value instanceof Set) for (const entry of value) nodes += 1 + walk(entry);
		else for (const entry of Object.values(value)) nodes += walk(entry);
		return nodes;
	};
	const own = observer as unknown as Record<string, unknown>;
	return Object.keys(own)
		.filter((name) => !["deps", "timers", "reporter", "clock"].includes(name))
		.reduce((total, name) => total + walk(own[name]), 0);
}

describe("the liveness heartbeat: a session is alive, not only changing", () => {
	test("30 simulated hours of scans with no planning change: the session stays active while it heartbeats, and goes stale when the heartbeats stop", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const presence = new DragonflyPresenceStore(backend);
		const events: EventInput[] = [];
		const observer = liveObserver(tree, events, { presence, liveness: { intervalMs: 0 } });
		const startMs = backend.clockMs;
		const ttlMs = DEFAULT_PRESENCE_TTL_S * 1000;
		const now = async () => classifySessions(await presence.list(), backend.clockMs, ttlMs)[0];

		expect(await observer.scan()).toEqual({ state: "observed", outcome: "baseline", heartbeat: { state: "not-due" }, liveness: { state: "written" } });
		for (let minute = 1; minute <= 30 * 60; minute++) {
			backend.clockMs += 60_000;
			expect(await observer.scan()).toMatchObject({ outcome: "unchanged", heartbeat: { state: "not-due" }, liveness: { state: "written" } });
			if (minute % 300 === 0) expect((await now())?.status).toBe("active");
		}
		// 30 hours with no planning change: alive, and idle for exactly that long. The change time is the first write's.
		expect(await now()).toMatchObject({ sessionId: planningSessionId(tree, TREE_ROOT), status: "active", lastHeartbeatMs: startMs, ageMs: 0, idleForMs: 30 * HOUR_MS });
		expect(events).toEqual([]);
		// Every write renewed the key by the lifetime derived from the freshness window.
		expect([...new Set(backend.writes.map((write) => write.ttlSeconds))]).toEqual([presenceRetentionS(ttlMs)]);

		// The heartbeats stop. A sign of life exactly the TTL old is still active; one millisecond more is stale, and still listed.
		backend.clockMs += ttlMs;
		expect((await now())?.status).toBe("active");
		backend.clockMs += 1;
		expect(await now()).toMatchObject({ status: "stale", ageMs: ttlMs + 1, idleForMs: 30 * HOUR_MS + ttlMs + 1 });
	}, 120_000);

	test("a liveness write keeps the change time, and the next change heartbeat moves it and needs no liveness field", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const observer = liveObserver(tree, [], { presence: new DragonflyPresenceStore(backend), liveness: { intervalMs: 0 } });
		const startMs = backend.clockMs;
		await observer.scan();

		backend.clockMs += HOUR_MS;
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged", liveness: { state: "written" } });
		expect(storedSession(backend)).toMatchObject({ lastHeartbeatMs: startMs, livenessMs: startMs + HOUR_MS });

		backend.clockMs += 15_000;
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" }, liveness: { state: "covered" } });
		const stored = storedSession(backend);
		expect(stored.lastHeartbeatMs).toBe(startMs + HOUR_MS + 15_000);
		expect("livenessMs" in stored).toBe(false);
		expect(backend.writes).toHaveLength(3);
	});

	test("without the liveness setting a quiet scan writes nothing, as before", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		const observer = liveObserver(tree, [], { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(backend.writes).toEqual([]);
	});

	test("the interval spaces the writes, and never exceeds a third of the freshness window", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RecordingPresenceBackend();
		// A one-hour interval is capped at a third of the 90 s window: 30 s.
		const observer = liveObserver(tree, [], { presence: new DragonflyPresenceStore(backend), liveness: { intervalMs: HOUR_MS } });
		expect(await observer.scan()).toMatchObject({ liveness: { state: "written" } });
		backend.clockMs += 29_999;
		expect(await observer.scan()).toMatchObject({ liveness: { state: "not-due" } });
		backend.clockMs += 1;
		expect(await observer.scan()).toMatchObject({ liveness: { state: "written" } });
		expect(backend.writes).toHaveLength(2);

		// A ten-minute interval inside a one-hour window is kept as it is.
		const slowBackend = new RecordingPresenceBackend();
		const slow = liveObserver(tree, [], { presence: new DragonflyPresenceStore(slowBackend), liveness: { intervalMs: 600_000 } }, { [PLANNING_PRESENCE_TTL_ENV]: "3600" });
		await slow.scan();
		slowBackend.clockMs += 599_999;
		expect(await slow.scan()).toMatchObject({ liveness: { state: "not-due" } });
		slowBackend.clockMs += 1;
		expect(await slow.scan()).toMatchObject({ liveness: { state: "written" } });
	});

	test("a failed liveness write is reported once and tried again on the next scan, and recovery is reported", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RefusingWritesBackend();
		const lines: string[] = [];
		let tick: () => Promise<unknown> = async () => undefined;
		const observer = liveObserver(tree, [], {
			presence: new DragonflyPresenceStore(backend),
			liveness: { intervalMs: 0 },
			report: (line) => lines.push(line),
			timers: {
				setInterval: (run) => {
					tick = run;
					return "scan-timer";
				},
				clearInterval: () => undefined,
			},
		});
		expect(observer.start()).toBe(true);
		backend.refusesWrites = true;
		await tick();
		await tick();
		expect(lines).toEqual(["[substrate] planning observer: liveness heartbeat failed: UNKNOWN"]);
		expect(backend.writes).toEqual([]);

		backend.refusesWrites = false;
		backend.clockMs += 1_000;
		await tick();
		expect(lines).toEqual(["[substrate] planning observer: liveness heartbeat failed: UNKNOWN", "[substrate] planning observer: scans succeed again"]);
		expect(storedSession(backend)).toMatchObject({ livenessMs: backend.clockMs });
		observer.stop();
	});

	test("a checkout that cannot be read is not proven alive: no liveness write", async () => {
		const backend = new RecordingPresenceBackend();
		const observer = liveObserver(new FakeTree({}), [], { presence: new DragonflyPresenceStore(backend), liveness: { intervalMs: 0 } });
		expect(await observer.scan()).toEqual({ state: "unavailable", code: "root-unavailable" });
		expect(backend.writes).toEqual([]);
	});

	test("with no cache endpoint there is nothing to write, and the scan says so", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const observer = liveObserver(tree, [], { liveness: { intervalMs: 0 } });
		expect(await observer.scan()).toMatchObject({ outcome: "baseline", liveness: { state: "presence-unset" } });
	});

	test("the liveness setting is an integer from 0 to an hour, defaults to every scan, and is never echoed", () => {
		expect(loadLivenessSettings({})).toEqual({ ok: true, settings: { intervalMs: DEFAULT_LIVENESS_INTERVAL_MS } });
		expect(DEFAULT_LIVENESS_INTERVAL_MS).toBe(0);
		expect(loadLivenessSettings({ [PLANNING_LIVENESS_INTERVAL_ENV]: "15000" })).toEqual({ ok: true, settings: { intervalMs: 15_000 } });
		expect(loadLivenessSettings({ [PLANNING_LIVENESS_INTERVAL_ENV]: "3600000" })).toEqual({ ok: true, settings: { intervalMs: 3_600_000 } });
		for (const bad of ["abc", "-1", "1.5", "", " 5"]) {
			expect(loadLivenessSettings({ [PLANNING_LIVENESS_INTERVAL_ENV]: bad })).toEqual({ ok: false, errors: [{ key: PLANNING_LIVENESS_INTERVAL_ENV, reason: "not-integer" }] });
		}
		expect(loadLivenessSettings({ [PLANNING_LIVENESS_INTERVAL_ENV]: "3600001" })).toEqual({
			ok: false,
			errors: [{ key: PLANNING_LIVENESS_INTERVAL_ENV, reason: "out-of-range", min: 0, max: 3_600_000 }],
		});
	});
});

describe("the observer's durable baseline: a restart publishes what changed while it was down", () => {
	const KEY = planningSessionId(new FakeTree({}), TREE_ROOT);

	test("a restarted observer with a stored baseline publishes exactly the changes made while it was down, once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "planning-baseline-"));
		try {
			const store = new FileBaselineStore(join(dir, "baselines"));
			const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n", [`${PHASE}/52-PLAN.md`]: "# plan\n" });
			const events: EventInput[] = [];
			const first = liveObserver(tree, events, { baselines: store, baselineSaveIntervalMs: 0 });
			expect(await first.scan()).toMatchObject({ outcome: "baseline" });
			await first.idle();
			expect(events).toEqual([]);

			// The first observer is gone. The tree changes while no observer runs.
			tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
			tree.remove(`${PHASE}/52-PLAN.md`);
			tree.setContent(`${PHASE}/52-02-PLAN.md`, "# plan two\n");
			const second = liveObserver(tree, events, { baselines: store, baselineSaveIntervalMs: 0 });
			expect(await second.scan()).toMatchObject({ outcome: "published" });
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({
				kind: "planning.changed",
				added: [{ path: ".planning/phases/52-planning-awareness-core/52-02-PLAN.md", before: null, after: sha256("# plan two\n") }],
				removed: [{ path: PLAN_PATH, before: sha256("# plan\n"), after: null }],
				changed: [{ path: CONTEXT, before: sha256("# context\n"), after: sha256("# context, edited\n") }],
			});
			expect(JSON.stringify(events)).not.toContain("context, edited");
			await second.idle();

			// A third start finds the baseline the second one saved: nothing is published twice.
			const third = liveObserver(tree, events, { baselines: store, baselineSaveIntervalMs: 0 });
			expect(await third.scan()).toMatchObject({ outcome: "unchanged" });
			expect(events).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("with no stored baseline the first scan is a baseline and publishes nothing, and it saves one", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		const events: EventInput[] = [];
		const observer = liveObserver(tree, events, { baselines: store });
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "baseline", heartbeat: { state: "not-due" } });
		expect(events).toEqual([]);
		await observer.idle();
		expect(store.files.get(KEY)).toMatchObject({ root: TREE_ROOT, snapshot: { truncated: false, unlisted: [], records: [{ path: CONTEXT, sha256: sha256("# context\n") }] } });
	});

	test("a stored baseline that matches the tree publishes nothing", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		const events: EventInput[] = [];
		const first = liveObserver(tree, events, { baselines: store });
		await first.scan();
		await first.idle();
		const restarted = liveObserver(tree, events, { baselines: store });
		expect(await restarted.scan()).toEqual({ state: "observed", outcome: "unchanged", heartbeat: { state: "not-due" } });
		expect(events).toEqual([]);
	});

	test("a restored change the ledger does not store is held, and published on a later scan", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		const first = liveObserver(tree, [], { baselines: store });
		await first.scan();
		await first.idle();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");

		let accept = false;
		const events: EventInput[] = [];
		const restarted = liveObserver(tree, events, {
			baselines: store,
			emit: async (event) => {
				if (accept) events.push(event);
				return accept;
			},
		});
		expect(await restarted.scan()).toMatchObject({ outcome: "not-published" });
		accept = true;
		expect(await restarted.scan()).toMatchObject({ outcome: "published" });
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({ changed: [{ path: CONTEXT, before: sha256("# context\n"), after: sha256("# context, edited\n") }] });
	});

	test("a stored baseline with a gap publishes nothing: an incomplete diff proves no absence", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		store.files.set(KEY, { root: TREE_ROOT, snapshot: { records: [], truncated: true, unlisted: [] } });
		const events: EventInput[] = [];
		expect(await liveObserver(tree, events, { baselines: store }).scan()).toMatchObject({ outcome: "incomplete" });
		expect(events).toEqual([]);
	});

	test("an unusable stored baseline is reported and treated as none; a store that throws likewise; another root's is ignored", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const events: EventInput[] = [];

		const corrupt = new MemoryBaselines();
		corrupt.loads = { state: "unusable", reason: "bad-shape", detail: null };
		const corruptLines: string[] = [];
		expect(await liveObserver(tree, events, { baselines: corrupt, report: (line) => corruptLines.push(line) }).scan()).toMatchObject({ outcome: "baseline" });
		expect(corruptLines).toEqual(["[substrate] planning observer: stored baseline unusable (bad-shape); scanning as a first run"]);

		const throwing = new MemoryBaselines();
		throwing.loads = "throws";
		const throwingLines: string[] = [];
		expect(await liveObserver(tree, events, { baselines: throwing, report: (line) => throwingLines.push(line) }).scan()).toMatchObject({ outcome: "baseline" });
		expect(throwingLines).toEqual(["[substrate] planning observer: stored baseline not read: invalid-key; scanning as a first run"]);

		const foreign = new MemoryBaselines();
		foreign.files.set(KEY, { root: "/elsewhere", snapshot: { records: [], truncated: false, unlisted: [] } });
		const foreignLines: string[] = [];
		expect(await liveObserver(tree, events, { baselines: foreign, report: (line) => foreignLines.push(line) }).scan()).toMatchObject({ outcome: "baseline" });
		expect(foreignLines).toEqual(["[substrate] planning observer: stored baseline names another checkout root; scanning as a first run"]);
		expect(events).toEqual([]);
	});

	test("saves are throttled by the injected clock, and a quiet tree saves nothing more", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		let nowMs = 1_000_000;
		const observer = liveObserver(tree, [], { baselines: store, now: () => nowMs, baselineSaveIntervalMs: 5_000 });
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);

		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);
		nowMs += 4_999;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);
		nowMs += 1;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(2);
		expect(store.files.get(KEY)?.snapshot.records).toEqual([{ path: CONTEXT, sha256: sha256("# context, edited\n") }]);

		nowMs += 60_000;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(2);
	});

	test("flushBaseline saves a dirty baseline at once, whatever the throttle", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		const observer = liveObserver(tree, [], { baselines: store, now: () => 1_000_000, baselineSaveIntervalMs: 60_000 });
		await observer.scan();
		await observer.idle();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);

		await observer.flushBaseline();
		expect(store.attempts).toBe(2);
		expect(store.files.get(KEY)?.snapshot.records).toEqual([{ path: CONTEXT, sha256: sha256("# context, edited\n") }]);
		await observer.flushBaseline();
		expect(store.attempts).toBe(2);
	});

	test("a slow save never holds a scan, and no second save starts behind it", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		const gate = Promise.withResolvers<void>();
		store.gate = gate.promise;
		const observer = liveObserver(tree, [], { baselines: store, baselineSaveIntervalMs: 0 });
		expect(await observer.scan()).toMatchObject({ outcome: "baseline" });
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(store.attempts).toBe(1);
		expect(store.saves).toBe(0);

		gate.resolve();
		await observer.idle();
		expect(store.saves).toBe(1);
		// The save in flight held the baseline of the first scan; the change since is saved on the next scan.
		await observer.scan();
		await observer.idle();
		expect(store.files.get(KEY)?.snapshot.records).toEqual([{ path: CONTEXT, sha256: sha256("# context, edited\n") }]);
	});

	test("a failed save is reported once, retried after the interval, and the recovery is reported", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		store.failSaves = true;
		const lines: string[] = [];
		let nowMs = 1_000_000;
		const observer = liveObserver(tree, [], { baselines: store, now: () => nowMs, baselineSaveIntervalMs: 5_000, report: (line) => lines.push(line) });

		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);
		expect(lines).toEqual(["[substrate] planning observer: baseline save failed: write-failed: EIO; it is retried"]);

		nowMs += 1_000;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(1);

		nowMs += 4_000;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(2);
		expect(lines).toHaveLength(1);

		store.failSaves = false;
		nowMs += 5_000;
		await observer.scan();
		await observer.idle();
		expect(store.attempts).toBe(3);
		expect(store.files.has(KEY)).toBe(true);
		expect(lines).toEqual(["[substrate] planning observer: baseline save failed: write-failed: EIO; it is retried", "[substrate] planning observer: baseline saves succeed again"]);
	});

	test("a bad baseline file is replaced by the first save after it is reported", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const store = new MemoryBaselines();
		store.loads = { state: "unusable", reason: "not-json", detail: null };
		const observer = liveObserver(tree, [], { baselines: store, report: () => undefined });
		await observer.scan();
		await observer.idle();
		expect(store.saves).toBe(1);
		expect(store.files.get(KEY)?.root).toBe(TREE_ROOT);
	});

	test("10,000 simulated scans retain no growing history: what the observer holds is the same after 1,000 scans and after 10,000", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n", [`${PHASE}/52-PLAN.md`]: "# plan\n" });
		const backend = new RecordingPresenceBackend();
		const store = new MemoryBaselines();
		const observer = liveObserver(tree, [], {
			presence: new DragonflyPresenceStore(backend),
			liveness: { intervalMs: 0 },
			baselines: store,
			baselineSaveIntervalMs: 0,
		});
		let early = 0;
		// 10,025 scans, so the last one falls 25 scans after a change, as the early measurement does.
		for (let scan = 1; scan <= 10_025; scan++) {
			backend.clockMs += 15_000;
			// A change every 50 scans (12.5 minutes), so touched pairs and saves keep happening and expiring.
			if (scan % 50 === 0) tree.setContent(`${PHASE}/52-CONTEXT.md`, scan % 100 === 0 ? "# context\n" : "# context, edited\n");
			await observer.scan();
			if (scan === 1_025) early = retainedNodes(observer);
		}
		await observer.idle();
		const late = retainedNodes(observer);
		expect(early).toBeGreaterThan(0);
		// Both counts are taken 25 scans after a change. A little slack covers a pair that is inside the window in one and not the other; a history would add thousands.
		expect(Math.abs(late - early)).toBeLessThanOrEqual(16);
		expect(store.attempts).toBeLessThan(400);
	}, 180_000);
});
