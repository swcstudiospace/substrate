/**
 * The planning observer (phase 52, SOTA-08; phase 53, SOTA-09): the server-side writer of the planning plane.
 *
 * On a timer (`SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, unref'd, started and stopped by the server entry) it scans the checkout's
 * `.planning/` with the incremental index, so a scan reads and hashes only the documents that changed. It diffs the scan
 * against its baseline and publishes a complete change as one `planning.changed` event, through the ledger and the bus
 * (`observePlanningChange`). Nothing else writes on a read: the reads never do.
 *
 * Heartbeat: a checkout heartbeats when this observer sees a complete change in it, and when its watcher gap opens or
 * closes. The heartbeat carries the checkout's planning report (`report.ts`), which is how every other session sees its
 * plan ids, and its touched pairs. The session is that checkout (`wt-<hash of its path>`), and its branch is read from its
 * HEAD. A scan that sees no change writes no heartbeat, so a session is listed as `active` for the freshness window after it
 * last changed a planning document, and `stale` after.
 *
 * Touched pairs: a complete change records the phase and plan of each document it added, changed or removed, dated by the
 * server clock. A pair stays while it is inside the presence TTL, so a later complete change to other documents keeps it.
 * An incomplete observation records nothing and drops nothing: the gap rule. A change that would take the list past
 * `MAX_REPORT_ENTRIES` is not cut, since a cut list claims absences. The report says `report-limit` until a complete
 * change fits again.
 *
 * Conflicts: after each scan that can read the server clock, the observer lists the presence snapshot, detects conflicts
 * (`conflicts.ts`) and announces each one that is not already open, once. A conflict that clears and returns is announced
 * again. A conflict the ledger did not store is retried on the next scan.
 *
 * The baseline is process-local. The first scan is a baseline and publishes nothing. A failed publish holds the baseline,
 * so the same change is published on the next scan. The index cache is separate: it always holds the latest scan.
 */
import type { EventInput } from "../types.ts";
import { branchOf, gitLayout, planningSessionId, repoOf, type RepoLookup } from "./checkout.ts";
import { conflictEvent, conflictSignature, detectConflicts } from "./conflicts.ts";
import type { PlanningConfigResult } from "./config.ts";
import { diffPlanningIndex, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { observePlanningChange } from "./events.ts";
import { buildPlanningIndex, errnoCode, indexRecords, isErrorRecord, snapshotOf, updatePlanningIndex, type PlanningFs, type PlanningIndex, type PlanningIndexFailure, type PlanningIndexResult } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, MAX_REPORT_ENTRIES, REPORT_ID_MAX, touchedWithin, type PlanningReport, type SessionRecord, type TouchedPair } from "./presence.ts";
import { observeScan, planIdentity, unknownReport, type WatcherGap } from "./report.ts";
import { readClock, resolveSettings } from "./read.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

/** The handle a scan timer returns. Opaque to the observer: it is only passed back to `clearInterval`. */
export type PlanningTimerHandle = unknown;

/** The timer the observer schedules its scans with. Production uses the global timers; a test injects one to see the cadence. */
export interface PlanningTimers {
	setInterval(run: () => void, ms: number): PlanningTimerHandle;
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

export type PlanningHeartbeat =
	| { state: "written" }
	/** The scan saw no complete change in this checkout and its watcher gap did not move, so there is nothing to heartbeat. */
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
	/** The scan timer. Omitted in production; a test injects one to see the cadence the observer schedules. */
	timers?: PlanningTimers;
}

/** The phase and plan of one described document. `plan` is null when the document names none. */
type PhasePlan = Pick<TouchedPair, "phase" | "plan">;

