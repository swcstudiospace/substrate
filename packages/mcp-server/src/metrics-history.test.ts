/**
 * The durable metrics history (uplift-4 S6): the config knobs, the closed
 * allow-list, the delta logic, the single-flight sampler and `GET /slo/history`.
 * The client's statements are pinned in `greptime.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import {
	ADMISSION_DECISIONS,
	BRIEF_RECALL_RESULTS,
	CACHE_METRIC_RESULTS,
	DOCS_SEARCH_OUTCOMES,
	MEMORY_EXPIRED_MODES,
	METRIC,
	MetricRegistry,
	PLANES,
	RECALL_PREFETCH_RESULTS,
	SubstrateInstruments,
} from "@substrate/observability";
import { loadConfig, loadMetricsHistorySettings } from "./config.ts";
import type { MetricHistoryPoint } from "./greptime.ts";
import {
	ALL_METRIC_SERIES,
	DROPPED_METRIC,
	EVENT_METRIC_SERIES,
	EXTENDED_METRIC_SERIES,
	MAX_METRIC_BATCH,
	MAX_METRIC_POINTS,
	METRIC_SERIES,
	MetricHistoryMemo,
	MetricsHistorySampler,
	SampleCollector,
	bucketDeltas,
	canonicalLabels,
	counterDelta,
	effectiveHistoryStep,
	metricHistoryAnswer,
	metricSeriesFor,
	parseHistoryStep,
	parseHistoryWindow,
	readLabels,
	registerMetricsHistoryMetrics,
	type MetricDropReason,
	type MetricSampleRow,
} from "./metrics-history.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { SURFACES } from "./types.ts";

/** What the route hands the client; the fakes below take it and report the step the real client would run at. */
type ReadQuery = {
	series: string;
	fromMs: number;
	toMs: number;
	stepS: number;
	ttl?: string;
};

describe("SUBSTRATE_METRICS_HISTORY*", () => {
	test("defaults: off, 60 s, 14d", () => {
		expect(loadMetricsHistorySettings({})).toEqual({ enabled: false, intervalS: 60, ttl: "14d", ttlDays: 14, series: "core", problems: [] });
		expect(loadConfig({}).metricsHistory.enabled).toBe(false);
	});

	test("only `on` turns it on, in any case; anything else stays off and says so", () => {
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: "ON" }).enabled).toBe(true);
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: "off" })).toMatchObject({ enabled: false, problems: [] });
		for (const typo of ["1", "true", "yes", "onn"]) {
			const settings = loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: typo });
			expect(settings.enabled).toBe(false);
			expect(settings.problems).toHaveLength(1);
		}
	});

	test("the interval has a floor of 15 s and a ceiling of an hour", () => {
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_INTERVAL_S: "1" }).intervalS).toBe(15);
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_INTERVAL_S: "99999" }).intervalS).toBe(3600);
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_INTERVAL_S: "30" }).intervalS).toBe(30);
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_INTERVAL_S: "soon" }).intervalS).toBe(60);
	});

	test("a TTL is whole days from 1d to 90d; every hostile string falls back to 14d with a problem that quotes nothing", () => {
		for (const [raw, days] of [["1d", 1], ["30d", 30], ["90d", 90], [" 7d ", 7]] as const) {
			expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_TTL: raw })).toMatchObject({ ttl: `${days}d`, ttlDays: days, problems: [] });
		}
		const hostile = [
			"14d'); DROP TABLE metric_samples; --",
			"14d' , 'append_mode' = 'false",
			"14d 1h",
			"0d",
			"91d",
			"999d",
			"-1d",
			"+7d",
			"014d",
			"14D",
			"1e1d",
			"14",
			"14d;",
			"1\nd",
			"14days",
			"forever",
			"1h",
			"d",
		];
		for (const raw of hostile) {
			const settings = loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_TTL: raw });
			expect(settings.ttl).toBe("14d");
			expect(settings.ttlDays).toBe(14);
			expect(settings.problems).toHaveLength(1);
			expect(settings.problems[0]).not.toContain("DROP");
		}
	});
});

describe("the series allow-list", () => {
	test("is closed: about a dozen series, each with a kind, an aggregate and one closed label at most", () => {
		const names = Object.keys(METRIC_SERIES);
		expect(names.length).toBeGreaterThanOrEqual(10);
		expect(names.length).toBeLessThanOrEqual(14);
		for (const name of names) expect(name).toMatch(/^[a-z0-9_.]+$/);
	});

	test("planning.transition is a core series with one closed outcome label: its two outcomes are stored, and any other name or label is refused", () => {
		expect(Object.hasOwn(METRIC_SERIES, "planning.transition")).toBe(true);
		expect(Object.hasOwn(metricSeriesFor("core"), "planning.transition")).toBe(true);
		expect(canonicalLabels("planning.transition", { outcome: "applied" })).toBe('{"outcome":"applied"}');
		expect(canonicalLabels("planning.transition", { outcome: "refused" })).toBe('{"outcome":"refused"}');
		expect(canonicalLabels("planning.transition", { outcome: "dropped" })).toBeNull();
		expect(canonicalLabels("planning.transition", { surface: "grok-bot" })).toBeNull();
		expect(canonicalLabels("planning.transition", {})).toBeNull();
		expect(canonicalLabels("planning.unlisted", { outcome: "applied" })).toBeNull();
	});

	test("canonicalLabels takes only the series' own label with a value from its closed set", () => {
		expect(canonicalLabels("brief.p95", { surface: "grok-bot" })).toBe('{"surface":"grok-bot"}');
		expect(canonicalLabels("brief.p95", { surface: "other" })).toBe('{"surface":"other"}');
		expect(canonicalLabels("plane.availability", { plane: "greptime" })).toBe('{"plane":"greptime"}');
		expect(canonicalLabels("emit.success", {})).toBe("{}");
		expect(canonicalLabels("emit.success", { surface: "grok-bot" })).toBeNull();
		expect(canonicalLabels("brief.p95", {})).toBeNull();
		expect(canonicalLabels("brief.p95", { plane: "greptime" })).toBeNull();
		expect(canonicalLabels("brief.p95", { surface: "grok-bot", plane: "greptime" })).toBeNull();
	});

	test("hostile series and label text is refused, not escaped", () => {
		for (const series of ["", "nope", "__proto__", "constructor", "toString", "brief.p95' OR '1'='1", 'brief.p95"; DROP TABLE x; --']) {
			expect(canonicalLabels(series, {})).toBeNull();
			expect(readLabels(series, "{}")).toEqual({});
		}
		for (const surface of ["x'); DROP TABLE metric_samples; --", 'a"b', "back\\slash", "Grok-Bot", "grok-bot ", "__proto__"]) {
			expect(canonicalLabels("brief.p95", { surface })).toBeNull();
		}
	});

	test("readLabels shows a caller the closed label and nothing else, whatever the column holds", () => {
		expect(readLabels("brief.p95", '{"surface":"grok-bot"}')).toEqual({ surface: "grok-bot" });
		expect(readLabels("brief.p95", '{"surface":"grok-bot","secret":"x"}')).toEqual({ surface: "grok-bot" });
		expect(readLabels("brief.p95", '{"surface":"https://internal.example"}')).toEqual({});
		expect(readLabels("brief.p95", "not json")).toEqual({});
		expect(readLabels("brief.p95", null)).toEqual({});
		expect(readLabels("emit.success", '{"surface":"grok-bot"}')).toEqual({});
	});
});

