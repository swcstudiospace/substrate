/**
 * The quota-burn objectives, and the evaluator that answers them from a metric
 * snapshot (SPE-10477, uplift U4).
 *
 * Two ceilings over what the host is spending per rolling hour, computed from the
 * same cumulative series the catalogue SLOs read:
 *
 *   - `burn.tokens`    — sum of `substrate.tokens` (input + output) per hour
 *                        against `SUBSTRATE_BURN_TOKENS_PER_HOUR`.
 *   - `burn.cost_usd`  — sum of `substrate.cost.usd` per hour against
 *                        `SUBSTRATE_BURN_COST_USD_PER_HOUR`.
 *
 * They live beside `slo.ts`'s catalogue rather than in it, for one reason: the
 * catalogue is exactly the four objectives SPE-4793 states, and consumers pin that
 * list (the evidence bundle, the `/slo` id assertions). The burn objectives are
 * operator-configured — an env var is the difference between judged and unjudged —
 * so they surface as a sibling `burn` array on `GET /slo`, in the same entry shape
 * the catalogue verdicts use. The dispatcher's storm-breaker reads that array.
 *
 * A rolling window over a cumulative counter needs memory, which one snapshot
 * cannot carry: `BurnLedger` remembers recent totals per metric, and every
 * evaluation both feeds it and reads from it. `GET /slo` is scraped regularly (the
 * dispatcher ticks every 30 s, monitors scrape besides), so the window fills at
 * scrape frequency with no exporter involved.
 *
 * Judging is conservative on purpose:
 *
 *   - an unset or malformed threshold reports `unconfigured` — the objective is
 *     named, never judged, and can never breach;
 *   - fewer than two samples spanning `minSpanMs` report `insufficient-data`,
 *     because a rate taken from a single reading would be fiction;
 *   - once judged, the per-hour rate is extrapolated from the oldest sample still
 *     inside the window, so a storm is caught in minutes rather than after a full
 *     hour of history.
 */
import type { MetricSnapshot } from "./metrics.ts";
import { findCounter, sumCounter } from "./metrics.ts";
import { METRIC } from "./instruments.ts";

/** The rolling window every burn objective is judged over: one hour. */
export const BURN_WINDOW_MS = 60 * 60 * 1000;

/**
 * Minimum span two samples must cover before a rate is taken from them.
 *
 * Extrapolating a per-hour figure from two readings milliseconds apart amplifies
 * noise into verdicts: a single burst of tokens across a one-second span would
 * read as a storm. Five minutes of coverage is the smallest span a per-hour rate
 * is honest about; before that the objective says `insufficient-data`.
 */
export const BURN_MIN_SPAN_MS = 5 * 60 * 1000;

/** Samples kept per metric; the window is what bounds the useful history anyway. */
export const BURN_MAX_SAMPLES = 480;

export const BURN_TOKENS_ID = "burn.tokens";
export const BURN_COST_ID = "burn.cost_usd";

export const TOKENS_BURN_ENV = "SUBSTRATE_BURN_TOKENS_PER_HOUR";
export const COST_BURN_ENV = "SUBSTRATE_BURN_COST_USD_PER_HOUR";

/** Ceilings an operator can set without touching code; `null` is unconfigured. */
export interface BurnThresholds {
	/** Max model tokens (input + output) per rolling hour. */
	tokensPerHour: number | null;
	/** Max spend in USD per rolling hour. */
	costUsdPerHour: number | null;
}

export type BurnStatus = "ok" | "breached" | "unconfigured" | "insufficient-data";

/** One burn verdict; the field shape mirrors `SloResult` so `/slo` reads alike. */
export interface BurnResult {
	id: string;
	title: string;
	statement: string;
	status: BurnStatus;
	/** The measured per-hour rate, or `null` before one exists. */
	observed: number | null;
	unit: "tokens/h" | "USD/h";
	/** The configured ceiling, or `null` when unconfigured. */
	target: number | null;
	samples: number;
	/** One sentence a human reads instead of the numbers. */
	detail: string;
}

/** What one `BurnLedger.observe` answers: a rate when the span supports one. */
export interface BurnReading {
	/** Extrapolated per-hour delta, or `null` before two samples span `minSpanMs`. */
	perHour: number | null;
	/** The span the rate (or would-be rate) was taken over. */
	spanMs: number;
	/** Samples retained inside the window, this observation included. */
	samples: number;
}

export interface BurnSample {
	atMs: number;
	total: number;
}

/**
 * Recent cumulative totals of one monotonic series per metric, remembered so a
 * rate can be taken over the rolling window.
 *
 * Entries older than the window are dropped on every observation, and reads
 * within the same wall-clock second coalesce into one sample, so the retained
 * history stays bounded — and long enough to judge — no matter how often the
 * evaluator runs. A total that goes
 * backwards is a counter reset — a restart gave the process a fresh registry — and
 * the history is dropped rather than divided: subtracting across a reset would
 * read the restart itself as negative spend.
 *
 * `prior` (uplift-3 N2) is the history a checkpoint carried across a restart,
 * copied in and capped as observed samples are. Its totals came from a merged
 * snapshot, so the first live reading on a restored registry is never below
 * them and the restart is not read as a reset.
 */
