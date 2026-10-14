/**
 * Durable, queryable metrics history (uplift-4 S6).
 *
 * The SLO windows and the exporter's cumulative points live in memory and a
 * checkpoint file; neither can answer "what was `brief.p95` on Tuesday". This
 * module is the part of the answer that is not SQL: a FIXED allow-list of series,
 * the delta logic that turns the registry's cumulative counters and histograms
 * into one row per series per interval, the single-flight sampler that feeds
 * `GreptimeClient.recordMetricSamples`, and the `GET /slo/history` answer.
 *
 * Everything that reaches a statement is a member of a closed set defined here:
 * a series is a key of {@link METRIC_SERIES}, a label value is a member of that
 * series' closed value set, a window and a step are parsed against strict
 * patterns. No caller string is ever interpolated; the table is written and read
 * only by `greptime.ts`.
 *
 * Off unless `SUBSTRATE_METRICS_HISTORY=on`. Off, nothing here runs: no timer, no
 * table, no instrument, and the route answers `{ enabled: false }`.
 */
import {
	ADMISSION_DECISIONS,
	DOCS_SEARCH_OUTCOMES,
	METRIC,
	PLANES,
	attributeKey,
	quantileFromBuckets,
	type Attributes,
	type MetricRegistry,
	type MetricSnapshot,
} from "@substrate/observability";
import type { MetricsHistorySettings } from "./config.ts";
import type { GreptimeClient, MetricHistoryPoint } from "./greptime.ts";
import { SURFACES } from "./types.ts";

/** The counter a dropped batch is counted on, by closed reason. */
export const DROPPED_METRIC = "substrate.metrics.history.dropped";

/** Why a batch (or part of one) was not stored. A closed set: it is a metric label. */
export const METRIC_DROP_REASONS = ["breaker_open", "unavailable", "rejected", "ddl", "invalid", "capped", "internal"] as const;
export type MetricDropReason = (typeof METRIC_DROP_REASONS)[number];

/** Rows per `INSERT`. The sampler emits a few dozen, so this is a ceiling, not a target. */
export const MAX_METRIC_BATCH = 200;
/** Points a readback may return, whatever the window and step. */
export const MAX_METRIC_POINTS = 2000;
/** Per-point baselines the delta tracker keeps; past it, further points are not sampled (stably, in snapshot order). */
export const MAX_TRACKED_POINTS = 16_384;

export type SampleKind = "counter" | "gauge" | "histogram" | "ratio";
type LabelKey = "surface" | "plane" | "decision" | "outcome";

/**
 * How a readback folds the rows of one step bucket into one number: `sum` for
 * deltas, `avg` for gauges and medians, `max` for p95 (the worst interval in the
 * bucket, never an average that hides a spike), `wavg` for ratios weighted by
 * the sample count of each interval.
 */
export type SampleAggregate = "sum" | "avg" | "max" | "wavg";

export interface SeriesSpec {
	/** What the registry value was: stored in the `kind` column. */
	kind: SampleKind;
	/** The one label the series carries, or `null`. */
	label: LabelKey | null;
	/** The label's closed value set; `null` with no label. */
	values: ReadonlySet<string> | null;
	agg: SampleAggregate;
	unit: string;
}

/** A surface label folds into `other` rather than minting a series for a name outside the closed list. */
const SURFACE_VALUES: ReadonlySet<string> = new Set<string>([...SURFACES, "other"]);
const PLANE_VALUES: ReadonlySet<string> = new Set<string>(PLANES);
const DECISION_VALUES: ReadonlySet<string> = new Set<string>(ADMISSION_DECISIONS);
const OUTCOME_VALUES: ReadonlySet<string> = new Set<string>(DOCS_SEARCH_OUTCOMES);

/**
 * The only series the history carries. A series name from a request or a row is
 * looked up with `Object.hasOwn` here and nowhere else; anything absent is
 * refused before a statement is built.
 */
