/**
 * The planning reads over an in-memory tree and a recording presence backend (phase 52, SOTA-08). Both reads answer typed
 * results, and neither writes anything: no presence heartbeat, no ledger note, no file, on the first call or any later one.
 * Every sessions answer carries the session view's state (phase 54), derived from the body alone.
 *
 * Multi-root (phase 52, v1.7): the top-level fields are the selected checkout's view (the one named, or the first configured),
 * and `checkouts` holds one `{ key, root, view }` entry per checkout the call names. These tests configure one checkout, so
 * the first entry is the answer: `okIndexOf` reads a status entry, `onlyView` a sessions entry.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { planningSessionId } from "./checkout.ts";
import { PLANNING_MAX_FILES_ENV, PLANNING_ROOTS_ENV, loadPlanningSettings } from "./config.ts";
import { dragonflyPresenceBackend, type PresenceRedisClient } from "./presence-client.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";
import { PlanningReader, type PlanningIndexView, type PlanningSessionsView } from "./read.ts";
import { SESSION_STATES } from "./states.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const P = `${TREE_ROOT}/.planning`;
const PHASE = `${P}/phases/52-planning-awareness-core`;
const BODY = "BODY-SECRET-TEXT";
const FRONTMATTER_SECRET = "FM-SECRET-VALUE";
/** A checkout key no configured checkout has: smaller than any `wt-` id of a real checkout. */
const UNKNOWN_KEY = "wt-000000000000000000000000";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Two good phase documents and one with an unclosed frontmatter fence. Each carries a body and a frontmatter secret. */
function seededTree(): FakeTree {
	return new FakeTree({
		[`${PHASE}/52-PLAN.md`]: `---\nphase: "52"\nnote: ${FRONTMATTER_SECRET}\n---\n${BODY} plan\n`,
		[`${PHASE}/52-CONTEXT.md`]: `${BODY} context\n`,
		[`${PHASE}/BAD.md`]: `---\nphase: [unclosed\n${BODY} bad\n`,
	});
}

function readerOver(tree: FakeTree, options: { root?: string | null; presence?: DragonflyPresenceStore | null } = {}): PlanningReader {
	const env = options.root === null ? {} : { [PLANNING_ROOTS_ENV]: options.root ?? TREE_ROOT };
	return new PlanningReader({
		settings: loadPlanningSettings(env),
		fs: tree,
		presence: options.presence === undefined ? null : options.presence,
	});
}

/** A session record as a heartbeat stores it, under its presence key. */
function storeSession(backend: RecordingPresenceBackend, record: SessionRecord): void {
	backend.values.set(`${PRESENCE_KEY_PREFIX}${record.sessionId}`, JSON.stringify(record));
}

function session(sessionId: string, lastHeartbeatMs: number): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: "gsd/p52-wiring", lastHeartbeatMs };
}

/** The index of the one checkout an ok status names: the entry's `view`, which must be an ok index. */
function okIndexOf(answer: { checkouts: readonly { view: PlanningIndexView }[] }): Extract<PlanningIndexView, { state: "ok" }> {
	const [only] = answer.checkouts;
	if (only?.view.state !== "ok") throw new Error(`the checkout's index is ${only?.view.state ?? "absent"}`);
	return only.view;
}

/** The view of the one checkout an ok sessions answer names: the entry's `view`. */
function onlyView<E extends { view: unknown }>(answer: { checkouts: readonly E[] }): E["view"] {
	const [only] = answer.checkouts;
	if (only === undefined) throw new Error("the answer names no checkout");
	return only.view;
}

/** Every session view names one of the six states, with a line that is never blank. The state is the selected checkout's. */
function expectNonBlankState(view: PlanningSessionsView): void {
	expect(SESSION_STATES).toContain(view.view.state);
	expect(view.view.text.trim()).not.toBe("");
}