export class BurnLedger {
	readonly #byMetric = new Map<string, BurnSample[]>();

	constructor(
		readonly windowMs: number = BURN_WINDOW_MS,
		readonly minSpanMs: number = BURN_MIN_SPAN_MS,
		prior: Record<string, readonly BurnSample[]> = {},
	) {
		for (const [metric, samples] of Object.entries(prior)) {
			if (samples.length === 0) continue;
			this.#byMetric.set(metric, samples.slice(-BURN_MAX_SAMPLES).map((sample) => ({ ...sample })));
		}
	}

	/** Every retained sample per metric, copied, for a checkpoint to carry. */
	export(): Record<string, BurnSample[]> {
		const out: Record<string, BurnSample[]> = {};
		for (const [metric, samples] of this.#byMetric) {
			if (samples.length > 0) out[metric] = samples.map((sample) => ({ ...sample }));
		}
		return out;
	}

	/** Record one observation of `metric` and answer the per-hour rate it supports. */
	observe(metric: string, total: number, atMs: number): BurnReading {
		const samples = this.#byMetric.get(metric) ?? [];
		while (samples.length > 0 && samples[0]!.atMs < atMs - this.windowMs) samples.shift();
		const last = samples[samples.length - 1];
		if (last !== undefined && total < last.total) samples.length = 0;
		// Reads landing in the same wall-clock second coalesce into one sample.
		// The cap below bounds samples by count, so without this a reader polling
		// faster than once a second fills the ring with sub-second spacing — 480
		// reads at 2 Hz is four minutes of span, under the five-minute minimum,
		// and a busy /slo poller would keep both burn checks `insufficient-data`
		// forever. At the cap the ring now holds 480 distinct seconds (eight
		// minutes) whatever the read rate; slower readers are bounded by the
		// window instead, as before.
		if (
			samples.length > 0 &&
			Math.floor(samples[samples.length - 1]!.atMs / 1000) === Math.floor(atMs / 1000)
		) {
			const current = samples[samples.length - 1]!;
			current.atMs = atMs;
			current.total = total;
		} else {
			samples.push({ atMs, total });
		}
		if (samples.length > BURN_MAX_SAMPLES) samples.splice(0, samples.length - BURN_MAX_SAMPLES);
		this.#byMetric.set(metric, samples);

		// `push` guarantees at least one entry, so the base read after it is safe.
		const base = samples[0]!;
		const spanMs = atMs - base.atMs;
		const perHour =
			spanMs > 0 && spanMs >= this.minSpanMs && total >= base.total
				? ((total - base.total) * this.windowMs) / spanMs
				: null;
		return { perHour, spanMs, samples: samples.length };
	}
}

let sharedLedger: BurnLedger | null = null;
/** The process-wide ledger the default evaluator feeds; `/slo` scrapes are its samples. */
export function sharedBurnLedger(): BurnLedger {
	sharedLedger ??= new BurnLedger();
	return sharedLedger;
}

const warnedAbout = new Set<string>();
function warnOnce(message: string): void {
	if (warnedAbout.has(message)) return;
	warnedAbout.add(message);
	process.stderr.write(`[substrate] misconfigured — ${message}\n`);
}

function thresholdFrom(env: Record<string, string | undefined>, key: string, warn: (message: string) => void): number | null {
	const raw = env[key];
	if (raw === undefined || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		const quoted = raw.length > 40 ? `${raw.slice(0, 37)}...` : raw;
		warn(
			`${key} is set to ${JSON.stringify(quoted)}, which is not a non-negative number; ` +
				"the burn objective it configures is treated as unset",
		);
		return null;
	}
	return value;
}

/**
 * Read the two ceilings from the environment. Malformed values are treated as
 * unset, with one warning per variable — the same tolerance the OTLP and SLO
 * settings get, because a typo must not crash-loop a substrate an operator is
 * only tuning.
 */
export function loadBurnThresholds(
	env: Record<string, string | undefined> = process.env,
	warn: (message: string) => void = warnOnce,
): BurnThresholds {
	return {
		tokensPerHour: thresholdFrom(env, TOKENS_BURN_ENV, warn),
		costUsdPerHour: thresholdFrom(env, COST_BURN_ENV, warn),
	};
}

export interface BurnTarget {
	id: string;
	title: string;
	/** The cumulative series the per-hour rate is taken over. */
	metric: string;
	/** The env var whose number is the ceiling; named so an unset objective explains itself. */
	env: string;
	unit: "tokens/h" | "USD/h";
	threshold: number | null;
	statement: string;
}

