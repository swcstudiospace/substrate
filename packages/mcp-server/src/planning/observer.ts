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
 * within one repository (`conflicts.ts`). A conflict is announced once, when it is not already open; a conflict that clears and
 * returns is announced again; a conflict the ledger did not store is retried on the next scan. Who announces depends on whether the
 * ledger deduplicates keyed events (`dedup`, from `SUBSTRATE_EVENT_IDEMPOTENCY`). With it, every observer of the repository writes
 * the warning under one key and one `ts` derived from the conflict (`conflictEvent`), so the ledger keeps one row however many
 * observers run, and a conflict is announced even when its smallest session has no observer. Without it (the default), every
 * observer reads the same snapshot, so the smallest session of a conflict alone announces it; when that session has no running
 * observer no observer announces the conflict.
 *
 * Scans never overlap: a tick that arrives during a scan shares that scan rather than starting another. A failure is reported
 * on stderr when it appears or changes, and once more when the scans succeed again. Shutdown waits for a scan in flight.
 *
 * Transitions (phase 54): each scan that moves the plane's view from one session state to another writes one
 * `planning.transition` record through `metrics`, with the stdout line as its fallback. The record is handed to its sinks
 * without being awaited, so a slow metric write does not delay the scan. The scan is the write cadence: a transition is
 * recorded where a scan detects it, and a read never records one. A baseline taken from the baseline store keeps no state, so
 * the first change published against it is recorded as a move from the state that scan saw to itself.
 *
 * The baseline is the ledger's view of the checkout: what it was last told. A failed publish holds it, so the same change is
 * published on the next scan. With a baseline store (`baseline-store.ts`) the observer takes the stored baseline on its first
 * scan and saves the baseline in the background after a change (throttled, retried while a save fails, never on a scan's
 * critical path), so a restart publishes what changed while it was down. With no store, or no usable stored baseline, the
 * first scan in a process is a baseline and publishes nothing. The index cache is separate: it always holds the latest scan.
 *
 * Liveness (phase 58): a session is alive, not only changing. With `deps.liveness` set, a scan that read the checkout refreshes
 * the presence record without moving its change time (`livenessBeat`), so a session quiet for days stays active while the
 * observer runs and its `idleForMs` grows. Dragonfly holds only this ephemeral record: the baseline never goes there. The beat
 * also runs on its own timer (`livenessPeriodMs`, at most a third of the freshness window), independent of the scan interval.
 */
