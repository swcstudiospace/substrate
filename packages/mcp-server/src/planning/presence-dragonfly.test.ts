/**
 * The Dragonfly presence adapter over a fake backend: server-side expiry is the TTL written, a key
 * that vanishes between enumeration and read is gone, not stale, and a corrupt value fails loudly.
 */
import { describe, expect, test } from "bun:test";
import { DragonflyPresenceStore, PRESENCE_KEY_PREFIX, type PresenceBackend } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";

class FakeBackend implements PresenceBackend {
	readonly values = new Map<string, string>();
	readonly ttls: Array<{ key: string; ttlSeconds: number }> = [];
	/** Extra keys the enumeration reports even though nothing is stored under them. */
	readonly ghostKeys: string[] = [];

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.values.set(key, value);
		this.ttls.push({ key, ttlSeconds });
	}

	async keysWithPrefix(prefix: string): Promise<string[]> {
		return [...this.values.keys(), ...this.ghostKeys].filter((key) => key.startsWith(prefix));
	}
}

function session(sessionId: string, lastHeartbeatMs = 1): SessionRecord {
	return { sessionId, worktree: `/work/${sessionId}`, branch: `gsd/${sessionId}`, activePhase: "52", lastHeartbeatMs };
}

describe("DragonflyPresenceStore.touch", () => {
	test("the window written is the TTL rounded up to whole seconds, never below one", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("worker-a"), 90_000);
		await store.touch(session("worker-b"), 1);
		await store.touch(session("worker-c"), 90_001);
		expect(backend.ttls.map((entry) => entry.ttlSeconds)).toEqual([90, 1, 91]);
	});

	test("the key is the prefix and the session id, and the value is the record", async () => {
		const backend = new FakeBackend();
		await new DragonflyPresenceStore(backend).touch(session("worker-a", 7), 90_000);
		expect(backend.ttls[0]?.key).toBe(`${PRESENCE_KEY_PREFIX}worker-a`);
		expect(JSON.parse(backend.values.get(`${PRESENCE_KEY_PREFIX}worker-a`) ?? "null")).toEqual(session("worker-a", 7));
	});

	test("an invalid record or a non-positive TTL is refused before anything is written", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await expect(store.touch(session("bad key!"), 90_000)).rejects.toThrow();
		await expect(store.touch(session("worker-a"), 0)).rejects.toThrow(RangeError);
		expect(backend.ttls).toEqual([]);
	});
});

describe("DragonflyPresenceStore.list", () => {
	test("returns every live record in session-id order", async () => {
		const backend = new FakeBackend();
		const store = new DragonflyPresenceStore(backend);
		await store.touch(session("zeta"), 90_000);
		await store.touch(session("alpha"), 90_000);
		expect(await store.list()).toEqual([session("alpha"), session("zeta")]);
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

	test("a stored value that is not a session record fails the listing, naming the key and not the value", async () => {
		const backend = new FakeBackend();
		const key = `${PRESENCE_KEY_PREFIX}corrupt`;
		backend.values.set(key, '{"sessionId":"corrupt","secret":"SHOULD-NOT-APPEAR"}');
		const failure = await new DragonflyPresenceStore(backend).list().then(
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
});
