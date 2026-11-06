/**
 * In-process metric aggregation.
 *
 * Hand-rolled rather than `@opentelemetry/sdk-metrics`, for the same reason
 * `greptime.ts` is a hand-rolled HTTP client: the substrate sits on the critical
 * path of every prompt on this host, it must fail open, and the whole surface it
 * needs is two instrument kinds and one snapshot. `otlp.ts` encodes the snapshot
 * in OTLP/HTTP JSON, so a real collector still receives standard OTLP.
 *
 * Everything here is cumulative and monotonic. The exporter pushes the same
 * running totals every interval and never resets, which is what makes a missed
 * export harmless: the next one carries the events the lost one would have.
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

/**
 * Latency buckets, in milliseconds.
 *
 * `800` is a boundary on purpose. The brief SLO is "p95 <= 800 ms", and a bucketed
 * histogram can answer *that* exactly — the share of observations at or below the
 * 800 boundary is a count, not an interpolation — where the interpolated p95 it
 * reports alongside is only an estimate. The bound is inclusive, as OTLP defines it,
 * which is why the objective is stated with `<=` and not the `<` SPE-4793 words it
 * with: see `exactFractionAtOrBelow` and `evaluateLatency`.
 */
export const LATENCY_BUCKETS_MS: readonly number[] = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 8000];

/** Token and cost buckets are not needed: those are sums, not distributions. */

/**
 * Attributes whose value space is unbounded, so they are the ones dropped first
 * when an instrument hits its series cap.
 *
 * `graph_id` is the substrate's task key — one per uplifted prompt — so a metric
 * keyed by it grows without limit, and a collector billed per series would feel
 * it. It is kept because "which graph is slow" is the question this ticket exists
 * to answer; it is kept *bounded* because an observability plane that can exhaust
 * a collector is an outage of its own.
 */
export const VOLATILE_ATTRIBUTES: readonly string[] = ["graph_id", "session_id", "node_id", "model"];

/** The value a volatile attribute collapses to once an instrument is at its cap. */
export const OVERFLOW = "_overflow";

/**
 * Series per instrument before volatile attributes start collapsing into
 * `_overflow`.
 *
 * A soft cap, and it bounds the *unbounded* growth rather than the total. Once it
 * is reached, each further attribute combination folds into the `_overflow` series
 * for its bounded attributes — and those overflow series are admitted beyond the
 * cap, because refusing them would mean dropping observations the SLOs are
 * computed from. The bounded attributes are `surface`, `kind`, `route`, `outcome`,
 * `decision`, `direction` and `reason`: a few dozen combinations, not a few
 * thousand.
 */
export const DEFAULT_MAX_SERIES = 500;

/**
 * The hard ceiling. Past this, **every** attribute collapses.
 *
 * The soft cap above only bounds growth if the attributes it does *not* collapse
 * are genuinely bounded, and that was an assumption the call sites had to keep
 * rather than a property this code enforced. It did not hold: `tool` came straight
 * from a JSON-RPC `params.name`, so an authenticated caller could mint one series
 * per name it invented, past the soft cap, without limit — the cap collapsed the
 * graph and session ids, found the collapsed key was equally new, and admitted it.
 *
 * The call sites are fixed too (`observe.ts` maps an unrecognised tool name to a
 * single bucket), but the invariant no longer depends on them: once an instrument
 * holds this many series, every further combination folds into one, and the series
 * count cannot grow again. Observations are still counted, as always.
 */
export const HARD_MAX_SERIES = 4 * DEFAULT_MAX_SERIES;

export interface CounterPoint {
	attributes: Attributes;
	value: number;
}

export interface HistogramPoint {
	attributes: Attributes;
	count: number;
	sum: number;
	min: number;
	max: number;
	/** `bounds.length + 1` entries; the last counts everything above the last bound. */
	bucketCounts: number[];
}

export interface CounterSnapshot {
	kind: "counter";
	name: string;
	description: string;
	unit: string;
	valueType: "int" | "double";
	points: CounterPoint[];
	/** Series that collapsed into `_overflow` because the cap was reached. */
	overflowed: number;
}

export interface HistogramSnapshot {
	kind: "histogram";
	name: string;
	description: string;
	unit: string;
	bounds: readonly number[];
	points: HistogramPoint[];
	overflowed: number;
}

export interface GaugeSnapshot {
	kind: "gauge";
	name: string;
	description: string;
	unit: string;
	points: CounterPoint[];
	overflowed: number;
}