export const METRIC_SERIES: Readonly<Record<string, SeriesSpec>> = {
	"brief.p50": { kind: "histogram", label: "surface", values: SURFACE_VALUES, agg: "avg", unit: "ms" },
	"brief.p95": { kind: "histogram", label: "surface", values: SURFACE_VALUES, agg: "max", unit: "ms" },
	"emit.success": { kind: "ratio", label: null, values: null, agg: "wavg", unit: "ratio" },
	"emit.p95": { kind: "histogram", label: null, values: null, agg: "max", unit: "ms" },
	"plane.availability": { kind: "ratio", label: "plane", values: PLANE_VALUES, agg: "wavg", unit: "ratio" },
	"plane.p95": { kind: "histogram", label: "plane", values: PLANE_VALUES, agg: "max", unit: "ms" },
	"cache.hit_ratio": { kind: "ratio", label: null, values: null, agg: "wavg", unit: "ratio" },
	"admission.decisions": { kind: "counter", label: "decision", values: DECISION_VALUES, agg: "sum", unit: "{decision}" },
	"docs.search": { kind: "counter", label: "outcome", values: OUTCOME_VALUES, agg: "sum", unit: "{search}" },
	"docs.p95": { kind: "histogram", label: null, values: null, agg: "max", unit: "ms" },
	"capacity.runway_days": { kind: "gauge", label: null, values: null, agg: "avg", unit: "days" },
};

/** One row as the sampler hands it to the client. `kind` is not here: the client takes it from the series' spec. */
export interface MetricSampleRow {
	tsMs: number;
	series: string;
	labels: Record<string, string>;
	value: number;
	count: number;
}

/**
 * The canonical labels JSON for a row, or `null` when the row is not storable:
 * the series is not in the allow-list, or its labels are not exactly the one key
 * it carries with a value from its closed set. Bounded by construction — every
 * member of every closed set is a short slug with no quote or backslash.
 */
export function canonicalLabels(series: string, labels: Record<string, unknown>): string | null {
	if (!Object.hasOwn(METRIC_SERIES, series)) return null;
	const spec = METRIC_SERIES[series]!;
	const keys = Object.keys(labels);
	if (spec.label === null) return keys.length === 0 ? "{}" : null;
	if (keys.length !== 1 || keys[0] !== spec.label) return null;
	const value = labels[spec.label];
	if (typeof value !== "string" || !spec.values!.has(value)) return null;
	return JSON.stringify({ [spec.label]: value });
}

/**
 * The labels a stored row may show a caller: the series' one key with a value
 * from its closed set, whatever the column holds. A row written by anything else
 * reads back as no labels.
 */
export function readLabels(series: string, raw: unknown): Record<string, string> {
	if (!Object.hasOwn(METRIC_SERIES, series)) return {};
	const spec = METRIC_SERIES[series]!;
	if (spec.label === null || typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const value = (parsed as Record<string, unknown>)[spec.label];
		return typeof value === "string" && spec.values!.has(value) ? { [spec.label]: value } : {};
	} catch {
		return {};
	}
}

// ── delta logic ──────────────────────────────────────────────────────────────

/** Metrics the collector reads; every other instrument in the snapshot is ignored. */
const TRACKED: ReadonlySet<string> = new Set([
	METRIC.briefDuration,
	METRIC.emitDuration,
	METRIC.emitTotal,
	METRIC.planeDuration,
	METRIC.cacheOperations,
	METRIC.admissionDecisions,
	METRIC.docsSearch,
	METRIC.docsDuration,
]);

interface CounterDelta {
	name: string;
	attributes: Attributes;
	delta: number;
}

interface HistogramDelta {
	name: string;
	attributes: Attributes;
	bounds: readonly number[];
	buckets: number[];
	count: number;
}

