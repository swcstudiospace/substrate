/**
 * uplift-4 S7: docs freshness SLI and merge-trigger lag.
 *
 * Pure and offline: everything here is computed from the persisted docs state
 * (the version store and the accepted-trigger store) and a caller-supplied
 * clock. No RAGFlow call; the only side effects are the injected ones.
 *
 * What it proves, and what it does not:
 * - `freshness_seconds` is the age of the newest recorded ingest per dataset.
 *   It says the corpus was refreshed recently; it does not say the corpus is
 *   at the repository HEAD, because only the post-merge hook ever sees HEAD.
 * - `trigger_lag_seconds` is the age of the newest accepted merge-trigger whose
 *   commit has no recorded version. It says an accepted trigger did not turn
 *   into an ingest; it is silent about a hook that never fired.
 *
 * The lag warning is deduplicated through markers kept in the docs state
 * file (like the doctor's last-emitted record): one `warning` when a dataset
 * enters the breach, nothing while it lasts, one `note` when it clears. A
 * marker is written before its event is emitted and marked `warned` only
 * after the emit succeeded, so a failed emit is retried (no sooner than
 * `LAG_RETRY_MS` later). The dedupe is best effort: with no state file
 * (`SUBSTRATE_DOCS_STATE_FILE` unset) the markers live in this process and a
 * restart can warn again; persist errors are swallowed (logged), so a lost
 * write can do the same; and a crash between the emit and the second persist,
 * or an emit that completed after its deadline, can duplicate one warning.
 * Nothing is ever lost, at worst repeated.
 */
import { DATASET_TRIGGERS, DATASET_VERSION_RETENTION, triggersFromJson, triggersToJson, type DatasetVersion, type TriggerStore, type VersionStore } from "./docs-datasets.ts";
import type { EventInput } from "./types.ts";

/** Metric names of the two gauges, served on `GET /metrics` under `gauges`. */
export const GAUGE_FRESHNESS_SECONDS = "substrate.docs.freshness_seconds";
export const GAUGE_TRIGGER_LAG_SECONDS = "substrate.docs.trigger_lag_seconds";

/** The name the corpus is judged under beside the datasets: its lag marker is kept in the same state file. */
export const CORPUS_FRESHNESS_DATASET = "corpus";

export interface FreshnessSettings {
	/** Staleness threshold in hours; `0` reports freshness without judging it. */
	maxAgeHours: number;
	/** Trigger-lag threshold in minutes; `0` switches trigger bookkeeping and lag detection off. */
	triggerLagMinutes: number;
	/** Seconds the corpus may go without an ingest (`SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`), named in the corpus's own events. Absent where the corpus is not judged. */
	corpusMaxAgeS?: number | undefined;
}

/** A corpus objective the row breaches: `ingest_age` past the age limit, `sync_lag` over the sync objective (`SUBSTRATE_DOCS_SLO_SYNC_LAG_S`). */
export type CorpusBreach = "ingest_age" | "sync_lag";

/** The corpus row beyond a dataset row: its breaches and, when the sync lag is one, the lag and the objective it is over. */
export interface CorpusVerdict {
	breaches: CorpusBreach[];
	sync?: { lag_seconds: number; threshold_seconds: number };
}

/** One dataset's verdict; `dataset` is always a name of the trigger table. */
export interface DatasetFreshness {
	dataset: string;
	/** Seconds since the newest `versions[].ingested_at`; `null` when no version is recorded. */
	freshness_seconds: number | null;
	newest_ingested_at: string | null;
	/** Older than `maxAgeHours` (never true when that is `0` or nothing is recorded). */
	stale: boolean;
	/** The newest accepted trigger had a recorded version, or none was accepted. */
	trigger_lag_seconds: number | null;
	/** The commit of the trigger still waiting for its version. */
	lagging_commit: string | null;
	/** A trigger has waited at least `triggerLagMinutes`. */
	lagging: boolean;
	/** Triggers on record for this dataset. */
	triggers: number;
	/** The corpus row only: the objectives it breaches, and the sync lag when that is one of them. */
	corpus?: CorpusVerdict;
}

