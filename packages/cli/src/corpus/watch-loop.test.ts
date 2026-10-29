import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FULL_SWEEP, type HintBatch, type SyncOutcome, type WatchFactory } from "@substrate/corpus";
import { defined, type FakeGit, fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import type { Inventory } from "./inventory.ts";
import type { SyncResult } from "./sync.ts";
import { discoverRegistry, type LoopSyncRequest, POLL_MS, runWatchLoop, watchTargets, type WatchLoopDeps } from "./watch-loop.ts";
import type { WatchSettings } from "./watch-settings.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "f".repeat(40);

/** Two checkouts below one root, as discovery sees them through a fake git. */
function fixture(): { root: string; alpha: string; beta: string; runner: FakeGit } {
	const root = tempDir("corpus-loop-");
	dirs.push(root);
	writeTree(root, { "alpha/.git/HEAD": "", "alpha/README.md": "# a\n", "beta/.git/HEAD": "", "beta/README.md": "# b\n" });
	const alpha = join(root, "alpha");
	const beta = join(root, "beta");
	const base = { head: HEAD, branch: "main", remoteDefault: "main", files: ["README.md"] };
	const runner = fakeGit({
		[alpha]: { ...base, origin: "git@github.com:Acme/Alpha.git" },
		[beta]: { ...base, origin: "git@github.com:Acme/Beta.git" },
	});
	return { root, alpha, beta, runner };
}

function syncResult(trigger: LoopSyncRequest["trigger"], outcome: SyncOutcome = "ok"): SyncResult {
	return {
		outcome,
		trigger,
		execute: true,
		repos: [],
		notFound: [],
		inventory: null,
		plan: null,
		ingest: null,
		mirrors: [],
		incomplete: [],
		error: outcome === "failed" ? "the server is unavailable (503)" : null,
		delivery: null,
		durationMs: 25,
		lagS: 3,
	};
}

interface Harness {
	deps: WatchLoopDeps;
	calls: Array<LoopSyncRequest & { at: number }>;
	out: string[];
	err: string[];
	sleeps: number[];
	clock: { now: number };
	stop: () => void;
	hints: (...batches: string[][]) => void;
	watches: Array<{ dir: string; closed: boolean; emit: (filename: string | null) => void }>;
	attempts: () => number;
}

function harness(options: { settings?: Partial<WatchSettings>; once?: boolean; sync?: (request: LoopSyncRequest, calls: number) => SyncResult; factory?: WatchFactory } = {}): Harness {
	const { root, runner } = fixture();
	const clock = { now: 1_000_000 };
	const calls: Harness["calls"] = [];
	const out: string[] = [];
	const err: string[] = [];
	const sleeps: number[] = [];
	const queue: string[][] = [];
	const watches: Harness["watches"] = [];
	let attempts = 0;
	let stopped = false;
	const factory: WatchFactory =
		options.factory ??
		((dir, listener) => {
			attempts += 1;
			const watch = { dir, closed: false, emit: listener };
			watches.push(watch);
			return {
				close: () => {
					watch.closed = true;
				},
			};
		});
	const settings: WatchSettings = { mirrorDir: "/mirrors", spoolDir: "/spool", debounceMs: 2000, maxWaitMs: 30_000, watchMax: 100, sweepS: 900, ...options.settings };
	const deps: WatchLoopDeps = {
		settings,
		roots: [root],
		sweepS: settings.sweepS,
		once: options.once ?? false,
		now: () => clock.now,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.now += ms;
		},
		stopped: () => stopped,
		sync: async (request) => {
			calls.push({ ...request, at: clock.now });
			const result = options.sync?.(request, calls.length) ?? syncResult(request.trigger);
			// A sync takes time, during which signals can arrive.
			clock.now += 300;
			return result;
		},
		runner,
		// Hints only arrive once the first sweep ran, so a hint never meets the startup sweep that would cover it.
		readHints: (): HintBatch => ({ dirs: calls.length === 0 ? [] : (queue.shift() ?? []), consumed: 0, dropped: 0 }),
		watchFactory: factory,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	};
	return {
		deps,
		calls,
		out,
		err,
		sleeps,
		clock,
		stop: () => {
			stopped = true;
		},
		hints: (...batches) => {
			queue.push(...batches);
		},
		watches,
		attempts: () => attempts,
	};
}

/** The newest watch on a directory that is still open (a sweep replaces the watches, closing the old ones). */
function liveWatch(h: Harness, name: string): Harness["watches"][number] {
	return defined(h.watches.filter((watch) => !watch.closed && watch.dir.endsWith(name)).at(-1), `a live watch on ${name}`);
}

