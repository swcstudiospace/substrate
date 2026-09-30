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
			// `<`, as SPE-4793 words it. A bucket bound is an inclusive upper edge in OTLP,
			// so the histogram cannot decide the strict question at the boundary — but the
			// answer to that is to report which of the three cases holds, not to restate the
			// objective as the one the data happens to be able to answer. See
			// `evaluateLatency`.
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
 * estimate. If the threshold is not one of the histogram's bounds the objective is
 * `unmeasurable` rather than quietly interpolated: a bucketed histogram genuinely
 * cannot answer it, and saying so is the honest result.
 *
 * **The objective is strict, and the boundary does not count as met.** SPE-4793 states
 * it as `p95 < 800 ms`, and a bucket bound is an *inclusive* upper edge in OTLP: the
 * 800 ms bucket holds `(400, 800]`, so no bucketed histogram can separate 800.000 from
 * 799.999. Judging on the at-or-below count therefore marked a run of briefs at exactly
 * 800 ms as met — a green verdict at the objective's own failure boundary.
 *
 * Two counts bracket the truth, and the verdict says which of three cases holds:
 *
 *   - at least 95 % **below** the threshold → `ok`. Proven, not inferred.
 *   - fewer than 95 % **at or below** it → `breached`. Also proven.
 *   - in between → the boundary bucket decides it and the histogram cannot say which
 *     way, so `unmeasurable`, naming the band. Not `ok`, because the objective has not
 *     been met; not `breached`, because it may well have been — and `breaches` leaves
 *     it out, so it does not fail an evidence bundle on a maybe. An operator who needs
 *     a verdict inside that band narrows it with a bucket bound just under the
 *     threshold.
 *
 * Two alternatives were considered and are worse. Restating the objective as
 * `<= 800 ms` makes the check exact by weakening the claim, and still hands out `ok`
 * at the boundary the ticket names as failure. Bucketing with `<` so the bound became
 * exclusive makes the strict check exact locally at the cost of misreporting bucket
 * membership to every standard collector: the exported histogram has to mean what OTLP
 * says it means.
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

	if (below >= target.quantile) {
		return {
			...measured,
			status: "ok",
			detail:
				`${(below * 100).toFixed(2)} % of ${merged.count} observations were below ${target.thresholdMs} ms ` +
				`(need ${need}); ${p95}`,
		};
	}
	if (atOrBelow < target.quantile) {
		return {
			...measured,
			status: "breached",
			detail:
				`${(atOrBelow * 100).toFixed(2)} % of ${merged.count} observations were at or below ${target.thresholdMs} ms ` +
				`(need ${need} below it); ${p95}`,
		};
	}
	// The objective is strict and the bucket ending at the threshold includes the
	// threshold itself. Everything that would decide this verdict sits in that bucket,
	// so the answer is "the data cannot say" rather than a green tick at the very
	// boundary the objective names as failure.
	const lower = merged.bounds[merged.bounds.indexOf(target.thresholdMs) - 1] ?? 0;
	return {
		...measured,
		status: "unmeasurable",
		detail:
			`${(below * 100).toFixed(2)} % of ${merged.count} observations were below ${target.thresholdMs} ms and ` +
			`${(atOrBelow * 100).toFixed(2)} % at or below it (need ${need} below), so the verdict turns on the ` +
			`${lower}–${target.thresholdMs} ms bucket, which includes ${target.thresholdMs} ms itself and cannot be split; ` +
			p95,
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