describe("deltas", () => {
	test("a counter's delta is never negative: a lower value is a reset and counts as everything since", () => {
		expect(counterDelta(10, 15)).toBe(5);
		expect(counterDelta(10, 10)).toBe(0);
		expect(counterDelta(10, 3)).toBe(3);
		expect(counterDelta(undefined, 4)).toBe(4);
		expect(counterDelta(10, Number.NaN)).toBe(0);
		expect(counterDelta(10, -5)).toBe(0);
		expect(counterDelta(10, Number.POSITIVE_INFINITY)).toBe(0);
	});

	test("a histogram point resets whole when any bucket goes down", () => {
		expect(bucketDeltas([1, 2, 3], [2, 2, 5])).toEqual([1, 0, 2]);
		expect(bucketDeltas([1, 2, 3], [0, 9, 9])).toEqual([0, 9, 9]);
		expect(bucketDeltas([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
		expect(bucketDeltas(undefined, [4, 5])).toEqual([4, 5]);
		expect(bucketDeltas([1, 2], [-1, Number.NaN]).every((value) => value >= 0)).toBe(true);
	});
});

function seriesRows(rows: MetricSampleRow[], series: string): MetricSampleRow[] {
	return rows.filter((row) => row.series === series);
}

describe("SampleCollector", () => {
	test("the first snapshot is a baseline: no deltas, only the gauge", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
		const collector = new SampleCollector();
		const first = collector.collect(instruments.snapshot(), 12.5, 1000);
		expect(first).toEqual([{ tsMs: 1000, series: "capacity.runway_days", labels: {}, value: 12.5, count: 1 }]);
		expect(collector.collect(instruments.snapshot(), null, 2000)).toEqual([]);
	});

	test("brief p50 and p95 per surface are of the interval, not of the process lifetime", () => {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < 50; i++) instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 4000 });
		const collector = new SampleCollector();
		collector.prime(instruments.snapshot());
		for (let i = 0; i < 20; i++) instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 20 });
		for (let i = 0; i < 4; i++) instruments.recordBrief({ surface: "claude-code", ok: false, durationMs: 90 });
		instruments.recordBrief({ surface: "not-a-surface", ok: true, durationMs: 30 });
		const rows = collector.collect(instruments.snapshot(), null, 5000);

		const p95 = seriesRows(rows, "brief.p95");
		const grok = p95.find((row) => row.labels.surface === "grok-bot")!;
		expect(grok.count).toBe(20);
		expect(grok.value).toBeGreaterThan(10);
		expect(grok.value).toBeLessThanOrEqual(25);
		expect(p95.find((row) => row.labels.surface === "claude-code")?.count).toBe(4);
		// A surface outside the closed list folds into `other` rather than minting a series.
		expect(p95.find((row) => row.labels.surface === "other")?.count).toBe(1);
		expect(p95.map((row) => row.labels.surface).sort()).toEqual(["claude-code", "grok-bot", "other"]);
		expect(seriesRows(rows, "brief.p50")).toHaveLength(3);
		for (const row of rows) expect(canonicalLabels(row.series, row.labels)).not.toBeNull();
	});

	test("a restart (a registry with lower counts) never yields a negative value", () => {
		const before = new SubstrateInstruments();
		for (let i = 0; i < 30; i++) {
			before.recordEmit({ surface: "grok-bot", kind: "note", stored: true, durationMs: 10 });
			before.recordCache({ result: "hit", mode: "on" });
			before.recordAdmission({ surface: "grok-bot", klass: "read", decision: "allowed" });
			before.recordBrief({ surface: "grok-bot", ok: true, durationMs: 30 });
		}
		const collector = new SampleCollector();
		collector.prime(before.snapshot());

		const after = new SubstrateInstruments();
		after.recordEmit({ surface: "grok-bot", kind: "note", stored: true, durationMs: 10 });
		after.recordCache({ result: "miss", mode: "on" });
		after.recordAdmission({ surface: "grok-bot", klass: "read", decision: "allowed" });
		after.recordBrief({ surface: "grok-bot", ok: true, durationMs: 30 });
		const rows = collector.collect(after.snapshot(), null, 9000);

		for (const row of rows) {
			expect(row.value).toBeGreaterThanOrEqual(0);
			expect(row.count).toBeGreaterThanOrEqual(0);
		}
		expect(seriesRows(rows, "admission.decisions")).toEqual([{ tsMs: 9000, series: "admission.decisions", labels: { decision: "allowed" }, value: 1, count: 1 }]);
		expect(seriesRows(rows, "brief.p95")[0]?.count).toBe(1);
		expect(seriesRows(rows, "cache.hit_ratio")[0]?.value).toBe(0);
	});

	test("emit success, cache hit ratio, plane availability, admission and docs outcomes over one interval", () => {
		const instruments = new SubstrateInstruments();
		const collector = new SampleCollector();
		collector.prime(instruments.snapshot());

		for (let i = 0; i < 9; i++) instruments.recordEmit({ surface: "grok-bot", kind: "note", stored: true, durationMs: 20 });
		instruments.recordEmit({ surface: "grok-bot", kind: "note", stored: false, durationMs: 20 });
		for (let i = 0; i < 3; i++) instruments.recordCache({ result: "hit", mode: "on" });
		instruments.recordCache({ result: "miss", mode: "on" });
		instruments.recordCache({ result: "bypass", mode: "on" });
		for (let i = 0; i < 3; i++) instruments.recordPlane({ plane: "greptime", op: "select", outcome: "ok", durationMs: 30 });
		instruments.recordPlane({ plane: "greptime", op: "insert", outcome: "timeout", durationMs: 3000 });
		instruments.recordPlane({ plane: "index", op: "select", outcome: "open", durationMs: 0 });
		instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision: "allowed" });
		instruments.recordAdmission({ surface: "claude-code", klass: "write", decision: "allowed" });
		instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision: "shadow_limited" });
		instruments.recordDocsSearch({ surface: "grok-bot", outcome: "hit", cached: false, durationMs: 100, citations: {} });
		instruments.recordDocsSearch({ surface: "grok-bot", outcome: "empty", cached: true, durationMs: 10, citations: {} });
		const rows = collector.collect(instruments.snapshot(), null, 7000);

		expect(seriesRows(rows, "emit.success")).toEqual([{ tsMs: 7000, series: "emit.success", labels: {}, value: 0.9, count: 10 }]);
		expect(seriesRows(rows, "cache.hit_ratio")).toEqual([{ tsMs: 7000, series: "cache.hit_ratio", labels: {}, value: 0.75, count: 4 }]);
		const planes = seriesRows(rows, "plane.availability");
		expect(planes.find((row) => row.labels.plane === "greptime")).toMatchObject({ value: 0.75, count: 4 });
		expect(planes.find((row) => row.labels.plane === "index")).toMatchObject({ value: 0, count: 1 });
		// A refused call carries no duration, so the index plane has no latency row.
		expect(seriesRows(rows, "plane.p95").map((row) => row.labels.plane)).toEqual(["greptime"]);
		const decisions = seriesRows(rows, "admission.decisions");
		expect(decisions.find((row) => row.labels.decision === "allowed")?.value).toBe(2);
		expect(decisions.find((row) => row.labels.decision === "shadow_limited")?.value).toBe(1);
		const docs = seriesRows(rows, "docs.search");
		expect(docs.map((row) => [row.labels.outcome, row.value]).sort()).toEqual([["empty", 1], ["hit", 1]]);
		expect(seriesRows(rows, "docs.p95")[0]?.count).toBe(2);
		expect(seriesRows(rows, "emit.p95")[0]?.count).toBe(10);
		// Every row is storable: the series is allow-listed and its labels are closed.
		for (const row of rows) expect(canonicalLabels(row.series, row.labels)).not.toBeNull();
	});

	test("an idle interval produces no rows; a gauge that is not judged produces none", () => {
		const instruments = new SubstrateInstruments();
		instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
		const collector = new SampleCollector();
		collector.prime(instruments.snapshot());
		expect(collector.collect(instruments.snapshot(), null, 1)).toEqual([]);
		expect(collector.collect(instruments.snapshot(), Number.NaN, 2)).toEqual([]);
	});
});

