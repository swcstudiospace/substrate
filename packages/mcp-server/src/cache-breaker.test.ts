/**
 * Phase 75: the cache plane's breaker is open. Brief and recall answer from the authoritative store; a generation key whose
 * bump the breaker refused stays on the source after the breaker closes, until a bump lands; admission follows each class's
 * declared policy. The breaker is the production one: `PlaneRegistry` gates every command through `callPlane`, and a refused
 * command is refused before a socket or a fake store is touched, so the breaker sees no outcome for it.
 */
import { describe, expect, test } from "bun:test";
import { PlaneRegistry, callPlane, type CircuitBreaker, type PlaneGate } from "@substrate/observability";
import { Admission } from "./admission.ts";
import { MEMORY_GENERATION_KEY, ReadThroughCache, bunRedis, type CacheRedis } from "./cache.ts";
import { loadAdmissionSettings, loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

/** A closed port: a command that reached the socket would fail here, and the breaker would count it. */
const UNREACHABLE = "redis://127.0.0.1:1";

/** A real client behind an open breaker. The gate refuses each command before the client opens a socket. */
function openCache(): { cache: ReadThroughCache; breaker: CircuitBreaker } {
	const registry = new PlaneRegistry({ enabled: true, failureThreshold: 1, openMs: 60_000 });
	const gate = registry.gate("cache");
	const breaker = defined(gate.breaker, "cache breaker");
	breaker.onFailure("cache plane down");
	return { cache: new ReadThroughCache({ redis: bunRedis(UNREACHABLE, { gate }), enabled: true, log: () => {} }), breaker };
}

/** An in-memory store behind a plane gate: each command goes through `callPlane` as `bunRedis` does, so an open breaker refuses it before the store is touched. */
class GatedMapRedis implements CacheRedis {
	readonly values = new Map<string, string>();

	constructor(private readonly gate: PlaneGate) {}

	get(key: string): Promise<string | null> {
		return callPlane(this.gate, "get", async () => this.values.get(key) ?? null);
	}

	set(key: string, value: string): Promise<void> {
		return callPlane(this.gate, "set", async () => {
			this.values.set(key, value);
		});
	}

	incr(key: string): Promise<number> {
		return callPlane(this.gate, "incr", async () => {
			const next = Number(this.values.get(key) ?? "0") + 1;
			this.values.set(key, String(next));
			return next;
		});
	}
}

/** Point the Hindsight env reads at a fake for one test; the returned function restores what it touched. */
function withHindsight(banks: string): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"] as const;
	const saved = names.map((name) => [name, process.env[name]] as const);
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = banks;
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

function graphView(status: string) {
	return { graph_id: "ut-1", notion_task_page: null, repo: "acme/app", branch: null, surface: "cursor", status, pr_url: null, created: null, updated: null, nodes: [], steps: [], edges: [] };
}

describe("the cache breaker is open (phase 75)", () => {
	test("brief is composed from the index on every call, and the cache never answers it", async () => {
		const { cache, breaker } = openCache();
		const state = { status: "active", reads: 0 };
		const index = {
			getGraph: async () => {
				state.reads += 1;
				return graphView(state.status);
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
			liveSessions: () => null,
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, cache });
		const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1" };

		expect((await substrate.briefDetailed(request)).text).toContain("active");
		state.status = "blocked";
		const after = await substrate.briefDetailed(request);
		expect(after.text).toContain("blocked");
		expect(after.text).not.toContain("active");
		expect(state.reads).toBe(2);
		expect(cache.health()).toMatchObject({ hits: 0, mode: "degraded" });
		// A refused command is not a plane outcome: the one failure is the setup's, and nothing else reached the plane.
		expect(breaker.snapshot().failures).toBe(1);
	});

	test("recall returns the same reply as a substrate with no cache at all", async () => {
		const restore = withHindsight("sub-hermes");
		try {
			const fake = new HindsightFake();
			fake.seed("sub-cursor", [{ id: "c1", text: "fence the lease", document_id: "mwd_c1", tags: ["cursor"], metadata: {}, score: 0.5 }]);
			fake.seed("sub-hermes", [{ id: "h1", text: "quote versions", document_id: "mwd_h1", tags: ["hermes"], metadata: {}, score: 0.9 }]);
			const plain = await new Substrate(loadConfig({}), { index: null, greptime: null, hindsightFetch: fake.fetch }).recallMemories({ query: "lease" }, "cursor");
			const { cache } = openCache();
			const answered = await new Substrate(loadConfig({}), { index: null, greptime: null, cache, hindsightFetch: fake.fetch }).recallMemories({ query: "lease" }, "cursor");

			expect(plain.degraded).toBe(false);
			expect(answered).toEqual(plain);
			expect(answered.results.length).toBe(2);
			expect(cache.health()).toMatchObject({ hits: 0 });
		} finally {
			restore();
		}
	});

	test("generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands", async () => {
		const registry = new PlaneRegistry({ enabled: true, failureThreshold: 1, openMs: 60_000 });
		const gate = registry.gate("cache");
		const breaker = defined(gate.breaker, "cache breaker");
		const redis = new GatedMapRedis(gate);
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		let value = "before";
		const ask = () => cache.getOrLoad({ klass: "memory-search", surface: "cursor", args: { query: "lease" }, generations: [MEMORY_GENERATION_KEY], load: async () => [value] });

		expect(await ask()).toEqual(["before"]);
		breaker.onFailure("cache plane down");
		value = "after";
		await cache.bump(MEMORY_GENERATION_KEY);
		expect(redis.values.has(MEMORY_GENERATION_KEY)).toBe(false);

		// The plane answers again. The pre-write answer is still stored under generation 0, and must not be served.
		breaker.onSuccess();
		expect(await ask()).toEqual(["after"]);
		expect(cache.health()).toMatchObject({ hits: 0, mode: "degraded" });

		await cache.bump(MEMORY_GENERATION_KEY);
		value = "landed";
		expect(await ask()).toEqual(["landed"]);
		value = "stale";
		expect(await ask()).toEqual(["landed"]);
		expect(cache.health()).toMatchObject({ hits: 1, mode: "on" });
	});

	test("admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane", async () => {
		const { cache, breaker } = openCache();
		const admission = new Admission(loadAdmissionSettings({ SUBSTRATE_BUDGETS: "enforce", SUBSTRATE_BUDGET_WRITE_BREAKER: "fail-closed" }), {
			script: (script, keys, args) => cache.script(script, keys, args),
		});

		expect(await admission.admit({ surface: "cursor", klass: "write", cost: 1 })).toMatchObject({ decision: "refused", tokensLeft: null });
		expect(await admission.admit({ surface: "cursor", klass: "read", cost: 1 })).toMatchObject({ decision: "bypass" });
		expect(breaker.snapshot().failures).toBe(1);
	});
});