describe("planning_status", () => {
	test("counts, hashes and the error record are reported, and no file body or frontmatter value is", async () => {
		const view = await readerOver(seededTree()).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		const checkout = okIndexOf(view);
		expect(checkout.counts).toEqual({ documents: 2, errors: 1, byKind: { phase: 2 } });
		expect(checkout.documents.find((row) => row.path.endsWith("52-CONTEXT.md"))?.sha256).toBe(sha256(`${BODY} context\n`));
		expect(checkout.errors).toEqual([expect.objectContaining({ path: ".planning/phases/52-planning-awareness-core/BAD.md", code: "malformed-frontmatter" })]);
		const text = JSON.stringify(view);
		expect(text).not.toContain(BODY);
		expect(text).not.toContain(FRONTMATTER_SECRET);
	});

	test("the GSD-Core position is carried from the same scan, with its secrets redacted and no body text", async () => {
		const token = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
		const state = `---\nmilestone: v1.6\nstatus: executing\nstopped_at: "pushed with ${token}"\ncurrent_phase: 58\n---\n# State\n\n${BODY} prose\n\n## Current Position\n\nPhase: 58\nPlan: 58-01-PLAN\n`;
		const roadmap = `### Phase 58: Live steering\n\n| Phase | Milestone | Plans Complete | Status | Completed |\n|---|---|---|---|---|\n| 58. Live steering | v1.6 | 0/1 | In progress | - |\n`;
		const tree = new FakeTree({ [`${P}/STATE.md`]: state, [`${P}/ROADMAP.md`]: roadmap, [`${P}/phases/58-live-steering/58-01-PLAN.md`]: "# plan\n" });
		const view = await readerOver(tree).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(okIndexOf(view).position).toEqual({
			errors: [],
			ok: true,
			position: {
				milestone: "v1.6",
				milestone_name: null,
				phase: { name: "Live steering", number: "58", slug: "live-steering" },
				plan: "58-01-PLAN",
				progress: { phases_done: 0, phases_total: 1 },
				status: "executing",
				step: "pushed with [REDACTED]",
			},
		});
		const text = JSON.stringify(view);
		expect(text).not.toContain("Z9y8X7w6V5u4T3s2R1q0");
		expect(text).not.toContain(BODY);
	});

	test("without STATE.md and ROADMAP.md the position says so in typed errors and every field is null", async () => {
		const view = await readerOver(seededTree()).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		const checkout = okIndexOf(view);
		expect(checkout.position?.ok).toBe(false);
		expect(checkout.position?.errors.map((error) => `${error.where}:${error.code}`)).toEqual(["ROADMAP.md:missing", "STATE.md:missing"]);
		expect(checkout.position?.position.phase).toBeNull();
	});

	test("an unset root answers disabled, never an error", async () => {
		expect(await readerOver(seededTree(), { root: null }).status()).toEqual({ state: "disabled", reason: "root-unset" });
	});

	test("an absent root answers disabled, never an error", async () => {
		const view = await new PlanningReader({ settings: loadPlanningSettings({}), fs: new FakeTree({}), presence: null }).status();
		expect(view).toEqual({ state: "disabled", reason: "root-unset" });
	});

	test("a relative root answers misconfigured, naming the key and never the value", async () => {
		const view = await readerOver(seededTree(), { root: "relative/checkout" }).status();
		expect(view.state).toBe("misconfigured");
		expect(JSON.stringify(view)).toContain(PLANNING_ROOTS_ENV);
		expect(JSON.stringify(view)).not.toContain("relative/checkout");
	});

	test("a relative root answers misconfigured, naming the key and not the value", async () => {
		const view = await readerOver(seededTree(), { root: "relative/checkout" }).status();
		expect(view).toEqual({ state: "misconfigured", errors: [{ key: PLANNING_ROOTS_ENV, reason: "not-absolute" }] });
	});

	test("a root that does not exist answers the checkout's index as unavailable with the failure code", async () => {
		expect(await readerOver(new FakeTree({})).status()).toMatchObject({ checkouts: [{ view: { state: "unavailable", code: "root-unavailable" } }] });
	});

	test("a truncated index says so and holds the first documents by path", async () => {
		const settings = loadPlanningSettings({ [PLANNING_ROOTS_ENV]: TREE_ROOT, [PLANNING_MAX_FILES_ENV]: "1" });
		const view = await new PlanningReader({ settings, fs: seededTree(), presence: null }).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		const checkout = okIndexOf(view);
		expect(checkout.truncated).toBe(true);
		expect(checkout.documents.map((row) => row.path)).toEqual([".planning/phases/52-planning-awareness-core/52-CONTEXT.md"]);
	});
});