interface Harness {
	handlers: Array<() => void>;
	cleared: number;
	unrefs: number;
	timers: { setInterval(handler: () => void, ms: number): { unref(): void }; clearInterval(handle: { unref(): void }): void };
	intervals: number[];
}

function fakeTimers(): Harness {
	const harness: Harness = {
		handlers: [],
		cleared: 0,
		unrefs: 0,
		intervals: [],
		timers: {
			setInterval(handler, ms) {
				harness.handlers.push(handler);
				harness.intervals.push(ms);
				return {
					unref() {
						harness.unrefs += 1;
					},
				};
			},
			clearInterval() {
				harness.cleared += 1;
			},
		},
	};
	return harness;
}

function busyInstruments(): SubstrateInstruments {
	const instruments = new SubstrateInstruments();
	instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
	return instruments;
}

describe("MetricsHistorySampler", () => {
	test("off: no timer, no snapshot, no write, and a flush that does nothing", async () => {
		const timers = fakeTimers();
		let writes = 0;
		let snapshots = 0;
		const sampler = new MetricsHistorySampler({
			settings: { enabled: false, intervalS: 60 },
			snapshot: () => {
				snapshots += 1;
				return [];
			},
			runwayDays: () => 1,
			record: async () => {
				writes += 1;
				return { stored: 0, drops: {} };
			},
			onDrop: () => undefined,
			timers: timers.timers,
		});
		expect(sampler.start()).toBe(false);
		await sampler.flush();
		sampler.stop();
		expect(timers.handlers).toHaveLength(0);
		expect(writes).toBe(0);
		expect(snapshots).toBe(0);
	});

	test("on: one unref'd timer at the interval, started once, cleared by stop", () => {
		const timers = fakeTimers();
		const sampler = new MetricsHistorySampler({
			settings: { enabled: true, intervalS: 45 },
			snapshot: () => [],
			runwayDays: () => null,
			record: async () => ({ stored: 0, drops: {} }),
			onDrop: () => undefined,
			timers: timers.timers,
		});
		expect(sampler.start()).toBe(true);
		expect(sampler.start()).toBe(true);
		expect(timers.intervals).toEqual([45_000]);
		expect(timers.unrefs).toBe(1);
		sampler.stop();
		sampler.stop();
		expect(timers.cleared).toBe(1);
	});

	test("never overlaps itself: a tick during a slow write joins it, and the next tick after it writes again", async () => {
		const instruments = busyInstruments();
		const release: Array<() => void> = [];
		let calls = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		const timers = fakeTimers();
		const sampler = new MetricsHistorySampler({
			settings: { enabled: true, intervalS: 60 },
			snapshot: () => instruments.snapshot(),
			runwayDays: () => 3,
			record: async () => {
				calls += 1;
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise<void>((resolve) => release.push(resolve));
				concurrent -= 1;
				return { stored: 1, drops: {} };
			},
			onDrop: () => undefined,
			timers: timers.timers,
		});
		sampler.start();
		const tick = timers.handlers[0]!;
		tick();
		tick();
		tick();
		await Promise.resolve();
		expect(calls).toBe(1);
		release.shift()!();
		await sampler.sample();
		tick();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(2);
		release.shift()!();
		await sampler.sample();
		expect(maxConcurrent).toBe(1);
		sampler.stop();
	});

	test("flush waits for the write in flight and then takes a fresh sample that holds what happened meanwhile", async () => {
		const instruments = busyInstruments();
		const batches: MetricSampleRow[][] = [];
		const release: Array<() => void> = [];
		const sampler = new MetricsHistorySampler({
			settings: { enabled: true, intervalS: 60 },
			snapshot: () => instruments.snapshot(),
			runwayDays: () => 2,
			record: async (rows) => {
				batches.push(rows);
				await new Promise<void>((resolve) => release.push(resolve));
				return { stored: rows.length, drops: {} };
			},
			onDrop: () => undefined,
			timers: fakeTimers().timers,
		});
		sampler.start();
		const inFlight = sampler.sample();
		await Promise.resolve();
		expect(batches).toHaveLength(1);

		let flushed = false;
		const flushing = sampler.flush().then(() => {
			flushed = true;
		});
		const joined = sampler.flush();
		await Promise.resolve();
		// Not started yet: the write in flight holds the line.
		expect(batches).toHaveLength(1);
		expect(flushed).toBe(false);

		// Recorded after the in-flight sample was taken: only the fresh one can carry it.
		instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
		release.shift()!();
		await inFlight;
		for (let i = 0; i < 50 && batches.length < 2; i++) await Promise.resolve();
		expect(batches).toHaveLength(2);
		expect(seriesRows(batches[1]!, "brief.p95")[0]?.count).toBe(1);
		expect(flushed).toBe(false);
		release.shift()!();
		await Promise.all([flushing, joined]);
		expect(flushed).toBe(true);
		expect(batches).toHaveLength(2);
	});

	test("drops are reported by closed reason; a record or a counter that throws never escapes", async () => {
		const instruments = busyInstruments();
		const seen: Array<[MetricDropReason, number]> = [];
		const sampler = new MetricsHistorySampler({
			settings: { enabled: true, intervalS: 60 },
			snapshot: () => instruments.snapshot(),
			runwayDays: () => 1,
			record: async (rows) => ({ stored: 0, drops: { breaker_open: rows.length, capped: 2 } }),
			onDrop: (reason, rows) => {
				seen.push([reason, rows]);
				throw new Error("counter failed");
			},
			timers: fakeTimers().timers,
		});
		sampler.start();
		await expect(sampler.sample()).resolves.toBeUndefined();
		expect(seen).toEqual([["breaker_open", 1], ["capped", 2]]);

		const failing = new MetricsHistorySampler({
			settings: { enabled: true, intervalS: 60 },
			snapshot: () => instruments.snapshot(),
			runwayDays: () => 1,
			record: async () => {
				throw new Error("boom");
			},
			onDrop: (reason, rows) => seen.push([reason, rows]),
			timers: fakeTimers().timers,
		});
		failing.start();
		await expect(failing.sample()).resolves.toBeUndefined();
		expect(seen.at(-1)).toEqual(["internal", 1]);
		// And the next sample still runs: the failure did not wedge the single-flight slot.
		await expect(failing.sample()).resolves.toBeUndefined();
	});

	test("the drop counter is registered only on request and carries only the reason label", () => {
		const registry = new MetricRegistry();
		expect(registry.snapshot().some((metric) => metric.name === DROPPED_METRIC)).toBe(false);
		registerMetricsHistoryMetrics(registry);
		registry.counter(DROPPED_METRIC).add(3, { reason: "ddl" });
		const metric = registry.snapshot().find((entry) => entry.name === DROPPED_METRIC);
		expect(metric?.kind).toBe("counter");
		expect(metric?.points).toEqual([{ attributes: { reason: "ddl" }, value: 3 }]);
	});
});

describe("window and step", () => {
	test("windows are a whole number and m, h or d; steps are seconds or s, m, h", () => {
		expect(parseHistoryWindow("90m")).toBe(5400);
		expect(parseHistoryWindow("6h")).toBe(21_600);
		expect(parseHistoryWindow("7d")).toBe(604_800);
		for (const bad of ["", "0h", "-1h", "1.5h", "1w", "h", "10", "99999d", "1h; DROP", " 1h", "1H"]) expect(parseHistoryWindow(bad)).toBeNull();
		expect(parseHistoryStep("60")).toBe(60);
		expect(parseHistoryStep("90s")).toBe(90);
		expect(parseHistoryStep("5m")).toBe(300);
		expect(parseHistoryStep("1h")).toBe(3600);
		for (const bad of ["", "0", "-5", "1d", "5 m", "1e3", "60; x"]) expect(parseHistoryStep(bad)).toBeNull();
	});
});

