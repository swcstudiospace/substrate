/**
 * The planning observer (phase 52, SOTA-08): the only writer of the planning plane. A scan publishes a complete change once,
 * with the sha256 before and after for each path, and heartbeats the checkout it saw change. A scan that sees no change
 * writes nothing. Each test runs on an in-memory tree and a recording presence backend.
 *
 * Phase 54: each scan that moves the plane's view from one session state to another records one `planning.transition`
 * through the metric sink, with the stdout line as its fallback. The transition tests live here, with the scan that detects them.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EventInput } from "../types.ts";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { PLANNING_MAX_FILES_ENV, PLANNING_ROOT_ENV, PLANNING_SCAN_INTERVAL_ENV, loadPlanningSettings } from "./config.ts";
import { MAX_PENDING_TRANSITIONS, PLANNING_OBSERVER_SESSION, PLANNING_TRANSITION_PHASE, PlanningObserver } from "./observer.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX } from "./presence-dragonfly.ts";
import { PlanningReader } from "./read.ts";
import { stdoutMetricSink, type MetricSink, type SinkResult, type TransitionRecord } from "./telemetry.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const PHASE = `${TREE_ROOT}/.planning/phases/52-planning-awareness-core`;
const CONTEXT = ".planning/phases/52-planning-awareness-core/52-CONTEXT.md";
const REPO = "swcstudiospace/agent-substrate";
const BRANCH = "gsd/p52-wiring";
const ORIGIN = '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n';
const GIT: Record<string, string> = {
	[`${TREE_ROOT}/.git/config`]: `[remote "origin"]\n\turl = git@github.com:${REPO}.git\n`,
	[`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n`,
};
const BODY = "BODY-SECRET-TEXT";
const FRONTMATTER_SECRET = "FM-SECRET-VALUE";
const CLOCK = (): Date => new Date("2026-10-22T12:00:00.000Z");

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Two good phase documents and one with an unclosed frontmatter fence, over the given git files. */
function seededTree(git: Record<string, string> = GIT): FakeTree {
	return new FakeTree({
		...git,
		[`${PHASE}/52-PLAN.md`]: `---\nphase: "52"\nnote: ${FRONTMATTER_SECRET}\n---\n${BODY} plan\n`,
		[`${PHASE}/52-CONTEXT.md`]: `${BODY} context\n`,
		[`${PHASE}/BAD.md`]: `---\nphase: [unclosed\n${BODY} bad\n`,
	});
}

/** A sink that keeps each record it is given and answers `result`. */
function recordingSink(name: string, result: SinkResult = { ok: true }) {
	const records: TransitionRecord[] = [];
	const sink: MetricSink = {
		name,
		emit: async (record) => {
			records.push(record);
			return result;
		},
	};
	return { sink, records };
}

function observerOver(
	tree: FakeTree,
	options: { presence?: DragonflyPresenceStore | null; accept?: () => boolean; env?: Record<string, string>; metrics?: MetricSink; fallback?: MetricSink } = {},
): { observer: PlanningObserver; events: EventInput[]; transitions: TransitionRecord[]; fallbacks: TransitionRecord[] } {
	const events: EventInput[] = [];
	const metrics = recordingSink("greptime");
	const fallback = recordingSink("stdout");
	const observer = new PlanningObserver({
		settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, ...options.env }),
		fs: tree,
		presence: options.presence ?? null,
		emit: async (event) => {
			const stored = options.accept ? options.accept() : true;
			if (stored) events.push(event);
			return stored;
		},
		metrics: options.metrics ?? metrics.sink,
		fallback: options.fallback ?? fallback.sink,
		clock: CLOCK,
	});
	return { observer, events, transitions: metrics.records, fallbacks: fallback.records };
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

	test("the first read is a baseline, an unchanged read emits nothing, and a changed read emits one planning.changed note", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, events } = observerOver(tree);

		expect(await observer.scan()).toMatchObject({ outcome: "baseline" });
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
		expect(events).toEqual([]);

		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event).toMatchObject({
			surface: "substrate",
			kind: "note",
			repo: REPO,
			session_id: PLANNING_OBSERVER_SESSION,
			payload: {
				kind: "planning.changed",
				repo: REPO,
				added: [],
				removed: [],
				changed: [{ path: CONTEXT, before: sha256(`${BODY} context\n`), after: sha256(`${BODY} edited\n`) }],
			},
		});
		expect(JSON.stringify(event)).not.toContain(BODY);
	});

	test("a change in a checkout with no git data is reported as repo-unknown and emits nothing", async () => {
		const tree = seededTree({});
		const { observer, events } = observerOver(tree);
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "repo-unknown" });
		expect(events).toEqual([]);
	});

	test("a ledger that does not store the event is reported as not-stored, not as emitted", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, events } = observerOver(tree, { accept: () => false });
		await observer.scan();
		tree.setContent(`${PHASE}/52-PLAN.md`, "changed\n");
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "not-published" });
		expect(events).toEqual([]);
	});
});

