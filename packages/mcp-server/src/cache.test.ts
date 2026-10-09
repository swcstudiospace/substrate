/**
 * Dragonfly read-through cache.
 *
 * A fake Redis stands in for Dragonfly. The assertions are the ones the unit
 * asks for: hit, miss, TTL class, generation invalidation, an unreachable
 * server, a malformed value, and the same answer with the cache off, on and
 * broken. `/healthz` reports the counters and does not take its status from them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { findCounter, sumCounter, type MetricSnapshot } from "@substrate/observability";
import {
	CACHE_TTL,
	MEMORY_GENERATION_KEY,
	ReadThroughCache,
	cacheKey,
	type CacheRedis,
} from "./cache.ts";
import { loadConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly ttls: number[] = [];
	fail = false;
	sets = 0;

	async get(key: string): Promise<string | null> {
		if (this.fail) throw new Error("connect ECONNREFUSED redis://default:s3cret@db.internal:6379");
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.sets += 1;
		if (this.fail) throw new Error("connect ECONNREFUSED redis://default:s3cret@db.internal:6379");
		this.values.set(key, value);
		this.ttls.push(ttlSeconds);
	}

	async incr(key: string): Promise<number> {
		if (this.fail) throw new Error("connect ECONNREFUSED redis://default:s3cret@db.internal:6379");
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

function cacheOf(redis: FakeRedis, log: (line: string) => void = () => {}, now = () => 1_000): ReadThroughCache {
	return new ReadThroughCache({ redis, enabled: true, log, now });
}

const read = {
	klass: "memory-search" as const,
	surface: "cursor",
	args: { query: "lease" },
	generations: [MEMORY_GENERATION_KEY],
};

describe("ReadThroughCache", () => {
	test("a miss stores the value and the next call is a hit", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return { text: "held by cursor" };
		};

		expect(await cache.getOrLoad({ ...read, load })).toEqual({ text: "held by cursor" });
		expect(await cache.getOrLoad({ ...read, load })).toEqual({ text: "held by cursor" });

		expect(loads).toBe(1);
		expect(redis.sets).toBe(1);
		expect(cache.health()).toMatchObject({ mode: "on", connected: true, hits: 1, misses: 1, bypasses: 0, errors: 0 });
	});

	test("each class is stored with its own TTL", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const load = async () => "v";
		await cache.getOrLoad({ klass: "brief", surface: "cursor", args: {}, generations: [MEMORY_GENERATION_KEY], load });
		await cache.getOrLoad({
			klass: "memory-search",
			surface: "cursor",
			args: {},
			generations: [MEMORY_GENERATION_KEY],
			load,
		});
		await cache.getOrLoad({ klass: "graph-view", surface: "cursor", args: {}, generations: ["g"], load });

		expect(redis.ttls).toEqual([CACHE_TTL.brief, CACHE_TTL["memory-search"], CACHE_TTL["graph-view"]]);
	});

	test("a generation bump misses and loads again", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let value = "before";
		const load = async () => value;

		expect(await cache.getOrLoad({ ...read, load })).toBe("before");
		value = "after";
		expect(await cache.getOrLoad({ ...read, load })).toBe("before");
		await cache.bump(MEMORY_GENERATION_KEY);
		expect(await cache.getOrLoad({ ...read, load })).toBe("after");
		expect(cache.health()).toMatchObject({ hits: 1, misses: 2 });
	});

	test("an unreachable server returns the source value, counts a bypass, and redacts the line", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const lines: string[] = [];
		const cache = cacheOf(redis, (line) => lines.push(line), () => 5_000);

		expect(await cache.getOrLoad({ ...read, load: async () => "source" })).toBe("source");
		expect(await cache.getOrLoad({ ...read, load: async () => "source" })).toBe("source");

		const health = cache.health();
		expect(health.mode).toBe("degraded");
		expect(health.connected).toBe(false);
		expect(health.bypasses).toBe(2);
		expect(health.errors).toBe(2);
		expect(health.hits).toBe(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("s3cret");
		expect(lines[0]).toContain("[REDACTED]");
	});

	test("a malformed value is not returned", async () => {
		const redis = new FakeRedis();
		const key = cacheKey("memory-search", "cursor", "0", { query: "lease" });
		redis.values.set(key, "{not json");
		const cache = cacheOf(redis);
		let loads = 0;

		const value = await cache.getOrLoad({
			...read,
			load: async () => {
				loads += 1;
				return "fresh";
			},
		});

		expect(value).toBe("fresh");
		expect(loads).toBe(1);
		expect(cache.health()).toMatchObject({ errors: 1, misses: 1, hits: 0 });
		expect(redis.values.get(key)).toBe(JSON.stringify({ v: "fresh" }));
	});

	test("two surfaces do not share a key", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return loads;
		};

		expect(await cache.getOrLoad({ ...read, surface: "cursor", load })).toBe(1);
		expect(await cache.getOrLoad({ ...read, surface: "grok-bot", load })).toBe(2);
		expect(await cache.getOrLoad({ ...read, surface: "cursor", load })).toBe(1);
	});

	test("SUBSTRATE_CACHE=0 and a missing URL leave the cache off", () => {
		expect(loadConfig({}).cacheEnabled).toBe(false);
		expect(loadConfig({}).dragonflyUrl).toBeUndefined();
		const on = loadConfig({ DRAGONFLY_URL: " redis://127.0.0.1:6379 " });
		expect(on.dragonflyUrl).toBe("redis://127.0.0.1:6379");
		expect(on.cacheEnabled).toBe(true);
		expect(loadConfig({ DRAGONFLY_URL: "redis://127.0.0.1:6379", SUBSTRATE_CACHE: "0" }).cacheEnabled).toBe(false);
	});
});

describe("the same answer with the cache off, on and broken", () => {
	const entries = [{ id: "mem-1", text: "the lease is fenced" }];

	function substrate(cache?: ReadThroughCache): Substrate {
		const index = { searchMemory: async () => entries };
		return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}) });
	}

	test("searchMemory matches", async () => {
		const on = new FakeRedis();
		const broken = new FakeRedis();
		broken.fail = true;
		const off = substrate();
		const live = substrate(cacheOf(on));
		const down = substrate(cacheOf(broken));

		const a = await off.searchMemory("lease", undefined, undefined, undefined, "cursor");
		const b = await live.searchMemory("lease", undefined, undefined, undefined, "cursor");
		const c = await down.searchMemory("lease", undefined, undefined, undefined, "cursor");
		expect(b).toEqual(a);
		expect(c).toEqual(a);
		expect(await live.searchMemory("lease", undefined, undefined, undefined, "cursor")).toEqual(a);
		expect(on.sets).toBe(1);
	});

	test("a brief is cached until its generation moves, and events are not", async () => {
		let graphs = 0;
		let queries = 0;
		const index = {
			getGraph: async () => {
				graphs += 1;
				return null;
			},
			memoryForBrief: async () => [],
		};
		const greptime = {
			queryEvents: async () => {
				queries += 1;
				return [];
			},
		};
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			cache: cacheOf(redis),
		});

		const request = { surface: "cursor" as const, graph_id: "ut-1", repo: undefined };
		const first = await substrate.brief(request);
		const second = await substrate.brief(request);
		expect(second).toBe(first);
		expect(graphs).toBe(1);

		await redis.incr(MEMORY_GENERATION_KEY);
		await substrate.brief(request);
		expect(graphs).toBe(2);

		await substrate.queryEvents({ graph_id: "ut-1" });
		await substrate.queryEvents({ graph_id: "ut-1" });
		expect(queries).toBe(2);
	});
});

describe("GET /healthz", () => {
	const running: Array<{ close: () => void }> = [];
	afterAll(() => {
		for (const server of running) server.close();
	});

	test("reports cache counters and does not take its status from the cache", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const config = loadConfig({});
		const observability = createObservability(config, {});
		const index = {
			ping: async () => true,
			getGraph: async () => null,
			memoryForBrief: async () => [],
		};
		const substrate = new Substrate(
			config,
			{
				index: index as never,
				greptime: null,
				cache: new ReadThroughCache({
					redis,
					enabled: true,
					log: () => {},
					now: () => 1_000,
					record: (sample) => observability.observer.cached?.(sample),
				}),
			},
			observability.observer,
		);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		running.push({
			close() {
				observability.stop();
				server.close();
			},
		});

		const brief = await fetch(`http://127.0.0.1:${port}/brief`, {
			method: "POST",
			body: JSON.stringify({ surface: "cursor", graph_id: "ut-1" }),
		});
		expect(brief.status).toBe(200);

		const health = await fetch(`http://127.0.0.1:${port}/healthz`);
		const body = (await health.json()) as {
			index: boolean;
			cache: { mode: string; bypasses: number; errors: number; hits: number };
		};
		expect(health.status).toBe(200);
		expect(body.index).toBe(true);
		expect(body.cache.mode).toBe("degraded");
		expect(body.cache.bypasses).toBeGreaterThan(0);
		expect(body.cache.errors).toBeGreaterThan(0);
		expect(body.cache.hits).toBe(0);

		const metrics = (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()) as {
			metrics: MetricSnapshot[];
		};
		const counter = findCounter(metrics.metrics, "substrate.cache.operations");
		expect(counter).toBeDefined();
		expect(sumCounter(counter!, { result: "bypass" })).toBeGreaterThan(0);
	});
});
