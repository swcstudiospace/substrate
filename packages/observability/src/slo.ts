/**
 * The substrate's service-level objectives, and the evaluator that answers them
 * from a metric snapshot.
 *
 * Four objectives, stated in SPE-4793:
 *
 *   1. brief p95 <= 800 ms           — the brief is on the critical path of every
 *                                      prompt and the uplift hook's budget is
 *                                      1.5 s, so 800 ms leaves room for the hook.
 *                                      SPE-4793 words it `< 800 ms`; 800 is an
 *                                      *inclusive* bucket edge in OTLP, so `<=` is
 *                                      the strongest form a conformant histogram
 *                                      can decide there. See `evaluateLatency`.
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
import {
	exactFractionAtOrBelow,
	exactFractionBelow,
	findCounter,
	findHistogram,
	mergeHistogram,
	quantileFromBuckets,
	sumCounter,
} from "./metrics.ts";
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
			// `<=`, not the `<` SPE-4793 words it with, and the statement says so rather than
			// printing a claim the check does not make. A bucket bound is an inclusive upper
			// edge in OTLP, so the finest question this histogram can decide at 800 is
			// `<= 800 ms`; the gap between the two is the single value 800.000 ms. See
			// `evaluateLatency` for why the strict reading is the worse trade.
			statement: `p95 of ${METRIC.briefDuration} <= ${t.briefP95Ms} ms`,
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
 * estimate. If the threshold is not one of the histogram's bounds the objective is
 * `unmeasurable` rather than quietly interpolated: a bucketed histogram genuinely
 * cannot answer it, and saying so is the honest result.
 *
 * **The threshold is an inclusive bucket edge, and the objective is stated to match.**
 * SPE-4793 words it `p95 < 800 ms`. A bucket bound is an *inclusive* upper edge in
 * OTLP: the 800 ms bucket holds `(400, 800]`, so no bucketed histogram can separate
 * 800.000 from 799.999. The at-or-below count is therefore the verdict, and the
 * catalogue states the objective as `<= 800 ms` — the strongest form this data can
 * decide — instead of printing `<` and answering something else.
 *
 *   - at least 95 % **at or below** the threshold → `ok`.
 *   - fewer than 95 % at or below it → `breached`.
 *   - the threshold is not one of the histogram's bounds → `unmeasurable`, because a
 *     bucketed histogram genuinely cannot answer that one.
 *
 * The honesty the strict reading was protecting is kept in the detail, not in the
 * verdict: when the boundary bucket is what carries the run over the line — at or
 * below the threshold but not provably below it — the sentence says so, names the
 * bucket, and says that briefs at exactly 800 ms were counted as meeting the
 * objective. An operator who needs those ruled out narrows the check with a bucket
 * bound just under the threshold.
 *
 * Judging on the **below** count instead is the trade this replaces, and it is much
 * worse than it looks. It does not make the strict question answerable; it moves the
 * only provable pass down to the next bound, so `p95 < 800 ms` is enforced as
 * `p95 <= 400 ms` and every healthy run whose p95 lands anywhere in `(400, 800]` —
 * the band the objective exists to allow — reports `unmeasurable`. Silently doubling
 * an objective's strictness is a larger misstatement than counting the single value
 * 800.000 ms as met, and an SLO no healthy service can pass is not a conservative
 * SLO, it is a broken one.
 *
 * Bucketing with `<` so the bound became exclusive was the other alternative, and is
 * also worse: it makes the strict check exact locally at the cost of misreporting
 * bucket membership to every standard collector, and the exported histogram has to
 * mean what OTLP says it means.
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
	const atOrBelow = exactFractionAtOrBelow(merged, target.thresholdMs);
	const below = exactFractionBelow(merged, target.thresholdMs);
	if (atOrBelow === null || below === null) {
		return {
			...base,
			status: "unmeasurable",
			observed: estimate,
			samples: merged.count,
			detail: `${target.thresholdMs} ms is not one of this histogram's bucket bounds, so the quantile cannot be checked exactly`,
		};
	}
	const p95 = `interpolated p95 ${estimate === null ? `> ${merged.bounds[merged.bounds.length - 1]}` : estimate.toFixed(0)} ms`;
	const need = `${(target.quantile * 100).toFixed(0)} %`;
	const measured = { ...base, observed: estimate, samples: merged.count };

	if (atOrBelow < target.quantile) {
		return {
			...measured,
			status: "breached",
			detail:
				`${(atOrBelow * 100).toFixed(2)} % of ${merged.count} observations were at or below ${target.thresholdMs} ms ` +
				`(need ${need}); ${p95}`,
		};
	}
	if (below >= target.quantile) {
		return {
			...measured,
			status: "ok",
			detail:
				`${(below * 100).toFixed(2)} % of ${merged.count} observations were below ${target.thresholdMs} ms ` +
				`(need ${need}); ${p95}`,
		};
	}
	// Met, and the bucket ending at the threshold is what carries it. That bucket's
	// upper edge is inclusive, so this is the one case where `ok` rests on counting
	// observations of exactly the threshold as met. Say it in the sentence rather than
	// hand out an unqualified green tick.
	const lower = merged.bounds[merged.bounds.indexOf(target.thresholdMs) - 1] ?? 0;
	return {
		...measured,
		status: "ok",
		detail:
			`${(atOrBelow * 100).toFixed(2)} % of ${merged.count} observations were at or below ${target.thresholdMs} ms ` +
			`(need ${need}), but only ${(below * 100).toFixed(2)} % provably below it, so the verdict rests on the ` +
			`${lower}–${target.thresholdMs} ms bucket, whose upper edge is inclusive: briefs at exactly ` +
			`${target.thresholdMs} ms count as meeting it. Narrow the check with a bucket bound under ` +
			`${target.thresholdMs} ms to rule them out; ${p95}`,
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