describe("the observer on a truncated index", () => {
	/** An observer whose index keeps two documents of the three seeded, so the third (BAD.md, last by path) is past the cutoff. */
	function truncatingObserver(tree: FakeTree) {
		return observerOver(tree, { env: { [PLANNING_MAX_FILES_ENV]: "2" } });
	}

	test("a change to a kept document is reported as partial, writes no ledger note, and reports no removal", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, events } = truncatingObserver(tree);

		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "baseline" });
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "incomplete" });
		expect(events).toEqual([]);
	});

	test("a document past the cutoff that disappears is not reported as a removal", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, events } = truncatingObserver(tree);

		await observer.scan();
		tree.remove(`${PHASE}/BAD.md`);
		// The index is complete now, but the previous one was not: the diff is still partial, so nothing is removed or written.
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "incomplete" });
		expect(events).toEqual([]);
	});
});

describe("planning.transition", () => {
	test("a detected change writes one transition record, and an unchanged read writes none", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, transitions, fallbacks } = observerOver(tree);
		await observer.scan();
		await observer.scan();
		await observer.settleTransitions();
		expect(transitions).toEqual([]);

		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await observer.scan();
		await observer.settleTransitions();
		expect(transitions).toEqual([{ phaseId: PLANNING_TRANSITION_PHASE, from: "DEGRADED", to: "DEGRADED", outcome: "applied", ts: "2026-10-22T12:00:00.000Z" }]);
		expect(fallbacks).toEqual([]);
	});

	test("a change that clears the view's degradation records the move from DEGRADED to SUCCESS", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, transitions } = observerOver(tree);
		await observer.scan();
		tree.remove(`${PHASE}/BAD.md`);
		await observer.scan();
		await observer.settleTransitions();
		expect(transitions).toEqual([expect.objectContaining({ from: "DEGRADED", to: "SUCCESS", outcome: "applied" })]);
	});

	test("a change the ledger does not store is held, and its transition is recorded once, on first detection", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		let accept = false;
		const { observer, transitions } = observerOver(tree, { accept: () => accept });
		await observer.scan();
		tree.setContent(`${PHASE}/52-PLAN.md`, "changed\n");
		expect(await observer.scan()).toMatchObject({ outcome: "not-published" });
		await observer.settleTransitions();
		expect(transitions).toEqual([expect.objectContaining({ outcome: "refused" })]);

		accept = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		await observer.settleTransitions();
		expect(transitions).toEqual([expect.objectContaining({ outcome: "refused" })]);
	});

	test("a failing primary sink falls back once, to stdout, and the primary is called once", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const primary = recordingSink("greptime", { ok: false, reason: "refused", detail: "rows dropped: invalid=1" });
		const lines: string[] = [];
		const { observer } = observerOver(tree, { metrics: primary.sink, fallback: stdoutMetricSink((line) => lines.push(line)) });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await observer.scan();
		await observer.settleTransitions();
		expect(primary.records).toHaveLength(1);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({ metric: "planning.transition", phaseId: "planning", from: "DEGRADED", to: "DEGRADED", outcome: "applied", ts: "2026-10-22T12:00:00.000Z" });
	});
});