export type MetricSnapshot = CounterSnapshot | HistogramSnapshot | GaugeSnapshot;

/**
 * A stable key for an attribute set: keys sorted, values stringified, joined on
 * control characters no attribute can contain. Two callers passing the same
 * attributes in different order must land on the same series.
 *
 * Both separators are control characters, including the one between a key and its
 * value. A printable one collides: with `=`, `{a: "b=c"}` and `{"a=b": "c"}` are
 * two different attribute sets that produce the same key, and their observations
 * would be silently added together.
 */
export function attributeKey(attributes: Attributes): string {
	return Object.keys(attributes)
		.sort()
		.map((key) => `${key}\u0002${String(attributes[key])}`)
		.join("\u0001");
}

/**
 * Longest attribute value kept. Anything longer is shortened by `boundValue`.
 *
 * Several attribute values are caller-supplied — a `model` from an event payload, a
 * `reason` — and a series key is held for the life of the process. Capping the length
 * bounds what one caller can make this hold, alongside the series cap that bounds how
 * many it can make.
 */
export const MAX_ATTRIBUTE_LENGTH = 120;

/**
 * The cap for the attributes an identifier is *read back by*.
 *
 * `graph_id` is how `substrate evidence` finds a graph's token and cost totals, and it
 * searches with the full id. At 120 characters the two ends disagreed: an id longer
 * than that was recorded truncated and its usage could never be found again, and — worse
 * — a 120-character id received the totals of every longer id sharing its prefix, so one
 * graph's spend was reported as another's. `512` is `MAX_FIELD` on the event path and
 * `MAX_IDENTIFIER` in the audit record, so an identifier this substrate accepts anywhere
 * is now carried whole by the metrics too.
 */
export const MAX_IDENTIFIER_ATTRIBUTE_LENGTH = 512;

/** Attributes that are looked up by their exact value, and so get the longer cap. */
export const IDENTIFIER_ATTRIBUTES: readonly string[] = ["graph_id", "session_id", "node_id"];

/**
 * Shorten an over-long attribute value **without letting two values collide**.
 *
 * A plain `slice` is a prefix, and two different identifiers with a common prefix
 * truncate to the same string — which in a metric means their observations are added
 * together and attributed to whichever arrived first. A digest of the whole value,
 * appended to the prefix, makes the result unique to the input while staying bounded:
 * the series is still unreadable-long, but it is nobody else's.
 *
 * Nothing this substrate accepts reaches here — `MAX_IDENTIFIER_ATTRIBUTE_LENGTH`
 * matches the event path's own cap — so this is the guard for a value that got past
 * validation, not a routine path.
 */
export function boundValue(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);
	return `${value.slice(0, Math.max(limit - digest.length - 1, 0))}~${digest}`;
}

/** The length cap for one attribute, by name. */
export function limitFor(key: string): number {
	return IDENTIFIER_ATTRIBUTES.includes(key) ? MAX_IDENTIFIER_ATTRIBUTE_LENGTH : MAX_ATTRIBUTE_LENGTH;
}

/** Drop `undefined` and `null` so an absent attribute is absent, not the string "undefined". */
export function cleanAttributes(attributes: Record<string, AttributeValue | null | undefined>): Attributes {
	const out: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (value === null || value === undefined) continue;
		out[key] = typeof value === "string" ? boundValue(value, limitFor(key)) : value;
	}
	return out;
}

/** Collapse every volatile attribute to `_overflow`, keeping the bounded ones. */
function collapse(attributes: Attributes): Attributes {
	const out: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		out[key] = VOLATILE_ATTRIBUTES.includes(key) ? OVERFLOW : value;
	}
	return out;
}

/** Collapse *every* attribute. The one series an instrument at its hard ceiling folds into. */
function collapseAll(attributes: Attributes): Attributes {
	const out: Attributes = {};
	for (const key of Object.keys(attributes)) out[key] = OVERFLOW;
	return out;
}

interface InstrumentOptions {
	description?: string;
	unit?: string;
	maxSeries?: number;
	hardMaxSeries?: number;
}

