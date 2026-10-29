/**
 * The embedding service: the real TEI client over a fake server, behind the real read-through cache over a fake
 * Redis. The assertions are about what reaches TEI and what reaches Redis: which texts were sent, which keys were
 * written with which TTL, and that no cache failure ever changes the answer.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PlaneFetch } from "@substrate/observability";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import type { TeiConfig } from "./config.ts";
import { createEmbeddingService, decodeVector, embeddingDigest, encodeVector, type EmbeddingCacheStore } from "./embed.ts";
import { MAX_TEXT_CHARS, createTeiClient, type TeiEmbedResult } from "./planes/tei.ts";
import { defined } from "./test-support.ts";

const TTL = 1234;
const PINNED: TeiConfig = { url: "http://tei.test:8080", timeoutMs: 10_000, batch: 32, model: "test-model", dim: 4 };
const UNPINNED: TeiConfig = { url: "http://tei.test:8080", timeoutMs: 10_000, batch: 32 };

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly sets: Array<{ key: string; ttl: number }> = [];
	mgets = 0;
	fail = false;

	async get(key: string): Promise<string | null> {
		if (this.fail) throw new Error("connect refused");
		return this.values.get(key) ?? null;
	}

	async mget(keys: readonly string[]): Promise<Array<string | null>> {
		this.mgets += 1;
		if (this.fail) throw new Error("connect refused");
		return keys.map((key) => this.values.get(key) ?? null);
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		if (this.fail) throw new Error("connect refused");
		this.values.set(key, value);
		this.sets.push({ key, ttl: ttlSeconds });
	}

	async incr(): Promise<number> {
		return 1;
	}
}

function inputsOf(raw: unknown): string[] {
	const body: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
	if (body !== null && typeof body === "object" && "inputs" in body && Array.isArray(body.inputs)) {
		return body.inputs.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

interface FakeTei {
	/** The texts of every `/embed` request, in order. */
	embeds: string[][];
	state: { embedStatus: number };
	fetch: PlaneFetch;
}

/** A fake TEI. Vectors are not round numbers, so a Float32 round trip is a real test. */
function fakeTei(options: { model?: string; dim?: number } = {}): FakeTei {
	const dim = options.dim ?? 4;
	const embeds: string[][] = [];
	const state = { embedStatus: 200 };
	const fetchImpl: PlaneFetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/info") return Response.json({ model_id: options.model ?? "test-model", max_client_batch_size: 64 });
		if (path === "/embed") {
			if (state.embedStatus !== 200) return new Response("", { status: state.embedStatus });
			const inputs = inputsOf(init?.body);
			embeds.push(inputs);
			return Response.json(inputs.map((text) => Array.from({ length: dim }, (_, index) => (text.length + index) / 7)));
		}
		return new Response("", { status: 404 });
	};
	return { embeds, state, fetch: fetchImpl };
}

function serviceOf(
	config: TeiConfig | null,
	tei: FakeTei,
	redis: FakeRedis,
	options: { cacheEnabled?: boolean; cache?: EmbeddingCacheStore | null } = {},
) {
	const client = createTeiClient(config, { fetch: tei.fetch, sleep: async () => {}, random: () => 0.5 });
	const cache = options.cache === undefined ? new ReadThroughCache({ redis, enabled: true, log: () => {} }) : options.cache;
	return createEmbeddingService({ client, cache, cacheEnabled: options.cacheEnabled ?? true, ttlS: TTL });
}

function vectorsOf(result: TeiEmbedResult): Float32Array[] {
	if (!result.ok) throw new Error(`embed failed: ${result.reason}`);
	return result.vectors;
}

