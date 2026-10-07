import { describe, expect, test } from "bun:test";
import {
	Counter,
	DEFAULT_MAX_SERIES,
	Histogram,
	LATENCY_BUCKETS_MS,
	IDENTIFIER_ATTRIBUTES,
	MAX_ATTRIBUTE_LENGTH,
	MAX_IDENTIFIER_ATTRIBUTE_LENGTH,
	boundValue,
	limitFor,
	MetricRegistry,
	OVERFLOW,
	VOLATILE_ATTRIBUTES,
	attributeKey,
	cleanAttributes,
	exactFractionAtOrBelow,
	exactFractionBelow,
	findCounter,
	findHistogram,
	mergeHistogram,
	quantileFromBuckets,
	sumCounter,
} from "./metrics.ts";

describe("attributeKey", () => {
	test("does not depend on the order the caller wrote the attributes in", () => {
		// Two call sites naming the same series must not create two series.
		expect(attributeKey({ surface: "omp", graph_id: "ut-1" })).toBe(attributeKey({ graph_id: "ut-1", surface: "omp" }));
	});

	test("separates values that would otherwise concatenate the same way", () => {
		expect(attributeKey({ a: "b=c" })).not.toBe(attributeKey({ "a=b": "c" }));
	});
});

describe("cleanAttributes", () => {
	test("drops absent attributes rather than storing the string 'undefined'", () => {
		expect(cleanAttributes({ surface: "omp", graph_id: null, node_id: undefined })).toEqual({ surface: "omp" });
	});
});

describe("Histogram", () => {
	test("a bound is the inclusive top of its bucket", () => {
		// This is what lets the 800 ms boundary answer "p95 <= 800 ms" as a count
		// rather than an interpolation, so it is asserted rather than assumed.
		const histogram = new Histogram("h", [10, 100]);
		histogram.record(10);
		histogram.record(10.0001);
		histogram.record(100);
		histogram.record(100.1);

		expect(histogram.snapshot().points[0]?.bucketCounts).toEqual([1, 2, 1]);
	});

	test("records count, sum, min and max per series", () => {
		const histogram = new Histogram("h", [100]);
		histogram.record(5, { surface: "omp" });
		histogram.record(45, { surface: "omp" });
		histogram.record(900, { surface: "muse" });

		const points = histogram.snapshot().points;
		expect(points).toHaveLength(2);
		const omp = points.find((point) => point.attributes.surface === "omp");
		expect(omp).toMatchObject({ count: 2, sum: 50, min: 5, max: 45 });
	});

	test("ignores a negative or non-finite observation instead of throwing", () => {
		// A bad caller must not be able to fail the turn it is instrumenting.
		const histogram = new Histogram("h");
		histogram.record(-1);
		histogram.record(Number.NaN);
		histogram.record(Number.POSITIVE_INFINITY);

		expect(histogram.snapshot().points).toEqual([]);
	});

	test("800 ms is one of the default bounds", () => {
		expect(LATENCY_BUCKETS_MS).toContain(800);
	});
});

describe("Counter", () => {
	test("refuses to go backwards", () => {
		const counter = new Counter("c");
		counter.add(3);
		counter.add(-5);
		counter.add(Number.NaN);

		expect(counter.snapshot().points[0]?.value).toBe(3);
	});

	test("an int counter rounds; a double counter does not", () => {
		const ints = new Counter("c", "int");
		const doubles = new Counter("d", "double");
		ints.add(0.6);
		doubles.add(0.6);

		expect(ints.snapshot().points[0]?.value).toBe(1);
		expect(doubles.snapshot().points[0]?.value).toBeCloseTo(0.6, 10);
	});
});