/** Shared series bookkeeping, including the cardinality cap. */
abstract class Instrument<S> {
	protected readonly series = new Map<string, { attributes: Attributes; state: S }>();
	/**
	 * Series restored from a prior epoch's checkpoint (uplift-3 N2), merged into
	 * every snapshot beneath the live ones. Never observed into — `seriesFor`
	 * only ever touches `series` — and replaced whole by `seedPrior`, never added
	 * to, so restoring the same checkpoint twice cannot double-count: the live
	 * epoch starts at zero on top of exactly one prior layer.
	 *
	 * Bounded by the **same** caps as the live series, over the union of the two
	 * layers (`distinct`): a checkpoint seeded without the cap would carry every
	 * `graph_id` ever seen from epoch to epoch, and the file would grow until the
	 * next boot refused it (Greptile round 1, PR #61). Restored points past the
	 * cap fold into the same `_overflow` series a live observation would.
	 */
	protected readonly prior = new Map<string, { attributes: Attributes; state: S }>();
	/** Observations and restored points that collapsed into `_overflow` this epoch; the prior layer's count is kept apart so a re-seed replaces it. */
	protected overflowed = 0;
	private priorOverflowed = 0;
	/** Distinct series across both layers — what the caps bound. A key in both counts once. */
	private distinct = 0;
	readonly description: string;
	readonly unit: string;
	private readonly maxSeries: number;
	private readonly hardMaxSeries: number;

	constructor(
		readonly name: string,
		options: InstrumentOptions = {},
	) {
		this.description = options.description ?? "";
		this.unit = options.unit ?? "";
		this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
		this.hardMaxSeries = Math.max(options.hardMaxSeries ?? HARD_MAX_SERIES, this.maxSeries + 1);
	}

	protected abstract initial(): S;

	/** Add `from` into `into`: how two restored points of one collapsed series combine. */
	protected abstract fold(into: S, from: S): void;

	/**
	 * The attributes a new series is admitted under: its own while there is room,
	 * the volatile attributes collapsed at the soft cap, everything collapsed at
	 * the hard ceiling. Shared by the live and the restored path so the bound is
	 * one rule, not two.
	 */
	private placement(attributes: Attributes): { attributes: Attributes; overflow: boolean } {
		if (this.distinct < this.maxSeries) return { attributes, overflow: false };
		return { attributes: this.distinct >= this.hardMaxSeries ? collapseAll(attributes) : collapse(attributes), overflow: true };
	}

	/**
	 * The series an observation belongs in, creating it if there is room.
	 *
	 * At the cap, the volatile attributes are collapsed and the observation is
	 * folded into the `_overflow` series rather than dropped: losing the graph
	 * breakdown is acceptable, losing the observation is not — the emit success
	 * ratio would drift away from the truth.
	 */
	protected seriesFor(attributes: Attributes): S {
		const key = attributeKey(attributes);
		const existing = this.series.get(key);
		if (existing) return existing.state;

		// A series the prior layer already holds is not new: its live half is
		// created without consulting the cap, so a restored graph keeps its own row.
		if (this.prior.has(key)) {
			const created = { attributes, state: this.initial() };
			this.series.set(key, created);
			return created.state;
		}

		const placed = this.placement(attributes);
		if (placed.overflow) {
			// Past the hard ceiling nothing new is admitted at all: every observation
			// folds into the single all-collapsed series. This is what makes the bound a
			// property of this code rather than a promise each call site has to keep.
			this.overflowed++;
			const collapsedKey = attributeKey(placed.attributes);
			const found = this.series.get(collapsedKey);
			if (found) return found.state;
			// The collapsed series itself may still be new. Admit it — there are only as
			// many of those as there are combinations of bounded attributes, and the hard
			// ceiling above catches the case where an attribute turns out not to be.
			const created = { attributes: placed.attributes, state: this.initial() };
			this.series.set(collapsedKey, created);
			if (!this.prior.has(collapsedKey)) this.distinct++;
			return created.state;
		}

		const created = { attributes, state: this.initial() };
		this.series.set(key, created);
		this.distinct++;
		return created.state;
	}

