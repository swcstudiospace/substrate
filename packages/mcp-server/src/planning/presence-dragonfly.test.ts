/**
 * The Dragonfly presence adapter over a fake backend with a settable server clock. Covered: the heartbeat is stamped
 * with the server's time, the key expires with the retention window, a session past its freshness window is stale and
 * still listed, the listing never exceeds its bound, a key gone before its read is skipped, and a corrupt value fails
 * the listing by name.
 */
import { describe, expect, test } from "bun:test";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, PRESENCE_MAX_SESSIONS, PRESENCE_RETENTION_S, type PresenceBackend } from "./presence-dragonfly.ts";
import { classifySessions, type SessionRecord } from "./presence.ts";

class FakeBackend implements PresenceBackend {
	readonly values = new Map<string, string>();
	readonly expiries: Array<{ key: string; ttlSeconds: number }> = [];
	/** Extra keys the enumeration reports though nothing is stored under them, as if they expired after the walk. */
	readonly ghostKeys: string[] = [];
	/** The server's clock. Tests move it forward to age a heartbeat without touching the host clock. */
	serverNow = 1_000_000;

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.values.set(key, value);
		this.expiries.push({ key, ttlSeconds });
	}

	/** Reports every matching key and ignores `limit`, so the store's own bound is what the tests prove. */
	async scanPrefix(prefix: string): Promise<{ keys: string[]; truncated: boolean }> {
		return { keys: [...this.values.keys(), ...this.ghostKeys].filter((key) => key.startsWith(prefix)), truncated: false };
	}

	async serverTimeMs(): Promise<number> {
		return this.serverNow;
	}
}

function session(sessionId: string, lastHeartbeatMs = 1): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: `gsd/${sessionId}`, activePhase: "52", lastHeartbeatMs };
}

describe("DragonflyPresenceStore.touch", () => {
	test("the key expires with the retention window, not the freshness window", async () => {
		const backend = new FakeBackend();
		await new DragonflyPresenceStore(backend).touch(session("worker-a"), 90_000);
		expect(backend.expiries.map((entry) => entry.ttlSeconds)).toEqual([PRESENCE_RETENTION_S]);
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

	test("an invalid record, a non-positive freshness window, or one longer than the retention is refused before any write", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await expect(store.touch(session("bad key!"), 90_000)).rejects.toThrow();
		await expect(store.touch(session("worker-a"), 0)).rejects.toThrow(RangeError);
		await expect(store.touch(session("worker-a"), PRESENCE_RETENTION_S * 1000 + 1)).rejects.toThrow(RangeError);
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