import type { EventInput } from "../types.ts";
import { BaselineStoreError, type BaselineLoad, type BaselineStore, type StoredBaseline } from "./baseline-store.ts";
import { branchOf, gitLayout, planningSessionId, repoOf, type OriginUrlRunner, type RepoLookup } from "./checkout.ts";
import { conflictEvent, conflictOriginMs, conflictSignature, detectConflicts, repoKey } from "./conflicts.ts";
import type { PlanningConfigError, PlanningConfigResult } from "./config.ts";
import { diffPlanningIndex, type PathChange, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { observePlanningChange } from "./events.ts";
import { buildPlanningIndex, errnoCode, indexRecords, isErrorRecord, snapshotOf, updatePlanningIndex, type PlanningFs, type PlanningIndex, type PlanningIndexFailure, type PlanningIndexResult } from "./index.ts";
import { type DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, MAX_REPORT_ENTRIES, REPORT_ID_MAX, touchedWithin, type PlanningReport, type SessionRecord, type TouchedPair } from "./presence.ts";
import { observeScan, planIdentity, unknownReport, type WatcherGap } from "./report.ts";
import { readClock, resolveSettings } from "./read.ts";
import type { SessionState } from "./states.ts";
import { emitTransition, stdoutMetricSink, transitionRecord, type MetricSink, type TransitionClock, type TransitionOutcome, type TransitionRecord } from "./telemetry.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

/** The phase id a planning transition is recorded under: the planning plane's view, which spans every phase document. */
export const PLANNING_TRANSITION_PHASE = "planning";

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

/** Most transition deliveries in flight at once. Past it a record goes straight to the stdout fallback, so the set stays bounded. */
export const MAX_PENDING_TRANSITIONS = 64;

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

/** What one scan did about the checkout's liveness. Present only when the liveness heartbeat is configured. `covered`: this scan's change heartbeat was the sign of life. */
export type PlanningLiveness =
	| { state: "written" }
	| { state: "covered" }
	| { state: "not-due" }
	| { state: "presence-unset" }
	| { state: "failed"; detail: string };

/** What one scan did with the change it saw. `repo-unknown` is a change that cannot be attributed to a repo, so it is not published. */
export type ObserverOutcome = "baseline" | "unchanged" | "incomplete" | "published" | "not-published" | "repo-unknown";

export type ObserverScan =
	| { state: "disabled" }
	| { state: "unavailable"; code: PlanningIndexFailure }
	| { state: "failed"; detail: string }
	| { state: "observed"; outcome: ObserverOutcome; heartbeat: PlanningHeartbeat; liveness?: PlanningLiveness };

export interface PlanningObserverDeps {
	settings: PlanningConfigResult;
	fs: PlanningFs;
	/** Null when the cache endpoint is unset or refused by the endpoint policy. */
	presence: DragonflyPresenceStore | null;
	/** The ledger ingest (`Substrate.emit`). Resolves true when the event was stored. */
	emit: (event: EventInput) => Promise<boolean>;
	/** The primary sink for `planning.transition` records: the metrics writer when the ledger is configured, else stdout. */
	metrics: MetricSink;
	/** Written once when `metrics` does not deliver. Default: one JSON line on stdout. */
	fallback?: MetricSink;
	/** The record's clock. Default: the host clock, which stamps a record and classifies nothing. */
	clock?: TransitionClock;
	/**
	 * True when the ledger deduplicates a keyed event (`SUBSTRATE_EVENT_IDEMPOTENCY` is `accept` or `enforce`, and `emit` asks for
	 * the lookup). Every observer then announces each conflict under its deterministic key; otherwise the smallest session alone does.
	 */
	dedup?: boolean;
	/** The scan timer. Omitted in production; a test injects one to see the cadence the observer schedules. */
	timers?: PlanningTimers;
	/** Where a failure is reported. Omitted in production, where it goes to stderr; a test injects one to read the lines. */
	report?: (line: string) => void;
	/** The durable baseline store. Null or omitted keeps the baseline in memory, as before: the first scan of a process is a baseline. */
	baselines?: BaselineStore | null;
	/** The host clock the baseline-save throttle reads, in milliseconds. Omitted in production (`Date.now`); a test injects one. */
	now?: () => number;
	/** The least time between baseline saves, in milliseconds. Omitted: `DEFAULT_BASELINE_SAVE_INTERVAL_MS`. */
	baselineSaveIntervalMs?: number;
	/** The liveness heartbeat. Null or omitted writes none: a quiet checkout reads stale after the freshness window, as before. */
	liveness?: LivenessSettings | null;
	/** How the checkout's origin URL is asked of git. Omitted in production, where it is `git config --get remote.origin.url`. */
	originUrl?: OriginUrlRunner;
}

/** Where the observer's liveness heartbeat is configured: how often a quiet checkout refreshes its record. Read by `loadLivenessSettings`. */
export const PLANNING_LIVENESS_INTERVAL_ENV = "SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS";
/** 0 refreshes the record on every scan. */
export const DEFAULT_LIVENESS_INTERVAL_MS = 0;
/** Inclusive bounds. Outside them the value is refused, not clamped. */
export const LIVENESS_INTERVAL_BOUNDS = { min: 0, max: 3_600_000 } as const;

/** The least time between baseline saves when `deps.baselineSaveIntervalMs` is omitted. */
export const DEFAULT_BASELINE_SAVE_INTERVAL_MS = 5_000;

export interface LivenessSettings {
	/** The least time between liveness writes, in milliseconds. It never exceeds a third of the freshness window. */
	intervalMs: number;
}

export type LivenessConfigResult = { ok: true; settings: LivenessSettings } | { ok: false; errors: PlanningConfigError[] };

/** Parse the liveness settings from an environment map. A value that is set but not a plain integer in range is an error; it is never echoed. */
export function loadLivenessSettings(env: Readonly<Record<string, string | undefined>>): LivenessConfigResult {
	const raw = env[PLANNING_LIVENESS_INTERVAL_ENV];
	if (raw === undefined) return { ok: true, settings: { intervalMs: DEFAULT_LIVENESS_INTERVAL_MS } };
	if (!/^[0-9]+$/.test(raw)) return { ok: false, errors: [{ key: PLANNING_LIVENESS_INTERVAL_ENV, reason: "not-integer" }] };
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < LIVENESS_INTERVAL_BOUNDS.min || value > LIVENESS_INTERVAL_BOUNDS.max) {
		return { ok: false, errors: [{ key: PLANNING_LIVENESS_INTERVAL_ENV, reason: "out-of-range", min: LIVENESS_INTERVAL_BOUNDS.min, max: LIVENESS_INTERVAL_BOUNDS.max }] };
	}
	return { ok: true, settings: { intervalMs: value } };
}

