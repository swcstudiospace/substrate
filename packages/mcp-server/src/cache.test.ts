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
import { BreakerOpenError, CACHE_METRIC_CLASSES, CircuitBreaker, findCounter, sumCounter, type MetricSnapshot, type PlaneSample } from "@substrate/observability";
import {
	CACHE_CLASSES,
	MAX_REFRESHES,
	classOf,
	snapshotKey,
	type LastGood,
	CACHE_CONNECT_COOLDOWN_MS,
	CACHE_TTL,
	COMMAND_TIMEOUT_MS,
	CONNECT_TIMEOUT_MS,
	GRAPHS_GENERATION_KEY,
	MEMORY_GENERATION_KEY,
	ReadThroughCache,
	bunRedis,
	cacheKey,
	createReadThroughCache,
	graphGenerationKey,
	type CacheRedis,
} from "./cache.ts";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { FakeStore } from "./memory-write.test.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";
import { clearEnsuredBanks, type FetchLike } from "./planes/hindsight.ts";

/**
 * Point the Hindsight env reads at the fake for one test. Restores every
 * touched variable: the plane config is per-test state, not suite state.
 */
function hindsightEnv(): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = "sub-cursor";
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

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

	test("a refresh runs the loader over a fresh entry and replaces what is stored", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		let value = "before";
		expect(await cache.getOrLoad({ ...read, load: async () => [value] })).toEqual(["before"]);
		value = "after";
		expect(await cache.getOrLoad({ ...read, load: async () => [value], refresh: true })).toEqual(["after"]);
		expect(await cache.getOrLoad({ ...read, load: async () => ["never"] })).toEqual(["after"]);
		expect(redis.sets).toBe(2);
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

	test("a command that does not return is a bypass, and the budgets are pinned to 250 ms", async () => {
		// Sized for the loopback redis production runs (uplift-2 R1); env-overridable in config.
		expect(COMMAND_TIMEOUT_MS).toBe(250);
		expect(CONNECT_TIMEOUT_MS).toBe(250);

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
		return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}), steering: { history: null, liveSessions: null } });
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
		// Two entries: the merged search and the recall it shares with memory_recall.
		expect(on.sets).toBe(2);
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
			return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}), steering: { history: null, liveSessions: null } });
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
		// The brief entry and its last-good snapshot (uplift-2 R1); the hit wrote nothing.
		expect(on.sets).toBe(2);
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
			steering: { history: null, liveSessions: null },
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
		// The recovered brief and, now that it is complete, its snapshot.
		expect(redis.sets).toBe(2);
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
			return new Substrate(loadConfig({}), { index: index as never, greptime: null, ...(cache ? { cache } : {}), steering: { history: null, liveSessions: null } });
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
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
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: new ReadThroughCache({ redis, enabled: true, log: () => {}, now: Date.now }),
		});
		await substrate.brief({ surface: "cursor", graph_id: "ut-1" });
		// The brief's own TTL stops at the lease; the snapshot written beside it keeps its class TTL.
		expect(redis.ttls).toHaveLength(2);
		expect(redis.ttls[0]).toBeLessThanOrEqual(25);
		expect(redis.ttls[0]).toBeGreaterThanOrEqual(1);
		expect(redis.ttls[0]).toBeLessThan(CACHE_TTL.brief);
		expect(redis.ttls[1]).toBe(CACHE_TTL["brief-snapshot"]);
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
			steering: { history: null, liveSessions: null },
			greptime: greptime as never,
			cache: cacheOf(redis),
		});

		const request = { surface: "cursor" as const, graph_id: "ut-1" };
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

	test("a fresh claim is visible in a brief served right after a cache hit", async () => {
		// The D26-06b pin: the mechanism is the memory-generation bump the
		// write path performs on accept, verified here rather than rebuilt.
		const memory = [
			{ kind: "decision", text: "keep the prefix", writer: "cursor", trust: "agent-claimed", version: 1, needs_reverification: false },
		];
		const index = {
			getGraph: async () => null,
			openGraphs: async () => [],
			memoryForBrief: async () => memory,
		};
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache, steering: { history: null, liveSessions: null } });
		const request = { surface: "cursor" as const, repo: "acme/app" };
		const first = await substrate.brief(request);
		expect(first).toContain("keep the prefix");
		expect(await substrate.brief(request)).toEqual(first);
		expect(cache.health().hits).toBe(1);
		// A claim newer than 60 s lands; the accepted write bumps the generation.
		memory.push(
			{ kind: "decision", text: "fence every handoff", writer: "hermes", trust: "agent-claimed", version: 1, needs_reverification: false },
		);
		await cache.bump(MEMORY_GENERATION_KEY);
		const fresh = await substrate.brief(request);
		expect(fresh).toContain("fence every handoff");
	});

	test("a second identical recall is a hit", async () => {
		const saved = { url: process.env.HINDSIGHT_URL, key: process.env.HINDSIGHT_API_KEY, banks: process.env.HINDSIGHT_BANKS };
		process.env.HINDSIGHT_URL = "http://fake";
		process.env.HINDSIGHT_API_KEY = "test-bearer";
		process.env.HINDSIGHT_BANKS = "sub-hermes";
		try {
			const fake = new HindsightFake();
			fake.seed("sub-cursor", [{ id: "c1", text: "fence the lease", document_id: "mwd_c1", tags: ["cursor"], metadata: {}, score: 0.5 }]);
			fake.seed("sub-hermes", [{ id: "h1", text: "quote versions", document_id: "mwd_h1", tags: ["hermes"], metadata: {}, score: 0.9 }]);
			const redis = new FakeRedis();
			const cache = cacheOf(redis);
			const substrate = new Substrate(loadConfig({}), { index: null, greptime: null, cache, hindsightFetch: fake.fetch });
			const first = await substrate.recallMemories({ query: "lease" }, "cursor");
			expect(first.degraded).toBe(false);
			expect(first.results.length).toBe(2);
			const second = await substrate.recallMemories({ query: "lease" }, "cursor");
			expect(second).toEqual(first);
			expect(cache.health().hits).toBe(1);
			expect(redis.sets).toBe(1);
		} finally {
			if (saved.url === undefined) delete process.env.HINDSIGHT_URL;
			else process.env.HINDSIGHT_URL = saved.url;
			if (saved.key === undefined) delete process.env.HINDSIGHT_API_KEY;
			else process.env.HINDSIGHT_API_KEY = saved.key;
			if (saved.banks === undefined) delete process.env.HINDSIGHT_BANKS;
			else process.env.HINDSIGHT_BANKS = saved.banks;
		}
	});

	test("with Dragonfly down the same recall comes back uncached", async () => {
		const saved = { url: process.env.HINDSIGHT_URL, key: process.env.HINDSIGHT_API_KEY, banks: process.env.HINDSIGHT_BANKS };
		process.env.HINDSIGHT_URL = "http://fake";
		process.env.HINDSIGHT_API_KEY = "test-bearer";
		process.env.HINDSIGHT_BANKS = "sub-hermes";
		try {
			const fake = new HindsightFake();
			fake.seed("sub-cursor", [{ id: "c1", text: "fence the lease", document_id: "mwd_c1", tags: ["cursor"], metadata: {}, score: 0.5 }]);
			fake.seed("sub-hermes", [{ id: "h1", text: "quote versions", document_id: "mwd_h1", tags: ["hermes"], metadata: {}, score: 0.9 }]);
			const off = new Substrate(loadConfig({}), { index: null, greptime: null, hindsightFetch: fake.fetch });
			const broken = new FakeRedis();
			broken.fail = true;
			const brokenCache = cacheOf(broken);
			const down = new Substrate(loadConfig({}), { index: null, greptime: null, cache: brokenCache, hindsightFetch: fake.fetch });
			const plain = await off.recallMemories({ query: "lease" }, "cursor");
			const uncached = await down.recallMemories({ query: "lease" }, "cursor");
			expect(uncached).toEqual(plain);
			expect(brokenCache.health().bypasses).toBe(1);
		} finally {
			if (saved.url === undefined) delete process.env.HINDSIGHT_URL;
			else process.env.HINDSIGHT_URL = saved.url;
			if (saved.key === undefined) delete process.env.HINDSIGHT_API_KEY;
			else process.env.HINDSIGHT_API_KEY = saved.key;
			if (saved.banks === undefined) delete process.env.HINDSIGHT_BANKS;
			else process.env.HINDSIGHT_BANKS = saved.banks;
		}
	});

	test("a refused redis URL leaves the cache off with a reason and answers uncached", async () => {
		const refused = loadConfig({ DRAGONFLY_URL: "redis://user:pass@cache.example.com:6379/0" });
		expect(refused.dragonflyRefused).toContain("cache.example.com");
		const cache = createReadThroughCache(refused);
		expect(cache.health().enabled).toBe(false);
		expect(cache.health().reason).toContain("cache.example.com");
		const entries = [{ id: "mem-1", text: "the lease is fenced" }];
		const index = { searchMemory: async () => entries };
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache, steering: { history: null, liveSessions: null } });
		const answer = await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
		expect(entries).toEqual(answer.entries);
		expect(answer.derived).toEqual([]);
		// Two bypasses: the merged search and the recall inside it.
		expect(cache.health().bypasses).toBe(2);
	});

	test("pre-upgrade bare-list entries never satisfy the merged shape", async () => {
		// The merged list reply caches under a shape-marked key, so an entry
		// stored before the upgrade is simply never read back as a hit.
		const entries = [{ id: "mem-1", text: "the lease is fenced" }];
		const index = { searchMemory: async () => entries };
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const staleKey = cacheKey("memory-search", "cursor", "0", { query: "lease", scope: null, limit: null, includeSuperseded: false });
		await redis.set(staleKey, JSON.stringify({ v: entries }), 600);
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache, steering: { history: null, liveSessions: null } });
		const answer = await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
		expect(Array.isArray(answer)).toBe(false);
		expect(entries).toEqual(answer.entries);
		expect(answer.derived).toEqual([]);
	});

	test("an outage is served but never stored", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			fake.failRecallWith = 500;
			let loads = 0;
			const entries = [{ id: "mem-1", text: "the lease is fenced" }];
			const index = {
				searchMemory: async () => {
					loads += 1;
					return entries;
				},
			};
			const redis = new FakeRedis();
			const cache = cacheOf(redis);
			const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache, hindsightFetch: fake.fetch, steering: { history: null, liveSessions: null } });
			const first = await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
			expect(first.degraded).toBe(true);
			expect(entries).toEqual(first.entries);
			expect(first.derived).toEqual([]);
			expect(typeof first.reason).toBe("string");
			expect(redis.sets).toBe(0);
			await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
			expect(loads).toBe(2);
		} finally {
			restore();
		}
	});

	test("a guest instance refuses recall before any network call", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			fake.seed("sub-cursor", [{ id: "c1", text: "fence the lease", document_id: "mwd_c1", tags: ["cursor"], metadata: {}, score: 0.5 }]);
			const config = loadConfig({ SUBSTRATE_VM_GUEST: "1" });
			const substrate = new Substrate(config, { index: null, greptime: null, hindsightFetch: fake.fetch });
			const reply = await substrate.recallMemories({ query: "lease" }, "cursor");
			expect(reply).toMatchObject({ results: [], degraded: true, reason: "vm-guest" });
			expect(fake.requests.length).toBe(0);
			const entries = [{ id: "mem-1", text: "the lease is fenced" }];
			const index = { searchMemory: async () => entries };
			const redis = new FakeRedis();
			const cache = cacheOf(redis);
			const searching = new Substrate(config, { index: index as never, greptime: null, cache, hindsightFetch: fake.fetch, steering: { history: null, liveSessions: null } });
			const merged = await searching.searchMemory("lease", undefined, undefined, undefined, "cursor");
			expect(entries).toEqual(merged.entries);
			expect(merged.derived).toEqual([]);
			expect(merged.degraded).toBe(true);
			expect(fake.requests.length).toBe(0);
		} finally {
			restore();
		}
	});

	test("an accepted write reaches the brief, the plane and the next recall through the write path", async () => {
		// End to end across the Greptile round: no manual cache bump anywhere.
		// The write bumps the generation (brief goes fresh), the successful
		// retain bumps it again (no stale recall window), and awaiting the
		// drain proves the background forward lands without blocking the reply.
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			clearEnsuredBanks();
			const store = new FakeStore();
			const redis = new FakeRedis();
			const cache = cacheOf(redis);
			const config = loadConfig({ SUBSTRATE_MEMORY_GRANTS: `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["fact","decision"]}]` });
			const substrate = new Substrate(config, { index: store as never, greptime: null, cache, hindsightFetch: fake.fetch, steering: { history: null, liveSessions: null } });
			const request = { surface: "cursor" as const, repo: "acme/app" };
			const before = await substrate.brief(request);
			expect(before).not.toContain("fence every handoff");
			const written = await substrate.writeMemory({
				scope: "graph:ut-1",
				kind: "decision",
				subject: "handoff-rule",
				text: "fence every handoff",
				writer: "cursor",
				source_event: "evt_e2e",
			});
			expect(written.outcome).toBe("accepted");
			expect(written.verified_persisted).toBe(true);
			const briefed = await substrate.brief(request);
			expect(briefed).toContain("fence every handoff");
			await substrate.drainPendingRetains(5000);
			expect(fake.retains.length).toBe(1);
			expect(redis.values.get(MEMORY_GENERATION_KEY)).toBe("2");
			const recalled = await substrate.recallMemories({ query: "handoff" }, "cursor");
			expect(recalled.degraded).toBe(false);
			expect(recalled.results.map((hit) => hit.text)).toContain("fence every handoff");
		} finally {
			restore();
		}
	});

	test("shutdown drains an in-flight retain without blocking the reply", async () => {
		// Real latency, deliberately: the drain must wait out a slow plane,
		// which no clock control can simulate — the delay lives in the fake.
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			fake.retainDelayMs = 500;
			clearEnsuredBanks();
			const store = new FakeStore();
			const config = loadConfig({ SUBSTRATE_MEMORY_GRANTS: `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["fact"]}]` });
			const substrate = new Substrate(config, { index: store as never, greptime: null, hindsightFetch: fake.fetch, steering: { history: null, liveSessions: null } });
			const written = await substrate.writeMemory({
				scope: "graph:ut-1",
				kind: "fact",
				text: "drain me",
				writer: "cursor",
				source_event: "evt_drain",
			});
			expect(written.outcome).toBe("accepted");
			expect(fake.retains.length).toBe(0);
			await substrate.drainPendingRetains(5000);
			expect(fake.retains.length).toBe(1);
		} finally {
			restore();
		}
	});
	test("a stalled older forward cannot overwrite its accepted replacement", async () => {
		// Forwards to one document run in acceptance order: v1's retain POST
		// stays gated until v2 has landed, so v2 must still be queued — an
		// unchained pair would already show v2 retained here.
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			clearEnsuredBanks();
			const gate = Promise.withResolvers<void>();
			const gatedFetch: FetchLike = async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const body = typeof init?.body === "string" ? init.body : "";
				if (url.includes("/memories") && !url.includes("recall") && body.includes("v1 first")) await gate.promise;
				return fake.fetch(input, init);
			};
			const store = new FakeStore();
			const config = loadConfig({ SUBSTRATE_MEMORY_GRANTS: `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["decision"]}]` });
			const substrate = new Substrate(config, { index: store as never, greptime: null, hindsightFetch: gatedFetch, steering: { history: null, liveSessions: null } });
			const write = (text: string, key: string, expectedVersion?: number) =>
				substrate.writeMemory({
					scope: "graph:ut-1",
					kind: "decision",
					subject: "order-rule",
					text,
					writer: "cursor",
					source_event: "evt_order",
					idempotency_key: key,
					...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
				});
			const first = await write("v1 first", "mwd_v1");
			expect(first.outcome).toBe("accepted");
			const second = await write("v2 second", "mwd_v2", 1);
			expect(second.outcome).toBe("accepted");
			await substrate.drainPendingRetains(300);
			expect(fake.retains.length).toBe(0);
			gate.resolve();
			await substrate.drainPendingRetains(5000);
			const contents = fake.retains.map((retained) => {
				const item = retained.item;
				return "content" in item && typeof item.content === "string" ? item.content : "";
			});
			expect(contents).toEqual(["v1 first", "v2 second"]);
			const memories = fake.banks.get("sub-cursor")?.memories ?? [];
			expect(memories.length).toBe(1);
			expect(memories.at(0)?.text).toBe("v2 second");
		} finally {
			restore();
		}
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
			const bulk = (stored: string | undefined): string => (stored === undefined ? "$-1\r\n" : `$${Buffer.byteLength(stored)}\r\n${stored}\r\n`);
			if (command === "HELLO") out.push(hello);
			else if (command === "GET") out.push(bulk(key ? store.get(key) : undefined));
			else if (command === "MGET") {
				// Generation keys arrive in one round trip since uplift-2 R1.
				const keys = args.slice(1);
				out.push(`*${keys.length}\r\n${keys.map((name) => bulk(store.get(name))).join("")}`);
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
			let now = 1_000_000;
			const cache = createReadThroughCache(loadConfig({ DRAGONFLY_URL: `redis://127.0.0.1:${port}` }), { record: () => {}, now: () => now });
			const request = { ...read, klass: "brief" as const, args: {}, load: async () => "source" };
			const started = Date.now();
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(cache.health()).toMatchObject({ bypasses: 1, errors: 1, hits: 0, mode: "degraded", cooldownUntil: now + CACHE_CONNECT_COOLDOWN_MS });

			// Inside the cooldown nothing touches the socket: a bypass in microseconds.
			drop = false;
			const cooled = Date.now();
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(Date.now() - cooled).toBeLessThan(50);
			expect(cache.health()).toMatchObject({ bypasses: 2, errors: 2, hits: 0, misses: 0 });

			now += CACHE_CONNECT_COOLDOWN_MS;
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(await cache.getOrLoad(request)).toBe("source");
			expect(cache.health()).toMatchObject({ hits: 1, misses: 1, mode: "on", connected: true, cooldownUntil: null });
		} finally {
			server.close();
		}
	});

	test("the connect cooldown is reported and expires; a breaker refusal does not start one", async () => {
		expect(CACHE_CONNECT_COOLDOWN_MS).toBe(5_000);
		let now = 50_000;
		// Nothing listens here: the connect fails at once.
		const server = net.createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));

		const redis = bunRedis(`redis://127.0.0.1:${port}`, { now: () => now, cooldownMs: 100 });
		await expect(redis.get("k")).rejects.toThrow();
		expect(redis.cooldownUntil?.()).toBe(now + 100);
		await expect(redis.get("k")).rejects.toThrow(/cooling down/);
		now += 100;
		expect(redis.cooldownUntil?.()).toBeNull();
		// The cooldown has expired: the socket is tried again (and fails again).
		await expect(redis.get("k")).rejects.not.toThrow(/cooling down/);

		const gated = bunRedis(`redis://127.0.0.1:${port}`, { now: () => now, cooldownMs: 100, gate: { plane: "cache", breaker: new CircuitBreaker("cache", { failureThreshold: 1 }, () => now), observe: null } });
		await expect(gated.get("k")).rejects.toThrow();
		now += 100;
		await expect(gated.get("k")).rejects.toBeInstanceOf(BreakerOpenError);
		// The breaker refused before any socket was opened, so no new cooldown started.
		expect(gated.cooldownUntil?.()).toBeNull();
	});

	test("during the connect cooldown a fail-closed read is refused without a connect attempt", async () => {
		// Each accepted socket is one connect attempt, and each is dropped, so the connect fails and starts the cooldown.
		let now = 2_000_000;
		let connects = 0;
		const server = net.createServer((socket) => {
			connects += 1;
			socket.destroy();
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const port = (server.address() as AddressInfo).port;
		try {
			const cache = createReadThroughCache(loadConfig({ DRAGONFLY_URL: `redis://127.0.0.1:${port}` }), { record: () => {}, now: () => now });
			// The admission bucket step a fail-closed class reads: a refusal carries `breakerRetryAfterMs`; a fail-open class reads any other failure as a bypass.
			const bucket = ["substrate:v1:budget:cursor:read"];
			const args = ["1", "1", "0", "1"];
			// The connect that starts the cooldown is an ordinary failure, not a refusal.
			const first = await cache.script("return 1", bucket, args);
			expect(first.ok).toBe(false);
			expect(first).not.toHaveProperty("breakerRetryAfterMs");
			const attempts = connects;
			expect(attempts).toBeGreaterThan(0);
			expect(cache.health().cooldownUntil).toBe(now + CACHE_CONNECT_COOLDOWN_MS);
			// Inside the cooldown the read is refused with the remaining wait, and no socket is opened.
			now += 1_000;
			expect(await cache.script("return 1", bucket, args)).toEqual({ ok: false, reason: expect.stringContaining("cooling down for 4 s"), breakerRetryAfterMs: 4_000 });
			expect(connects).toBe(attempts);
			// Once the cooldown has lapsed the next command connects again.
			now += 4_000;
			expect((await cache.script("return 1", bucket, args)).ok).toBe(false);
			expect(connects).toBeGreaterThan(attempts);
		} finally {
			server.close();
		}
	});

	test("a connected server that stops replying is a gate timeout, and the connection is dropped", async () => {
		// Greptile round 1: the command deadline used to sit outside `callPlane`, so a
		// wedged server left the command pending — the breaker saw nothing and the
		// same dead connection was reused, costing every later request a timeout.
		const store = new Map<string, string>();
		let stall = false;
		let connections = 0;
		const server = net.createServer((socket) => {
			connections += 1;
			let pending = "";
			socket.on("data", (buf) => {
				pending += buf.toString("utf8");
				const taken = takeCommands(store, pending);
				pending = taken.rest;
				// HELLO is always answered so the connect completes; later commands stall.
				if (taken.answer.length > 0 && (!stall || taken.answer === hello)) socket.write(taken.answer);
			});
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const samples: PlaneSample[] = [];
			const breaker = new CircuitBreaker("cache", { failureThreshold: 2 }, () => 0);
			const redis = bunRedis(`redis://127.0.0.1:${port}`, {
				gate: { plane: "cache", breaker, observe: (sample) => samples.push(sample) },
				commandTimeoutMs: 30,
				cooldownMs: 0,
			});
			expect(await redis.get("k")).toBeNull();
			expect(connections).toBe(1);

			stall = true;
			const started = Date.now();
			await expect(redis.get("k")).rejects.toThrow(/timed out/);
			expect(Date.now() - started).toBeLessThan(500);
			// Connect and command are one gated operation (Greptile round 2): no separate `connect` sample.
			expect(samples.map((sample) => `${sample.op}:${sample.outcome}`)).toEqual(["get:ok", "get:timeout"]);
			expect(breaker.snapshot().failures).toBe(1);

			// The wedged connection was discarded: the next call opens a fresh socket.
			stall = false;
			expect(await redis.get("k")).toBeNull();
			expect(connections).toBe(2);
			expect(breaker.state()).toBe("closed");
		} finally {
			server.close();
		}
	});

	test("a server that accepts connections but never answers opens the breaker; reconnects do not reset it", async () => {
		// Greptile round 2: the connect used to be its own gated call, so every
		// reconnect after a command timeout was a breaker success that cleared the
		// count. The threshold was never reached and each request paid the timeout.
		const store = new Map<string, string>();
		let stall = true;
		let connections = 0;
		const server = net.createServer((socket) => {
			connections += 1;
			let pending = "";
			socket.on("data", (buf) => {
				pending += buf.toString("utf8");
				const taken = takeCommands(store, pending);
				pending = taken.rest;
				// The handshake is always answered, so every connect succeeds; commands stall.
				if (taken.answer.length > 0 && (!stall || taken.answer === hello)) socket.write(taken.answer);
			});
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			let now = 10_000;
			const samples: PlaneSample[] = [];
			const breaker = new CircuitBreaker("cache", { failureThreshold: 2, openMs: 1_000 }, () => now);
			const redis = bunRedis(`redis://127.0.0.1:${port}`, {
				gate: { plane: "cache", breaker, observe: (sample) => samples.push(sample) },
				now: () => now,
				commandTimeoutMs: 30,
				cooldownMs: 0,
			});

			await expect(redis.get("k")).rejects.toThrow(/timed out/);
			expect(connections).toBe(1);
			expect(breaker.snapshot().failures).toBe(1);
			// The wedged connection was dropped; this request reconnects (the
			// handshake succeeds) and still counts as the second failure.
			await expect(redis.get("k")).rejects.toThrow(/timed out/);
			expect(connections).toBe(2);
			expect(breaker.state()).toBe("open");
			expect(breaker.snapshot().failures).toBe(2);

			// Open: refused before any socket is opened, without paying the command timeout.
			const started = Date.now();
			await expect(redis.get("k")).rejects.toBeInstanceOf(BreakerOpenError);
			expect(Date.now() - started).toBeLessThan(20);
			expect(connections).toBe(2);
			expect(redis.cooldownUntil?.()).toBeNull();
			expect(samples.map((sample) => `${sample.op}:${sample.outcome}`)).toEqual(["get:timeout", "get:timeout", "get:open"]);

			// Half-open probe against a server that answers again: connect + command
			// succeed as one outcome and close the breaker.
			now += 1_000;
			stall = false;
			expect(breaker.state()).toBe("half-open");
			expect(await redis.get("k")).toBeNull();
			expect(connections).toBe(3);
			expect(breaker.state()).toBe("closed");
			expect(breaker.snapshot().failures).toBe(0);
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
				steering: { history: null, liveSessions: null },
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
			headers: { "content-type": "application/json" },
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
		expect(sumCounter(defined(counter), { result: "bypass" })).toBeGreaterThan(0);
	});
});

/**
 * Single-flight and stale-while-revalidate (uplift-4 S4). Every test below
 * fails on the old `getOrLoad`: it had no in-flight map, no stale path and no
 * class on its samples.
 */
describe("single-flight (uplift-4 S4)", () => {
	function deferred() {
		const gate = Promise.withResolvers<void>();
		return { wait: gate.promise, open: () => gate.resolve() };
	}
	// One macrotask turn drains every promise continuation the fake redis produced; no wall-clock wait.
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

	test("N concurrent identical misses call the loader once and every caller gets the value", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const gate = deferred();
		let loads = 0;
		const load = async () => {
			loads += 1;
			await gate.wait;
			return [{ text: "shared" }];
		};
		const calls = Array.from({ length: 10 }, () => cache.getOrLoad({ ...read, load }));
		await settle();
		gate.open();
		const results = await Promise.all(calls);

		expect(loads).toBe(1);
		for (const result of results) expect(result).toEqual([{ text: "shared" }]);
		// Each waiter has its own copy: editing one does not edit another.
		expect(results[1]).not.toBe(results[2]);
		expect(redis.sets).toBe(1);
		expect(cache.health()).toMatchObject({ misses: 10, coalesced: 9 });
	});

	test("a rejecting loader does not poison later calls and every waiter sees the failure", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const gate = deferred();
		let loads = 0;
		const failing = async (): Promise<string> => {
			loads += 1;
			await gate.wait;
			throw new Error("source down");
		};
		const calls = Array.from({ length: 4 }, () => cache.getOrLoad({ ...read, klass: "brief", load: failing }).then(() => "ok", (cause: Error) => cause.message));
		await settle();
		gate.open();
		expect(await Promise.all(calls)).toEqual(["source down", "source down", "source down", "source down"]);
		expect(loads).toBe(1);

		expect(await cache.getOrLoad({ ...read, klass: "brief", load: async () => "recovered" })).toBe("recovered");
		expect(await cache.getOrLoad({ ...read, klass: "brief", load: async () => "never" })).toBe("recovered");
	});

	test("a degraded load is shared with nobody: waiters load for themselves and nothing is stored", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const gate = deferred();
		let loads = 0;
		const request = {
			...read,
			klass: "brief" as const,
			store: () => false,
			load: async () => {
				loads += 1;
				await gate.wait;
				return `thin ${loads}`;
			},
		};
		const calls = [cache.getOrLoad(request), cache.getOrLoad(request), cache.getOrLoad(request)];
		await settle();
		gate.open();
		await Promise.all(calls);

		expect(loads).toBe(3);
		expect(redis.sets).toBe(0);
		// Nothing is left registered: the next call loads again, and is not handed a stale promise.
		await cache.getOrLoad({ ...request, load: async () => "after" });
		expect(redis.sets).toBe(0);
	});

	test("the in-flight map is capped: beyond it requests load independently", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => 1_000, maxInflight: 2 });
		const gate = deferred();
		const loads = new Map<string, number>();
		const call = (name: string) =>
			cache.getOrLoad({
				...read,
				args: { name },
				load: async () => {
					loads.set(name, (loads.get(name) ?? 0) + 1);
					await gate.wait;
					return [{ text: name }];
				},
			});
		const calls = [call("a"), call("b"), call("c"), call("a"), call("b"), call("c")];
		await settle();
		gate.open();
		await Promise.all(calls);

		expect(loads.get("a")).toBe(1);
		expect(loads.get("b")).toBe(1);
		expect(loads.get("c")).toBe(2);
	});

	test("a load older than the join age is not joined, so a hung loader cannot capture later callers", async () => {
		const redis = new FakeRedis();
		let now = 1_000;
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => now, flightMaxAgeMs: 1_000 });
		const hung = Promise.withResolvers<string[]>();
		void cache.getOrLoad({ ...read, load: () => hung.promise }).catch(() => {});
		await settle();
		now += 5_000;
		expect(await cache.getOrLoad({ ...read, load: async () => ["independent"] })).toEqual(["independent"]);
		hung.resolve(["late"]);
	});

	test("a cache that errors still answers from the source, once per caller", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const cache = cacheOf(redis);
		let loads = 0;
		const load = async () => {
			loads += 1;
			return [{ text: "source" }];
		};
		expect(await Promise.all([cache.getOrLoad({ ...read, load }), cache.getOrLoad({ ...read, load })])).toEqual([[{ text: "source" }], [{ text: "source" }]]);
		expect(loads).toBe(2);
	});
});

