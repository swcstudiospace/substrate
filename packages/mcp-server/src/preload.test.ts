import { describe, expect, test } from "bun:test";
import { ConfigError, loadCachePreloadSettings, type CachePreloadSettings } from "./config.ts";
import { PRELOAD_REPO_CAP, PRELOAD_WINDOW_MS, RepoAccess, startPreloader, type PreloadTimer, type PreloadTimers } from "./preload.ts";
import type { Surface } from "./types.ts";

const HOUR = PRELOAD_WINDOW_MS;
const INTERVAL_MS = 300_000;
const ON: CachePreloadSettings = { enabled: true, top: 2, intervalS: 300 };

/** Record `times` requests for `repo`, one per millisecond from `at`. */
function recordMany(access: RepoAccess, repo: string, times: number, at: number, surface: Surface = "cursor"): void {
	for (let i = 0; i < times; i += 1) access.record(repo, at + i, surface);
}

/** The repo names of a `topRepos` result, in its order. */
function repoNames(entries: Array<{ repo: string }>): string[] {
	return entries.map((entry) => entry.repo);
}

class FakeTimer implements PreloadTimer {
	unrefs = 0;
	clears = 0;
	constructor(
		readonly handler: () => Promise<void>,
		readonly ms: number,
	) {}
	unref(): void {
		this.unrefs += 1;
	}
	clear(): void {
		this.clears += 1;
	}
}

/** Timers that never fire on their own: a test runs the interval body with `fire()`. */
class FakeTimers implements PreloadTimers {
	readonly timers: FakeTimer[] = [];
	setInterval(handler: () => Promise<void>, ms: number): FakeTimer {
		const timer = new FakeTimer(handler, ms);
		this.timers.push(timer);
		return timer;
	}
	live(): FakeTimer[] {
		return this.timers.filter((timer) => timer.clears === 0);
	}
	/** Run the newest live timer's interval body once, and wait for it. */
	async fire(): Promise<void> {
		const timer = this.live().at(-1);
		if (timer === undefined) throw new Error("no live timer to fire");
		await timer.handler();
	}
}

describe("RepoAccess", () => {
	test("top-K is ordered by request count inside the hour", () => {
		const access = new RepoAccess();
		recordMany(access, "a", 3, 1);
		recordMany(access, "b", 2, 4);
		access.record("c", 6, "cursor");
		access.record("d", 7, "cursor");
		expect(repoNames(access.topRepos(2, 10))).toEqual(["a", "b"]);
		// c and d tie on one request; the more recently requested one ranks first.
		expect(repoNames(access.topRepos(3, 10))).toEqual(["a", "b", "d"]);
		expect(access.topRepos(0, 10)).toEqual([]);
	});

	test("requests older than an hour drop out, and so does the repo once none is left", () => {
		const access = new RepoAccess();
		access.record("stale", 0, "cursor");
		access.record("recent", HOUR - 1, "cursor");
		expect(repoNames(access.topRepos(5, HOUR - 1))).toEqual(["recent", "stale"]);
		// At exactly one hour the stale request is no longer inside the window.
		expect(repoNames(access.topRepos(5, HOUR))).toEqual(["recent"]);
		expect(access.size()).toBe(1);
	});

	test("the cap evicts the least recently seen repo, not the least requested", () => {
		const access = new RepoAccess();
		for (let i = 0; i < PRELOAD_REPO_CAP; i += 1) access.record(`r${i}`, i + 1, "cursor");
		// r0 is seen again, so r1 becomes the least recently seen.
		access.record("r0", 1_000, "cursor");
		access.record("fresh", 1_001, "cursor");
		expect(access.size()).toBe(PRELOAD_REPO_CAP);
		const kept = repoNames(access.topRepos(PRELOAD_REPO_CAP + 1, 1_001));
		expect(kept).toContain("r0");
		expect(kept).toContain("fresh");
		expect(kept).not.toContain("r1");
		expect(kept.length).toBe(PRELOAD_REPO_CAP);
	});

	test("topRepos reports the surface last named for each repo", () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		access.record("a", 1, "hermes");
		access.record("b", 2, "claude-code");
		expect(access.topRepos(2, 3)).toEqual([
			{ repo: "a", surface: "hermes" },
			{ repo: "b", surface: "claude-code" },
		]);
	});
});