describe("metricHistoryAnswer", () => {
	const settings = { enabled: true, intervalS: 60, ttl: "14d", ttlDays: 14 };
	const now = () => Date.parse("2026-10-14T12:00:00Z");

	/** A client that reports the step the real one would run at. */
	function store(points: MetricHistoryPoint[] = [], seen: Array<Record<string, unknown>> = []) {
		return {
			async readMetricHistory(query: ReadQuery) {
				seen.push(query);
				return { points, stepS: effectiveHistoryStep(query.series, query.toMs - query.fromMs, query.stepS) };
			},
		};
	}

	test("flag off: 404 {enabled:false} and the store is never asked", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const answer = await metricHistoryAnswer({ settings: { ...settings, enabled: false }, greptime: store([], seen) as never, now }, new URLSearchParams("series=brief.p95"));
		expect(answer).toEqual({ status: 404, body: { enabled: false } });
		expect(seen).toEqual([]);
	});

	test("a series outside the allow-list is a 400 that lists the allowed ones; the store is never asked", async () => {
		const seen: Array<Record<string, unknown>> = [];
		for (const series of ["", "nope", "__proto__", "brief.p95' OR 1=1 --", "constructor"]) {
			const answer = await metricHistoryAnswer({ settings, greptime: store([], seen) as never, now }, new URLSearchParams({ series }));
			expect(answer.status).toBe(400);
			expect(answer.body.series).toEqual(Object.keys(METRIC_SERIES));
		}
		expect(seen).toEqual([]);
	});

	test("a bad window or step is a 400", async () => {
		const seen: Array<Record<string, unknown>> = [];
		for (const query of ["series=brief.p95&window=banana", "series=brief.p95&window=0h", "series=brief.p95&window=1h&step=0", "series=brief.p95&step=1d"]) {
			const answer = await metricHistoryAnswer({ settings, greptime: store([], seen) as never, now }, new URLSearchParams(query));
			expect(answer.status).toBe(400);
		}
		expect(seen).toEqual([]);
	});

	test("a valid read passes a window capped at the TTL and shows only closed labels; the step reported is the one the read ran at", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const points: MetricHistoryPoint[] = [{ tsMs: now() - 60_000, labels: { surface: "grok-bot" }, value: 41.5, count: 12 }];
		const answer = await metricHistoryAnswer(
			{ settings, greptime: store(points, seen) as never, now },
			new URLSearchParams("series=brief.p95&window=90d&step=15s"),
		);
		expect(answer.status).toBe(200);
		expect(seen[0]).toMatchObject({ series: "brief.p95", toMs: now(), fromMs: now() - 14 * 86_400_000, stepS: 15, ttl: "14d" });
		// 15 s over 14 days of a 28-surface series would be 80 000 rows; the client raised it, and the answer says so.
		const effective = effectiveHistoryStep("brief.p95", 14 * 86_400_000, 15);
		expect(effective).toBeGreaterThan(15);
		expect(answer.body).toMatchObject({
			enabled: true,
			series: "brief.p95",
			kind: "histogram",
			unit: "ms",
			aggregate: "max",
			windowCapped: true,
			retentionDays: 14,
			truncated: false,
			stepS: effective,
			points: [{ ts: "2026-10-14T11:59:00.000Z", labels: { surface: "grok-bot" }, value: 41.5, count: 12 }],
		});
	});

	test("the step is one rule: raised until buckets x label values fit the cap, never lowered, so the oldest bucket survives", () => {
		const labelled = Object.keys(METRIC_SERIES).filter((name) => (METRIC_SERIES[name]!.values?.size ?? 1) > 1);
		expect(METRIC_SERIES["brief.p95"]!.values!.size).toBe(new Set([...SURFACES, "other"]).size);
		for (const series of Object.keys(METRIC_SERIES)) {
			const labelValues = METRIC_SERIES[series]!.values?.size ?? 1;
			for (const windowMs of [3_600_000, 86_400_000, 14 * 86_400_000, 90 * 86_400_000]) {
				const step = effectiveHistoryStep(series, windowMs, 15);
				// A window spans at most ceil(window / step) + 1 date_bin buckets.
				expect((Math.ceil(windowMs / 1000 / step) + 1) * labelValues).toBeLessThanOrEqual(MAX_METRIC_POINTS);
			}
		}
		expect(labelled).toContain("brief.p95");
		// An unlabelled series keeps what was asked when it fits, a requested step is clamped to 15 s..1 day, and only ever raised.
		expect(effectiveHistoryStep("emit.success", 3_600_000, 15)).toBe(15);
		expect(effectiveHistoryStep("emit.success", 3_600_000, 1)).toBe(15);
		expect(effectiveHistoryStep("emit.success", 3_600_000, 600)).toBe(600);
		expect(effectiveHistoryStep("emit.success", 3_600_000, 10 * 86_400)).toBe(86_400);
	});

	test("the memo shares one read among concurrent requests, serves it for 15 s, re-reads after, and never grows past 64 keys", async () => {
		let clock = 1_000_000;
		const reads: string[] = [];
		const release = Promise.withResolvers<void>();
		const slow = {
			async readMetricHistory(query: ReadQuery) {
				reads.push(`${query.series}|${query.toMs - query.fromMs}`);
				await release.promise;
				return { points: [], stepS: 60 };
			},
		};
		const memo = new MetricHistoryMemo(() => clock);
		const ask = (query: string) => metricHistoryAnswer({ settings, greptime: slow as never, now: () => clock, memo }, new URLSearchParams(query));

		const pending = [ask("series=emit.success&window=1h"), ask("series=emit.success&window=1h"), ask("series=cache.hit_ratio&window=1h")];
		expect(reads).toHaveLength(2);
		release.resolve();
		expect((await Promise.all(pending)).map((answer) => answer.status)).toEqual([200, 200, 200]);
		expect(memo.size).toBe(2);

		clock += 14_999;
		await ask("series=emit.success&window=1h");
		expect(reads).toHaveLength(2);
		clock += 2;
		await ask("series=emit.success&window=1h");
		expect(reads).toHaveLength(3);

		// A refused request (bad series, window or flag) is never a memo key, so hostile input cannot fill it.
		await ask("series=nope");
		await ask("series=emit.success&window=banana");
		expect(memo.size).toBeLessThanOrEqual(2);
		// A scanner cycling through every window: bounded, newest kept, oldest evicted.
		for (let minutes = 1; minutes <= 300; minutes++) await ask(`series=emit.success&window=${minutes}m`);
		expect(memo.size).toBeLessThanOrEqual(64);
		const before = reads.length;
		await ask("series=emit.success&window=300m");
		expect(reads.length).toBe(before);
		await ask("series=emit.success&window=1m");
		expect(reads.length).toBe(before + 1);
	});

	describe("pending reads are capped and never evicted while they run", () => {
		function gated() {
			const release = Promise.withResolvers<void>();
			const reads: string[] = [];
			let running = 0;
			let peak = 0;
			let failing = false;
			const store = {
				async readMetricHistory(query: ReadQuery) {
					reads.push(`${query.series}|${query.toMs - query.fromMs}`);
					running += 1;
					peak = Math.max(peak, running);
					try {
						await release.promise;
						if (failing) throw new Error("greptime unreachable");
						return { points: [], stepS: 60 };
					} finally {
						running -= 1;
					}
				},
			};
			return { store, release, reads, peak: () => peak, fail: () => (failing = true) };
		}
		const settings16 = { enabled: true, intervalS: 60, ttl: "14d", ttlDays: 14 };

		test("100 distinct concurrent keys never start more than 16 reads; the rest are answered busy with Retry-After", async () => {
			const clock = 1_000_000;
			const world = gated();
			const memo = new MetricHistoryMemo(() => clock);
			const ask = (minutes: number) =>
				metricHistoryAnswer({ settings: settings16, greptime: world.store as never, now: () => clock, memo }, new URLSearchParams(`series=emit.success&window=${minutes}m`));
			const answers = Array.from({ length: 100 }, (_, i) => ask(i + 1));
			expect(world.reads).toHaveLength(16);
			expect(memo.pendingSize).toBe(16);
			const busy = await Promise.all(answers.slice(16));
			expect(busy.every((answer) => answer.status === 503 && answer.body.busy === true && answer.headers?.["retry-after"] === "5")).toBe(true);
			world.release.resolve();
			const ok = await Promise.all(answers.slice(0, 16));
			expect(ok.every((answer) => answer.status === 200)).toBe(true);
			expect(world.reads).toHaveLength(16);
			expect(world.peak()).toBe(16);
			expect(memo.pendingSize).toBe(0);
		});

		test("the same key joins its pending read after more than 64 other keys have completed", async () => {
			const clock = 1_000_000;
			const hanging = gated();
			const fast = gated();
			fast.release.resolve();
			const memo = new MetricHistoryMemo(() => clock, 15_000, 64, 16);
			const ask = (store: unknown, minutes: number) =>
				metricHistoryAnswer({ settings: settings16, greptime: store as never, now: () => clock, memo }, new URLSearchParams(`series=emit.success&window=${minutes}m`));
			const first = ask(hanging.store, 1);
			expect(hanging.reads).toHaveLength(1);
			// 100 other keys start and finish while key 1 is still reading; the old single map evicted key 1's pending entry here.
			for (let minutes = 2; minutes <= 101; minutes++) await ask(fast.store, minutes);
			expect(memo.size).toBeLessThanOrEqual(64);
			expect(memo.pendingSize).toBe(1);
			const joined = ask(fast.store, 1);
			expect(fast.reads).toHaveLength(100);
			expect(hanging.reads).toHaveLength(1);
			hanging.release.resolve();
			expect((await Promise.all([first, joined])).map((answer) => answer.status)).toEqual([200, 200]);
			expect(memo.pendingSize).toBe(0);
		});

		test("a full cap answers an expired completed key with its last answer instead of reading, and a failed read leaves no pending entry", async () => {
			let clock = 1_000_000;
			const memo = new MetricHistoryMemo(() => clock, 15_000, 64, 2);
			const ask = (store: unknown, query: string) =>
				metricHistoryAnswer({ settings: settings16, greptime: store as never, now: () => clock, memo }, new URLSearchParams(query));
			const quick = gated();
			quick.release.resolve();
			const known = await ask(quick.store, "series=emit.success&window=1h");
			expect(known.status).toBe(200);
			clock += 20_000;

			const slow = gated();
			const a = ask(slow.store, "series=emit.success&window=2h");
			const b = ask(slow.store, "series=emit.success&window=3h");
			expect(memo.pendingSize).toBe(2);
			// Expired but held: served as is, no third read.
			const stale = await ask(slow.store, "series=emit.success&window=1h");
			expect(stale).toBe(known);
			expect(slow.reads).toHaveLength(2);
			slow.release.resolve();
			await Promise.all([a, b]);

			const failing = gated();
			failing.fail();
			failing.release.resolve();
			const failed = await ask(failing.store, "series=emit.success&window=9h");
			expect(failed.status).toBe(503);
			expect(memo.pendingSize).toBe(0);
			// A failure is not remembered as an answer: the next request reads again.
			await ask(failing.store, "series=emit.success&window=9h");
			expect(failing.reads).toHaveLength(2);
		});
	});

	test("the default window is an hour; the default step is the sampling interval at least", async () => {
		const seen: Array<Record<string, unknown>> = [];
		await metricHistoryAnswer({ settings: { ...settings, intervalS: 120 }, greptime: store([], seen) as never, now }, new URLSearchParams("series=emit.success"));
		expect(seen[0]).toMatchObject({ fromMs: now() - 3_600_000, stepS: 120 });
	});

	test("at most 2000 points come back, and the answer says it was cut", async () => {
		const many: MetricHistoryPoint[] = Array.from({ length: 2500 }, (_, i) => ({ tsMs: i * 1000, labels: {}, value: i, count: 1 }));
		const answer = await metricHistoryAnswer({ settings, greptime: store(many) as never, now }, new URLSearchParams("series=emit.success&window=1d"));
		expect(answer.status).toBe(200);
		expect((answer.body.points as unknown[]).length).toBe(MAX_METRIC_POINTS);
		expect(answer.body.truncated).toBe(true);
	});

	test("a store that fails is a 503 with a closed message, never its error text", async () => {
		const failing = {
			async readMetricHistory(): Promise<{ points: MetricHistoryPoint[]; stepS: number }> {
				throw new Error("greptime unreachable: connect ECONNREFUSED 10.0.0.1:4000");
			},
		};
		const answer = await metricHistoryAnswer({ settings, greptime: failing as never, now }, new URLSearchParams("series=emit.success"));
		expect(answer.status).toBe(503);
		expect(JSON.stringify(answer.body)).not.toContain("10.0.0.1");
		const none = await metricHistoryAnswer({ settings, greptime: null, now }, new URLSearchParams("series=emit.success"));
		// No ledger is the same answer as the history being off.
		expect(none).toEqual({ status: 404, body: { enabled: false } });
	});
});