describe("a waiter keeps its own deadline (uplift-4 S4)", () => {
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
	const DEGRADED = ["degraded"];

	/** Real timers, kept to tens of ms: the point is that the waiter's own timer fires while the shared load is still running. */
	test("a short-budget search joining a long-budget recall answers degraded at its own deadline and starts no load of its own", async () => {
		const redis = new FakeRedis();
		const cache = cacheOf(redis);
		const gate = Promise.withResolvers<string[]>();
		let loads = 0;
		const recall = cache.getOrLoad({
			...read,
			load: () => {
				loads += 1;
				return gate.promise;
			},
		});
		await settle();
		const started = Date.now();
		const search = await cache.getOrLoad({
			...read,
			load: async () => {
				loads += 1;
				return ["its own load"];
			},
			deadlineMs: 25,
			onDeadline: () => DEGRADED,
		});
		expect(search).toBe(DEGRADED);
		// The shared load never resolves here, so a waiter that waited for it would hang; this bound only catches a slow finite wait. It has room for a loaded host.
		expect(Date.now() - started).toBeLessThan(2_000);
		// Exactly one load ran, and the shared one was not cancelled: its owner still gets its answer.
		expect(loads).toBe(1);
		gate.resolve(["recall answer"]);
		expect(await recall).toEqual(["recall answer"]);
		expect(cache.health().coalesced).toBe(1);
	});

	test("a waiter whose owner comes back degraded loads once for itself, inside what is left of its budget", async () => {
		const cache = cacheOf(new FakeRedis());
		const gate = Promise.withResolvers<string[]>();
		let own = 0;
		const owner = cache.getOrLoad({ ...read, store: () => false, load: () => gate.promise });
		await settle();
		const waiter = cache.getOrLoad({
			...read,
			deadlineMs: 5_000,
			onDeadline: () => DEGRADED,
			load: async () => {
				own += 1;
				return ["waiter load"];
			},
		});
		await settle();
		gate.resolve(["thin"]);
		expect(await owner).toEqual(["thin"]);
		expect(await waiter).toEqual(["waiter load"]);
		expect(own).toBe(1);

		// And a waiter whose own load then outlives the budget answers degraded rather than waiting for it.
		const slowGate = Promise.withResolvers<string[]>();
		const gate2 = Promise.withResolvers<string[]>();
		const owner2 = cache.getOrLoad({ ...read, args: { query: "other" }, store: () => false, load: () => gate2.promise });
		await settle();
		const waiter2 = cache.getOrLoad({
			...read,
			args: { query: "other" },
			deadlineMs: 25,
			onDeadline: () => DEGRADED,
			load: () => slowGate.promise,
		});
		await settle();
		gate2.resolve(["thin"]);
		await owner2;
		expect(await waiter2).toBe(DEGRADED);
		slowGate.resolve([]);
	});

	test("an owner that degrades after the waiter's budget is spent: the waiter answers onDeadline and never starts its own load", async () => {
		let now = 1_000;
		const cache = cacheOf(new FakeRedis(), () => {}, () => now);
		const gate = Promise.withResolvers<string[]>();
		let own = 0;
		const owner = cache.getOrLoad({ ...read, store: () => false, load: () => gate.promise });
		await settle();
		const waiter = cache.getOrLoad({
			...read,
			deadlineMs: 5_000,
			onDeadline: () => DEGRADED,
			load: async () => {
				own += 1;
				return ["waiter load"];
			},
		});
		await settle();
		// The clock moves past the waiter's budget before the owner's degraded answer lands; its own timer has not fired.
		now += 6_000;
		gate.resolve(["thin"]);
		expect(await owner).toEqual(["thin"]);
		expect(await waiter).toBe(DEGRADED);
		expect(own).toBe(0);
	});

	test("callers with the same budget still coalesce, and a caller without a budget waits as before", async () => {
		const cache = cacheOf(new FakeRedis());
		const gate = Promise.withResolvers<string[]>();
		let loads = 0;
		const load = () => {
			loads += 1;
			return gate.promise;
		};
		const calls = [
			cache.getOrLoad({ ...read, load, deadlineMs: 5_000, onDeadline: () => DEGRADED }),
			cache.getOrLoad({ ...read, load, deadlineMs: 5_000, onDeadline: () => DEGRADED }),
			cache.getOrLoad({ ...read, load }),
		];
		await settle();
		gate.resolve(["shared"]);
		expect(await Promise.all(calls)).toEqual([["shared"], ["shared"], ["shared"]]);
		expect(loads).toBe(1);
		expect(cache.health().coalesced).toBe(2);
	});

	test("a deadline without an onDeadline answer is ignored: there is nothing to answer with", async () => {
		const cache = cacheOf(new FakeRedis());
		const gate = Promise.withResolvers<string[]>();
		const owner = cache.getOrLoad({ ...read, load: () => gate.promise });
		await settle();
		const waiter = cache.getOrLoad({ ...read, load: async () => ["x"], deadlineMs: 1 });
		await settle();
		gate.resolve(["shared"]);
		expect(await waiter).toEqual(["shared"]);
		expect(await owner).toEqual(["shared"]);
	});
});