describe("planning.transition delivery", () => {
	test("a metric write that never resolves does not hold up the planning_status reply", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const stalled: MetricSink = { name: "greptime", emit: () => new Promise<SinkResult>(() => {}) };
		const { observer } = observerOver(tree, { metrics: stalled });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		// The scan is awaited directly: a reply held up by the stalled write would never resolve, and the test would time out.
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published" });
	});

	test("a config read that throws holds the transition, and the next readable read records it exactly once", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const metrics = recordingSink("greptime");
		const { observer } = observerOver(tree, { metrics: metrics.sink });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		tree.denied.add(`${TREE_ROOT}/.git/config`);
		const failed = await observer.scan();
		tree.denied.delete(`${TREE_ROOT}/.git/config`);
		expect(failed).toMatchObject({ state: "observed", outcome: "repo-unknown" });
		await observer.settleTransitions();
		expect(metrics.records).toEqual([]);

		const recovered = await observer.scan();
		await observer.settleTransitions();
		expect(recovered).toMatchObject({ state: "observed", outcome: "published" });
		const after = await observer.scan();
		await observer.settleTransitions();
		expect(after).toMatchObject({ state: "observed", outcome: "unchanged" });
		expect(metrics.records).toEqual([expect.objectContaining({ phaseId: PLANNING_TRANSITION_PHASE, outcome: "applied" })]);
	});

	test("a delivery that completes before the shutdown bound finishes before shutdown resolves", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const delivered: TransitionRecord[] = [];
		const release = Promise.withResolvers<void>();
		const gated: MetricSink = {
			name: "greptime",
			emit: async (record) => {
				await release.promise;
				delivered.push(record);
				return { ok: true };
			},
		};
		const { observer } = observerOver(tree, { metrics: gated });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await observer.scan();
		const bound = Promise.withResolvers<void>();
		const shutdown = observer.settleTransitions(bound.promise);
		release.resolve();
		expect(await shutdown).toBe("settled");
		expect(delivered).toHaveLength(1);
	});

	test("a delivery still pending when the shutdown bound passes does not hold shutdown past it", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const stalled: MetricSink = { name: "greptime", emit: () => Promise.withResolvers<SinkResult>().promise };
		const { observer } = observerOver(tree, { metrics: stalled });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await observer.scan();
		const bound = Promise.withResolvers<void>();
		const shutdown = observer.settleTransitions(bound.promise);
		bound.resolve();
		expect(await shutdown).toBe("deadline");
	});

	test("past the bound a record goes to the fallback, and the primary never holds more deliveries than the bound", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const primaryCalls: TransitionRecord[] = [];
		const stalled: MetricSink = {
			name: "greptime",
			emit: (record) => {
				primaryCalls.push(record);
				return Promise.withResolvers<SinkResult>().promise;
			},
		};
		const fallback = recordingSink("stdout");
		const { observer } = observerOver(tree, { metrics: stalled, fallback: fallback.sink });
		await observer.scan();
		for (let i = 0; i <= MAX_PENDING_TRANSITIONS; i++) {
			tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edit ${i}\n`);
			await observer.scan();
		}
		expect(primaryCalls).toHaveLength(MAX_PENDING_TRANSITIONS);
		expect(fallback.records).toHaveLength(1);
	}, 60_000);
});

describe("the planning heartbeat", () => {
	test("a session whose change the observer saw appears in planning_sessions afterwards", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n` });
		const backend = new RecordingPresenceBackend();
		const presence = new DragonflyPresenceStore(backend);
		const { observer } = observerOver(tree, { presence });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "written" } });

		const stored = await presence.listWithin(10);
		expect(stored.records.map((record) => [record.worktree, record.branch, record.activePhase])).toEqual([[TREE_ROOT, BRANCH, null]]);

		const reader = new PlanningReader({ settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }), fs: tree, presence });
		const sessions = await reader.sessions();
		expect(sessions.state === "ok" && sessions.sessions).toEqual([
			expect.objectContaining({ sessionId: expect.stringMatching(/^wt-[0-9a-f]{24}$/), worktree: TREE_ROOT, status: "active", ageMs: 0 }),
		]);
	});

	test("a checkout with no git entry records a failed heartbeat, and the scan still returns its summary", async () => {
		const tree = seededTree({});
		const backend = new RecordingPresenceBackend();
		const { observer } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "repo-unknown", heartbeat: { state: "failed", detail: "no-git-entry" } });
		expect(backend.writes).toEqual([]);
	});

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

	test("a checkout whose presence write fails records a failed heartbeat, and its change is still published", async () => {
		class FailingWrites extends RecordingPresenceBackend {
			async setWithTtl(): Promise<void> {
				throw new Error("SET refused");
			}
		}
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n` });
		const { observer, events } = observerOver(tree, { presence: new DragonflyPresenceStore(new FailingWrites()) });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published", heartbeat: { state: "failed" } });
		expect(events).toHaveLength(1);
	});

	test("the observer's timer is refused while the plane is disabled, and runs only between start and stop", () => {
		const disabled = new PlanningObserver({
			settings: loadPlanningSettings({}),
			fs: new FakeTree({}),
			presence: null,
			emit: async () => true,
			metrics: recordingSink("greptime").sink,
		});
		expect(disabled.start()).toBe(false);

		const { observer } = observerOver(new FakeTree({}));
		expect(observer.start()).toBe(true);
		expect(observer.start()).toBe(true);
		observer.stop();
		expect(observer.start()).toBe(true);
		observer.stop();
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
				metrics: recordingSink("greptime").sink,
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

		const disabled = new PlanningObserver({ settings: loadPlanningSettings({}), fs: new FakeTree({}), presence: null, emit: async () => true, metrics: recordingSink("greptime").sink });
		expect(disabled.start()).toBe(false);
	});
});

describe("the planning baseline", () => {
	test("a slow scan that finishes after a newer one does not move the baseline back", async () => {
		const { promise: atGate, resolve: reached } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let gated = false;
		// The first read of the document returns its old bytes, then waits. Scans run one at a time, so the newer scan queues
		// behind it: it cannot finish first, and the baseline only ever moves forward.
		class SlowTree extends FakeTree {
			override async openRead(path: string, limit: number, accept: (real: string) => boolean, reuse: (signature: string) => boolean) {
				const opened = await super.openRead(path, limit, accept, reuse);
				if (!gated && path.endsWith("52-CONTEXT.md")) {
					gated = true;
					reached();
					await gate;
				}
				return opened;
			}
		}
		const tree = new SlowTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: `${BODY} one\n` });
		const { observer, events } = observerOver(tree);

		const slow = observer.scan();
		await atGate;
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} two\n`);
		const fresh = observer.scan();
		let freshDone = false;
		void fresh.then(() => {
			freshDone = true;
		});
		await Promise.resolve();
		expect(freshDone).toBe(false);

		release();
		expect(await slow).toMatchObject({ outcome: "baseline" });
		expect(await fresh).toMatchObject({ outcome: "published" });
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});
});