/** Runs the loop until `done` says so after a sync (the loop then ends cleanly). */
async function runUntil(h: Harness, done: (calls: Harness["calls"]) => boolean): Promise<number> {
	const inner = h.deps.sync;
	h.deps.sync = async (request) => {
		const result = await inner(request);
		if (done(h.calls)) h.stop();
		return result;
	};
	return await runWatchLoop(h.deps);
}

describe("runWatchLoop", () => {
	test("starts with one sweep after the debounce, labelled as a sweep for every repository", async () => {
		const h = harness();
		const code = await runUntil(h, (calls) => calls.length >= 1);

		expect(code).toBe(0);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toMatchObject({ repo: FULL_SWEEP, trigger: "sweep" });
		expect(h.out.join("")).toContain("all repositories synced (sweep): ok");
		// The loop slept in poll-sized steps, never spinning.
		expect(h.sleeps.every((ms) => ms >= 50 && ms <= POLL_MS)).toBe(true);
	});

	test("hints for the same repository coalesce into one sync per repository; an unknown directory is ignored", async () => {
		const h = harness();
		const registry = discoverRegistry(h.deps.roots, h.deps.runner);
		const alpha = defined(registry.roots.find((target) => target.repo === "Acme/Alpha"), "alpha").dir;
		const beta = defined(registry.roots.find((target) => target.repo === "Acme/Beta"), "beta").dir;
		h.hints([alpha, alpha, beta], [alpha, "/nowhere/else"]);

		await runUntil(h, (calls) => calls.length >= 3);

		const byRepo = h.calls.slice(1).map((call) => `${call.repo}:${call.trigger}`).sort();
		expect(byRepo).toEqual(["Acme/Alpha:hook", "Acme/Beta:hook"]);
		expect(h.err.join("")).toContain("below none of the roots");
	});

	test("a burst of file events is one sync per repository, started after the quiet time", async () => {
		const h = harness();
		let fired = false;
		const sleep = h.deps.sleep;
		h.deps.sleep = async (ms) => {
			// After the startup sweep ran, a burst of edits arrives in one watched directory.
			if (!fired && h.calls.length === 1) {
				fired = true;
				const watch = liveWatch(h, "alpha");
				for (let i = 0; i < 20; i++) watch.emit("guide.md");
			}
			await sleep(ms);
		};

		await runUntil(h, (calls) => calls.length >= 2);

		expect(h.calls.map((call) => `${call.repo}:${call.trigger}`)).toEqual(["*:sweep", "Acme/Alpha:watch"]);
		const last = defined(h.calls[1], "the watch sync");
		expect(last.at - last.firstSignalAtMs).toBeGreaterThanOrEqual(2000);
	});

	test("a signal that arrives while a repository syncs becomes exactly one more sync of it", async () => {
		const h: Harness = harness({
			sync: (request, calls) => {
				if (request.repo === "Acme/Alpha" && calls === 2) {
					const watch = liveWatch(h, "alpha");
					for (let i = 0; i < 5; i++) watch.emit("a.md");
				}
				return syncResult(request.trigger);
			},
		});
		h.hints([join(h.deps.roots[0] ?? "", "alpha")]);

		await runUntil(h, (calls) => calls.length >= 3);

		expect(h.calls.map((call) => call.repo)).toEqual([FULL_SWEEP, "Acme/Alpha", "Acme/Alpha"]);
		expect(h.calls.slice(1).map((call) => call.trigger)).toEqual(["hook", "watch"]);
	});

	test("a stop request ends the loop after the sync in flight and closes every watch", async () => {
		const h: Harness = harness({
			sync: (request) => {
				if (request.repo === "Acme/Alpha") h.stop();
				return syncResult(request.trigger);
			},
		});
		const alpha = join(h.deps.roots[0] ?? "", "alpha");
		const beta = join(h.deps.roots[0] ?? "", "beta");
		h.hints([alpha, beta]);

		const code = await runWatchLoop(h.deps);

		expect(code).toBe(0);
		// Beta was due in the same turn but never started: the loop stopped after alpha.
		expect(h.calls.map((call) => call.repo)).toEqual([FULL_SWEEP, "Acme/Alpha"]);
		expect(h.watches.length).toBeGreaterThan(0);
		expect(h.watches.every((watch) => watch.closed)).toBe(true);
	});

	test("sweeps repeat at the configured interval", async () => {
		const h = harness({ settings: { sweepS: 30 } });
		await runUntil(h, (calls) => calls.length >= 3);
		const times = h.calls.map((call) => call.at);
		expect(h.calls.every((call) => call.repo === FULL_SWEEP)).toBe(true);
		expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30_000);
		expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(30_000);
		expect((times[2] ?? 0) - (times[1] ?? 0)).toBeLessThan(33_000);
	});

	test("a failed sync is reported on the error stream and the loop carries on", async () => {
		const h = harness({ sync: (request, calls) => syncResult(request.trigger, calls === 1 ? "failed" : "ok"), settings: { sweepS: 30 } });
		await runUntil(h, (calls) => calls.length >= 2);
		expect(h.err.join("")).toContain("failed");
		expect(h.err.join("")).toContain("unavailable");
		expect(h.calls).toHaveLength(2);
	});

	test("when the watch limit is hit the loop says so once and keeps sweeping", async () => {
		const limit: WatchFactory = () => {
			throw Object.assign(new Error("limit"), { code: "ENOSPC" });
		};
		const h = harness({ factory: limit, settings: { sweepS: 30 } });
		await runUntil(h, (calls) => calls.length >= 2);
		expect(h.err.filter((text) => text.includes("inotify watch limit"))).toHaveLength(1);
		expect(h.calls.map((call) => call.trigger)).toEqual(["sweep", "sweep"]);
	});

	test("--once runs one sweep, watches nothing and exits with the sweep's verdict", async () => {
		const ok = harness({ once: true });
		expect(await runWatchLoop(ok.deps)).toBe(0);
		expect(ok.calls.map((call) => `${call.repo}:${call.trigger}`)).toEqual(["*:sweep"]);
		expect(ok.attempts()).toBe(0);

		const partial = harness({ once: true, sync: (request) => syncResult(request.trigger, "partial") });
		expect(await runWatchLoop(partial.deps)).toBe(1);
		const failed = harness({ once: true, sync: (request) => syncResult(request.trigger, "failed") });
		expect(await runWatchLoop(failed.deps)).toBe(1);
		expect(failed.err.join("")).toContain("failed");
	});
});

