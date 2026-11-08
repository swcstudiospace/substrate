/**
 * The long-running loop of `substrate corpus watch` (v1.7 phase 65).
 *
 * Three signals feed one `Coalescer`: the filesystem watcher (a change in a watched directory), the hint spool (a git hook
 * said a repository moved) and the sweep timer (every `sweepS` seconds, a full sync that also fetches the mirrors and finds
 * what no trigger saw). One sync runs at a time, through the same `runSync` as `corpus sync --execute`. The loop reads every
 * repository and writes nothing into any of them. It never throws for a failed sync: that is reported and the loop goes on.
 *
 * Time, sleeping, the watcher, the spool and the sync are all injected, so the tests drive it with a fake clock and never wait.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	Coalescer,
	createWatcher,
	discoverRepos,
	FULL_SWEEP,
	type GitRunner,
	type HintBatch,
	type SyncTrigger,
	type Watcher,
	type WatchFactory,
	type WatchTarget,
} from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";
import type { SyncResult } from "./sync.ts";
import { syncFailed } from "./sync.ts";
import { renderSyncWarnings } from "./render-sync.ts";
import type { WatchSettings } from "./watch-settings.ts";

/** How often the hint spool is read and the clock is looked at when nothing is due sooner. */
export const POLL_MS = 1000;
/** A loop never spins: the shortest sleep. */
const MIN_SLEEP_MS = 50;

export interface LoopSyncRequest {
	/** A repository label, or {@link FULL_SWEEP}. */
	repo: string;
	trigger: SyncTrigger;
	firstSignalAtMs: number;
}

export interface WatchLoopDeps {
	settings: WatchSettings;
	roots: string[];
	/** Seconds between sweeps; the command's `--sweep-s` or the setting. */
	sweepS: number;
	once: boolean;
	now: () => number;
	/** Resolves after `ms`, or sooner when a stop was requested. */
	sleep: (ms: number) => Promise<void>;
	stopped: () => boolean;
	sync: (request: LoopSyncRequest) => Promise<SyncResult>;
	runner: GitRunner | undefined;
	readHints: () => HintBatch;
	watchFactory: WatchFactory;
	out: (text: string) => void;
	err: (text: string) => void;
}

/** The registered repositories and which directories belong to which label. */
interface Registry {
	labels: string[];
	/** The checkout and collection roots, as watch targets. */
	roots: WatchTarget[];
	labelForDir(dir: string): string | null;
}

function realOrSelf(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		// A directory that is gone cannot be resolved; the plain path is the only name it has.
		return dir;
	}
}

/** Finds the repositories below the roots the way a sync does (the same discovery, so the labels agree). */
export function discoverRegistry(roots: readonly string[], runner: GitRunner | undefined): Registry {
	const found = discoverRepos(roots, runner === undefined ? {} : { run: runner });
	const byDir = new Map<string, string>();
	const targets: WatchTarget[] = [];
	const add = (dir: string, repo: string): void => {
		byDir.set(resolve(dir), repo);
		byDir.set(realOrSelf(dir), repo);
	};
	for (const checkout of found.checkouts) {
		add(checkout.dir, checkout.repo);
		targets.push({ repo: checkout.repo, dir: checkout.dir });
	}
	for (const collection of found.collections) {
		add(collection.dir, collection.repo);
		targets.push({ repo: collection.repo, dir: collection.dir });
	}
	// A linked worktree or clone folded into another directory still names the repository that absorbed it.
	for (const record of found.collapsed.records) add(record.dir, record.repo);
	return {
		labels: [...new Set(targets.map((target) => target.repo))].sort(),
		roots: targets,
		labelForDir: (dir) => byDir.get(resolve(dir)) ?? byDir.get(realOrSelf(dir)) ?? null,
	};
}

/** The directories worth watching: each repository root and every directory that holds one of its documents. */
export function watchTargets(registry: Registry, inventory: Inventory | null): WatchTarget[] {
	const targets = [...registry.roots];
	if (inventory === null) return targets;
	const dirOf = new Map<string, string>();
	for (const report of inventory.report.repos) if (report.source === "fs" && !dirOf.has(report.repo)) dirOf.set(report.repo, report.dir);
	const seen = new Set(targets.map((target) => target.dir));
	const addDir = (repo: string, path: string): void => {
		const root = dirOf.get(repo);
		if (root === undefined) return;
		const dir = join(root, dirname(path));
		if (seen.has(dir) || !existsSync(dir)) return;
		seen.add(dir);
		targets.push({ repo, dir });
	};
	for (const entry of inventory.entries) addDir(entry.repo, entry.path);
	// Copies dropped as identical still live in their own directories. Those directories are watched before the watcher applies its limit.
	for (const group of inventory.report.collapsed.identicalCopies) {
		for (const copy of group.copies) {
			const split = copy.indexOf(":");
			if (split <= 0) continue;
			addDir(copy.slice(0, split), copy.slice(split + 1));
		}
	}
	return targets;
}

