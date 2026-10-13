/**
 * The brief fast path (uplift-2 R1).
 *
 * Parallel source reads under one budget, the degraded/ETag/304 contract on
 * `POST /brief`, the last-good snapshot, heartbeat invalidation scope, one
 * round trip for generation keys, and the memoised `/healthz`. Every store is
 * a fake; nothing here opens a socket to anything but its own server.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { BRIEF_SOURCES, composeBrief, recentActionsSql, type BriefSource } from "./brief.ts";
import {
	CACHE_TTL,
	GRAPHS_GENERATION_KEY,
	MEMORY_GENERATION_KEY,
	ReadThroughCache,
	graphGenerationKey,
	snapshotKey,
	type CacheRedis,
} from "./cache.ts";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer, etagMatches, type HttpServerOptions } from "./server.ts";
import { Substrate, briefEtag } from "./service.ts";

/** A redis that answers after `delayMs`, remembers every command and may lack MGET. */
class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly commands: string[] = [];
	readonly ttls: number[] = [];
	fail = false;
	mget?: (keys: readonly string[]) => Promise<Array<string | null>>;

	constructor(options: { mget?: boolean } = {}) {
		if (options.mget !== false) {
			this.mget = async (keys) => {
				this.commands.push(`MGET ${keys.length}`);
				if (this.fail) throw new Error("down");
				return keys.map((key) => this.values.get(key) ?? null);
			};
		}
	}

	async get(key: string): Promise<string | null> {
		this.commands.push("GET");
		if (this.fail) throw new Error("down");
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.commands.push("SET");
		if (this.fail) throw new Error("down");
		this.values.set(key, value);
		this.ttls.push(ttlSeconds);
	}

	async incr(key: string): Promise<number> {
		this.commands.push("INCR");
		if (this.fail) throw new Error("down");
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

/**
 * A read that reports when it was called and completes when the test says so,
 * so concurrency is proved by ordering, not by guessed durations. The only real
 * timers in this file sit in the deadline tests, because `sharedDeadline` is a
 * timer and the point of those tests is that it fires.
 */
function gated<T>(value: T): { read: () => Promise<T>; started: () => boolean; release: () => void } {
	const { promise, resolve } = Promise.withResolvers<T>();
	let called = false;
	return {
		read: () => {
			called = true;
			return promise;
		},
		started: () => called,
		release: () => resolve(value),
	};
}

/** Real time, for the deadline tests only (see `gated`). */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function graphView(graphId: string, status = "active") {
	return {
		graph_id: graphId,
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "cursor",
		status,
		pr_url: null,
		created: null,
		updated: null,
		nodes: [],
		steps: [],
		edges: [],
	};
}

/** Stderr lines written while `run` executes; the brief's fail-open path logs there. */
async function capturingStderr<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		return { value: await run(), lines };
	} finally {
		process.stderr.write = original;
	}
}

