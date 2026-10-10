import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitReconcile,
	emptyHerdrState,
	loadHerdrState,
	paneIdentity,
	reconcile,
	saveHerdrState,
	type HerdrStateFile,
} from "./herdr-state.ts";
import type { HerdrPane } from "./herdr-map.ts";

const NOW = "2026-10-09T00:00:00.000Z";
const LATER = "2026-10-09T00:00:05.000Z";

function pane(over: Partial<HerdrPane> = {}): HerdrPane {
	return {
		pane_id: "w1:p1",
		terminal_id: "term_a",
		agent: "omp",
		agent_status: "working",
		cwd: "/tmp/repo",
		workspace_id: "w1",
		tab_id: "t1",
		...over,
	};
}

const attribute = () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" });

function seeded(panes: HerdrPane[], now = NOW): HerdrStateFile {
	const result = reconcile(emptyHerdrState(), panes, { seed: true, now, attribute });
	if (!result.seeded) throw new Error("expected a seed");
	return result.seeded;
}

const directories: string[] = [];

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of directories) rmSync(dir, { recursive: true, force: true });
	directories.length = 0;
});

describe("reconcile", () => {
	test("first run seeds and emits nothing, including a non-v2 file", () => {
		const dir = scratchDir();
		const path = join(dir, "herdr-offsets.json");
		writeFileSync(path, `${JSON.stringify({ lastSignature: { "w1:p1:pane.exited": "x" } })}\n`);
		const loaded = loadHerdrState(path);
		expect(loaded.firstRun).toBe(true);
		const result = reconcile(loaded.state, [pane(), pane({ pane_id: "w1:p2", terminal_id: "term_b", agent: null })], {
			seed: true,
			now: NOW,
			attribute,
		});
		expect(result.transitions).toEqual([]);
		expect(result.seeded?.panes[paneIdentity("w1:p1", "term_a")]?.agent).toBe("omp");
		expect(result.seeded?.panes[paneIdentity("w1:p2", "term_b")]).toBeUndefined();
	});

	test("an unchanged reload emits nothing", () => {
		const state = seeded([pane()]);
		const again = reconcile(state, [pane()], { now: LATER, attribute });
		expect(again.transitions).toEqual([]);
	});

	test("start, note and end follow the snapshot", () => {
		const state = seeded([]);
		const started = reconcile(state, [pane()], { now: NOW, attribute });
		expect(started.transitions.map((transition) => transition.event.kind)).toEqual(["session.start"]);
		expect(started.transitions[0]?.event.repo).toBe("swcstudiospace/agent-substrate");
		expect(started.transitions[0]?.event.payload).toMatchObject({ runtime: "herdr", status: "working", agent: "omp" });
		const holding = commitReconcile(state, started, ["stored"]);

		const noted = reconcile(holding, [pane({ agent_status: "idle" })], { now: LATER, attribute });
		expect(noted.transitions).toHaveLength(1);
		expect(noted.transitions[0]?.event.kind).toBe("note");
		expect(noted.transitions[0]?.event.payload).toMatchObject({ status: "idle", previous_status: "working" });
		expect(noted.transitions[0]?.event.session_id).toBe(holding.panes[paneIdentity("w1:p1", "term_a")]?.session_id);
		const afterNote = commitReconcile(holding, noted, ["stored"]);

		const ended = reconcile(afterNote, [], { now: LATER, attribute });
		expect(ended.transitions).toHaveLength(1);
		expect(ended.transitions[0]?.event.kind).toBe("session.end");
		expect(ended.transitions[0]?.event.repo).toBe("swcstudiospace/agent-substrate");
		expect(ended.transitions[0]?.event.payload).toMatchObject({ end_reason: "pane_gone" });
		const afterEnd = commitReconcile(afterNote, ended, ["stored"]);
		expect(afterEnd.panes).toEqual({});
	});

	test("unknown is recorded and only the net known change is emitted", () => {
		const state = seeded([pane({ agent_status: "working" })]);
		const into = reconcile(state, [pane({ agent_status: "unknown" })], { now: LATER, attribute });
		expect(into.transitions).toEqual([]);
		expect(into.silent[0]?.pane.raw_status).toBe("unknown");
		expect(into.silent[0]?.pane.status).toBe("working");
		const dipped = commitReconcile(state, into, []);

		const back = reconcile(dipped, [pane({ agent_status: "working" })], { now: LATER, attribute });
		expect(back.transitions).toEqual([]);
		expect(back.silent[0]?.pane.raw_status).toBe("working");

		const idle = reconcile(dipped, [pane({ agent_status: "idle" })], { now: LATER, attribute });
		expect(idle.transitions).toHaveLength(1);
		expect(idle.transitions[0]?.event.payload).toMatchObject({ previous_status: "working", status: "idle" });
	});

	test("a reused pane id with a new terminal ends the old run and starts a new one", () => {
		const state = seeded([pane()]);
		const oldSession = state.panes[paneIdentity("w1:p1", "term_a")]?.session_id;
		const result = reconcile(state, [pane({ terminal_id: "term_b", agent_status: "idle" })], { now: LATER, attribute });
		expect(result.transitions.map((transition) => transition.event.kind)).toEqual(["session.start", "session.end"]);
		const start = result.transitions.find((transition) => transition.event.kind === "session.start");
		const end = result.transitions.find((transition) => transition.event.kind === "session.end");
		expect(start?.identity).toBe(paneIdentity("w1:p1", "term_b"));
		expect(end?.identity).toBe(paneIdentity("w1:p1", "term_a"));
		expect(start?.event.session_id).not.toBe(oldSession);
		expect(end?.event.session_id).toBe(oldSession);
	});

	test("an agent change is an end plus a start, and an unmapped id emits nothing", () => {
		const state = seeded([pane()]);
		const changed = reconcile(state, [pane({ agent: "claude", agent_status: "idle" })], { now: LATER, attribute });
		expect(changed.transitions.map((transition) => transition.rowId)).toEqual(["herdr.pane_exited", "herdr.agent_detected"]);
		expect(changed.transitions[1]?.event.surface).toBe("claude-code");

		const unmapped = reconcile(state, [pane({ agent: "copilot" })], { now: LATER, attribute });
		expect(unmapped.transitions.map((transition) => transition.event.kind)).toEqual(["session.end"]);
		expect(unmapped.unmapped.copilot).toBe(1);
		const counted = commitReconcile(state, unmapped, ["stored"]);
		const again = reconcile(counted, [pane({ agent: "copilot" })], { now: LATER, attribute });
		expect(again.transitions).toEqual([]);
		expect(again.unmapped.copilot).toBe(1);

		const unknown = reconcile(emptyHerdrState(), [pane({ agent: "not-a-real-agent" })], { now: NOW, attribute });
		expect(unknown.transitions).toEqual([]);
		expect(unknown.unmapped["not-a-real-agent"]).toBe(1);
	});

	test("reserved agent names keep own numeric totals across a save", () => {
		const panes = [
			pane({ pane_id: "w1:p1", terminal_id: "term_a", agent: "constructor" }),
			pane({ pane_id: "w1:p2", terminal_id: "term_b", agent: "__proto__" }),
			pane({ pane_id: "w1:p3", terminal_id: "term_c", agent: "toString" }),
		];
		const first = reconcile(emptyHerdrState(), panes, { now: NOW, attribute });
		expect(first.transitions).toEqual([]);
		for (const agent of ["constructor", "__proto__", "toString"]) {
			expect(typeof first.unmapped[agent]).toBe("number");
			expect(first.unmapped[agent]).toBe(1);
		}
		expect(Object.hasOwn(first.unmapped, "__proto__")).toBe(true);
		const counted = commitReconcile(emptyHerdrState(), first, []);
		const dir = scratchDir();
		const path = join(dir, "herdr-offsets.json");
		expect(saveHerdrState(path, counted)).toBe(true);
		const loaded = loadHerdrState(path);
		expect(loaded.firstRun).toBe(false);
		for (const agent of ["constructor", "__proto__", "toString"]) {
			expect(loaded.state.counters.unmapped[agent]).toBe(1);
		}
		const again = reconcile(counted, panes, { now: LATER, attribute });
		expect(again.transitions).toEqual([]);
		for (const agent of ["constructor", "__proto__", "toString"]) {
			expect(again.unmapped[agent]).toBe(1);
		}
	});

	test("a directory with no origin still starts, without repo", () => {
		const result = reconcile(emptyHerdrState(), [pane()], { now: NOW, attribute: () => ({}) });
		expect(result.transitions[0]?.event.repo).toBeUndefined();
		expect(result.transitions[0]?.event.kind).toBe("session.start");
	});

	test("a status change drops repo and branch the lookup no longer returns", () => {
		const state = seeded([pane()]);
		const noted = reconcile(state, [pane({ agent_status: "idle" })], { now: LATER, attribute: () => ({}) });
		expect(noted.transitions).toHaveLength(1);
		expect(noted.transitions[0]?.event.repo).toBeUndefined();
		expect(noted.transitions[0]?.event.branch).toBeUndefined();
		const held = commitReconcile(state, noted, ["stored"]);
		expect(held.panes[paneIdentity("w1:p1", "term_a")]?.repo).toBeUndefined();
		expect(held.panes[paneIdentity("w1:p1", "term_a")]?.branch).toBeUndefined();
		const ended = reconcile(held, [], { now: LATER, attribute: () => ({}) });
		expect(ended.transitions[0]?.event.repo).toBeUndefined();
		expect(ended.transitions[0]?.event.branch).toBeUndefined();
	});
});

