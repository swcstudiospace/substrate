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
 *
 * The per-plane availability objectives (uplift-2 R2) live beside the catalogue,
 * not in it — the catalogue is pinned to SPE-4793's four — and surface as a
 * sibling `planes` array on `GET /slo`, judged over a rolling hour by
 * `PlaneWindow` in the same way `burn.ts` judges spend: successive `/slo` reads
 * are the samples.
 */
import type { MetricSnapshot } from "./metrics.ts";
import {
	exactFractionAtOrBelow,
	exactFractionBelow,
	findHistogram,
	findCounter,
	mergeHistogram,
	quantileFromBuckets,
	sumCounter,
} from "./metrics.ts";
import { METRIC } from "./instruments.ts";
import { sharedBurnLedger, thresholdFrom, warnOnce, type BurnLedger } from "./burn.ts";
import { PLANES, type PlaneName } from "./breaker.ts";

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
			/** Attribute equalities the judged series must satisfy; absent means every series of the metric. */
			where?: Record<string, string>;
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
	/** Per-plane `ok / all` floor over the rolling hour; `SUBSTRATE_SLO_PLANE_AVAILABILITY`. */
	planeAvailability?: number;
	/** End-to-end docs search p95 ceiling, ms; `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS` (uplift-3 N5). */
	docsSearchP95Ms?: number;
	/** Days of index capacity runway the fitted growth must leave; `SUBSTRATE_SLO_RUNWAY_DAYS` (uplift-3 N2). */
	runwayDays?: number;
}

/**
 * What a caller may hand over. `loadObservabilityConfig` yields `undefined` for every
 * threshold the operator left unset, and `stripUndefined` keeps the default for those.
 */
export type SloOverrides = { [K in keyof SloThresholds]?: number | undefined };

export const DEFAULT_THRESHOLDS: Required<SloThresholds> = {
	briefP95Ms: 800,
	emitSuccessRatio: 0.995,
	// Provisional. No lease expiry exists yet (Phase 2 adds it), so there is no
	// baseline to set these from; they are ceilings chosen to be alarming rather
	// than measured, and are meant to be re-derived once claims can actually expire.
	leaseStealRatio: 0.005,
	quarantineRatio: 0.01,
	minSamples: 20,
	planeAvailability: 0.99,
	// uplift-3 N5: half the default shared budget, so a search that costs the
	// whole budget is a breach, not the norm.
	docsSearchP95Ms: 2000,
	// uplift-3 N2: two weeks, the lead time a volume resize or an archive run
	// needs to be scheduled rather than done during an incident.
	runwayDays: 14,
};

