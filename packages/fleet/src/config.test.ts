import { describe, expect, test } from "bun:test";
import { DEFAULT_IDLE_DAYS, DEFAULT_MIN_FREE_GB, idleDaysFromEnv, minFreeGbFromEnv, worktreeRootsFromEnv } from "./config.ts";

describe("worktreeRootsFromEnv", () => {
	test("is empty when unset: no location is assumed", () => {
		expect(worktreeRootsFromEnv({})).toEqual([]);
		expect(worktreeRootsFromEnv({ SUBSTRATE_WORKTREE_ROOTS: " : " })).toEqual([]);
	});

	test("keeps absolute entries in order, normalised and without duplicates, and drops relative ones", () => {
		expect(worktreeRootsFromEnv({ SUBSTRATE_WORKTREE_ROOTS: "/a/b/:rel/x:/c/../c:/a/b" })).toEqual(["/a/b", "/c"]);
	});
});

describe("numeric flags", () => {
	test("the floor and the idle threshold fall back to their defaults for anything that is not a positive number", () => {
		for (const raw of [undefined, "", "abc", "0", "-2", "NaN", "Infinity"]) {
			expect(minFreeGbFromEnv({ SUBSTRATE_WORKTREE_MIN_FREE_GB: raw })).toBe(DEFAULT_MIN_FREE_GB);
			expect(idleDaysFromEnv({ SUBSTRATE_WORKTREE_IDLE_DAYS: raw })).toBe(DEFAULT_IDLE_DAYS);
		}
		expect(DEFAULT_MIN_FREE_GB).toBe(5);
		expect(DEFAULT_IDLE_DAYS).toBe(14);
	});

	test("a positive number is used, fractions included", () => {
		expect(minFreeGbFromEnv({ SUBSTRATE_WORKTREE_MIN_FREE_GB: "20" })).toBe(20);
		expect(minFreeGbFromEnv({ SUBSTRATE_WORKTREE_MIN_FREE_GB: "0.5" })).toBe(0.5);
		expect(idleDaysFromEnv({ SUBSTRATE_WORKTREE_IDLE_DAYS: "30" })).toBe(30);
	});
});
