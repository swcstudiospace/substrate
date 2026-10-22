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
 * Transitions (phase 54): each scan that moves the plane's view from one session state to another writes one
 * `planning.transition` record through `metrics`, with the stdout line as its fallback. The record is handed to its sinks
 * without being awaited, so a slow metric write does not delay the scan. The scan is the write cadence: a transition is
 * recorded where a scan detects it, and a read never records one.
 *
 * The baseline is process-local. The first scan is a baseline and publishes nothing. A failed publish holds the baseline,
 * so the same change is published on the next scan. The index cache is separate: it always holds the latest scan.
 */
import type { EventInput } from "../types.ts";
import { branchOf, gitLayout, planningSessionId, repoOf } from "./checkout.ts";
import type { PlanningConfigResult } from "./config.ts";
import { diffPlanningIndex, type PathChange, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { observePlanningChange } from "./events.ts";
import { buildPlanningIndex, errnoCode, snapshotOf, updatePlanningIndex, type PlanningFs, type PlanningIndex, type PlanningIndexFailure } from "./index.ts";
import type { DragonflyPresenceStore } from "./presence-dragonfly.ts";
import type { SessionRecord } from "./presence.ts";
import { resolveSettings } from "./read.ts";
import type { SessionState } from "./states.ts";
import { emitTransition, stdoutMetricSink, transitionRecord, type MetricSink, type TransitionClock, type TransitionOutcome, type TransitionRecord } from "./telemetry.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

/** The phase id a planning transition is recorded under: the planning plane's view, which spans every phase document. */
export const PLANNING_TRANSITION_PHASE = "planning";

/** How often the observer scans, in milliseconds. A fixed cadence, not configuration: a scan is incremental, so it is cheap. */
export const PLANNING_SCAN_INTERVAL_MS = 15_000;

/** Most transition deliveries in flight at once. Past it a record goes straight to the stdout fallback, so the set stays bounded. */
export const MAX_PENDING_TRANSITIONS = 64;

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
	/** The primary sink for `planning.transition` records: the metrics writer when the ledger is configured, else stdout. */
	metrics: MetricSink;
	/** Written once when `metrics` does not deliver. Default: one JSON line on stdout. */
	fallback?: MetricSink;
	/** The record's clock. Default: the host clock, which stamps a record and classifies nothing. */
	clock?: TransitionClock;
}

/** The baseline a diff is taken against: its root, its snapshot, and the session state the plane was in when that scan ran. */
interface Baseline {
	root: string;
	snapshot: PlanningSnapshot;
	state: SessionState;
}

export class PlanningObserver {
	/** The index of the latest scan, which the next scan updates. Holds whatever the last scan found, even when a publish failed. */
	private index: { root: string; index: PlanningIndex } | null = null;
	/** The baseline a diff is taken against. It moves forward, and holds when a publish fails. */
	private baseline: Baseline | null = null;
	/** The identity of the held change whose transition is already recorded, so a later scan of that change records nothing. */
	private recordedHold: string | null = null;
	/** Scheduled transition deliveries not yet settled. */
	private readonly pending = new Set<Promise<void>>();
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