	/**
	 * Replace the prior layer with restored entries, admitted through the same
	 * cap as live observations: the live series stay distinct, and each restored
	 * point either keeps its key (room left, or the live layer already holds it)
	 * or folds into the collapsed series it would have landed in live. The
	 * prior layer's overflow count is replaced, not added to.
	 */
	protected seedPrior(entries: ReadonlyArray<{ attributes: Attributes; state: S }>): void {
		this.prior.clear();
		this.priorOverflowed = 0;
		this.distinct = this.series.size;
		for (const entry of entries) {
			const key = attributeKey(entry.attributes);
			const duplicate = this.prior.get(key);
			if (duplicate) {
				this.fold(duplicate.state, entry.state);
				continue;
			}
			if (this.series.has(key)) {
				this.prior.set(key, entry);
				continue;
			}
			const placed = this.placement(entry.attributes);
			if (!placed.overflow) {
				this.prior.set(key, entry);
				this.distinct++;
				continue;
			}
			this.priorOverflowed++;
			const collapsedKey = attributeKey(placed.attributes);
			const found = this.prior.get(collapsedKey);
			if (found) {
				this.fold(found.state, entry.state);
				continue;
			}
			this.prior.set(collapsedKey, { attributes: placed.attributes, state: entry.state });
			if (!this.series.has(collapsedKey)) this.distinct++;
		}
	}

	/** Live and restored points that collapsed into `_overflow`, as a snapshot reports it. */
	protected get overflowedTotal(): number {
		return this.overflowed + this.priorOverflowed;
	}

	get seriesCount(): number {
		return this.series.size;
	}

	/** Distinct series across the live and prior layers: the number the caps bound. */
	get distinctCount(): number {
		return this.distinct;
	}

	/** Live and prior series by key: the prior state first, the live one merged over it. */
	protected merged(merge: (prior: S | undefined, live: S | undefined) => S): Array<{ attributes: Attributes; state: S }> {
		const out: Array<{ attributes: Attributes; state: S }> = [];
		for (const [key, { attributes, state }] of this.prior) {
			out.push({ attributes, state: merge(state, this.series.get(key)?.state) });
		}
		for (const [key, { attributes, state }] of this.series) {
			if (!this.prior.has(key)) out.push({ attributes, state: merge(undefined, state) });
		}
		return out;
	}
}

/** A monotonic cumulative sum. */
export class Counter extends Instrument<{ value: number }> {
	constructor(
		name: string,
		private readonly valueType: "int" | "double" = "int",
		options: InstrumentOptions = {},
	) {
		super(name, options);
	}

	protected initial(): { value: number } {
		return { value: 0 };
	}

	protected fold(into: { value: number }, from: { value: number }): void {
		into.value += from.value;
	}

	/**
	 * Add to a series. A negative or non-finite delta is ignored rather than
	 * thrown: a counter that can go backwards is not a counter, and a bad caller
	 * must not be able to fail the turn it is instrumenting.
	 */
	add(value: number, attributes: Attributes = {}): void {
		if (!Number.isFinite(value) || value < 0) return;
		this.seriesFor(attributes).value += value;
	}

	/**
	 * Replace the prior layer with a checkpoint's points (uplift-3 N2), under the
	 * cardinality cap. Negative or non-finite values are skipped: a counter
	 * restored from them would read as having gone backwards, which the burn
	 * ledger and plane window treat as a reset.
	 */
	seed(points: readonly CounterPoint[]): void {
		this.seedPrior(
			points
				.filter((point) => Number.isFinite(point.value) && point.value >= 0)
				.map((point) => ({ attributes: point.attributes, state: { value: point.value } })),
		);
	}

	snapshot(): CounterSnapshot {
		return {
			kind: "counter",
			name: this.name,
			description: this.description,
			unit: this.unit,
			valueType: this.valueType,
			overflowed: this.overflowedTotal,
			points: this.merged((prior, live) => ({ value: (prior?.value ?? 0) + (live?.value ?? 0) })).map(({ attributes, state }) => ({
				attributes,
				value: this.valueType === "int" ? Math.round(state.value) : state.value,
			})),
		};
	}
}

interface HistogramState {
	count: number;
	sum: number;
	min: number;
	max: number;
	buckets: number[];
}

/** An explicit-bucket cumulative histogram. */
export class Histogram extends Instrument<HistogramState> {
	constructor(
		name: string,
		readonly bounds: readonly number[] = LATENCY_BUCKETS_MS,
		options: InstrumentOptions = {},
	) {
		super(name, options);
	}

	protected initial(): HistogramState {
		return {
			count: 0,
			sum: 0,
			min: Number.POSITIVE_INFINITY,
			max: Number.NEGATIVE_INFINITY,
			buckets: new Array<number>(this.bounds.length + 1).fill(0),
		};
	}