describe("EmbeddingService with the cache off", () => {
	test("every call goes to TEI and nothing reaches Redis", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis, { cacheEnabled: false });
		await service.embed(["a"]);
		await service.embed(["a"]);
		expect(tei.embeds).toEqual([["a"], ["a"]]);
		expect(redis.mgets).toBe(0);
		expect(redis.sets).toEqual([]);
	});

	test("with no cache store at all it is the client", async () => {
		const tei = fakeTei();
		const service = serviceOf(PINNED, tei, new FakeRedis(), { cache: null });
		expect(vectorsOf(await service.embed(["a", "bb"]))).toHaveLength(2);
		expect(tei.embeds).toEqual([["a", "bb"]]);
	});

	test("an unconfigured service answers not-configured and touches neither TEI nor Redis", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(null, tei, redis);
		expect(await service.embed(["a"])).toEqual({ ok: false, reason: "not-configured" });
		expect(tei.embeds).toEqual([]);
		expect(redis.mgets).toBe(0);
		expect(redis.sets).toEqual([]);
	});
});

describe("EmbeddingService with the cache on", () => {
	test("a miss embeds and stores under the sha256 key with the TTL, and the next call is a hit that sends nothing", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis);
		const first = vectorsOf(await service.embed(["alpha"]));
		const key = `substrate:v1:emb:${createHash("sha256").update("test-model\nalpha").digest("hex")}`;
		expect(redis.sets).toEqual([{ key, ttl: TTL }]);
		const stored: unknown = JSON.parse(defined(redis.values.get(key)));
		expect(stored).toEqual({ v: { dim: 4, b64: Buffer.from(defined(first[0]).buffer).toString("base64") } });
		const second = vectorsOf(await service.embed(["alpha"]));
		expect(tei.embeds).toEqual([["alpha"]]);
		expect(second[0]).toEqual(first[0]);
	});

	test("a partial hit embeds only the misses, in one batch, and answers in the caller's order", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis);
		await service.embed(["a", "b"]);
		const answered = vectorsOf(await service.embed(["a", "ccc", "b", "dddd"]));
		expect(tei.embeds).toEqual([["a", "b"], ["ccc", "dddd"]]);
		expect(answered.map((vector) => Math.round(defined(vector[0]) * 7))).toEqual([1, 3, 1, 4]);
		const fresh = vectorsOf(await createEmbeddingService({ client: createTeiClient(PINNED, { fetch: fakeTei().fetch }), cache: null, cacheEnabled: false, ttlS: TTL }).embed(["a", "ccc", "b", "dddd"]));
		expect(answered).toEqual(fresh);
	});

	test("a text repeated inside one call is embedded once", async () => {
		const tei = fakeTei();
		const service = serviceOf(PINNED, tei, new FakeRedis());
		const answered = vectorsOf(await service.embed(["x", "yy", "x"]));
		expect(tei.embeds).toEqual([["x", "yy"]]);
		expect(answered).toHaveLength(3);
		expect(answered[0]).toEqual(answered[2]);
	});

	test("every write carries the TTL, however many are written", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis);
		await service.embed(Array.from({ length: 70 }, (_, index) => `text-${index}`));
		expect(redis.sets).toHaveLength(70);
		expect(redis.sets.every((entry) => entry.ttl === TTL)).toBe(true);
		expect(new Set(redis.sets.map((entry) => entry.key)).size).toBe(70);
	});

	test("the key names the model: another model never reads these vectors", async () => {
		const redis = new FakeRedis();
		await serviceOf(PINNED, fakeTei(), redis).embed(["alpha"]);
		const other = fakeTei({ model: "other-model" });
		await serviceOf({ ...PINNED, model: "other-model" }, other, redis).embed(["alpha"]);
		expect(other.embeds).toEqual([["alpha"]]);
		expect(redis.sets).toHaveLength(2);
		expect(embeddingDigest("test-model", "alpha")).not.toBe(embeddingDigest("other-model", "alpha"));
	});

	test("with neither pin set, the first call reads nothing (the key needs the model), still writes, and the second call hits", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(UNPINNED, tei, redis);
		await service.embed(["alpha"]);
		expect(redis.mgets).toBe(0);
		expect(redis.sets).toHaveLength(1);
		await service.embed(["alpha"]);
		expect(redis.mgets).toBe(1);
		expect(tei.embeds).toEqual([["alpha"]]);
	});

	test("a failed TEI call returns its reason and writes nothing", async () => {
		const tei = fakeTei();
		tei.state.embedStatus = 422;
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis);
		expect(await service.embed(["a", "b"])).toEqual({ ok: false, reason: "input-refused" });
		expect(redis.sets).toEqual([]);
	});

	test("texts that differ only past the length bound share one entry", async () => {
		const tei = fakeTei();
		const service = serviceOf(PINNED, tei, new FakeRedis());
		const base = "x".repeat(MAX_TEXT_CHARS);
		const answered = vectorsOf(await service.embed([`${base}1`, `${base}2`]));
		expect(tei.embeds).toHaveLength(1);
		expect(defined(tei.embeds[0])).toHaveLength(1);
		expect(answered).toHaveLength(2);
	});
});

