/**
 * The planning reads over a real temp checkout and a fake presence backend. Covered: `planning_status` reports counts,
 * hashes and error records without any file body; an unset or invalid root answers typed results; `planning_sessions`
 * lists stale sessions, classifies against the server clock, and marks them unknown when that clock is unreadable; a
 * change between two reads is written as one `planning.changed` note, and a first read emits nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventInput } from "../types.ts";
import { PLANNING_MAX_FILES_ENV, PLANNING_ROOT_ENV, loadPlanningSettings } from "./config.ts";
import { nodePlanningFs } from "./fs.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, PRESENCE_MAX_SESSIONS, type PresenceBackend } from "./presence-dragonfly.ts";
import { PLANNING_OBSERVER_SESSION, PLANNING_TRANSITION_PHASE, PlanningReader, type PlanningSessionsView, repoFromGitConfig } from "./read.ts";
import type { SessionRecord } from "./presence.ts";
import { SESSION_STATES } from "./states.ts";
import { stdoutMetricSink, type MetricSink, type SinkResult, type TransitionRecord } from "./telemetry.ts";

const BODY = "BODY-SECRET-TEXT";
const FRONTMATTER_SECRET = "FM-SECRET-VALUE";
const PHASE = ".planning/phases/52-planning-awareness-core";
const REPO = "swcstudiospace/agent-substrate";

let dir: string;
let root: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "planning-read-"));
	root = join(dir, "checkout");
	await mkdir(join(root, PHASE), { recursive: true });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function settingsFor(path: string) {
	return loadPlanningSettings({ [PLANNING_ROOT_ENV]: path });
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function write(relative: string, text: string): Promise<void> {
	const path = join(root, relative);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

/** Two good phase documents and one with an unclosed frontmatter fence. Each carries a body and a frontmatter secret. */
async function seedPhase(): Promise<void> {
	await write(`${PHASE}/52-PLAN.md`, `---\nphase: "52"\nnote: ${FRONTMATTER_SECRET}\n---\n${BODY} plan\n`);
	await write(`${PHASE}/52-CONTEXT.md`, `${BODY} context\n`);
	await write(`${PHASE}/BAD.md`, `---\nphase: [unclosed\n${BODY} bad\n`);
}

function emitRecorder(result = true) {
	const events: EventInput[] = [];
	return {
		events,
		emit: async (event: EventInput) => {
			events.push(event);
			return result;
		},
	};
}

function reader(path: string, options: { presence?: DragonflyPresenceStore | null; emit?: (event: EventInput) => Promise<boolean> } = {}) {
	const recorder = emitRecorder();
	const metrics = recordingSink("greptime");
	const fallback = recordingSink("stdout");
	return {
		events: recorder.events,
		transitions: metrics.records,
		fallbacks: fallback.records,
		reader: new PlanningReader({
			settings: settingsFor(path),
			fs: nodePlanningFs(),
			presence: options.presence === undefined ? null : options.presence,
			emit: options.emit ?? recorder.emit,
			metrics: metrics.sink,
			fallback: fallback.sink,
			clock: CLOCK,
		}),
	};
}

