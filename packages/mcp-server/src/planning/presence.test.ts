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
	livenessOf,
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

describe("liveness: a session is alive while it heartbeats, and idle for as long as nothing changed", () => {
	const HOUR_MS = 3_600_000;

	test("a record with no liveness field reads as before: its change heartbeat is its liveness, and idle equals age", () => {
		// One millisecond past the window: the existing rule is "stale only when the age is greater than the TTL", so exactly the TTL is still active.
		const [old] = classifySessions([session("old-format", 9_999)], 100_000, TTL_MS);
		expect(SessionRecordSchema.safeParse(session("old-format", 9_999)).success).toBe(true);
		expect(old).toMatchObject({ status: "stale", ageMs: 90_001, idleForMs: 90_001 });
	});

	test("a session whose last change was 26 hours ago is active while its liveness is fresh, and reports how long it has been idle", () => {
		const now = 100 * HOUR_MS;
		const record: SessionRecord = { ...session("quiet", now - 26 * HOUR_MS), livenessMs: now - 15_000 };
		const [classified] = classifySessions([record], now, TTL_MS);
		expect(classified).toMatchObject({ status: "active", ageMs: 15_000, idleForMs: 26 * HOUR_MS });
	});

	test("the same session turns stale once its liveness is older than the TTL, whatever its change time", () => {
		const now = 100 * HOUR_MS;
		const record: SessionRecord = { ...session("gone", now - 26 * HOUR_MS), livenessMs: now - TTL_MS - 1 };
		expect(classifySessions([record], now, TTL_MS)[0]).toMatchObject({ status: "stale", ageMs: TTL_MS + 1 });
		// Exactly the TTL old is still active, as a change heartbeat exactly the TTL old is.
		expect(classifySessions([{ ...record, livenessMs: now - TTL_MS }], now, TTL_MS)[0]?.status).toBe("active");
	});

	test("a liveness time older than the change time does not make a session older than its last change", () => {
		const record: SessionRecord = { ...session("odd", 95_000), livenessMs: 1_000 };
		expect(classifySessions([record], 100_000, TTL_MS)[0]).toMatchObject({ status: "active", ageMs: 5_000, idleForMs: 5_000 });
	});

	test("a negative or fractional liveness time is not a valid record", () => {
		expect(SessionRecordSchema.safeParse({ ...session("worker-a", 1), livenessMs: -1 }).success).toBe(false);
		expect(SessionRecordSchema.safeParse({ ...session("worker-a", 1), livenessMs: 1.5 }).success).toBe(false);
	});

	test("livenessOf is the later of the change heartbeat and the liveness time", () => {
		expect(livenessOf({ lastHeartbeatMs: 5, livenessMs: 9 })).toBe(9);
		expect(livenessOf({ lastHeartbeatMs: 9, livenessMs: 5 })).toBe(9);
		expect(livenessOf({ lastHeartbeatMs: 9 })).toBe(9);
	});
});