describe("the cardinality cap", () => {
	test("collapses graph_id into _overflow but keeps the observation", () => {
		// Losing the per-graph breakdown is acceptable. Losing the observation is not:
		// the emit-success ratio is computed from these counts and would drift.
		const counter = new Counter("c", "int", { maxSeries: 3 });
		for (let i = 0; i < 10; i++) counter.add(1, { surface: "omp", graph_id: `ut-${i}` });

		const snapshot = counter.snapshot();
		expect(snapshot.overflowed).toBe(7);
		expect(snapshot.points.reduce((total, point) => total + point.value, 0)).toBe(10);
		expect(snapshot.points.some((point) => point.attributes.graph_id === OVERFLOW)).toBe(true);
	});

	test("series count stops growing however many graphs arrive", () => {
		// The cap bounds the unbounded attribute, not the total: the `_overflow` series
		// for each combination of *bounded* attributes is admitted past the cap, because
		// refusing it would drop observations. What matters is that it stops growing.
		const counter = new Counter("c", "int", { maxSeries: 3 });
		for (let i = 0; i < 10; i++) counter.add(1, { surface: "omp", graph_id: `ut-${i}` });
		const afterTen = counter.snapshot().points.length;
		for (let i = 10; i < 5000; i++) counter.add(1, { surface: "omp", graph_id: `ut-${i}` });

		expect(counter.snapshot().points.length).toBe(afterTen);
		expect(afterTen).toBe(4); // three admitted series, plus the one they overflow into
	});

	test("bounded attributes survive the collapse", () => {
		const counter = new Counter("c", "int", { maxSeries: 1 });
		counter.add(1, { surface: "omp", graph_id: "ut-1" });
		counter.add(1, { surface: "muse", graph_id: "ut-2" });

		const overflow = counter.snapshot().points.find((point) => point.attributes.graph_id === OVERFLOW);
		expect(overflow?.attributes.surface).toBe("muse");
	});

	test("the default cap is high enough not to bite an ordinary day", () => {
		expect(DEFAULT_MAX_SERIES).toBeGreaterThanOrEqual(100);
	});

	test("an attribute the soft cap does not collapse is still bounded by the hard ceiling", () => {
		// The hole this closes: the soft cap only bounds growth if the attributes it does
		// *not* collapse are genuinely bounded, and `tool` came from a caller-supplied
		// JSON-RPC `params.name`. The cap collapsed the ids, found the collapsed key was
		// equally new, and admitted it — one series per name a caller invented, forever.
		const counter = new Counter("c", "int", { maxSeries: 4, hardMaxSeries: 8 });
		for (let i = 0; i < 5000; i++) counter.add(1, { surface: "omp", tool: `invented_${i}` });

		const snapshot = counter.snapshot();
		expect(snapshot.points.length).toBeLessThanOrEqual(9); // the ceiling, plus its one overflow series
		expect(snapshot.points.reduce((total, point) => total + point.value, 0)).toBe(5000);
	});

	test("at the hard ceiling every attribute collapses, so the count cannot grow again", () => {
		const counter = new Counter("c", "int", { maxSeries: 2, hardMaxSeries: 3 });
		for (let i = 0; i < 100; i++) counter.add(1, { surface: `s${i}`, tool: `t${i}` });
		const settled = counter.snapshot().points.length;
		for (let i = 100; i < 10_000; i++) counter.add(1, { surface: `s${i}`, tool: `t${i}` });

		expect(counter.snapshot().points.length).toBe(settled);
		const allCollapsed = counter.snapshot().points.find((point) => point.attributes.surface === OVERFLOW);
		expect(allCollapsed?.attributes.tool).toBe(OVERFLOW);
	});

	test("the hard ceiling cannot be configured below the soft cap", () => {
		const counter = new Counter("c", "int", { maxSeries: 10, hardMaxSeries: 1 });
		for (let i = 0; i < 100; i++) counter.add(1, { graph_id: `ut-${i}` });

		expect(counter.snapshot().points.reduce((total, point) => total + point.value, 0)).toBe(100);
	});

	test("model is volatile, because it arrives on a caller's payload", () => {
		expect(VOLATILE_ATTRIBUTES).toContain("model");
	});
});

describe("attribute values are length-bounded", () => {
	test("a runaway value is truncated, because a series key is held for the life of the process", () => {
		const value = "x".repeat(5000);
		expect((cleanAttributes({ model: value }).model as string).length).toBe(MAX_ATTRIBUTE_LENGTH);
	});

	test("an ordinary value is untouched", () => {
		expect(cleanAttributes({ surface: "omp", model: "opus" })).toEqual({ surface: "omp", model: "opus" });
	});

	test("an identifier gets the longer cap, because evidence reads it back by its exact value", () => {
		// `substrate evidence` finds a graph's token and cost totals by searching with the
		// full id. At 120 characters the two ends disagreed: a longer id's usage could never
		// be found again. 512 is the event path's own `MAX_FIELD`, so anything this
		// substrate accepts is now carried whole.
		const id = `ut-${"a".repeat(400)}`;
		expect(MAX_IDENTIFIER_ATTRIBUTE_LENGTH).toBe(512);
		expect(cleanAttributes({ graph_id: id }).graph_id).toBe(id);
		expect(cleanAttributes({ node_id: id }).node_id).toBe(id);
		expect(cleanAttributes({ session_id: id }).session_id).toBe(id);
		expect(IDENTIFIER_ATTRIBUTES).toContain("graph_id");
	});

	test("two over-long identifiers sharing a prefix do not collide", () => {
		// The misattribution this replaces. A plain slice is a prefix, so an id of exactly
		// the cap length received the totals of every longer id that started with it —
		// one graph's spend reported as another's, which is worse than losing it.
		const shared = "ut-" + "a".repeat(600);
		const first = boundValue(shared, MAX_IDENTIFIER_ATTRIBUTE_LENGTH);
		const second = boundValue(`${shared}-other`, MAX_IDENTIFIER_ATTRIBUTE_LENGTH);

		expect(first).not.toBe(second);
		expect(first.length).toBe(MAX_IDENTIFIER_ATTRIBUTE_LENGTH);
		expect(second.length).toBe(MAX_IDENTIFIER_ATTRIBUTE_LENGTH);
	});

	test("the bound is still a bound: nothing a caller sends exceeds it", () => {
		expect(boundValue("x".repeat(100_000), MAX_ATTRIBUTE_LENGTH).length).toBe(MAX_ATTRIBUTE_LENGTH);
		expect(limitFor("graph_id")).toBe(MAX_IDENTIFIER_ATTRIBUTE_LENGTH);
		expect(limitFor("model")).toBe(MAX_ATTRIBUTE_LENGTH);
	});
});