describe("commit", () => {
	test("stored and refused advance; failed does not, and blocks the rest of that identity", () => {
		const state = seeded([pane({ agent: "omp" })]);
		const changed = reconcile(state, [pane({ agent: "claude" })], { now: LATER, attribute });
		const refused = commitReconcile(state, changed, ["refused", "stored"]);
		expect(refused.panes[paneIdentity("w1:p1", "term_a")]?.agent).toBe("claude");
		expect(refused.counters).toMatchObject({ stored: 1, refused: 1, failed: 0 });

		const failed = commitReconcile(state, changed, ["failed", "skipped"]);
		expect(failed.panes[paneIdentity("w1:p1", "term_a")]?.agent).toBe("omp");
		expect(failed.counters.failed).toBe(1);
		expect(failed.counters.stored).toBe(0);

		const half = commitReconcile(state, changed, ["stored", "failed"]);
		expect(half.panes[paneIdentity("w1:p1", "term_a")]).toBeUndefined();
		expect(half.counters).toMatchObject({ stored: 1, failed: 1 });
	});
});

describe("state file", () => {
	test("version 2 round-trips by tmp plus rename and a restart stays silent", () => {
		const dir = scratchDir();
		const path = join(dir, "nested", "herdr-offsets.json");
		const state = seeded([pane()]);
		expect(saveHerdrState(path, state)).toBe(true);
		expect(existsSync(`${path}.tmp`)).toBe(false);
		const loaded = loadHerdrState(path);
		expect(loaded.firstRun).toBe(false);
		expect(loaded.state.panes).toEqual(state.panes);
		expect(reconcile(loaded.state, [pane()], { now: LATER, attribute }).transitions).toEqual([]);
		const text = readFileSync(path, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text).version).toBe(2);
	});

	test("reload retries a failed agent end without duplicating another pane's committed note", () => {
		const path = join(scratchDir(), "herdr-offsets.json");
		const firstIdentity = paneIdentity("w1:p1", "term_a");
		const secondIdentity = paneIdentity("w1:p2", "term_b");
		const secondPane = pane({ pane_id: "w1:p2", terminal_id: "term_b" });
		const state = seeded([pane(), secondPane]);
		expect(saveHerdrState(path, state)).toBe(true);
		const snapshot = [
			pane({ agent: "claude", agent_status: "idle" }),
			{ ...secondPane, agent_status: "idle" },
		];
		const planned = reconcile(loadHerdrState(path).state, snapshot, { now: LATER, attribute });
		expect(planned.transitions.map((transition) => ({
			identity: transition.identity, kind: transition.event.kind, session_id: transition.event.session_id,
			surface: transition.event.surface, payload: transition.event.payload,
		}))).toEqual([
			{
				identity: firstIdentity, kind: "session.end", session_id: `herdr:term_a:${NOW}`, surface: "omp",
				payload: { runtime: "herdr", herdr_type: "pane.exited", pane_id: "w1:p1", agent: "omp", end_reason: "agent_released" },
			},
			{
				identity: firstIdentity, kind: "session.start", session_id: `herdr:term_a:${LATER}`, surface: "claude-code",
				payload: { runtime: "herdr", herdr_type: "pane.agent_detected", pane_id: "w1:p1", agent: "claude", status: "idle" },
			},
			{
				identity: secondIdentity, kind: "note", session_id: `herdr:term_b:${NOW}`, surface: "omp",
				payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id: "w1:p2", agent: "omp", previous_status: "working", status: "idle" },
			},
		]);
		const failed = commitReconcile(loadHerdrState(path).state, planned, ["failed", "skipped", "stored"]);
		expect(saveHerdrState(path, failed)).toBe(true);
		const restarted = loadHerdrState(path);
		expect(restarted.firstRun).toBe(false);
		expect(restarted.state.panes[firstIdentity]).toEqual(state.panes[firstIdentity]);
		expect(restarted.state.panes[secondIdentity]).toMatchObject({ status: "idle", session_id: `herdr:term_b:${NOW}` });
		expect(restarted.state.counters).toEqual({ stored: 1, refused: 0, failed: 1, unmapped: {} });

		const retried = reconcile(restarted.state, snapshot, { now: LATER, attribute });
		expect(retried.transitions.map((transition) => transition.event)).toEqual(planned.transitions.slice(0, 2).map((transition) => transition.event));
		for (const transition of retried.transitions) expect(transition.event).toMatchObject({
			repo: "swcstudiospace/agent-substrate", branch: "main", actor: "agent",
		});
		// An end refusal is accountable: it advances and permits the new agent start.
		const recovered = commitReconcile(restarted.state, retried, ["refused", "stored"]);
		expect(saveHerdrState(path, recovered)).toBe(true);
		const settled = loadHerdrState(path).state;
		expect(settled.panes[firstIdentity]).toMatchObject({ agent: "claude", status: "idle", session_id: `herdr:term_a:${LATER}` });
		expect(settled.counters).toEqual({ stored: 2, refused: 1, failed: 1, unmapped: {} });
		expect(reconcile(settled, snapshot, { now: "2026-10-09T00:01:00.000Z", attribute }).transitions).toEqual([]);
	});

	test("reload after a half-committed agent swap retries only the new start and retains a failed end", () => {
		const path = join(scratchDir(), "herdr-offsets.json");
		const identity = paneIdentity("w1:p1", "term_a");
		const state = seeded([pane()]);
		expect(saveHerdrState(path, state)).toBe(true);
		const snapshot = [pane({ agent: "claude", agent_status: "idle" })];
		const swap = reconcile(loadHerdrState(path).state, snapshot, { now: LATER, attribute });
		expect(swap.transitions.map((transition) => transition.event.kind)).toEqual(["session.end", "session.start"]);
		const half = commitReconcile(loadHerdrState(path).state, swap, ["stored", "failed"]);
		expect(saveHerdrState(path, half)).toBe(true);
		const restarted = loadHerdrState(path);
		expect(restarted.firstRun).toBe(false);
		expect(restarted.state.panes).toEqual({});
		expect(restarted.state.counters).toEqual({ stored: 1, refused: 0, failed: 1, unmapped: {} });

		const recoveryTime = "2026-10-09T00:00:10.000Z";
		const retry = reconcile(restarted.state, snapshot, { now: recoveryTime, attribute });
		expect(retry.transitions.map((transition) => transition.event)).toEqual([{
			kind: "session.start", surface: "claude-code", actor: "agent",
			session_id: `herdr:term_a:${recoveryTime}`, repo: "swcstudiospace/agent-substrate", branch: "main",
			summary: "herdr detected claude-code in pane w1:p1",
			payload: { runtime: "herdr", herdr_type: "pane.agent_detected", pane_id: "w1:p1", agent: "claude", status: "idle" },
		}]);
		const started = commitReconcile(restarted.state, retry, ["stored"]);
		expect(saveHerdrState(path, started)).toBe(true);
		const stable = loadHerdrState(path).state;
		expect(stable.panes[identity]?.session_id).toBe(`herdr:term_a:${recoveryTime}`);
		expect(reconcile(stable, snapshot, { now: LATER, attribute }).transitions).toEqual([]);

		const ending = reconcile(stable, [], { now: LATER, attribute });
		expect(ending.transitions.map((transition) => transition.event)).toEqual([{
			kind: "session.end", surface: "claude-code", actor: "agent",
			session_id: `herdr:term_a:${recoveryTime}`, repo: "swcstudiospace/agent-substrate", branch: "main",
			summary: "herdr pane w1:p1 exited",
			payload: { runtime: "herdr", herdr_type: "pane.exited", pane_id: "w1:p1", agent: "claude", end_reason: "pane_gone" },
		}]);
		const failedEnd = commitReconcile(stable, ending, ["failed"]);
		expect(saveHerdrState(path, failedEnd)).toBe(true);
		const afterEndFailure = loadHerdrState(path).state;
		expect(afterEndFailure.panes[identity]).toEqual(stable.panes[identity]);
		expect(afterEndFailure.counters).toEqual({ stored: 2, refused: 0, failed: 2, unmapped: {} });
		const endRetry = reconcile(afterEndFailure, [], { now: recoveryTime, attribute });
		expect(endRetry.transitions.map((transition) => transition.event)).toEqual(ending.transitions.map((transition) => transition.event));
		expect(saveHerdrState(path, commitReconcile(afterEndFailure, endRetry, ["refused"]))).toBe(true);
		const ended = loadHerdrState(path).state;
		expect(ended.panes).toEqual({});
		expect(ended.counters).toEqual({ stored: 2, refused: 1, failed: 2, unmapped: {} });
		expect(reconcile(ended, [], { now: recoveryTime, attribute }).transitions).toEqual([]);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});
