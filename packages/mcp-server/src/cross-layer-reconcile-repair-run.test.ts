/**
 * The repair runner's pure gates (`cross-layer-reconcile-repair-run.ts`): the argument grammar that decides what runs before any
 * store is opened, and `freshItemsWithinPlan`, the check that lets an apply proceed only when a fresh read holds nothing the stored
 * plan does not hold. Nothing here touches a store.
 */
import { describe, expect, test } from "bun:test";
import { FORGET_MARK_KEY } from "./cache.ts";
import { parseRepairArgs } from "./cross-layer-reconcile-repair-run.ts";
import { type CacheMarkItem, type RepairItem, freshItemsWithinPlan } from "./cross-layer-reconcile.ts";
import { forgetMarker } from "./memory-forget.ts";

const FORGET = "fg_0123456789abcdef0123456789";
const OTHER_FORGET = "fg_fedcba9876543210fedcba9876";
const ENTRY_A: RepairItem = { action: "index-mark", entryId: "mem_a", forgetId: FORGET, marker: forgetMarker(FORGET) };
const ENTRY_B: RepairItem = { action: "index-mark", entryId: "mem_b", forgetId: FORGET, marker: forgetMarker(FORGET) };
const CACHE: CacheMarkItem = { action: "cache-mark", key: FORGET_MARK_KEY, ttlS: 3600 };

describe("parseRepairArgs", () => {
	test("nothing, or --plan alone, is a plan run", () => {
		expect(parseRepairArgs([])).toEqual({ mode: "plan" });
		expect(parseRepairArgs(["--plan"])).toEqual({ mode: "plan" });
	});

	test("--apply PLAN_ID --confirm, in that order, is an apply of that plan", () => {
		expect(parseRepairArgs(["--apply", "plan-1", "--confirm"])).toEqual({ mode: "apply", planId: "plan-1" });
	});

	test("anything else is refused before a store is opened, with a reason", () => {
		const refused = [
			["plan-1"],
			["--bogus"],
			["--plan", "extra"],
			["--apply"],
			["--apply", "--confirm"],
			["--apply", "plan-1"],
			["--apply", "plan-1", "--force"],
			["--apply", "plan-1", "--confirm", "extra"],
		];
		for (const argv of refused) {
			const parsed = parseRepairArgs(argv);
			expect(parsed.mode, JSON.stringify(argv)).toBe("refused");
			if (parsed.mode === "refused") expect(parsed.problem.length, JSON.stringify(argv)).toBeGreaterThan(0);
		}
		const noConfirm = parseRepairArgs(["--apply", "plan-1"]);
		expect(noConfirm.mode === "refused" && noConfirm.problem).toContain("--confirm");
		const noPlanId = parseRepairArgs(["--apply", "--confirm"]);
		expect(noPlanId.mode === "refused" && noPlanId.problem).toContain("PLAN_ID");
	});
});

describe("freshItemsWithinPlan", () => {
	test("a fresh read that holds the whole plan proceeds", () => {
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B, CACHE], [ENTRY_A, ENTRY_B, CACHE])).toBe(true);
	});

	test("partial retry: the repairs an earlier apply already made are gone from the fresh read, and the rest still proceed", () => {
		// The earlier apply marked mem_a and invalidated the cache; what it did not reach is still a repair the plan holds.
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B, CACHE], [ENTRY_B])).toBe(true);
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B, CACHE], [ENTRY_B, CACHE])).toBe(true);
	});

	test("empty fresh: every repair was already made, so the retry proceeds to record the note an earlier apply did not store", () => {
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B, CACHE], [])).toBe(true);
	});

	test("altered item: a repair the plan holds with different content is not the plan and refuses", () => {
		// The same cache key with a longer lifetime than the plan recorded.
		expect(freshItemsWithinPlan([CACHE], [{ ...CACHE, ttlS: 7200 }])).toBe(false);
		// The same entry under a different forget: its marker and forget id no longer match the plan's.
		const reforgotten: RepairItem = { action: "index-mark", entryId: "mem_a", forgetId: OTHER_FORGET, marker: forgetMarker(OTHER_FORGET) };
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B], [reforgotten])).toBe(false);
	});

	test("new item: a repair the plan never held refuses, even alongside repairs it does hold", () => {
		const newEntry: RepairItem = { action: "index-mark", entryId: "mem_c", forgetId: FORGET, marker: forgetMarker(FORGET) };
		expect(freshItemsWithinPlan([ENTRY_A, ENTRY_B], [ENTRY_A, newEntry])).toBe(false);
		expect(freshItemsWithinPlan([ENTRY_A], [CACHE])).toBe(false);
	});
});