describe("startPreloader", () => {
	test("switch off starts no timer and never calls compose", () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		const timers = new FakeTimers();
		const calls: string[] = [];
		const preloader = startPreloader({
			settings: { enabled: false, top: 3, intervalS: 300 },
			access,
			compose: async (repo) => {
				calls.push(repo);
			},
			now: () => 0,
			intervalMs: INTERVAL_MS,
			timers,
		});
		expect(timers.timers.length).toBe(0);
		expect(calls).toEqual([]);
		expect(preloader.failures()).toBe(0);
		preloader.stop();
	});

	test("a tick composes exactly the top K repos, most requested first", async () => {
		const access = new RepoAccess();
		recordMany(access, "a", 3, 0);
		recordMany(access, "b", 2, 10);
		access.record("c", 20, "cursor");
		access.record("d", 21, "cursor");
		const timers = new FakeTimers();
		const calls: string[] = [];
		startPreloader({
			settings: ON,
			access,
			compose: async (repo) => {
				calls.push(repo);
			},
			now: () => 30,
			intervalMs: INTERVAL_MS,
			timers,
		});
		await timers.fire();
		expect(calls).toEqual(["a", "b"]);
	});

	test("a tick passes each repo with the surface last named for it", async () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		access.record("a", 1, "hermes");
		access.record("b", 2, "claude-code");
		const timers = new FakeTimers();
		const calls: Array<[string, Surface]> = [];
		startPreloader({
			settings: ON,
			access,
			compose: async (repo, surface) => {
				calls.push([repo, surface]);
			},
			now: () => 3,
			intervalMs: INTERVAL_MS,
			timers,
		});
		await timers.fire();
		expect(calls).toEqual([
			["a", "hermes"],
			["b", "claude-code"],
		]);
	});

	test("one interval is owned, it is unref'd, and it runs at the configured period", () => {
		const timers = new FakeTimers();
		startPreloader({
			settings: ON,
			access: new RepoAccess(),
			compose: async () => undefined,
			now: () => 0,
			intervalMs: INTERVAL_MS,
			timers,
		});
		expect(timers.timers.length).toBe(1);
		expect(timers.timers[0]?.unrefs).toBe(1);
		expect(timers.timers[0]?.ms).toBe(INTERVAL_MS);
	});

	test("a compose failure is counted, logged once for the tick, and the next tick still runs", async () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		const timers = new FakeTimers();
		const calls: string[] = [];
		const warnings: string[] = [];
		let failing = true;
		const preloader = startPreloader({
			settings: { ...ON, top: 1 },
			access,
			compose: async (repo) => {
				calls.push(repo);
				if (failing) throw new Error("upstream unavailable");
			},
			now: () => 0,
			intervalMs: INTERVAL_MS,
			timers,
			warn: (message) => {
				warnings.push(message);
			},
		});
		await timers.fire();
		expect(preloader.failures()).toBe(1);
		expect(warnings.length).toBe(1);
		failing = false;
		await timers.fire();
		expect(calls).toEqual(["a", "a"]);
		expect(preloader.failures()).toBe(1);
		expect(warnings.length).toBe(1);
	});

	test("several failures in one tick are counted and logged as one line", async () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		access.record("b", 1, "cursor");
		const timers = new FakeTimers();
		const warnings: string[] = [];
		const preloader = startPreloader({
			settings: ON,
			access,
			compose: async () => {
				throw new Error("boom");
			},
			now: () => 2,
			intervalMs: INTERVAL_MS,
			timers,
			warn: (message) => {
				warnings.push(message);
			},
		});
		await timers.fire();
		expect(preloader.failures()).toBe(2);
		expect(warnings.length).toBe(1);
	});

	test("a tick that is still running is not overlapped by the next one", async () => {
		const access = new RepoAccess();
		access.record("a", 0, "cursor");
		const timers = new FakeTimers();
		const calls: string[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		startPreloader({
			settings: { ...ON, top: 1 },
			access,
			compose: async (repo) => {
				calls.push(repo);
				await gate;
			},
			now: () => 0,
			intervalMs: INTERVAL_MS,
			timers,
		});
		const first = timers.fire();
		await timers.fire();
		expect(calls).toEqual(["a"]);
		release();
		await first;
		await timers.fire();
		expect(calls).toEqual(["a", "a"]);
	});

	test("stop clears the timer and is idempotent", () => {
		const timers = new FakeTimers();
		const preloader = startPreloader({
			settings: ON,
			access: new RepoAccess(),
			compose: async () => undefined,
			now: () => 0,
			intervalMs: INTERVAL_MS,
			timers,
		});
		expect(timers.live().length).toBe(1);
		preloader.stop();
		expect(timers.live().length).toBe(0);
		expect(timers.timers[0]?.clears).toBe(1);
		preloader.stop();
		expect(timers.timers[0]?.clears).toBe(1);
	});
});

describe("SUBSTRATE_CACHE_PRELOAD settings", () => {
	test("unset is off, top 3, every 300 s", () => {
		expect(loadCachePreloadSettings({})).toEqual({ enabled: false, top: 3, intervalS: 300 });
	});

	test("on, top and interval parse at their bounds", () => {
		expect(loadCachePreloadSettings({ SUBSTRATE_CACHE_PRELOAD: " On ", SUBSTRATE_CACHE_PRELOAD_TOP: "20", SUBSTRATE_CACHE_PRELOAD_S: "10" })).toEqual({
			enabled: true,
			top: 20,
			intervalS: 10,
		});
		expect(loadCachePreloadSettings({ SUBSTRATE_CACHE_PRELOAD_TOP: "1", SUBSTRATE_CACHE_PRELOAD_S: "3600" })).toEqual({
			enabled: false,
			top: 1,
			intervalS: 3600,
		});
	});

	test("a value outside its range is a ConfigError that names the variable", () => {
		const bad: Array<[string, string]> = [
			["SUBSTRATE_CACHE_PRELOAD_TOP", "0"],
			["SUBSTRATE_CACHE_PRELOAD_TOP", "21"],
			["SUBSTRATE_CACHE_PRELOAD_TOP", "2.5"],
			["SUBSTRATE_CACHE_PRELOAD_S", "9"],
			["SUBSTRATE_CACHE_PRELOAD_S", "3601"],
			["SUBSTRATE_CACHE_PRELOAD_S", "soon"],
		];
		for (const [name, value] of bad) {
			expect(() => loadCachePreloadSettings({ [name]: value })).toThrow(ConfigError);
			expect(() => loadCachePreloadSettings({ [name]: value })).toThrow(name);
		}
	});

	test("a mode that is not on or off is a ConfigError that names the variable", () => {
		expect(() => loadCachePreloadSettings({ SUBSTRATE_CACHE_PRELOAD: "yes" })).toThrow(ConfigError);
		expect(() => loadCachePreloadSettings({ SUBSTRATE_CACHE_PRELOAD: "yes" })).toThrow("SUBSTRATE_CACHE_PRELOAD=");
	});
});