interface HistogramBaseline {
	buckets: number[];
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The increase of one cumulative counter since the last sample. A value below
 * the previous one is a reset (a restart, a re-seeded registry): what the
 * counter says now is everything since the reset, so that is the delta. Never
 * negative. A series with no previous value is new since the last sample.
 */
export function counterDelta(previous: number | undefined, current: number): number {
	const value = finiteNonNegative(current);
	if (previous === undefined || value < previous) return value;
	return value - previous;
}

/** The same for a histogram's bucket counts: any bucket going down is a reset of the whole point. */
export function bucketDeltas(previous: readonly number[] | undefined, current: readonly number[]): number[] {
	const now = current.map(finiteNonNegative);
	if (previous === undefined || previous.length !== now.length || now.some((value, i) => value < previous[i]!)) return now;
	return now.map((value, i) => value - previous[i]!);
}

/**
 * Turns registry snapshots into rows, one interval at a time.
 *
 * The first snapshot it sees is a baseline and produces only gauges: after a
 * restart the registry may be seeded from a checkpoint, and treating that
 * cumulative history as one interval's delta would draw a spike that never
 * happened. The baselines are rebuilt from every snapshot, so the map is exactly
 * the live points and cannot outgrow {@link MAX_TRACKED_POINTS}.
 */
export class SampleCollector {
	private counters = new Map<string, number>();
	private histograms = new Map<string, HistogramBaseline>();
	private primed = false;

	/** Take the baseline without producing rows. */
	prime(snapshot: MetricSnapshot[]): void {
		this.advance(snapshot);
		this.primed = true;
	}

	collect(snapshot: MetricSnapshot[], runwayDays: number | null, tsMs: number): MetricSampleRow[] {
		const deltas = this.advance(snapshot);
		const first = !this.primed;
		this.primed = true;
		const rows: MetricSampleRow[] = first ? [] : rowsFrom(deltas, tsMs);
		if (runwayDays !== null && Number.isFinite(runwayDays)) {
			rows.push({ tsMs, series: "capacity.runway_days", labels: {}, value: runwayDays, count: 1 });
		}
		return rows;
	}