describe("discoverRegistry", () => {
	test("maps a checkout directory, a symlinked path to it and a path with a trailing slash to the repository label, and an unknown directory to nothing", () => {
		const { root, alpha, beta, runner } = fixture();
		const link = join(root, "link-to-alpha");
		symlinkSync(alpha, link);

		const registry = discoverRegistry([root], runner);

		expect(registry.labels).toEqual(["Acme/Alpha", "Acme/Beta"]);
		expect(registry.labelForDir(alpha)).toBe("Acme/Alpha");
		expect(registry.labelForDir(link)).toBe("Acme/Alpha");
		expect(registry.labelForDir(`${beta}/`)).toBe("Acme/Beta");
		expect(registry.labelForDir("/somewhere/else")).toBeNull();
	});
});

describe("watchTargets", () => {
	test("adds the existing directories of the documents once each, after the repository roots", () => {
		const { root, alpha, runner } = fixture();
		mkdirSync(join(alpha, "docs", "adr"), { recursive: true });
		const registry = discoverRegistry([root], runner);
		const entry = (path: string) => ({ repo: "Acme/Alpha", path, kind: "doc" as const, tier: 1 as const, sha256: "a".repeat(64), bytes: 1, source: "fs" as const });
		const inventory: Inventory = {
			entries: [entry("README.md"), entry("docs/a.md"), entry("docs/b.md"), entry("docs/adr/0001.md"), entry("gone/c.md")],
			paths: new Map(),
			sources: ["fs"],
			maxTier: 2,
			scope: { coverage: [], maxTier: 2 },
			report: {
				checkouts: 2,
				repos: [{ repo: "Acme/Alpha", dir: alpha, source: "fs", files: 5, bytes: 5, complete: true }],
				collapsed: { clones: 0, worktrees: 0, identical: 0, identicalGroups: 0, identicalCopies: [] },
				skipped: [],
				skippedByReason: {},
				emptyCollections: 0,
				notes: [],
			},
		};

		const targets = watchTargets(registry, inventory);

		expect(targets.map((target) => target.dir)).toEqual([alpha, join(root, "beta"), join(alpha, "docs"), join(alpha, "docs", "adr")]);
		expect(watchTargets(registry, null).map((target) => target.dir)).toEqual([alpha, join(root, "beta")]);
	});
});