	/**
	 * Waits for the transition deliveries in flight, up to `deadline`: resolves `settled` when none is left, or `deadline` when the
	 * bound came first. Never rejects. Shutdown passes its timer as the bound; a scan never waits on this. Without a bound it waits
	 * for every delivery.
	 */
	async settleTransitions(deadline: Promise<void> = Promise.withResolvers<void>().promise): Promise<"settled" | "deadline"> {
		const flushed = (async (): Promise<"settled"> => {
			while (this.pending.size > 0) await Promise.all([...this.pending]);
			return "settled";
		})();
		return Promise.race([flushed, deadline.then((): "deadline" => "deadline")]);
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
		const state = indexState(built.index);
		const current = this.baseline;
		const previous = current !== null && current.root === root ? current.snapshot : null;
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
			// A failed publish holds the baseline; every other outcome advances it. The transition follows the same rule.
			const held = observed.outcome === "not-published";
			const outcome = observed.outcome === "published" ? "applied" : held ? "refused" : unpublishedOutcome(previous, diff);
			this.settle(root, current, state, { snapshot: observed.baseline, next, diff, outcome, held });
			return { state: "observed", outcome: observed.outcome, heartbeat: await this.heartbeat(root, diff, ttlMs) };
		}
		// Without a repo nothing can be published. A complete change is reported once and ends here, unless the failure that
		// hid the repo was transient: then the baseline holds, and the next scan sees the same change again.
		if (diff !== null && diff.complete && changesIn(diff) > 0) {
			if (!repo.transient) this.settle(root, current, state, { snapshot: next, next, diff, outcome: "refused", held: false });
			return { state: "observed", outcome: "repo-unknown", heartbeat: await this.heartbeat(root, diff, ttlMs) };
		}
		this.settle(root, current, state, { snapshot: next, next, diff, outcome: unpublishedOutcome(previous, diff), held: false });
		const outcome: ObserverOutcome = previous === null ? "baseline" : diff !== null && !diff.complete ? "incomplete" : "unchanged";
		return { state: "observed", outcome, heartbeat: { state: "not-due" } };
	}

	/**
	 * Records the transition this scan made, if any, then moves the baseline. A held change keeps the baseline's state: its
	 * transition is recorded once, on first detection, and a later scan of the same change records nothing.
	 */
	private settle(
		root: string,
		current: Baseline | null,
		state: SessionState,
		change: { snapshot: PlanningSnapshot; next: PlanningSnapshot; diff: PlanningDiff | null; outcome: TransitionOutcome | null; held: boolean },
	): void {
		const { diff, outcome } = change;
		const incomplete = diff !== null && !diff.complete;
		const key = diff !== null && diff.removed !== null && outcome !== null ? changeKey({ added: diff.added, removed: diff.removed, changed: diff.changed }, change.next) : null;
		if (change.held) {
			if (outcome !== null && current !== null && key !== this.recordedHold) {
				this.recordedHold = key;
				this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: current.state, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
			}
			if (current !== null) this.baseline = { root, snapshot: change.snapshot, state: current.state };
			return;
		}
		const recorded = key !== null && key === this.recordedHold;
		if (outcome !== null && current !== null && !recorded) {
			this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: current.state, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
		}
		this.advance(root, change.snapshot, state);
	}

	/** Moves the baseline. A new baseline forgets a held change. */
	private advance(root: string, snapshot: PlanningSnapshot, state: SessionState): void {
		this.recordedHold = null;
		this.baseline = { root, snapshot, state };
	}

	/**
	 * Hands one `planning.transition` record to its sinks without waiting for them, so the scan never waits on the metric write.
	 * The deliveries in flight are bounded by {@link MAX_PENDING_TRANSITIONS}: past the bound a record goes to the fallback alone,
	 * so a stalled primary can neither grow the set nor lose a record. `emitTransition` never throws; a fallback that fails is
	 * written to stderr.
	 */
	private schedule(record: TransitionRecord): void {
		const fallback = this.deps.fallback ?? stdoutMetricSink();
		const tracked = this.pending.size < MAX_PENDING_TRANSITIONS;
		const delivery: Promise<void> = emitTransition(record, tracked ? this.deps.metrics : fallback, fallback).then((delivered) => {
			if (tracked) this.pending.delete(delivery);
			if (delivered.status === "failed") {
				process.stderr.write(`[substrate] planning transition not delivered: ${delivered.primary.sink} ${delivered.primary.reason}, ${delivered.fallback.sink} ${delivered.fallback.reason}\n`);
			}
		});
		if (tracked) this.pending.add(delivery);
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

/** A scan that threw. Only the error's code is kept: its message can carry host paths. */
function failedScan(cause: unknown): ObserverScan {
	return { state: "failed", detail: errnoCode(cause) };
}