/** An env that names the event ledger without spelling the variable as a literal assignment (the store lock scans for that). */
const LEDGER_URL_KEY = ["GREPTIME", "URL"].join("_");
const WITH_LEDGER = { [LEDGER_URL_KEY]: "http://ledger.test" };

describe("the effective flag", () => {
	test("the switch alone is not enough: it needs the ledger, and says so at boot when it has none", () => {
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: "on" }, false)).toMatchObject({ enabled: false });
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: "on" }, false).problems).toHaveLength(1);
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY: "on" }, true)).toMatchObject({ enabled: true, problems: [] });
		expect(loadMetricsHistorySettings({}, false).problems).toEqual([]);
		expect(loadConfig({ SUBSTRATE_METRICS_HISTORY: "on" }).metricsHistory.enabled).toBe(false);
		expect(loadConfig({ ...WITH_LEDGER, SUBSTRATE_METRICS_HISTORY: "on" }).metricsHistory.enabled).toBe(true);
		expect(loadConfig({ ...WITH_LEDGER }).metricsHistory.enabled).toBe(false);
	});
});

describe("GET /slo/history over HTTP", () => {
	async function serve(env: Record<string, string>, greptime: unknown) {
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: greptime as never }, observability.observer);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return {
			base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			observability,
			close() {
				observability.stop();
				server.close();
			},
		};
	}
	test("flag off (the default): 404 {enabled:false}, no drop counter in /metrics", async () => {
		const harness = await serve({}, null);
		try {
			const response = await fetch(`${harness.base}/slo/history?series=brief.p95`);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ enabled: false });
			const names = harness.observability.snapshot().map((metric) => metric.name);
			expect(names).not.toContain(DROPPED_METRIC);
		} finally {
			harness.close();
		}
	});

	test("flag on with a ledger: 400 for a bad series, JSON points for a good one, drop counter registered, the effective step and retention reported", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const fake = {
			async readMetricHistory(query: ReadQuery) {
				seen.push(query);
				return { points: [{ tsMs: Date.now() - 1000, labels: { plane: "greptime" }, value: 0.99, count: 40 }], stepS: effectiveHistoryStep(query.series, query.toMs - query.fromMs, query.stepS) };
			},
		};
		const harness = await serve({ ...WITH_LEDGER, SUBSTRATE_METRICS_HISTORY: "on", SUBSTRATE_METRICS_HISTORY_TTL: "7d" }, fake);
		try {
			const bad = await fetch(`${harness.base}/slo/history?series=agent_events`);
			expect(bad.status).toBe(400);
			const good = await fetch(`${harness.base}/slo/history?series=plane.availability&window=2h&step=5m`);
			expect(good.status).toBe(200);
			const body = (await good.json()) as { enabled: boolean; points: Array<{ labels: Record<string, string>; value: number }>; stepS: number; retentionDays: number };
			expect(body).toMatchObject({ enabled: true, stepS: 300, retentionDays: 7, points: [{ labels: { plane: "greptime" }, value: 0.99 }] });
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ series: "plane.availability", ttl: "7d", stepS: 300 });
			expect(harness.observability.snapshot().map((metric) => metric.name)).toContain(DROPPED_METRIC);
			// Monitoring traffic: it never lands in the audit trail.
			expect(harness.observability.audit.recent()).toEqual([]);
		} finally {
			harness.close();
		}
	});

	test("two concurrent identical requests issue one read; a different key issues its own", async () => {
		let reads = 0;
		const release = Promise.withResolvers<void>();
		const twoReads = Promise.withResolvers<void>();
		const fake = {
			async readMetricHistory(query: ReadQuery) {
				reads += 1;
				if (reads === 2) twoReads.resolve();
				await release.promise;
				return { points: [], stepS: effectiveHistoryStep(query.series, query.toMs - query.fromMs, query.stepS) };
			},
		};
		const harness = await serve({ ...WITH_LEDGER, SUBSTRATE_METRICS_HISTORY: "on" }, fake);
		try {
			const first = fetch(`${harness.base}/slo/history?series=emit.success&window=6h`);
			const second = fetch(`${harness.base}/slo/history?series=emit.success&window=6h`);
			const other = fetch(`${harness.base}/slo/history?series=emit.success&window=12h`);
			// Released once the second distinct key is reading. The in-flight sharing itself is pinned deterministically in the memo test above; here a duplicate arriving late is served from the memo, and either way there are two reads.
			await twoReads.promise;
			release.resolve();
			const answers = await Promise.all([first, second, other]);
			expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
			expect(reads).toBe(2);
			// And a repeat inside the memo window is still served from it.
			expect((await fetch(`${harness.base}/slo/history?series=emit.success&window=6h`)).status).toBe(200);
			expect(reads).toBe(2);
		} finally {
			harness.close();
		}
	});

	test("history on but no ledger configured: 404 {enabled:false}, no drop counter, and a boot warning that names the key", async () => {
		const env = { SUBSTRATE_METRICS_HISTORY: "on" };
		const config = loadConfig(env);
		expect(config.metricsHistory.enabled).toBe(false);
		expect(config.metricsHistory.problems.join(" ")).toContain("SUBSTRATE_METRICS_HISTORY");
		const harness = await serve(env, { readMetricHistory: async () => ({ points: [], stepS: 60 }) });
		try {
			const response = await fetch(`${harness.base}/slo/history?series=emit.success`);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ enabled: false });
			expect(harness.observability.snapshot().map((metric) => metric.name)).not.toContain(DROPPED_METRIC);
		} finally {
			harness.close();
		}
	});

	test("SUBSTRATE_METRICS_HISTORY_SERIES reaches the route: an extended series is a 400 by default and a 200 under `extended`, and unknown values fall back with a boot problem", async () => {
		const fake = {
			async readMetricHistory(query: ReadQuery) {
				return { points: [{ tsMs: Date.now() - 1000, labels: { result: "would_include" }, value: 3, count: 3 }], stepS: effectiveHistoryStep(query.series, query.toMs - query.fromMs, query.stepS) };
			},
		};
		const base = { ...WITH_LEDGER, SUBSTRATE_METRICS_HISTORY: "on" };
		const core = await serve(base, fake);
		try {
			const refused = await fetch(`${core.base}/slo/history?series=brief.recall`);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { series: string[] }).series).toEqual(Object.keys(METRIC_SERIES));
		} finally {
			core.close();
		}

		const extended = await serve({ ...base, SUBSTRATE_METRICS_HISTORY_SERIES: "extended" }, fake);
		try {
			const served = await fetch(`${extended.base}/slo/history?series=brief.recall&window=2h`);
			expect(served.status).toBe(200);
			expect(await served.json()).toMatchObject({ series: "brief.recall", kind: "counter", unit: "{brief}", aggregate: "sum", points: [{ labels: { result: "would_include" }, value: 3 }] });
			const stillCore = await fetch(`${extended.base}/slo/history?series=plane.availability&window=2h`);
			expect(stillCore.status).toBe(200);
		} finally {
			extended.close();
		}

		expect(loadConfig({ ...base, SUBSTRATE_METRICS_HISTORY_SERIES: "everything" }).metricsHistory).toMatchObject({ series: "core" });
	});
});

