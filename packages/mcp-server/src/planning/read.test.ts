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
import type { PlanningFs } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, PRESENCE_MAX_SESSIONS, type PresenceBackend } from "./presence-dragonfly.ts";
import { dragonflyPresenceBackend, type PresenceRedisClient } from "./presence-client.ts";
import { MAX_PENDING_TRANSITIONS, PLANNING_OBSERVER_SESSION, PLANNING_TRANSITION_PHASE, PlanningReader, type PlanningSessionsView, repoFromGitConfig } from "./read.ts";
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

	test("a change in a checkout with no git data is reported as repo-unknown and emits nothing", async () => {
		await seedPhase();
		const harness = reader(root);
		await harness.reader.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "repo-unknown", repoReason: "no-git-entry" });
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

	test("quoted and unquoted origin URLs give the same repo identity", () => {
		const unquotedUrl = '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n';
		const doubleQuoted = '[remote "origin"]\n\turl = "https://github.com/acme/repo.git"\n';
		const singleQuoted = "[remote \"origin\"]\n\turl = 'git@github.com:acme/repo.git'\n";
		expect(repoFromGitConfig(unquotedUrl)).toBe("acme/repo");
		expect(repoFromGitConfig(doubleQuoted)).toBe("acme/repo");
		expect(repoFromGitConfig(singleQuoted)).toBe("acme/repo");
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

	test("a change the ledger does not store is held, and its transition is recorded once, on first detection", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		let accept = false;
		const harness = reader(root, { emit: async () => accept });
		await harness.reader.status();
		await write(`${PHASE}/52-PLAN.md`, "changed\n");
		const held = await harness.reader.status();
		await harness.reader.settleTransitions();
		expect(held.state === "ok" && held.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "not-stored" });
		expect(harness.transitions).toEqual([expect.objectContaining({ outcome: "refused" })]);

		accept = true;
		const retried = await harness.reader.status();
		await harness.reader.settleTransitions();
		expect(retried.state === "ok" && retried.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
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

describe("planning.transition delivery", () => {
	const ORIGIN = '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n';

	test("a metric write that never resolves does not hold up the planning_status reply", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const stalled: MetricSink = { name: "greptime", emit: () => new Promise<SinkResult>(() => {}) };
		const planning = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence: null, emit: async () => true, metrics: stalled, fallback: recordingSink("stdout").sink, clock: CLOCK });
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		// The reply is awaited directly: a reply held up by the stalled write would never resolve, and the test would time out.
		const view = await planning.status();
		expect(view.state === "ok" && view.changes.state).toBe("changed");
	});

	test("a config read that throws holds the transition, and the next readable read records it exactly once", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		let configReadable = true;
		const base = nodePlanningFs();
		const flaky: PlanningFs = {
			...base,
			readFile: async (path) => {
				if (!configReadable && path.endsWith(join(".git", "config"))) throw new Error("EIO");
				return base.readFile(path);
			},
		};
		const metrics = recordingSink("greptime");
		const planning = new PlanningReader({ settings: settingsFor(root), fs: flaky, presence: null, emit: async () => true, metrics: metrics.sink, fallback: recordingSink("stdout").sink, clock: CLOCK });
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		configReadable = false;
		const failed = await planning.status();
		configReadable = true;
		expect(failed.state === "ok" && failed.changes).toMatchObject({ state: "changed", changed: 1, ledger: "repo-unknown" });
		await planning.settleTransitions();
		expect(metrics.records).toEqual([]);

		const recovered = await planning.status();
		await planning.settleTransitions();
		expect(recovered.state === "ok" && recovered.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		const after = await planning.status();
		await planning.settleTransitions();
		expect(after.state === "ok" && after.changes).toEqual({ state: "unchanged" });
		expect(metrics.records).toEqual([expect.objectContaining({ phaseId: PLANNING_TRANSITION_PHASE, outcome: "applied" })]);
	});

	test("a delivery that completes before the shutdown bound finishes before shutdown resolves", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
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
		const planning = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence: null, emit: async () => true, metrics: gated, fallback: recordingSink("stdout").sink, clock: CLOCK });
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await planning.status();
		const bound = Promise.withResolvers<void>();
		const shutdown = planning.settleTransitions(bound.promise);
		release.resolve();
		expect(await shutdown).toBe("settled");
		expect(delivered).toHaveLength(1);
	});

	test("a delivery still pending when the shutdown bound passes does not hold shutdown past it", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const stalled: MetricSink = { name: "greptime", emit: () => Promise.withResolvers<SinkResult>().promise };
		const planning = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence: null, emit: async () => true, metrics: stalled, fallback: recordingSink("stdout").sink, clock: CLOCK });
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		await planning.status();
		const bound = Promise.withResolvers<void>();
		const shutdown = planning.settleTransitions(bound.promise);
		bound.resolve();
		expect(await shutdown).toBe("deadline");
	});

	test("past the bound a record goes to the fallback, and the primary never holds more deliveries than the bound", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN);
		const primaryCalls: TransitionRecord[] = [];
		const stalled: MetricSink = {
			name: "greptime",
			emit: (record) => {
				primaryCalls.push(record);
				return Promise.withResolvers<SinkResult>().promise;
			},
		};
		const fallback = recordingSink("stdout");
		const planning = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence: null, emit: async () => true, metrics: stalled, fallback: fallback.sink, clock: CLOCK });
		await planning.status();
		for (let i = 0; i <= MAX_PENDING_TRANSITIONS; i++) {
			await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edit ${i}\n`);
			await planning.status();
		}
		expect(primaryCalls).toHaveLength(MAX_PENDING_TRANSITIONS);
		expect(fallback.records).toHaveLength(1);
	}, 60_000);
});

const ORIGIN_CONFIG = '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n';

describe("the planning heartbeat", () => {
	test("a session that reads the plane appears in planning_sessions afterwards", async () => {
		await seedPhase();
		await write(".git/HEAD", "ref: refs/heads/gsd/p52-wiring\n");
		const presence = new DragonflyPresenceStore(new PresenceFake());
		const plane = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence, emit: async () => true, ...quietSinks() });

		expect(await plane.status()).toMatchObject({ state: "ok", heartbeat: { state: "written" } });
		const stored = await presence.listWithin(10);
		expect(stored.records.map((record) => [record.worktree, record.branch, record.activePhase])).toEqual([[root, "gsd/p52-wiring", null]]);

		const sessions = await plane.sessions();
		expect(sessions.state === "ok" && sessions.sessions).toEqual([
			expect.objectContaining({ sessionId: expect.stringMatching(/^wt-[0-9a-f]{24}$/), worktree: root, status: "active", ageMs: 0 }),
		]);
	});

	test("a checkout with no git entry records a failed heartbeat, and the read still returns its summary", async () => {
		await seedPhase();
		const presence = new DragonflyPresenceStore(new PresenceFake());
		const plane = new PlanningReader({ settings: settingsFor(root), fs: nodePlanningFs(), presence, emit: async () => true, ...quietSinks() });
		expect(await plane.status()).toMatchObject({
			state: "ok",
			counts: { documents: 2, errors: 1 },
			heartbeat: { state: "failed", detail: "no-git-entry" },
		});
		expect((await presence.listWithin(10)).records).toEqual([]);
	});
});

describe("the planning baseline", () => {
	test("a slow scan that finishes after a newer one does not move the baseline back", async () => {
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} one\n`);
		await write(".git/config", ORIGIN_CONFIG);
		const real = nodePlanningFs();
		const { promise: atGate, resolve: reached } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let gated = false;
		// The first read of the document returns its old bytes, then waits: that scan hashes old content and finishes late.
		// The index reads a document through `openRead`, so the gate sits there.
		const slowFirst = {
			...real,
			openRead: async (path: string, limit: number, accept: (real: string) => boolean) => {
				const opened = await real.openRead(path, limit, accept);
				if (!gated && path.endsWith("52-CONTEXT.md")) {
					gated = true;
					reached();
					await gate;
				}
				return opened;
			},
		};
		const plane = new PlanningReader({ settings: settingsFor(root), fs: slowFirst, presence: null, emit: async () => true, ...quietSinks() });

		const slow = plane.status();
		await atGate;
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} two\n`);
		const fresh = await plane.status();
		expect(fresh.state === "ok" && fresh.changes).toEqual({ state: "baseline" });

		release();
		const stale = await slow;
		expect(stale.state === "ok" && stale.changes).toEqual({ state: "superseded" });

		const after = await plane.status();
		expect(after.state === "ok" && after.changes).toEqual({ state: "unchanged" });
	});
});

describe("the origin of a checkout", () => {
	test("a .git file names a git directory whose config holds the origin", async () => {
		const gitDir = join(dir, "git-admin");
		await mkdir(gitDir, { recursive: true });
		await writeFile(join(gitDir, "config"), ORIGIN_CONFIG);
		await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`);
		await seedPhase();
		const harness = reader(root);
		await harness.reader.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(harness.events.map((event) => event.repo)).toEqual([REPO]);
	});

	test("a linked worktree's git directory reads the shared config from its commondir", async () => {
		const common = join(dir, "common-git");
		const worktreeAdmin = join(common, "worktrees", "wt");
		await mkdir(worktreeAdmin, { recursive: true });
		await writeFile(join(common, "config"), ORIGIN_CONFIG);
		await writeFile(join(worktreeAdmin, "commondir"), "../..\n");
		await writeFile(join(worktreeAdmin, "HEAD"), "ref: refs/heads/gsd/p52-wiring\n");
		await writeFile(join(root, ".git"), `gitdir: ${worktreeAdmin}\n`);
		await seedPhase();
		const harness = reader(root);
		await harness.reader.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const view = await harness.reader.status();
		expect(view.state === "ok" && view.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(harness.events.map((event) => event.repo)).toEqual([REPO]);
	});

	test("an unreadable .git/config still returns the document summary, and the transition is published once it is readable", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN_CONFIG);
		const real = nodePlanningFs();
		let readable = true;
		const flaky = {
			...real,
			readFile: async (path: string) => {
				if (!readable && path.endsWith(join(".git", "config"))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				return real.readFile(path);
			},
		};
		const events: EventInput[] = [];
		const plane = new PlanningReader({
			settings: settingsFor(root),
			fs: flaky,
			presence: null,
			...quietSinks(),
			emit: async (event) => {
				events.push(event);
				return true;
			},
		});
		await plane.status();

		readable = false;
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const denied = await plane.status();
		expect(denied.state).toBe("ok");
		if (denied.state !== "ok") return;
		expect(denied.counts.documents).toBe(2);
		expect(denied.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "repo-unknown", repoReason: "config-unreadable" });
		expect(events).toEqual([]);

		readable = true;
		const recovered = await plane.status();
		expect(recovered.state === "ok" && recovered.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(events.map((event) => event.repo)).toEqual([REPO]);

		const after = await plane.status();
		expect(after.state === "ok" && after.changes).toEqual({ state: "unchanged" });
		expect(events).toHaveLength(1);
	});
});

