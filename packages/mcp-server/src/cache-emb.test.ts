/**
 * The `emb` cache class (phase 64): generation-free entries keyed by a content digest, read many at a time and
 * always written with a TTL. A fake Redis stands in for Dragonfly; the class's shape check is the guard against a
 * truncated or foreign value being read back as a vector.
 */
import { describe, expect, test } from "bun:test";
import { CACHE_CLASSES, CACHE_TTL, EMB_MAX_DIM, ReadThroughCache, classOf, digestKey, type CacheRedis, type CacheSample } from "./cache.ts";

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly ttls = new Map<string, number>();
	mgets: string[][] = [];
	fail = false;

	async get(key: string): Promise<string | null> {
		if (this.fail) throw new Error("connect refused");
		return this.values.get(key) ?? null;
	}

	async mget(keys: readonly string[]): Promise<Array<string | null>> {
		if (this.fail) throw new Error("connect refused");
		this.mgets.push([...keys]);
		return keys.map((key) => this.values.get(key) ?? null);
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		if (this.fail) throw new Error("connect refused");
		this.values.set(key, value);
		this.ttls.set(key, ttlSeconds);
	}

	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

/** Three Float32 values, four bytes each: twelve bytes, sixteen base64 characters. */
const THREE = { dim: 3, b64: Buffer.from(new Float32Array([0.5, -1, 2]).buffer).toString("base64") };

function cacheOf(redis: FakeRedis, samples: CacheSample[] = []): ReadThroughCache {
	return new ReadThroughCache({ redis, enabled: true, log: () => {}, record: (sample) => samples.push(sample) });
}

describe("the emb cache class", () => {
	test("is a closed class with a default TTL, and its keys name it", () => {
		expect(CACHE_CLASSES).toContain("emb");
		expect(CACHE_TTL.emb).toBe(604_800);
		expect(classOf(digestKey("emb", "abc"))).toBe("emb");
		expect(digestKey("emb", "abc")).toBe("substrate:v1:emb:abc");
	});

	test("putEntry writes under the digest key with exactly the TTL it was given, and peekMany reads it back", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		expect(await cache.putEntry("emb", "d1", THREE, 3600)).toBe(true);
		expect(redis.ttls.get("substrate:v1:emb:d1")).toBe(3600);
		expect(await cache.peekMany("emb", ["d1"])).toEqual([THREE]);
	});

	test("a TTL under one second writes nothing, so no entry is ever stored without an expiry", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		expect(await cache.putEntry("emb", "d1", THREE, 0)).toBe(false);
		expect(await cache.putEntry("emb", "d1", THREE, 0.5)).toBe(false);
		expect(redis.values.size).toBe(0);
	});

	test("peekMany reads every digest in one MGET and answers in order, null for a miss", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		await cache.putEntry("emb", "a", THREE, 60);
		await cache.putEntry("emb", "c", THREE, 60);
		const answered = await cache.peekMany("emb", ["a", "b", "c"]);
		expect(answered).toEqual([THREE, null, THREE]);
		expect(redis.mgets).toEqual([["substrate:v1:emb:a", "substrate:v1:emb:b", "substrate:v1:emb:c"]]);
		expect(cache.health()).toMatchObject({ hits: 2, misses: 1 });
	});

	test("a value that fails the class shape is a miss and counts as an error, never a vector", async () => {
		const redis = new FakeRedis();
		const samples: CacheSample[] = [];
		const cache = cacheOf(redis, samples);
		const bad: unknown[] = [
			{ dim: 3, b64: THREE.b64.slice(0, -4) },
			{ dim: 4, b64: THREE.b64 },
			{ dim: 0, b64: "" },
			{ dim: 1.5, b64: THREE.b64 },
			{ dim: EMB_MAX_DIM + 1, b64: THREE.b64 },
			{ dim: 3, b64: `${THREE.b64.slice(0, -4)}!!!!` },
			{ dim: 3 },
			{ b64: THREE.b64 },
			[THREE.b64],
			"text",
		];
		for (const [index, value] of bad.entries()) redis.values.set(digestKey("emb", `bad${index}`), JSON.stringify({ v: value }));
		redis.values.set(digestKey("emb", "notjson"), "{not json");
		const digests = [...bad.map((_, index) => `bad${index}`), "notjson"];
		const answered = await cache.peekMany("emb", digests);
		expect(answered.every((entry) => entry === null)).toBe(true);
		expect(samples.filter((sample) => sample.result === "error" && sample.cacheClass === "emb")).toHaveLength(digests.length);
	});

	test("putEntry refuses a value of the wrong shape and stores nothing", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		expect(await cache.putEntry("emb", "d1", { dim: 3, b64: "AAAA" }, 60)).toBe(false);
		expect(await cache.putEntry("emb", "d2", "text", 60)).toBe(false);
		expect(redis.values.size).toBe(0);
	});

	test("a failing server answers all null for a read and false for a write, and never throws", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const cache = cacheOf(redis);
		expect(await cache.peekMany("emb", ["a", "b"])).toEqual([null, null]);
		expect(await cache.putEntry("emb", "a", THREE, 60)).toBe(false);
		expect(cache.health().errors).toBeGreaterThan(0);
	});

	test("a cache that is off answers all null and writes nothing", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis: null, enabled: false, log: () => {} });
		expect(await cache.peekMany("emb", ["a"])).toEqual([null]);
		expect(await cache.peekMany("emb", [])).toEqual([]);
		expect(await cache.putEntry("emb", "a", THREE, 60)).toBe(false);
		expect(redis.values.size).toBe(0);
	});
});
