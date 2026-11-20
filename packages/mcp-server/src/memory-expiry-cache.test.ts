/**
 * What the cache must not do with an expired memory (uplift-3 N4, Greptile
 * round 1 on PR #61):
 *
 *   - a `ttl: graph` entry's verdict is read off `graph_index`, so a graph
 *     finishing must drop the cached searches that still list it — before the
 *     10-minute search TTL, which `refreshAt` cannot shorten because a `graph`
 *     entry has no `expires_at`;
 *   - a brief composed under `report` carries expired advice (tagged), so it
 *     must not be served `complete`, nor replayed as a last-good snapshot,
 *     by a process restarted into `enforce`.
 *
 * The index is a stub that hides a graph entry once its graph is `Merged`, the
 * way `IndexStore.servable` does under `enforce`; what is under test is the
 * service's cache keys and dependencies, not the predicate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GRAPHS_GENERATION_KEY, MEMORY_GENERATION_KEY, ReadThroughCache, graphGenerationKey, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import type { MemoryEntry } from "./types.ts";
import { withoutHindsightEnv } from "./test-support.ts";

/** A redis that remembers every command, so a generation bump is observable. */
class FakeRedis implements CacheRedis {
	readonly values: Map<string, string>;
	readonly commands: string[] = [];
	constructor(seed: Iterable<[string, string]> = []) {
		this.values = new Map(seed);
	}
	async get(key: string): Promise<string | null> {
		this.commands.push(`GET ${key}`);
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.commands.push(`SET ${key} ttl=${ttlSeconds}`);
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		this.commands.push(`INCR ${key}`);
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

function cacheOf(redis: FakeRedis): ReadThroughCache {
	return new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => 1_000 });
}

const GRAPH_VIEW = {
	graph_id: "ut-1",
	notion_task_page: null,
	repo: "acme/app",
	branch: null,
	surface: null,
	status: "Merged",
	pr_url: null,
	created: null,
	updated: null,
	nodes: [],
	steps: [],
	edges: [],
};

function graphEntry(over: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_graph",
		scope: "graph:ut-1",
		kind: "decision",
		text: "keep the prefix while ut-1 is open",
		writer: "cursor",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "graph",
		graph_id: "ut-1",
		created: "2026-10-01T00:00:00.000Z",
		version: 1,
		entry_hash: "h1",
		needs_reverification: false,
		expired: false,
		...over,
	};
}

describe("a finished graph drops the cached searches that still list its memories", () => {
	let restoreHindsightEnv: () => void = () => {};
	beforeEach(() => {
		restoreHindsightEnv = withoutHindsightEnv();
	});
	afterEach(() => restoreHindsightEnv());

	/**
	 * The index as `enforce` reads it: the graph entry is served while its graph
	 * is open and left out once `graph_index` says `Merged`. `registerGraph` is
	 * the service path that moves the status and bumps the graph generations.
	 */
	function enforcingIndex() {
		let status = "In Progress";
		let loads = 0;
		const page = () => {
			loads += 1;
			return status === "Merged" ? [] : [graphEntry()];
		};
		return {
			loads: () => loads,
			index: {
				searchMemory: async () => page(),
				searchMemoryPage: async () => ({ entries: page(), next: null }),
				registerGraph: async (plan: { status?: string }) => {
					status = plan.status ?? status;
					return { ...GRAPH_VIEW, status };
				},
			},
		};
	}

	test("the list search misses on the graphs generation the register bumped, without waiting for the TTL", async () => {
		const stub = enforcingIndex();
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "enforce" }), {
			index: stub.index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(redis),
		});

		const first = await substrate.searchMemory("prefix", "graph:ut-1", undefined, undefined, "cursor");
		expect(first.entries.map((entry) => entry.id)).toEqual(["mem_graph"]);
		const again = await substrate.searchMemory("prefix", "graph:ut-1", undefined, undefined, "cursor");
		expect(again.entries.map((entry) => entry.id)).toEqual(["mem_graph"]);
		expect(stub.loads()).toBe(1);

		// Nothing was written to memory — only the graph moved. The register bumps
		// the graph's own key and the shared one every brief embeds.
		await substrate.registerGraph({ graph_id: "ut-1", status: "Merged" } as never);
		expect(redis.values.get(MEMORY_GENERATION_KEY)).toBeUndefined();
		expect(redis.values.get(GRAPHS_GENERATION_KEY)).toBe("1");
		expect(redis.values.get(graphGenerationKey("ut-1"))).toBe("1");

		const after = await substrate.searchMemory("prefix", "graph:ut-1", undefined, undefined, "cursor");
		expect(after.entries).toEqual([]);
		expect(stub.loads()).toBe(2);
		// The cache was consulted, not bypassed: the generation read includes the graphs key.
		expect(redis.commands.filter((line) => line.startsWith(`GET ${GRAPHS_GENERATION_KEY}`)).length).toBeGreaterThanOrEqual(3);
	});

	test("the paged search shares the dependency", async () => {
		const stub = enforcingIndex();
		const redis = new FakeRedis();
		const substrate = new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "enforce" }), {
			index: stub.index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(redis),
		});
		const request = { subject_prefix: "decision:", scope: "graph:ut-1" };

		expect((await substrate.searchMemoryPage(request, "cursor")).entries.map((entry) => entry.id)).toEqual(["mem_graph"]);
		expect((await substrate.searchMemoryPage(request, "cursor")).entries.map((entry) => entry.id)).toEqual(["mem_graph"]);
		expect(stub.loads()).toBe(1);

		await substrate.registerGraph({ graph_id: "ut-1", status: "Merged" } as never);
		expect((await substrate.searchMemoryPage(request, "cursor")).entries).toEqual([]);
		expect(stub.loads()).toBe(2);
	});

	test("under report the dependency holds too, so a served tag never outlives its graph", async () => {
		// `report` serves the entry either way; what must not be stale is its tag.
		let status = "In Progress";
		let loads = 0;
		const index = {
			searchMemory: async () => {
				loads += 1;
				return [graphEntry({ expired: status === "Merged" })];
			},
			registerGraph: async (plan: { status?: string }) => {
				status = plan.status ?? status;
				return { ...GRAPH_VIEW, status };
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache: cacheOf(new FakeRedis()), steering: { history: null, liveSessions: null } });
		expect((await substrate.searchMemory("prefix", undefined, undefined, undefined, "cursor")).entries[0]?.expired).toBe(false);
		await substrate.registerGraph({ graph_id: "ut-1", status: "Merged" } as never);
		expect((await substrate.searchMemory("prefix", undefined, undefined, undefined, "cursor")).entries[0]?.expired).toBe(true);
		expect(loads).toBe(2);
	});
});

