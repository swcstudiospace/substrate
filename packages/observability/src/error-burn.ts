/**
 * The error/timeout burn detector (phase 86, E5).
 *
 * The quota-burn objectives in `burn.ts` judge spend; this one judges plane
 * health: the share of `substrate.plane.duration` observations that ended in
 * `error` or `timeout` (an `open` refusal is the caller not getting an answer,
 * so it burns too). Pure like every other evaluator: counts in, verdict out,
 * no I/O, no clock except the caller-supplied `nowMs`.
 */
import { findHistogram, mergeHistogram, type MetricSnapshot } from "./metrics.ts";
import { METRIC } from "./instruments.ts";

export const ERROR_BURN_ID = "burn.plane_errors";

export type ErrorBurnStatus = "ok" | "breached" | "insufficient-data";

/** One error-burn verdict; the field shape mirrors `BurnResult` so `/slo` and `/healthz` read alike. */
export interface ErrorBurnResult {
	id: typeof ERROR_BURN_ID;
	title: string;
	status: ErrorBurnStatus;
	/** `(error + timeout + open) / total`, or null under `minSamples`. */
	observed: number | null;
	/** Total observations inside the window. */
	samples: number;
	target: number;
	detail: string;
}

/** The bad-outcome counts inside one window. */
export interface ErrorBurnCounts {
	ok: number;
	error: number;
	timeout: number;
	open: number;
}

export interface ErrorBurnOptions {
	/** Ceiling on the bad-outcome share; default 1 %. */
	target?: number;
	/** Calls needed before the objective is judged; default 20 (the SLO floor). */
	minSamples?: number;
}

export const DEFAULT_ERROR_BURN_TARGET = 0.01;
export const DEFAULT_ERROR_BURN_MIN_SAMPLES = 20;

/** Judge already-counted outcomes. Sums defensively: negatives and NaN read as zero. */
export function evaluateErrorBurn(counts: ErrorBurnCounts, options: ErrorBurnOptions = {}): ErrorBurnResult {
	const target = options.target ?? DEFAULT_ERROR_BURN_TARGET;
	const minSamples = options.minSamples ?? DEFAULT_ERROR_BURN_MIN_SAMPLES;
	const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
	const ok = clean(counts.ok);
	const bad = clean(counts.error) + clean(counts.timeout) + clean(counts.open);
	const total = ok + bad;
	const base = {
		id: ERROR_BURN_ID as typeof ERROR_BURN_ID,
		title: "Plane error burn",
		target,
	};
	if (total < minSamples) {
		return {
			...base,
			status: "insufficient-data",
			observed: total > 0 ? bad / total : null,
			samples: total,
			detail: `${total} of ${minSamples} plane calls needed before the error burn is judged`,
		};
	}
	const observed = bad / total;
	return {
		...base,
		status: observed > target ? "breached" : "ok",
		observed,
		samples: total,
		detail:
			`${bad} of ${total} plane calls ended in error/timeout/open ` +
			`(${(observed * 100).toFixed(3)} %) against a ${(target * 100).toFixed(2)} % ceiling`,
	};
}

/**
 * Judge a metric snapshot, counting `substrate.plane.duration` histogram
 * observations by outcome. An absent histogram (or one with no series) reads
 * as zero observations, hence `insufficient-data` — never `ok` on no data.
 */
export function evaluateErrorBurnFromSnapshot(
	snapshot: MetricSnapshot[],
	options: ErrorBurnOptions = {},
): ErrorBurnResult {
	const histogram = findHistogram(snapshot, METRIC.planeDuration);
	if (!histogram) {
		return evaluateErrorBurn({ ok: 0, error: 0, timeout: 0, open: 0 }, options);
	}
	const count = (outcome?: string): number =>
		mergeHistogram(histogram, outcome === undefined ? {} : { outcome }).count;
	return evaluateErrorBurn(
		{
			ok: count("ok"),
			error: count("error"),
			timeout: count("timeout"),
			open: count("open"),
		},
		options,
	);
}