describe("composeBrief runs its reads together", () => {
	test("all four start before any finishes, and the sections keep their order", async () => {
		const graph = gated(graphView("ut-1"));
		const actions = gated([{ ts: Date.now(), surface: "cursor", summary: "committed a fix", node_id: null, step: null }]);
		const others = gated([graphView("ut-2", "open")]);
		const memory = gated([
			{ kind: "warning", text: "the disk is full", writer: "omp", trust: "verified", version: 1, needs_reverification: false, created: new Date().toISOString() },
		]);
		const index = { getGraph: graph.read, openGraphs: others.read, memoryForBrief: memory.read };
		const greptime = { sql: actions.read };
		const pending = composeBrief(
			{ repo: "acme/app", graph_id: "ut-1", surface: "cursor" },
			{ index: index as never, greptime: greptime as never },
			undefined,
			undefined,
			{ budgetMs: 1200 },
		);
		// Nothing has been released, yet every read has been asked for: the
		// sequential version would have asked for only the first.
		const sources: Record<BriefSource, { started: () => boolean }> = { graph, "recent actions": actions, "open graphs": others, memory };
		expect(BRIEF_SOURCES.map((source) => sources[source].started())).toEqual([true, true, true, true]);
		// Release in reverse section order; the text still reads in section order.
		memory.release();
		others.release();
		actions.release();
		graph.release();
		const brief = await pending;

		const order = ["active", "committed a fix", "Other open graphs here", "Warnings"].map((marker) => brief.indexOf(marker));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("a source slower than the budget is a failed read and the brief returns inside it", async () => {
		const never = Promise.withResolvers<never>().promise;
		const index = {
			getGraph: async () => graphView("ut-1"),
			openGraphs: () => never,
			memoryForBrief: async () => [],
		};
		const failed: BriefSource[] = [];
		const before = performance.now();
		const { value: brief, lines } = await capturingStderr(() =>
			composeBrief({ repo: "acme/app", graph_id: "ut-1", surface: "cursor" }, { index: index as never, greptime: null }, undefined, (source) => failed.push(source), {
				budgetMs: 60,
			}),
		);
		expect(performance.now() - before).toBeLessThan(600);
		expect(brief).toContain("active");
		expect(brief).not.toContain("Other open graphs");
		expect(failed).toEqual(["open graphs"]);
		expect(lines.some((line) => line.includes("open graphs") && line.includes("deadline"))).toBe(true);
	});

	test("budget 0 means no deadline", async () => {
		// The contrast with the test above: the same slow read, no budget, no
		// failure. Real time, because the absence of a timer is what is proved.
		const others = gated([graphView("ut-2", "open")]);
		const index = { getGraph: async () => null, openGraphs: others.read, memoryForBrief: async () => [] };
		const failed: BriefSource[] = [];
		const pending = composeBrief({ repo: "acme/app", surface: "cursor" }, { index: index as never, greptime: null }, undefined, (source) => failed.push(source), {
			budgetMs: 0,
		});
		await sleep(80);
		others.release();
		const brief = await pending;
		expect(failed).toEqual([]);
		expect(brief).toContain("Other open graphs here: ut-2");
	});

	test("the recent-actions statement is bounded in time and carries the budget as its timeout", async () => {
		const calls: Array<{ statement: string; timeoutMs: number | undefined }> = [];
		const greptime = {
			sql: async (statement: string, timeoutMs?: number) => {
				calls.push({ statement, timeoutMs });
				return [];
			},
		};
		const now = Date.parse("2026-10-13T12:00:00.000Z");
		await composeBrief({ repo: "Acme/App", surface: "cursor" }, { index: null, greptime: greptime as never }, undefined, undefined, {
			budgetMs: 900,
			recentWindowDays: 7,
			now: () => now,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.timeoutMs).toBe(900);
		expect(calls[0]?.statement).toContain(`"ts" >= '2026-10-06T12:00:00.000Z'`);
		expect(calls[0]?.statement).toBe(recentActionsSql("Acme/App", now - 7 * 86_400_000));
		expect(calls[0]?.statement).toContain("LIMIT 5");

		await composeBrief({ repo: "acme/app", surface: "cursor" }, { index: null, greptime: greptime as never }, undefined, undefined, { budgetMs: 0 });
		// No budget: the client's own default timeout applies.
		expect(calls[1]?.timeoutMs).toBeUndefined();
		expect(calls[1]?.statement).toMatch(/"ts" >= '20\d\d-/);
	});
});

describe("Substrate.briefDetailed", () => {
	function substrateWith(index: Record<string, unknown>, redis: FakeRedis = new FakeRedis(), env: Record<string, string> = {}) {
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		return { substrate: new Substrate(loadConfig(env), { index: index as never, greptime: null, cache }), cache, redis };
	}
	const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };

	test("complete: every source answered, a weak etag of the text, nothing failed", async () => {
		const { substrate } = substrateWith({
			getGraph: async () => graphView("ut-1"),
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		});
		const detail = await substrate.briefDetailed(request);
		expect(detail.state).toBe("complete");
		expect(detail.failed).toEqual([]);
		expect(detail.snapshotAt).toBeNull();
		expect(detail.etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
		expect(detail.etag).toBe(briefEtag(detail.text));
		expect(await substrate.brief(request)).toBe(detail.text);
		// Same text, same tag — that is what lets a caller skip it.
		expect((await substrate.briefDetailed(request)).etag).toBe(detail.etag);
		expect(briefEtag("a")).not.toBe(briefEtag("b"));
	});

	test("degraded: names the sources that failed; the thin text is still the answer", async () => {
		const { substrate, redis } = substrateWith({
			getGraph: () => Promise.reject(new Error("postgres is down")),
			openGraphs: async () => [],
			memoryForBrief: () => Promise.reject(new Error("postgres is down")),
		});
		const detail = await substrate.briefDetailed(request);
		expect(detail.state).toBe("degraded");
		expect(detail.failed).toEqual(["graph", "memory"]);
		expect(detail.text).toContain("not in the index yet");
		expect(detail.snapshotAt).toBeNull();
		// Degraded answers are never stored — not as a brief, not as a snapshot.
		expect(redis.commands.filter((command) => command === "SET")).toHaveLength(0);
	});

	test("snapshot: a complete brief is kept, and served with a banner once the live compose degrades", async () => {
		let down = false;
		const { substrate, redis } = substrateWith({
			getGraph: async () => {
				if (down) throw new Error("postgres is down");
				return graphView("ut-1");
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		});
		const complete = await substrate.briefDetailed(request);
		expect(complete.state).toBe("complete");
		const stored = redis.values.get(snapshotKey("brief-snapshot", "cursor", { repo: "acme/app", branch: null, graph_id: "ut-1" }));
		expect(stored).toBeDefined();
		expect(JSON.parse(stored as string)).toMatchObject({ v: { text: complete.text } });
		expect(redis.ttls).toContain(CACHE_TTL["brief-snapshot"]);
		// A cache hit does not rewrite the snapshot: one SET for the brief, one for the snapshot, then none.
		await substrate.briefDetailed(request);
		expect(redis.commands.filter((command) => command === "SET")).toHaveLength(2);

		down = true;
		await redis.incr(graphGenerationKey("ut-1"));
		const served = await substrate.briefDetailed(request);
		expect(served.state).toBe("snapshot");
		expect(served.failed).toEqual(["graph"]);
		expect(served.snapshotAt).not.toBeNull();
		expect(served.text.split("\n")[0]).toBe(`_(substrate brief snapshot from ${served.snapshotAt}; live sources degraded: graph)_`);
		expect(served.text).toContain(complete.text);
		expect(served.text).toContain("active");
		expect(served.etag).not.toBe(complete.etag);
		expect(redis.commands.filter((command) => command === "SET")).toHaveLength(2);
	});

	test("SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=0 writes no snapshot and reads none", async () => {
		let down = false;
		const { substrate, redis } = substrateWith(
			{
				getGraph: async () => {
					if (down) throw new Error("postgres is down");
					return graphView("ut-1");
				},
				openGraphs: async () => [],
				memoryForBrief: async () => [],
			},
			new FakeRedis(),
			{ SUBSTRATE_BRIEF_SNAPSHOT_TTL_S: "0" },
		);
		await substrate.briefDetailed(request);
		expect(redis.commands.filter((command) => command === "SET")).toHaveLength(1);
		expect([...redis.values.keys()].some((key) => key.includes(":brief-snapshot:"))).toBe(false);
		down = true;
		await redis.incr(graphGenerationKey("ut-1"));
		const commandsBefore = redis.commands.length;
		const detail = await substrate.briefDetailed(request);
		expect(detail.state).toBe("degraded");
		// No snapshot read was attempted: the generation MGET and the brief GET only.
		expect(redis.commands.slice(commandsBefore).filter((command) => command === "GET")).toHaveLength(1);
	});

	test("a cache that is down never fails the brief, snapshot or not", async () => {
		const redis = new FakeRedis();
		redis.fail = true;
		const { substrate } = substrateWith({ getGraph: () => Promise.reject(new Error("down")), openGraphs: async () => [], memoryForBrief: async () => [] }, redis);
		const detail = await substrate.briefDetailed(request);
		expect(detail.state).toBe("degraded");
		expect(detail.text).toContain("not in the index yet");
	});
});

describe("heartbeat invalidation scope", () => {
	test("a heartbeat bumps only the graph's own generation; a claim still bumps the shared one", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const bumps: string[] = [];
		cache.bump = async (key: string) => {
			bumps.push(key);
		};
		const lease = { lease_id: "lease-1", expires_at: new Date(Date.now() + 60_000).toISOString() };
		const index = {
			heartbeatNode: async () => ({ ok: true, lease, decision: { ok: true } }),
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache });
		const result = await substrate.heartbeatNode("ut-1", "n1", "lease-1", "cursor");
		expect(result.ok).toBe(true);
		expect(bumps).toEqual([graphGenerationKey("ut-1")]);
		expect(bumps).not.toContain(GRAPHS_GENERATION_KEY);
	});

	test("a refused heartbeat bumps nothing", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const bumps: string[] = [];
		cache.bump = async (key: string) => {
			bumps.push(key);
		};
		const index = {
			heartbeatNode: async () => ({ ok: false, lease: null, decision: { ok: false, reason: "not-holder" } }),
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache });
		await substrate.heartbeatNode("ut-1", "n1", "lease-1", "cursor");
		expect(bumps).toEqual([]);
	});
});

describe("generation keys are read in one round trip", () => {
	test("MGET when the client has it", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		await cache.getOrLoad({
			klass: "brief",
			surface: "cursor",
			args: { repo: "acme/app" },
			generations: [MEMORY_GENERATION_KEY, GRAPHS_GENERATION_KEY, graphGenerationKey("ut-1")],
			load: async () => "text",
		});
		expect(redis.commands).toEqual(["MGET 3", "GET", "SET"]);
		await redis.incr(MEMORY_GENERATION_KEY);
		redis.commands.length = 0;
		expect(
			await cache.getOrLoad({
				klass: "brief",
				surface: "cursor",
				args: { repo: "acme/app" },
				generations: [MEMORY_GENERATION_KEY, GRAPHS_GENERATION_KEY],
				load: async () => "fresh",
			}),
		).toBe("fresh");
		// The bumped generation changed the key: a miss, not a stale hit.
		expect(redis.commands).toEqual(["MGET 2", "GET", "SET"]);
		expect(cache.health()).toMatchObject({ misses: 2, hits: 0 });
	});

	test("concurrent GETs when it does not, all in flight together", async () => {
		const redis = new FakeRedis({ mget: false });
		// The first three GETs (the generation keys) park until all three have
		// been asked for; a sequential reader would deadlock here, a concurrent
		// one proceeds. The entry GET that follows passes straight through.
		const parked: Array<() => void> = [];
		let seen = 0;
		const get = redis.get.bind(redis);
		redis.get = async (key: string) => {
			seen += 1;
			if (seen <= 3) {
				const { promise, resolve } = Promise.withResolvers<void>();
				parked.push(resolve);
				if (parked.length === 3) for (const release of parked.splice(0)) release();
				await promise;
			}
			return get(key);
		};
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		await cache.getOrLoad({
			klass: "brief",
			surface: "cursor",
			args: {},
			generations: [MEMORY_GENERATION_KEY, GRAPHS_GENERATION_KEY, graphGenerationKey("ut-1")],
			load: async () => "text",
		});
		// Three generation GETs plus the entry GET; none of them hit MGET.
		expect(redis.commands.filter((command) => command === "GET")).toHaveLength(4);
		expect(redis.commands.some((command) => command.startsWith("MGET"))).toBe(false);
	});
});