describe("the origin of a checkout", () => {
	test("a .git file names a git directory whose config holds the origin", async () => {
		const tree = seededTree({
			[`${TREE_ROOT}/.git`]: "gitdir: /git-admin\n",
			"/git-admin/config": ORIGIN,
		});
		const { observer, events } = observerOver(tree);
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(events.map((event) => event.repo)).toEqual([REPO]);
	});

	test("a linked worktree's git directory reads the shared config from its commondir", async () => {
		const tree = seededTree({
			[`${TREE_ROOT}/.git`]: "gitdir: /common-git/worktrees/wt\n",
			"/common-git/config": ORIGIN,
			"/common-git/worktrees/wt/commondir": "../..\n",
			"/common-git/worktrees/wt/HEAD": `ref: refs/heads/${BRANCH}\n`,
		});
		const { observer, events } = observerOver(tree);
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(events.map((event) => event.repo)).toEqual([REPO]);
	});

	test("an unreadable .git/config still returns the document summary, and the transition is published once it is readable", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, events } = observerOver(tree);
		await observer.scan();

		tree.denied.add(`${TREE_ROOT}/.git/config`);
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "repo-unknown" });
		expect(events).toEqual([]);

		tree.denied.delete(`${TREE_ROOT}/.git/config`);
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(events.map((event) => event.repo)).toEqual([REPO]);

		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});
});

