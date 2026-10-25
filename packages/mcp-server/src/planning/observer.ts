/**
 * The planning observer (phase 52, SOTA-08): the server-side writer of the planning plane.
 *
 * On a timer (`SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, unref'd, started and stopped by the server entry) it scans the checkout's
 * `.planning/` with the incremental index, so a scan reads and hashes only the documents that changed. It diffs the scan
 * against its baseline and publishes a complete change as one `planning.changed` event, through the ledger and the bus
 * (`observePlanningChange`). Nothing else writes: the reads never do.
 *
 * Heartbeat: a checkout heartbeats only in a scan that sees a complete change in it since the scan before. The session is that
 * checkout (`wt-<hash of its path>`), and its branch is read from its HEAD. A change the ledger does not store is heartbeated
 * once, in the scan that saw it; the scans after it are quiet, so the session goes `stale` after the freshness window.
 * A failed heartbeat is owed: the scans after it retry it, unchanged, until it reads written.
 *
 * Scans never overlap: a tick that arrives during a scan shares that scan rather than starting another. A failure is reported
 * on stderr when it appears or changes, and once more when the scans succeed again. Shutdown waits for a scan in flight.
 *
 * The baseline is process-local. The first scan is a baseline and publishes nothing. A failed publish holds the baseline,
 * so the same change is published on the next scan. The index cache is separate: it always holds the latest scan.
 */