export class PlanningObserver {
	/** The index of the latest scan, which the next scan updates. Holds whatever the last scan found, even when a publish failed. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/**
	 * The baseline a diff is taken against: its snapshot, and the phase and plan of each of its documents by path. It moves
	 * forward, and holds when a publish fails.
	 */
	private baseline: { root: string; snapshot: PlanningSnapshot; phasePlans: ReadonlyMap<string, PhasePlan> } | null = null;
	/** This checkout's planning report from its latest scan, stamped by the server clock. It rides in the checkout's heartbeat. Null until one exists. */
	private report: PlanningReport | null = null;
	/** The watcher gap after the latest scan: a truncated or unlisted scan opens it, and a complete scan clears it. Process-local. */
	private gap: WatcherGap | null = null;
	/** This checkout's touched pairs inside the TTL, as its latest complete changes left them. Written on each heartbeat. Process-local. */
	private touched: TouchedPair[] = [];
	/** True while the latest complete change did not fit in `touched`. The report stays unknown (`report-limit`) until a change fits. */
	private touchedOverflow = false;
	/** The presence record has a change this process has not written yet: a complete change, a moved watcher gap, or a write that failed. Process-local. */
	private presencePending = false;
	/** The signature of the change whose publish is held. Its next sighting is a retry, and renews nothing. Null when no publish is held. Process-local. */
	private heldChange: string | null = null;
	/** The report the last successful heartbeat wrote. A change of view (known, or the reason it is unknown) must reach the record. Null until one is written. */
	private written: PlanningReport | null = null;
	/** Conflicts announced and still open, by signature. A conflict leaves the set once it is no longer detected. Process-local. */
	private openConflicts = new Set<string>();
	private timer: PlanningTimerHandle | undefined;
	/** Scans run one at a time, in arrival order, so two scans never publish the same change. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Scans queued or running. A timer tick that finds one starts none. Process-local. */
	private queued = 0;

	private readonly timers: PlanningTimers;

	constructor(private readonly deps: PlanningObserverDeps) {
		this.timers = deps.timers ?? GLOBAL_TIMERS;
	}

	/** Start the scan timer at the configured cadence, unref'd. Nothing starts while the plane is disabled or misconfigured. Returns whether it is running. */
	start(): boolean {
		if (this.timer !== undefined) return true;
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return false;
		this.timer = this.timers.setInterval(() => this.tick(), resolved.limits.scanIntervalMs);
		return true;
	}

	/** Clear the timer. A scan in flight finishes; no new scan starts from the timer. */
	stop(): void {
		this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * A timer tick. A tick that finds a scan still queued or running starts none: a slow listing then delays the next scan
	 * instead of piling scans up behind it.
	 */
	private tick(): void {
		if (this.queued > 0) return;
		void this.scan();
	}

	/** One scan, queued behind any scan in flight. Never rejects: a failure is a `failed` result. */
	scan(): Promise<ObserverScan> {
		this.queued += 1;
		const run = this.queue.then(() => this.scanOnce().catch(failedScan)).finally(() => {
			this.queued -= 1;
		});
		this.queue = run;
		return run;
	}

	private async scanOnce(): Promise<ObserverScan> {
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return { state: "disabled" };
		const { root, limits } = resolved;
		const ttlMs = limits.presenceTtlS * 1000;
		const fsDeps = { fs: this.deps.fs, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } };
		const cached = this.index !== null && this.index.root === root ? this.index.index : null;
		const built = cached === null ? await buildPlanningIndex(root, fsDeps) : await updatePlanningIndex(root, fsDeps, cached);
		const clock = this.deps.presence === null ? null : await readClock(this.deps.presence);
		const nowMs = clock !== null && clock.ok ? clock.nowMs : null;
		const gapMoved = nowMs !== null ? this.stampReport(built, nowMs) : false;
		const repo = await repoOf(this.deps.fs, root);
		if (!built.ok) {
			await this.heartbeat(root, false, ttlMs, repo);
			return { state: "unavailable", code: built.code };
		}
		this.index = { root, index: built.index };

		const next = snapshotOf(built.index);
		const nextPhasePlans = phasePlansOf(built.index);
		const priorBaseline = this.baseline !== null && this.baseline.root === root ? this.baseline : null;
		const previous = priorBaseline?.snapshot ?? null;
		const diff = previous === null ? null : diffPlanningIndex(previous, next);
		const changed = diff !== null && diff.complete && changesIn(diff) > 0;
		// The same change seen again while its publish is held is a retry, not a new edit: it keeps the time it was first seen.
		const signature = diff !== null && changed ? JSON.stringify([diff.added, diff.removed, diff.changed]) : null;
		const retry = signature !== null && signature === this.heldChange;
		if (diff !== null && changed && nowMs !== null && !retry) this.touch(pairsOfChange(diff, nextPhasePlans, priorBaseline?.phasePlans), nowMs, ttlMs);
		if (this.touchedOverflow && nowMs !== null) this.report = unknownReport(nowMs, "report-limit");

		// A baseline that holds (a failed publish) keeps its own phase and plan map, so a removal is still read from what was there.
		const phasePlansFor = (snapshot: PlanningSnapshot): ReadonlyMap<string, PhasePlan> =>
			snapshot === previous && priorBaseline !== null ? priorBaseline.phasePlans : nextPhasePlans;
		let outcome: ObserverOutcome;
		let holds = false;
		if (repo.state === "known") {
			const observed = await observePlanningChange({
				previous,
				next,
				repo: repo.repo,
				sessionId: PLANNING_OBSERVER_SESSION,
				publisher: { publish: this.deps.emit },
			});
			this.baseline = { root, snapshot: observed.baseline, phasePlans: phasePlansFor(observed.baseline) };
			outcome = observed.outcome;
			holds = observed.outcome === "not-published";
		} else if (changed) {
			// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
			// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
			holds = repo.transient;
			if (!repo.transient) this.baseline = { root, snapshot: next, phasePlans: nextPhasePlans };
			outcome = "repo-unknown";
		} else {
			this.baseline = { root, snapshot: next, phasePlans: nextPhasePlans };
			outcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		}
		this.heldChange = holds ? signature : null;
		const heartbeat = await this.heartbeat(root, changed || gapMoved, ttlMs, repo);
		if (nowMs !== null) await this.announce(repo, nowMs, ttlMs);
		return { state: "observed", outcome, heartbeat };
	}

