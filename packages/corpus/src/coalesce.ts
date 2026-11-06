/**
 * Turns a burst of change signals into one sync per repository (v1.7 phase 65).
 *
 * Pure: the caller passes the time of every call, so no test sleeps. A signal starts or extends the repository's burst. The
 * burst is due once it has been quiet for the debounce, or once it has lasted the maximum wait (so a steady stream of edits
 * still syncs). `due` hands a due burst out and marks the repository running; a signal that arrives while it runs becomes
 * exactly one more burst, due after `finished`. Memory is bounded: at most {@link MAX_TRACKED_REPOS} repositories are
 * tracked, and every signal beyond that folds into the single {@link FULL_SWEEP} key, which means "every repository".
 */
import type { SyncTrigger } from "./protocol.ts";

/** The key of a full sweep: a sync of every registered repository. */
export const FULL_SWEEP = "*";
const MAX_TRACKED_REPOS = 4096;

interface CoalescerOptions {
	debounceMs: number;
	/** Never below `debounceMs`. */
	maxWaitMs: number;
	maxTracked?: number | undefined;
}

/** A burst handed out by `due`. */
interface DueSync {
	repo: string;
	/** The trigger of the burst's first signal. */
	trigger: SyncTrigger;
	/** When the burst's first signal arrived; the lag of the sync counts from here. */
	firstAtMs: number;
}

interface Burst {
	trigger: SyncTrigger;
	firstAtMs: number;
	lastAtMs: number;
}

interface Tracked {
	pending: Burst | null;
	running: boolean;
}

export class Coalescer {
	private readonly tracked = new Map<string, Tracked>();
	private readonly debounceMs: number;
	private readonly maxWaitMs: number;
	private readonly maxTracked: number;

	constructor(options: CoalescerOptions) {
		this.debounceMs = Math.max(0, options.debounceMs);
		this.maxWaitMs = Math.max(this.debounceMs, options.maxWaitMs);
		this.maxTracked = Math.max(1, options.maxTracked ?? MAX_TRACKED_REPOS);
	}

	/** Records a change signal for `repo` (or {@link FULL_SWEEP}). */
	signal(repo: string, trigger: SyncTrigger, atMs: number): void {
		const key = this.tracked.has(repo) || this.tracked.size < this.maxTracked ? repo : FULL_SWEEP;
		const entry = this.tracked.get(key) ?? { pending: null, running: false };
		if (entry.pending === null) entry.pending = { trigger, firstAtMs: atMs, lastAtMs: atMs };
		else entry.pending.lastAtMs = Math.max(entry.pending.lastAtMs, atMs);
		this.tracked.set(key, entry);
	}

	private isDue(burst: Burst, atMs: number): boolean {
		return atMs - burst.lastAtMs >= this.debounceMs || atMs - burst.firstAtMs >= this.maxWaitMs;
	}

	/**
	 * The bursts due at `atMs`, oldest first, each marked running until `finished`. A due full sweep covers every other idle
	 * repository, so those bursts are dropped with it.
	 */
	due(atMs: number): DueSync[] {
		const ready: DueSync[] = [];
		for (const [repo, entry] of this.tracked) {
			if (entry.running || entry.pending === null || !this.isDue(entry.pending, atMs)) continue;
			ready.push({ repo, trigger: entry.pending.trigger, firstAtMs: entry.pending.firstAtMs });
		}
		ready.sort((a, b) => a.firstAtMs - b.firstAtMs);
		const sweep = ready.some((item) => item.repo === FULL_SWEEP);
		const claimed = sweep ? ready.filter((item) => item.repo === FULL_SWEEP) : ready;
		for (const item of claimed) {
			const entry = this.tracked.get(item.repo);
			if (entry === undefined) continue;
			entry.pending = null;
			entry.running = true;
		}
		if (sweep) {
			for (const [repo, entry] of this.tracked) {
				if (repo === FULL_SWEEP || entry.running || entry.pending === null) continue;
				// A signal that arrived after the sweep was due is not covered by it and keeps its own burst.
				if (entry.pending.lastAtMs <= atMs) this.tracked.delete(repo);
			}
		}
		return claimed;
	}

	/** The sync of `repo` ended; a signal that arrived meanwhile is now a burst of its own. */
	finished(repo: string): void {
		const entry = this.tracked.get(repo);
		if (entry === undefined) return;
		entry.running = false;
		if (entry.pending === null) this.tracked.delete(repo);
	}

	/** When the next burst becomes due, or null when nothing waits; a running repository is not waited for. */
	nextDueAtMs(): number | null {
		let next: number | null = null;
		for (const entry of this.tracked.values()) {
			if (entry.running || entry.pending === null) continue;
			const at = Math.min(entry.pending.lastAtMs + this.debounceMs, entry.pending.firstAtMs + this.maxWaitMs);
			if (next === null || at < next) next = at;
		}
		return next;
	}

	/** How many repositories have a burst waiting or a sync running. */
	get size(): number {
		return this.tracked.size;
	}
}
