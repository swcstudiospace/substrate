/**
 * The planning observer (phase 52, SOTA-08; phase 53, SOTA-09): the server-side writer of the planning plane.
 *
 * On a timer (`SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, unref'd, started and stopped by the server entry) it scans the checkout's
 * `.planning/` with the incremental index, so a scan reads and hashes only the documents that changed. It diffs the scan
 * against its baseline and publishes a complete change as one `planning.changed` event, through the ledger and the bus
 * (`observePlanningChange`). Nothing else writes on a read: the reads never do.
 *
 * Heartbeat: a checkout heartbeats in a scan that sees a complete change: a change the baseline has not published yet, or a
 * change since the scan before. It also heartbeats when its watcher gap moves, when its report's view changes, and when a
 * previous write failed, until the write lands or its observation leaves the freshness window. A change the ledger does not store is heartbeated once, in the scan that saw it; the scans after it
 * are quiet, so the session goes `stale` after the freshness window. The session is that checkout (`wt-<hash of its path>`),
 * and its branch is read from its HEAD. The heartbeat carries the checkout's planning report (`report.ts`), which is how
 * every other session sees its plan ids, its touched pairs and its repository.
 *
 * Touched pairs: a complete change records the phase and plan of each document it added, changed or removed, dated by the
 * server clock. A pair stays while it is inside the presence TTL, so a later complete change to other documents keeps it.
 * A change that is still held by a failed publish keeps the time it was first seen, so a retry never renews it. An incomplete
 * observation records nothing and drops nothing: the gap rule. A change that would take the list past `MAX_REPORT_ENTRIES` is
 * not cut, since a cut list claims absences. The report stays `report-limit` until the claims that did not fit have left the
 * freshness window, which the overflowing change's observation time dates.
 *
 * Conflicts: after each scan that can read the server clock, the observer lists the presence snapshot and detects conflicts
 * within one repository (`conflicts.ts`). Every observer reads the same snapshot, so the smallest session of a conflict alone
 * announces it, once, when it is not already open. A conflict that clears and returns is announced again. A conflict the ledger
 * did not store is retried on the next scan.
 *
 * Scans never overlap: a tick that arrives during a scan shares that scan rather than starting another. A failure is reported
 * on stderr when it appears or changes, and once more when the scans succeed again. Shutdown waits for a scan in flight.
 *
 * The baseline is process-local. The first scan is a baseline and publishes nothing. A failed publish holds the baseline,
 * so the same change is published on the next scan. The index cache is separate: it always holds the latest scan.
 */
import type { EventInput } from "../types.ts";
import { branchOf, gitLayout, planningSessionId, repoOf, type RepoLookup } from "./checkout.ts";
import { conflictEvent, conflictSignature, detectConflicts, repoKey } from "./conflicts.ts";
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
	/** The scan saw no complete change in this checkout since the scan before, and nothing else is pending, so there is nothing to heartbeat. */
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
	/** Where a failure is reported. Omitted in production, where it goes to stderr; a test injects one to read the lines. */
	report?: (line: string) => void;
}

/** The phase and plan of one described document. `plan` is null when the document names none. */
type PhasePlan = Pick<TouchedPair, "phase" | "plan">;

