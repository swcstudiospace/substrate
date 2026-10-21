import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitReconcile,
	emptyHerdrState,
	graphOfPane,
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

describe("reconcile", () => {
	test("first run seeds and emits nothing, including a non-v2 file", () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
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
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
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

	test("a spooled transition advances like a stored one so it is not emitted twice, and counts failed", () => {
		const state = seeded([pane({ agent: "omp" })]);
		const changed = reconcile(state, [pane({ agent: "claude" })], { now: LATER, attribute });

		const parked = commitReconcile(state, changed, ["spooled", "spooled"]);

		expect(parked.panes[paneIdentity("w1:p1", "term_a")]?.agent).toBe("claude");
		expect(parked.counters).toMatchObject({ stored: 0, refused: 0, failed: 2 });
		// The next pass sees no change: the spool owns the event now.
		expect(reconcile(parked, [pane({ agent: "claude" })], { now: LATER, attribute }).transitions).toEqual([]);
	});
});

describe("state file", () => {
	test("version 2 round-trips by tmp plus rename and a restart stays silent", () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-state-"));
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

	test("a graph named at start stays on the pane record, so the session end after a restart still names it", () => {
		const GID = "ut-mugzzzzz-0123abcd";
		const named = { attribute: () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }), graphOf: () => GID };
		const started = reconcile(emptyHerdrState(), [pane()], { now: NOW, ...named });
		expect(started.transitions[0]?.event.graph_id).toBe(GID);
		const dir = mkdtempSync(join(tmpdir(), "herdr-graph-"));
		const path = join(dir, "herdr-offsets.json");
		expect(saveHerdrState(path, commitReconcile(emptyHerdrState(), started, ["stored"]))).toBe(true);
		const ended = reconcile(loadHerdrState(path).state, [], { now: LATER, attribute });
		expect(ended.transitions.map((transition) => transition.event.kind)).toEqual(["session.end"]);
		expect(ended.transitions[0]?.event.graph_id).toBe(GID);
	});
});

describe("one session, one graph", () => {
	const A = "ut-aaaa-00000001";
	const B = "ut-bbbb-00000002";
	const LATEST = "2026-10-09T00:00:10.000Z";
	const repoAndBranch = () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" });
	const inGraph = (graph: string | undefined) => ({ attribute: repoAndBranch, graphOf: () => graph });

	test("a pane that moves to another graph and back starts a new session at each move", () => {
		const started = reconcile(emptyHerdrState(), [pane()], { now: NOW, ...inGraph(A) });
		let state = commitReconcile(emptyHerdrState(), started, ["stored"]);
		const moved = reconcile(state, [pane()], { now: LATER, ...inGraph(B) });
		expect(moved.transitions.map((transition) => transition.event.kind)).toEqual(["session.end", "session.start"]);
		expect(moved.transitions[0]?.event).toMatchObject({ graph_id: A, payload: { end_reason: "graph_changed" } });
		expect(moved.transitions[1]?.event.graph_id).toBe(B);
		expect(moved.transitions[1]?.event.session_id).not.toBe(started.transitions[0]?.event.session_id);
		state = commitReconcile(state, moved, ["stored", "stored"]);
		const back = reconcile(state, [pane()], { now: LATEST, ...inGraph(A) });
		expect(back.transitions.map((transition) => transition.event.kind)).toEqual(["session.end", "session.start"]);
		expect(back.transitions[0]?.event.graph_id).toBe(B);
		expect(back.transitions[1]?.event.graph_id).toBe(A);
	});

	test("a session that began before graph attribution is closed at the first snapshot that names a graph", () => {
		const old = seeded([pane()]);
		const upgraded = reconcile(old, [pane()], { now: LATER, ...inGraph(A) });
		expect(upgraded.transitions.map((transition) => transition.event.kind)).toEqual(["session.end", "session.start"]);
		expect(upgraded.transitions[0]?.event.graph_id).toBeUndefined();
		expect(upgraded.transitions[1]?.event.graph_id).toBe(A);
		const closed = reconcile(commitReconcile(old, upgraded, ["stored", "stored"]), [], { now: LATEST, attribute });
		expect(closed.transitions[0]?.event.graph_id).toBe(A);
	});

	test("a snapshot that reports no directory keeps the session and its graph", () => {
		const started = reconcile(emptyHerdrState(), [pane()], { now: NOW, ...inGraph(A) });
		const state = commitReconcile(emptyHerdrState(), started, ["stored"]);
		const quiet = reconcile(state, [pane({ cwd: undefined, foreground_cwd: undefined, agent_status: "idle" })], {
			now: LATER,
			...inGraph(A),
		});
		expect(quiet.transitions.map((transition) => transition.event.kind)).toEqual(["note"]);
		expect(quiet.transitions[0]?.event.graph_id).toBe(A);
	});

	test("a pane that stays put is attributed once, at its start, so Git does not run on steady snapshots", () => {
		let attributed = 0;
		const counted = () => {
			attributed += 1;
			return { repo: "swcstudiospace/agent-substrate", branch: "main" };
		};
		let state = emptyHerdrState();
		for (const at of [NOW, LATER, LATEST]) {
			const result = reconcile(state, [pane()], { now: at, attribute: counted, graphOf: () => A });
			state = commitReconcile(state, result, result.transitions.map(() => "stored"));
		}
		expect(attributed).toBe(1);
	});
});

describe("the graph a pane's directory names", () => {
	test("comes from the directory, falling back to the foreground process, and is empty elsewhere", () => {
		const GID = "ut-mugzzzzz-0123abcd";
		expect(graphOfPane(pane({ cwd: `/var/lib/substrate/worktrees/${GID}/packages/collectors` }))).toBe(GID);
		expect(graphOfPane(pane({ cwd: undefined, foreground_cwd: `/var/lib/substrate/worktrees/${GID}` }))).toBe(GID);
		expect(graphOfPane(pane({ cwd: "/home/ops/src/agent-substrate" }))).toBeUndefined();
		expect(graphOfPane(pane({ cwd: "/var/lib/substrate/worktrees" }))).toBeUndefined();
	});
});