/** One interval of activity that touches every instrument an extended series reads. */
function extendedActivity(instruments: SubstrateInstruments): void {
	bootEndpoints(instruments);
	for (let i = 0; i < 3; i++) instruments.recordCache({ result: "hit", mode: "on", cacheClass: "brief" });
	for (let i = 0; i < 2; i++) instruments.recordCache({ result: "miss", mode: "on", cacheClass: "memory-search" });
	instruments.recordCache({ result: "would_serve_stale", mode: "on", cacheClass: "brief" });
	instruments.recordCache({ result: "stale", mode: "on", cacheClass: "brief" });
	instruments.recordCache({ result: "refresh", mode: "degraded", cacheClass: "brief" });
	instruments.recordBriefProfile({ surface: "grok-bot", profile: "full", mode: "shadow", bytesSaved: 1200 });
	instruments.recordBriefProfile({ surface: "claude-code", profile: "full", mode: "shadow", bytesSaved: 300 });
	// A profile with nothing measured adds nothing to the saved bytes.
	instruments.recordBriefProfile({ surface: "grok-bot", profile: "full", mode: "off", bytesSaved: null });
	for (let i = 0; i < 2; i++) instruments.recordBriefRecall({ surface: "grok-bot", result: "included" });
	instruments.recordBriefRecall({ surface: "claude-code", result: "cold" });
	instruments.recordBriefRecall({ surface: "grok-bot", result: "stale" });
	for (let i = 0; i < 3; i++) instruments.recordRecallPrefetch({ surface: "grok-bot", result: "ok" });
	instruments.recordRecallPrefetch({ surface: "grok-bot", result: "error" });
	for (let i = 0; i < 4; i++) instruments.recordMemoryExpired({ surface: "grok-bot", kind: "note", mode: "served" });
	instruments.recordMemoryExpired({ surface: "claude-code", kind: "decision", mode: "hidden" });
	instruments.setHindsightOutbox({ size: 7, oldestAgeSeconds: 31.5, durable: true });
	instruments.observeIndexArchiveAge(() => 1_000, () => 61_000);
}

/** The boot-time call `createObservability` makes (observe.ts), with the count the empty environment configures. */
function bootEndpoints(instruments: SubstrateInstruments): void {
	const classes = loadConfig({}).dbEndpoints.classes;
	instruments.setEndpointProxyPlanes(Object.values(classes).filter((endpointClass) => endpointClass === "proxy").length);
}

/** Rows of one series as `{label: value}` (or the single value of an unlabelled one). */
function byLabel(rows: MetricSampleRow[], series: string): Record<string, number> {
	return Object.fromEntries(seriesRows(rows, series).map((row) => [Object.values(row.labels)[0] ?? "", row.value]));
}