export interface FreshnessInput {
	versions: VersionStore;
	triggers: TriggerStore;
	/** Epoch ms. */
	now: number;
	settings: FreshnessSettings;
}

function parseMs(value: string): number | null {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/** Newest `ingested_at` over a dataset's retained versions; unparseable timestamps are ignored. */
function newestIngest(versions: readonly DatasetVersion[]): { at: string; ms: number } | null {
	let best: { at: string; ms: number } | null = null;
	for (const version of versions) {
		const ms = parseMs(version.ingested_at);
		if (ms !== null && (best === null || ms > best.ms)) best = { at: version.ingested_at, ms };
	}
	return best;
}

/**
 * Per-dataset freshness and trigger lag. A dataset appears when it has a
 * recorded version or an accepted trigger; order follows the trigger table.
 *
 * The trigger judged is the newest by `received_at`: an older unresolved one
 * is superseded by whatever the newer one did. It is resolved when any
 * retained version carries its commit, or when the version history has
 * rolled past it (every retained version is newer and the store is full), in
 * which case it can no longer be judged and is not reported.
 */
export function evaluateFreshness(input: FreshnessInput): DatasetFreshness[] {
	const { versions, triggers, now, settings } = input;
	const maxAgeMs = settings.maxAgeHours * 3_600_000;
	const lagMs = settings.triggerLagMinutes * 60_000;
	const rows: DatasetFreshness[] = [];
	for (const dataset of Object.keys(DATASET_TRIGGERS)) {
		const held = versions.get(dataset) ?? [];
		const accepted = triggers.get(dataset) ?? [];
		if (held.length === 0 && accepted.length === 0) continue;

		const newest = newestIngest(held);
		// Clamped at zero: a version stamped ahead of this clock is fresh, not negative.
		const freshness = newest === null ? null : Math.max(0, Math.round((now - newest.ms) / 1000));

		let waiting: { commit: string; sha: string; ms: number } | null = null;
		for (const trigger of accepted) {
			const ms = parseMs(trigger.received_at);
			if (ms !== null && (waiting === null || ms >= waiting.ms)) waiting = { commit: trigger.commit, sha: trigger.content_sha256, ms };
		}
		let lagSeconds: number | null = null;
		let laggingCommit: string | null = null;
		if (waiting !== null) {
			const pending: { commit: string; sha: string; ms: number } = waiting;
			// The same commit with another content hash is another ingest: it does not land this trigger.
			const recorded = held.some((version) => version.commit === pending.commit && version.content_sha256 === pending.sha);
			const oldest = held.reduce<number | null>((min, version) => {
				const ms = parseMs(version.ingested_at);
				return ms !== null && (min === null || ms < min) ? ms : min;
			}, null);
			const rolledPast = held.length >= DATASET_VERSION_RETENTION && oldest !== null && oldest > waiting.ms;
			if (recorded || rolledPast) {
				lagSeconds = 0;
			} else {
				lagSeconds = Math.max(0, Math.round((now - waiting.ms) / 1000));
				laggingCommit = waiting.commit;
			}
		}
		rows.push({
			dataset,
			freshness_seconds: freshness,
			newest_ingested_at: newest?.at ?? null,
			stale: maxAgeMs > 0 && freshness !== null && freshness * 1000 > maxAgeMs,
			trigger_lag_seconds: lagSeconds,
			lagging_commit: laggingCommit,
			lagging: lagMs > 0 && laggingCommit !== null && lagSeconds !== null && lagSeconds * 1000 >= lagMs,
			triggers: accepted.length,
		});
	}
	return rows;
}

/**
 * The corpus's verdict, judged apart from the datasets (v1.7 phase 65): stale when its newest ingest is older than
 * `maxAgeS` (0 judges no age), and lagging when the newest `docs.sync` lag is strictly over `syncLagMaxS` (unset judges no
 * sync). It reuses the dataset breach machinery (one marker, one warning per breach, one note when it clears), so the row
 * stands in a dataset row: `trigger_lag_seconds` is the age and `lagging_commit` the newest ingest's instant; `corpus` names
 * the objectives it breaches. `null` (judge nothing) when neither objective is on, the manifest has never ingested anything
 * or its instant cannot be read. A corpus whose documents do not change is as old as its last change, so this warns for a
 * quiet one too; the threshold is the knob.
 */
export function corpusFreshnessRow(input: { lastIngestAt: string | null; now: number; maxAgeS: number; syncLagS?: number | null | undefined; syncLagMaxS?: number | undefined }): DatasetFreshness | null {
	const ageJudged = input.maxAgeS > 0;
	const syncMax = input.syncLagMaxS;
	if (!ageJudged && syncMax === undefined) return null;
	if (input.lastIngestAt === null) return null;
	const ms = parseMs(input.lastIngestAt);
	if (ms === null) return null;
	const age = Math.max(0, Math.round((input.now - ms) / 1000));
	const stale = ageJudged && age > input.maxAgeS;
	const syncLag = input.syncLagS ?? null;
	const syncOver = syncMax !== undefined && syncLag !== null && syncLag > syncMax;
	const breaches: CorpusBreach[] = [];
	if (stale) breaches.push("ingest_age");
	if (syncOver) breaches.push("sync_lag");
	return {
		dataset: CORPUS_FRESHNESS_DATASET,
		freshness_seconds: age,
		newest_ingested_at: input.lastIngestAt,
		stale,
		trigger_lag_seconds: age,
		lagging_commit: input.lastIngestAt,
		lagging: breaches.length > 0,
		triggers: 0,
		corpus: { breaches, ...(syncOver ? { sync: { lag_seconds: syncLag, threshold_seconds: syncMax } } : {}) },
	};
}

/** One gauge point; `dataset` is the only label and comes from the trigger table. */
export interface GaugeSample {
	name: string;
	unit: "s";
	description: string;
	attributes: { dataset: string };
	value: number;
}

/** The observer gauges: freshness for every dataset with a version, trigger lag for every one that ever took a trigger. */
export function freshnessGauges(rows: readonly DatasetFreshness[]): GaugeSample[] {
	const samples: GaugeSample[] = [];
	for (const row of rows) {
		if (row.freshness_seconds !== null) {
			samples.push({
				name: GAUGE_FRESHNESS_SECONDS,
				unit: "s",
				description: "Seconds since the newest recorded docs ingest of the dataset",
				attributes: { dataset: row.dataset },
				value: row.freshness_seconds,
			});
		}
		if (row.triggers > 0) {
			samples.push({
				name: GAUGE_TRIGGER_LAG_SECONDS,
				unit: "s",
				description: "Seconds the newest accepted merge-trigger of the dataset has waited for its recorded version; 0 when it landed",
				attributes: { dataset: row.dataset },
				value: row.trigger_lag_seconds ?? 0,
			});
		}
	}
	return samples;
}

// ── the lag warning's dedupe ──────────────────────────────────────────────────

/** A breach in progress for one dataset, persisted in the docs state file. */
export interface LagMarker {
	/** When this process first saw the breach, ISO. */
	since: string;
	commit: string;
	/** True once the `warning` event was accepted by the ledger. */
	warned: boolean;
}

export type LagMarkers = Map<string, LagMarker>;

/** The persisted freshness bookkeeping: what the state file's optional `triggers` and `lag` members hold. */
export interface FreshnessState {
	triggers: TriggerStore;
	lag: LagMarkers;
}

export function createFreshnessState(): FreshnessState {
	return { triggers: new Map(), lag: new Map() };
}

/**
 * The `triggers` and `lag` members to merge into the state file. Empty
 * members are left out, so a state file nothing was triggered against is
 * byte-identical to what version 2 wrote before this change.
 */
export function freshnessStateToJson(state: FreshnessState): { triggers?: Record<string, unknown>; lag?: Record<string, LagMarker> } {
	const triggers = triggersToJson(state.triggers);
	const lag = state.lag.size === 0 ? undefined : Object.fromEntries(state.lag);
	return { ...(triggers !== undefined ? { triggers } : {}), ...(lag !== undefined ? { lag } : {}) };
}

/** The state a parsed file describes; an absent, malformed or oversized member is ignored, never thrown on. */
export function freshnessStateFromJson(parsed: unknown): FreshnessState {
	const state = createFreshnessState();
	if (parsed === null || typeof parsed !== "object") return state;
	const file = parsed as Record<string, unknown>;
	if (Object.hasOwn(file, "triggers")) state.triggers = triggersFromJson(file.triggers);
	const lag: unknown = Object.hasOwn(file, "lag") ? file.lag : undefined;
	if (lag !== null && typeof lag === "object" && !Array.isArray(lag)) {
		for (const dataset of [...Object.keys(DATASET_TRIGGERS), CORPUS_FRESHNESS_DATASET]) {
			if (!Object.hasOwn(lag, dataset)) continue;
			const marker = (lag as Record<string, unknown>)[dataset];
			if (marker === null || typeof marker !== "object") continue;
			const { since, commit, warned } = marker as Record<string, unknown>;
			if (typeof since !== "string" || typeof commit !== "string" || typeof warned !== "boolean") continue;
			if (since.length > 64 || commit.length > 200 || !Number.isFinite(Date.parse(since))) continue;
			state.lag.set(dataset, { since, commit, warned });
		}
	}
	return state;
}

export type LagAction =
	| { type: "breach"; dataset: string; commit: string; lagSeconds: number; corpus?: CorpusVerdict }
	| { type: "recover"; dataset: string; commit: string; warned: boolean };

/**
 * What the markers and the verdicts call for. A breach with no marker, or
 * with one whose warning never landed, warns; a breach already warned about
 * is silent; a marker whose dataset no longer lags recovers. Pure: the caller
 * writes the markers and emits the events.
 */
export function planLagTransitions(rows: readonly DatasetFreshness[], markers: LagMarkers): LagAction[] {
	const actions: LagAction[] = [];
	const lagging = new Set<string>();
	for (const row of rows) {
		if (!row.lagging || row.lagging_commit === null || row.trigger_lag_seconds === null) continue;
		lagging.add(row.dataset);
		const marker = markers.get(row.dataset);
		if (marker === undefined || !marker.warned) {
			actions.push({ type: "breach", dataset: row.dataset, commit: row.lagging_commit, lagSeconds: row.trigger_lag_seconds, ...(row.corpus === undefined ? {} : { corpus: row.corpus }) });
		}
	}
	for (const [dataset, marker] of markers) {
		if (!lagging.has(dataset)) actions.push({ type: "recover", dataset, commit: marker.commit, warned: marker.warned });
	}
	return actions;
}

/** Summary and payload strings stay short whatever a caller put in the commit. */
const COMMIT_MAX = 64;

/** The `warning` for one dataset entering the breach: the commit, the wait and the threshold, never content. */
export function lagWarningEvent(action: Extract<LagAction, { type: "breach" }>, settings: FreshnessSettings): EventInput {
	if (action.dataset === CORPUS_FRESHNESS_DATASET) {
		const verdict: CorpusVerdict = action.corpus ?? { breaches: ["ingest_age"] };
		const ageOver = verdict.breaches.includes("ingest_age");
		const parts: string[] = [];
		if (ageOver) parts.push(`last ingest ${Math.round(action.lagSeconds / 3600)} h ago${settings.corpusMaxAgeS === undefined ? "" : `, over the ${Math.round(settings.corpusMaxAgeS / 3600)} h limit`}`);
		if (verdict.sync !== undefined) parts.push(`sync lag ${verdict.sync.lag_seconds} s, over the ${verdict.sync.threshold_seconds} s objective`);
		return {
			surface: "substrate",
			kind: "warning",
			summary: `docs corpus: ${parts.join("; ")}`,
			session_id: `docs-freshness:${CORPUS_FRESHNESS_DATASET}`,
			payload: {
				action: "docs.freshness",
				runtime: "docs-freshness",
				state: "lagging",
				dataset: CORPUS_FRESHNESS_DATASET,
				lag_seconds: action.lagSeconds,
				breaches: verdict.breaches,
				...(ageOver && settings.corpusMaxAgeS !== undefined ? { threshold_seconds: settings.corpusMaxAgeS } : {}),
				...(verdict.sync === undefined ? {} : { sync_lag_seconds: verdict.sync.lag_seconds, sync_threshold_seconds: verdict.sync.threshold_seconds }),
			},
		};
	}
	const commit = action.commit.slice(0, COMMIT_MAX);
	return {
		surface: "substrate",
		kind: "warning",
		summary: `docs ${action.dataset}: merge-trigger for ${commit.slice(0, 12)} has no recorded ingest after ${Math.round(action.lagSeconds / 60)} min`,
		session_id: `docs-freshness:${action.dataset}`,
		payload: {
			action: "docs.freshness",
			runtime: "docs-freshness",
			state: "lagging",
			dataset: action.dataset,
			commit,
			lag_seconds: action.lagSeconds,
			threshold_minutes: settings.triggerLagMinutes,
		},
	};
}

/** The `note` when the breach clears: the marker that makes the dedupe's end visible on the ledger. */
export function lagRecoveryEvent(action: Extract<LagAction, { type: "recover" }>, settings: FreshnessSettings): EventInput {
	if (action.dataset === CORPUS_FRESHNESS_DATASET) {
		return {
			surface: "substrate",
			kind: "note",
			summary: "docs corpus: back within its freshness and sync objectives",
			session_id: `docs-freshness:${CORPUS_FRESHNESS_DATASET}`,
			payload: { action: "docs.freshness", runtime: "docs-freshness", state: "recovered", dataset: CORPUS_FRESHNESS_DATASET, ...(settings.corpusMaxAgeS === undefined ? {} : { threshold_seconds: settings.corpusMaxAgeS }) },
		};
	}
	const commit = action.commit.slice(0, COMMIT_MAX);
	return {
		surface: "substrate",
		kind: "note",
		summary: `docs ${action.dataset}: merge-trigger lag cleared (${commit.slice(0, 12)})`,
		session_id: `docs-freshness:${action.dataset}`,
		payload: {
			action: "docs.freshness",
			runtime: "docs-freshness",
			state: "recovered",
			dataset: action.dataset,
			commit,
			threshold_minutes: settings.triggerLagMinutes,
		},
	};
}

/** The side effects a lag transition needs, injected so tests supply their own. */
export interface LagEffects {
	/** Persist the markers; called after each marker change and never throws. */
	persist(): Promise<void>;
	/** The existing event path; a rejection is caught here. */
	emit(event: EventInput): Promise<unknown>;
	/** One line to stderr for a failed emit; never carries the commit. */
	report(line: string): void;
}

/** What one pass did: the transitions that completed, and those that failed and stay owed. */
export interface LagOutcome {
	applied: LagAction[];
	failed: LagAction[];
}

/**
 * Emit one event and treat a resolved `stored: false` (ledger unavailable or
 * refused the write) as a failed delivery, exactly like a throw: the caller's
 * marker stays as it was so a later pass retries.
 */
async function deliver(effects: LagEffects, event: EventInput): Promise<void> {
	const result = await effects.emit(event);
	if (result !== null && typeof result === "object" && "stored" in result && result.stored === false) {
		throw new Error("event not stored");
	}
}

/**
 * Apply the transitions in order. A breach writes its marker (not yet
 * `warned`) and persists it before emitting, and flips `warned` only once the
 * emit succeeded; a failed emit leaves the marker, so a later pass retries.
 * A recovery emits first and drops the marker only on success, so a lost note
 * is retried too; a breach that was never announced clears silently. No
 * failure here reaches the caller.
 */
export async function applyLagActions(
	actions: readonly LagAction[],
	markers: LagMarkers,
	settings: FreshnessSettings,
	nowIso: string,
	effects: LagEffects,
): Promise<LagOutcome> {
	const outcome: LagOutcome = { applied: [], failed: [] };
	for (const action of actions) {
		try {
			if (action.type === "breach") {
				const marker = markers.get(action.dataset) ?? { since: nowIso, commit: action.commit, warned: false };
				markers.set(action.dataset, marker);
				await effects.persist();
				await deliver(effects, lagWarningEvent(action, settings));
				marker.warned = true;
				await effects.persist();
			} else if (!action.warned) {
				markers.delete(action.dataset);
				await effects.persist();
			} else {
				await deliver(effects, lagRecoveryEvent(action, settings));
				markers.delete(action.dataset);
				await effects.persist();
			}
			outcome.applied.push(action);
		} catch {
			outcome.failed.push(action);
			effects.report(`docs freshness: ${action.type} for ${action.dataset} was not recorded; will retry no sooner than ${LAG_RETRY_MS / 1000} s from now`);
		}
	}
	return outcome;
}

/** Least time between two attempts to deliver the same dataset's transition after a failure. */
export const LAG_RETRY_MS = 60_000;

/** Longest `startDocsRefresh` waits for the accepted-trigger record before answering anyway. */
export const TRIGGER_RECORD_DEADLINE_MS = 500;

/** Longest an emit may take before it counts as a failure; a hung ledger must not pin the settler. */
export const LAG_EMIT_DEADLINE_MS = 5_000;

export interface LagSettlerOptions {
	retryMs?: number;
	emitDeadlineMs?: number;
}

/** Rejects when `work` has not settled inside `ms`; the timer is unref'd and cleared on every exit. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const handle = setTimeout(() => expired.reject(new Error("deadline exceeded")), ms);
	handle.unref();
	return Promise.race([work, expired.promise]).finally(() => clearTimeout(handle));
}

/**
 * Runs lag transitions off the request path. `settle` returns at once: it
 * starts at most ONE background pass (a call while one is in flight joins
 * nothing and starts nothing), skips any dataset still inside its retry
 * interval after a failure, bounds every emit by a deadline, and logs a pass
 * that throws once. The caller never waits for it.
 */
export class LagSettler {
	#flight: Promise<void> | null = null;
	readonly #retryAt = new Map<string, number>();
	readonly #retryMs: number;
	readonly #emitDeadlineMs: number;

	constructor(
		private readonly markers: LagMarkers,
		private readonly effects: LagEffects,
		options: LagSettlerOptions = {},
	) {
		this.#retryMs = options.retryMs ?? LAG_RETRY_MS;
		this.#emitDeadlineMs = options.emitDeadlineMs ?? LAG_EMIT_DEADLINE_MS;
	}

	/** The pass in flight, for a test to await; null when idle. */
	get flight(): Promise<void> | null {
		return this.#flight;
	}

	/** Start a background pass for what `rows` and the markers call for; true when one started. */
	settle(rows: readonly DatasetFreshness[], settings: FreshnessSettings, now: number): boolean {
		if (this.#flight !== null) return false;
		const owed = planLagTransitions(rows, this.markers).filter((action) => (this.#retryAt.get(action.dataset) ?? 0) <= now);
		if (owed.length === 0) return false;
		const effects: LagEffects = { ...this.effects, emit: (event) => withDeadline(this.effects.emit(event), this.#emitDeadlineMs) };
		const flight = applyLagActions(owed, this.markers, settings, new Date(now).toISOString(), effects)
			.then((outcome) => {
				for (const action of outcome.applied) this.#retryAt.delete(action.dataset);
				for (const action of outcome.failed) this.#retryAt.set(action.dataset, now + this.#retryMs);
			})
			.catch(() => this.effects.report("docs freshness: a lag pass failed unexpectedly"))
			.finally(() => {
				this.#flight = null;
			});
		this.#flight = flight;
		return true;
	}
}