describe("planning_sessions", () => {
	test("a session past its freshness window is stale with its age, and a fresh one is active", async () => {
		const backend = new RecordingPresenceBackend();
		const now = backend.clockMs;
		storeSession(backend, session("wt-fresh", now - 10_000));
		storeSession(backend, session("wt-old", now - 200_000));
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		const checkout = onlyView(view);
		expect(checkout.clock).toEqual({ state: "server" });
		expect(checkout.sessions.map((row) => [row.sessionId, row.status, row.ageMs])).toEqual([
			["wt-fresh", "active", 10_000],
			["wt-old", "stale", 200_000],
		]);
	});

	test("a session past its freshness window is listed as stale with its age, and a fresh one as active", async () => {
		const backend = new RecordingPresenceBackend();
		const now = backend.clockMs;
		storeSession(backend, session("drifted", now - 120_000));
		storeSession(backend, session("fresh", now));
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		expect(view).toMatchObject({
			state: "ok",
			view: { state: "STALE" },
			checkouts: [{ view: { presenceTtlS: 90, clock: { state: "server" }, truncated: false } }],
		});
		if (view.state !== "ok") return;
		expect(onlyView(view).sessions.map((row) => [row.sessionId, row.status, row.ageMs])).toEqual([
			["drifted", "stale", 120_000],
			["fresh", "active", 0],
		]);
	});

	test("a session idle for hours but alive reads active and reports how long it has been idle", async () => {
		const backend = new RecordingPresenceBackend();
		const now = backend.clockMs;
		const hour = 3_600_000;
		// Its last planning change was 5 hours ago; its observer wrote a liveness record 20 seconds ago.
		storeSession(backend, { ...session("wt-quiet", now - 5 * hour), livenessMs: now - 20_000 });
		// No liveness record at all: its change heartbeat is its only sign of life, so it is stale.
		storeSession(backend, session("wt-silent", now - 5 * hour));
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(onlyView(view).sessions.map((row) => [row.sessionId, row.status, row.ageMs, row.idleForMs])).toEqual([
			["wt-quiet", "active", 20_000, 5 * hour],
			["wt-silent", "stale", 5 * hour, 5 * hour],
		]);
	});

	test("when the server clock cannot be read, sessions are listed as unknown and the reason is given", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, session("wt-only", backend.clockMs - 1_000));
		backend.clockFails = true;
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		const checkout = onlyView(view);
		expect(checkout.clock.state).toBe("unavailable");
		expect(checkout.sessions).toEqual([expect.objectContaining({ sessionId: "wt-only", status: "unknown", ageMs: null })]);
		expect(view).toMatchObject({ view: { state: "DEGRADED" } });
	});

	test("with no cache endpoint, sessions answer unavailable with presence-backend-unset", async () => {
		expect(await readerOver(seededTree(), { presence: null }).sessions()).toMatchObject({
			state: "unavailable",
			code: "presence-backend-unset",
			view: { state: "DEGRADED" },
		});
	});

	test("no Dragonfly endpoint answers unavailable with presence-backend-unset", async () => {
		expect(await readerOver(new FakeTree({}), { presence: null }).sessions()).toMatchObject({
			state: "unavailable",
			code: "presence-backend-unset",
			view: { state: "DEGRADED" },
		});
	});

	test("a listing past the bound says it was truncated and holds exactly the bound", async () => {
		const backend = new RecordingPresenceBackend();
		for (let n = 0; n <= PRESENCE_MAX_SESSIONS; n += 1) {
			storeSession(backend, session(`wt-${String(n).padStart(4, "0")}`, backend.clockMs));
		}
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(onlyView(view).truncated).toBe(true);
		expect(onlyView(view).sessions).toHaveLength(PRESENCE_MAX_SESSIONS);
	});

	test("a corrupt stored session fails the listing as unavailable, naming the key and never the value", async () => {
		const backend = new RecordingPresenceBackend();
		backend.values.set(`${PRESENCE_KEY_PREFIX}wt-bad`, "{not json SECRETVALUE");
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "unavailable" || !("code" in view)) throw new Error(`expected unavailable, got ${view.state}`);
		expect(view.code).toBe("presence-listing-failed");
		expect(view.detail).toContain("wt-bad");
		expect(JSON.stringify(view)).not.toContain("SECRETVALUE");
	});

	test("a corrupt stored session fails the listing as unavailable, naming the key and not the value", async () => {
		const backend = new RecordingPresenceBackend();
		backend.values.set(`${PRESENCE_KEY_PREFIX}corrupt`, '{"sessionId":"corrupt","secret":"SHOULD-NOT-APPEAR"}');
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		expect(view.state).toBe("unavailable");
		expect(JSON.stringify(view)).toContain(`${PRESENCE_KEY_PREFIX}corrupt`);
		expect(JSON.stringify(view)).not.toContain("SHOULD-NOT-APPEAR");
	});

	test("an absent root answers disabled, never an error", async () => {
		const view = await readerOver(seededTree(), { root: null }).sessions();
		expect(view).toMatchObject({ state: "disabled", reason: "root-unset", view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});

	test("planning_sessions returns its error within the command deadline", async () => {
		const stalled: PresenceRedisClient = { connect: async () => {}, send: () => new Promise<never>(() => {}), close: () => {} };
		const presence = new DragonflyPresenceStore(dragonflyPresenceBackend("redis://127.0.0.1:6379", 250, () => stalled, 20));
		const started = performance.now();
		const view = await readerOver(new FakeTree({}), { presence }).sessions();
		expect(performance.now() - started).toBeLessThan(1000);
		expect(view).toMatchObject({ state: "unavailable", code: "presence-listing-failed" });
		expect(view.state === "unavailable" && "code" in view ? view.detail : undefined).toContain("deadline (20 ms presence SCAN)");
	});
});