	protected fold(into: HistogramState, from: HistogramState): void {
		into.count += from.count;
		into.sum += from.sum;
		if (from.min < into.min) into.min = from.min;
		if (from.max > into.max) into.max = from.max;
		for (let i = 0; i < into.buckets.length; i++) into.buckets[i] = (into.buckets[i] ?? 0) + (from.buckets[i] ?? 0);
	}

	record(value: number, attributes: Attributes = {}): void {
		if (!Number.isFinite(value) || value < 0) return;
		const state = this.seriesFor(attributes);
		state.count++;
		state.sum += value;
		if (value < state.min) state.min = value;
		if (value > state.max) state.max = value;
		// `<=` — a bound is the inclusive top of its bucket, as OTLP defines it, which
		// is what lets the 800 ms boundary answer "p95 <= 800 ms" without interpolating.
		let index = this.bounds.findIndex((bound) => value <= bound);
		if (index < 0) index = this.bounds.length;
		state.buckets[index] = (state.buckets[index] ?? 0) + 1;
	}

	/**
	 * Replace the prior layer with a checkpoint's points (uplift-3 N2), under the
	 * cardinality cap. A point whose bucket count does not match these bounds is
	 * skipped: its counts belong to another edge set and would land in the
	 * wrong buckets.
	 */
	seed(points: readonly HistogramPoint[]): void {
		this.seedPrior(
			points
				.filter(
					(point) =>
						point.bucketCounts.length === this.bounds.length + 1 &&
						Number.isFinite(point.count) &&
						point.count >= 0 &&
						Number.isFinite(point.sum) &&
						point.bucketCounts.every((n) => Number.isFinite(n) && n >= 0),
				)
				.map((point) => ({
					attributes: point.attributes,
					state: {
						count: point.count,
						sum: point.sum,
						min: point.count === 0 ? Number.POSITIVE_INFINITY : point.min,
						max: point.count === 0 ? Number.NEGATIVE_INFINITY : point.max,
						buckets: [...point.bucketCounts],
					},
				})),
		);
	}

	snapshot(): HistogramSnapshot {
		const empty = this.initial();
		return {
			kind: "histogram",
			name: this.name,
			description: this.description,
			unit: this.unit,
			bounds: this.bounds,
			overflowed: this.overflowedTotal,
			points: this.merged((prior = empty, live = empty) => ({
				count: prior.count + live.count,
				sum: prior.sum + live.sum,
				min: Math.min(prior.min, live.min),
				max: Math.max(prior.max, live.max),
				buckets: prior.buckets.map((n, i) => n + (live.buckets[i] ?? 0)),
			})).map(({ attributes, state }) => ({
				attributes,
				count: state.count,
				sum: state.sum,
				min: state.count === 0 ? 0 : state.min,
				max: state.count === 0 ? 0 : state.max,
				bucketCounts: [...state.buckets],
			})),
		};
	}
}

/**
 * Merge a histogram's matching series into one distribution.
 *
 * SLOs are stated over the whole service ("brief p95 <= 800 ms"), not per graph, so
 * evaluation has to add the buckets up rather than pick a series.
 */
export function mergeHistogram(
	snapshot: HistogramSnapshot,
	where: Record<string, string> = {},
): HistogramPoint & { bounds: readonly number[] } {
	const merged: HistogramPoint & { bounds: readonly number[] } = {
		attributes: {},
		bounds: snapshot.bounds,
		count: 0,
		sum: 0,
		min: Number.POSITIVE_INFINITY,
		max: 0,
		bucketCounts: new Array<number>(snapshot.bounds.length + 1).fill(0),
	};
	for (const point of snapshot.points) {
		if (!matches(point.attributes, where)) continue;
		merged.count += point.count;
		merged.sum += point.sum;
		if (point.count > 0 && point.min < merged.min) merged.min = point.min;
		if (point.max > merged.max) merged.max = point.max;
		point.bucketCounts.forEach((value, index) => {
			merged.bucketCounts[index] = (merged.bucketCounts[index] ?? 0) + value;
		});
	}
	if (merged.count === 0) merged.min = 0;
	return merged;
}

/** Sum a counter's matching series. */
export function sumCounter(snapshot: CounterSnapshot, where: Record<string, string> = {}): number {
	return snapshot.points
		.filter((point) => matches(point.attributes, where))
		.reduce((total, point) => total + point.value, 0);
}

/** Whether every attribute in `where` is present on the point with that value. */
export function matches(attributes: Attributes, where: Record<string, string>): boolean {
	return Object.entries(where).every(([key, value]) => String(attributes[key] ?? "") === value);
}