describe("a planning change whose publish fails", () => {
	test("is re-sent by the next read, and stored exactly once after the publish succeeds", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN_CONFIG);
		const attempts: EventInput[] = [];
		const stored: EventInput[] = [];
		let accept = false;
		const plane = new PlanningReader({
			settings: settingsFor(root),
			fs: nodePlanningFs(),
			presence: null,
			...quietSinks(),
			emit: async (event) => {
				attempts.push(event);
				if (!accept) return false;
				stored.push(event);
				return true;
			},
		});
		await plane.status();

		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const failed = await plane.status();
		expect(failed.state === "ok" && failed.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "not-stored" });
		expect(stored).toEqual([]);

		accept = true;
		const retried = await plane.status();
		expect(retried.state === "ok" && retried.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(attempts).toHaveLength(2);
		expect(stored).toHaveLength(1);

		const after = await plane.status();
		expect(after.state === "ok" && after.changes).toEqual({ state: "unchanged" });
		expect(stored).toHaveLength(1);
	});
});

describe("a failed publish holds the baseline through the reader", () => {
	test("two failed publishes hold the baseline, and the next read publishes the change exactly once", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN_CONFIG);
		const attempts: EventInput[] = [];
		const stored: EventInput[] = [];
		let failures = 2;
		const plane = new PlanningReader({
			settings: settingsFor(root),
			fs: nodePlanningFs(),
			presence: null,
			...quietSinks(),
			emit: async (event) => {
				attempts.push(event);
				if (failures > 0) {
					failures--;
					return false;
				}
				stored.push(event);
				return true;
			},
		});
		await plane.status();

		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const first = await plane.status();
		expect(first.state === "ok" && first.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "not-stored" });

		const second = await plane.status();
		expect(second.state === "ok" && second.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "not-stored" });
		expect(stored).toEqual([]);

		const third = await plane.status();
		expect(third.state === "ok" && third.changes).toEqual({ state: "changed", added: 0, removed: 0, changed: 1, ledger: "emitted" });
		expect(attempts).toHaveLength(3);
		expect(stored).toHaveLength(1);

		const after = await plane.status();
		expect(after.state === "ok" && after.changes).toEqual({ state: "unchanged" });
		expect(stored).toHaveLength(1);
	});
});