describe("planning_sessions state", () => {
	test("an empty root has the EMPTY state", async () => {
		const view = await readerOver(new FakeTree({}), { presence: new DragonflyPresenceStore(new RecordingPresenceBackend()) }).sessions();
		expect(view).toMatchObject({ state: "ok", view: { state: "EMPTY" }, checkouts: [{ view: { sessions: [] } }] });
		expectNonBlankState(view);
	});

	test("a root with a stale session has the STALE state", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, session("wt-drifted", backend.clockMs - 120_000));
		const view = await readerOver(new FakeTree({}), { presence: new DragonflyPresenceStore(backend) }).sessions();
		expect(view).toMatchObject({ state: "ok", view: { state: "STALE" } });
		expectNonBlankState(view);
	});

	test("a disabled root has the DEGRADED state, not a blank one", async () => {
		const view = await readerOver(new FakeTree({}), { root: null }).sessions();
		expect(view).toMatchObject({ state: "disabled", view: { state: "DEGRADED" } });
		expectNonBlankState(view);
	});
});

describe("neither read writes anything", () => {
	test("planning_status and planning_sessions write nothing on the first call or on a repeated one", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, session("wt-seen", backend.clockMs - 5_000));
		const tree = seededTree();
		const reader = readerOver(tree, { presence: new DragonflyPresenceStore(backend) });

		expect((await reader.status()).state).toBe("ok");
		expect((await reader.sessions()).state).toBe("ok");
		expect((await reader.status()).state).toBe("ok");
		expect((await reader.sessions()).state).toBe("ok");

		expect(backend.writes).toEqual([]);
		expect(backend.values.has(`${PRESENCE_KEY_PREFIX}wt-seen`)).toBe(true);
		expect(tree.returnedFrom.length).toBeGreaterThan(0);
	});

	test("with no presence backend a status read answers the same on every call and writes nothing", async () => {
		const reader = readerOver(seededTree(), { presence: null });
		const first = await reader.status();
		expect(await reader.status()).toEqual(first);
	});
});

describe("planning_status checkpoint durability (phase 53, SOTA-09)", () => {
	test("with no checkpoint directory configured, planning_status says the checkpoints are not durable", async () => {
		expect(await readerOver(seededTree()).status()).toMatchObject({
			state: "ok",
			checkouts: [{ view: { checkpoints: { durable: false, reason: "checkpoint-dir-unset" } } }],
		});
	});

	test("a configured checkpoint directory reports the checkpoints as durable", async () => {
		const reader = new PlanningReader({ settings: loadPlanningSettings({ [PLANNING_ROOTS_ENV]: TREE_ROOT }), fs: seededTree(), presence: null, checkpoints: { durable: true } });
		expect(await reader.status()).toMatchObject({ state: "ok", checkouts: [{ view: { checkpoints: { durable: true } } }] });
	});
});

describe("a stalled Dragonfly reply", () => {
	test("planning_sessions returns its error within the command deadline", async () => {
		const stalled: PresenceRedisClient = { connect: async () => {}, send: () => new Promise<never>(() => {}), close: () => {} };
		const presence = new DragonflyPresenceStore(dragonflyPresenceBackend("redis://127.0.0.1:6379", 250, () => stalled, 20));
		const started = performance.now();
		const view = await readerOver(seededTree(), { presence }).sessions();
		expect(performance.now() - started).toBeLessThan(1000);
		expect(view).toMatchObject({ state: "unavailable", code: "presence-listing-failed" });
		expect(view.state === "unavailable" && "code" in view ? view.detail : undefined).toContain("deadline (20 ms presence SCAN)");
	});
});