export function burnTargets(thresholds: BurnThresholds): BurnTarget[] {
	// Tokens are whole counts; USD carries cents. Both are display forms only — the
	// verdict compares raw numbers — but the statement and the verdict sentence must
	// agree on the spelling, so each site spells its unit the same way.
	const tokensCeiling = thresholds.tokensPerHour === null ? null : `${Math.round(thresholds.tokensPerHour)} tokens`;
	const usdCeiling = thresholds.costUsdPerHour === null ? null : `${thresholds.costUsdPerHour.toFixed(2)} USD`;
	return [
		{
			id: BURN_TOKENS_ID,
			title: "Token burn",
			metric: METRIC.tokens,
			env: TOKENS_BURN_ENV,
			unit: "tokens/h",
			threshold: thresholds.tokensPerHour,
			statement:
				tokensCeiling === null
					? `sum of ${METRIC.tokens} (input + output) per rolling hour, ceiling from ${TOKENS_BURN_ENV} (unset)`
					: `sum of ${METRIC.tokens} (input + output) per rolling hour <= ${tokensCeiling}`,
		},
		{
			id: BURN_COST_ID,
			title: "Cost burn",
			metric: METRIC.cost,
			env: COST_BURN_ENV,
			unit: "USD/h",
			threshold: thresholds.costUsdPerHour,
			statement:
				usdCeiling === null
					? `sum of ${METRIC.cost} per rolling hour, ceiling from ${COST_BURN_ENV} (unset)`
					: `sum of ${METRIC.cost} per rolling hour <= ${usdCeiling}`,
		},
	];
}

function evaluateBurn(snapshot: MetricSnapshot[], target: BurnTarget, ledger: BurnLedger, nowMs: number): BurnResult {
	const base = {
		id: target.id,
		title: target.title,
		statement: target.statement,
		unit: target.unit,
		target: target.threshold,
	};
	if (target.threshold === null) {
		return {
			...base,
			status: "unconfigured",
			observed: null,
			samples: 0,
			detail: `${target.env} is unset, so this objective is reported but never judged`,
		};
	}
	const counter = findCounter(snapshot, target.metric);
	if (!counter) {
		return {
			...base,
			status: "insufficient-data",
			observed: null,
			samples: 0,
			detail: `${target.metric} has no series yet`,
		};
	}
	// No `where` filter on purpose: the burn ceiling is over everything the host
	// spends, and the counter already splits input and output by `direction`, so the
	// unfiltered sum is exactly input + output.
	const reading = ledger.observe(target.metric, sumCounter(counter), nowMs);
	if (reading.perHour === null) {
		return {
			...base,
			status: "insufficient-data",
			observed: null,
			samples: reading.samples,
			detail:
				`${reading.samples} sample(s) span ${Math.round(reading.spanMs / 1000)} s; a rate needs two samples ` +
				`at least ${Math.round(ledger.minSpanMs / 60_000)} minute(s) apart, and every /slo read feeds one`,
		};
	}
	// A ceiling: exactly at it is met, past it is breached, matching the
	// ratio-ceiling objectives in the catalogue.
	const breached = reading.perHour > target.threshold;
	// Same spellings `burnTargets` uses in the statement: whole tokens, cents for USD.
	const fmt = (value: number) => (target.unit === "USD/h" ? value.toFixed(2) : `${Math.round(value)}`);
	const verdict =
		`${fmt(reading.perHour)} ${target.unit} over the rolling hour, extrapolated from ${reading.samples} samples ` +
		`spanning ${Math.round(reading.spanMs / 60_000)} minute(s)`;
	return {
		...base,
		status: breached ? "breached" : "ok",
		observed: reading.perHour,
		samples: reading.samples,
		detail: `${verdict}; ${breached ? `over the ${fmt(target.threshold)} ${target.unit} ceiling` : `within the ${fmt(target.threshold)} ${target.unit} ceiling`}`,
	};
}

export interface BurnEvalOptions {
	/** Environment the ceilings are read from; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Sample history; defaults to the process-wide ledger every evaluation feeds. */
	ledger?: BurnLedger;
	/** Evaluation time in epoch milliseconds; defaults to now. */
	now?: number;
	/** Where malformed-env warnings go; defaults to one stderr line per variable. */
	warn?: (message: string) => void;
}

/**
 * Evaluate both burn objectives against a metric snapshot.
 *
 * Both objectives are always answered — `unconfigured` when their ceiling is not
 * set — so a reader can tell "not judged" from "absent". The window memory lives
 * in the ledger, not the snapshot: successive evaluations are the samples.
 */
export function evaluateBurnSlos(snapshot: MetricSnapshot[], options: BurnEvalOptions = {}): BurnResult[] {
	const ledger = options.ledger ?? sharedBurnLedger();
	const now = options.now ?? Date.now();
	return burnTargets(loadBurnThresholds(options.env ?? process.env, options.warn ?? warnOnce)).map((target) =>
		evaluateBurn(snapshot, target, ledger, now),
	);
}
