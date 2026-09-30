/**
 * The substrate's service-level objectives, and the evaluator that answers them
 * from a metric snapshot.
 *
 * Four objectives, stated in SPE-4793:
 *
 *   1. brief p95 < 800 ms            — the brief is on the critical path of every
 *                                      prompt and the uplift hook's budget is
 *                                      1.5 s, so 800 ms leaves room for the hook.
 *   2. emit success ≥ 99.5 %         — appends are fail-closed at the ledger, so a
 *                                      dropped event is a hole in the trail.
 *   3. lease-steal rate ≤ 0.5 %      — two agents believing they hold one node is
 *                                      the failure claims exist to prevent.
 *   4. quarantine rate ≤ 1 %         — a node the substrate withdraws is work no
 *                                      agent picks up.
 *
 * An objective with too few observations reports `insufficient-data`, never `ok`.
 * A green SLO computed from three samples is worse than no SLO: it is a claim the
 * data does not support, and it is exactly what an evidence bundle must not carry.
 */
import type { MetricSnapshot } from "./metrics.ts";
import { exactFractionAtOrBelow, findCounter, findHistogram, mergeHistogram, quantileFromBuckets, sumCounter } from "./metrics.ts";
import { METRIC } from "./instruments.ts";

export interface CounterSelector {
	metric: string;
	/** Attribute equalities every counted series must satisfy. */
	where?: Record<string, string>;
}

export type SloTarget =
	| {
			kind: "latency-quantile";
			id: string;
			title: string;
			statement: string;
			metric: string;
			quantile: number;
			/** Must be one of the histogram's own bucket bounds, so the check is exact. */
			thresholdMs: number;
			minSamples: number;
	  }
	| {
			kind: "ratio-floor" | "ratio-ceiling";
			id: string;
			title: string;
			statement: string;
			numerator: CounterSelector;
			denominator: CounterSelector;
			target: number;
			minSamples: number;
	  };

/** Thresholds an operator can move without touching code. */
export interface SloThresholds {
	briefP95Ms?: number;
	emitSuccessRatio?: number;
	leaseStealRatio?: number;
	quarantineRatio?: number;
	minSamples?: number;
}

export const DEFAULT_THRESHOLDS: Required<SloThresholds> = {
	briefP95Ms: 800,
	emitSuccessRatio: 0.995,
	// Provisional. No lease expiry exists yet (Phase 2 adds it), so there is no
	// baseline to set these from; they are ceilings chosen to be alarming rather
	// than measured, and are meant to be re-derived once claims can actually expire.
	leaseStealRatio: 0.005,
	quarantineRatio: 0.01,
	minSamples: 20,
};