describe("a brief cached under report is not served under enforce", () => {
	const request = { surface: "cursor" as const, repo: "acme/app" };

	/** An index whose brief memory is one expired entry under `report` and nothing under `enforce`. */
	function briefIndex(mode: "report" | "enforce", fail = false) {
		let loads = 0;
		return {
			loads: () => loads,
			index: {
				getGraph: async () => null,
				openGraphs: async () => [],
				memoryForBrief: async () => {
					loads += 1;
					if (fail) throw new Error("postgres is down");
					return mode === "report" ? [graphEntry({ kind: "warning", text: "old advice", expired: true })] : [];
				},
			},
		};
	}

	test("the answer key and the snapshot key both carry the mode, so a restart into enforce composes afresh", async () => {
		const redis = new FakeRedis();
		const reporting = briefIndex("report");
		const before = new Substrate(loadConfig({}), { index: reporting.index as never, greptime: null, cache: cacheOf(redis), steering: { history: null, liveSessions: null } });
		const served = await before.briefDetailed(request);
		expect(served.state).toBe("complete");
		expect(served.text).toContain("old advice");
		expect(served.text).toContain("— expired");
		expect(await before.brief(request)).toBe(served.text);
		expect(reporting.loads()).toBe(1);
		// A report-mode snapshot now sits in redis beside the answer.
		expect(redis.commands.filter((line) => line.startsWith("SET substrate:v1:brief-snapshot:"))).toHaveLength(1);
		const reportSnapshots = [...redis.values].filter(([key]) => key.includes(":brief-snapshot:"));
		expect(reportSnapshots).toHaveLength(1);

		// The same redis, a process restarted into enforce: the report answer is not a hit…
		const enforcing = briefIndex("enforce");
		const after = new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "enforce" }), {
			index: enforcing.index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(redis),
		});
		const fresh = await after.briefDetailed(request);
		expect(fresh.state).toBe("complete");
		expect(fresh.text).not.toContain("old advice");
		expect(enforcing.loads()).toBe(1);

		// …and the report snapshot is not what a degraded enforce brief falls back
		// to. A redis holding only the report-mode snapshot: a report process
		// whose index is down replays it, an enforce process does not find it.
		// The enforce compose wrote a snapshot of its own, under a different key.
		const allSnapshots = [...redis.values].filter(([key]) => key.includes(":brief-snapshot:"));
		expect(allSnapshots).toHaveLength(2);
		const snapshots = reportSnapshots;
		const replayed = await new Substrate(loadConfig({}), {
			index: briefIndex("report", true).index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(new FakeRedis(snapshots)),
		}).briefDetailed(request);
		expect(replayed.state).toBe("snapshot");
		expect(replayed.text).toContain("old advice");
		const fallen = await new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "enforce" }), {
			index: briefIndex("enforce", true).index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(new FakeRedis(snapshots)),
		}).briefDetailed(request);
		expect(fallen.state).toBe("degraded");
		expect(fallen.text).not.toContain("old advice");
	});

	test("under report the brief keys are the keys they were", async () => {
		// Pinned so the mode marker cannot creep into the default key: an upgrade
		// must not cold-start every report-mode brief.
		const redis = new FakeRedis();
		const stub = briefIndex("report");
		const substrate = new Substrate(loadConfig({}), { index: stub.index as never, greptime: null, cache: cacheOf(redis), steering: { history: null, liveSessions: null } });
		await substrate.brief(request);
		const sets = redis.commands.filter((line) => line.startsWith("SET substrate:v1:brief:"));
		expect(sets).toHaveLength(1);
		const explicit = new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "report" }), {
			index: briefIndex("report").index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(redis),
		});
		await explicit.brief(request);
		// A second process with the mode spelled out reads the first one's entry: no second SET.
		expect(redis.commands.filter((line) => line.startsWith("SET substrate:v1:brief:"))).toEqual(sets);
	});

	test("each mode writes its own answer key and its own snapshot key", async () => {
		const redis = new FakeRedis();
		await new Substrate(loadConfig({}), { index: briefIndex("report").index as never, greptime: null, cache: cacheOf(redis), steering: { history: null, liveSessions: null } }).brief(request);
		await new Substrate(loadConfig({ SUBSTRATE_MEMORY_EXPIRY: "enforce" }), {
			index: briefIndex("enforce").index as never,
			steering: { history: null, liveSessions: null },
			greptime: null,
			cache: cacheOf(redis),
		}).brief(request);
		const written = (klass: string) =>
			redis.commands.filter((line) => line.startsWith(`SET substrate:v1:${klass}:`)).map((line) => line.split(" ")[1]);
		expect(new Set(written("brief")).size).toBe(2);
		expect(new Set(written("brief-snapshot")).size).toBe(2);
	});
});
