/**
 * Unit tests for the two-VM rehearsal proof harness itself: the fake pool
 * isolates graphs, and the full rehearsal passes end to end with fakes.
 */
import { describe, expect, test } from "bun:test";
import { fakeVmPool, runSmoke, type FakeActor } from "./host-smoke.ts";

describe("fakeVmPool", () => {
	test("one actor per graph id; sessions isolated", async () => {
		const pool = new Map<string, FakeActor>();
		const vmFor = fakeVmPool(pool);
		const a = vmFor("ut-test-aaa11111");
		vmFor("ut-test-bbb22222");
		vmFor("ut-test-aaa11111");
		expect(pool.size).toBe(2);
		expect(pool.get("ut-test-aaa11111")?.graphId).toBe("ut-test-aaa11111");
		await a.filesystem.writeFile("/home/agentos/x", "a");
		const b = vmFor("ut-test-bbb22222");
		expect(await b.filesystem.readFile("/home/agentos/x")).toEqual(Buffer.from(""));
		expect(await a.filesystem.readFile("/home/agentos/x")).toEqual(Buffer.from("a"));
	});
});

describe("runSmoke", () => {
	test("every rehearsal check passes with fakes", async () => {
		const results = await runSmoke();
		expect(results.length).toBeGreaterThan(0);
		const failed = results.filter((result) => !result.ok);
		expect(failed).toEqual([]);
		const names = results.map((result) => result.name);
		for (const needle of ["two actors", "tokens distinct", "disk gate refuses", "api loopback", "worked single release", "worked sync fields"]) {
			expect(names.some((name) => name.includes(needle))).toBe(true);
		}
	});
});