export class PlanningObserver {
	/** The index of the latest scan, which the next scan updates. Holds whatever the last scan found, even when a publish failed. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/** The latest scan's snapshot. A heartbeat reports the change since it, so it moves with every scan. */
	private lastScan: { root: string; snapshot: PlanningSnapshot } | null = null;
	/** The publish baseline: what the ledger has been told. It holds when a publish fails, so the change is retried. */
	private baseline: { root: string; snapshot: PlanningSnapshot } | null = null;
	/**
	 * The last complete snapshot whose change was claimed: a touched pair is taken against it. It moves on a claim and on a
	 * complete scan with no change. It holds on an incomplete scan and while the clock is unreadable, so a change observed then
	 * is claimed on a readable scan. A retry of a held publish finds no new change, so it never renews a touched time. Process-local.
	 */
	private touchBase: { root: string; snapshot: PlanningSnapshot; phasePlans: ReadonlyMap<string, PhasePlan> } | null = null;
	/** This checkout's planning report from its latest scan, stamped by the server clock. It rides in the checkout's heartbeat. Null until one exists. */
	private report: PlanningReport | null = null;
	/** The watcher gap after the latest scan: a truncated or unlisted scan opens it, and a complete scan clears it. Process-local. */
	private gap: WatcherGap | null = null;
	/** This checkout's touched pairs inside the TTL, as its latest complete changes left them. Written on each heartbeat. Process-local. */
	private touched: TouchedPair[] = [];
	/** True while the claims a complete change could not keep in `touched` are inside the freshness window. The report stays unknown (`report-limit`) until they have left it. */
	private touchedOverflow = false;
	/** When the change that overflowed `touched` was observed, by the server clock; null when none has. The overflow holds while that time is inside the TTL. Process-local. */
	private overflowAtMs: number | null = null;
	/** The presence record has a change this process has not written yet: a change, a moved watcher gap, a changed view, or a write that failed. Process-local. */
	private presencePending = false;
	/** When the observation that armed the pending write was made, by the server clock. Null when that clock was unreadable (`pendingUndated`) or nothing is pending. Process-local. */
	private pendingSinceMs: number | null = null;
	/** True when the pending write was armed in a scan whose clock was unreadable: its observation has no time, so it is dropped unwritten once retained. Process-local. */
	private pendingUndated = false;
	/** The report the last successful heartbeat wrote: undefined until one is written, null when it wrote none. A change of view (known, unknown, or none) must reach the record. */
	private written: PlanningReport | null | undefined = undefined;
	/** The repository the last successful heartbeat wrote; undefined until one is written. A different repository now is a change the record must carry. */
	private writtenRepo: string | null | undefined = undefined;
	/** Conflicts announced and still open, by signature. A conflict leaves the set once it is no longer detected. Process-local. */
	private openConflicts = new Set<string>();
	private timer: PlanningTimerHandle | undefined;
	/** The scan in flight, or null. A scan asked for while one runs shares it. */
	private running: Promise<ObserverScan> | null = null;
	/** The problem last reported, or null while the scans are healthy. A report fires only when the problem changes. */
	private problem: string | null = null;
	private readonly timers: PlanningTimers;
	private readonly reporter: (line: string) => void;