/** The phase and plan of one described document. `plan` is null when the document names none. */
type PhasePlan = Pick<TouchedPair, "phase" | "plan">;

export class PlanningObserver {
	/** The index of the latest scan, which the next scan updates. Holds whatever the last scan found, even when a publish failed. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/** The latest scan's snapshot and state. A heartbeat reports the change since it, so it moves with every scan. */
	private lastScan: { root: string; snapshot: PlanningSnapshot; state: SessionState } | null = null;
	/** The publish baseline: what the ledger has been told. It holds when a publish fails, so the change is retried. */
	private baseline: StoredBaseline | null = null;
	/** The session state the plane was in when `baseline` was taken. Null for a baseline restored from the store, which keeps no state. */
	private baselineState: SessionState | null = null;
	/** The identity of the held change whose transition is already recorded, so a later scan of that change records nothing. */
	private recordedHold: string | null = null;
	/** Scheduled transition deliveries not yet settled. */
	private readonly pendingTransitions = new Set<Promise<void>>();
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
	/** The root whose stored baseline has been looked for. A root is restored at most once, on its first successful scan. Process-local. */
	private restoreTried: string | null = null;
	/** The baseline last written to, or read from, the store. A baseline that differs from it is dirty. At most one snapshot is held for it. Process-local. */
	private savedBaseline: StoredBaseline | null = null;
	/** The save in flight, or null. It never rejects, and a scan does not wait for it. */
	private baselineSave: Promise<void> | null = null;
	/** When the last save was attempted, by the host clock (`deps.now`); null before the first. Saves are at least `baselineSaveIntervalMs` apart. */
	private lastSaveAttemptMs: number | null = null;
	/** The save failure last reported, or null while saves land. A report fires only when it changes. */
	private saveProblem: string | null = null;
	/** The server time of the last presence write that landed (change or liveness); null before one, or when its clock was unreadable. The liveness interval runs from it. Process-local. */
	private lastPresenceMs: number | null = null;
	/** The liveness timer, or undefined while it is not running. It beats independently of the scan interval. */
	private livenessTimer: PlanningTimerHandle | undefined;
	/** The liveness beat in flight, or null. It never rejects. */
	private livenessRun: Promise<void> | null = null;
	/** The liveness-timer failure last reported, or null while its beats land. A report fires only when it changes. */
	private livenessProblem: string | null = null;
	/** What the liveness timer beats for: the checkout the latest scan read. Null before a scan, and after a scan that could not read it. Process-local. */
	private liveTarget: { root: string; ttlMs: number; repo: RepoLookup } | null = null;
	private readonly timers: PlanningTimers;
	private readonly reporter: (line: string) => void;
	private readonly clock: () => number;
	private readonly saveIntervalMs: number;

	constructor(private readonly deps: PlanningObserverDeps) {
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.reporter = deps.report ?? STDERR_REPORT;
		this.clock = deps.now ?? Date.now;
		this.saveIntervalMs = deps.baselineSaveIntervalMs ?? DEFAULT_BASELINE_SAVE_INTERVAL_MS;
		if (!Number.isFinite(this.saveIntervalMs) || this.saveIntervalMs < 0) throw new RangeError("baselineSaveIntervalMs must be a non-negative number");
	}

	/**
	 * Start the scan timer at the configured cadence, unref'd, and, when liveness is configured and a presence store exists, the
	 * liveness timer beside it (`livenessPeriodMs`). Nothing starts while the plane is disabled or misconfigured. Returns whether it
	 * is running. The liveness timer is scheduled first so the scan timer is the one a test's single-slot fake keeps.
	 */
	start(): boolean {
		if (this.timer !== undefined) return true;
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return false;
		const liveness = this.deps.liveness;
		if (liveness !== undefined && liveness !== null && this.deps.presence !== null) {
			this.livenessTimer = this.timers.setInterval(() => this.livenessTick(), livenessPeriodMs(liveness, resolved.limits.scanIntervalMs, resolved.limits.presenceTtlS * 1000));
		}
		this.timer = this.timers.setInterval(() => this.tick(), resolved.limits.scanIntervalMs);
		return true;
	}

	/** Clear both timers. A scan or liveness beat in flight finishes; `idle` waits for it. Nothing new starts from a timer. */
	stop(): void {
		this.timers.clearInterval(this.timer);
		this.timer = undefined;
		if (this.livenessTimer !== undefined) this.timers.clearInterval(this.livenessTimer);
		this.livenessTimer = undefined;
	}