	/**
	 * Stamps this checkout's report from its scan and moves the watcher gap. Returns whether the gap moved: a gap that opens or
	 * closes is a change the presence record must carry. A failed scan proves nothing, so it keeps the gap it had.
	 */
	private stampReport(built: PlanningIndexResult, nowMs: number): boolean {
		const observed = observeScan(built, nowMs, this.gap);
		const moved = observed.gap !== this.gap;
		this.report = observed.report;
		this.gap = observed.gap;
		return moved;
	}

	/**
	 * Folds one complete change into the touched pairs, dated by the server clock. A pair the change touches replaces its older
	 * entry, and the others stay while they are inside the TTL. A list past `MAX_REPORT_ENTRIES` is not kept: the pairs stay as
	 * they were, pruned, and the overflow flag holds the report unknown until a complete change fits.
	 */
	private touch(pairs: readonly PhasePlan[], nowMs: number, ttlMs: number): void {
		const fresh = new Map<string, TouchedPair>();
		for (const pair of pairs) fresh.set(touchKey(pair), { phase: pair.phase, plan: pair.plan, observedAtMs: nowMs });
		const kept = touchedWithin(this.touched, nowMs, ttlMs).filter((pair) => !fresh.has(touchKey(pair)));
		const merged = [...fresh.values(), ...kept];
		this.touchedOverflow = merged.length > MAX_REPORT_ENTRIES;
		this.touched = this.touchedOverflow ? touchedWithin(this.touched, nowMs, ttlMs) : merged;
	}

