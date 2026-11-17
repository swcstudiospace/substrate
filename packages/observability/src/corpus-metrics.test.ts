/**
 * The three gauges of the corpus atlas SLOs (phase 70): freshness is computed when read so it keeps growing, the ingest rate
 * and the golden recall are the last value set, and a value that is not a reading is never stored.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_FRESHNESS_METRIC, CORPUS_GOLDEN_RECALL5_METRIC, CORPUS_INGEST_RATE_METRIC, SubstrateInstruments } from "./instruments.ts";
import type { MetricSnapshot } from "./metrics.ts";

function readings(snapshot: MetricSnapshot[], name: string): number[] {
	const metric = snapshot.find((candidate) => candidate.name === name);
	return metric === undefined || metric.kind !== "gauge" ? [] : metric.points.map((point) => point.value);
}

describe("observeCorpusFreshness", () => {
	test("is the age in seconds of the newest change, recomputed at every snapshot, and has no point before there is a change", () => {
		const instruments = new SubstrateInstruments();
		let newest: number | null = null;
		let clock = 100_000;
		instruments.observeCorpusFreshness(() => newest, () => clock);
		expect(readings(instruments.snapshot(), CORPUS_FRESHNESS_METRIC)).toEqual([]);
		newest = 40_000;
		expect(readings(instruments.snapshot(), CORPUS_FRESHNESS_METRIC)).toEqual([60]);
		clock = 130_000;
		expect(readings(instruments.snapshot(), CORPUS_FRESHNESS_METRIC)).toEqual([90]);
	});

	test("a change dated in the future (a clock step) reads 0, never negative", () => {
		const instruments = new SubstrateInstruments();
		instruments.observeCorpusFreshness(() => 200_000, () => 100_000);
		expect(readings(instruments.snapshot(), CORPUS_FRESHNESS_METRIC)).toEqual([0]);
	});

	test("a source that throws reads as no point instead of failing the snapshot", () => {
		const instruments = new SubstrateInstruments();
		instruments.observeCorpusFreshness(() => {
			throw new Error("store gone");
		});
		expect(readings(instruments.snapshot(), CORPUS_FRESHNESS_METRIC)).toEqual([]);
	});
});

describe("setCorpusIngestRate", () => {
	test("keeps the last rate, 0 included, and ignores a negative or non-finite one", () => {
		const instruments = new SubstrateInstruments();
		expect(readings(instruments.snapshot(), CORPUS_INGEST_RATE_METRIC)).toEqual([]);
		instruments.setCorpusIngestRate(2.5);
		expect(readings(instruments.snapshot(), CORPUS_INGEST_RATE_METRIC)).toEqual([2.5]);
		instruments.setCorpusIngestRate(Number.NaN);
		instruments.setCorpusIngestRate(-1);
		instruments.setCorpusIngestRate(Number.POSITIVE_INFINITY);
		expect(readings(instruments.snapshot(), CORPUS_INGEST_RATE_METRIC)).toEqual([2.5]);
		instruments.setCorpusIngestRate(0);
		expect(readings(instruments.snapshot(), CORPUS_INGEST_RATE_METRIC)).toEqual([0]);
	});
});

describe("setCorpusGoldenRecall5", () => {
	test("keeps the last recall in [0, 1] and ignores anything outside it", () => {
		const instruments = new SubstrateInstruments();
		instruments.setCorpusGoldenRecall5(0.8);
		for (const bad of [1.01, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) instruments.setCorpusGoldenRecall5(bad);
		expect(readings(instruments.snapshot(), CORPUS_GOLDEN_RECALL5_METRIC)).toEqual([0.8]);
		instruments.setCorpusGoldenRecall5(0);
		instruments.setCorpusGoldenRecall5(1);
		expect(readings(instruments.snapshot(), CORPUS_GOLDEN_RECALL5_METRIC)).toEqual([1]);
	});
});
