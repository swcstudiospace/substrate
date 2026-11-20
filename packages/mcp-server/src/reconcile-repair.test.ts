import { describe, expect, mock, test } from "bun:test";
import type { ReadThroughCache } from "./cache.ts";
import { executePlan, findingsDigest, planFromReport } from "./reconcile-repair.ts";
import type { IndexReader, LedgerReader } from "./reconcile-read.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ORPHAN_KEY = "substrate:v1:gen:graph:g-gone";
const MEMORY_COUNTER_KEY = "substrate:v1:gen:memory";
const FORGET_MARK = "substrate:v1:gen:forgotten";

/** Every key the orphan fixture holds: answers, snapshots, counters, the forget mark, budget and embedding keys, and one unrelated key. */
const FIXTURE_KEYS = [
	ORPHAN_KEY,
	MEMORY_COUNTER_KEY,
	FORGET_MARK,
	"substrate:v1:brief:a1",
	"substrate:v1:brief-snapshot:b2",
	"substrate:v1:budget:surface:class",
	"substrate:v1:emb:digest1",
	"other:unrelated",
];

interface FakeCache {
	cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys">;
	keys: Set<string>;
	calls: string[];
	/** Every key unlinked, in the order it was removed. */
	removed: string[];
}

/** A cache over fixed keys. SCAN matches a trailing `*` as a prefix and honours the cap. Every call is recorded. */
function fakeCache(initial: readonly string[]): FakeCache {
	const keys = new Set(initial);
	const calls: string[] = [];
	const removed: string[] = [];
	const cache = {
		scanKeys: async (match: string, limit: number) => {
			calls.push(`scan ${match} ${limit}`);
			const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
			const found = [...keys].filter((key) => key.startsWith(prefix)).sort();
			return { keys: found.slice(0, limit), truncated: found.length > limit };
		},
		unlinkKeys: async (list: readonly string[]) => {
			calls.push(`unlink ${list.length}`);
			let count = 0;
			for (const key of list) {
				if (keys.delete(key)) {
					removed.push(key);
					count += 1;
				}
			}
			return count;
		},
	};
	return { cache, keys, calls, removed };
}