	private advance(snapshot: MetricSnapshot[]): { counters: CounterDelta[]; histograms: HistogramDelta[] } {
		const nextCounters = new Map<string, number>();
		const nextHistograms = new Map<string, HistogramBaseline>();
		const counters: CounterDelta[] = [];
		const histograms: HistogramDelta[] = [];
		let tracked = 0;
		for (const metric of snapshot) {
			if (!TRACKED.has(metric.name)) continue;
			if (metric.kind === "counter") {
				for (const point of metric.points) {
					if (tracked >= MAX_TRACKED_POINTS) break;
					tracked += 1;
					const key = `${metric.name}\u0001${attributeKey(point.attributes)}`;
					nextCounters.set(key, finiteNonNegative(point.value));
					counters.push({ name: metric.name, attributes: point.attributes, delta: counterDelta(this.counters.get(key), point.value) });
				}
				continue;
			}
			// S2 added a gauge instrument; no allow-listed series reads one from the registry (the runway comes in as an argument).
			if (metric.kind !== "histogram") continue;
			for (const point of metric.points) {
				if (tracked >= MAX_TRACKED_POINTS) break;
				tracked += 1;
				const key = `${metric.name}\u0001${attributeKey(point.attributes)}`;
				nextHistograms.set(key, { buckets: point.bucketCounts.map(finiteNonNegative) });
				const buckets = bucketDeltas(this.histograms.get(key)?.buckets, point.bucketCounts);
				histograms.push({
					name: metric.name,
					attributes: point.attributes,
					bounds: metric.bounds,
					buckets,
					count: buckets.reduce((total, value) => total + value, 0),
				});
			}
		}
		this.counters = nextCounters;
		this.histograms = nextHistograms;
		return { counters, histograms };
	}
}

/** The label value for an attribute, folded into the closed set; `null` when the series should skip the point. */
function labelFor(series: string, raw: unknown): string | null {
	const spec = METRIC_SERIES[series]!;
	const value = String(raw ?? "");
	if (spec.values!.has(value)) return value;
	return spec.values === SURFACE_VALUES ? "other" : null;
}

interface MergedBuckets {
	bounds: readonly number[];
	buckets: number[];
	count: number;
}

/** Merge histogram deltas into one distribution per label value. */
function mergeBy(
	deltas: readonly HistogramDelta[],
	metric: string,
	pick: (attributes: Attributes) => string | null,
): Map<string, MergedBuckets> {
	const groups = new Map<string, MergedBuckets>();
	for (const delta of deltas) {
		if (delta.name !== metric) continue;
		const label = pick(delta.attributes);
		if (label === null) continue;
		const group = groups.get(label) ?? { bounds: delta.bounds, buckets: new Array<number>(delta.buckets.length).fill(0), count: 0 };
		if (group.buckets.length !== delta.buckets.length) continue;
		delta.buckets.forEach((value, i) => {
			group.buckets[i] = (group.buckets[i] ?? 0) + value;
		});
		group.count += delta.count;
		groups.set(label, group);
	}
	return groups;
}

/** A quantile; one above the top bound reads as that bound, a floor rather than an invented tail. */
function quantileOf(group: MergedBuckets, q: number): number {
	return quantileFromBuckets({ count: group.count, bucketCounts: group.buckets, bounds: group.bounds }, q) ?? group.bounds.at(-1) ?? 0;
}

function rowsFrom(deltas: { counters: CounterDelta[]; histograms: HistogramDelta[] }, tsMs: number): MetricSampleRow[] {
	const rows: MetricSampleRow[] = [];

	const quantiles = (series: string, metric: string, q: number, pick: (attributes: Attributes) => string | null): void => {
		const spec = METRIC_SERIES[series]!;
		for (const [label, group] of mergeBy(deltas.histograms, metric, pick)) {
			if (group.count <= 0) continue;
			rows.push({ tsMs, series, labels: spec.label === null ? {} : { [spec.label]: label }, value: quantileOf(group, q), count: group.count });
		}
	};
	const unlabelled = (): string => "";
	quantiles("brief.p50", METRIC.briefDuration, 0.5, (attributes) => labelFor("brief.p50", attributes.surface));
	quantiles("brief.p95", METRIC.briefDuration, 0.95, (attributes) => labelFor("brief.p95", attributes.surface));
	quantiles("emit.p95", METRIC.emitDuration, 0.95, unlabelled);
	// A refused call (`open`) is recorded with no duration; it says nothing about latency.
	quantiles("plane.p95", METRIC.planeDuration, 0.95, (attributes) => (attributes.outcome === "open" ? null : labelFor("plane.p95", attributes.plane)));
	quantiles("docs.p95", METRIC.docsDuration, 0.95, unlabelled);

	// plane.availability: ok / every outcome, per plane, over the interval.
	const planes = new Map<string, { ok: number; total: number }>();
	for (const delta of deltas.histograms) {
		if (delta.name !== METRIC.planeDuration) continue;
		const plane = labelFor("plane.availability", delta.attributes.plane);
		if (plane === null) continue;
		const tally = planes.get(plane) ?? { ok: 0, total: 0 };
		tally.total += delta.count;
		if (delta.attributes.outcome === "ok") tally.ok += delta.count;
		planes.set(plane, tally);
	}
	for (const [plane, tally] of planes) {
		if (tally.total > 0) rows.push({ tsMs, series: "plane.availability", labels: { plane }, value: tally.ok / tally.total, count: tally.total });
	}

	// emit.success: stored / (stored + dropped).
	let stored = 0;
	let dropped = 0;
	// cache.hit_ratio: hit / (hit + miss); bypass and error are neither.
	let hits = 0;
	let misses = 0;
	const decisions = new Map<string, number>();
	const outcomes = new Map<string, number>();
	for (const delta of deltas.counters) {
		if (delta.name === METRIC.emitTotal) {
			if (delta.attributes.outcome === "stored") stored += delta.delta;
			else if (delta.attributes.outcome === "dropped") dropped += delta.delta;
		} else if (delta.name === METRIC.cacheOperations) {
			if (delta.attributes.result === "hit") hits += delta.delta;
			else if (delta.attributes.result === "miss") misses += delta.delta;
		} else if (delta.name === METRIC.admissionDecisions) {
			const decision = labelFor("admission.decisions", delta.attributes.decision);
			if (decision !== null) decisions.set(decision, (decisions.get(decision) ?? 0) + delta.delta);
		} else if (delta.name === METRIC.docsSearch) {
			const outcome = labelFor("docs.search", delta.attributes.outcome);
			if (outcome !== null) outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + delta.delta);
		}
	}
	if (stored + dropped > 0) rows.push({ tsMs, series: "emit.success", labels: {}, value: stored / (stored + dropped), count: stored + dropped });
	if (hits + misses > 0) rows.push({ tsMs, series: "cache.hit_ratio", labels: {}, value: hits / (hits + misses), count: hits + misses });
	for (const [decision, total] of decisions) {
		if (total > 0) rows.push({ tsMs, series: "admission.decisions", labels: { decision }, value: total, count: total });
	}
	for (const [outcome, total] of outcomes) {
		if (total > 0) rows.push({ tsMs, series: "docs.search", labels: { outcome }, value: total, count: total });
	}
	return rows;
}

