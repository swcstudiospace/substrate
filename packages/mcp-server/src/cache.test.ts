/**
 * Dragonfly read-through cache.
 *
 * A fake Redis stands in for Dragonfly. The assertions are the ones the unit
 * asks for: hit, miss, TTL class, generation invalidation, an unreachable
 * server, a malformed value, and the same answer with the cache off, on and
 * broken. `/healthz` reports the counters and does not take its status from them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import { findCounter, sumCounter, type MetricSnapshot } from "@substrate/observability";
import {
	CACHE_TTL,
	COMMAND_TIMEOUT_MS,
	CONNECT_TIMEOUT_MS,
	GRAPHS_GENERATION_KEY,
	MEMORY_GENERATION_KEY,
	ReadThroughCache,
	cacheKey,
	createReadThroughCache,
	graphGenerationKey,
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
	/** GET succeeds and SET rejects, so a save failure is distinct from a dead server. */
	failSet = false;
	hang = false;
	failMessage = "connect ECONNREFUSED redis://default:s3cret@db.internal:6379";
	sets = 0;
	private readonly waiting: Array<() => void> = [];

	async get(key: string): Promise<string | null> {
		if (this.hang) await new Promise<void>((resolve) => this.waiting.push(resolve));
		if (this.fail) throw new Error(this.failMessage);
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.sets += 1;
		if (this.hang) await new Promise<void>((resolve) => this.waiting.push(resolve));
		if (this.fail || this.failSet) throw new Error(this.failMessage);
		this.values.set(key, value);
		this.ttls.push(ttlSeconds);
	}

	async incr(key: string): Promise<number> {
		if (this.hang) await new Promise<void>((resolve) => this.waiting.push(resolve));
		if (this.fail) throw new Error(this.failMessage);
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}

	release(): void {
		const pending = this.waiting.splice(0);
		for (const resolve of pending) resolve();
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
			return [{ text: "held by cursor" }];
		};

		expect(await cache.getOrLoad({ ...read, load })).toEqual([{ text: "held by cursor" }]);
		expect(await cache.getOrLoad({ ...read, load })).toEqual([{ text: "held by cursor" }]);

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
		const load = async () => [value];

		expect(await cache.getOrLoad({ ...read, load })).toEqual(["before"]);
		value = "after";
		expect(await cache.getOrLoad({ ...read, load })).toEqual(["before"]);
		await cache.bump(MEMORY_GENERATION_KEY);
		expect(await cache.getOrLoad({ ...read, load })).toEqual(["after"]);
		expect(cache.health()).toMatchObject({ hits: 1, misses: 2 });
	});

	test("a rejected SET returns the source value and counts a bypass", async () => {
		const redis = new FakeRedis();
		redis.failSet = true;
		const cache = cacheOf(redis);
		expect(await cache.getOrLoad({ ...read, load: async () => [{ text: "from source" }] })).toEqual([
			{ text: "from source" },
		]);
		expect(redis.values.size).toBe(0);
		expect(cache.health()).toMatchObject({ hits: 0, misses: 1, bypasses: 1, errors: 1 });
	});

	test("store false returns the value and does not write it", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return [{ text: `load ${loads}` }];
		};
		expect(await cache.getOrLoad({ ...read, load, store: () => false })).toEqual([{ text: "load 1" }]);
		expect(await cache.getOrLoad({ ...read, load, store: () => false })).toEqual([{ text: "load 2" }]);
		expect(loads).toBe(2);
		expect(redis.sets).toBe(0);
		expect(cache.health()).toMatchObject({ hits: 0, misses: 2, bypasses: 0, errors: 0 });
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
		expect(cache.health()).toMatchObject({ errors: 1, bypasses: 1, misses: 0, hits: 0 });
		expect(redis.values.get(key)).toBe(JSON.stringify({ v: "fresh" }));
	});

	test("a malformed value whose replacement SET fails counts one bypass", async () => {
		const redis = new FakeRedis();
		redis.failSet = true;
		const key = cacheKey("memory-search", "cursor", "0", { query: "lease" });
		redis.values.set(key, "{not json");
		const cache = cacheOf(redis);

		expect(await cache.getOrLoad({ ...read, load: async () => "fresh" })).toBe("fresh");
		expect(redis.values.get(key)).toBe("{not json");
		expect(cache.health()).toMatchObject({ errors: 2, bypasses: 1, misses: 0, hits: 0 });
	});

	test("skipping a store still records that Dragonfly answered", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const cache = cacheOf(redis);
		await cache.getOrLoad({ ...read, load: async () => "down" });
		expect(cache.health()).toMatchObject({ connected: false, mode: "degraded" });

		redis.fail = false;
		expect(await cache.getOrLoad({ ...read, load: async () => "partial", store: () => false })).toBe("partial");
		expect(redis.sets).toBe(0);
		expect(cache.health()).toMatchObject({ connected: true, mode: "on" });
	});

	test("a command that does not return is a bypass, and the budgets are pinned to 800 ms", async () => {
		expect(COMMAND_TIMEOUT_MS).toBe(800);
		expect(CONNECT_TIMEOUT_MS).toBe(800);

		const redis = new FakeRedis();
		redis.hang = true;
		const lines: string[] = [];
		const cache = new ReadThroughCache({
			redis,
			enabled: true,
			log: (line) => lines.push(line),
			now: () => 9_000,
			commandTimeoutMs: 30,
		});
		const started = Date.now();
		expect(await cache.getOrLoad({ ...read, load: async () => "source" })).toBe("source");
		expect(Date.now() - started).toBeLessThan(500);
		expect(cache.health()).toMatchObject({
			mode: "degraded",
			connected: false,
			bypasses: 1,
			errors: 1,
			hits: 0,
			misses: 0,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("s3cret");
		redis.release();
	});

	test("a user-less redis URL is stripped before it is logged", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		redis.failMessage = "connect ECONNREFUSED redis://:s3cret@db.internal:6379";
		const lines: string[] = [];
		const cache = cacheOf(redis, (line) => lines.push(line), () => 11_000);

		expect(await cache.getOrLoad({ ...read, load: async () => "source" })).toBe("source");
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("s3cret");
		expect(lines[0]).not.toContain("db.internal");
		expect(lines[0]).toContain("[REDACTED]");
	});

	test("valid JSON of the wrong shape is a bypass", async () => {
		const redis = new FakeRedis();
		const briefKey = cacheKey("brief", "cursor", "0", {});
		redis.values.set(briefKey, JSON.stringify({ v: 42 }));
		const searchKey = cacheKey("memory-search", "cursor", "0", { query: "lease" });
		redis.values.set(searchKey, JSON.stringify({ v: {} }));
		const cache = cacheOf(redis);

		expect(
			await cache.getOrLoad({
				klass: "brief",
				surface: "cursor",
				args: {},
				generations: [MEMORY_GENERATION_KEY],
				load: async () => "a brief",
			}),
		).toBe("a brief");
		expect(await cache.getOrLoad({ ...read, load: async () => [{ id: "mem-1" }] })).toEqual([{ id: "mem-1" }]);

		expect(cache.health()).toMatchObject({ hits: 0, bypasses: 2, errors: 2 });
		expect(redis.values.get(briefKey)).toBe(JSON.stringify({ v: "a brief" }));
	});

	test("a failed bump keeps later reads on the source until a bump lands", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let value = "before";
		expect(await cache.getOrLoad({ ...read, load: async () => [value] })).toEqual(["before"]);

		redis.fail = true;
		redis.failMessage = "incr failed";
		await cache.bump(MEMORY_GENERATION_KEY);
		redis.fail = false;
		value = "after";

		expect(await cache.getOrLoad({ ...read, load: async () => [value] })).toEqual(["after"]);
		expect(await cache.getOrLoad({ ...read, load: async () => [value] })).toEqual(["after"]);
		expect(cache.health().hits).toBe(0);
		expect(cache.health().mode).toBe("degraded");

		await cache.bump(MEMORY_GENERATION_KEY);
		expect(await cache.getOrLoad({ ...read, load: async () => ["landed"] })).toEqual(["landed"]);
		expect(await cache.getOrLoad({ ...read, load: async () => ["stale"] })).toEqual(["landed"]);
		expect(cache.health()).toMatchObject({ hits: 1, mode: "on" });
	});

	test("a stored answer expires when its deadline does", async () => {
		const redis = new FakeRedis();
		const now = 1_000_000;
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => now });

		await cache.getOrLoad({
			klass: "memory-search",
			surface: "cursor",
			args: { query: "lease" },
			generations: [MEMORY_GENERATION_KEY],
			refreshAt: () => now + 20_000,
			load: async () => [],
		});
		await cache.getOrLoad({
			klass: "brief",
			surface: "cursor",
			args: {},
			generations: [MEMORY_GENERATION_KEY],
			refreshAt: () => now - 1,
			load: async () => "already due",
		});

		expect(redis.ttls).toEqual([20]);
		expect(redis.sets).toBe(1);
	});

	test("two surfaces do not share a key", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return [loads];
		};

		expect(await cache.getOrLoad({ ...read, surface: "cursor", load })).toEqual([1]);
		expect(await cache.getOrLoad({ ...read, surface: "grok-bot", load })).toEqual([2]);
		expect(await cache.getOrLoad({ ...read, surface: "cursor", load })).toEqual([1]);
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

	test("brief matches", async () => {
		const memory = [
			{
				kind: "decision",
				text: "keep the prefix",
				writer: "cursor",
				trust: "verified",
				version: 1,
				needs_reverification: false,
			},
		];
		function substrate(cache?: ReadThroughCache): Substrate {
			const index = {
				getGraph: async () => null,
				memoryForBrief: async () => memory,
			};
			return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}) });
		}
		const on = new FakeRedis();
		const broken = new FakeRedis();
		broken.fail = true;
		const request = { surface: "cursor" as const, graph_id: "ut-mv10s1se-50878383" };
		const off = substrate();
		const live = substrate(cacheOf(on));
		const down = substrate(cacheOf(broken));

		const a = await off.brief(request);
		const b = await live.brief(request);
		const c = await down.brief(request);
		expect(b).toEqual(a);
		expect(c).toEqual(a);
		expect(await live.brief(request)).toEqual(a);
		expect(on.sets).toBe(1);
		expect(a).toContain("keep the prefix");
	});

	test("a brief built while a source read fails is not cached", async () => {
		let down = true;
		let loads = 0;
		const index = {
			getGraph: async () => {
				loads += 1;
				if (down) throw new Error("postgres is down");
				return {
					graph_id: "ut-1",
					notion_task_page: null,
					repo: "acme/app",
					branch: null,
					surface: "cursor",
					status: "active",
					pr_url: null,
					created: null,
					updated: null,
					nodes: [],
					steps: [],
					edges: [],
				};
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };
		const thin = await substrate.brief(request);
		expect(thin).toContain("not in the index yet");
		expect(redis.sets).toBe(0);
		expect(loads).toBe(1);

		down = false;
		const recovered = await substrate.brief(request);
		expect(recovered).toContain("active");
		expect(recovered).not.toContain("not in the index yet");
		expect(loads).toBe(2);
		expect(redis.sets).toBe(1);
	});

	test("graph_get matches", async () => {
		const graph = {
			graph_id: "ut-mv10s1se-50878383",
			notion_task_page: null,
			repo: "swcstudiospace/agent-substrate",
			branch: "main",
			surface: "cursor",
			status: "active",
			pr_url: null,
			created: "2026-10-09T00:00:00.000Z",
			updated: "2026-10-09T00:00:00.000Z",
			nodes: [
				{
					graph_id: "ut-mv10s1se-50878383",
					node_id: "n3",
					linear_issue_id: null,
					linear_identifier: "SPE-9228",
					notion_page: null,
					state: "todo",
					claimed_by: null,
					claimed_at: null,
					claim_session: null,
					lease_id: "secret-lease",
					lease_expires_at: null,
					lease_heartbeat_at: null,
					lease_epoch: 0,
				},
			],
			steps: [],
			edges: [],
		};
		function substrate(cache?: ReadThroughCache): Substrate {
			const index = { getGraph: async () => graph };
			return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}) });
		}
		const on = new FakeRedis();
		const broken = new FakeRedis();
		broken.fail = true;
		const off = substrate();
		const live = substrate(cacheOf(on));
		const down = substrate(cacheOf(broken));

		const a = await off.getGraph("ut-mv10s1se-50878383", "cursor");
		const b = await live.getGraph("ut-mv10s1se-50878383", "cursor");
		const c = await down.getGraph("ut-mv10s1se-50878383", "cursor");
		expect(b).toEqual(a);
		expect(c).toEqual(a);
		expect(await live.getGraph("ut-mv10s1se-50878383", "cursor")).toEqual(a);
		expect(a).toMatchObject({ nodes: [{ node_id: "n3", lease_id: null }] });
		expect(JSON.stringify(b)).not.toContain("secret-lease");
		expect(on.sets).toBe(1);
	});

	test("a graph write refreshes a repo brief", async () => {
		let loads = 0;
		const index = {
			getGraph: async () => null,
			memoryForBrief: async () => {
				loads += 1;
				return [];
			},
			openGraphs: async () => [],
			registerGraph: async () => ({
				graph_id: "ut-other",
				notion_task_page: null,
				repo: "acme/app",
				branch: null,
				surface: null,
				status: "active",
				pr_url: null,
				created: null,
				updated: null,
				nodes: [],
				steps: [],
				edges: [],
			}),
		};
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		const request = { surface: "cursor" as const, repo: "acme/app" };
		await substrate.brief(request);
		await substrate.brief(request);
		expect(loads).toBe(1);

		await substrate.registerGraph({ graph_id: "ut-other" } as never);
		expect(redis.values.get(GRAPHS_GENERATION_KEY)).toBe("1");
		expect(redis.values.get(graphGenerationKey("ut-other"))).toBe("1");
		await substrate.brief(request);
		expect(loads).toBe(2);
	});

	test("a register that throws after it may have committed still refreshes the graph", async () => {
		let status = "old";
		const index = {
			getGraph: async () => ({
				graph_id: "ut-1",
				notion_task_page: null,
				repo: null,
				branch: null,
				surface: "cursor",
				status,
				pr_url: null,
				created: null,
				updated: null,
				nodes: [],
				steps: [],
				edges: [],
			}),
			registerGraph: async () => {
				status = "new";
				throw new Error("read-back failed");
			},
		};
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		expect((await substrate.getGraph("ut-1", "cursor"))?.status).toBe("old");
		await expect(substrate.registerGraph({ graph_id: "ut-1" } as never)).rejects.toThrow("read-back failed");
		expect(redis.values.get(graphGenerationKey("ut-1"))).toBe("1");
		expect(redis.values.get(GRAPHS_GENERATION_KEY)).toBe("1");
		expect((await substrate.getGraph("ut-1", "cursor"))?.status).toBe("new");
	});

	test("reaping several graphs bumps the shared generation once", async () => {
		const redis = new FakeRedis();
		const index = {
			reapExpiredLeases: async () => [
				{ graph_id: "ut-a", node_id: "n1", linear_identifier: null, holder: null, lease_epoch: 1, expired_at: "2026-10-09T00:00:00.000Z" },
				{ graph_id: "ut-a", node_id: "n2", linear_identifier: null, holder: null, lease_epoch: 1, expired_at: "2026-10-09T00:00:00.000Z" },
				{ graph_id: "ut-b", node_id: "n3", linear_identifier: null, holder: null, lease_epoch: 1, expired_at: "2026-10-09T00:00:00.000Z" },
			],
			getGraph: async () => null,
		};
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		await substrate.reapExpiredLeases();
		expect(redis.values.get(graphGenerationKey("ut-a"))).toBe("1");
		expect(redis.values.get(graphGenerationKey("ut-b"))).toBe("1");
		expect(redis.values.get(GRAPHS_GENERATION_KEY)).toBe("1");
	});

	test("an unverified accept and an uncertain commit both refresh memory", async () => {
		const redis = new FakeRedis();
		const row = {
			id: "mem-1",
			scope: "graph:ut-1",
			kind: "fact",
			subject: null,
			text: "hermes finished n2",
			writer: "hermes",
			actor: "agent",
			trust: "agent-claimed",
			ttl: "30d",
			created: "2026-10-09T00:00:00.000Z",
			version: 1,
			entry_hash: "abc",
			needs_reverification: false,
		};
		const accepted = {
			claimWrite: async () => ({ claimed: true, holder: "h1", tookOverFrom: null }),
			standingEntry: async () => null,
			insertEntry: async (entry: typeof row) => ({ ok: true, entry }),
			finishWrite: async () => undefined,
			readEntry: async () => null,
		};
		const unverified = new Substrate(loadConfig({}), {
			index: accepted as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		const result = await unverified.writeMemory({
			scope: "graph:ut-1",
			kind: "fact",
			text: "hermes finished n2",
			writer: "hermes",
		});
		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(false);
		expect(redis.values.get(MEMORY_GENERATION_KEY)).toBe("1");

		const throwing = new Substrate(loadConfig({}), {
			index: {
				...accepted,
				readEntry: async () => {
					throw new Error("read failed after insert");
				},
			} as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		const denied = await throwing.writeMemory({
			scope: "graph:ut-1",
			kind: "fact",
			text: "hermes finished n2",
			writer: "hermes",
		});
		expect(denied.outcome).toBe("denied");
		expect(redis.values.get(MEMORY_GENERATION_KEY)).toBe("2");

		const refused = new Substrate(loadConfig({}), {
			index: {} as never,
			greptime: null,
			cache: cacheOf(redis),
		});
		expect((await refused.writeMemory({ ...{ scope: "person:ove", kind: "fact" as const, text: "no", writer: "hermes" } })).outcome).toBe(
			"denied",
		);
		expect(redis.values.get(MEMORY_GENERATION_KEY)).toBe("2");
	});

	test("a brief's TTL stops at the next lease expiry", async () => {
		const redis = new FakeRedis();
		const expires = new Date(Date.now() + 25_000).toISOString();
		const index = {
			getGraph: async () => ({
				graph_id: "ut-1",
				notion_task_page: null,
				repo: null,
				branch: null,
				surface: "cursor",
				status: "active",
				pr_url: null,
				created: null,
				updated: null,
				nodes: [
					{
						graph_id: "ut-1",
						node_id: "n1",
						linear_issue_id: null,
						linear_identifier: null,
						notion_page: null,
						state: "todo",
						claimed_by: "cursor",
						claimed_at: new Date().toISOString(),
						claim_session: null,
						lease_id: "lease",
						lease_expires_at: expires,
						lease_heartbeat_at: null,
						lease_epoch: 1,
					},
				],
				steps: [],
				edges: [],
			}),
			memoryForBrief: async () => [],
		};
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: null,
			cache: new ReadThroughCache({ redis, enabled: true, log: () => {}, now: Date.now }),
		});
		await substrate.brief({ surface: "cursor", graph_id: "ut-1" });
		expect(redis.ttls).toHaveLength(1);
		expect(redis.ttls[0]).toBeLessThanOrEqual(25);
		expect(redis.ttls[0]).toBeGreaterThanOrEqual(1);
		expect(redis.ttls[0]).toBeLessThan(CACHE_TTL.brief);
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

describe("Bun RedisClient", () => {
	const hello = [
		"%7",
		"$6",
		"server",
		"$5",
		"redis",
		"$7",
		"version",
		"$5",
		"7.2.4",
		"$5",
		"proto",
		":3",
		"$2",
		"id",
		":10",
		"$4",
		"mode",
		"$10",
		"standalone",
		"$4",
		"role",
		"$6",
		"master",
		"$7",
		"modules",
		"*0",
		"",
	].join("\r\n");

	/** Answers every whole command in `text` and returns the unparsed tail. */
	function takeCommands(store: Map<string, string>, text: string): { answer: string; rest: string } {
		const out: string[] = [];
		let i = 0;
		while (i < text.length && text[i] === "*") {
			const header = text.indexOf("\r\n", i);
			if (header < 0) break;
			const count = Number(text.slice(i + 1, header));
			if (!Number.isInteger(count) || count < 0) break;
			let cursor = header + 2;
			const args: string[] = [];
			let complete = true;
			for (let n = 0; n < count; n++) {
				if (text[cursor] !== "$") {
					complete = false;
					break;
				}
				const lenEnd = text.indexOf("\r\n", cursor);
				if (lenEnd < 0) {
					complete = false;
					break;
				}
				const len = Number(text.slice(cursor + 1, lenEnd));
				const start = lenEnd + 2;
				if (!Number.isInteger(len) || len < 0 || text.length < start + len + 2) {
					complete = false;
					break;
				}
				args.push(text.slice(start, start + len));
				cursor = start + len + 2;
			}
			if (!complete) break;
			i = cursor;
			const [command, key, value] = args;
			if (command === "HELLO") out.push(hello);
			else if (command === "GET") {
				const stored = key ? store.get(key) : undefined;
				out.push(stored === undefined ? "$-1\r\n" : `$${Buffer.byteLength(stored)}\r\n${stored}\r\n`);
			} else if (command === "SET" && key !== undefined && value !== undefined) {
				store.set(key, value);
				out.push("+OK\r\n");
			} else if (command === "INCR" && key !== undefined) {
				const next = Number(store.get(key) ?? "0") + 1;
				store.set(key, String(next));
				out.push(`:${next}\r\n`);
			}
		}
		return { answer: out.join(""), rest: text.slice(i) };
	}

	test("a command split across chunks is answered only once it is whole", () => {
		const store = new Map<string, string>();
		const command = "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n";
		const first = takeCommands(store, command.slice(0, 8));
		expect(first.answer).toBe("");
		expect(store.size).toBe(0);
		const second = takeCommands(store, first.rest + command.slice(8));
		expect(second.answer).toBe("+OK\r\n");
		expect(second.rest).toBe("");
		expect(store.get("k")).toBe("v");
	});

	test("a dropped socket fails open, and the next command recovers", async () => {
		const store = new Map<string, string>();
		let drop = true;
		const server = net.createServer((socket) => {
			if (drop) {
				socket.destroy();
				return;
			}
			let pending = "";
			socket.on("data", (buf) => {
				pending += buf.toString("utf8");
				const taken = takeCommands(store, pending);
				pending = taken.rest;
				if (taken.answer.length > 0) socket.write(taken.answer);
			});
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const cache = createReadThroughCache(loadConfig({ DRAGONFLY_URL: `redis://127.0.0.1:${port}` }), () => {});
			const request = { ...read, klass: "brief" as const, args: {}, load: async () => "source" };
			const started = Date.now();
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(cache.health()).toMatchObject({ bypasses: 1, errors: 1, hits: 0, mode: "degraded" });

			drop = false;
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(cache.health()).toMatchObject({ hits: 1, misses: 1, mode: "on", connected: true });
		} finally {
			server.close();
		}
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