describe("stale-while-revalidate (uplift-4 S4)", () => {
	const clock = { now: 1_000_000 };
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
	const iso = (ms: number) => new Date(ms).toISOString();

	interface Probe {
		loads: number;
		refreshLoads: number;
		served: number[];
		stored: string[];
	}
	const probeOf = (): Probe => ({ loads: 0, refreshLoads: 0, served: [], stored: [] });

	function cacheWith(redis: FakeRedis, mode: "off" | "shadow" | "enforce" | undefined, windowS = 30): ReadThroughCache {
		return new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => clock.now, ...(mode ? { swr: { mode, windowS } } : {}) });
	}

	function call(
		cache: ReadThroughCache,
		probe: Probe,
		hooks: {
			args?: unknown;
			load?: () => Promise<string>;
			refresh?: () => Promise<string>;
			degraded?: boolean;
			lastGood?: () => Promise<LastGood<string> | null>;
		} = {},
	): Promise<string> {
		const args = hooks.args ?? { repo: "acme/app" };
		return cache.getOrLoad({
			klass: "brief",
			surface: "cursor",
			args,
			generations: [MEMORY_GENERATION_KEY],
			load: async () => {
				probe.loads += 1;
				return (hooks.load ?? (async () => "live"))();
			},
			swr: {
				lastGood:
					hooks.lastGood ??
					(async () => {
						const good = await cache.peekQuiet<{ text: string; at: string }>("brief-snapshot", "cursor", args);
						return good ? { value: good.text, atMs: Date.parse(good.at), untilMs: null } : null;
					}),
				refresh: () => ({
					load: async () => {
						probe.refreshLoads += 1;
						return (hooks.refresh ?? (async () => "refreshed"))();
					},
					store: () => hooks.degraded !== true,
					stored: async (text) => {
						probe.stored.push(text);
						await cache.put("brief-snapshot", "cursor", args, { text, at: iso(clock.now) }, 3600);
					},
				}),
				served: (ageMs) => {
					probe.served.push(ageMs);
				},
			},
		});
	}

	const seed = (cache: ReadThroughCache, text: string, ageMs: number, args: unknown = { repo: "acme/app" }) =>
		cache.put("brief-snapshot", "cursor", args, { text, at: iso(clock.now - ageMs) }, 3600);

	test("shadow counts would_serve_stale and still serves the live value", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "shadow");
		const probe = probeOf();
		await seed(cache, "old", 5_000);

		expect(await call(cache, probe)).toBe("live");
		// The probe is not on the answer path; let it settle before reading its count.
		await settle();
		expect(probe).toMatchObject({ loads: 1, refreshLoads: 0, served: [] });
		expect(cache.health()).toMatchObject({ wouldServeStale: 1, stale: 0, refreshes: 0 });
	});

	test("enforce serves the last-good inside the window and refreshes exactly once under N callers", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		await seed(cache, "old", 5_000);
		const gate = Promise.withResolvers<void>();

		const calls = Array.from({ length: 6 }, () =>
			call(cache, probe, {
				refresh: async () => {
					await gate.promise;
					return "refreshed";
				},
			}),
		);
		expect(await Promise.all(calls)).toEqual(Array(6).fill("old"));
		expect(probe.loads).toBe(0);
		expect(probe.refreshLoads).toBe(1);
		expect(probe.served).toEqual(Array(6).fill(5_000));
		expect(cache.health()).toMatchObject({ stale: 6, refreshes: 1, wouldServeStale: 0 });

		gate.resolve();
		await settle();
		expect(probe.stored).toEqual(["refreshed"]);
		// The refresh stored the entry under the current generation and moved the last-good.
		expect(await call(cache, probe)).toBe("refreshed");
		expect(probe.refreshLoads).toBe(1);
		expect(await cache.peekQuiet<{ text: string }>("brief-snapshot", "cursor", { repo: "acme/app" })).toMatchObject({ text: "refreshed" });
	});

	test("a degraded refresh is never stored and never becomes the last-good", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		await seed(cache, "old", 5_000);

		expect(await call(cache, probe, { degraded: true, refresh: async () => "thin" })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(1);
		expect(probe.stored).toEqual([]);
		expect([...redis.values.keys()].filter((key) => classOf(key) === "brief")).toEqual([]);
		expect(await cache.peekQuiet<{ text: string }>("brief-snapshot", "cursor", { repo: "acme/app" })).toMatchObject({ text: "old" });
	});

	test("a failing refresh is swallowed, counted, and does not block the next one", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		await seed(cache, "old", 5_000);
		const failing = async (): Promise<string> => {
			throw new Error("source down");
		};

		expect(await call(cache, probe, { refresh: failing })).toBe("old");
		await settle();
		expect(cache.health().errors).toBe(1);
		expect(await call(cache, probe, { refresh: failing })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(2);
	});

	test("after the window the live value is loaded and nothing is served stale", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce", 30);
		const probe = probeOf();
		await seed(cache, "old", 29_000);
		clock.now += 1_000;

		expect(await call(cache, probe)).toBe("live");
		expect(probe).toMatchObject({ loads: 1, refreshLoads: 0, served: [] });
		expect(cache.health().stale).toBe(0);
	});

	test("a last-good from the future, or one past its own deadline, is not served", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		await seed(cache, "future", -5_000);
		expect(await call(cache, probe)).toBe("live");

		const expired = probeOf();
		expect(
			await call(cache, expired, {
				args: { repo: "other" },
				lastGood: async () => ({ value: "lease gone", atMs: clock.now - 1_000, untilMs: clock.now - 1 }),
			}),
		).toBe("live");
		expect(expired.served).toEqual([]);
	});

	test("the refresh cap holds: at most MAX_REFRESHES run at once, the rest are still answered stale", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		const gate = Promise.withResolvers<void>();
		const names = Array.from({ length: MAX_REFRESHES + 4 }, (_, index) => ({ n: index }));
		for (const args of names) await seed(cache, "old", 1_000, args);

		const answers = await Promise.all(
			names.map((args) =>
				call(cache, probe, {
					args,
					refresh: async () => {
						await gate.promise;
						return "refreshed";
					},
				}),
			),
		);
		expect(answers).toEqual(Array(names.length).fill("old"));
		expect(probe.refreshLoads).toBe(MAX_REFRESHES);
		gate.resolve();
		await settle();
	});

	test("a probe that throws, or a cache that errors, is the old answer", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "enforce");
		const probe = probeOf();
		expect(
			await call(cache, probe, {
				lastGood: async () => {
					throw new Error("probe failed");
				},
			}),
		).toBe("live");

		redis.fail = true;
		expect(await call(cache, probe)).toBe("live");
		expect(probe.served).toEqual([]);
	});

	test("off and shadow answer exactly what a cache without SWR answers, step for step", async () => {
		async function run(mode: "off" | "shadow" | undefined): Promise<{ answers: string[]; stored: string[]; health: unknown }> {
			const redis = new FakeRedis();
			const cache = cacheWith(redis, mode);
			const probe = probeOf();
			let version = 0;
			const load = async () => {
				version += 1;
				return `v${version}`;
			};
			const answers: string[] = [];
			answers.push(await call(cache, probe, { load }));
			answers.push(await call(cache, probe, { load }));
			await seed(cache, "old", 5_000);
			await cache.bump(MEMORY_GENERATION_KEY);
			answers.push(await call(cache, probe, { load }));
			answers.push(await call(cache, probe, { load }));
			const health = cache.health();
			return {
				answers,
				stored: [...redis.values.entries()].filter(([key]) => classOf(key) === "brief").map(([, value]) => value),
				health: { hits: health.hits, misses: health.misses, bypasses: health.bypasses, errors: health.errors, mode: health.mode },
			};
		}
		const baseline = await run(undefined);
		expect(baseline.answers).toEqual(["v1", "v1", "v2", "v2"]);
		expect(await run("off")).toEqual(baseline);
		expect(await run("shadow")).toEqual(baseline);
	});

	test("every sample carries a class from the closed set, including the new results", async () => {
		const redis = new FakeRedis();
		const samples: Array<{ result: string; cacheClass?: string }> = [];
		const cache = new ReadThroughCache({
			redis,
			enabled: true,
			log: () => {},
			now: () => clock.now,
			swr: { mode: "enforce", windowS: 30 },
			record: (sample) => samples.push(sample),
		});
		const probe = probeOf();
		await seed(cache, "old", 5_000);
		await call(cache, probe);
		await settle();
		await call(cache, probe);
		await cache.bump(MEMORY_GENERATION_KEY);
		await cache.getOrLoad({ ...read, load: async () => [{ text: "x" }] });

		expect(new Set(samples.map((sample) => sample.result))).toEqual(new Set(["miss", "stale", "refresh", "hit"]));
		for (const sample of samples) expect(CACHE_CLASSES as readonly string[]).toContain(sample.cacheClass as string);
		expect(samples.find((sample) => sample.result === "refresh")?.cacheClass).toBe("brief");
		expect(samples.find((sample) => sample.cacheClass === "memory-search")).toBeDefined();
	});

	function hungCache(): ReadThroughCache {
		return new ReadThroughCache({
			redis: new FakeRedis(),
			enabled: true,
			log: () => {},
			now: () => clock.now,
			swr: { mode: "enforce", windowS: 30 },
			flightMaxAgeMs: 5,
		});
	}

	test("a hung refresh keeps its key until the load settles, and a late load writes nothing over a newer snapshot", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => clock.now, swr: { mode: "enforce", windowS: 30 }, flightMaxAgeMs: 5 });
		const probe = probeOf();
		await seed(cache, "old", 5_000);
		const hung = Promise.withResolvers<string>();

		expect(await call(cache, probe, { refresh: () => hung.promise })).toBe("old");
		// Wait for the signal, not a guessed duration: the deadline counts one error.
		while (cache.health().errors === 0) await settle();
		// The deadline released the flight, not the key: a second refresh for the same key does not start while the first load lives.
		expect(await call(cache, probe, { refresh: async () => "second" })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(1);

		hung.resolve("late");
		await settle();
		await settle();
		// The late value was not stored, not as the entry and not as the last-good.
		expect(probe.stored).toEqual([]);
		expect([...redis.values.keys()].filter((key) => classOf(key) === "brief")).toEqual([]);
		expect(await cache.peekQuiet<{ text: string }>("brief-snapshot", "cursor", { repo: "acme/app" })).toMatchObject({ text: "old" });

		// Settled: the key is free again.
		expect(await call(cache, probe, { refresh: async () => "recovered" })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(2);
		expect(probe.stored).toEqual(["recovered"]);
	});

	test("MAX_REFRESHES stays strict after a deadline: hung loads keep their slots until they settle", async () => {
		const cache = hungCache();
		const probe = probeOf();
		const hung = Promise.withResolvers<string>();
		const names = Array.from({ length: MAX_REFRESHES + 1 }, (_, index) => ({ n: index }));
		for (const args of names) await seed(cache, "old", 1_000, args);
		for (const args of names.slice(0, MAX_REFRESHES)) await call(cache, probe, { args, refresh: () => hung.promise });
		while (cache.health().errors < MAX_REFRESHES) await settle();

		const extra = names[MAX_REFRESHES];
		expect(await call(cache, probe, { args: extra, refresh: async () => "extra" })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(MAX_REFRESHES);

		hung.resolve("late");
		await settle();
		await settle();
		expect(await call(cache, probe, { args: extra, refresh: async () => "extra" })).toBe("old");
		await settle();
		expect(probe.refreshLoads).toBe(MAX_REFRESHES + 1);
	});

	test("shadow never waits for its probe: a probe that has not settled does not delay the answer, and the count lands when it does", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "shadow");
		const probe = probeOf();
		const parked = Promise.withResolvers<void>();
		const answer = await call(cache, probe, {
			lastGood: async () => {
				await parked.promise;
				return { value: "old", atMs: clock.now - 1_000, untilMs: null };
			},
		});
		// Awaiting the probe on the answer path would never return here: it is parked.
		expect(answer).toBe("live");
		expect(probe.loads).toBe(1);
		expect(cache.health().wouldServeStale).toBe(0);
		parked.resolve();
		await settle();
		expect(cache.health()).toMatchObject({ wouldServeStale: 1, stale: 0 });
	});

	test("a probe that never settles neither delays the answer nor holds the flight slot", async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, "shadow");
		const probe = probeOf();
		const never = () => new Promise<null>(() => {});
		expect(await call(cache, probe, { lastGood: never })).toBe("live");
		// Settled: the key is free, so the next miss on a new generation loads again rather than joining.
		await cache.bump(MEMORY_GENERATION_KEY);
		expect(await call(cache, probe, { lastGood: never })).toBe("live");
		expect(probe.loads).toBe(2);
	});

	test("a failing last-good read is silent: no error, no bypass, the cache stays on, in both modes", async () => {
		for (const mode of ["shadow", "enforce"] as const) {
			const redis = new FakeRedis();
			const cache = cacheWith(redis, mode);
			const probe = probeOf();
			const get = redis.get.bind(redis);
			redis.get = async (key: string) => {
				if (classOf(key) === "brief-snapshot") throw new Error("snapshot read failed");
				return get(key);
			};
			// The default probe is `peekQuiet`, which reads the snapshot key.
			expect(await call(cache, probe)).toBe("live");
			expect(cache.health()).toMatchObject({ errors: 0, bypasses: 0, mode: "on", wouldServeStale: 0, stale: 0 });
		}
	});

	test("the metric class set is the cache's class set", () => {
		expect([...CACHE_METRIC_CLASSES]).toEqual([...CACHE_CLASSES]);
	});
});

describe("classOf (uplift-4 S4)", () => {
	test("names the class of every key the cache writes and nothing else", () => {
		expect(classOf(cacheKey("brief", "cursor", "0", {}))).toBe("brief");
		expect(classOf(cacheKey("memory-search", "cursor", "0", {}))).toBe("memory-search");
		expect(classOf(cacheKey("graph-view", "cursor", "0", {}))).toBe("graph-view");
		expect(classOf(cacheKey("docs-search", "cursor", "0", {}))).toBe("docs-search");
		expect(classOf(snapshotKey("brief-snapshot", "cursor", {}))).toBe("brief-snapshot");
		expect(classOf(MEMORY_GENERATION_KEY)).toBe("gen");
		expect(classOf(graphGenerationKey("ut-1"))).toBe("gen");
		expect(classOf("substrate:v1:budget:cursor:read")).toBe("budget");
		expect(classOf("substrate:v1:unknown:abc")).toBeNull();
		expect(classOf("other:v1:brief:abc")).toBeNull();
		expect(classOf("substrate:v1:__proto__:abc")).toBeNull();
	});
});