// ── the sampler ──────────────────────────────────────────────────────────────

/** What the sampler needs from the client; `GreptimeClient.recordMetricSamples` is the production one. */
export type RecordSamples = (rows: MetricSampleRow[]) => Promise<{ stored: number; drops: Partial<Record<MetricDropReason, number>> }>;

export interface TimerApi {
	setInterval(handler: () => void, ms: number): { unref(): unknown };
	clearInterval(handle: { unref(): unknown }): void;
}

export interface MetricsHistorySamplerDeps {
	settings: Pick<MetricsHistorySettings, "enabled" | "intervalS">;
	/** The registry snapshot, as `/metrics` serves it. */
	snapshot: () => MetricSnapshot[];
	/** The capacity runway in days, or `null` when it is not judged. */
	runwayDays: () => number | null;
	record: RecordSamples;
	/** Counts a drop by closed reason; production adds to {@link DROPPED_METRIC}. */
	onDrop: (reason: MetricDropReason, rows: number) => void;
	clock?: () => number;
	timers?: TimerApi;
}

/** Register the drop counter. Called before the registry is seeded, so a checkpoint can restore it. */
export function registerMetricsHistoryMetrics(registry: MetricRegistry): void {
	registry.counter(DROPPED_METRIC, {
		description: "Metric-history rows not stored, by reason (breaker_open|unavailable|rejected|ddl|invalid|capped|internal).",
		unit: "{row}",
	});
}

/**
 * Samples the registry every `intervalS` and hands the rows to the client.
 *
 * Fail-open end to end: nothing a request does waits for it, a failed write is a
 * counted drop and never an exception, and a slow write skips ticks instead of
 * overlapping them (the deltas simply accumulate into the next sample, so only
 * a *failed* batch loses data). The timer is unref'd and cleared by `stop()`;
 * `flush()` waits for the write in flight and then does one fresh sample.
 */
export class MetricsHistorySampler {
	private readonly collector = new SampleCollector();
	private readonly clock: () => number;
	private readonly timers: TimerApi;
	private timer: { unref(): unknown } | null = null;
	private inFlight: Promise<void> | null = null;
	private flushing: Promise<void> | null = null;

	constructor(private readonly deps: MetricsHistorySamplerDeps) {
		this.clock = deps.clock ?? Date.now;
		this.timers = deps.timers ?? { setInterval: (handler, ms) => setInterval(handler, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>) };
	}

	/** Start sampling. `false`, and nothing scheduled, when the history is off. Idempotent. */
	start(): boolean {
		if (!this.deps.settings.enabled) return false;
		if (this.timer !== null) return true;
		try {
			// The baseline first: the first interval's deltas must start from now.
			this.collector.prime(this.deps.snapshot());
		} catch {
			// A snapshot that throws is the registry's bug; the first tick primes instead.
		}
		this.timer = this.timers.setInterval(() => void this.sample(), this.deps.settings.intervalS * 1000);
		this.timer.unref();
		return true;
	}

	/** Clear the timer. A write already in flight finishes; `flush()` awaits it. */
	stop(): void {
		if (this.timer === null) return;
		this.timers.clearInterval(this.timer);
		this.timer = null;
	}

