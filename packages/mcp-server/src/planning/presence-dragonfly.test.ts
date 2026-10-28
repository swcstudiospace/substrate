/**
 * The Dragonfly presence adapter over a fake backend with a settable server clock. Covered: the heartbeat is stamped
 * with the server's time, the key expires with the retention window, a session past its freshness window is stale and
 * still listed, the listing never exceeds its bound, a key gone before its read is skipped, and a corrupt value fails
 * the listing by name.
 */
import { describe, expect, test } from "bun:test";
import { DeadlineError } from "../deadline.ts";
import {
	DragonflyPresenceStore,
	PRESENCE_KEY_PREFIX,
	PRESENCE_MARGIN_MAX_S,
	PRESENCE_MARGIN_MIN_S,
	PRESENCE_MAX_SESSIONS,
	PRESENCE_RETENTION_MAX_S,
	PRESENCE_TTL_MAX_S,
	presenceMarginS,
	presenceRetentionS,
	type PresenceBackend,
} from "./presence-dragonfly.ts";
import { classifySessions, type SessionRecord } from "./presence.ts";

class FakeBackend implements PresenceBackend {
	readonly values = new Map<string, string>();
	/** The server-side `EX` deadline of each key, in server milliseconds. */
	readonly deadlines = new Map<string, number>();
	readonly expiries: Array<{ key: string; ttlSeconds: number }> = [];
	/** Extra keys the enumeration reports though nothing is stored under them, as if they expired after the walk. */
	readonly ghostKeys: string[] = [];
	/** The server's clock. Tests move it forward to age a heartbeat without touching the host clock. */
	serverNow = 1_000_000;

	/** Every key read, in order: a duplicated enumeration must not read a key twice. */
	readonly gets: string[] = [];

	/** A key is live until its `EX` deadline on the server clock, as the server would have it. */
	private live(key: string): boolean {
		const deadline = this.deadlines.get(key);
		return deadline === undefined || deadline > this.serverNow;
	}

	async get(key: string): Promise<string | null> {
		this.gets.push(key);
		if (!this.live(key)) return null;
		return this.values.get(key) ?? null;
	}

	async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.values.set(key, value);
		this.deadlines.set(key, this.serverNow + ttlSeconds * 1000);
		this.expiries.push({ key, ttlSeconds });
	}

	/** Reports every live matching key and ignores `limit`, so the store's own bound is what the tests prove. */
	async scanPrefix(prefix: string): Promise<{ keys: string[]; truncated: boolean }> {
		const live = [...this.values.keys()].filter((key) => this.live(key));
		return { keys: [...live, ...this.ghostKeys].filter((key) => key.startsWith(prefix)), truncated: false };
	}

	async serverTimeMs(): Promise<number> {
		return this.serverNow;
	}
}

describe("the key outlives the largest freshness window", () => {
	test("a session written at the maximum freshness window is still listed after that window closes, and reports stale", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		const ttlMs = PRESENCE_TTL_MAX_S * 1000;
		await store.touch(session("long-window"), ttlMs);
		backend.serverNow += ttlMs + 1_000;
		const listing = await store.listWithin(10);
		const classified = classifySessions(listing.records, await store.serverNowMs(), ttlMs);
		expect(classified.map((entry) => [entry.sessionId, entry.status])).toEqual([["long-window", "stale"]]);
	});

	test("the key is gone only once the retention closes", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("long-window"), PRESENCE_TTL_MAX_S * 1000);
		backend.serverNow += (PRESENCE_RETENTION_MAX_S - 1) * 1000;
		expect((await store.listWithin(10)).records).toHaveLength(1);
		backend.serverNow += 1_000;
		expect((await store.listWithin(10)).records).toEqual([]);
	});
});

function session(sessionId: string, lastHeartbeatMs = 1): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: `gsd/${sessionId}`, lastHeartbeatMs };
}