	constructor(private readonly deps: PlanningObserverDeps) {
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.reporter = deps.report ?? STDERR_REPORT;
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
		if (problem !== null) this.reporter(`[substrate] planning observer: ${problem}`);
		else if (before !== null) this.reporter("[substrate] planning observer: scans succeed again");
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
		const gapMoved = nowMs !== null ? this.stampReport(built, nowMs) : this.withdrawReport();
		const repo = await repoOf(this.deps.fs, root);
		if (!built.ok) {
			await this.heartbeat(root, false, ttlMs, repo, nowMs);
			return { state: "unavailable", code: built.code };
		}
		this.index = { root, index: built.index };

		const next = snapshotOf(built.index);
		// The change since the scan before: a heartbeat reports it, so a change is heartbeated once, in the scan that sees it.
		const sinceLastScan = this.lastScan !== null && this.lastScan.root === root ? diffPlanningIndex(this.lastScan.snapshot, next) : null;
		this.lastScan = { root, snapshot: next };
		this.claimTouches(root, next, phasePlansOf(built.index), nowMs, ttlMs);
		// The overflow holds while the claims it could not keep are inside the freshness window of the change that overflowed.
		if (nowMs !== null) {
			this.touchedOverflow = this.overflowAtMs !== null && nowMs - this.overflowAtMs <= ttlMs;
			if (!this.touchedOverflow) this.overflowAtMs = null;
		}
		if (this.touchedOverflow && nowMs !== null) this.report = unknownReport(nowMs, "report-limit");

		const previous = this.baseline !== null && this.baseline.root === root ? this.baseline.snapshot : null;
		const diff = previous === null ? null : diffPlanningIndex(previous, next);
		const changed = diff !== null && diff.complete && changesIn(diff) > 0;
		let outcome: ObserverOutcome;
		if (repo.state === "known") {
			const observed = await observePlanningChange({
				previous,
				next,
				repo: repo.repo,
				sessionId: PLANNING_OBSERVER_SESSION,
				publisher: { publish: this.deps.emit },
			});
			this.baseline = { root, snapshot: observed.baseline };
			outcome = observed.outcome;
		} else if (changed) {
			// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
			// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
			if (!repo.transient) this.baseline = { root, snapshot: next };
			outcome = "repo-unknown";
		} else {
			this.baseline = { root, snapshot: next };
			outcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		}
		const sinceChange = sinceLastScan !== null && sinceLastScan.complete && changesIn(sinceLastScan) > 0;
		const heartbeat = await this.heartbeat(root, sinceChange || gapMoved, ttlMs, repo, nowMs);
		await this.announce(root, repo, ttlMs);
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
	 * Withdraws this checkout's report when the server clock cannot stamp a scan. The held report was stamped by an earlier clock
	 * reading, so keeping it would let a later write present that old view as current. Without a report the session reads as
	 * `no-scan`, which is unknown. Returns whether a report was held: its withdrawal is a change the record must carry.
	 */
	private withdrawReport(): boolean {
		const held = this.report !== null;
		this.report = null;
		return held;
	}

	/**
	 * Claims the change since the last complete snapshot (`touchBase`): its pairs are folded into the touched list, dated by the
	 * server clock. A complete change observed while the clock is unreadable is not claimed, since its time is unknown, and
	 * `touchBase` still advances past it, so recovery never presents it as active. An incomplete observation claims nothing and
	 * holds `touchBase`. The first complete scan of a root sets it, and a complete scan with no change moves it.
	 */
	private claimTouches(root: string, next: PlanningSnapshot, nextPhasePlans: ReadonlyMap<string, PhasePlan>, nowMs: number | null, ttlMs: number): void {
		const base = this.touchBase !== null && this.touchBase.root === root ? this.touchBase : null;
		if (base === null) {
			// Only a complete snapshot may be a touch baseline: an incomplete one would make every later diff incomplete, and never move.
			if (!next.truncated && next.unlisted.length === 0) this.touchBase = { root, snapshot: next, phasePlans: nextPhasePlans };
			return;
		}
		const diff = diffPlanningIndex(base.snapshot, next);
		if (!diff.complete) return;
		// An undated change is not claimed: its time is unknown, so claiming it at recovery would show a stale edit as active.
		if (changesIn(diff) > 0 && nowMs !== null) this.touch(pairsOfChange(diff, nextPhasePlans, base.phasePlans), nowMs, ttlMs);
		this.touchBase = { root, snapshot: next, phasePlans: nextPhasePlans };
	}

	/**
	 * Folds one complete change into the touched pairs, dated by the server clock. A pair the change touches replaces its older
	 * entry, and the others stay while they are inside the TTL. A list past `MAX_REPORT_ENTRIES` is not kept: the pairs stay as
	 * they were, pruned, and the overflow holds the report unknown until the claims that did not fit have left the freshness
	 * window, dated by the overflowing change.
	 */
	private touch(pairs: readonly PhasePlan[], nowMs: number, ttlMs: number): void {
		const fresh = new Map<string, TouchedPair>();
		for (const pair of pairs) fresh.set(touchKey(pair), { phase: pair.phase, plan: pair.plan, observedAtMs: nowMs });
		const kept = touchedWithin(this.touched, nowMs, ttlMs).filter((pair) => !fresh.has(touchKey(pair)));
		const merged = [...fresh.values(), ...kept];
		if (merged.length > MAX_REPORT_ENTRIES) {
			this.overflowAtMs = nowMs;
			this.touched = touchedWithin(this.touched, nowMs, ttlMs);
		} else {
			this.touched = merged;
		}
	}

	/**
	 * Heartbeats this checkout when `due`, or when a write is still pending. The record's time is replaced by the server's clock,
	 * and the record carries the repository, the report and the touched pairs. The pending write follows these rules:
	 * R1: a write armed this scan (a due observation, or a view or repo change that newly arms it) is attempted at once. Its
	 *     observation time is `nowMs`, which may be null: a null time makes the write undated.
	 * R2: a retained write (pending from an earlier scan) is held while `nowMs` is null: the result is failed with `clock-unavailable`.
	 * R3: a retained undated write is dropped unwritten, so it is never written as active.
	 * R4: a retained write older than the freshness window (`nowMs - pendingSinceMs > ttlMs`) is dropped unwritten. Exactly `ttlMs` is still written.
	 * R5: a successful write clears the debt. A failed write keeps it, with its observation time.
	 */
	private async heartbeat(root: string, due: boolean, ttlMs: number, repo: RepoLookup, nowMs: number | null): Promise<PlanningHeartbeat> {
		const currentRepo = repo.state === "known" ? repo.repo : null;
		const viewChanged = this.written !== undefined && reportViewOf(this.report) !== reportViewOf(this.written);
		const repoChanged = this.writtenRepo !== undefined && this.writtenRepo !== currentRepo;
		// A view or repo change arms the write only when it first arms, so re-arming on every scan cannot keep a dead write alive.
		const armed = due || (!this.presencePending && (viewChanged || repoChanged));
		if (armed) {
			this.presencePending = true;
			this.pendingSinceMs = nowMs;
			this.pendingUndated = nowMs === null;
		} else if (!this.presencePending) {
			return { state: "not-due" };
		}
		const presence = this.deps.presence;
		if (presence === null) {
			this.clearPending();
			return { state: "presence-unset" };
		}
		if (!armed) {
			// A retained write is aged against this scan's clock. While the clock is unreadable its age cannot be checked, so it is held.
			if (nowMs === null) return { state: "failed", detail: "clock-unavailable" };
			if (this.pendingUndated || (this.pendingSinceMs !== null && nowMs - this.pendingSinceMs > ttlMs)) {
				// The observation has no time, or has left the window: writing now would show the checkout active on a quiet
				// observation. The view and repo are acknowledged, so the next scan does not re-arm them.
				this.clearPending();
				this.written = this.report;
				this.writtenRepo = currentRepo;
				return { state: "not-due" };
			}
		}
		const result = await this.touchCheckout(root, presence, currentRepo, ttlMs);
		if (result.state === "written") {
			this.clearPending();
			this.written = this.report;
			this.writtenRepo = currentRepo;
		}
		return result;
	}

	/** Clears the pending write: it was written, or it is dropped unwritten. */
	private clearPending(): void {
		this.presencePending = false;
		this.pendingSinceMs = null;
		this.pendingUndated = false;
	}

	/** Writes the checkout's session record. The result is written, or failed with an error code: never a message, which can carry host paths. */
	private async touchCheckout(root: string, presence: DragonflyPresenceStore, currentRepo: string | null, ttlMs: number): Promise<PlanningHeartbeat> {
		try {
			const layout = await gitLayout(this.deps.fs, root);
			if (!layout.ok) return { state: "failed", detail: layout.reason };
			const record: SessionRecord = {
				sessionId: planningSessionId(this.deps.fs, root),
				worktree: root,
				branch: await branchOf(this.deps.fs, layout.gitDir),
				activePhase: null,
				lastHeartbeatMs: 0,
				repo: currentRepo,
				touched: this.touched,
				...(this.report === null ? {} : { planning: this.report }),
			};
			await presence.touch(record, ttlMs);
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: errnoCode(cause) };
		}
	}

