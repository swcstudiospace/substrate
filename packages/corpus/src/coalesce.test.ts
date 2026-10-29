import { describe, expect, test } from "bun:test";
import { Coalescer, FULL_SWEEP } from "./coalesce.ts";

const options = { debounceMs: 2000, maxWaitMs: 30_000 };

describe("Coalescer", () => {
	test("a burst of signals costs one sync, due once the repository has been quiet for the debounce", () => {
		const c = new Coalescer(options);
		for (let at = 0; at < 10; at++) c.signal("Acme/A", "watch", at * 100);
		expect(c.due(900 + 1999)).toEqual([]);
		expect(c.nextDueAtMs()).toBe(900 + 2000);

		const due = c.due(900 + 2000);

		expect(due).toEqual([{ repo: "Acme/A", trigger: "watch", firstAtMs: 0 }]);
		expect(c.due(900 + 2000)).toEqual([]);
		c.finished("Acme/A");
		expect(c.size).toBe(0);
	});

	test("a steady stream still syncs once the maximum wait has passed", () => {
		const c = new Coalescer(options);
		for (let at = 0; at <= 30_000; at += 1000) c.signal("Acme/A", "watch", at);
		expect(c.due(29_999)).toEqual([]);
		expect(c.due(30_000)).toHaveLength(1);
	});

	test("repositories are independent, and the oldest burst is handed out first", () => {
		const c = new Coalescer(options);
		c.signal("Acme/B", "hook", 100);
		c.signal("Acme/A", "watch", 0);
		expect(c.due(2100).map((item) => item.repo)).toEqual(["Acme/A", "Acme/B"]);
	});

	test("a signal during a running sync makes exactly one more sync, however many arrive", () => {
		const c = new Coalescer(options);
		c.signal("Acme/A", "watch", 0);
		expect(c.due(2000)).toHaveLength(1);
		for (const at of [2100, 2200, 2300]) c.signal("Acme/A", "hook", at);
		// Not due while it runs, even long after the debounce.
		expect(c.due(10_000)).toEqual([]);
		expect(c.nextDueAtMs()).toBeNull();

		c.finished("Acme/A");

		expect(c.nextDueAtMs()).toBe(2300 + 2000);
		expect(c.due(4300)).toEqual([{ repo: "Acme/A", trigger: "hook", firstAtMs: 2100 }]);
		c.finished("Acme/A");
		expect(c.due(100_000)).toEqual([]);
		expect(c.size).toBe(0);
	});

	test("the first signal of a burst names its trigger", () => {
		const c = new Coalescer(options);
		c.signal("Acme/A", "hook", 0);
		c.signal("Acme/A", "watch", 50);
		expect(c.due(5000)[0]?.trigger).toBe("hook");
	});

	test("the maximum wait is never below the debounce", () => {
		const c = new Coalescer({ debounceMs: 5000, maxWaitMs: 1000 });
		c.signal("Acme/A", "watch", 0);
		c.signal("Acme/A", "watch", 4000);
		expect(c.due(4999)).toEqual([]);
		expect(c.due(5000)).toHaveLength(1);
	});

	test("tracking is bounded: repositories beyond the cap fold into one full sweep, which covers the idle ones", () => {
		const c = new Coalescer({ ...options, maxTracked: 3 });
		for (const repo of ["r1", "r2", "r3", "r4", "r5", "r6"]) c.signal(repo, "watch", 0);
		expect(c.size).toBe(4);

		const due = c.due(2000);

		// One sweep stands for every repository, so the three tracked bursts are dropped with it.
		expect(due).toEqual([{ repo: FULL_SWEEP, trigger: "watch", firstAtMs: 0 }]);
		expect(c.size).toBe(1);
		expect(c.nextDueAtMs()).toBeNull();
	});

	test("a due full sweep drops the idle bursts it covers but keeps a signal that arrived after it", () => {
		const c = new Coalescer(options);
		c.signal(FULL_SWEEP, "sweep", 0);
		c.signal("Acme/A", "watch", 1000);
		c.signal("Acme/B", "watch", 5000);

		const due = c.due(3000);

		expect(due).toEqual([{ repo: FULL_SWEEP, trigger: "sweep", firstAtMs: 0 }]);
		expect(c.nextDueAtMs()).toBe(5000 + 2000);
		expect(c.due(7000).map((item) => item.repo)).toEqual(["Acme/B"]);
	});
});