/**
 * The exact share of observations at or below one of the histogram's own bounds.
 *
 * How "p95 <= 800 ms" is checked against bucketed data: the count at or below the
 * 800 ms boundary is known precisely, so the answer does not depend on how a quantile
 * is interpolated inside the bucket. `null` means the bound is not one of this
 * histogram's boundaries, so the question cannot be answered exactly — the caller
 * should say so rather than guess.
 *
 * This count is inclusive of the bound, as an OTLP bucket edge is, so it answers `<=`
 * and not `<`; `evaluateLatency` decides on it, and states the objective in the same
 * terms. Its companion `exactFractionBelow` is what tells the two apart, and is used
 * to qualify the sentence rather than to move the verdict.
 */
export function exactFractionAtOrBelow(
	point: Pick<HistogramPoint, "count" | "bucketCounts"> & { bounds: readonly number[] },
	bound: number,
): number | null {
	if (point.count === 0) return null;
	const index = point.bounds.indexOf(bound);
	if (index < 0) return null;
	let below = 0;
	for (let i = 0; i <= index; i++) below += point.bucketCounts[i] ?? 0;
	return below / point.count;
}

/**
 * The exact share of observations **strictly below** one of the histogram's bounds.
 *
 * A bucket bound is an inclusive upper edge in OTLP, so the bucket ending at `bound`
 * may hold observations of exactly `bound` and cannot be placed on either side of a
 * strict `<`. This sums only the buckets that end below it, which is the share that is
 * *provably* below.
 *
 * With `exactFractionAtOrBelow` it brackets the truth: anything between the two is
 * decided by the boundary bucket, and a bucketed histogram cannot say which way. This
 * is not the verdict — an objective stated at an inclusive bound is judged on the
 * at-or-below count, or no healthy run inside the boundary bucket could ever pass.
 * `evaluateLatency` uses this to *qualify* such a pass: when the two disagree, the
 * detail names the bucket the verdict rests on and says that observations at exactly
 * the bound were counted as meeting the objective. `null` when the bound is not one
 * of this histogram's boundaries.
 */
export function exactFractionBelow(
	point: Pick<HistogramPoint, "count" | "bucketCounts"> & { bounds: readonly number[] },
	bound: number,
): number | null {
	if (point.count === 0) return null;
	const index = point.bounds.indexOf(bound);
	if (index < 0) return null;
	let below = 0;
	for (let i = 0; i < index; i++) below += point.bucketCounts[i] ?? 0;
	return below / point.count;
}

/**
 * An interpolated quantile, for reporting.
 *
 * Linear within the bucket the quantile lands in. `null` when it lands above the
 * last bound, because there is no upper edge to interpolate against and inventing
 * one would understate a real tail.
 */
export function quantileFromBuckets(
	point: Pick<HistogramPoint, "count" | "bucketCounts"> & { bounds: readonly number[] },
	quantile: number,
): number | null {
	if (point.count === 0) return null;
	const target = quantile * point.count;
	let cumulative = 0;
	for (let i = 0; i < point.bucketCounts.length; i++) {
		const inBucket = point.bucketCounts[i] ?? 0;
		if (cumulative + inBucket < target) {
			cumulative += inBucket;
			continue;
		}
		const upper = point.bounds[i];
		if (upper === undefined) return null; // the unbounded top bucket
		const lower = i === 0 ? 0 : (point.bounds[i - 1] ?? 0);
		if (inBucket === 0) return upper;
		return lower + ((target - cumulative) / inBucket) * (upper - lower);
	}
	return null;
}

/**
 * The latest value of one reading, with no attributes. Not cumulative: it
 * reports whatever was last set or observed, which is why it never rides a checkpoint.
 */
export class Gauge {
	private value: number | null = null;
	/** Computes the reading at snapshot time; replaces `set` when installed (`null` means no reading yet). */
	observe: (() => number | null) | null = null;
	readonly description: string;
	readonly unit: string;

	constructor(
		readonly name: string,
		options: InstrumentOptions = {},
	) {
		this.description = options.description ?? "";
		this.unit = options.unit ?? "";
	}

	/** Replace the reading. A non-finite value is ignored: a bad caller must not be able to fail what it is instrumenting. */
	set(value: number): void {
		if (Number.isFinite(value)) this.value = value;
	}