	/** One sample, single-flight: a call while one is running joins it. */
	sample(): Promise<void> {
		this.inFlight ??= this.run().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** The shutdown write: wait out the one in flight, then take a fresh sample. Concurrent calls join. */
	flush(): Promise<void> {
		if (!this.deps.settings.enabled) return Promise.resolve();
		this.flushing ??= (async () => {
			if (this.inFlight !== null) await this.inFlight.catch(() => undefined);
			await this.sample();
		})().finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	private async run(): Promise<void> {
		let rows: MetricSampleRow[] = [];
		try {
			rows = this.collector.collect(this.deps.snapshot(), this.deps.runwayDays(), this.clock());
			if (rows.length === 0) return;
			const result = await this.deps.record(rows);
			for (const reason of METRIC_DROP_REASONS) {
				const dropped = result.drops[reason];
				if (dropped !== undefined && dropped > 0) this.report(reason, dropped);
			}
		} catch {
			// `record` does not throw; this is the sampler's own fault (a snapshot, a callback).
			if (rows.length > 0) this.report("internal", rows.length);
		}
	}

	/** A callback that throws must not turn a finished sample into a failure. */
	private report(reason: MetricDropReason, rows: number): void {
		try {
			this.deps.onDrop(reason, rows);
		} catch {
			// Counting is best-effort.
		}
	}
}

// ── GET /slo/history ─────────────────────────────────────────────────────────

const WINDOW_PATTERN = /^([1-9][0-9]{0,3})([mhd])$/;
const STEP_PATTERN = /^([1-9][0-9]{0,4})([smh]?)$/;
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };
const DEFAULT_WINDOW = "1h";
const MIN_STEP_S = 15;
const MAX_STEP_S = 86_400;

/** A window in seconds (`90m`, `6h`, `7d`), or `null`. */
export function parseHistoryWindow(raw: string): number | null {
	const match = WINDOW_PATTERN.exec(raw);
	return match === null ? null : Number(match[1]) * UNIT_SECONDS[match[2]!]!;
}

/** A step in seconds (`60`, `90s`, `5m`, `1h`), or `null`. */
export function parseHistoryStep(raw: string): number | null {
	const match = STEP_PATTERN.exec(raw);
	return match === null ? null : Number(match[1]) * UNIT_SECONDS[match[2] === "" ? "s" : match[2]!]!;
}

/** How long an answer is served again, and how many are kept. The route scans the whole TTL window through the shared ledger gate, so it is memoised. */
export const HISTORY_MEMO_MS = 15_000;
export const HISTORY_MEMO_MAX = 64;

/**
 * The step a read is really run at, ONE rule for the client and the route.
 *
 * A bucket can hold one row per label value of the series (28 for a per-surface
 * series), and the statement keeps the newest {@link MAX_METRIC_POINTS} rows, so
 * the step is raised until (buckets + 1) x label values fits the cap. Otherwise a
 * long window of a labelled series would lose its oldest days. `windowMs` is the
 * already TTL-capped window; the requested step is clamped to 15 s .. 1 day first
 * and is only ever raised, never lowered.
 */
export function effectiveHistoryStep(series: string, windowMs: number, requestedStepS: number): number {
	const labelValues = Object.hasOwn(METRIC_SERIES, series) ? (METRIC_SERIES[series]!.values?.size ?? 1) : 1;
	const maxBuckets = Math.max(1, Math.floor(MAX_METRIC_POINTS / labelValues) - 1);
	const needed = Math.ceil(windowMs / 1000 / maxBuckets);
	const requested = Math.min(MAX_STEP_S, Math.max(MIN_STEP_S, Math.ceil(requestedStepS)));
	return Math.max(requested, needed);
}

/**
 * Answers by request key, each served again for {@link HISTORY_MEMO_MS} and
 * computed once however many requests arrive meanwhile (the promise is stored,
 * so concurrent identical requests share one read). Bounded: expired entries are
 * purged first, then the oldest inserted goes until there is room, so a scanner
 * cycling keys cannot grow it past `max`. Keys are built from validated values.
 */
export class MetricHistoryMemo {
	private readonly entries = new Map<string, { at: number; answer: Promise<MetricHistoryAnswer> }>();

	constructor(
		private readonly now: () => number,
		private readonly ttlMs: number = HISTORY_MEMO_MS,
		private readonly max: number = HISTORY_MEMO_MAX,
	) {}

	get size(): number {
		return this.entries.size;
	}