	/**
	 * Resolves once no scan, no liveness beat and no baseline save is in flight. A scan can start a save as it ends, so it looks
	 * again after each wait. The shutdown path waits on it, inside its own bound, after `stop`. Never rejects.
	 */
	async idle(): Promise<void> {
		for (;;) {
			const pending: Array<Promise<unknown>> = [];
			if (this.running !== null) pending.push(this.running);
			if (this.livenessRun !== null) pending.push(this.livenessRun);
			if (this.baselineSave !== null) pending.push(this.baselineSave);
			if (pending.length === 0) return;
			await Promise.all(pending);
		}
	}

	/** One scan. A call made while a scan is in flight shares that scan: no second scan starts behind it. Never rejects. */
	scan(): Promise<ObserverScan> {
		return this.running ?? this.startScan();
	}

	private startScan(): Promise<ObserverScan> {
		const run = this.scanOnce()
			.catch((cause: unknown) => {
				this.liveTarget = null;
				return failedScan(cause);
			})
			.finally(() => {
				this.running = null;
			});
		this.running = run;
		return run;
	}

	/**
	 * Waits for the scan in flight, then for the transition deliveries in flight, up to `deadline`: resolves `settled` when neither is
	 * left, or `deadline` when the bound came first. Never rejects. Shutdown passes its timer as the bound. A scan running when this is
	 * called cannot schedule a transition after the settle returns, because the settle waits for that scan first. A scan never waits
	 * on this. Without a bound it waits for everything.
	 */
	async settleTransitions(deadline: Promise<void> = Promise.withResolvers<void>().promise): Promise<"settled" | "deadline"> {
		const flushed = (async (): Promise<"settled"> => {
			for (;;) {
				if (this.running !== null) await this.running;
				if (this.pendingTransitions.size === 0) return "settled";
				await Promise.all([...this.pendingTransitions]);
			}
		})();
		return Promise.race([flushed, deadline.then((): "deadline" => "deadline")]);
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
		const repo = await repoOf(this.deps.fs, root, this.deps.originUrl);
		if (!built.ok) {
			// A checkout the scan could not read is not proven alive: the liveness timer stops beating until a scan reads it.
			this.liveTarget = null;
			await this.heartbeat(root, false, ttlMs, repo, nowMs);
			return { state: "unavailable", code: built.code };
		}
		this.index = { root, index: built.index };
		this.liveTarget = { root, ttlMs, repo };

		const next = snapshotOf(built.index);
		const state = indexState(built.index);
		// The change since the scan before: a heartbeat reports it, so a change is heartbeated once, in the scan that sees it.
		const sinceLastScan = this.lastScan !== null && this.lastScan.root === root ? diffPlanningIndex(this.lastScan.snapshot, next) : null;
		// The state the scan before saw. A revert and a held change record their move from there: the publish baseline's state lags while a change is held.
		const observedBefore = this.lastScan !== null && this.lastScan.root === root ? this.lastScan.state : null;
		this.lastScan = { root, snapshot: next, state };
		this.claimTouches(root, next, phasePlansOf(built.index), nowMs, ttlMs);
		// The overflow holds while the claims it could not keep are inside the freshness window of the change that overflowed.
		if (nowMs !== null) {
			this.touchedOverflow = this.overflowAtMs !== null && nowMs - this.overflowAtMs <= ttlMs;
			if (!this.touchedOverflow) this.overflowAtMs = null;
		}
		if (this.touchedOverflow && nowMs !== null) this.report = unknownReport(nowMs, "report-limit");

		if (this.restoreTried !== root && (this.baseline === null || this.baseline.root !== root)) await this.restoreBaseline(root);
		// Read after the restore, so a restored baseline is the one a transition moves from.
		const current = this.baseline;
		const previous = current !== null && current.root === root ? current.snapshot : null;
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
			// A failed publish holds the baseline; every other outcome advances it. The transition follows the same rule.
			const held = observed.outcome === "not-published";
			const transition = observed.outcome === "published" ? "applied" : held ? "refused" : unpublishedOutcome(previous, diff);
			this.settle(root, current, state, { snapshot: observed.baseline, next, diff, outcome: transition, held, observedBefore });
			outcome = observed.outcome;
		} else if (changed) {
			// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
			// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
			if (!repo.transient) this.settle(root, current, state, { snapshot: next, next, diff, outcome: "refused", held: false, observedBefore });
			outcome = "repo-unknown";
		} else {
			this.settle(root, current, state, { snapshot: next, next, diff, outcome: unpublishedOutcome(previous, diff), held: false, observedBefore });
			outcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		}
		// The transition was scheduled, not awaited, and the baseline advanced in `settle` above: the baseline save below saves the
		// advanced baseline, and nothing after it (heartbeat, liveness beat, announcement) waits on the metric write.
		const sinceChange = sinceLastScan !== null && sinceLastScan.complete && changesIn(sinceLastScan) > 0;
		const heartbeat = await this.heartbeat(root, sinceChange || gapMoved, ttlMs, repo, nowMs);
		const liveness = await this.livenessBeat(root, heartbeat, ttlMs, repo, nowMs);
		await this.announce(root, repo, ttlMs);
		this.persistBaseline(root);
		return liveness === undefined ? { state: "observed", outcome, heartbeat } : { state: "observed", outcome, heartbeat, liveness };
	}

	/**
	 * Records the transition this scan made, if any, then moves the baseline. A held change keeps the baseline's state: its
	 * transition is recorded once, on first detection, and a later scan of the same change records nothing. A baseline restored
	 * from the store has no state, so a move from it is recorded as a move from this scan's own state.
	 */
	private settle(
		root: string,
		current: StoredBaseline | null,
		state: SessionState,
		change: { snapshot: PlanningSnapshot; next: PlanningSnapshot; diff: PlanningDiff | null; outcome: TransitionOutcome | null; held: boolean; observedBefore: SessionState | null },
	): void {
		const { diff, outcome } = change;
		// The state the baseline was taken in; a restored baseline has none, so the move reads from this scan's own state.
		const baselineState = this.baselineState ?? state;
		const incomplete = diff !== null && !diff.complete;
		const key = diff !== null && diff.removed !== null && outcome !== null ? changeKey({ added: diff.added, removed: diff.removed, changed: diff.changed }, change.next) : null;
		if (change.held) {
			if (outcome !== null && current !== null && key !== this.recordedHold) {
				this.recordedHold = key;
				this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: change.observedBefore ?? baselineState, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
			}
			if (current !== null) this.baseline = { root, snapshot: change.snapshot };
			return;
		}
		const recorded = key !== null && key === this.recordedHold;
		if (outcome !== null && current !== null && !recorded) {
			this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: baselineState, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
		} else if (current !== null && this.recordedHold !== null && diff !== null && diff.complete && changesIn(diff) === 0) {
			// A revert: the held change is undone, so the baseline matches the checkout again and nothing is published. It is recorded
			// once, as refused, because the reverted change never reached the ledger.
			this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: change.observedBefore ?? baselineState, to: state, outcome: "refused" }, this.deps.clock ?? hostClock));
		}
		this.advance(root, change.snapshot, state);
	}

	/** Moves the baseline. A new baseline forgets a held change. */
	private advance(root: string, snapshot: PlanningSnapshot, state: SessionState): void {
		this.recordedHold = null;
		this.baseline = { root, snapshot };
		this.baselineState = state;
	}

	/**
	 * Hands one `planning.transition` record to its sinks without waiting for them, so the scan never waits on the metric write.
	 * The deliveries in flight are bounded by {@link MAX_PENDING_TRANSITIONS}: past the bound a record goes to the fallback alone,
	 * so a stalled primary can neither grow the set nor lose a record. `emitTransition` never throws; a fallback that fails is
	 * written to stderr.
	 */
	private schedule(record: TransitionRecord): void {
		const fallback = this.deps.fallback ?? stdoutMetricSink();
		const tracked = this.pendingTransitions.size < MAX_PENDING_TRANSITIONS;
		const delivery: Promise<void> = emitTransition(record, tracked ? this.deps.metrics : fallback, fallback).then((delivered) => {
			if (tracked) this.pendingTransitions.delete(delivery);
			if (delivered.status === "failed") {
				process.stderr.write(`[substrate] planning transition not delivered: ${delivered.primary.sink} ${delivered.primary.reason}, ${delivered.fallback.sink} ${delivered.fallback.reason}\n`);
			}
		});
		if (tracked) this.pendingTransitions.add(delivery);
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
	private async touchCheckout(root: string, presence: DragonflyPresenceStore, currentRepo: string | null, ttlMs: number, kind: "change" | "liveness" = "change"): Promise<Extract<PlanningHeartbeat, { state: "written" | "failed" }>> {
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
			await (kind === "liveness" ? presence.touchLiveness(record, ttlMs) : presence.touch(record, ttlMs));
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: errnoCode(cause) };
		}
	}

	/**
	 * The liveness heartbeat (phase 58): a scan that read the checkout proves it alive, whether or not anything changed, so a
	 * session that thinks for hours without touching a planning document stays active. It runs only when `deps.liveness` is set,
	 * and only after a scan that built the index: a checkout that cannot be read is not proven alive. A scan whose change
	 * heartbeat landed is already covered (that write is also a sign of life). A failed change heartbeat is not retried here:
	 * the same backend would refuse it. Otherwise a write is due on the first scan and then `intervalMs` after the last presence
	 * write, capped at a third of the freshness window so a beat always lands well inside it. A write that fails is reported
	 * (`problemOf`) and tried again on the next scan, since a failure does not move the last-write time. The same write is also
	 * driven by its own timer (`livenessTick`), so a scan interval longer than the freshness window cannot make a live session
	 * look dead.
	 */
	private async livenessBeat(root: string, heartbeat: PlanningHeartbeat, ttlMs: number, repo: RepoLookup, nowMs: number | null): Promise<PlanningLiveness | undefined> {
		const settings = this.deps.liveness;
		if (settings === undefined || settings === null) return undefined;
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
		if (heartbeat.state === "written") {
			this.lastPresenceMs = nowMs;
			return { state: "covered" };
		}
		if (heartbeat.state === "failed") return { state: "failed", detail: heartbeat.detail };
		return this.livenessWrite(root, presence, settings, ttlMs, repo, nowMs);
	}

	/** The due check and the write of one liveness beat, shared by the scan and the liveness timer. */
	private async livenessWrite(root: string, presence: DragonflyPresenceStore, settings: LivenessSettings, ttlMs: number, repo: RepoLookup, nowMs: number | null): Promise<PlanningLiveness> {
		if (nowMs === null) return { state: "failed", detail: "clock-unavailable" };
		const everyMs = Math.min(settings.intervalMs, Math.floor(ttlMs / 3));
		const elapsedMs = this.lastPresenceMs === null ? null : nowMs - this.lastPresenceMs;
		// A server clock that moved backwards (negative elapsed time) is due: it cannot show how long the record has been held.
		if (elapsedMs !== null && elapsedMs >= 0 && elapsedMs < everyMs) return { state: "not-due" };
		const currentRepo = repo.state === "known" ? repo.repo : null;
		const result = await this.touchCheckout(root, presence, currentRepo, ttlMs, "liveness");
		if (result.state === "failed") return result;
		this.lastPresenceMs = nowMs;
		// The liveness record carries the same report and repository a change heartbeat does, so they are written: a view change must not re-arm a change heartbeat for them.
		this.written = this.report;
		this.writtenRepo = currentRepo;
		return { state: "written" };
	}

	/**
	 * One tick of the liveness timer, which runs on its own cadence (`livenessPeriodMs`), not the scan's. It beats for the
	 * checkout the last scan read (`liveTarget`, dropped by a scan that could not read it); `touchCheckout` reads the git layout
	 * again, so a checkout that has vanished since then is not written. A scan in flight beats for itself, and a beat in flight
	 * is not doubled. Never rejects: a failure is reported once when it appears or changes, and once more on recovery.
	 */
	private async livenessTick(): Promise<void> {
		const settings = this.deps.liveness;
		const presence = this.deps.presence;
		const target = this.liveTarget;
		if (settings === undefined || settings === null || presence === null || target === null) return;
		if (this.running !== null || this.livenessRun !== null) return;
		const run = (async () => {
			try {
				const clock = await readClock(presence);
				const beat = await this.livenessWrite(target.root, presence, settings, target.ttlMs, target.repo, clock.ok ? clock.nowMs : null);
				this.noteLiveness(beat.state === "failed" ? beat.detail : null);
			} catch (cause: unknown) {
				this.noteLiveness(errnoCode(cause));
			}
		})().finally(() => {
			this.livenessRun = null;
		});
		this.livenessRun = run;
		await run;
	}

	/** Reports a liveness-timer failure when it appears or changes, and the recovery when the beats land again. Silent while nothing changes. */
	private noteLiveness(problem: string | null): void {
		if (problem === this.livenessProblem) return;
		const before = this.livenessProblem;
		this.livenessProblem = problem;
		if (problem !== null) this.reporter(`[substrate] planning observer: liveness timer heartbeat failed: ${problem}`);
		else if (before !== null) this.reporter("[substrate] planning observer: liveness timer heartbeats succeed again");
	}

	/**
	 * Takes the stored baseline of this checkout as the publish baseline, once per root, so the first scan diffs the tree against
	 * what the ledger was last told and publishes what changed while the observer was down. No store, no file, a file for another
	 * root, or a file that cannot be used leaves no baseline, and the first scan is a baseline as before: the last three are
	 * reported, and the next save replaces the bad file. Changes found this way are published but not claimed as touched pairs:
	 * their time is unknown, and claiming them at restart would show a stale edit as active.
	 */
	private async restoreBaseline(root: string): Promise<void> {
		this.restoreTried = root;
		const store = this.deps.baselines;
		if (store === undefined || store === null) return;
		let loaded: BaselineLoad;
		try {
			loaded = await store.load(planningSessionId(this.deps.fs, root));
		} catch (cause: unknown) {
			this.reporter(`[substrate] planning observer: stored baseline not read: ${cause instanceof BaselineStoreError ? cause.message : errnoCode(cause)}; scanning as a first run`);
			return;
		}
		if (loaded.state === "unusable") {
			this.reporter(`[substrate] planning observer: stored baseline unusable (${loaded.reason}${loaded.detail === null ? "" : `: ${loaded.detail}`}); scanning as a first run`);
			return;
		}
		if (loaded.state !== "loaded") return;
		if (loaded.baseline.root !== root) {
			this.reporter("[substrate] planning observer: stored baseline names another checkout root; scanning as a first run");
			return;
		}
		// The store keeps no state: a restored baseline has none, and the first move from it reads from the state that scan finds.
		this.baseline = loaded.baseline;
		this.baselineState = null;
		this.savedBaseline = loaded.baseline;
	}

	/**
	 * Starts a save of the publish baseline when it differs from the stored one, no save is in flight, and the last attempt is
	 * older than `baselineSaveIntervalMs` (host clock, injected). It never waits for the save: a slow or failing store cannot
	 * hold a scan. A failed save leaves the baseline dirty, so a later scan tries again. A crash before a save lands loses at
	 * most the baseline advance since the last save, so a restart may publish that change a second time: delivery is at least once.
	 */
	private persistBaseline(root: string): void {
		const baseline = this.baseline;
		if (this.deps.baselines === undefined || this.deps.baselines === null || baseline === null || baseline.root !== root) return;
		if (this.baselineSave !== null) return;
		// Equal content needs no save. The newest object is held, not the first one saved, so a quiet tree retains one snapshot.
		if (this.savedBaseline !== null && sameBaseline(this.savedBaseline, baseline)) {
			this.savedBaseline = baseline;
			return;
		}
		const nowMs = this.clock();
		const sinceMs = this.lastSaveAttemptMs === null ? null : nowMs - this.lastSaveAttemptMs;
		// A host clock that moved backwards (negative elapsed time) is due.
		if (sinceMs !== null && sinceMs >= 0 && sinceMs < this.saveIntervalMs) return;
		this.startSave(baseline, nowMs);
	}

	/** Saves `baseline` in the background. The result is recorded, never thrown: a failure is reported once and the baseline stays dirty. */
	private startSave(baseline: StoredBaseline, nowMs: number): void {
		const store = this.deps.baselines;
		if (store === undefined || store === null) return;
		this.lastSaveAttemptMs = nowMs;
		this.baselineSave = (async () => {
			try {
				await store.save(planningSessionId(this.deps.fs, baseline.root), baseline);
				this.savedBaseline = baseline;
				this.noteSave(null);
			} catch (cause: unknown) {
				this.noteSave(cause instanceof BaselineStoreError ? cause.message : errnoCode(cause));
			}
		})().finally(() => {
			this.baselineSave = null;
		});
	}

	/** Reports a save failure when it appears or changes, and the recovery when saves land again. Silent while nothing changes. */
	private noteSave(problem: string | null): void {
		if (problem === this.saveProblem) return;
		const before = this.saveProblem;
		this.saveProblem = problem;
		if (problem !== null) this.reporter(`[substrate] planning observer: baseline save failed: ${problem}; it is retried`);
		else if (before !== null) this.reporter("[substrate] planning observer: baseline saves succeed again");
	}

	/**
	 * Saves the publish baseline now when it is dirty, ignoring the throttle, and waits for it. The shutdown path calls it (inside
	 * its own bound) so a clean stop loses no baseline advance. Never rejects: a failure is reported like any other save failure.
	 */
	async flushBaseline(): Promise<void> {
		while (this.baselineSave !== null) await this.baselineSave;
		const baseline = this.baseline;
		if (this.deps.baselines === undefined || this.deps.baselines === null || baseline === null) return;
		if (this.savedBaseline !== null && sameBaseline(this.savedBaseline, baseline)) return;
		this.startSave(baseline, this.clock());
		await this.baselineSave;
	}

	/**
	 * Announces each conflict of this checkout's repository that is not already open, once. With a deduplicating ledger every
	 * observer announces it under the conflict's key (see `conflictEvent`); otherwise this checkout announces it only when it is the
	 * conflict's announcer, the session with the smallest id among its sessions, which needs no coordination. A conflict that is no
	 * longer detected leaves the open set, so its return is announced again. A conflict the ledger did not store stays out of the
	 * set, so the next scan tries again.
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
		const keyed = this.deps.dedup === true;
		const next = new Set<string>();
		for (const conflict of detected.conflicts) {
			if (repoName === null || repoKey(conflict.repo) !== repoKey(repoName)) continue;
			// Without a deduplicating ledger the announcer is the smallest session of the conflict (`sessionIds` is sorted). Known
			// limit: when that session has no running observer, no observer announces the conflict.
			if (!keyed && conflict.sessionIds[0] !== sessionId) continue;
			const signature = conflictSignature(conflict);
			if (this.openConflicts.has(signature)) {
				next.add(signature);
				continue;
			}
			let stored = false;
			try {
				stored = await this.deps.emit(keyed ? conflictEvent(conflict, conflictOriginMs(conflict, detected.views)) : conflictEvent(conflict));
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

/** The identity of a change: its paths and the hashes they now have. A held change detected again has the same identity. */
function changeKey(diff: { added: PathChange[]; removed: PathChange[]; changed: PathChange[] }, after: PlanningSnapshot): string {
	const hashes = new Map(after.records.map((record) => [record.path, record.sha256] as const));
	const hashed = (changes: PathChange[]): [string, string | null][] => changes.map(({ path }) => [path, hashes.get(path) ?? null]);
	return JSON.stringify({ added: hashed(diff.added), removed: diff.removed.map(({ path }) => path), changed: hashed(diff.changed) });
}