describe("a planning change whose publish fails", () => {
	test("is re-sent by the next read, and stored exactly once after the publish succeeds", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		let accept = false;
		const { observer, events } = observerOver(tree, { accept: () => accept });
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "not-published" });
		expect(events).toEqual([]);

		accept = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(events).toHaveLength(1);

		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});
});

describe("a failed publish holds the baseline through the reader", () => {
	test("two failed publishes hold the baseline, and the next read publishes the change exactly once", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		let failures = 2;
		const { observer, events } = observerOver(tree, {
			accept: () => {
				if (failures > 0) {
					failures--;
					return false;
				}
				return true;
			},
		});
		await observer.scan();

		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "not-published" });
		expect(await observer.scan()).toMatchObject({ outcome: "not-published" });
		expect(events).toEqual([]);

		expect(await observer.scan()).toMatchObject({ outcome: "published" });
		expect(events).toHaveLength(1);
		expect(await observer.scan()).toMatchObject({ outcome: "unchanged" });
		expect(events).toHaveLength(1);
	});
});

describe("held, incomplete and failed-heartbeat states are reported", () => {
	test("a file added and then edited while the ledger is down records one refused transition for each distinct change", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		const { observer, transitions } = observerOver(tree, { accept: () => false });
		await observer.scan();
		tree.setContent(`${PHASE}/52-NOTES.md`, "first\n");
		await observer.scan();
		await observer.settleTransitions();
		tree.setContent(`${PHASE}/52-NOTES.md`, "second\n");
		await observer.scan();
		await observer.settleTransitions();
		expect(transitions).toEqual([expect.objectContaining({ outcome: "refused" }), expect.objectContaining({ outcome: "refused" })]);
	});

	test("an unlistable directory with an edit in a readable directory records that edit as an incomplete refused transition", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/config`]: ORIGIN });
		tree.setContent(`${TREE_ROOT}/.planning/phases/53-locked/53-PLAN.md`, `${BODY} locked\n`);
		tree.deniedListings.add(`${TREE_ROOT}/.planning/phases/53-locked`);
		const { observer, events, transitions } = observerOver(tree);
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ outcome: "incomplete" });
		await observer.settleTransitions();
		expect(events).toEqual([]);
		expect(transitions).toEqual([expect.objectContaining({ outcome: "refused", incomplete: true })]);
	});

	test("an unreadable .git/HEAD on an observed change is a failed heartbeat, and the change is still published", async () => {
		const tree = seededTree({ ...GIT, [`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n` });
		tree.denied.add(`${TREE_ROOT}/.git/HEAD`);
		const { observer, events } = observerOver(tree, { presence: new DragonflyPresenceStore(new RecordingPresenceBackend()) });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toMatchObject({ state: "observed", outcome: "published", heartbeat: { state: "failed" } });
		expect(events).toHaveLength(1);
	});

	test("a missing git entry is a definitive absence: the change is not published, and the heartbeat names it", async () => {
		const tree = seededTree({});
		const backend = new RecordingPresenceBackend();
		const { observer, events } = observerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		expect(await observer.scan()).toEqual({ state: "observed", outcome: "repo-unknown", heartbeat: { state: "failed", detail: "no-git-entry" } });
		expect(events).toEqual([]);
		expect(backend.writes).toEqual([]);
	});
});