describe("ETag comparison", () => {
	test("is weak, list-aware and honours *", () => {
		const tag = 'W/"abc"';
		expect(etagMatches('W/"abc"', tag)).toBe(true);
		expect(etagMatches('"abc"', tag)).toBe(true);
		expect(etagMatches('"zzz", W/"abc"', tag)).toBe(true);
		expect(etagMatches("*", tag)).toBe(true);
		expect(etagMatches(['"zzz"', 'W/"abc"'], tag)).toBe(true);
		expect(etagMatches('"abd"', tag)).toBe(false);
		expect(etagMatches(undefined, tag)).toBe(false);
		expect(etagMatches("", tag)).toBe(false);
	});
});

describe("over HTTP", () => {
	interface Harness {
		base: string;
		observability: Observability;
		close(): void;
	}
	const running: Harness[] = [];
	afterAll(() => {
		for (const harness of running) harness.close();
	});

	async function start(env: Record<string, string> = {}, stores: Record<string, unknown> = {}, options?: HttpServerOptions): Promise<Harness> {
		const config: SubstrateConfig = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: null, ...stores } as ConstructorParameters<typeof Substrate>[1], observability.observer);
		const server = createHttpServer(substrate, config, observability, options);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const { port } = server.address() as AddressInfo;
		const harness: Harness = {
			base: `http://127.0.0.1:${port}`,
			observability,
			close() {
				observability.stop();
				server.close();
			},
		};
		running.push(harness);
		return harness;
	}

	const briefBody = JSON.stringify({ surface: "cursor", repo: "acme/app", graph_id: "ut-1" });

	test("POST /brief carries ETag, X-Substrate-Brief and Cache-Control, and answers 304 to a matching If-None-Match", async () => {
		const harness = await start({}, {
			index: { getGraph: async () => graphView("ut-1"), openGraphs: async () => [], memoryForBrief: async () => [] },
		});
		const first = await fetch(`${harness.base}/brief`, { method: "POST", body: briefBody });
		expect(first.status).toBe(200);
		const etag = first.headers.get("etag");
		expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
		expect(first.headers.get("x-substrate-brief")).toBe("complete");
		expect(first.headers.get("x-substrate-brief-failed")).toBeNull();
		expect(first.headers.get("cache-control")).toBe("no-cache");
		expect(first.headers.get("content-type")).toContain("text/markdown");
		const text = await first.text();
		expect(text).toContain("active");

		const unchanged = await fetch(`${harness.base}/brief`, { method: "POST", body: briefBody, headers: { "if-none-match": etag as string } });
		expect(unchanged.status).toBe(304);
		expect(await unchanged.text()).toBe("");
		expect(unchanged.headers.get("etag")).toBe(etag);
		expect(unchanged.headers.get("x-substrate-brief")).toBe("complete");

		// Weak comparison: the strong form of the same opaque tag matches too.
		const strong = await fetch(`${harness.base}/brief`, { method: "POST", body: briefBody, headers: { "if-none-match": (etag as string).replace(/^W\//, "") } });
		expect(strong.status).toBe(304);

		const other = await fetch(`${harness.base}/brief`, { method: "POST", body: briefBody, headers: { "if-none-match": 'W/"00000000000000000000000000000000"' } });
		expect(other.status).toBe(200);
		expect(await other.text()).toBe(text);
	});

	test("a degraded brief is still 200, says so in the headers, and names what failed", async () => {
		const harness = await start({}, {
			index: {
				getGraph: () => Promise.reject(new Error("postgres is down")),
				openGraphs: async () => [],
				memoryForBrief: () => Promise.reject(new Error("postgres is down")),
			},
		});
		const response = await fetch(`${harness.base}/brief`, { method: "POST", body: briefBody });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-substrate-brief")).toBe("degraded");
		expect(response.headers.get("x-substrate-brief-failed")).toBe("graph,memory");
		expect(response.headers.get("etag")).toMatch(/^W\//);
		expect(await response.text()).toContain("not in the index yet");
	});

	test("GET /healthz is memoised for SUBSTRATE_HEALTHZ_CACHE_MS and recomputed after", async () => {
		let pings = 0;
		let now = 1_000_000;
		const harness = await start(
			{ SUBSTRATE_HEALTHZ_CACHE_MS: "5000" },
			{
				index: {
					ping: async () => {
						pings += 1;
						return true;
					},
					capacity: async () => null,
				},
			},
			{ now: () => now },
		);
		const first = await fetch(`${harness.base}/healthz`);
		const firstBody = (await first.json()) as { index: boolean; cachedAt: string; stale: boolean };
		expect(first.status).toBe(200);
		expect(firstBody.index).toBe(true);
		expect(firstBody.stale).toBe(false);
		expect(firstBody.cachedAt).toBe(new Date(now).toISOString());
		expect(pings).toBe(1);

		now += 4_999;
		const second = (await (await fetch(`${harness.base}/healthz`)).json()) as { cachedAt: string; stale: boolean };
		expect(second.stale).toBe(true);
		expect(second.cachedAt).toBe(firstBody.cachedAt);
		expect(pings).toBe(1);

		now += 1;
		const third = (await (await fetch(`${harness.base}/healthz`)).json()) as { cachedAt: string; stale: boolean };
		expect(third.stale).toBe(false);
		expect(third.cachedAt).toBe(new Date(now).toISOString());
		expect(pings).toBe(2);

		// `/metrics` and `/slo` are never memoised.
		expect((await fetch(`${harness.base}/metrics`)).status).toBe(200);
		expect((await fetch(`${harness.base}/slo`)).status).toBe(200);
	});

	test("SUBSTRATE_HEALTHZ_CACHE_MS=0 recomputes on every call", async () => {
		let pings = 0;
		const harness = await start(
			{ SUBSTRATE_HEALTHZ_CACHE_MS: "0" },
			{
				index: {
					ping: async () => {
						pings += 1;
						return true;
					},
					capacity: async () => null,
				},
			},
		);
		for (let i = 0; i < 3; i++) {
			const body = (await (await fetch(`${harness.base}/healthz`)).json()) as { stale: boolean };
			expect(body.stale).toBe(false);
		}
		expect(pings).toBe(3);
	});
});

describe("config knobs", () => {
	test("default on, 0 switches each off, junk falls back", () => {
		const defaults = loadConfig({});
		expect(defaults.briefBudgetMs).toBe(1200);
		expect(defaults.briefRecentWindowDays).toBe(30);
		expect(defaults.briefSnapshotTtlS).toBe(3600);
		expect(defaults.cacheCommandTimeoutMs).toBe(250);
		expect(defaults.cacheConnectTimeoutMs).toBe(250);
		expect(defaults.healthzCacheMs).toBe(5000);

		const off = loadConfig({ SUBSTRATE_BRIEF_BUDGET_MS: "0", SUBSTRATE_BRIEF_SNAPSHOT_TTL_S: "0", SUBSTRATE_HEALTHZ_CACHE_MS: "0" });
		expect(off.briefBudgetMs).toBe(0);
		expect(off.briefSnapshotTtlS).toBe(0);
		expect(off.healthzCacheMs).toBe(0);

		const junk = loadConfig({
			SUBSTRATE_BRIEF_BUDGET_MS: "soon",
			SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS: "0",
			SUBSTRATE_BRIEF_SNAPSHOT_TTL_S: "",
			SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS: "-1",
			SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS: "x",
			SUBSTRATE_HEALTHZ_CACHE_MS: " ",
		});
		expect(junk).toMatchObject({
			briefBudgetMs: 1200,
			briefRecentWindowDays: 30,
			briefSnapshotTtlS: 3600,
			cacheCommandTimeoutMs: 250,
			cacheConnectTimeoutMs: 250,
			healthzCacheMs: 5000,
		});
		expect(loadConfig({ SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS: "40.9", SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS: "7" })).toMatchObject({
			cacheCommandTimeoutMs: 40,
			briefRecentWindowDays: 7,
		});
	});
});
