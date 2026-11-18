/**
 * A failed presence write is visible in the session view (phase 54, SOTA-10). The store records the code of the latest write that
 * failed; the view reads DEGRADED while it is set; the next write that lands clears it. The observer's own heartbeats go through the
 * same store, so the scan test below shows the observer's failed heartbeat reaching the view. In-memory tree and recording backend.
 */
import { describe, expect, test } from "bun:test";
import { RecordingPresenceBackend } from "./backend.fixtures.ts";
import { DEFAULT_PRESENCE_TTL_S, PLANNING_ROOT_ENV, loadPlanningSettings } from "./config.ts";
import { PlanningObserver } from "./observer.ts";
import { DragonflyPresenceStore } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";
import { PlanningReader } from "./read.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

const TTL_MS = DEFAULT_PRESENCE_TTL_S * 1000;
const PHASE = `${TREE_ROOT}/.planning/phases/52-planning-awareness-core`;
const BRANCH = "gsd/p52-wiring";
const GIT: Record<string, string> = {
	[`${TREE_ROOT}/.git/config`]: `[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n`,
	[`${TREE_ROOT}/.git/HEAD`]: `ref: refs/heads/${BRANCH}\n`,
};
const CLOCK = (): Date => new Date("2026-10-22T12:00:00.000Z");

/** A backend whose writes are refused while `refusesWrites` is set. The reads and the clock keep working. */
class RefusingWritesBackend extends RecordingPresenceBackend {
	refusesWrites = false;

	override async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		if (this.refusesWrites) throw new Error("SET refused");
		return super.setWithTtl(key, value, ttlSeconds);
	}
}

function session(sessionId: string): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: BRANCH, lastHeartbeatMs: 0 };
}

function readerOver(tree: FakeTree, presence: DragonflyPresenceStore): PlanningReader {
	return new PlanningReader({ settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }), fs: tree, presence });
}

describe("the presence store's last write", () => {
	test("a refused write is reported with its code, and the next write that lands clears it", async () => {
		const backend = new RefusingWritesBackend();
		const store = new DragonflyPresenceStore(backend);
		expect(store.lastWriteFailure()).toBeNull();

		backend.refusesWrites = true;
		await expect(store.touch(session("wt-a"), TTL_MS)).rejects.toThrow("SET refused");
		expect(store.lastWriteFailure()).toBe("UNKNOWN");
		await expect(store.touchLiveness(session("wt-a"), TTL_MS)).rejects.toThrow("SET refused");
		expect(store.lastWriteFailure()).toBe("UNKNOWN");

		backend.refusesWrites = false;
		await store.touchLiveness(session("wt-a"), TTL_MS);
		expect(store.lastWriteFailure()).toBeNull();
	});
});

describe("a failed heartbeat write in the session view", () => {
	test("the view is DEGRADED while this server's write is failing, and SUCCESS once a write lands", async () => {
		const tree = new FakeTree({ ...GIT });
		const backend = new RefusingWritesBackend();
		const store = new DragonflyPresenceStore(backend);
		const reader = readerOver(tree, store);

		backend.refusesWrites = true;
		await expect(store.touch(session("wt-a"), TTL_MS)).rejects.toThrow("SET refused");
		expect(await reader.sessions()).toMatchObject({ state: "ok", sessions: [], view: { state: "DEGRADED" } });

		backend.refusesWrites = false;
		await store.touch(session("wt-a"), TTL_MS);
		expect(await reader.sessions()).toMatchObject({ state: "ok", view: { state: "SUCCESS" } });
	});

	test("an observer whose heartbeat write is refused shows DEGRADED until its heartbeat lands", async () => {
		const tree = new FakeTree({ ...GIT, [`${PHASE}/52-CONTEXT.md`]: "# context\n" });
		const backend = new RefusingWritesBackend();
		const store = new DragonflyPresenceStore(backend);
		const observer = new PlanningObserver({
			settings: loadPlanningSettings({ [PLANNING_ROOT_ENV]: TREE_ROOT }),
			fs: tree,
			presence: store,
			originUrl: async () => ({ kind: "unavailable" }),
			emit: async () => true,
			metrics: { name: "greptime", emit: async () => ({ ok: true }) },
			fallback: { name: "stdout", emit: async () => ({ ok: true }) },
			clock: CLOCK,
		});
		const reader = readerOver(tree, store);

		await observer.scan();
		tree.setContent(`${PHASE}/52-CONTEXT.md`, "# context, edited\n");
		backend.refusesWrites = true;
		expect(await observer.scan()).toMatchObject({ outcome: "published", heartbeat: { state: "failed" } });
		expect(await reader.sessions()).toMatchObject({ view: { state: "DEGRADED" } });

		backend.refusesWrites = false;
		expect(await observer.scan()).toMatchObject({ heartbeat: { state: "written" } });
		expect(store.lastWriteFailure()).toBeNull();
		expect(await reader.sessions()).toMatchObject({ view: { state: "SUCCESS" } });
	});
});