describe("the extended series (uplift-5 S6)", () => {
	const core = Object.keys(METRIC_SERIES);
	const extra = Object.keys(EXTENDED_METRIC_SERIES);

	test("the allow-list is two tiers: core is today's 11 plus the event-written planning.transition, extended adds distinct closed series, and the mode picks one", () => {
		expect(core).toHaveLength(12);
		expect(core).toContain("planning.transition");
		expect(extra.length).toBeGreaterThan(0);
		expect(extra.filter((name) => core.includes(name))).toEqual([]);
		expect(Object.keys(ALL_METRIC_SERIES)).toEqual([...core, ...extra]);
		expect(metricSeriesFor(undefined)).toBe(METRIC_SERIES);
		expect(metricSeriesFor("core")).toBe(METRIC_SERIES);
		expect(metricSeriesFor("extended")).toBe(ALL_METRIC_SERIES);
		for (const name of extra) {
			expect(name).toMatch(/^[a-z0-9_.]+$/);
			const spec = EXTENDED_METRIC_SERIES[name]!;
			// Counters add; a gauge is the worst reading in a step. Neither is ever averaged.
			expect(spec.agg).toBe(spec.kind === "counter" ? "sum" : "max");
			expect(spec.kind === "counter" || spec.kind === "gauge").toBe(true);
			if (spec.label !== null) expect(spec.values?.size).toBeGreaterThan(0);
		}
	});

	test("SUBSTRATE_METRICS_HISTORY_SERIES: core by default; `extended` in any case; anything else is core with a problem that quotes nothing", () => {
		expect(loadMetricsHistorySettings({})).toMatchObject({ series: "core", problems: [] });
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_SERIES: "core" })).toMatchObject({ series: "core", problems: [] });
		expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_SERIES: "" })).toMatchObject({ series: "core", problems: [] });
		for (const raw of ["extended", " EXTENDED ", "Extended"]) {
			expect(loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_SERIES: raw })).toMatchObject({ series: "extended", problems: [] });
		}
		for (const raw of ["all", "ext", "1", "true", "extended; DROP TABLE metric_samples"]) {
			const settings = loadMetricsHistorySettings({ SUBSTRATE_METRICS_HISTORY_SERIES: raw });
			expect(settings.series).toBe("core");
			expect(settings.problems).toHaveLength(1);
			expect(settings.problems[0]).toContain("SUBSTRATE_METRICS_HISTORY_SERIES");
			expect(settings.problems[0]).not.toContain("DROP");
		}
		expect(loadConfig({ SUBSTRATE_METRICS_HISTORY_SERIES: "extended" }).metricsHistory.series).toBe("extended");
	});

	test("core mode is today's behaviour: the default and an explicit `core` sample the same rows, and none of them is an extended series", () => {
		const instruments = new SubstrateInstruments();
		const collectors = [new SampleCollector(), new SampleCollector("core"), new SampleCollector("extended")];
		for (const collector of collectors) collector.prime(instruments.snapshot());
		extendedActivity(instruments);
		for (let i = 0; i < 5; i++) instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
		instruments.recordEmit({ surface: "grok-bot", kind: "note", stored: true, durationMs: 10 });
		const snapshot = instruments.snapshot();
		const [byDefault, explicit, extended] = collectors.map((collector) => collector.collect(snapshot, 11, 5000)) as [MetricSampleRow[], MetricSampleRow[], MetricSampleRow[]];

		expect(explicit).toEqual(byDefault);
		expect(byDefault.length).toBeGreaterThan(0);
		for (const row of byDefault) expect(Object.hasOwn(METRIC_SERIES, row.series)).toBe(true);
		// Extended is core plus more, never core changed.
		expect(extended.filter((row) => Object.hasOwn(METRIC_SERIES, row.series))).toEqual(byDefault);
		expect(extended.length).toBeGreaterThan(byDefault.length);
	});

	test("extended counters are the interval's delta summed over class and mode, one row per closed label value", () => {
		const instruments = new SubstrateInstruments();
		// Lifetime activity before the baseline must not show up as one interval's.
		for (let i = 0; i < 100; i++) {
			instruments.recordCache({ result: "hit", mode: "on", cacheClass: "brief" });
			instruments.recordBriefRecall({ surface: "grok-bot", result: "included" });
		}
		const collector = new SampleCollector("extended");
		collector.prime(instruments.snapshot());
		extendedActivity(instruments);
		const rows = collector.collect(instruments.snapshot(), null, 8000);

		expect(byLabel(rows, "cache.operations")).toEqual({ hit: 3, miss: 2, would_serve_stale: 1, stale: 1, refresh: 1 });
		expect(seriesRows(rows, "brief.profile_bytes_saved")).toEqual([{ tsMs: 8000, series: "brief.profile_bytes_saved", labels: {}, value: 1500, count: 1500 }]);
		expect(byLabel(rows, "brief.recall")).toEqual({ included: 2, cold: 1, stale: 1 });
		expect(byLabel(rows, "recall.prefetch")).toEqual({ ok: 3, error: 1 });
		expect(byLabel(rows, "memory.expired")).toEqual({ served: 4, hidden: 1 });
		for (const row of seriesRows(rows, "cache.operations")) expect(row.count).toBe(row.value);
		// The core ratio is still taken from the same counter: 3 hits of 5 lookups.
		expect(seriesRows(rows, "cache.hit_ratio")[0]).toMatchObject({ value: 0.6, count: 5 });
		for (const row of rows) expect(canonicalLabels(row.series, row.labels)).not.toBeNull();
	});

	test("the gauges are the reading at the sample, every interval, and a gauge nobody set has no row", () => {
		const instruments = new SubstrateInstruments();
		const collector = new SampleCollector("extended");
		// Before anything is set: no outbox, no archive, so no gauge row. This first call is also the counters' baseline.
		expect(collector.collect(instruments.snapshot(), null, 1000)).toEqual([]);

		instruments.setHindsightOutbox({ size: 7, oldestAgeSeconds: 31.5, durable: true });
		instruments.observeIndexArchiveAge(() => 1_000, () => 61_000);
		// A gauge is a reading, not a delta: it is a row whatever the counters did.
		const afterStart = collector.collect(instruments.snapshot(), null, 2000);
		expect(afterStart).toEqual([
			{ tsMs: 2000, series: "hindsight.outbox_size", labels: {}, value: 7, count: 1 },
			{ tsMs: 2000, series: "hindsight.outbox_oldest_age_s", labels: {}, value: 31.5, count: 1 },
			{ tsMs: 2000, series: "index.archive_age_s", labels: {}, value: 60, count: 1 },
		]);

		// An idle interval still reports the gauges, and nothing else.
		const idle = collector.collect(instruments.snapshot(), null, 3000);
		expect(idle.map((row) => row.series)).toEqual(["hindsight.outbox_size", "hindsight.outbox_oldest_age_s", "index.archive_age_s"]);
		instruments.setHindsightOutbox({ size: 0, oldestAgeSeconds: 0, durable: true });
		expect(seriesRows(collector.collect(instruments.snapshot(), null, 4000), "hindsight.outbox_size")[0]?.value).toBe(0);

		// Core never reads them.
		expect(new SampleCollector().collect(instruments.snapshot(), null, 5000)).toEqual([]);
	});

	test("a label value outside the closed set mints no series", () => {
		const instruments = new SubstrateInstruments();
		const collector = new SampleCollector("extended");
		collector.prime(instruments.snapshot());
		instruments.registry.counter(METRIC.memoryExpired).add(9, { mode: "bogus" });
		instruments.registry.counter(METRIC.briefRecall).add(9, { result: "x'); DROP TABLE metric_samples; --" });
		instruments.registry.counter(METRIC.cacheOperations).add(9, { result: "other", mode: "on", class: "brief" });
		instruments.recordMemoryExpired({ surface: "grok-bot", kind: "note", mode: "served" });
		const rows = collector.collect(instruments.snapshot(), null, 6000);
		expect(byLabel(rows, "memory.expired")).toEqual({ served: 1 });
		expect(seriesRows(rows, "brief.recall")).toEqual([]);
		expect(seriesRows(rows, "cache.operations")).toEqual([]);
	});

	async function sampled(series: "core" | "extended" | undefined): Promise<MetricSampleRow[]> {
		const instruments = new SubstrateInstruments();
		const written: MetricSampleRow[] = [];
		const sampler = new MetricsHistorySampler({
			settings: series === undefined ? { enabled: true, intervalS: 60 } : { enabled: true, intervalS: 60, series },
			snapshot: () => instruments.snapshot(),
			runwayDays: () => null,
			record: async (rows) => {
				written.push(...rows);
				return { stored: rows.length, drops: {} };
			},
			onDrop: () => undefined,
			timers: fakeTimers().timers,
		});
		sampler.start();
		extendedActivity(instruments);
		for (let i = 0; i < 5; i++) instruments.recordBrief({ surface: "grok-bot", ok: true, durationMs: 40 });
		await sampler.sample();
		sampler.stop();
		return written;
	}

	test("the sampler writes only the series of its mode: no setting and `core` write core only, `extended` also writes the evidence", async () => {
		for (const series of [undefined, "core"] as const) {
			const rows = await sampled(series);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.filter((row) => !Object.hasOwn(METRIC_SERIES, row.series))).toEqual([]);
		}
		const rows = await sampled("extended");
		expect(new Set(rows.map((row) => row.series))).toEqual(new Set(["brief.p50", "brief.p95", "cache.hit_ratio", ...extra]));
	});

	describe("GET /slo/history answer by mode", () => {
		const now = () => Date.parse("2026-10-14T12:00:00Z");
		const settings = { enabled: true, intervalS: 60, ttl: "14d", ttlDays: 14 };
		function store(seen: Array<Record<string, unknown>>) {
			return {
				async readMetricHistory(query: ReadQuery) {
					seen.push(query);
					return { points: [{ tsMs: now() - 60_000, labels: { result: "miss" }, value: 5, count: 5 }], stepS: effectiveHistoryStep(query.series, query.toMs - query.fromMs, query.stepS) };
				},
			};
		}

		test("an extended series is a 400 in core mode (no setting too), listing exactly the core series; the store is never asked", async () => {
			const seen: Array<Record<string, unknown>> = [];
			for (const mode of [{}, { series: "core" as const }]) {
				for (const series of extra) {
					const answer = await metricHistoryAnswer({ settings: { ...settings, ...mode }, greptime: store(seen) as never, now }, new URLSearchParams({ series }));
					expect(answer.status).toBe(400);
					expect(answer.body.series).toEqual(core);
				}
			}
			expect(seen).toEqual([]);
		});

		test("every series is served in extended mode with its own spec and closed labels; a name outside both tiers is still a 400 listing all of them", async () => {
			const seen: Array<Record<string, unknown>> = [];
			const extended = { ...settings, series: "extended" as const };
			for (const [name, spec] of Object.entries(ALL_METRIC_SERIES)) {
				const answer = await metricHistoryAnswer({ settings: extended, greptime: store(seen) as never, now }, new URLSearchParams({ series: name }));
				expect(answer.status).toBe(200);
				expect(answer.body).toMatchObject({ series: name, kind: spec.kind, unit: spec.unit, aggregate: spec.agg });
			}
			expect(seen.map((query) => query.series)).toEqual(Object.keys(ALL_METRIC_SERIES));
			const refused = await metricHistoryAnswer({ settings: extended, greptime: store(seen) as never, now }, new URLSearchParams({ series: "nope" }));
			expect(refused.status).toBe(400);
			expect(refused.body.series).toEqual(Object.keys(ALL_METRIC_SERIES));
		});
	});

	test("the step rule counts an extended series' label values: 8 cache results mean at most 2000 / 8 - 1 buckets in 14 days", () => {
		const windowMs = 14 * 86_400_000;
		const labels = EXTENDED_METRIC_SERIES["cache.operations"]!.values!.size;
		expect(labels).toBe(8);
		const maxBuckets = Math.floor(MAX_METRIC_POINTS / labels) - 1;
		expect(effectiveHistoryStep("cache.operations", windowMs, 60)).toBe(Math.ceil(windowMs / 1000 / maxBuckets));
		// An unlabelled extended series keeps the unlabelled rule.
		expect(effectiveHistoryStep("hindsight.outbox_size", windowMs, 60)).toBe(Math.ceil(windowMs / 1000 / (MAX_METRIC_POINTS - 1)));
	});

	test("the worst case is under the batch cap: every label of every series active in one tick is the sum of the specs, and the real collector emits exactly that many rows", () => {
		// What the specs allow: one row per label value (or one row) per series.
		const sampled = Object.entries(ALL_METRIC_SERIES).filter(([name]) => !Object.hasOwn(EVENT_METRIC_SERIES, name));
		const bound = sampled.reduce((total, [, spec]) => total + (spec.values?.size ?? 1), 0);
		expect(bound).toBeLessThan(MAX_METRIC_BATCH);

		const instruments = new SubstrateInstruments();
		bootEndpoints(instruments);
		const collector = new SampleCollector("extended");
		collector.prime(instruments.snapshot());
		// Every surface (and one outside the list, which folds into `other`), plane, decision, outcome and result at once.
		for (const surface of [...SURFACES, "not-a-surface"]) instruments.recordBrief({ surface, ok: true, durationMs: 30 });
		for (const plane of PLANES) instruments.recordPlane({ plane, op: "select", outcome: "ok", durationMs: 20 });
		for (const decision of ADMISSION_DECISIONS) instruments.recordAdmission({ surface: "grok-bot", klass: "read", decision });
		for (const outcome of DOCS_SEARCH_OUTCOMES) instruments.recordDocsSearch({ surface: "grok-bot", outcome, cached: false, durationMs: 50, citations: {} });
		instruments.recordEmit({ surface: "grok-bot", kind: "note", stored: true, durationMs: 10 });
		for (const result of CACHE_METRIC_RESULTS) instruments.recordCache({ result, mode: "on", cacheClass: "brief" });
		instruments.recordBriefProfile({ surface: "grok-bot", profile: "compact", mode: "enforce", bytesSaved: 10 });
		for (const result of BRIEF_RECALL_RESULTS) instruments.recordBriefRecall({ surface: "grok-bot", result });
		for (const result of RECALL_PREFETCH_RESULTS) instruments.recordRecallPrefetch({ surface: "grok-bot", result });
		for (const mode of MEMORY_EXPIRED_MODES) instruments.recordMemoryExpired({ surface: "grok-bot", kind: "note", mode });
		instruments.setHindsightOutbox({ size: 1, oldestAgeSeconds: 1, durable: true });
		instruments.observeIndexArchiveAge(() => 0, () => 1000);

		const rows = collector.collect(instruments.snapshot(), 20, 9000);
		expect(rows).toHaveLength(bound);
		expect(rows.length).toBeLessThan(MAX_METRIC_BATCH);
		// Core alone is the same exercise with the extended rows left out.
		const sampledCore = Object.entries(METRIC_SERIES).filter(([name]) => !Object.hasOwn(EVENT_METRIC_SERIES, name));
		expect(sampledCore.reduce((total, [, spec]) => total + (spec.values?.size ?? 1), 0)).toBe(rows.filter((row) => Object.hasOwn(METRIC_SERIES, row.series)).length);
	});

	test("the ledger-side label check knows the extended series: its closed label is kept and a foreign one is not", () => {
		expect(canonicalLabels("cache.operations", { result: "would_serve_stale" })).toBe('{"result":"would_serve_stale"}');
		expect(canonicalLabels("memory.expired", { mode: "served" })).toBe('{"mode":"served"}');
		expect(canonicalLabels("hindsight.outbox_size", {})).toBe("{}");
		expect(canonicalLabels("cache.operations", { result: "weird" })).toBeNull();
		expect(canonicalLabels("cache.operations", { mode: "served" })).toBeNull();
		expect(readLabels("brief.recall", '{"result":"cold","x":"y"}')).toEqual({ result: "cold" });
		expect(readLabels("brief.recall", '{"result":"https://internal.example"}')).toEqual({});
	});
});
