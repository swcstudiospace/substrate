/**
 * The instruments behind uplift-4 S5: the two recall counters keep closed label
 * sets, the cache class is in the closed class list, and the retain outbox
 * gauges carry exactly one unlabelled value each.
 */
import { describe, expect, test } from "bun:test";
import {
	BRIEF_RECALL_MODES,
	BRIEF_RECALL_RESULTS,
	CACHE_METRIC_CLASSES,
	OUTBOX_DURABLE_METRIC,
	OUTBOX_OLDEST_METRIC,
	OUTBOX_SIZE_METRIC,
	METRIC,
	RECALL_PREFETCH_RESULTS,
	SubstrateInstruments,
	type BriefRecallResult,
	type RecallPrefetchResult,
} from "./instruments.ts";
import { findCounter, type MetricSnapshot } from "./metrics.ts";

function gaugeValue(snapshot: MetricSnapshot[], name: string): { value: number; attributes: Record<string, unknown> } | null {
	const metric = snapshot.find((candidate) => candidate.name === name);
	if (metric === undefined || metric.kind !== "gauge") return null;
	const point = metric.points[0];
	return point === undefined ? null : { value: point.value, attributes: point.attributes };
}

describe("substrate.brief.recall", () => {
	test("counts each closed result per surface and drops anything else", () => {
		const instruments = new SubstrateInstruments();
		for (const result of BRIEF_RECALL_RESULTS) instruments.recordBriefRecall({ surface: "grok-bot", result });
		instruments.recordBriefRecall({ surface: "grok-bot", result: "bogus" as BriefRecallResult });
		const counter = findCounter(instruments.snapshot(), METRIC.briefRecall);
		expect(counter?.points).toHaveLength(BRIEF_RECALL_RESULTS.length);
		expect(counter?.points.map((point) => point.attributes.result).sort()).toEqual([...BRIEF_RECALL_RESULTS].sort());
		for (const point of counter?.points ?? []) expect(Object.keys(point.attributes).sort()).toEqual(["result", "surface"]);
	});

	test("the vocabularies are the specified ones", () => {
		expect([...BRIEF_RECALL_MODES]).toEqual(["off", "shadow", "enforce"]);
		expect([...BRIEF_RECALL_RESULTS]).toEqual(["included", "would_include", "cold", "stale", "disabled", "dropped_by_cap"]);
	});
});

describe("substrate.recall.prefetch", () => {
	test("counts each closed result per surface and drops anything else", () => {
		const instruments = new SubstrateInstruments();
		for (const result of RECALL_PREFETCH_RESULTS) instruments.recordRecallPrefetch({ surface: "omp", result });
		instruments.recordRecallPrefetch({ surface: "omp", result: "rate-limited" as RecallPrefetchResult });
		const counter = findCounter(instruments.snapshot(), METRIC.recallPrefetch);
		expect(counter?.points.map((point) => point.attributes.result).sort()).toEqual([...RECALL_PREFETCH_RESULTS].sort());
	});
});

describe("the recall-snapshot cache class", () => {
	test("is a member of the closed class list, so a cache operation on it keeps its label", () => {
		expect([...CACHE_METRIC_CLASSES]).toContain("recall-snapshot");
		const instruments = new SubstrateInstruments();
		instruments.recordCache({ result: "hit", mode: "on", cacheClass: "recall-snapshot" });
		instruments.recordCache({ result: "hit", mode: "on", cacheClass: "something-else" });
		const classes = findCounter(instruments.snapshot(), METRIC.cacheOperations)?.points.map((point) => point.attributes.class).sort();
		expect(classes).toEqual(["recall-snapshot", "unknown"]);
	});
});

describe("setHindsightOutbox", () => {
	test("sets three unlabelled gauges, durable as 0 or 1", () => {
		const instruments = new SubstrateInstruments();
		expect(gaugeValue(instruments.snapshot(), OUTBOX_SIZE_METRIC)).toBeNull();
		instruments.setHindsightOutbox({ size: 3, oldestAgeSeconds: 42, durable: true });
		expect(gaugeValue(instruments.snapshot(), OUTBOX_SIZE_METRIC)).toEqual({ value: 3, attributes: {} });
		expect(gaugeValue(instruments.snapshot(), OUTBOX_OLDEST_METRIC)).toEqual({ value: 42, attributes: {} });
		expect(gaugeValue(instruments.snapshot(), OUTBOX_DURABLE_METRIC)).toEqual({ value: 1, attributes: {} });
		instruments.setHindsightOutbox({ size: 0, oldestAgeSeconds: 0, durable: false });
		expect(gaugeValue(instruments.snapshot(), OUTBOX_SIZE_METRIC)?.value).toBe(0);
		expect(gaugeValue(instruments.snapshot(), OUTBOX_DURABLE_METRIC)?.value).toBe(0);
	});
});
