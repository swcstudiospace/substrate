import { describe, expect, test } from "bun:test";
import type { ReadThroughCache } from "./cache.ts";
import { executePlan, findingsDigest, planFromReport } from "./reconcile-repair.ts";
import type { IndexReader, LedgerReader } from "./reconcile-read.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ORPHAN_KEY = "substrate:v1:gen:graph:g-gone";

interface FakeCache {
	cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys">;
	keys: Set<string>;
	calls: string[];
}

/** A cache over fixed keys. SCAN matches a trailing `*` as a prefix and honours the cap. Every call is recorded. */
function fakeCache(initial: readonly string[]): FakeCache {
	const keys = new Set(initial);
	const calls: string[] = [];
	const cache = {
		scanKeys: async (match: string, limit: number) => {
			calls.push(`scan ${match} ${limit}`);
			const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
			const found = [...keys].filter((key) => key.startsWith(prefix)).sort();
			return { keys: found.slice(0, limit), truncated: found.length > limit };
		},
		unlinkKeys: async (list: readonly string[]) => {
			calls.push(`unlink ${list.length}`);
			let removed = 0;
			for (const key of list) if (keys.delete(key)) removed += 1;
			return removed;
		},
	};
	return { cache, keys, calls };
}

/** A cache holding one generation orphan (its graph is absent from the index), one unrelated key, and derived keys under the prefix. */
function orphanCache(): FakeCache {
	return fakeCache([
		ORPHAN_KEY,
		"substrate:v1:gen:memory",
		"substrate:v1:gen:forgotten",
		"substrate:v1:brief:a1",
		"substrate:v1:brief-snapshot:b2",
		"other:unrelated",
	]);
}

/** Deps over the fake cache. The ledger is empty; the index has the given `graph_index` ids and nothing else. */
function fakeDeps(
	cache: FakeCache,
	graphs: readonly string[],
): ReconcileDeps & { cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys"> } {
	const ledger: LedgerReader = { queryEvents: async () => [] };
	const index: IndexReader = {
		reconcileHolds: async () => [],
		reconcileHeldNodes: async () => ({ rows: [], truncated: false }),
		reconcileMemoryIds: async () => ({ rows: [], truncated: false }),
		reconcileGraphIds: async (cap) => ({ rows: graphs.slice(0, cap), truncated: graphs.length > cap }),
		reconcileMemoryRowsBefore: async () => 0,
	};
	return { ledger, index, cache: cache.cache, now: NOW, windowHours: 24, caps: DEFAULT_RECONCILE_CAPS };
}

describe("planFromReport", () => {
	test("lists one flush item naming the generation orphans", async () => {
		const deps = fakeDeps(orphanCache(), []);
		const plan = planFromReport(await runReport(deps), NOW);
		expect(plan.schema).toBe("substrate.reconcile.plan.v1");
		expect(plan.items).toHaveLength(1);
		expect(plan.items[0]?.match).toBe("substrate:v1:*");
		expect(plan.items[0]?.orphans).toEqual(["substrate:v1:gen:graph:g-gone"]);
	});

	test("a clean report lists no items", async () => {
		const deps = fakeDeps(fakeCache(["other:unrelated"]), []);
		const plan = planFromReport(await runReport(deps), NOW);
		expect(plan.items).toEqual([]);
	});
});

describe("findingsDigest", () => {
	test("does not depend on the order of the findings", () => {
		const a = { comparison: "generation" as const, key: "gen:graph:a", detail: "x" };
		const b = { comparison: "lease" as const, key: "g/n", detail: "y" };
		expect(findingsDigest([a, b])).toBe(findingsDigest([b, a]));
	});
});

describe("executePlan", () => {
	test("a dry run writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: false });
		expect(result).toEqual({ executed: false, reason: expect.any(String), listed: 1, repaired: 0, truncated: false, refused: false });
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(6);
	});

	test("a digest mismatch refuses and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		cache.keys.add("substrate:v1:gen:graph:g-new");
		const result = await executePlan(plan, deps, { execute: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(result.reason).toMatch(/digest mismatch/);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.calls).not.toContain("scan substrate:v1:* 10000");
		expect(cache.keys.size).toBe(7);
	});

	test("an orphan that is gone refuses and writes nothing", async () => {
		const cache = orphanCache();
		const plan = planFromReport(await runReport(fakeDeps(cache, [])), NOW);
		// The graph now exists in graph_index, so the orphan is gone.
		const result = await executePlan(plan, fakeDeps(cache, ["g-gone"]), { execute: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(6);
	});

	test("a plan with no generation orphans left to repair refuses", async () => {
		const cache = fakeCache(["other:unrelated"]);
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true });
		expect(result).toEqual({
			executed: false,
			reason: "refused: no generation orphans remain, so there is nothing to repair",
			listed: 0,
			repaired: 0,
			truncated: false,
			refused: true,
		});
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
	});

	test("execute removes every key under the prefix and only those", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true });
		expect(result).toEqual({ executed: true, reason: expect.any(String), listed: 1, repaired: 5, truncated: false, refused: false });
		expect(cache.calls).toContain("scan substrate:v1:* 10000");
		expect([...cache.keys]).toEqual(["other:unrelated"]);
	});

	test("a second execute after the first finds nothing and is a no-op", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		await executePlan(plan, deps, { execute: true });
		const second = await executePlan(plan, deps, { execute: true });
		expect(second.refused).toBe(true);
		expect(second.executed).toBe(false);
		expect(second.repaired).toBe(0);
		expect(cache.calls.filter((call) => call.startsWith("unlink"))).toHaveLength(1);
	});

	test("a capped scan reports truncated and says the flush is partial", async () => {
		const brief = Array.from({ length: 10_001 }, (_, index) => `substrate:v1:brief:${index}`);
		const cache = fakeCache([ORPHAN_KEY, ...brief]);
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true });
		expect(result.truncated).toBe(true);
		expect(result.executed).toBe(true);
		expect(result.repaired).toBe(10_000);
		expect(result.reason).toMatch(/partial flush/);
		expect(cache.keys.size).toBe(2);
	});

	test("a plan item that names another match is refused and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const widened = { ...plan, items: plan.items.map((item) => ({ ...item, match: "substrate:v1:brief:*" })) };
		const result = await executePlan(widened, deps, { execute: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(6);
	});

	test("a plan item with another action is refused and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const other = { ...plan, items: plan.items.map((item) => ({ ...item, action: "prune-ledger" as unknown as "flush-derived-cache" })) };
		const result = await executePlan(other, deps, { execute: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(6);
	});

	test("a plan item naming an orphan the fresh report does not list is refused and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const ghost = {
			...plan,
			items: [
				...plan.items,
				{ action: "flush-derived-cache" as const, match: "substrate:v1:*", reason: "ghost orphan", orphans: ["substrate:v1:gen:graph:g-ghost"] },
			],
		};
		const result = await executePlan(ghost, deps, { execute: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(6);
	});

	test("a flush that fails after one batch reports the keys that batch removed", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const failing = {
			...deps,
			cache: {
				scanKeys: cache.cache.scanKeys,
				unlinkKeys: async (_keys: readonly string[], onBatch?: (removed: number) => void) => {
					onBatch?.(500);
					throw new Error("unlink failed");
				},
			},
		};
		const result = await executePlan(plan, failing, { execute: true });
		expect(result.executed).toBe(false);
		expect(result.refused).toBe(false);
		expect(result.repaired).toBe(500);
		expect(result.error).toBe("unlink failed");
	});
});