function line(result: SyncResult, request: LoopSyncRequest): string {
	const counts = result.plan?.counts;
	const changes = counts === undefined ? "" : ` +${counts.add} ~${counts.change + counts.update + counts.rename} -${counts.tombstone}`;
	const bad = (result.ingest?.counts.refused ?? 0) + (result.ingest?.counts.failed ?? 0);
	return `[substrate] corpus watch: ${request.repo === FULL_SWEEP ? "all repositories" : request.repo} synced (${request.trigger}): ${result.outcome}${changes}${bad > 0 ? `, ${bad} refused or failed` : ""} in ${result.durationMs} ms, lag ${result.lagS} s${result.error === null ? "" : `; ${result.error}`}\n`;
}

/** Runs one sync and reports it; the loop's only call into the sync. Returns the result for the caller's bookkeeping. */
async function runOne(deps: WatchLoopDeps, request: LoopSyncRequest): Promise<SyncResult> {
	const result = await deps.sync(request);
	const write = syncFailed(result) ? deps.err : deps.out;
	write(line(result, request));
	const warnings = renderSyncWarnings(result);
	if (warnings !== "") write(warnings);
	return result;
}

export async function runWatchLoop(deps: WatchLoopDeps): Promise<number> {
	const { settings } = deps;
	if (deps.once) {
		const result = await runOne(deps, { repo: FULL_SWEEP, trigger: "sweep", firstSignalAtMs: deps.now() });
		return syncFailed(result) ? 1 : 0;
	}

	const coalescer = new Coalescer({ debounceMs: settings.debounceMs, maxWaitMs: settings.maxWaitMs });
	let registry = discoverRegistry(deps.roots, deps.runner);
	let degradedReported = false;
	const watcher: Watcher = createWatcher({
		dirs: registry.roots,
		onChange: (repo, atMs) => coalescer.signal(repo, "watch", atMs),
		watchFactory: deps.watchFactory,
		clock: deps.now,
		max: settings.watchMax,
	});
	const reportWatcher = (): void => {
		const state = watcher.state();
		if (state.degraded !== null && !degradedReported) {
			degradedReported = true;
			deps.err(`[substrate] corpus watch: the inotify watch limit was reached; continuing with a sweep every ${deps.sweepS} s only\n`);
		}
	};
	reportWatcher();

	const sweepMs = deps.sweepS * 1000;
	// The first sweep is due on the first turn: the watcher only reports what changes after it started.
	let nextSweepAt = deps.now();
	try {
		while (!deps.stopped()) {
			const now = deps.now();
			const hints = deps.readHints();
			for (const dir of hints.dirs) {
				const label = registry.labelForDir(dir);
				if (label === null) deps.err("[substrate] corpus watch: a hint named a repository below none of the roots; it was ignored\n");
				else coalescer.signal(label, "hook", now);
			}
			if (now >= nextSweepAt) {
				coalescer.signal(FULL_SWEEP, "sweep", now);
				nextSweepAt = now + sweepMs;
			}
			for (const due of coalescer.due(now)) {
				if (deps.stopped()) {
					coalescer.finished(due.repo);
					continue;
				}
				const request: LoopSyncRequest = { repo: due.repo, trigger: due.trigger, firstSignalAtMs: due.firstAtMs };
				const result = await runOne(deps, request);
				coalescer.finished(due.repo);
				if (due.repo === FULL_SWEEP) {
					// A sweep may have found new repositories and directories: the registry and the watches follow it.
					registry = discoverRegistry(deps.roots, deps.runner);
					watcher.replace(watchTargets(registry, result.inventory));
					reportWatcher();
				}
			}
			if (deps.stopped()) break;
			const next = coalescer.nextDueAtMs();
			const wake = Math.min(nextSweepAt, deps.now() + POLL_MS, next ?? Number.POSITIVE_INFINITY);
			await deps.sleep(Math.max(MIN_SLEEP_MS, wake - deps.now()));
		}
	} finally {
		watcher.close();
	}
	return 0;
}