/** The transition outcome of a scan that published nothing: an incomplete diff that vouches for a change is refused; the rest record nothing. */
function unpublishedOutcome(previous: PlanningSnapshot | null, diff: PlanningDiff | null): TransitionOutcome | null {
	if (diff === null || diff.complete) return null;
	const added = previous?.truncated === true ? 0 : diff.added.length;
	return added + diff.changed.length > 0 ? "refused" : null;
}

/** The host clock. It stamps a transition record and classifies nothing. */
const hostClock: TransitionClock = () => new Date();

/**
 * The state of a planning index for its transition record: DEGRADED when the view is partial (truncated, or a document could
 * not be read), EMPTY with no document, SUCCESS otherwise.
 */
function indexState(index: PlanningIndex): SessionState {
	if (index.truncated || Object.keys(index.errors).length > 0) return "DEGRADED";
	return Object.keys(index.documents).length === 0 ? "EMPTY" : "SUCCESS";
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
	if (scan.liveness?.state === "failed") return `liveness heartbeat failed: ${scan.liveness.detail}`;
	if (scan.outcome === "not-published") return "a change was not stored by the ledger, and is retried on the next scan";
	if (scan.outcome === "repo-unknown") return "a change could not be attributed to a repo, so nothing was published";
	return null;
}