describe("planning_status", () => {
	test("counts, hashes and the error record are reported, and no file body or frontmatter value is", async () => {
		await seedPhase();
		const view = await reader(root).reader.status();
		expect(view.state).toBe("ok");
		if (view.state !== "ok") return;
		expect(view.counts).toEqual({ documents: 2, errors: 1, byKind: { phase: 2 } });
		expect(view.truncated).toBe(false);
		const plan = view.documents.find((row) => row.path === `${PHASE}/52-PLAN.md`);
		expect(plan).toMatchObject({ kind: "phase", phase: "52", plan: "52-PLAN", sha256: sha256(await Bun.file(join(root, PHASE, "52-PLAN.md")).text()) });
		expect(view.errors).toEqual([
			expect.objectContaining({ path: `${PHASE}/BAD.md`, code: "malformed-frontmatter", sha256: expect.any(String) }),
		]);
		const serialised = JSON.stringify(view);
		expect(serialised).not.toContain(BODY);
		expect(serialised).not.toContain(FRONTMATTER_SECRET);
	});

	test("an absent root answers disabled, never an error", async () => {
		const view = await new PlanningReader({ settings: loadPlanningSettings({}), fs: nodePlanningFs(), presence: null, emit: async () => true, ...quietSinks() }).status();
		expect(view).toEqual({ state: "disabled", reason: "root-unset" });
	});

	test("a relative root answers misconfigured, naming the key and not the value", async () => {
		const view = await new PlanningReader({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: "relative/checkout" }),
			fs: nodePlanningFs(),
			presence: null,
			emit: async () => true,
			...quietSinks(),
		}).status();
		expect(view).toEqual({ state: "misconfigured", errors: [{ key: PLANNING_ROOT_ENV, reason: "not-absolute" }] });
	});

	test("a root that does not exist answers unavailable with the failure code", async () => {
		const view = await reader(join(dir, "missing")).reader.status();
		expect(view).toEqual({ state: "unavailable", code: "root-unavailable" });
	});

	test("the first read is a baseline, an unchanged read emits nothing, and a changed read emits one planning.changed note", async () => {
		await seedPhase();
		await write(".git/config", '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n');
		const harness = reader(root);

		const first = await harness.reader.status();
		expect(first.state === "ok" && first.changes).toEqual({ state: "baseline" });

		const second = await harness.reader.status();
		expect(second.state === "ok" && second.changes).toEqual({ state: "unchanged" });
		expect(harness.events).toEqual([]);

		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const third = await harness.reader.status();
		expect(third.state === "ok" && third.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(harness.events).toHaveLength(1);
		const [event] = harness.events;
		expect(event).toMatchObject({
			surface: "substrate",
			kind: "note",
			repo: REPO,
			session_id: PLANNING_OBSERVER_SESSION,
			payload: { kind: "planning.changed", repo: REPO, changed: [`${PHASE}/52-CONTEXT.md`], added: [], removed: [] },
		});
		expect(JSON.stringify(event)).not.toContain(BODY);
	});

	test("a change in a checkout with no origin remote is reported as repo-unknown and emits nothing", async () => {
		await seedPhase();
		const harness = reader(root);
		await harness.reader.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "repo-unknown" });
		expect(harness.events).toEqual([]);
	});

	test("a ledger that does not store the event is reported as not-stored, not as emitted", async () => {
		await seedPhase();
		await write(".git/config", '[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate\n');
		const harness = reader(root, { emit: async () => false });
		await harness.reader.status();
		await write(`${PHASE}/52-PLAN.md`, "changed\n");
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "not-stored" });
	});
});

describe("planning_status on a truncated index", () => {
	/** A reader whose index keeps two documents of the three seeded, so the third (BAD.md, last by path) is past the cutoff. */
	function truncatingReader(events: EventInput[]) {
		return new PlanningReader({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: root, [PLANNING_MAX_FILES_ENV]: "2" }),
			fs: nodePlanningFs(),
			presence: null,
			...quietSinks(),
			emit: async (event) => {
				events.push(event);
				return true;
			},
		});
	}

	test("a change to a kept document is reported as partial, writes no ledger note, and reports no removal", async () => {
		await seedPhase();
		await write(".git/config", '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n');
		const events: EventInput[] = [];
		const reader = truncatingReader(events);

		const baseline = await reader.status();
		expect(baseline.state === "ok" && baseline.truncated).toBe(true);
		expect(baseline.state === "ok" && baseline.changes).toEqual({ state: "baseline" });

		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const partial = await reader.status();
		expect(partial.state === "ok" && partial.changes).toEqual({ state: "partial", added: null, removed: null, changed: 1, ledger: "not-written" });
		expect(events).toEqual([]);
	});

	test("a document past the cutoff that disappears is not reported as a removal", async () => {
		await seedPhase();
		await write(".git/config", '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n');
		const events: EventInput[] = [];
		const reader = truncatingReader(events);

		await reader.status();
		await rm(join(root, PHASE, "BAD.md"));
		const after = await reader.status();
		// The index is complete now, but the previous one was not: the diff is still partial, so nothing is removed or written.
		expect(after.state === "ok" && after.truncated).toBe(false);
		expect(after.state === "ok" && after.changes).toEqual({ state: "partial", added: null, removed: null, changed: 0, ledger: "not-written" });
		expect(events).toEqual([]);
	});
});

