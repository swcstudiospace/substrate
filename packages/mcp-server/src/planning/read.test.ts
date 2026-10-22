/**
 * The planning reads over an in-memory tree and a recording presence backend (phase 52, SOTA-08). Both reads answer typed
 * results, and neither writes anything: no presence heartbeat, no ledger note, no file, on the first call or any later one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { PLANNING_MAX_FILES_ENV, PLANNING_ROOT_ENV, loadPlanningSettings } from "./config.ts";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";
import { PlanningReader } from "./read.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const P = `${TREE_ROOT}/.planning`;
const PHASE = `${P}/phases/52-planning-awareness-core`;
const BODY = "BODY-SECRET-TEXT";
const FRONTMATTER_SECRET = "FM-SECRET-VALUE";

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
	const env = options.root === null ? {} : { [PLANNING_ROOT_ENV]: options.root ?? TREE_ROOT };
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
	return { sessionId, worktree: `/work/${sessionId}`, branch: "gsd/p52-wiring", activePhase: null, lastHeartbeatMs };
}

describe("planning_status", () => {
	test("counts, hashes and the error record are reported, and no file body or frontmatter value is", async () => {
		const view = await readerOver(seededTree()).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(view.counts).toEqual({ documents: 2, errors: 1, byKind: { phase: 2 } });
		expect(view.documents.find((row) => row.path.endsWith("52-CONTEXT.md"))?.sha256).toBe(sha256(`${BODY} context\n`));
		expect(view.errors).toEqual([expect.objectContaining({ path: ".planning/phases/52-planning-awareness-core/BAD.md", code: "malformed-frontmatter" })]);
		const text = JSON.stringify(view);
		expect(text).not.toContain(BODY);
		expect(text).not.toContain(FRONTMATTER_SECRET);
	});

	test("an unset root answers disabled, never an error", async () => {
		expect(await readerOver(seededTree(), { root: null }).status()).toEqual({ state: "disabled", reason: "root-unset" });
	});

	test("a relative root answers misconfigured, naming the key and never the value", async () => {
		const view = await readerOver(seededTree(), { root: "relative/checkout" }).status();
		expect(view.state).toBe("misconfigured");
		expect(JSON.stringify(view)).toContain(PLANNING_ROOT_ENV);
		expect(JSON.stringify(view)).not.toContain("relative/checkout");
	});

	test("a root that does not exist answers unavailable with the failure code", async () => {
		expect(await readerOver(new FakeTree({})).status()).toEqual({ state: "unavailable", code: "root-unavailable" });
	});

	test("a truncated index says so and holds the first documents by path", async () => {
		const settings = loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT, [PLANNING_MAX_FILES_ENV]: "1" });
		const view = await new PlanningReader({ settings, fs: seededTree(), presence: null }).status();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(view.truncated).toBe(true);
		expect(view.documents.map((row) => row.path)).toEqual([".planning/phases/52-planning-awareness-core/52-CONTEXT.md"]);
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
		expect(view.clock).toEqual({ state: "server" });
		expect(view.sessions.map((row) => [row.sessionId, row.status, row.ageMs])).toEqual([
			["wt-fresh", "active", 10_000],
			["wt-old", "stale", 200_000],
		]);
	});

	test("when the server clock cannot be read, sessions are listed as unknown and the reason is given", async () => {
		const backend = new RecordingPresenceBackend();
		storeSession(backend, session("wt-only", backend.clockMs - 1_000));
		backend.clockFails = true;
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(view.clock.state).toBe("unavailable");
		expect(view.sessions).toEqual([expect.objectContaining({ sessionId: "wt-only", status: "unknown", ageMs: null })]);
	});

	test("with no cache endpoint, sessions answer unavailable with presence-backend-unset", async () => {
		expect(await readerOver(seededTree(), { presence: null }).sessions()).toEqual({ state: "unavailable", code: "presence-backend-unset" });
	});

	test("a listing past the bound says it was truncated and holds exactly the bound", async () => {
		const backend = new RecordingPresenceBackend();
		for (let n = 0; n <= PRESENCE_MAX_SESSIONS; n += 1) {
			storeSession(backend, session(`wt-${String(n).padStart(4, "0")}`, backend.clockMs));
		}
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "ok") throw new Error(`expected ok, got ${view.state}`);
		expect(view.truncated).toBe(true);
		expect(view.sessions).toHaveLength(PRESENCE_MAX_SESSIONS);
	});

	test("a corrupt stored session fails the listing as unavailable, naming the key and never the value", async () => {
		const backend = new RecordingPresenceBackend();
		backend.values.set(`${PRESENCE_KEY_PREFIX}wt-bad`, "{not json SECRETVALUE");
		const view = await readerOver(seededTree(), { presence: new DragonflyPresenceStore(backend) }).sessions();
		if (view.state !== "unavailable") throw new Error(`expected unavailable, got ${view.state}`);
		expect(view.code).toBe("presence-listing-failed");
		expect(view.detail).toContain("wt-bad");
		expect(JSON.stringify(view)).not.toContain("SECRETVALUE");
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
