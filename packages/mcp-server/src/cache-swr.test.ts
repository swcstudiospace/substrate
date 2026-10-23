/**
 * Single-flight and stale-while-revalidate through `Substrate.briefDetailed` and
 * `POST /brief` (uplift-4 S4). `cache.test.ts` proves the cache in isolation;
 * these prove the call site: which generation a flight belongs to, that `off`
 * and `shadow` keep read-your-writes, what `enforce` advertises, and what the
 * snapshot records about its own deadline. Every store is a fake.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { MEMORY_GENERATION_KEY, ReadThroughCache, snapshotKey, type CacheRedis, type CacheSwrMode } from "./cache.ts";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

class MapRedis implements CacheRedis {
	readonly values = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function node(leaseExpiresAt: string | null) {
	return {
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
		lease_expires_at: leaseExpiresAt,
		lease_heartbeat_at: null,
		lease_epoch: 1,
	};
}

function graphView(status: string, leaseExpiresAt: string | null = null) {
	return {
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "cursor",
		status,
		pr_url: null,
		created: null,
		updated: null,
		nodes: leaseExpiresAt === null ? [] : [node(leaseExpiresAt)],
		steps: [],
		edges: [],
	};
}

const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };
/** The brief's cache arguments, as `briefDetailed` builds them under the default expiry mode. */
const SNAPSHOT_ARGS = { repo: "acme/app", branch: null, graph_id: "ut-1" };
/** Every POST that carries a body names its media type: `POST /brief` answers 415 to anything else. */
const JSON_HEADERS = { "content-type": "application/json" };

interface Rig {
	substrate: Substrate;
	cache: ReadThroughCache;
	redis: MapRedis;
	config: SubstrateConfig;
	state: { status: string; down: boolean; lease: string | null; reads: number; memory: unknown[] };
}

/** `offsetMs` runs the cache's clock ahead of the snapshot's own timestamp, so a stale age is exact. */
function rigOf(mode: CacheSwrMode, offsetMs = 0): Rig {
	const redis = new MapRedis();
	const config = loadConfig({});
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => Date.now() + offsetMs, swr: { mode, windowS: 30 } });
	const state = { status: "active", down: false, lease: null as string | null, reads: 0, memory: [] as unknown[] };
	const index = {
		getGraph: async () => {
			state.reads += 1;
			if (state.down) throw new Error("postgres is down");
			return graphView(state.status, state.lease);
		},
		openGraphs: async () => [],
		memoryForBrief: async () => state.memory,
	};
	return { substrate: new Substrate(config, { index: index as never, greptime: null, cache }), cache, redis, config, state };
}