/** A cache holding one generation orphan (its graph is absent from the index) and the other fixture keys. */
function orphanCache(): FakeCache {
	return fakeCache(FIXTURE_KEYS);
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
		const result = await executePlan(plan, deps, { execute: false, serverStopped: false });
		expect(result).toEqual({ executed: false, reason: expect.any(String), listed: 1, repaired: 0, truncated: false, refused: false });
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
	});

	test("a digest mismatch refuses and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		cache.keys.add("substrate:v1:gen:graph:g-new");
		const result = await executePlan(plan, deps, { execute: true, serverStopped: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(result.reason).toMatch(/digest mismatch/);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.calls).not.toContain("scan substrate:v1:* 1000000");
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length + 1);
	});

	test("an orphan that is gone refuses and writes nothing", async () => {
		const cache = orphanCache();
		const plan = planFromReport(await runReport(fakeDeps(cache, [])), NOW);
		// The graph now exists in graph_index, so the orphan is gone.
		const result = await executePlan(plan, fakeDeps(cache, ["g-gone"]), { execute: true, serverStopped: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
	});

	test("a plan with no generation orphans left to repair refuses", async () => {
		const cache = fakeCache(["other:unrelated"]);
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true, serverStopped: true });
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

	test("execute removes answers, then counters, then the forget mark, and only those", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true, serverStopped: true });
		expect(result).toEqual({ executed: true, reason: expect.any(String), listed: 1, repaired: 5, truncated: false, refused: false });
		expect(cache.calls).toContain("scan substrate:v1:* 1000000");
		// Three passes, in order: two answers, two counters (the orphan and the memory counter), then the mark.
		expect(cache.calls.filter((call) => call.startsWith("unlink"))).toEqual(["unlink 2", "unlink 2", "unlink 1"]);
		expect(cache.removed).toEqual([
			"substrate:v1:brief-snapshot:b2",
			"substrate:v1:brief:a1",
			ORPHAN_KEY,
			MEMORY_COUNTER_KEY,
			FORGET_MARK,
		]);
		expect([...cache.keys].sort()).toEqual(["other:unrelated", "substrate:v1:budget:surface:class", "substrate:v1:emb:digest1"]);
	});

	test("a second execute after the first finds nothing and is a no-op", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		await executePlan(plan, deps, { execute: true, serverStopped: true });
		const second = await executePlan(plan, deps, { execute: true, serverStopped: true });
		expect(second.refused).toBe(true);
		expect(second.executed).toBe(false);
		expect(second.repaired).toBe(0);
		expect(cache.calls.filter((call) => call.startsWith("unlink"))).toHaveLength(3);
	});

	test("a scan that cannot be completed removes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const unlinkKeys = mock(async (_keys: readonly string[], _onBatch?: (removed: number) => void) => 0);
		const incomplete = {
			...deps,
			cache: {
				// Only the flush's own scan is incomplete: the report scans narrower prefixes and must still read the cache.
				scanKeys: async (match: string, limit: number) =>
					match === "substrate:v1:*" ? { keys: [], truncated: true } : cache.cache.scanKeys(match, limit),
				unlinkKeys,
			},
		};
		const result = await executePlan(plan, incomplete, { execute: true, serverStopped: true });
		expect(result).toMatchObject({ executed: false, refused: true, repaired: 0, truncated: true });
		expect(result.reason).toMatch(/could not be read completely/);
		expect(unlinkKeys).not.toHaveBeenCalled();
		for (const key of FIXTURE_KEYS) expect(cache.keys.has(key)).toBe(true);
	});

	test("a failure in the answer pass leaves every counter and the mark in place", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const unlinkKeys = mock(async (_keys: readonly string[], _onBatch?: (removed: number) => void): Promise<number> => {
			throw new Error("unlink failed");
		});
		const failing = { ...deps, cache: { scanKeys: cache.cache.scanKeys, unlinkKeys } };
		const result = await executePlan(plan, failing, { execute: true, serverStopped: true });
		expect(result).toMatchObject({ executed: false, refused: false, repaired: 0 });
		expect(result.error).toEqual(expect.any(String));
		expect(result.error?.length).toBeGreaterThan(0);
		expect(unlinkKeys).toHaveBeenCalledTimes(1);
		expect(unlinkKeys.mock.calls[0]?.[0]).toEqual(["substrate:v1:brief-snapshot:b2", "substrate:v1:brief:a1"]);
		expect(cache.keys.has(ORPHAN_KEY)).toBe(true);
		expect(cache.keys.has(MEMORY_COUNTER_KEY)).toBe(true);
		expect(cache.keys.has(FORGET_MARK)).toBe(true);
	});

	test("a failure in the counter pass keeps the forget mark in place", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		let pass = 0;
		const unlinkKeys = mock(async (keys: readonly string[], onBatch?: (removed: number) => void): Promise<number> => {
			pass += 1;
			if (pass === 2) throw new Error("unlink failed");
			return cache.cache.unlinkKeys(keys, onBatch);
		});
		const failing = { ...deps, cache: { scanKeys: cache.cache.scanKeys, unlinkKeys } };
		const result = await executePlan(plan, failing, { execute: true, serverStopped: true });
		expect(result).toMatchObject({ executed: false, refused: false });
		expect(result.error).toEqual(expect.any(String));
		expect(result.error?.length).toBeGreaterThan(0);
		expect(unlinkKeys).toHaveBeenCalledTimes(2);
		for (const key of ["substrate:v1:brief:a1", "substrate:v1:brief-snapshot:b2"]) expect(cache.keys.has(key)).toBe(false);
		expect(cache.keys.has(ORPHAN_KEY)).toBe(true);
		expect(cache.keys.has(MEMORY_COUNTER_KEY)).toBe(true);
		expect(cache.keys.has(FORGET_MARK)).toBe(true);
	});

	test("a failure in the mark pass leaves the answers and counters removed and the mark in place", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const unlinkKeys = mock(async (keys: readonly string[], onBatch?: (removed: number) => void): Promise<number> => {
			if (keys.includes(FORGET_MARK)) throw new Error("unlink failed");
			return cache.cache.unlinkKeys(keys, onBatch);
		});
		const failing = { ...deps, cache: { scanKeys: cache.cache.scanKeys, unlinkKeys } };
		const result = await executePlan(plan, failing, { execute: true, serverStopped: true });
		expect(result).toMatchObject({ executed: false, refused: false, repaired: 4 });
		expect(result.error).toEqual(expect.any(String));
		expect(result.error?.length).toBeGreaterThan(0);
		expect(unlinkKeys).toHaveBeenCalledTimes(3);
		for (const key of ["substrate:v1:brief:a1", "substrate:v1:brief-snapshot:b2", ORPHAN_KEY, MEMORY_COUNTER_KEY]) {
			expect(cache.keys.has(key)).toBe(false);
		}
		expect(cache.keys.has(FORGET_MARK)).toBe(true);
	});

	test("execute without the server stopped refuses and removes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const result = await executePlan(plan, deps, { execute: true, serverStopped: false });
		expect(result).toEqual({
			executed: false,
			reason: "refused: a flush needs the server stopped (--server-stopped); a live server can write a snapshot between the passes",
			listed: 1,
			repaired: 0,
			truncated: false,
			refused: true,
		});
		expect(cache.calls).not.toContain("scan substrate:v1:* 1000000");
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
	});

	test("a plan item that names another match is refused and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const widened = { ...plan, items: plan.items.map((item) => ({ ...item, match: "substrate:v1:brief:*" })) };
		const result = await executePlan(widened, deps, { execute: true, serverStopped: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
	});

	test("a plan item with another action is refused and writes nothing", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const other = { ...plan, items: plan.items.map((item) => ({ ...item, action: "prune-ledger" as unknown as "flush-derived-cache" })) };
		const result = await executePlan(other, deps, { execute: true, serverStopped: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
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
		const result = await executePlan(ghost, deps, { execute: true, serverStopped: true });
		expect(result.refused).toBe(true);
		expect(result.executed).toBe(false);
		expect(cache.calls.some((call) => call.startsWith("unlink"))).toBe(false);
		expect(cache.keys.size).toBe(FIXTURE_KEYS.length);
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
		const result = await executePlan(plan, failing, { execute: true, serverStopped: true });
		expect(result.executed).toBe(false);
		expect(result.refused).toBe(false);
		expect(result.repaired).toBe(500);
		expect(result.error).toBe("unlink failed");
	});

	test("a scan that fails removes nothing and reports the failure", async () => {
		const cache = orphanCache();
		const deps = fakeDeps(cache, []);
		const plan = planFromReport(await runReport(deps), NOW);
		const unlinkKeys = mock(async (_keys: readonly string[], _onBatch?: (removed: number) => void) => 0);
		const failing = {
			...deps,
			cache: {
				// Only the flush's own scan fails: the report scans narrower prefixes and must still read the cache.
				scanKeys: async (match: string, limit: number) => {
					if (match === "substrate:v1:*") throw new Error("scan failed at postgres://user:hunter2@host/db");
					return cache.cache.scanKeys(match, limit);
				},
				unlinkKeys,
			},
		};
		const result = await executePlan(plan, failing, { execute: true, serverStopped: true });
		expect(result.executed).toBe(false);
		expect(result.refused).toBe(false);
		expect(result.repaired).toBe(0);
		expect(result.error).toEqual(expect.any(String));
		expect(result.error?.length).toBeGreaterThan(0);
		expect(result.error).not.toContain("hunter2");
		expect(unlinkKeys).not.toHaveBeenCalled();
	});
});