	answer(key: string, load: () => Promise<MetricHistoryAnswer>): Promise<MetricHistoryAnswer> {
		const now = this.now();
		const hit = this.entries.get(key);
		if (hit !== undefined && now - hit.at < this.ttlMs) return hit.answer;
		this.entries.delete(key);
		for (const [other, entry] of this.entries) {
			if (now - entry.at >= this.ttlMs) this.entries.delete(other);
		}
		while (this.entries.size >= this.max) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		const answer = load();
		this.entries.set(key, { at: now, answer });
		return answer;
	}
}

export interface MetricHistoryDeps {
	/** `enabled` is the effective flag (switch on AND a ledger), see `loadMetricsHistorySettings`. */
	settings: Pick<MetricsHistorySettings, "enabled" | "intervalS" | "ttl" | "ttlDays">;
	greptime: Pick<GreptimeClient, "readMetricHistory"> | null;
	now: () => number;
	/** Absent in tests that want every request to read; the server passes one. */
	memo?: MetricHistoryMemo;
}

export interface MetricHistoryAnswer {
	status: number;
	body: Record<string, unknown>;
}

/**
 * The `GET /slo/history?series=&window=&step=` answer: aggregated numbers only,
 * labels only from the series' closed set, at most {@link MAX_METRIC_POINTS}
 * points. 404 `{ enabled: false }` with the history off or no ledger; 400 for a
 * series outside the allow-list or a window or step that does not parse; 503 with
 * a closed message when the store cannot answer (never the store's own error
 * text). `stepS` is the step the read actually ran at, and `retentionDays` is the
 * configured TTL the window is capped at (an existing table keeps the retention
 * it was created with).
 */
export async function metricHistoryAnswer(deps: MetricHistoryDeps, params: URLSearchParams): Promise<MetricHistoryAnswer> {
	if (!deps.settings.enabled || deps.greptime === null) return { status: 404, body: { enabled: false } };
	const series = params.get("series") ?? "";
	if (!Object.hasOwn(METRIC_SERIES, series)) {
		return { status: 400, body: { enabled: true, error: "series is not one of the recorded series", series: Object.keys(METRIC_SERIES) } };
	}
	const windowS = parseHistoryWindow(params.get("window") ?? DEFAULT_WINDOW);
	if (windowS === null) {
		return { status: 400, body: { enabled: true, error: "window must be a whole number and a unit, 1m to 9999d (for example 90m, 6h, 7d)" } };
	}
	const stepRaw = params.get("step");
	const requestedStepS = stepRaw === null ? null : parseHistoryStep(stepRaw);
	if (stepRaw !== null && requestedStepS === null) {
		return { status: 400, body: { enabled: true, error: "step must be whole seconds, or a number and s, m or h (for example 60, 5m)" } };
	}
	const store = deps.greptime;
	const load = async (): Promise<MetricHistoryAnswer> => {
		const toMs = deps.now();
		const cappedWindowS = Math.min(windowS, deps.settings.ttlDays * 86_400);
		const fromMs = toMs - cappedWindowS * 1000;
		const wantedStepS = requestedStepS ?? Math.max(deps.settings.intervalS, Math.ceil(cappedWindowS / 400));
		let read: { points: MetricHistoryPoint[]; stepS: number };
		try {
			read = await store.readMetricHistory({ series, fromMs, toMs, stepS: wantedStepS, ttl: deps.settings.ttl });
		} catch {
			return { status: 503, body: { enabled: true, error: "the history store could not answer" } };
		}
		const spec = METRIC_SERIES[series]!;
		return {
			status: 200,
			body: {
				enabled: true,
				series,
				kind: spec.kind,
				unit: spec.unit,
				aggregate: spec.agg,
				from: new Date(fromMs).toISOString(),
				to: new Date(toMs).toISOString(),
				windowCapped: windowS > cappedWindowS,
				retentionDays: deps.settings.ttlDays,
				stepS: read.stepS,
				truncated: read.points.length >= MAX_METRIC_POINTS,
				points: read.points.slice(0, MAX_METRIC_POINTS).map((point) => ({
					ts: new Date(point.tsMs).toISOString(),
					labels: point.labels,
					value: point.value,
					count: point.count,
				})),
			},
		};
	};
	return deps.memo === undefined ? load() : deps.memo.answer(`${series}|${windowS}|${requestedStepS ?? ""}`, load);
}