describe("single-flight across generations (uplift-4 S4)", () => {
	test("identical concurrent briefs share one compose; a caller on a newer generation does not join the older flight", async () => {
		const redis = new MapRedis();
		const config = loadConfig({});
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const first = Promise.withResolvers<unknown>();
		let calls = 0;
		const index = {
			getGraph: () => {
				calls += 1;
				return calls === 1 ? first.promise : Promise.resolve(graphView("blocked"));
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
		const substrate = new Substrate(config, { index: index as never, greptime: null, cache });

		const older = substrate.briefDetailed(request);
		const sameGeneration = substrate.briefDetailed(request);
		for (let turn = 0; turn < 8; turn += 1) await settle();
		// Two identical callers, one source read: the second joined the first.
		expect(calls).toBe(1);

		// A write moves the generation. The next caller reads the new one, so it has a different key and loads again.
		await cache.bump(MEMORY_GENERATION_KEY);
		const newer = await substrate.briefDetailed(request);
		expect(calls).toBe(2);
		expect(newer.text).toContain("blocked");

		first.resolve(graphView("active"));
		const [a, b] = await Promise.all([older, sameGeneration]);
		expect(a.text).toContain("active");
		expect(b.text).toBe(a.text);
		expect(calls).toBe(2);
	});
});

describe("read-your-writes with SUBSTRATE_CACHE_SWR off and shadow (uplift-4 S4)", () => {
	for (const mode of ["off", "shadow"] as const) {
		test(`${mode}: a brief after a write and a generation bump shows the write, never the last-good`, async () => {
			const { substrate, cache, state } = rigOf(mode);
			const before = await substrate.briefDetailed(request);
			expect(before.text).toContain("active");

			state.status = "blocked";
			await cache.bump(MEMORY_GENERATION_KEY);
			const after = await substrate.briefDetailed(request);
			expect(after.text).toContain("blocked");
			expect(after.text).not.toContain("active");
			expect(after.ageS).toBeUndefined();
			expect(after.state).toBe("complete");
			// Shadow saw that enforce could have served stale; it served live regardless.
			// The shadow probe is off the answer path; let it settle before reading its count.
			await settle();
			expect(cache.health().wouldServeStale).toBe(mode === "shadow" ? 1 : 0);
			expect(cache.health().stale).toBe(0);
		});
	}
});

describe("enforce advertises a stale brief (uplift-4 S4)", () => {
	const running: Observability[] = [];
	const servers: Array<{ close(): void }> = [];
	afterAll(() => {
		for (const observability of running) observability.stop();
		for (const server of servers) server.close();
	});

	test("briefDetailed returns ageS, POST /brief sets x-substrate-brief-age, and the 304 path carries it", async () => {
		const { substrate, cache, state, config } = rigOf("enforce", 7_000);
		const fresh = await substrate.briefDetailed(request);
		expect(fresh.ageS).toBeUndefined();

		// The write lands, then the sources fail: only the last-good can answer, and no refresh can store a degraded brief.
		await cache.bump(MEMORY_GENERATION_KEY);
		state.status = "blocked";
		state.down = true;
		const stale = await substrate.briefDetailed(request);
		expect(stale.state).toBe("complete");
		expect(stale.ageS).toBe(7);
		expect(stale.text).toBe(fresh.text);
		expect(stale.etag).toBe(fresh.etag);

		const observability = createObservability(config, {});
		await observability.start();
		running.push(observability);
		const server = createHttpServer(substrate, config, observability);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		servers.push(server);
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const body = JSON.stringify(request);

		const ok = await fetch(`${base}/brief`, { method: "POST", headers: JSON_HEADERS, body });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("x-substrate-brief")).toBe("complete");
		expect(ok.headers.get("x-substrate-brief-age")).toBe("7");
		expect(await ok.text()).toBe(fresh.text);

		const unchanged = await fetch(`${base}/brief`, { method: "POST", body, headers: { ...JSON_HEADERS, "if-none-match": fresh.etag } });
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get("x-substrate-brief-age")).toBe("7");
	});

	test("a fresh brief has no age header", async () => {
		const { substrate, config } = rigOf("enforce");
		const observability = createObservability(config, {});
		await observability.start();
		running.push(observability);
		const server = createHttpServer(substrate, config, observability);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		servers.push(server);
		const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/brief`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request) });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-substrate-brief-age")).toBeNull();
	});
});

describe("the snapshot records its own deadline (uplift-4 S4)", () => {
	const stored = (redis: MapRedis) => JSON.parse(redis.values.get(snapshotKey("brief-snapshot", "cursor", SNAPSHOT_ARGS)) ?? "null") as { v: { text: string; at: string; sections?: unknown; until?: number | null } } | null;

	test("the snapshot write stores until from the lease note, and null when no lease is named", async () => {
		const withLease = rigOf("shadow");
		const lease = new Date(Date.now() + 60_000).toISOString();
		withLease.state.lease = lease;
		await withLease.substrate.briefDetailed(request);
		expect(stored(withLease.redis)?.v.until).toBe(Date.parse(lease));

		const noLease = rigOf("shadow");
		await noLease.substrate.briefDetailed(request);
		expect(stored(noLease.redis)?.v.until).toBeNull();
	});

	test("enforce does not serve a last-good that predates the recorded deadline, whatever its age", async () => {
		const { substrate, redis, state } = rigOf("enforce");
		// An old-release snapshot: `{text, at}` with no `until`. Its lease or reverify time is unknown.
		const key = snapshotKey("brief-snapshot", "cursor", SNAPSHOT_ARGS);
		redis.values.set(key, JSON.stringify({ v: { text: "OLD RELEASE TEXT", at: new Date(Date.now() - 5_000).toISOString() } }));
		const answer = await substrate.briefDetailed(request);
		expect(answer.text).not.toContain("OLD RELEASE TEXT");
		expect(answer.text).toContain("active");
		expect(answer.ageS).toBeUndefined();
		expect(state.reads).toBe(1);

		// A deadline already past, and a junk deadline, are refused the same way.
		for (const until of [Date.now() - 1, "soon"]) {
			const rig = rigOf("enforce");
			rig.redis.values.set(key, JSON.stringify({ v: { text: "STALE TEXT", at: new Date(Date.now() - 5_000).toISOString(), until } }));
			const live = await rig.substrate.briefDetailed(request);
			expect(live.text).not.toContain("STALE TEXT");
			expect(live.ageS).toBeUndefined();
		}

		// Control: a snapshot with its sections and `until: null` (no deadline, recorded by this release) is served stale,
		// as the rendered text of those sections — never as the raw encoding.
		const known = [{ id: "heading", lines: ["KNOWN TEXT"], items: [{ text: "KNOWN TEXT" }] }];
		const control = rigOf("enforce");
		control.redis.values.set(key, JSON.stringify({ v: { text: "KNOWN TEXT", at: new Date(Date.now() - 5_000).toISOString(), sections: known, until: null } }));
		const served = await control.substrate.briefDetailed(request);
		expect(served.text).toBe("KNOWN TEXT");
		expect(served.ageS).toBe(5);

		// The same snapshot without readable sections (written before profiles, or damaged) is not a last-good:
		// it is neither served stale nor recomposed synchronously beyond the one live load.
		for (const sections of [undefined, "not sections", [{ id: "constructor", lines: [], items: [] }]]) {
			const rig = rigOf("enforce");
			rig.redis.values.set(key, JSON.stringify({ v: { text: "NO SECTIONS TEXT", at: new Date(Date.now() - 5_000).toISOString(), sections, until: null } }));
			const live = await rig.substrate.briefDetailed(request);
			expect(live.text).not.toContain("NO SECTIONS TEXT");
			expect(live.text).toContain("active");
			expect(live.ageS).toBeUndefined();
			expect(rig.state.reads).toBe(1);
		}
	});

	test("the background refresh rewrites the snapshot with text, sections, until and a new timestamp", async () => {
		const { substrate, cache, redis, state } = rigOf("enforce", 7_000);
		await substrate.briefDetailed(request);
		const before = stored(redis)!.v;
		state.status = "blocked";
		await cache.bump(MEMORY_GENERATION_KEY);
		const stale = await substrate.briefDetailed(request);
		expect(stale.ageS).toBe(7);
		expect(stale.text).toContain("active");
		for (let turn = 0; turn < 16; turn += 1) await settle();
		const after = stored(redis)!.v;
		expect(after.text).toContain("blocked");
		expect(after.text.startsWith("## Substrate brief")).toBe(true);
		expect(Array.isArray(after.sections)).toBe(true);
		expect(after.until).toBeNull();
		expect(after.at >= before.at).toBe(true);
		// The next caller is served the refreshed brief, fresh, and the stale advertisement is gone.
		const next = await substrate.briefDetailed(request);
		expect(next.text).toContain("blocked");
		expect(next.ageS).toBeUndefined();
	});
});

describe("an oversized background refresh (uplift-4 S4 x S5)", () => {
	const snapshot = (redis: MapRedis) => JSON.parse(redis.values.get(snapshotKey("brief-snapshot", "cursor", SNAPSHOT_ARGS)) ?? "null") as { v: { text: string; at: string } };

	test("is not stored: the stale brief's snapshot is kept", async () => {
		const { substrate, cache, redis, state } = rigOf("enforce", 7_000);
		await substrate.briefDetailed(request);
		const before = snapshot(redis).v;
		// The refresh composes a brief whose encoding is past the cache's decode limit.
		state.memory = [1, 2, 3, 4].map((n) => ({ id: `m${n}`, kind: "decision", text: `d${n} ${"x".repeat(300_000)}`, writer: "hermes", trust: "human-confirmed", version: 1, created: new Date().toISOString() }));
		await cache.bump(MEMORY_GENERATION_KEY);
		const stale = await substrate.briefDetailed(request);
		expect(stale.ageS).toBe(7);
		for (let turn = 0; turn < 16; turn += 1) await settle();
		const after = snapshot(redis).v;
		expect(after.text).toBe(before.text);
		expect(after.at).toBe(before.at);
	});
});

describe("a stale brief says so in the compact state line (uplift-4 S4 x S1)", () => {
	test("the age survives a gateway that drops x-substrate-brief-age; the full text is unchanged", async () => {
		const redis = new MapRedis();
		const config = loadConfig({ SUBSTRATE_BRIEF_PROFILE: "enforce" });
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => Date.now() + 7_000, swr: { mode: "enforce", windowS: 30 } });
		const state = { down: false };
		const index = {
			getGraph: async () => {
				if (state.down) throw new Error("postgres is down");
				return graphView("active", null);
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
		const substrate = new Substrate(config, { index: index as never, greptime: null, cache }, {});
		const fresh = await substrate.briefDetailed(request, "compact", "cursor");
		expect(fresh.text.split("\n")[0]).toBe("[brief: complete]");

		await cache.bump(MEMORY_GENERATION_KEY);
		state.down = true;
		const stale = await substrate.briefDetailed(request, "compact", "cursor");
		expect(stale.ageS).toBe(7);
		expect(stale.text.split("\n")[0]).toBe("[brief: complete; age 7s]");
		const full = await substrate.briefDetailed(request, "full", "cursor");
		expect(full.text).not.toContain("[brief:");
	});
});
