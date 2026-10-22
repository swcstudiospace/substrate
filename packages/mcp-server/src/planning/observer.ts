/**
 * The planning observer (phase 52, SOTA-08): the server-side writer of the planning plane.
 *
 * On a timer (`PLANNING_SCAN_INTERVAL_MS`, unref'd, started and stopped by the server entry) it scans the checkout's
 * `.planning/` with the incremental index, so a scan reads and hashes only the documents that changed. It diffs the scan
 * against its baseline and publishes a complete change as one `planning.changed` event, through the ledger and the bus
 * (`observePlanningChange`). Nothing else writes: the reads never do.
 *
 * Heartbeat: a checkout heartbeats only when this observer sees a complete change in it. The session is that checkout
 * (`wt-<hash of its path>`), and its branch is read from its HEAD. A scan that sees no change writes no heartbeat, so a
 * session is listed as `active` for the freshness window after it last changed a planning document, and `stale` after.
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

/** How often the observer scans, in milliseconds. A fixed cadence, not configuration: a scan is incremental, so it is cheap. */
export const PLANNING_SCAN_INTERVAL_MS = 15_000;

export type PlanningHeartbeat =
	| { state: "written" }
	/** The scan saw no complete change in this checkout, so there is nothing to heartbeat. */
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
}

export class PlanningObserver {
	/** The index of the latest scan, which the next scan updates. Holds whatever the last scan found, even when a publish failed. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/** The baseline a diff is taken against. It moves forward, and holds when a publish fails. */
	private baseline: { root: string; snapshot: PlanningSnapshot } | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Scans run one at a time, in arrival order, so two scans never publish the same change. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: PlanningObserverDeps) {}

	/** Start the scan timer, unref'd. Nothing starts while the plane is disabled or misconfigured. Returns whether it is running. */
	start(intervalMs: number = PLANNING_SCAN_INTERVAL_MS): boolean {
		if (this.timer !== undefined) return true;
		if (!resolveSettings(this.deps.settings).ready) return false;
		this.timer = setInterval(() => void this.scan(), intervalMs);
		this.timer.unref();
		return true;
	}

	/** Clear the timer. A scan in flight finishes; no new scan starts from the timer. */
	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One scan, queued behind any scan in flight. Never rejects: a failure is a `failed` result. */
	scan(): Promise<ObserverScan> {
		const run = this.queue.then(() => this.scanOnce().catch(failedScan));
		this.queue = run;
		return run;
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
			return { state: "observed", outcome: observed.outcome, heartbeat: await this.heartbeat(root, diff, ttlMs) };
		}
		// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
		// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
		if (diff !== null && diff.complete && changesIn(diff) > 0) {
			if (!repo.transient) this.baseline = { root, snapshot: next };
			return { state: "observed", outcome: "repo-unknown", heartbeat: await this.heartbeat(root, diff, ttlMs) };
		}
		this.baseline = { root, snapshot: next };
		const outcome: ObserverOutcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		return { state: "observed", outcome, heartbeat: { state: "not-due" } };
	}

	/** Heartbeats this checkout when the scan saw a complete change in it. The record's time is replaced by the server's clock. */
	private async heartbeat(root: string, diff: PlanningDiff | null, ttlMs: number): Promise<PlanningHeartbeat> {
		if (diff === null || !diff.complete || changesIn(diff) === 0) return { state: "not-due" };
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
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