import type { EventInput } from "../types.ts";
import { branchOf, gitLayout, planningSessionId, repoOf } from "./checkout.ts";
import type { PlanningConfigResult } from "./config.ts";
import { diffPlanningIndex, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { observePlanningChange } from "./events.ts";
import { buildPlanningIndex, errnoCode, snapshotOf, updatePlanningIndex, type PlanningFs, type PlanningIndex, type PlanningIndexFailure } from "./index.ts";
import type { DragonflyPresenceStore } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";
import { resolveSettings } from "./read.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

/** The handle a scan timer returns. Opaque to the observer: it is only passed back to `clearInterval`. */
export type PlanningTimerHandle = unknown;

/** The timers the observer schedules its scans with. Production uses the global timers; a test injects its own. */
export interface PlanningTimers {
	setInterval(run: () => Promise<unknown>, ms: number): PlanningTimerHandle;
	clearInterval(timer: PlanningTimerHandle): void;
}

const GLOBAL_TIMERS: PlanningTimers = {
	setInterval: (run, ms) => {
		const timer = setInterval(run, ms);
		timer.unref();
		return timer;
	},
	clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** Where a failure is reported in production: stderr, as the server's other background notes are. */
const STDERR_REPORT = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

export type PlanningHeartbeat =
	| { state: "written" }
	/** The scan saw no complete change in this checkout since the scan before, so there is nothing to heartbeat. */
	| { state: "not-due" }
	| { state: "presence-unset" }
	| { state: "failed"; detail: string };

/** What one scan did with the change it saw. `repo-unknown` is a change that cannot be attributed to a repo, so it is not published. */
export type ObserverOutcome = "baseline" | "unchanged" | "incomplete" | "published" | "not-published" | "repo-unknown";

export type ObserverScan =
	| { state: "disabled" }
	| { state: "unavailable"; code: PlanningIndexFailure }
	| { state: "failed"; detail: string }
	| { state: "observed"; outcome: ObserverOutcome; heartbeat: PlanningHeartbeat };

export interface PlanningObserverDeps {
	settings: PlanningConfigResult;
	fs: PlanningFs;
	/** Null when the cache endpoint is unset or refused by the endpoint policy. */
	presence: DragonflyPresenceStore | null;
	/** The ledger ingest (`Substrate.emit`). Resolves true when the event was stored. */
	emit: (event: EventInput) => Promise<boolean>;
	/** The timers the scans are scheduled with. Omitted in production. */
	timers?: PlanningTimers;
	/** Where a failure is reported. Omitted in production, where it goes to stderr. */
	report?: (line: string) => void;
}

export class PlanningObserver {
	/** The index of the latest scan. The next scan updates it, so an unchanged document is not read again. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/** The latest scan's snapshot. A heartbeat reports the change since it, so it moves with every scan. */
	private lastScan: { root: string; snapshot: PlanningSnapshot } | null = null;
	/** The publish baseline: what the ledger has been told. It holds when a publish fails, so the change is retried. */
	private baseline: { root: string; snapshot: PlanningSnapshot } | null = null;
	/** The heartbeat a failed write still owes: the change it was for. Retried on later scans until it reads written. */
	private pendingHeartbeat: { root: string; change: PlanningDiff } | null = null;
	private timer: PlanningTimerHandle | undefined;
	/** The scan in flight, or null. A scan asked for while one runs shares it. */
	private running: Promise<ObserverScan> | null = null;
	/** The problem last reported, or null while the scans are healthy. A report fires only when the problem changes. */
	private problem: string | null = null;
	private readonly timers: PlanningTimers;
	private readonly report: (line: string) => void;

	constructor(private readonly deps: PlanningObserverDeps) {
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.report = deps.report ?? STDERR_REPORT;
	}

	/** Start the scan timer at the configured cadence, unref'd. Nothing starts while the plane is disabled or misconfigured. Returns whether it is running. */
	start(): boolean {
		if (this.timer !== undefined) return true;
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return false;
		this.timer = this.timers.setInterval(() => this.tick(), resolved.limits.scanIntervalMs);
		return true;
	}

	/** Clear the timer. A scan in flight finishes; `idle` waits for it. No new scan starts from the timer. */
	stop(): void {
		this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Resolves once no scan is in flight. The shutdown path waits on it, inside its own bound. Never rejects. */
	idle(): Promise<void> {
		return this.running === null ? Promise.resolve() : this.running.then(() => undefined);
	}

	/** One scan. A call made while a scan is in flight shares that scan: no second scan starts behind it. Never rejects. */
	scan(): Promise<ObserverScan> {
		return this.running ?? this.startScan();
	}

	private startScan(): Promise<ObserverScan> {
		const run = this.scanOnce()
			.catch(failedScan)
			.finally(() => {
				this.running = null;
			});
		this.running = run;
		return run;
	}

	/** One timer tick: a scan (shared with one already in flight), then the report for its outcome. */
	private async tick(): Promise<void> {
		this.note(await this.scan());
	}

	/** Reports a problem when it appears or changes, and the recovery when the scans are healthy again. Silent while nothing changes. */
	private note(scan: ObserverScan): void {
		const problem = problemOf(scan);
		if (problem === this.problem) return;
		const before = this.problem;
		this.problem = problem;
		if (problem !== null) this.report(`[substrate] planning observer: ${problem}`);
		else if (before !== null) this.report("[substrate] planning observer: scans succeed again");
	}

	private async scanOnce(): Promise<ObserverScan> {
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return { state: "disabled" };
		const { root, limits } = resolved;
		const fsDeps = { fs: this.deps.fs, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } };
		const cached = this.index !== null && this.index.root === root ? this.index.index : null;
		const built = cached === null ? await buildPlanningIndex(root, fsDeps) : await updatePlanningIndex(root, fsDeps, cached);
		if (!built.ok) return { state: "unavailable", code: built.code };
		this.index = { root, index: built.index };

		const next = snapshotOf(built.index);
		// The change since the scan before: what a heartbeat reports. It moves with every scan, so a change is heartbeated once.
		const sinceLastScan = this.lastScan !== null && this.lastScan.root === root ? diffPlanningIndex(this.lastScan.snapshot, next) : null;
		this.lastScan = { root, snapshot: next };
		// The publish baseline, as the ledger was last told. It holds when a publish fails, so the same change is published again.
		const previous = this.baseline !== null && this.baseline.root === root ? this.baseline.snapshot : null;
		const diff = previous === null ? null : diffPlanningIndex(previous, next);
		const ttlMs = limits.presenceTtlS * 1000;
		const repo = await repoOf(this.deps.fs, root);
		if (repo.state === "known") {
			const observed = await observePlanningChange({
				previous,
				next,
				repo: repo.repo,
				sessionId: PLANNING_OBSERVER_SESSION,
				publisher: { publish: this.deps.emit },
			});
			this.baseline = { root, snapshot: observed.baseline };
			return { state: "observed", outcome: observed.outcome, heartbeat: await this.heartbeat(root, sinceLastScan, ttlMs) };
		}
		// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
		// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
		if (diff !== null && diff.complete && changesIn(diff) > 0) {
			if (!repo.transient) this.baseline = { root, snapshot: next };
			return { state: "observed", outcome: "repo-unknown", heartbeat: await this.heartbeat(root, sinceLastScan, ttlMs) };
		}
		this.baseline = { root, snapshot: next };
		const outcome: ObserverOutcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		return { state: "observed", outcome, heartbeat: await this.heartbeat(root, sinceLastScan, ttlMs) };
	}

	/** Heartbeats this checkout when the change since the last scan is complete and non-empty, or when a failed heartbeat is still owed. The record's time is replaced by the server's clock. */
	private async heartbeat(root: string, sinceLastScan: PlanningDiff | null, ttlMs: number): Promise<PlanningHeartbeat> {
		const change = this.owedHeartbeat(root, sinceLastScan);
		if (change === null) return { state: "not-due" };
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
		const result = await this.touchCheckout(root, presence, ttlMs);
		// A failed write stays owed: the next scan retries it, even when nothing else changed. Written clears the debt.
		this.pendingHeartbeat = result.state === "written" ? null : { root, change };
		return result;
	}

	/** The change a heartbeat is owed for: this scan's change when it is heartbeat-worthy, else the heartbeat a failed write still owes. */
	private owedHeartbeat(root: string, sinceLastScan: PlanningDiff | null): PlanningDiff | null {
		if (sinceLastScan !== null && sinceLastScan.complete && changesIn(sinceLastScan) > 0) return sinceLastScan;
		if (this.pendingHeartbeat === null) return null;
		if (this.pendingHeartbeat.root !== root) {
			this.pendingHeartbeat = null;
			return null;
		}
		return this.pendingHeartbeat.change;
	}

	/** Writes the checkout's session record. The result is written, or failed with an error code: never a message, which can carry host paths. */
	private async touchCheckout(root: string, presence: DragonflyPresenceStore, ttlMs: number): Promise<PlanningHeartbeat> {
		try {
			const layout = await gitLayout(this.deps.fs, root);
			if (!layout.ok) return { state: "failed", detail: layout.reason };
			const record: SessionRecord = {
				sessionId: planningSessionId(this.deps.fs, root),
				worktree: root,
				branch: await branchOf(this.deps.fs, layout.gitDir),
				activePhase: null,
				lastHeartbeatMs: 0,
			};
			await presence.touch(record, ttlMs);
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: errnoCode(cause) };
		}
	}
}

/** The number of paths a complete diff changes. A removal is counted only when the diff vouches for removals. */
function changesIn(diff: PlanningDiff): number {
	return diff.added.length + (diff.removed?.length ?? 0) + diff.changed.length;
}

/** A scan that threw. Only the error's code is kept: its message can carry host paths. */
function failedScan(cause: unknown): ObserverScan {
	return { state: "failed", detail: errnoCode(cause) };
}

/** What is wrong with a scan, in words, or null when nothing is. Codes and outcomes only: never a path or a message. */
function problemOf(scan: ObserverScan): string | null {
	if (scan.state === "disabled") return null;
	if (scan.state === "unavailable") return `scan unavailable: ${scan.code}`;
	if (scan.state === "failed") return `scan failed: ${scan.detail}`;
	if (scan.heartbeat.state === "failed") return `heartbeat failed: ${scan.heartbeat.detail}`;
	if (scan.outcome === "not-published") return "a change was not stored by the ledger, and is retried on the next scan";
	if (scan.outcome === "repo-unknown") return "a change could not be attributed to a repo, so nothing was published";
	return null;
}
