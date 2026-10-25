/**
 * Presence: a session past its TTL is stale and still listed, classification removes nothing,
 * and history only grows. The clock is a plain number the test moves.
 */
import { describe, expect, test } from "bun:test";
import {
	InMemoryHistorySink,
	InMemoryPresenceStore,
	SessionRecordSchema,
	classifySessions,
	presenceSnapshot,
	recordHeartbeat,
	type PresenceClock,
	type SessionRecord,
} from "./presence.ts";

const TTL_MS = 90_000;

function session(sessionId: string, lastHeartbeatMs: number): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: `gsd/${sessionId}`, lastHeartbeatMs };
}

function manualClock(start: number): PresenceClock & { advance(ms: number): void } {
	let now = start;
	return {
		serverNowMs: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("classifySessions", () => {
	test("a heartbeat within the TTL is active, one past it is stale, one exactly at the TTL is still active", () => {
		const now = 100_000;
		const classified = classifySessions([session("fresh", 60_000), session("old", 0), session("edge", now - TTL_MS)], now, TTL_MS);
		const status = Object.fromEntries(classified.map((entry) => [entry.sessionId, entry.status]));
		expect(status).toEqual({ fresh: "active", old: "stale", edge: "active" });
	});

	test("classification removes nothing and does not modify its input", () => {
		const input = [session("a", 0), session("b", 95_000)];
		const before = structuredClone(input);
		const classified = classifySessions(input, 100_000, TTL_MS);
		expect(classified).toHaveLength(input.length);
		expect(input).toEqual(before);
	});

	test("output is sorted by session id and carries the age", () => {
		const classified = classifySessions([session("zeta", 90_000), session("alpha", 10_000)], 100_000, TTL_MS);
		expect(classified.map((entry) => entry.sessionId)).toEqual(["alpha", "zeta"]);
		expect(classified.map((entry) => entry.ageMs)).toEqual([90_000, 10_000]);
	});

	test("a non-positive TTL is refused", () => {
		expect(() => classifySessions([], 0, 0)).toThrow(RangeError);
	});
});

describe("InMemoryPresenceStore and presenceSnapshot", () => {
	test("a session past its TTL is stale in the snapshot and still present in list()", async () => {
		const store = new InMemoryPresenceStore();
		const clock = manualClock(0);
		await store.touch(session("worker-a", 0), TTL_MS);
		await store.touch(session("worker-b", 50_000), TTL_MS);

		clock.advance(120_000);
		const snapshot = await presenceSnapshot({ store, clock }, TTL_MS);
		expect(Object.fromEntries(snapshot.map((entry) => [entry.sessionId, entry.status]))).toEqual({
			"worker-a": "stale",
			"worker-b": "active",
		});
		const listed = await store.list();
		expect(listed.map((entry) => entry.sessionId)).toEqual(["worker-a", "worker-b"]);
	});

	test("a second touch replaces the session's record instead of adding one", async () => {
		const store = new InMemoryPresenceStore();
		await store.touch(session("worker-a", 1), TTL_MS);
		await store.touch(session("worker-a", 2), TTL_MS);
		expect(await store.list()).toEqual([session("worker-a", 2)]);
	});
});

describe("HistorySink", () => {
	test("every heartbeat is appended, and nothing already written is ever removed", async () => {
		const store = new InMemoryPresenceStore();
		const history = new InMemoryHistorySink();
		const clock = manualClock(0);

		await recordHeartbeat({ store, history }, session("worker-a", 0), TTL_MS);
		await recordHeartbeat({ store, history }, session("worker-a", 30_000), TTL_MS);
		await recordHeartbeat({ store, history }, session("worker-b", 40_000), TTL_MS);
		const afterWrites = history.entries();
		expect(afterWrites.map((entry) => entry.lastHeartbeatMs)).toEqual([0, 30_000, 40_000]);

		clock.advance(500_000);
		await presenceSnapshot({ store, clock }, TTL_MS);
		await store.list();
		expect(history.entries()).toEqual(afterWrites);
	});

	test("an invalid record is refused before the store or history is touched", async () => {
		const store = new InMemoryPresenceStore();
		const history = new InMemoryHistorySink();
		await expect(recordHeartbeat({ store, history }, session("bad id with spaces", 0), TTL_MS)).rejects.toThrow();
		expect(await store.list()).toEqual([]);
		expect(history.entries()).toEqual([]);
	});

	test("entries returned to the caller cannot change what the sink holds", async () => {
		const history = new InMemoryHistorySink();
		await history.append(session("worker-a", 1));
		history.entries()[0] = session("tampered", 9);
		expect(history.entries()).toEqual([session("worker-a", 1)]);
	});
});

describe("SessionRecordSchema", () => {
	test("accepts a well-formed record and rejects a session id that would be a bad key", () => {
		expect(SessionRecordSchema.safeParse(session("worker-a", 1)).success).toBe(true);
		expect(SessionRecordSchema.safeParse(session("has space", 1)).success).toBe(false);
		expect(SessionRecordSchema.safeParse(session("-leading-dash", 1)).success).toBe(false);
		expect(SessionRecordSchema.safeParse({ ...session("worker-a", 1), lastHeartbeatMs: -1 }).success).toBe(false);
	});

	test("reads activePhase as null, absent, or a phase string, and returns a present value unchanged", () => {
		const withNull = SessionRecordSchema.safeParse({ ...session("worker-a", 1), activePhase: null });
		const absent = SessionRecordSchema.safeParse(session("worker-a", 1));
		const withPhase = SessionRecordSchema.safeParse({ ...session("worker-a", 1), activePhase: "52" });
		expect(withNull.success).toBe(true);
		expect(absent.success).toBe(true);
		expect(withPhase.success).toBe(true);
		expect(withNull.success && withNull.data.activePhase).toBeNull();
		expect(absent.success && "activePhase" in absent.data).toBe(false);
		expect(withPhase.success && withPhase.data.activePhase).toBe("52");
	});
});