describe("a cache that misbehaves never changes the answer", () => {
	test("a dead Redis falls through on read and on write", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		redis.fail = true;
		const service = serviceOf(PINNED, tei, redis);
		const answered = vectorsOf(await service.embed(["a", "bb"]));
		expect(answered).toHaveLength(2);
		expect(tei.embeds).toEqual([["a", "bb"]]);
		expect(redis.values.size).toBe(0);
	});

	test("a cache store that throws is treated as a miss and a refused write", async () => {
		const tei = fakeTei();
		const throwing: EmbeddingCacheStore = {
			peekMany: async () => {
				throw new Error("boom");
			},
			putEntry: async () => {
				throw new Error("boom");
			},
		};
		const answered = vectorsOf(await serviceOf(PINNED, tei, new FakeRedis(), { cache: throwing }).embed(["a"]));
		expect(answered).toHaveLength(1);
		expect(tei.embeds).toEqual([["a"]]);
	});

	test("a corrupt entry, one of the wrong shape and one of another dimension are misses, and are replaced by a good one", async () => {
		const tei = fakeTei();
		const redis = new FakeRedis();
		const service = serviceOf(PINNED, tei, redis);
		const keyOf = (text: string) => `substrate:v1:emb:${embeddingDigest("test-model", text)}`;
		const threeValues = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString("base64");
		redis.values.set(keyOf("torn"), '{"v":{"dim":4,"b64":"AAAA"}}');
		redis.values.set(keyOf("alien"), '{"v":"not a vector"}');
		redis.values.set(keyOf("wide"), JSON.stringify({ v: { dim: 3, b64: threeValues } }));
		const answered = vectorsOf(await service.embed(["torn", "alien", "wide"]));
		expect(tei.embeds).toEqual([["torn", "alien", "wide"]]);
		expect(answered.every((vector) => vector.length === 4)).toBe(true);
		const again = vectorsOf(await service.embed(["torn", "alien", "wide"]));
		expect(tei.embeds).toHaveLength(1);
		expect(again).toEqual(answered);
	});
});

describe("the stored vector", () => {
	test("round-trips exactly, and is refused for another dimension or a wrong byte count", () => {
		const vector = new Float32Array([0.1, -0.25, 3.5, 1e-7]);
		const stored = encodeVector(vector);
		expect(stored.dim).toBe(4);
		expect(decodeVector(stored, 4)).toEqual(vector);
		expect(decodeVector(stored, 3)).toBeNull();
		expect(decodeVector({ dim: 4, b64: Buffer.from(new Uint8Array(15)).toString("base64") }, 4)).toBeNull();
	});

	test("a view with an offset encodes only its own bytes", () => {
		const backing = new Float32Array([9, 9, 1, 2, 9]);
		const view = backing.subarray(2, 4);
		expect(decodeVector(encodeVector(view), 2)).toEqual(new Float32Array([1, 2]));
	});

	test("the digest is the sha256 of the model, a newline and the text", () => {
		expect(embeddingDigest("m", "t")).toBe(createHash("sha256").update("m\nt").digest("hex"));
	});
});