	/** Heartbeats this checkout when a change is pending, the scan's `due` says one is. The record's time is replaced by the server's clock, and the record carries the report and the touched pairs. */
	private async heartbeat(root: string, due: boolean, ttlMs: number, repo: RepoLookup): Promise<PlanningHeartbeat> {
		if (due) this.presencePending = true;
		if (this.report !== null && this.written !== null && reportViewOf(this.report) !== reportViewOf(this.written)) this.presencePending = true;
		if (!this.presencePending) return { state: "not-due" };
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
		try {
			const layout = await gitLayout(this.deps.fs, root);
			if (!layout.ok) return { state: "failed", detail: layout.reason };
			const record: SessionRecord = {
				sessionId: planningSessionId(this.deps.fs, root),
				worktree: root,
				branch: await branchOf(this.deps.fs, layout.gitDir),
				lastHeartbeatMs: 0,
				repo: repo.state === "known" ? repo.repo : null,
				touched: this.touched,
				...(this.report === null ? {} : { planning: this.report }),
			};
			await presence.touch(record, ttlMs);
			this.presencePending = false;
			this.written = this.report;
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: errnoCode(cause) };
		}
	}

	/**
	 * Announces each conflict that is not already open, once. A conflict that is no longer detected leaves the open set, so its
	 * return is announced again. A conflict the ledger did not store stays out of the set, so the next scan tries again.
	 */
	private async announce(repo: RepoLookup, nowMs: number, ttlMs: number): Promise<void> {
		const presence = this.deps.presence;
		if (presence === null) return;
		const listing = await presence.listWithin(PRESENCE_MAX_SESSIONS).catch(() => null);
		if (listing === null) return;
		const detected = detectConflicts({ sessions: classifySessions(listing.records, nowMs, ttlMs), nowMs, ttlMs });
		const repoName = repo.state === "known" ? repo.repo : null;
		const next = new Set<string>();
		for (const conflict of detected.conflicts) {
			if (conflict.repo !== repoName) continue;
			const signature = conflictSignature(conflict);
			if (this.openConflicts.has(signature)) {
				next.add(signature);
				continue;
			}
			let stored = false;
			try {
				stored = await this.deps.emit(conflictEvent(conflict));
			} catch {
				stored = false;
			}
			if (stored) next.add(signature);
		}
		this.openConflicts = next;
	}
}

/** What a reader of a report sees: known, or the reason it is unknown. A new scan time alone is not a change of view. */
function reportViewOf(report: PlanningReport): string {
	if (report.status === "known") return "known";
	return `unknown:${report.reason}`;
}

/** The number of paths a complete diff changes. A removal is counted only when the diff vouches for removals. */
function changesIn(diff: PlanningDiff): number {
	return diff.added.length + (diff.removed?.length ?? 0) + diff.changed.length;
}

/**
 * The phase and plan of each described document in an index, by path. An error record and a document with no phase have no
 * entry. A pair whose id the presence schema cannot carry has none either: the report of such an index is unknown
 * (`report-limit`), since `report.ts` checks the same ids.
 */
function phasePlansOf(index: PlanningIndex): ReadonlyMap<string, PhasePlan> {
	const plans = new Map<string, PhasePlan>();
	for (const record of indexRecords(index)) {
		if (isErrorRecord(record) || record.phase === undefined || record.phase === "") continue;
		const plan = planIdentity(record) ?? null;
		if (record.phase.length > REPORT_ID_MAX || (plan !== null && plan.length > REPORT_ID_MAX)) continue;
		plans.set(record.path, { phase: record.phase, plan });
	}
	return plans;
}

/**
 * The phase and plan of each document a complete change added or changed (read from the new index) or removed (read from the
 * baseline it left).
 */
function pairsOfChange(diff: PlanningDiff, next: ReadonlyMap<string, PhasePlan>, previous: ReadonlyMap<string, PhasePlan> | undefined): PhasePlan[] {
	const pairs: PhasePlan[] = [];
	for (const change of [...diff.added, ...diff.changed]) {
		const pair = next.get(change.path);
		if (pair !== undefined) pairs.push(pair);
	}
	for (const change of diff.removed ?? []) {
		const pair = previous?.get(change.path);
		if (pair !== undefined) pairs.push(pair);
	}
	return pairs;
}

function touchKey(pair: PhasePlan): string {
	return JSON.stringify([pair.phase, pair.plan]);
}

/** A scan that threw. Only the error's code is kept: its message can carry host paths. */
function failedScan(cause: unknown): ObserverScan {
	return { state: "failed", detail: errnoCode(cause) };
}