describe("a stalled Dragonfly reply", () => {
	test("planning_sessions returns its error within the command deadline", async () => {
		const stalled: PresenceRedisClient = { connect: async () => {}, send: () => new Promise<never>(() => {}), close: () => {} };
		const presence = new DragonflyPresenceStore(dragonflyPresenceBackend("redis://127.0.0.1:6379", 250, () => stalled, 20));
		const started = performance.now();
		const view = await sessionsReader(presence).sessions();
		expect(performance.now() - started).toBeLessThan(1000);
		expect(view).toMatchObject({ state: "unavailable", code: "presence-listing-failed" });
		expect(view.state === "unavailable" && view.detail).toContain("deadline (20 ms presence SCAN)");
	});
});

describe("held, incomplete and failed-heartbeat states are reported", () => {
	test("a file added and then edited while the ledger is down records one refused transition for each distinct change", async () => {
		await seedPhase();
		await write(".git/config", ORIGIN_CONFIG);
		let accept = false;
		const harness = reader(root, { emit: async () => accept });
		await harness.reader.status();
		await write(`${PHASE}/52-NOTES.md`, "first\n");
		await harness.reader.status();
		await harness.reader.settleTransitions();
		await write(`${PHASE}/52-NOTES.md`, "second\n");
		await harness.reader.status();
		await harness.reader.settleTransitions();
		expect(harness.transitions).toEqual([expect.objectContaining({ outcome: "refused" }), expect.objectContaining({ outcome: "refused" })]);
	});

	test("an unlistable directory with an edit in a readable directory records that edit as an incomplete refused transition", async () => {
		await seedPhase();
		await mkdir(join(root, ".planning/phases/53-locked"), { recursive: true });
		await write(".planning/phases/53-locked/53-PLAN.md", `${BODY} locked\n`);
		await write(".git/config", ORIGIN_CONFIG);
		const real = nodePlanningFs();
		const flaky: PlanningFs = {
			...real,
			readDir: async (path) => {
				if (path.endsWith("53-locked")) throw new Error("EACCES: permission denied");
				return real.readDir(path);
			},
		};
		const metrics = recordingSink("greptime");
		const planning = new PlanningReader({ settings: settingsFor(root), fs: flaky, presence: null, emit: async () => true, metrics: metrics.sink, fallback: recordingSink("stdout").sink, clock: CLOCK });
		await planning.status();
		await write(`${PHASE}/52-CONTEXT.md`, `${BODY} edited\n`);
		const view = await planning.status();
		expect(view.state === "ok" && view.changes.state).toBe("partial");
		await planning.settleTransitions();
		expect(metrics.records).toEqual([expect.objectContaining({ outcome: "refused", incomplete: true })]);
	});

	test("a checkout whose presence write fails, with a working listing, reports DEGRADED", async () => {
		await write(".git/HEAD", "ref: refs/heads/gsd/p54-complete\n");
		class FailingWrites extends PresenceFake {
			async setWithTtl(): Promise<void> {
				throw new Error("SET refused");
			}
		}
		const view = await sessionsReader(new DragonflyPresenceStore(new FailingWrites())).sessions();
		expect(view).toMatchObject({ state: "ok", heartbeat: { state: "failed" }, view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});
});

describe("a checkout's git reads, when they fail", () => {
	test("an unreadable .git/HEAD with a working listing reports DEGRADED", async () => {
		await write(".git/HEAD", "ref: refs/heads/gsd/p54-complete\n");
		const real = nodePlanningFs();
		const headDenied: PlanningFs = {
			...real,
			readFile: async (path) => {
				if (path.endsWith(join(".git", "HEAD"))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				return real.readFile(path);
			},
		};
		const view = await new PlanningReader({ settings: settingsFor(root), fs: headDenied, presence: new DragonflyPresenceStore(new PresenceFake()), emit: async () => true, ...quietSinks() }).sessions();
		expect(view).toMatchObject({ state: "ok", heartbeat: { state: "failed", transient: true }, view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});

	test("a missing git entry is a definitive absence: the view keeps its state and is not DEGRADED", async () => {
		const view = await sessionsReader(new DragonflyPresenceStore(new PresenceFake())).sessions();
		expect(view).toMatchObject({ state: "ok", heartbeat: { state: "failed", detail: "no-git-entry", transient: false }, view: { state: "EMPTY" } });
		expectNonBlankState(view);
	});
});