	/**
	 * Announces each conflict of this checkout's repository that is not already open, once, when this checkout is the
	 * conflict's announcer: the session with the smallest id among its sessions. Every observer reads the same snapshot, so
	 * exactly one of them announces a conflict, with no coordination. A conflict that is no longer detected leaves the open
	 * set, so its return is announced again. A conflict the ledger did not store stays out of the set, so the next scan tries
	 * again.
	 */
	private async announce(root: string, repo: RepoLookup, ttlMs: number): Promise<void> {
		const presence = this.deps.presence;
		if (presence === null) return;
		const sessionId = planningSessionId(this.deps.fs, root);
		const listing = await presence.listWithin(PRESENCE_MAX_SESSIONS).catch(() => null);
		if (listing === null) return;
		// The clock is read after the listing, which takes time: a peer that passed its freshness window while the scan ran is expired.
		const clock = await readClock(presence);
		if (!clock.ok) return;
		const detected = detectConflicts({ sessions: classifySessions(listing.records, clock.nowMs, ttlMs), nowMs: clock.nowMs, ttlMs });
		const repoName = repo.state === "known" ? repo.repo : null;
		const next = new Set<string>();
		for (const conflict of detected.conflicts) {
			if (repoName === null || repoKey(conflict.repo) !== repoKey(repoName)) continue;
			// The announcer is the smallest session of the conflict (`sessionIds` is sorted). Known limit: when that session has
			// no running observer, no observer announces the conflict. This is accepted, and it is recorded in the PR body.
			if (conflict.sessionIds[0] !== sessionId) continue;
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
		// A truncated listing may omit sessions that hold an open conflict: those stay open rather than leave the set and be announced again.
		if (listing.truncated) for (const signature of this.openConflicts) next.add(signature);
		this.openConflicts = next;
	}
}

/** What a reader of a report sees: known, the reason it is unknown, or none. A new scan time alone is not a change of view. */
function reportViewOf(report: PlanningReport | null): string {
	if (report === null) return "none";
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
 * touch baseline it left).
 */
function pairsOfChange(diff: PlanningDiff, next: ReadonlyMap<string, PhasePlan>, previous: ReadonlyMap<string, PhasePlan>): PhasePlan[] {
	const pairs: PhasePlan[] = [];
	for (const change of [...diff.added, ...diff.changed]) {
		const pair = next.get(change.path);
		if (pair !== undefined) pairs.push(pair);
	}
	for (const change of diff.removed ?? []) {
		const pair = previous.get(change.path);
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