describe("exactFractionAtOrBelow", () => {
	const point = { count: 100, bucketCounts: [0, 0, 0, 0, 0, 0, 0, 96, 4, 0, 0, 0], bounds: LATENCY_BUCKETS_MS };

	test("counts the share at or below one of the histogram's own bounds", () => {
		expect(exactFractionAtOrBelow(point, 800)).toBeCloseTo(0.96, 10);
	});

	test("refuses a threshold that is not a bound rather than interpolating one", () => {
		// A bucketed histogram genuinely cannot answer "what share is below 750 ms";
		// saying so is the honest result, and the SLO reports `unmeasurable`.
		expect(exactFractionAtOrBelow(point, 750)).toBeNull();
	});

	test("an empty histogram answers null, not 0 or 1", () => {
		expect(exactFractionAtOrBelow({ count: 0, bucketCounts: [0, 0], bounds: [10] }, 10)).toBeNull();
	});
});

describe("exactFractionBelow", () => {
	const point = { count: 100, bucketCounts: [0, 0, 0, 0, 0, 0, 0, 96, 4, 0, 0, 0], bounds: LATENCY_BUCKETS_MS };

	test("excludes the bucket ending at the bound, because that bucket includes it", () => {
		// The 96 observations sit in (400, 800]. Any of them could be exactly 800 ms, so
		// none is *provably* below 800 ms — the pair of counts brackets the truth.
		expect(exactFractionBelow(point, 800)).toBe(0);
		expect(exactFractionAtOrBelow(point, 800)).toBeCloseTo(0.96, 10);
	});

	test("counts every bucket that ends below the bound", () => {
		expect(exactFractionBelow({ ...point, bucketCounts: [0, 0, 0, 0, 0, 0, 96, 4, 0, 0, 0, 0] }, 800)).toBeCloseTo(0.96, 10);
	});

	test("refuses a bound that is not one of the histogram's own", () => {
		expect(exactFractionBelow(point, 750)).toBeNull();
	});

	test("an empty histogram answers null, not 0 or 1", () => {
		expect(exactFractionBelow({ count: 0, bucketCounts: [0, 0], bounds: [10] }, 10)).toBeNull();
	});
});

describe("quantileFromBuckets", () => {
	test("interpolates linearly inside the bucket the quantile lands in", () => {
		// 10 observations, all in (10, 100]. p50 sits halfway through the bucket.
		const point = { count: 10, bucketCounts: [0, 10, 0], bounds: [10, 100] };
		expect(quantileFromBuckets(point, 0.5)).toBeCloseTo(55, 6);
	});

	test("answers null when the quantile lands above the last bound", () => {
		// There is no upper edge to interpolate against, and inventing one would
		// understate a real tail.
		const point = { count: 10, bucketCounts: [0, 0, 10], bounds: [10, 100] };
		expect(quantileFromBuckets(point, 0.95)).toBeNull();
	});

	test("an empty histogram has no quantile", () => {
		expect(quantileFromBuckets({ count: 0, bucketCounts: [0, 0], bounds: [10] }, 0.95)).toBeNull();
	});
});

describe("aggregation across series", () => {
	test("mergeHistogram adds the buckets up and can be narrowed by attribute", () => {
		const histogram = new Histogram("h", [100]);
		histogram.record(5, { surface: "omp" });
		histogram.record(500, { surface: "muse" });
		const snapshot = histogram.snapshot();

		expect(mergeHistogram(snapshot).count).toBe(2);
		expect(mergeHistogram(snapshot).bucketCounts).toEqual([1, 1]);
		expect(mergeHistogram(snapshot, { surface: "omp" }).count).toBe(1);
	});

	test("sumCounter selects by attribute equality", () => {
		const counter = new Counter("c");
		counter.add(7, { outcome: "stored" });
		counter.add(3, { outcome: "dropped" });
		const snapshot = counter.snapshot();

		expect(sumCounter(snapshot)).toBe(10);
		expect(sumCounter(snapshot, { outcome: "stored" })).toBe(7);
		expect(sumCounter(snapshot, { outcome: "nonsense" })).toBe(0);
	});
});

describe("MetricRegistry", () => {
	test("returns the same instrument for a name, so two call sites share a series", () => {
		const registry = new MetricRegistry();
		registry.counter("c").add(1);
		registry.counter("c").add(1);

		expect(findCounter(registry.snapshot(), "c")?.points[0]?.value).toBe(2);
	});

	test("snapshot carries counters and histograms, each narrowed by kind", () => {
		const registry = new MetricRegistry();
		registry.counter("c").add(1);
		registry.histogram("h").record(1);

		expect(findCounter(registry.snapshot(), "h")).toBeNull();
		expect(findHistogram(registry.snapshot(), "h")).not.toBeNull();
	});
});