describe("DragonflyPresenceStore.touch", () => {
	test("the key expires with the retention window, not the freshness window", async () => {
		const backend = new FakeBackend();
		await new DragonflyPresenceStore(backend).touch(session("worker-a"), 90_000);
		expect(backend.expiries.map((entry) => entry.ttlSeconds)).toEqual([presenceRetentionS(90_000)]);
	});

	test("the heartbeat stored is the server's time, whatever the caller sent", async () => {
		const backend = new FakeBackend();
		backend.serverNow = 5_000_000;
		await new DragonflyPresenceStore(backend).touch(session("worker-a", 7), 90_000);
		expect(JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}worker-a`) ?? "null")).toEqual(session("worker-a", 5_000_000));
	});

	test("the key is the prefix and the session id", async () => {
		const backend = new FakeBackend();
		await new DragonflyPresenceStore(backend).touch(session("worker-a"), 90_000);
		expect(backend.expiries[0]?.key).toBe(`${PRESENCE_KEY_PREFIX}worker-a`);
	});

	test("an invalid record, a non-positive freshness window, or one longer than the settings allow is refused before any write", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await expect(store.touch(session("bad key!"), 90_000)).rejects.toThrow();
		await expect(store.touch(session("worker-a"), 0)).rejects.toThrow(RangeError);
		await expect(store.touch(session("worker-a"), PRESENCE_TTL_MAX_S * 1000 + 1)).rejects.toThrow(RangeError);
		expect(backend.expiries).toEqual([]);
	});
});

describe("DragonflyPresenceStore listing", () => {
	test("returns every held record in session-id order", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("zeta"), 90_000);
		await store.touch(session("alpha"), 90_000);
		const records = await store.list();
		expect(records.map((record) => record.sessionId)).toEqual(["alpha", "zeta"]);
	});

	test("a session past its freshness window is stale and still listed", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("drifted"), 90_000);
		backend.serverNow += 120_000;
		const listing = await store.listWithin(10);
		const classified = classifySessions(listing.records, await store.serverNowMs(), 90_000);
		expect(classified.map((entry) => [entry.sessionId, entry.status])).toEqual([["drifted", "stale"]]);
		expect(listing.truncated).toBe(false);
	});

	test("a key SCAN names twice is read once and yields one record", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("alive"), 90_000);
		const key = `${PRESENCE_KEY_PREFIX}alive`;
		backend.ghostKeys.push(key, key);
		backend.gets.length = 0;
		expect(await store.list()).toEqual([{ ...session("alive"), lastHeartbeatMs: backend.serverNow }]);
		expect(backend.gets).toEqual([key]);
	});

	test("a key that expired between the enumeration and its read is skipped, not reported", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("alive"), 90_000);
		backend.ghostKeys.push(`${PRESENCE_KEY_PREFIX}expired`);
		expect((await store.list()).map((record) => record.sessionId)).toEqual(["alive"]);
	});

	test("keys outside the presence prefix are ignored", async () => {
		const backend = new FakeBackend();
		backend.ghostKeys.push("substrate:v1:brief:abc");
		expect(await new DragonflyPresenceStore(backend).list()).toEqual([]);
	});

	test("the listing never reads more sessions than its bound and says it was truncated", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		for (const id of ["s1", "s2", "s3", "s4", "s5"]) await store.touch(session(id), 90_000);
		const listing = await store.listWithin(2);
		expect(listing.records.map((record) => record.sessionId)).toEqual(["s1", "s2"]);
		expect(listing.truncated).toBe(true);
		expect((await store.listWithin(5)).truncated).toBe(false);
	});

	test("list refuses a partial answer when the sessions exceed the bound", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		for (let i = 0; i <= PRESENCE_MAX_SESSIONS; i++) await store.touch(session(`w${i}`), 90_000);
		await expect(store.list()).rejects.toThrow(`more than ${PRESENCE_MAX_SESSIONS} sessions`);
	});

	test("a stored value that is not a session record fails the listing, naming the key and not the value", async () => {
		const backend = new FakeBackend();
		const key = `${PRESENCE_KEY_PREFIX}corrupt`;
		backend.values.set(key, '{"sessionId":"corrupt","secret":"SHOULD-NOT-APPEAR"}');
		const failure = await new DragonflyPresenceStore(backend)
			.list()
			.then(
				() => null,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
		expect(failure).toContain(key);
		expect(failure).not.toContain("SHOULD-NOT-APPEAR");
	});

	test("a stored value that is not JSON fails the listing", async () => {
		const backend = new FakeBackend();
		backend.values.set(`${PRESENCE_KEY_PREFIX}garbled`, "not json");
		await expect(new DragonflyPresenceStore(backend).list()).rejects.toThrow("is not JSON");
	});

	test("a limit that is not a positive integer is refused", async () => {
		await expect(new DragonflyPresenceStore(new FakeBackend()).listWithin(0)).rejects.toThrow(RangeError);
	});
});

/** Scans the given keys and holds its first `get` until `releaseStalled` is called. Every backend call is logged in order. */
class StallingBackend implements PresenceBackend {
	readonly calls: string[] = [];
	private readonly gate = Promise.withResolvers<void>();
	private stalled = false;

	constructor(private readonly keys: string[]) {}

	async get(key: string): Promise<string | null> {
		this.calls.push(`get ${key}`);
		if (!this.stalled) {
			this.stalled = true;
			await this.gate.promise;
		}
		return null;
	}

	async setWithTtl(): Promise<void> {
		throw new Error("the listing never writes");
	}

	async scanPrefix(prefix: string): Promise<{ keys: string[]; truncated: boolean }> {
		this.calls.push("scan");
		return { keys: this.keys.filter((key) => key.startsWith(prefix)), truncated: false };
	}

	async serverTimeMs(): Promise<number> {
		return 0;
	}

	releaseStalled(): void {
		this.gate.resolve();
	}
}

describe("DragonflyPresenceStore listing budget", () => {
	test("a listing that misses its budget rejects with a DeadlineError and starts no further read", async () => {
		const backend = new StallingBackend([`${PRESENCE_KEY_PREFIX}a`, `${PRESENCE_KEY_PREFIX}b`, `${PRESENCE_KEY_PREFIX}c`]);
		await expect(new DragonflyPresenceStore(backend).listWithin(PRESENCE_MAX_SESSIONS, 50)).rejects.toBeInstanceOf(DeadlineError);
		const callsAtRejection = backend.calls.length;
		backend.releaseStalled();
		// A macrotask runs only after every pending microtask, so the abandoned listing has settled by the time it resolves.
		const flushed = Promise.withResolvers<void>();
		setImmediate(flushed.resolve);
		await flushed.promise;
		expect(backend.calls).toHaveLength(callsAtRejection);
	});
});

describe("the key lifetime is derived from the freshness window, and bounded", () => {
	test("the margin is twice the window, held between five minutes and a day", () => {
		expect(presenceMarginS(1)).toBe(PRESENCE_MARGIN_MIN_S);
		expect(presenceMarginS(90)).toBe(300);
		expect(presenceMarginS(150)).toBe(300);
		expect(presenceMarginS(151)).toBe(302);
		expect(presenceMarginS(3_600)).toBe(7_200);
		expect(presenceMarginS(43_200)).toBe(PRESENCE_MARGIN_MAX_S);
		expect(presenceMarginS(PRESENCE_TTL_MAX_S)).toBe(PRESENCE_MARGIN_MAX_S);
	});

	test("the retention is the window rounded up plus its margin, and is not a fixed hour", () => {
		expect(presenceRetentionS(90_000)).toBe(90 + 300);
		expect(presenceRetentionS(1)).toBe(1 + 300);
		expect(presenceRetentionS(1_001)).toBe(2 + 300);
		expect(presenceRetentionS(3_600_000)).toBe(3_600 + 7_200);
		expect(presenceRetentionS(90_000)).not.toBe(90 + 3_600);
	});

	test("every allowed window leaves a margin, never decreases, and stays within the bound", () => {
		let previous = 0;
		for (let ttlS = 1; ttlS <= PRESENCE_TTL_MAX_S; ttlS += 7) {
			const retention = presenceRetentionS(ttlS * 1000);
			expect(retention - ttlS).toBeGreaterThanOrEqual(PRESENCE_MARGIN_MIN_S);
			expect(retention - ttlS).toBeLessThanOrEqual(PRESENCE_MARGIN_MAX_S);
			expect(retention).toBeGreaterThanOrEqual(previous);
			expect(retention).toBeLessThanOrEqual(PRESENCE_RETENTION_MAX_S);
			previous = retention;
		}
		expect(presenceRetentionS(PRESENCE_TTL_MAX_S * 1000)).toBe(PRESENCE_RETENTION_MAX_S);
		expect(PRESENCE_RETENTION_MAX_S).toBe(2 * 86_400);
	});

	test("a window that is not positive, not finite, or longer than the settings allow is refused", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, PRESENCE_TTL_MAX_S * 1000 + 1]) {
			expect(() => presenceRetentionS(bad)).toThrow(RangeError);
		}
	});

	test("a session written at a short window is listed stale until its derived retention closes, then gone", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("short-window"), 90_000);
		backend.serverNow += (presenceRetentionS(90_000) - 1) * 1000;
		const listing = await store.listWithin(10);
		expect(classifySessions(listing.records, await store.serverNowMs(), 90_000).map((entry) => entry.status)).toEqual(["stale"]);
		backend.serverNow += 1_000;
		expect((await store.listWithin(10)).records).toEqual([]);
	});
});

describe("DragonflyPresenceStore.touchLiveness", () => {
	test("it keeps the change time the key held and stamps the liveness with the server's time", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		backend.serverNow = 5_000_000;
		await store.touch(session("worker-a"), 90_000);
		backend.serverNow = 5_060_000;
		await store.touchLiveness(session("worker-a", 0), 90_000);
		expect(JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}worker-a`) ?? "null")).toEqual({ ...session("worker-a", 5_000_000), livenessMs: 5_060_000 });
	});

	test("a key that holds nothing takes the server's time as its change time, and a value that is not a record is replaced", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		backend.serverNow = 7_000_000;
		await store.touchLiveness(session("fresh"), 90_000);
		expect(JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}fresh`) ?? "null")).toEqual({ ...session("fresh", 7_000_000), livenessMs: 7_000_000 });

		backend.values.set(`${PRESENCE_KEY_PREFIX}garbled`, "not json");
		await store.touchLiveness(session("garbled"), 90_000);
		expect(await store.list()).toHaveLength(2);
	});

	test("a record in the old format, with no liveness, keeps its change time under a liveness write", async () => {
		const backend = new FakeBackend();
		backend.values.set(`${PRESENCE_KEY_PREFIX}legacy`, JSON.stringify(session("legacy", 4_000_000)));
		backend.serverNow = 4_030_000;
		const store = new DragonflyPresenceStore(backend);
		expect((await store.list())[0]).toEqual(session("legacy", 4_000_000));
		expect(classifySessions(await store.list(), backend.serverNow, 90_000)[0]).toMatchObject({ status: "active", ageMs: 30_000, idleForMs: 30_000 });

		await store.touchLiveness(session("legacy", 0), 90_000);
		expect((await store.list())[0]).toMatchObject({ lastHeartbeatMs: 4_000_000, livenessMs: 4_030_000 });
	});

	test("a change heartbeat after a liveness write drops the liveness field: its own time is the liveness", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		backend.serverNow = 1_000_000;
		await store.touchLiveness(session("worker-a"), 90_000);
		backend.serverNow = 1_020_000;
		await store.touch({ ...session("worker-a"), livenessMs: 1 }, 90_000);
		const stored = JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}worker-a`) ?? "null");
		expect(stored).toEqual(session("worker-a", 1_020_000));
		expect("livenessMs" in stored).toBe(false);
	});

	test("a session that heartbeats every 15 s for 30 simulated hours stays listed and active with its change time unmoved, then goes stale when the beats stop", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		const ttlMs = 90_000;
		const startMs = backend.serverNow;
		await store.touch(session("long-runner"), ttlMs);
		for (let beat = 1; beat <= (30 * 3_600) / 15; beat++) {
			backend.serverNow += 15_000;
			await store.touchLiveness(session("long-runner", 0), ttlMs);
		}
		const [alive] = classifySessions(await store.list(), backend.serverNow, ttlMs);
		expect(alive).toMatchObject({ status: "active", ageMs: 0, idleForMs: 30 * 3_600_000, lastHeartbeatMs: startMs });

		backend.serverNow += ttlMs + 1;
		const [silent] = classifySessions(await store.list(), backend.serverNow, ttlMs);
		expect(silent).toMatchObject({ status: "stale", ageMs: ttlMs + 1 });
	});

	test("a refused window or record fails before any command is sent", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await expect(store.touchLiveness(session("bad key!"), 90_000)).rejects.toThrow();
		await expect(store.touchLiveness(session("worker-a"), 0)).rejects.toThrow(RangeError);
		await expect(store.touchLiveness(session("worker-a"), PRESENCE_TTL_MAX_S * 1000 + 1)).rejects.toThrow(RangeError);
		expect(backend.expiries).toEqual([]);
		expect(backend.gets).toEqual([]);
	});
});