export function sloCatalogue(overrides: SloThresholds = {}): SloTarget[] {
	const t = { ...DEFAULT_THRESHOLDS, ...stripUndefined(overrides) };
	return [
		{
			kind: "latency-quantile",
			id: "brief.p95",
			title: "Brief latency",
			statement: `p95 of ${METRIC.briefDuration} < ${t.briefP95Ms} ms`,
			metric: METRIC.briefDuration,
			quantile: 0.95,
			thresholdMs: t.briefP95Ms,
			minSamples: t.minSamples,
		},
		{
			kind: "ratio-floor",
			id: "emit.success",
			title: "Emit success",
			statement: `stored / total of ${METRIC.emitTotal} >= ${(t.emitSuccessRatio * 100).toFixed(2)} %`,
			numerator: { metric: METRIC.emitTotal, where: { outcome: "stored" } },
			denominator: { metric: METRIC.emitTotal },
			target: t.emitSuccessRatio,
			minSamples: t.minSamples,
		},
		{
			kind: "ratio-ceiling",
			id: "lease.steal_rate",
			title: "Lease-steal rate",
			statement: `stolen / total of ${METRIC.claims} <= ${(t.leaseStealRatio * 100).toFixed(2)} %`,
			numerator: { metric: METRIC.claims, where: { outcome: "stolen" } },
			denominator: { metric: METRIC.claims },
			target: t.leaseStealRatio,
			minSamples: t.minSamples,
		},
		{
			kind: "ratio-ceiling",
			id: "quarantine.rate",
			title: "Quarantine rate",
			statement: `${METRIC.quarantines} / ${METRIC.claims} <= ${(t.quarantineRatio * 100).toFixed(2)} %`,
			numerator: { metric: METRIC.quarantines },
			denominator: { metric: METRIC.claims },
			target: t.quarantineRatio,
			minSamples: t.minSamples,
		},
	];
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type SloStatus = "ok" | "breached" | "insufficient-data" | "unmeasurable";

export interface SloResult {
	id: string;
	title: string;
	statement: string;
	status: SloStatus;
	/** The measured value: milliseconds for a latency objective, a ratio for the rest. */
	observed: number | null;
	unit: "ms" | "ratio";
	target: number;
	samples: number;
	/** One sentence a human reads instead of the numbers. */
	detail: string;
}

/**
 * Evaluate a latency objective.
 *
 * Two numbers come out, and the distinction is the point. `observed` is the
 * interpolated p95, for reading. The **verdict** comes from the exact share of
 * observations at or below the threshold, because that is a count rather than an
 * estimate — so "p95 < 800 ms" is decided by whether at least 95 % of briefs landed
 * in a bucket ending at 800 ms. If the threshold is not one of the histogram's
 * bounds the objective is `unmeasurable` rather than quietly interpolated: a
 * bucketed histogram genuinely cannot answer it, and saying so is the honest
 * result.
 */
function evaluateLatency(snapshot: MetricSnapshot[], target: Extract<SloTarget, { kind: "latency-quantile" }>): SloResult {
	const base = {
		id: target.id,
		title: target.title,
		statement: target.statement,
		unit: "ms" as const,
		target: target.thresholdMs,
	};
	const histogram = findHistogram(snapshot, target.metric);
	if (!histogram) {
		return { ...base, status: "insufficient-data", observed: null, samples: 0, detail: `${target.metric} has no series yet` };
	}
	const merged = mergeHistogram(histogram);
	const estimate = quantileFromBuckets(merged, target.quantile);
	if (merged.count < target.minSamples) {
		return {
			...base,
			status: "insufficient-data",
			observed: estimate,
			samples: merged.count,
			detail: `${merged.count} of ${target.minSamples} observations needed before this objective is judged`,
		};
	}
	const share = exactFractionAtOrBelow(merged, target.thresholdMs);
	if (share === null) {
		return {
			...base,
			status: "unmeasurable",
			observed: estimate,
			samples: merged.count,
			detail: `${target.thresholdMs} ms is not one of this histogram's bucket bounds, so the quantile cannot be checked exactly`,
		};
	}
	const ok = share >= target.quantile;
	return {
		...base,
		status: ok ? "ok" : "breached",
		observed: estimate,
		samples: merged.count,
		detail:
			`${(share * 100).toFixed(2)} % of ${merged.count} observations were at or below ${target.thresholdMs} ms ` +
			`(need ${(target.quantile * 100).toFixed(0)} %); interpolated p95 ` +
			`${estimate === null ? `> ${merged.bounds[merged.bounds.length - 1]}` : estimate.toFixed(0)} ms`,
	};
}

function evaluateRatio(snapshot: MetricSnapshot[], target: Extract<SloTarget, { kind: "ratio-floor" | "ratio-ceiling" }>): SloResult {
	const base = {
		id: target.id,
		title: target.title,
		statement: target.statement,
		unit: "ratio" as const,
		target: target.target,
	};
	const numeratorMetric = findCounter(snapshot, target.numerator.metric);
	const denominatorMetric = findCounter(snapshot, target.denominator.metric);
	const denominator = denominatorMetric ? sumCounter(denominatorMetric, target.denominator.where) : 0;
	const numerator = numeratorMetric ? sumCounter(numeratorMetric, target.numerator.where) : 0;

	if (denominator < target.minSamples) {
		return {
			...base,
			status: "insufficient-data",
			observed: denominator > 0 ? numerator / denominator : null,
			samples: denominator,
			detail: `${denominator} of ${target.minSamples} observations needed before this objective is judged`,
		};
	}
	const observed = numerator / denominator;
	const ok = target.kind === "ratio-floor" ? observed >= target.target : observed <= target.target;
	const comparison = target.kind === "ratio-floor" ? "at least" : "at most";
	return {
		...base,
		status: ok ? "ok" : "breached",
		observed,
		samples: denominator,
		detail: `${numerator} of ${denominator} (${(observed * 100).toFixed(3)} %); objective is ${comparison} ${(target.target * 100).toFixed(3)} %`,
	};
}

export function evaluateSlos(snapshot: MetricSnapshot[], catalogue: SloTarget[] = sloCatalogue()): SloResult[] {
	return catalogue.map((target) =>
		target.kind === "latency-quantile" ? evaluateLatency(snapshot, target) : evaluateRatio(snapshot, target),
	);
}

/** Every objective that is failing. Empty means nothing is breached — not that everything is judged. */
export function breaches(results: SloResult[]): SloResult[] {
	return results.filter((result) => result.status === "breached");
}