export function sloCatalogue(overrides: SloOverrides = {}): SloTarget[] {
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

function stripUndefined(value: SloOverrides): SloThresholds {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as SloThresholds;
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
	const merged = mergeHistogram(histogram, target.where);
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

// ── admission budgets (uplift-3 N3) ──────────────────────────────────────────

/**
 * `admission.limited_rate`: refusals ÷ decisions of `substrate.admission.decisions`,
 * at most 1 %. Beside the catalogue like the plane and burn objectives, because
 * the catalogue is pinned to SPE-4793's four. `decided` is every decision the
 * bucket itself made — `allowed`, `limited`, `shadow_limited` — so a `bypass` or a
 * `refused` (the cache not answering) neither helps nor hurts the rate; `limited` alone is
 * the numerator, so in `shadow` mode the rate is 0 whatever the shadow refusals
 * say, and the shadow count is read from the metric while the budgets are tuned.
 * 100 decisions before it is judged: a 1 % ceiling cannot be told from noise on
 * fewer.
 */
export const ADMISSION_SLO: Exclude<SloTarget, { kind: "latency-quantile" }> = {
	kind: "ratio-ceiling",
	id: "admission.limited_rate",
	title: "Admission refusal rate",
	statement: `limited / (allowed + limited + shadow_limited) of ${METRIC.admissionDecisions} <= 1.00 %`,
	numerator: { metric: METRIC.admissionDecisions, where: { decision: "limited" } },
	denominator: { metric: METRIC.admissionDecisions },
	target: 0.01,
	minSamples: 100,
};

/**
 * The bypasses are not decisions, so they are taken out of the denominator
 * rather than summed by `evaluateRatio`: a cache outage must not dilute the
 * refusal rate into `ok`.
 */
export function evaluateAdmissionSlo(snapshot: MetricSnapshot[], target = ADMISSION_SLO): SloResult {
	const counter = findCounter(snapshot, target.denominator.metric);
	const decided = counter ? sumCounter(counter) - sumCounter(counter, { decision: "bypass" }) : 0;
	const limited = counter ? sumCounter(counter, target.numerator.where) : 0;
	const base = { id: target.id, title: target.title, statement: target.statement, unit: "ratio" as const, target: target.target };
	if (decided < target.minSamples) {
		return {
			...base,
			status: "insufficient-data",
			observed: decided > 0 ? limited / decided : null,
			samples: decided,
			detail: `${decided} of ${target.minSamples} decisions needed before this objective is judged`,
		};
	}
	const observed = limited / decided;
	return {
		...base,
		status: observed <= target.target ? "ok" : "breached",
		observed,
		samples: decided,
		detail: `${limited} of ${decided} (${(observed * 100).toFixed(3)} %); objective is at most ${(target.target * 100).toFixed(3)} %`,
	};
}

/** Every objective that is failing. Empty means nothing is breached — not that everything is judged. */
export function breaches(results: SloResult[]): SloResult[] {
	return results.filter((result) => result.status === "breached");
}

// ── docs search latency (uplift-3 N5) ────────────────────────────────────────

/**
 * The docs-search latency objective: p95 of the end-to-end
 * `substrate.docs.duration` histogram <= `docsSearchP95Ms` (2,000 ms by
 * default; `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS`), judged exactly like
 * `brief.p95` — same evaluator, same `minSamples` floor, same inclusive
 * bucket-edge statement. It lives beside the catalogue, like the burn and
 * plane objectives, because the catalogue is pinned to SPE-4793's four and
 * its consumers assert that list; it surfaces as the sibling `docs` array on
 * `GET /slo` and is never folded into `breached`.
 */
export function docsSearchObjective(overrides: SloOverrides = {}): SloTarget {
	const t = { ...DEFAULT_THRESHOLDS, ...stripUndefined(overrides) };
	return {
		kind: "latency-quantile",
		id: "docs.search.p95",
		title: "Docs search latency",
		statement: `p95 of ${METRIC.docsDuration} <= ${t.docsSearchP95Ms} ms`,
		metric: METRIC.docsDuration,
		quantile: 0.95,
		thresholdMs: t.docsSearchP95Ms,
		minSamples: t.minSamples,
	};
}

/** The `docs` array `GET /slo` serves: one row, `docs.search.p95`, in the catalogue's entry shape. */
export function evaluateDocsSlos(snapshot: MetricSnapshot[], overrides: SloOverrides = {}): SloResult[] {
	return evaluateSlos(snapshot, [docsSearchObjective(overrides)]);
}

// ── per-surface brief latency (uplift-3 N7) ──────────────────────────────────

/** `SloResult` for one surface's slice of a metric: the same row shape with the surface named. */
export interface SurfaceSloResult extends SloResult {
	surface: string;
}

/**
 * `brief.p95` judged per surface: one row for every `surface` value the
 * `substrate.brief.duration` histogram has seen with at least `minSamples`
 * observations, against the same `briefP95Ms` target as the global objective.
 *
 * The global row blends every caller, so a fast CLI hides a slow bot; a
 * surface's own row is the verdict its operator wants. Rows below the floor
 * are omitted rather than reported `insufficient-data` so the array is empty
 * until there is something to say and never grows past the surfaces that
 * call. Served as the sibling `surfaces` array on `GET /slo`, in the
 * catalogue's entry shape plus `surface`, and never folded into `breached`.
 */
export function briefBySurfaceObjectives(snapshot: MetricSnapshot[], overrides: SloOverrides = {}): SurfaceSloResult[] {
	const t = { ...DEFAULT_THRESHOLDS, ...stripUndefined(overrides) };
	const histogram = findHistogram(snapshot, METRIC.briefDuration);
	if (!histogram) return [];
	const surfaces = new Set<string>();
	for (const point of histogram.points) {
		const surface = point.attributes.surface;
		if (typeof surface === "string") surfaces.add(surface);
	}
	const rows: SurfaceSloResult[] = [];
	for (const surface of [...surfaces].sort()) {
		const where = { surface };
		if (mergeHistogram(histogram, where).count < t.minSamples) continue;
		const target: Extract<SloTarget, { kind: "latency-quantile" }> = {
			kind: "latency-quantile",
			id: "brief.p95",
			title: "Brief latency",
			statement: `p95 of ${METRIC.briefDuration}{surface=${surface}} <= ${t.briefP95Ms} ms`,
			metric: METRIC.briefDuration,
			quantile: 0.95,
			thresholdMs: t.briefP95Ms,
			minSamples: t.minSamples,
			where,
		};
		rows.push({ ...evaluateLatency(snapshot, target), surface });
	}
	return rows;
}

// ── per-plane availability, over a rolling hour ──────────────────────────────

export const PLANE_AVAILABILITY_ENV = "SUBSTRATE_SLO_PLANE_AVAILABILITY";
/** The rolling window every plane objective is judged over: one hour. */
export const PLANE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Readings are coalesced into fixed time buckets, so the retained history is a
 * function of time, not of how often `/slo` is read: 360 buckets of 10 s is the
 * hour whether the poller runs once a second or once a minute. (Greptile round
 * 1: a cap on reading *count* at one-per-second coalescing kept eight minutes
 * under a 1 Hz poller and forty under a 5 s one, so failures vanished early.)
 */
export const PLANE_BUCKET_MS = 10_000;

export type PlaneSloStatus = "ok" | "breached" | "insufficient-data" | "unconfigured";

/** One plane verdict; the field shape mirrors `SloResult` so `/slo` reads alike. */
export interface PlaneSloResult {
	id: string;
	plane: PlaneName;
	title: string;
	statement: string;
	status: PlaneSloStatus;
	/** `ok / (ok + error + timeout + open)` over the window, or null before one exists. */
	observed: number | null;
	unit: "ratio";
	target: number;
	/** Calls inside the window. */
	samples: number;
	detail: string;
}

/**
 * One time bucket: the newest reading that landed in it (`atMs`, `ok`, `total`)
 * and the first (`baseAtMs`, `baseOk`, `baseTotal`). The newest decides when
 * the bucket leaves the window; the first is the baseline when the bucket is
 * the oldest kept — otherwise two readings inside one bucket (a fresh process
 * read twice within 10 s) would collapse to zero calls and never be judged.
 */
export interface PlaneCountSample {
	atMs: number;
	ok: number;
	total: number;
	baseAtMs: number;
	baseOk: number;
	baseTotal: number;
}

/** What one `PlaneWindow.observe` answers: the calls that fell inside the window. */
export interface PlaneWindowReading {
	ok: number;
	total: number;
	spanMs: number;
	samples: number;
}

/**
 * Recent cumulative `ok`/`total` call counts per plane, remembered so the share
 * over the rolling window can be taken from the oldest sample still inside it.
 *
 * Same discipline as `BurnLedger`: entries older than the window are dropped on
 * every observation, readings in the same `PLANE_BUCKET_MS` bucket coalesce (the
 * newest replaces), and a total that goes backwards is a restart, so the history
 * is dropped rather than subtracted across it. One reading alone spans nothing
 * and judges nothing.
 *
 * `prior` (uplift-3 N2) is the history a checkpoint carried across a restart,
 * copied in and capped exactly as observed buckets are. The totals it holds
 * came from a merged snapshot, so the first live reading on top of a restored
 * registry is never below them and the restart does not read as a reset.
 */
export class PlaneWindow {
	private readonly byPlane: Partial<Record<PlaneName, PlaneCountSample[]>> = {};

	constructor(
		readonly windowMs: number = PLANE_WINDOW_MS,
		readonly bucketMs: number = PLANE_BUCKET_MS,
		prior: Partial<Record<PlaneName, readonly PlaneCountSample[]>> = {},
	) {
		const cap = Math.ceil(this.windowMs / this.bucketMs) + 1;
		for (const plane of PLANES) {
			const samples = prior[plane];
			if (!samples || samples.length === 0) continue;
			this.byPlane[plane] = samples.slice(-cap).map((sample) => ({ ...sample }));
		}
	}

	/** Every retained bucket per plane, copied, for a checkpoint to carry. */
	export(): Partial<Record<PlaneName, PlaneCountSample[]>> {
		const out: Partial<Record<PlaneName, PlaneCountSample[]>> = {};
		for (const plane of PLANES) {
			const samples = this.byPlane[plane];
			if (samples && samples.length > 0) out[plane] = samples.map((sample) => ({ ...sample }));
		}
		return out;
	}

	observe(plane: PlaneName, ok: number, total: number, atMs: number): PlaneWindowReading {
		const samples = this.byPlane[plane] ?? [];
		for (let first = samples[0]; first !== undefined && first.atMs < atMs - this.windowMs; first = samples[0]) samples.shift();
		const last = samples[samples.length - 1];
		if (last !== undefined && (total < last.total || ok < last.ok)) samples.length = 0;
		if (last !== undefined && samples.length > 0 && Math.floor(last.atMs / this.bucketMs) === Math.floor(atMs / this.bucketMs)) {
			last.atMs = atMs;
			last.ok = ok;
			last.total = total;
		} else {
			samples.push({ atMs, ok, total, baseAtMs: atMs, baseOk: ok, baseTotal: total });
		}
		// A hard cap only against a clock that jumps backwards; time bounds the
		// history in every normal case, at windowMs / bucketMs + 1 entries.
		const cap = Math.ceil(this.windowMs / this.bucketMs) + 1;
		if (samples.length > cap) samples.splice(0, samples.length - cap);
		this.byPlane[plane] = samples;
		// The push above guarantees an entry; the fallback only keeps the types honest.
		const base = samples[0] ?? { atMs, ok, total, baseAtMs: atMs, baseOk: ok, baseTotal: total };
		return { ok: ok - base.baseOk, total: total - base.baseTotal, spanMs: atMs - base.baseAtMs, samples: samples.length };
	}
}

let sharedWindow: PlaneWindow | null = null;
/** The process-wide window the default evaluator feeds; `/slo` scrapes are its samples. */
export function sharedPlaneWindow(): PlaneWindow {
	sharedWindow ??= new PlaneWindow();
	return sharedWindow;
}

export interface PlaneEvalOptions {
	/** Which planes have configuration; an unconfigured plane is reported, never judged. */
	configured: Partial<Record<PlaneName, boolean>>;
	/** Sample history; defaults to the process-wide window every evaluation feeds. */
	window?: PlaneWindow;
	/** Evaluation time in epoch milliseconds; defaults to now. */
	now?: number;
	/** The availability floor; defaults to `DEFAULT_THRESHOLDS.planeAvailability`. */
	target?: number;
	/** Calls needed inside the window before the objective is judged. */
	minSamples?: number;
}

/**
 * Evaluate `plane.<name>.availability` for every plane against a metric snapshot.
 *
 * `ok / (ok + error + timeout + open)` of `substrate.plane.duration`, counted
 * over the rolling hour. An open-breaker refusal counts against the plane on
 * purpose: the caller did not get an answer, and a plane that is refused for a
 * minute is unavailable for that minute whoever decided it.
 */
export function evaluatePlaneSlos(snapshot: MetricSnapshot[], options: PlaneEvalOptions): PlaneSloResult[] {
	const window = options.window ?? sharedPlaneWindow();
	const now = options.now ?? Date.now();
	const target = options.target ?? DEFAULT_THRESHOLDS.planeAvailability;
	const minSamples = options.minSamples ?? DEFAULT_THRESHOLDS.minSamples;
	const histogram = findHistogram(snapshot, METRIC.planeDuration);
	return PLANES.map((plane): PlaneSloResult => {
		const base = {
			id: `plane.${plane}.availability`,
			plane,
			title: `${plane} availability`,
			statement: `ok / (ok+error+timeout+open) of ${METRIC.planeDuration}{plane=${plane}} >= ${(target * 100).toFixed(2)} % over the rolling hour`,
			unit: "ratio" as const,
			target,
		};
		if (options.configured[plane] !== true) {
			return { ...base, status: "unconfigured", observed: null, samples: 0, detail: `${plane} is not configured, so this objective is reported but never judged` };
		}
		const total = histogram ? mergeHistogram(histogram, { plane }).count : 0;
		const ok = histogram ? mergeHistogram(histogram, { plane, outcome: "ok" }).count : 0;
		const reading = window.observe(plane, ok, total, now);
		// `spanMs === 0` is the window's first-ever reading: nothing precedes it,
		// so there is nothing to count between. Two readings inside one bucket
		// still span something and are judged.
		if (reading.spanMs <= 0 || reading.total < minSamples) {
			return {
				...base,
				status: "insufficient-data",
				observed: reading.total > 0 ? reading.ok / reading.total : null,
				samples: reading.total,
				detail:
					`${reading.total} of ${minSamples} calls needed inside the window (${reading.samples} reading(s) spanning ` +
					`${Math.round(reading.spanMs / 1000)} s); every /slo read feeds one`,
			};
		}
		const observed = reading.ok / reading.total;
		return {
			...base,
			status: observed >= target ? "ok" : "breached",
			observed,
			samples: reading.total,
			detail:
				`${reading.ok} of ${reading.total} calls ok (${(observed * 100).toFixed(3)} %) over ${Math.round(reading.spanMs / 60_000)} minute(s); ` +
				`objective is at least ${(target * 100).toFixed(2)} %`,
		};
	});
}

// ── capacity runway (uplift-3 N2) ────────────────────────────────────────────

export const INDEX_VOLUME_ENV = "SUBSTRATE_INDEX_VOLUME_BYTES";
export const CAPACITY_RUNWAY_ID = "capacity.index.runway_days";
/**
 * The fixed sampling grid: at most one sample per `floor(at / bucketMs)`
 * bucket, and the first read in a bucket keeps it — a later read in the same
 * bucket never moves that sample's timestamp. Keyed by the grid, not by the
 * distance to the newest sample: a 5 s poller against a distance rule kept
 * dragging the newest sample forward and the ring never spanned a day
 * (Greptile round 1, PR #61).
 */
export const CAPACITY_BUCKET_MS = 60_000;
/**
 * The span the samples must cover before a growth rate is fitted. A day, so
 * the daily vacuum and a single bulk ingest cannot read as a trend: the
 * objective is about weeks of runway, and a slope taken over an hour of the
 * sweeper deleting rows would report an index that is shrinking forever.
 */
export const CAPACITY_MIN_SPAN_MS = 24 * 60 * 60 * 1000;
/**
 * Samples the ring keeps: the minute buckets of the required span plus an
 * hour of margin. N samples in consecutive buckets span at least
 * `(N - 1) * bucketMs - (bucketMs - 1)` ms first-to-last, so the bare 1,440
 * would stop a minute or two short of 24 h and never be judged; the margin
 * keeps the oldest sample behind the day however the reads fall in their
 * buckets (Greptile round 1, PR #61).
 */
export const CAPACITY_RING_MAX = CAPACITY_MIN_SPAN_MS / CAPACITY_BUCKET_MS + 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CapacitySample {
	/** Epoch ms of the `/healthz` capacity read. */
	at: number;
	databaseBytes: number;
}

/**
 * The `databaseBytes` history the runway is fitted over: at most one sample
 * per `bucketMs` bucket of wall-clock time, so the ring holds a function of
 * time rather than of the poll rate — a 5 s `/healthz` poller and a 60 s one
 * both fill it at one sample a minute and reach the 24 h span in a day — and
 * carried across restarts in the SLO checkpoint. Bounded by count, so the
 * checkpoint section is bounded whatever a clock does.
 */
export class CapacityRing {
	readonly #samples: CapacitySample[];

	constructor(
		prior: readonly CapacitySample[] = [],
		readonly max: number = CAPACITY_RING_MAX,
		readonly bucketMs: number = CAPACITY_BUCKET_MS,
	) {
		this.#samples = prior
			.filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.databaseBytes) && sample.databaseBytes >= 0)
			.slice(-max)
			.map((sample) => ({ ...sample }));
	}

	/**
	 * Record one read. A non-finite or negative size, or a clock behind the
	 * newest sample, is ignored. A read in the newest sample's grid bucket is
	 * ignored too — that sample keeps its own time and size; a read in a later
	 * bucket starts a new sample.
	 */
	record(at: number, databaseBytes: number): void {
		if (!Number.isFinite(at) || !Number.isFinite(databaseBytes) || databaseBytes < 0) return;
		const last = this.#samples[this.#samples.length - 1];
		if (last !== undefined && (at < last.at || Math.floor(last.at / this.bucketMs) === Math.floor(at / this.bucketMs))) return;
		this.#samples.push({ at, databaseBytes });
		if (this.#samples.length > this.max) this.#samples.splice(0, this.#samples.length - this.max);
	}

	/** Every retained sample, oldest first, copied. */
	samples(): CapacitySample[] {
		return this.#samples.map((sample) => ({ ...sample }));
	}

	get size(): number {
		return this.#samples.length;
	}
}

export type CapacitySloStatus = "ok" | "breached" | "insufficient-data";

/** One capacity verdict; the field shape mirrors `SloResult` so `/slo` reads alike. */
export interface CapacitySloResult {
	id: string;
	title: string;
	statement: string;
	status: CapacitySloStatus;
	/** Days until the volume is full at the fitted growth rate; `null` when not judged, or when the index is not growing. */
	observed: number | null;
	unit: "days";
	target: number;
	/** Samples in the ring. */
	samples: number;
	detail: string;
	/** The least-squares growth, bytes per day, or `null` before one is fitted. */
	bytesPerDay: number | null;
	/** The newest sample's size, or `null` with no sample. */
	currentBytes: number | null;
	/** The configured volume, or `null` when `SUBSTRATE_INDEX_VOLUME_BYTES` is unset. */
	volumeBytes: number | null;
}

export interface CapacityEvalOptions {
	/** The index volume's size in bytes; `null` leaves the objective `insufficient-data` and the detail says why. */
	volumeBytes: number | null;
	/** The runway floor in days; defaults to `DEFAULT_THRESHOLDS.runwayDays`. */
	targetDays?: number;
	/** The span the samples must cover before a rate is fitted; defaults to `CAPACITY_MIN_SPAN_MS`. */
	minSpanMs?: number;
}

/**
 * Evaluate `capacity.index.runway_days`: days until `SUBSTRATE_INDEX_VOLUME_BYTES`
 * is full at the growth fitted by least squares over the ring, which must span
 * at least a day. Fitted rather than first-to-last so one bulk ingest or vacuum
 * at either end cannot set the rate alone. An index that is not growing has an
 * unbounded runway, reported `ok` with `observed: null` and the rate in the
 * sentence; an index already at or past the volume has none.
 */
export function evaluateCapacitySlos(ring: CapacityRing, options: CapacityEvalOptions): CapacitySloResult[] {
	const target = options.targetDays ?? DEFAULT_THRESHOLDS.runwayDays;
	const minSpanMs = options.minSpanMs ?? CAPACITY_MIN_SPAN_MS;
	const samples = ring.samples();
	const newest = samples[samples.length - 1];
	const oldest = samples[0];
	const base = {
		id: CAPACITY_RUNWAY_ID,
		title: "Index capacity runway",
		statement:
			options.volumeBytes === null
				? `(${INDEX_VOLUME_ENV} - databaseBytes) / fitted bytes per day >= ${target} days (${INDEX_VOLUME_ENV} unset)`
				: `(${options.volumeBytes} - databaseBytes) / fitted bytes per day >= ${target} days`,
		unit: "days" as const,
		target,
		samples: samples.length,
		currentBytes: newest?.databaseBytes ?? null,
		volumeBytes: options.volumeBytes,
	};
	if (options.volumeBytes === null) {
		return [
			{
				...base,
				status: "insufficient-data",
				observed: null,
				bytesPerDay: null,
				detail: `${INDEX_VOLUME_ENV} is unset, so the volume's size is unknown and no runway can be computed`,
			},
		];
	}
	const spanMs = newest !== undefined && oldest !== undefined ? newest.at - oldest.at : 0;
	if (newest === undefined || oldest === undefined || samples.length < 2 || spanMs < minSpanMs) {
		return [
			{
				...base,
				status: "insufficient-data",
				observed: null,
				bytesPerDay: null,
				detail:
					`${samples.length} sample(s) span ${(spanMs / 3_600_000).toFixed(1)} h; a growth rate needs samples at least ` +
					`${Math.round(minSpanMs / 3_600_000)} h apart, and every /healthz capacity read feeds one`,
			},
		];
	}
	// Least squares on (t, bytes) with t centred on its mean, which keeps the
	// sums small: epoch milliseconds squared would otherwise overflow double
	// precision long before the ring is full.
	const meanT = samples.reduce((sum, sample) => sum + sample.at, 0) / samples.length;
	const meanY = samples.reduce((sum, sample) => sum + sample.databaseBytes, 0) / samples.length;
	let sxy = 0;
	let sxx = 0;
	for (const sample of samples) {
		const dt = sample.at - meanT;
		sxy += dt * (sample.databaseBytes - meanY);
		sxx += dt * dt;
	}
	const bytesPerDay = sxx > 0 ? (sxy / sxx) * DAY_MS : 0;
	const current = newest.databaseBytes;
	const remaining = options.volumeBytes - current;
	const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;
	if (remaining <= 0) {
		return [
			{
				...base,
				status: "breached",
				observed: 0,
				bytesPerDay,
				detail: `index is ${mb(current)}, at or past the ${mb(options.volumeBytes)} volume; no runway remains`,
			},
		];
	}
	if (bytesPerDay <= 0) {
		return [
			{
				...base,
				status: "ok",
				observed: null,
				bytesPerDay,
				detail:
					`index is ${mb(current)} of ${mb(options.volumeBytes)} and not growing (${mb(bytesPerDay)}/day over ` +
					`${(spanMs / 3_600_000).toFixed(1)} h, ${samples.length} samples); runway is unbounded`,
			},
		];
	}
	const runwayDays = remaining / bytesPerDay;
	return [
		{
			...base,
			status: runwayDays >= target ? "ok" : "breached",
			observed: runwayDays,
			bytesPerDay,
			detail:
				`index is ${mb(current)} of ${mb(options.volumeBytes)}, growing ${mb(bytesPerDay)}/day over ` +
				`${(spanMs / 3_600_000).toFixed(1)} h (${samples.length} samples): ${runwayDays.toFixed(1)} days of runway; ` +
				`objective is at least ${target}`,
		},
	];
}

// ── estimated served tokens per surface (uplift-4 S1) ────────────────────────

export const SERVED_TOKENS_ID = "served.tokens_est";
export const SERVED_TOKENS_ENV = "SUBSTRATE_SERVED_TOKENS_PER_HOUR";

export type ServedTokensStatus = "ok" | "breached" | "unconfigured" | "insufficient-data";

/** One surface's estimated spend verdict; the field shape mirrors `BurnResult` so `/slo` reads alike. */
export interface ServedTokensResult {
	id: typeof SERVED_TOKENS_ID;
	title: string;
	statement: string;
	surface: string;
	status: ServedTokensStatus;
	/** The estimated per-hour rate, or `null` before one exists. */
	observed: number | null;
	unit: "tokens/h (estimated)";
	/** The configured ceiling, or `null` when unconfigured. */
	target: number | null;
	samples: number;
	detail: string;
}

export interface ServedTokensEvalOptions {
	/** Environment the ceiling is read from; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Sample history; defaults to the process-wide burn ledger, which keys these series apart from the burn ones. */
	ledger?: BurnLedger;
	/** Evaluation time in epoch milliseconds; defaults to now. */
	now?: number;
	/** Where a malformed-env warning goes; defaults to one stderr line. */
	warn?: (message: string) => void;
}

/**
 * `served.tokens_est` per surface: the hourly rate of `substrate.served.tokens_est`
 * (bytes / 4 of what brief, recall and docs replies carried) against
 * `SUBSTRATE_SERVED_TOKENS_PER_HOUR`.
 *
 * This is an ESTIMATE of what a surface's model had to read, not what it was
 * billed: `burn.tokens` stays the model-reported series and never includes it.
 * One row per surface that has a series, sorted, so the array is empty until
 * something was served; an unset ceiling is `unconfigured` (reported, never
 * judged), exactly as `burn.ts` does. Every call is a sample in the ledger,
 * keyed per surface so the burn series and the surfaces never share history.
 * Served as the sibling `served` array on `GET /slo` and never folded into
 * `breached`.
 */
export function servedTokensBySurface(snapshot: MetricSnapshot[], options: ServedTokensEvalOptions = {}): ServedTokensResult[] {
	const counter = findCounter(snapshot, METRIC.servedTokensEst);
	if (!counter) return [];
	const ceiling = thresholdFrom(options.env ?? process.env, SERVED_TOKENS_ENV, options.warn ?? warnOnce, "served-tokens objective");
	const ledger = options.ledger ?? sharedBurnLedger();
	const now = options.now ?? Date.now();
	const surfaces = new Set<string>();
	for (const point of counter.points) {
		const surface = point.attributes.surface;
		if (typeof surface === "string") surfaces.add(surface);
	}
	const ceilingText = ceiling === null ? null : `${Math.round(ceiling)} tokens`;
	return [...surfaces].sort().map((surface): ServedTokensResult => {
		const base = {
			id: SERVED_TOKENS_ID as typeof SERVED_TOKENS_ID,
			title: "Estimated served tokens",
			surface,
			unit: "tokens/h (estimated)" as const,
			target: ceiling,
			statement:
				ceilingText === null
					? `estimated sum of ${METRIC.servedTokensEst}{surface=${surface}} (bytes/4 of served replies) per rolling hour, ceiling from ${SERVED_TOKENS_ENV} (unset)`
					: `estimated sum of ${METRIC.servedTokensEst}{surface=${surface}} (bytes/4 of served replies) per rolling hour <= ${ceilingText}`,
		};
		if (ceiling === null) {
			return { ...base, status: "unconfigured", observed: null, samples: 0, detail: `${SERVED_TOKENS_ENV} is unset, so this estimate is reported but never judged` };
		}
		const reading = ledger.observe(`${METRIC.servedTokensEst}|${surface}`, sumCounter(counter, { surface }), now);
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
		const breached = reading.perHour > ceiling;
		return {
			...base,
			status: breached ? "breached" : "ok",
			observed: reading.perHour,
			samples: reading.samples,
			detail:
				`about ${Math.round(reading.perHour)} tokens/h (estimated, bytes/4) over the rolling hour, extrapolated from ` +
				`${reading.samples} samples spanning ${Math.round(reading.spanMs / 60_000)} minute(s); ` +
				`${breached ? "over" : "within"} the ${Math.round(ceiling)} tokens/h ceiling`,
		};
	});
}

// ── docs freshness (uplift-4 S7) ─────────────────────────────────────────────

export const DOCS_FRESHNESS_ID = "docs.freshness";

/** One dataset's reading, as the substrate computes it from its persisted docs state; `dataset` is a configured name. */
export interface DocsFreshnessReading {
	dataset: string;
	/** Seconds since the newest recorded ingest; `null` when none is recorded. */
	freshnessSeconds: number | null;
	/** Seconds the newest accepted merge-trigger has waited for its version; `null` or 0 when it landed or none was accepted. */
	triggerLagSeconds: number | null;
	/** Older than the staleness threshold. */
	stale: boolean;
	/** A trigger has waited past the lag threshold. */
	lagging: boolean;
}

export interface DocsFreshnessSloResult {
	id: string;
	title: string;
	statement: string;
	status: "ok" | "breached" | "insufficient-data" | "unconfigured";
	/** Age in hours of the oldest dataset's newest ingest; `null` when no dataset has one. */
	observed: number | null;
	unit: "hours";
	/** The staleness threshold in hours; `0` means freshness is reported but not judged. */
	target: number;
	/** Datasets read. */
	samples: number;
	detail: string;
	datasets: Array<{ dataset: string; freshness_seconds: number | null; trigger_lag_seconds: number | null; stale: boolean; lagging: boolean }>;
}

export interface DocsFreshnessEvalOptions {
	/** `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H`; `0` leaves freshness unjudged. */
	maxAgeHours: number;
	/** `SUBSTRATE_DOCS_TRIGGER_LAG_MIN`; `0` means lag is not detected. */
	triggerLagMinutes: number;
}

/**
 * The `docs.freshness` row `GET /slo` serves beside `docs.search.p95`: no
 * RAGFlow call, only the persisted ingest times and accepted triggers. It is
 * report-only (the `docs` array is never folded into `breached`) and it
 * appears only when at least one dataset has a reading — a deployment that
 * never ingested sees nothing rather than a false `ok`. Like every objective
 * here it never reports `ok` without an observation it judged: `unconfigured`
 * when both knobs are 0, `insufficient-data` when no dataset has a recorded
 * ingest (a trigger alone has no age) or when nothing enabled could be judged.
 * It proves the corpus was refreshed recently and that accepted triggers
 * landed; it cannot know the repository HEAD.
 */
export function evaluateDocsFreshnessSlo(readings: readonly DocsFreshnessReading[], options: DocsFreshnessEvalOptions): DocsFreshnessSloResult[] {
	if (readings.length === 0) return [];
	const aged = readings.flatMap((reading) => (reading.freshnessSeconds === null ? [] : [reading.freshnessSeconds]));
	const oldest = aged.length === 0 ? null : Math.max(...aged);
	const stale = readings.filter((reading) => reading.stale);
	const lagging = readings.filter((reading) => reading.lagging);
	const ageJudged = options.maxAgeHours > 0;
	const lagJudged = options.triggerLagMinutes > 0 && readings.some((reading) => reading.triggerLagSeconds !== null);
	const status: DocsFreshnessSloResult["status"] =
		stale.length > 0 || lagging.length > 0
			? "breached"
			: options.maxAgeHours === 0 && options.triggerLagMinutes === 0
				? "unconfigured"
				: aged.length > 0 && (ageJudged || lagJudged)
					? "ok"
					: "insufficient-data";
	const parts = readings.map((reading) => {
		const age = reading.freshnessSeconds === null ? "no ingest recorded" : `${(reading.freshnessSeconds / 3600).toFixed(1)} h old`;
		const lag = reading.lagging ? `, trigger unrecorded for ${Math.round((reading.triggerLagSeconds ?? 0) / 60)} min` : "";
		return `${reading.dataset} ${age}${reading.stale ? " (stale)" : ""}${lag}`;
	});
	const why =
		status === "unconfigured"
			? "neither threshold is set (age and lag are reported, not judged); "
			: status === "insufficient-data"
				? "nothing judged yet: needs a recorded ingest and an enabled threshold; "
				: "";
	return [
		{
			id: DOCS_FRESHNESS_ID,
			title: "Docs corpus freshness",
			statement:
				`newest recorded ingest per dataset <= ${options.maxAgeHours > 0 ? `${options.maxAgeHours} h old` : "(age not judged)"}; ` +
				`no accepted merge-trigger without a recorded version for ${options.triggerLagMinutes > 0 ? `${options.triggerLagMinutes} min` : "(lag not detected)"}`,
			status,
			observed: oldest === null ? null : oldest / 3600,
			unit: "hours",
			target: options.maxAgeHours,
			samples: readings.length,
			detail: `${why}${parts.join("; ")}`,
			datasets: readings.map((reading) => ({
				dataset: reading.dataset,
				freshness_seconds: reading.freshnessSeconds,
				trigger_lag_seconds: reading.triggerLagSeconds,
				stale: reading.stale,
				lagging: reading.lagging,
			})),
		},
	];
}