/** True when two baselines say the same: the same root and the same documents, hashes, truncation and unlisted directories. */
function sameBaseline(a: StoredBaseline, b: StoredBaseline): boolean {
	if (a === b) return true;
	if (a.root !== b.root || a.snapshot.truncated !== b.snapshot.truncated) return false;
	if (a.snapshot.unlisted.length !== b.snapshot.unlisted.length || a.snapshot.records.length !== b.snapshot.records.length) return false;
	if (a.snapshot.unlisted.some((path, index) => path !== b.snapshot.unlisted[index])) return false;
	return a.snapshot.records.every((record, index) => {
		const other = b.snapshot.records[index];
		return other !== undefined && other.path === record.path && other.sha256 === record.sha256;
	});
}

/**
 * The period of the liveness timer, in milliseconds. It never exceeds a third of the freshness window, so a beat lands well
 * inside it whatever the scan interval is, and it follows the configured interval when that is shorter. An interval of 0 means
 * a beat as often as a scan would, so it takes the scan interval, still capped at a third of the window.
 */
export function livenessPeriodMs(settings: LivenessSettings, scanIntervalMs: number, ttlMs: number): number {
	const cap = Math.floor(ttlMs / 3);
	const wanted = settings.intervalMs > 0 ? settings.intervalMs : scanIntervalMs;
	return Math.max(1, Math.min(wanted, cap));
}