describe("planning reads name their checkouts (multi-root)", () => {
	test("planning_status names its one configured checkout by key and root", async () => {
		const tree = seededTree();
		expect(await readerOver(tree).status()).toMatchObject({
			state: "ok",
			checkouts: [{ key: planningSessionId(tree, TREE_ROOT), root: TREE_ROOT, view: { state: "ok" } }],
		});
	});

	test("a planning_status checkout filter names only the matching entry, and an unknown key is unavailable", async () => {
		const tree = seededTree();
		const reader = readerOver(tree);
		const key = planningSessionId(tree, TREE_ROOT);
		expect(await reader.status(key)).toMatchObject({ state: "ok", checkouts: [{ key, root: TREE_ROOT }] });
		expect(await reader.status(UNKNOWN_KEY)).toEqual({ state: "unavailable", reason: "unknown-checkout" });
	});

	test("a planning_sessions checkout filter names only the matching entry, and an unknown key is unavailable", async () => {
		const tree = seededTree();
		const backend = new RecordingPresenceBackend();
		const reader = readerOver(tree, { presence: new DragonflyPresenceStore(backend) });
		const key = planningSessionId(tree, TREE_ROOT);
		expect(await reader.sessions(key)).toMatchObject({ state: "ok", checkouts: [{ key, root: TREE_ROOT }] });
		expect(await reader.sessions(UNKNOWN_KEY)).toMatchObject({ state: "unavailable", reason: "unknown-checkout" });
	});
});

describe("planning_sessions planning rows and conflicts (phase 53, SOTA-09)", () => {
	/** A session whose touched pairs are inside the freshness window, with its planning report known at the server's clock. */
	function touching(backend: RecordingPresenceBackend, sessionId: string, touched: Array<[string, string | null]>): SessionRecord {
		return {
			sessionId,
			worktree: `/work/${sessionId}`,
			branch: `gsd/${sessionId}`,
			repo: "owner/name",
			lastHeartbeatMs: backend.clockMs,
			touched: touched.map(([phase, plan]) => ({ phase, plan, observedAtMs: backend.clockMs })),
			planning: { status: "known", scannedAtMs: backend.clockMs, phases: [] },
		};
	}

	function planningOf(view: PlanningSessionsView, sessionId: string) {
		if (view.state !== "ok") throw new Error(`planning_sessions is ${view.state}`);
		return onlyView(view).sessions.find((row) => row.sessionId === sessionId)?.planning;
	}

	test("two known sessions on one phase are one open conflict, and the read writes nothing", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, touching(backend, "alpha", [["53", "53-01"]]));
		storeSession(backend, touching(backend, "beta", [["53", "53-01"]]));
		const reader = readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) });
		expect(await reader.sessions()).toMatchObject({
			state: "ok",
			checkouts: [{ view: { conflicts: [{ key: { by: "phase", phase: "53" }, plans: ["53-01"], sessionIds: ["alpha", "beta"], status: "open" }] } }],
		});
		expect(backend.writes).toEqual([]);
	});

	test("a touched pair older than the freshness window no longer conflicts, and the read writes nothing", async () => {
		const backend = new RecordingPresenceBackend();
		const old = { ...touching(backend, "alpha", [["53", "53-01"]]), touched: [{ phase: "53", plan: "53-01", observedAtMs: backend.clockMs - 90_001 }] };
		storeSession(backend, old);
		storeSession(backend, touching(backend, "beta", [["53", "53-01"]]));
		expect(await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions()).toMatchObject({
			state: "ok",
			checkouts: [{ view: { conflicts: [] } }],
		});
		expect(backend.writes).toEqual([]);
	});

	test("sessions of two repositories that touch one phase number do not conflict on the read", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, touching(backend, "alpha", [["53", "53-01"]]));
		storeSession(backend, { ...touching(backend, "beta", [["53", "53-01"]]), repo: "owner/two" });
		expect(await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions()).toMatchObject({
			state: "ok",
			checkouts: [{ view: { conflicts: [] } }],
		});
	});

	test("a session in a watcher gap is unknown in its row and takes no part in conflict detection", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, { ...touching(backend, "alpha", [["52", null]]), planning: { status: "unknown", scannedAtMs: backend.clockMs, reason: "scan-truncated" } });
		storeSession(backend, touching(backend, "beta", [["52", "52-01"]]));
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		expect(view).toMatchObject({ state: "ok", checkouts: [{ view: { conflicts: [] } }] });
		expect(planningOf(view as PlanningSessionsView, "alpha")).toEqual({ state: "unknown", reason: "scan-truncated" });
	});

	test("a report older than the freshness window is unknown as stale in its row", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, touching(backend, "alpha", [["52", "52-01"]]));
		backend.clockMs += 90_001;
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		expect(planningOf(view as PlanningSessionsView, "alpha")).toEqual({ state: "unknown", reason: "scan-stale" });
	});
});
