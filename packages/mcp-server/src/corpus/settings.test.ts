import { describe, expect, test } from "bun:test";
import { loadConfig, loadCorpusSettings } from "../config.ts";

describe("loadCorpusSettings", () => {
	test("everything unset is the safe default: closed, four batches in flight, twenty documents, one megabyte", () => {
		expect(loadCorpusSettings({})).toEqual({ enabled: false, concurrency: 4, batchDocs: 20, batchBytes: 1_000_000, freshMaxAgeS: 172_800 });
		expect(loadConfig({}).corpus.enabled).toBe(false);
	});

	test("only the word on, in any case, opens the corpus: 1, true and yes do not", () => {
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS: "on" }).enabled).toBe(true);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS: " ON " }).enabled).toBe(true);
		for (const value of ["1", "true", "yes", "off", "", "onn"]) expect({ value, enabled: loadCorpusSettings({ SUBSTRATE_CORPUS: value }).enabled }).toEqual({ value, enabled: false });
	});

	test("a value out of range is clamped into it, so a typo can neither stop the ingest nor widen it past the plane's limits", () => {
		const high = loadCorpusSettings({ SUBSTRATE_CORPUS_CONCURRENCY: "500", SUBSTRATE_CORPUS_BATCH_DOCS: "9999", SUBSTRATE_CORPUS_BATCH_BYTES: "999999999" });
		expect(high).toMatchObject({ concurrency: 16, batchDocs: 200, batchBytes: 5_000_000 });
		const low = loadCorpusSettings({ SUBSTRATE_CORPUS_CONCURRENCY: "0", SUBSTRATE_CORPUS_BATCH_DOCS: "0", SUBSTRATE_CORPUS_BATCH_BYTES: "5" });
		expect(low).toMatchObject({ concurrency: 1, batchDocs: 1, batchBytes: 10_000 });
	});

	test("a value that is not a whole number is the default, not a guess", () => {
		const junk = loadCorpusSettings({ SUBSTRATE_CORPUS_CONCURRENCY: "four", SUBSTRATE_CORPUS_BATCH_DOCS: "2.5", SUBSTRATE_CORPUS_BATCH_BYTES: "-1" });
		expect(junk).toMatchObject({ concurrency: 4, batchDocs: 20, batchBytes: 1_000_000 });
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_CONCURRENCY: " 8 " }).concurrency).toBe(8);
	});
});

describe("the doc watch settings (v1.7 phase 65)", () => {
	test("the freshness age is two days unless set; 0 switches the judgement off; a bad value is the default and a huge one is a year", () => {
		expect(loadCorpusSettings({}).freshMaxAgeS).toBe(172_800);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "3600" }).freshMaxAgeS).toBe(3600);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "0" }).freshMaxAgeS).toBe(0);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "two days" }).freshMaxAgeS).toBe(172_800);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "-5" }).freshMaxAgeS).toBe(172_800);
		expect(loadCorpusSettings({ SUBSTRATE_CORPUS_FRESH_MAX_AGE_S: "999999999999" }).freshMaxAgeS).toBe(31_536_000);
	});

	test("the planning hash store is on unless the flag names another value", () => {
		expect(loadConfig({}).planningHashStore).toBe(true);
		expect(loadConfig({ SUBSTRATE_PLANNING_HASH_STORE: "" }).planningHashStore).toBe(true);
		expect(loadConfig({ SUBSTRATE_PLANNING_HASH_STORE: " On " }).planningHashStore).toBe(true);
		for (const value of ["1", "true", "yes", "off"]) expect({ value, on: loadConfig({ SUBSTRATE_PLANNING_HASH_STORE: value }).planningHashStore }).toEqual({ value, on: false });
	});
});