describe("repoFromGitConfig", () => {
	test("reads owner and name from ssh, https and https-with-.git origin URLs", () => {
		expect(repoFromGitConfig('[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n')).toBe(REPO);
		expect(repoFromGitConfig('[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate\n')).toBe(REPO);
		expect(repoFromGitConfig('[remote "origin"]\n\turl = ssh://git@host/swcstudiospace/agent-substrate.git/\n')).toBe(REPO);
	});

	test("only the origin remote counts, and a config with none gives null", () => {
		const text = '[remote "upstream"]\n\turl = https://github.com/other/fork.git\n[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate.git\n';
		expect(repoFromGitConfig(text)).toBe(REPO);
		expect(repoFromGitConfig('[remote "upstream"]\n\turl = https://github.com/other/fork.git\n')).toBeNull();
		expect(repoFromGitConfig("")).toBeNull();
	});
});

/** A fake backend with a settable server clock, which tests age a heartbeat with. */
class PresenceFake implements PresenceBackend {
	readonly values = new Map<string, string>();
	serverNow = 1_000_000;
	clockFails = false;

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async setWithTtl(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	async scanPrefix(prefix: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
		const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
		return { keys: keys.slice(0, limit), truncated: keys.length > limit };
	}

	async serverTimeMs(): Promise<number> {
		if (this.clockFails) throw new Error("TIME refused");
		return this.serverNow;
	}
}

function session(sessionId: string): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: `gsd/${sessionId}`, activePhase: "52", lastHeartbeatMs: 0 };
}

function sessionsReader(presence: DragonflyPresenceStore | null, path = root) {
	return new PlanningReader({ settings: settingsFor(path), fs: nodePlanningFs(), presence, emit: async () => true, ...quietSinks() });
}

describe("planning_sessions", () => {
	test("a session past its freshness window is listed as stale with its age, and a fresh one as active", async () => {
		const backend = new PresenceFake();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("drifted"), 90_000);
		backend.serverNow += 120_000;
		await store.touch(session("fresh"), 90_000);
		const view = await sessionsReader(store).sessions();
		expect(view).toMatchObject({ state: "ok", presenceTtlS: 90, clock: { state: "server" }, truncated: false });
		expect(view).toMatchObject({ view: { state: "STALE" } });
		if (view.state !== "ok") return;
		expect(view.sessions.map((row) => [row.sessionId, row.status, row.ageMs])).toEqual([
			["drifted", "stale", 120_000],
			["fresh", "active", 0],
		]);
	});

	test("when the server clock cannot be read, sessions are listed as unknown and the reason is given", async () => {
		const backend = new PresenceFake();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("alpha"), 90_000);
		backend.clockFails = true;
		const view = await sessionsReader(store).sessions();
		expect(view.state === "ok" && view.clock.state).toBe("unavailable");
		expect(view).toMatchObject({ view: { state: "DEGRADED" } });
		if (view.state !== "ok") return;
		expect(view.clock.state === "unavailable" && view.clock.detail).toBe("TIME refused");
		expect(view.sessions).toEqual([expect.objectContaining({ sessionId: "alpha", status: "unknown", ageMs: null })]);
	});

	test("a listing past the bound says it was truncated and holds exactly the bound", async () => {
		const backend = new PresenceFake();
		const store = new DragonflyPresenceStore(backend);
		for (let i = 0; i <= PRESENCE_MAX_SESSIONS; i++) await store.touch(session(`w${i}`), 90_000);
		const view = await sessionsReader(store).sessions();
		expect(view.state === "ok" && view.truncated).toBe(true);
		expect(view.state === "ok" && view.sessions).toHaveLength(PRESENCE_MAX_SESSIONS);
	});

	test("a corrupt stored session fails the listing as unavailable, naming the key and not the value", async () => {
		const backend = new PresenceFake();
		backend.values.set(`${PRESENCE_KEY_PREFIX}corrupt`, '{"sessionId":"corrupt","secret":"SHOULD-NOT-APPEAR"}');
		const view = await sessionsReader(new DragonflyPresenceStore(backend)).sessions();
		expect(view.state).toBe("unavailable");
		expect(JSON.stringify(view)).toContain(`${PRESENCE_KEY_PREFIX}corrupt`);
		expect(JSON.stringify(view)).not.toContain("SHOULD-NOT-APPEAR");
	});

	test("no Dragonfly endpoint answers unavailable with presence-backend-unset", async () => {
		expect(await sessionsReader(null).sessions()).toMatchObject({ state: "unavailable", code: "presence-backend-unset", view: { state: "DEGRADED" } });
	});

	test("an absent root answers disabled, never an error", async () => {
		const view = await new PlanningReader({ settings: loadPlanningSettings({}), fs: nodePlanningFs(), presence: null, emit: async () => true, ...quietSinks() }).sessions();
		expect(view).toMatchObject({ state: "disabled", reason: "root-unset", view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});
});

