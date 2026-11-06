/**
 * Pattern-based cache preload (phase 47, D47-d and D47-e).
 *
 * `RepoAccess` counts brief requests per repo over a sliding hour, in process
 * memory and capped at `PRELOAD_REPO_CAP` repos: the least recently seen repo
 * is evicted at the cap. It keeps the brief request last named for each repo,
 * with the fields its cache key is built from (repo, branch, graph_id) and the
 * surface. `startPreloader` owns at most one interval timer. Each tick takes
 * the top K repos by count and calls the caller's `compose` with the request
 * last named for each. `compose` writes through the existing cache. With the
 * switch off no timer is made and `compose` is never called.
 *
 * A failed compose is counted and logged once per tick; it never throws and
 * never reaches a request. The timer is unref'd and cleared by `stop()`.
 */
import type { BriefRequest } from "./brief.ts";
import type { CachePreloadSettings } from "./config.ts";
import { redact } from "./redact.ts";

/** The sliding window a request counts in. */
export const PRELOAD_WINDOW_MS = 3_600_000;
/** Most repos held at once; the least recently seen is evicted past this. */
export const PRELOAD_REPO_CAP = 256;
/** Longest branch or graph id kept in a remembered shape; a longer request is not remembered, since a truncated key would never match a real request. */
export const PRELOAD_FIELD_CAP = 256;
/** Most request times kept per repo; a repo past it ranks by its newest times, so one busy repo cannot grow the map. */
const PRELOAD_EVENTS_PER_REPO = 4_096;

/** A brief request as a warm-up repeats it: the fields its cache key is built from, and the surface it names. */
export type BriefShape = BriefRequest & { repo: string };

/** Drop the times that have left the window. Times are appended in order, so the live ones are a suffix. */
function expire(times: number[], now: number): void {
	const live = times.findIndex((at) => now - at < PRELOAD_WINDOW_MS);
	times.splice(0, live < 0 ? times.length : live);
}

/** What the access map keeps for one repo: its request times in the window, and the brief request last named. */
interface RepoEntry {
	times: number[];
	shape: BriefShape;
}

/**
 * Brief requests per repo over a sliding hour. A map in recency order: a
 * repo moves to the end on each record, so its first key is the least
 * recently seen and is the one evicted at the cap.
 */
export class RepoAccess {
	private readonly repos = new Map<string, RepoEntry>();

	/** Count one brief request for `shape.repo` at `now` (epoch ms), and remember the request it named. */
	record(now: number, shape: BriefShape): void {
		const repo = shape.repo;
		if (repo.length > PRELOAD_FIELD_CAP || (shape.branch?.length ?? 0) > PRELOAD_FIELD_CAP || (shape.graph_id?.length ?? 0) > PRELOAD_FIELD_CAP) return;
		const known = this.repos.get(repo);
		const times = known?.times ?? [];
		if (known !== undefined) {
			this.repos.delete(repo);
		} else if (this.repos.size >= PRELOAD_REPO_CAP) {
			const oldest = this.repos.keys().next().value;
			if (oldest !== undefined) this.repos.delete(oldest);
		}
		expire(times, now);
		times.push(now);
		if (times.length > PRELOAD_EVENTS_PER_REPO) times.splice(0, times.length - PRELOAD_EVENTS_PER_REPO);
		this.repos.set(repo, { times, shape });
	}

	/**
	 * The `k` repos with the most requests inside the hour at `now`, each as the
	 * brief request last named for it. Ties go to the more recently requested repo,
	 * then to the name. A repo with no request left in the window is dropped from the map.
	 */
	topRepos(k: number, now: number): BriefShape[] {
		const ranked: Array<{ repo: string; shape: BriefShape; count: number; last: number }> = [];
		for (const [repo, entry] of this.repos) {
			expire(entry.times, now);
			const last = entry.times[entry.times.length - 1];
			if (last === undefined) {
				this.repos.delete(repo);
				continue;
			}
			ranked.push({ repo, shape: entry.shape, count: entry.times.length, last });
		}
		ranked.sort((a, b) => b.count - a.count || b.last - a.last || a.repo.localeCompare(b.repo));
		return ranked.slice(0, Math.max(0, Math.floor(k))).map(({ shape }) => shape);
	}

	/** Repos currently held, expired ones included until the next `topRepos`. */
	size(): number {
		return this.repos.size;
	}
}

/**
 * A warm-up's own check: a brief that did not compose completely (a source
 * failed, so it is degraded or a snapshot) throws, so the tick counts it and
 * it is never taken for a warm entry.
 */
export function requireComplete<T extends { state: string }>(detail: T, shape: BriefShape): T {
	if (detail.state !== "complete") throw new Error(`brief for ${shape.repo} composed ${detail.state}, not complete`);
	return detail;
}

/** One running interval: unref'd by the preloader, cleared by `stop`. */
export interface PreloadTimer {
	unref(): void;
	clear(): void;
}

/** The interval seam: production uses the runtime's timer; a test drives the tick itself. */
export interface PreloadTimers {
	setInterval(handler: () => Promise<void>, ms: number): PreloadTimer;
}

const SYSTEM_PRELOAD_TIMERS: PreloadTimers = {
	setInterval: (handler, ms) => {
		const timer = setInterval(handler, ms);
		return {
			unref: () => timer.unref(),
			clear: () => clearInterval(timer),
		};
	},
};

interface PreloaderDeps {
	settings: CachePreloadSettings;
	access: RepoAccess;
	/** Composes the brief one shape names and writes it through the cache. A rejection is counted, never thrown. */
	compose: (shape: BriefShape) => Promise<unknown>;
	/** Epoch ms; a fake clock in tests. */
	now: () => number;
	/** Milliseconds between ticks. */
	intervalMs: number;
	timers?: PreloadTimers;
	/** One line per tick that had failures. Defaults to stderr. */
	warn?: (message: string) => void;
}

export interface Preloader {
	/** Clears the timer. A tick already running finishes; no new tick starts. */
	stop(): void;
	/** Composes that failed since start. */
	failures(): number;
}

const INERT_PRELOADER: Preloader = { stop: () => undefined, failures: () => 0 };

/**
 * Start the preloader. Off returns an inert handle and touches no timer. On
 * owns one unref'd interval; a tick that is still running when the next one
 * fires is skipped, so composes never overlap.
 */
export function startPreloader(deps: PreloaderDeps): Preloader {
	if (!deps.settings.enabled) return INERT_PRELOADER;
	const timers = deps.timers ?? SYSTEM_PRELOAD_TIMERS;
	const warn = deps.warn ?? ((message: string) => process.stderr.write(`[substrate] ${message}\n`));
	let failed = 0;
	let running = false;

	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		let misses = 0;
		let first: unknown = null;
		const miss = (cause: unknown): void => {
			failed += 1;
			misses += 1;
			first ??= cause;
		};
		try {
			for (const shape of deps.access.topRepos(deps.settings.top, deps.now())) {
				try {
					await deps.compose(shape);
				} catch (cause) {
					miss(cause);
				}
			}
		} catch (cause) {
			miss(cause);
		} finally {
			running = false;
		}
		if (misses > 0) {
			try {
				warn(`cache preload: ${misses} brief compose(s) failed this tick, ${failed} since start: ${redact(String(first)).slice(0, 200)}`);
			} catch {
				// A broken log sink must not turn a counted failure into a thrown one.
			}
		}
	};

	const timer = timers.setInterval(tick, deps.intervalMs);
	timer.unref();
	let stopped = false;

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			timer.clear();
		},
		failures: () => failed,
	};
}