	/**
	 * The current reading: the observer's answer when one is installed (computed
	 * now, at snapshot time, so an export that nobody else triggers is never
	 * stale), else the last `set`. A throwing or non-finite observer reads as no
	 * point — a gauge must not be able to fail the export that reads it.
	 */
	private current(): number | null {
		if (this.observe === null) return this.value;
		try {
			const observed = this.observe();
			return observed !== null && Number.isFinite(observed) ? observed : null;
		} catch {
			// A throwing observer reads as null: no point, as the doc above says.
			return null;
		}
	}

	snapshot(): GaugeSnapshot {
		const value = this.current();
		return {
			kind: "gauge",
			name: this.name,
			description: this.description,
			unit: this.unit,
			overflowed: 0,
			points: value === null ? [] : [{ attributes: {}, value }],
		};
	}
}

/**
 * Every instrument the process owns, plus the process start time.
 *
 * `startedAt` is the `start_time_unix_nano` every cumulative point carries: it is
 * how a collector tells a counter that reset (process restart) from one that
 * simply did not move.
 */
export class MetricRegistry {
	private readonly counters = new Map<string, Counter>();
	private readonly histograms = new Map<string, Histogram>();
	private readonly gauges = new Map<string, Gauge>();

	constructor(readonly startedAt: number = Date.now()) {}

	counter(name: string, options: InstrumentOptions & { valueType?: "int" | "double" } = {}): Counter {
		const existing = this.counters.get(name);
		if (existing) return existing;
		const created = new Counter(name, options.valueType ?? "int", options);
		this.counters.set(name, created);
		return created;
	}

	histogram(name: string, options: InstrumentOptions & { bounds?: readonly number[] } = {}): Histogram {
		const existing = this.histograms.get(name);
		if (existing) return existing;
		const created = new Histogram(name, options.bounds ?? LATENCY_BUCKETS_MS, options);
		this.histograms.set(name, created);
		return created;
	}

	/**
	 * One observed value (uplift-4 S2), created on first use so a process that
	 * never sets it carries no extra series. A gauge is a reading, not history:
	 * it is not checkpointed and not seeded across restarts.
	 */
	gauge(name: string, options: InstrumentOptions = {}): Gauge {
		const existing = this.gauges.get(name);
		if (existing) return existing;
		const created = new Gauge(name, options);
		this.gauges.set(name, created);
		return created;
	}

	snapshot(): MetricSnapshot[] {
		return [
			...[...this.counters.values()].map((instrument) => instrument.snapshot()),
			...[...this.histograms.values()].map((instrument) => instrument.snapshot()),
			...[...this.gauges.values()].map((instrument) => instrument.snapshot()),
		];
	}

	/**
	 * Seed every instrument's prior layer from a snapshot a previous epoch wrote
	 * (uplift-3 N2). Only instruments this registry already owns are seeded — a
	 * metric the running release no longer records has no description or unit
	 * to be created with — and a histogram whose bounds differ is skipped whole,
	 * since its bucket counts would land on the wrong edges. The names left out
	 * are returned so the caller can say so once.
	 */
	seed(
		prior: ReadonlyArray<
			| { kind: "counter"; name: string; points: readonly CounterPoint[] }
			| { kind: "histogram"; name: string; bounds: readonly number[]; points: readonly HistogramPoint[] }
		>,
	): string[] {
		const skipped: string[] = [];
		for (const metric of prior) {
			if (metric.kind === "counter") {
				const counter = this.counters.get(metric.name);
				if (!counter) skipped.push(metric.name);
				else counter.seed(metric.points);
				continue;
			}
			const histogram = this.histograms.get(metric.name);
			if (
				!histogram ||
				histogram.bounds.length !== metric.bounds.length ||
				!histogram.bounds.every((bound, i) => bound === metric.bounds[i])
			) {
				skipped.push(metric.name);
				continue;
			}
			histogram.seed(metric.points);
		}
		return skipped;
	}
}

/** Find one metric in a snapshot by name, narrowed to its kind. */
export function findCounter(snapshot: MetricSnapshot[], name: string): CounterSnapshot | null {
	const found = snapshot.find((metric) => metric.name === name);
	return found?.kind === "counter" ? found : null;
}

export function findHistogram(snapshot: MetricSnapshot[], name: string): HistogramSnapshot | null {
	const found = snapshot.find((metric) => metric.name === name);
	return found?.kind === "histogram" ? found : null;
}