describe("planning.transition", () => {
	const ORIGIN = '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n';

	test("a detected change writes one transition record, and an unchanged read writes none", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const harness = reader(root);
		await harness.reader.status();
		await harness.reader.status();
		expect(harness.transitions).toEqual([]);

		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await harness.reader.status();
		expect(harness.transitions).toEqual([
			{ phaseId: PLANNING_TRANSITION_PHASE, from: "DEGRADED", to: "DEGRADED", outcome: "applied", ts: "2026-10-22T12:00:00.000Z" },
		]);
		expect(harness.fallbacks).toEqual([]);
	});

	test("a change that clears the view's degradation records the move from DEGRADED to SUCCESS", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const harness = reader(root);
		await harness.reader.status();
		await rm(join(root, PHASE, "BAD.md"));
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.counts.errors).toBe(0);
		expect(harness.transitions).toEqual([expect.objectContaining({ from: "DEGRADED", to: "SUCCESS", outcome: "applied" })]);
	});

	test("a change the ledger does not store is recorded as refused", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const harness = reader(root, { emit: async () => false });
		await harness.reader.status();
		await write(`${PHASE}/52-PLAN.md`, "changed\n");
		await harness.reader.status();
		expect(harness.transitions).toEqual([expect.objectContaining({ outcome: "refused" })]);
	});

	test("a failing primary sink falls back once, to stdout, and the primary is called once", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const primary = recordingSink("greptime", { ok: false, reason: "refused", detail: "rows dropped: invalid=1" });
		const lines: string[] = [];
		const planning = new PlanningReader({
			settings: settingsFor(root),
			fs: nodePlanningFs(),
			presence: null,
			emit: async () => true,
			metrics: primary.sink,
			fallback: stdoutMetricSink((line) => lines.push(line)),
			clock: CLOCK,
		});
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await planning.status();
		expect(primary.records).toHaveLength(1);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({ metric: "planning.transition", phaseId: "planning", from: "DEGRADED", to: "DEGRADED", outcome: "applied", ts: "2026-10-22T12:00:00.000Z" });
	});
});

describe("planning_sessions state", () => {
	test("an empty root has the EMPTY state", async () => {
		const view = await sessionsReader(new DragonflyPresenceStore(new PresenceFake())).sessions();
		expect(view).toMatchObject({ state: "ok", sessions: [], view: { state: "EMPTY" } });
		expectNonBlankState(view);
	});

	test("a root with a stale session has the STALE state", async () => {
		const backend = new PresenceFake();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("drifted"), 90_000);
		backend.serverNow += 120_000;
		const view = await sessionsReader(store).sessions();
		expect(view).toMatchObject({ state: "ok", view: { state: "STALE" } });
		expectNonBlankState(view);
	});

	test("a disabled root has the DEGRADED state, not a blank one", async () => {
		const view = await new PlanningReader({ settings: loadPlanningSettings({}), fs: nodePlanningFs(), presence: null, emit: async () => true, ...quietSinks() }).sessions();
		expect(view).toMatchObject({ state: "disabled", view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});
});

const CLOCK = (): Date => new Date("2026-10-22T12:00:00.000Z");

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

/** Sinks for the reads that do not look at a transition. Nothing reaches stdout. */
function quietSinks() {
	return { metrics: recordingSink("greptime").sink, fallback: recordingSink("stdout").sink, clock: CLOCK };
}

/** Every session view names one of the six states, with a line that is never blank. */
function expectNonBlankState(view: PlanningSessionsView): void {
	expect(SESSION_STATES).toContain(view.view.state);
	expect(view.view.text.trim()).not.toBe("");
}
