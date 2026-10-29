/**
 * The corpus readings behind the three SLO gauges and the `corpus` fabric row (v1.7 phase 70): the state class on its own, then
 * the wiring through a real `Substrate` with a fake manifest, a fake plane and a ledger stub, so an ingest request, a status
 * read and a stored `docs.canary` report each move the reading and the gauge the way the docs say.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL } from "@substrate/corpus";
import { CORPUS_FRESHNESS_METRIC, CORPUS_GOLDEN_RECALL5_METRIC, CORPUS_INGEST_RATE_METRIC } from "@substrate/observability";
import { loadConfig } from "../config.ts";
import { createObservability, type Observability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import type { SubstrateEvent } from "../types.ts";
import type { CorpusStatusSummary } from "./store.ts";
import { CorpusSloState } from "./slo.ts";
import { FakePlane, FakeStore, makeDocument } from "./testkit.ts";

describe("CorpusSloState", () => {
	test("starts with no reading at all, and a missing reading is null rather than 0", () => {
		const state = new CorpusSloState();
		expect(state.newestAtMs()).toBeNull();
		expect(state.readings(1_000_000)).toEqual({ freshnessS: null, recall5: null, ingestDocsPerS: null });
	});

	test("freshness is the seconds since the manifest's last ingest, from the status answer, and an unreadable answer keeps the last one", () => {
		const state = new CorpusSloState();
		state.setLastChangeFrom("2026-10-29T00:00:00.000Z");
		const at = Date.parse("2026-10-29T00:00:00.000Z");
		expect(state.newestAtMs()).toBe(at);
		expect(state.readings(at + 90_000).freshnessS).toBe(90);
		state.setLastChangeFrom(null);
		state.setLastChangeFrom("not a date");
		expect(state.newestAtMs()).toBe(at);
		// A change dated after now (a clock step) is 0 seconds old, never negative.
		expect(state.readings(at - 5_000).freshnessS).toBe(0);
	});

	test("the ingest reading is the request's rate when it sent documents, and none after a request that sent nothing, while the gauge sees both", () => {
		const gauge: number[] = [];
		const state = new CorpusSloState({ ingestRate: (rate) => gauge.push(rate) });
		state.recordIngest(10, 2000);
		expect(state.readings(0).ingestDocsPerS).toBe(5);
		state.recordIngest(0, 800);
		expect(state.readings(0).ingestDocsPerS).toBeNull();
		expect(gauge).toEqual([5, 0]);
	});

	test("a docs.canary payload sets the golden recall, and a value that is not a recall is ignored without touching the last one", () => {
		const seen: number[] = [];
		const state = new CorpusSloState({ goldenRecall: (recall) => seen.push(recall) });
		state.recordGolden({ action: "docs.canary", golden_recall5: 0.75 });
		state.recordGolden({ action: "docs.canary", golden_recall5: 1.5 });
		state.recordGolden({ action: "docs.canary", golden_recall5: "0.9" });
		state.recordGolden({ action: "docs.canary" });
		expect(state.readings(0).recall5).toBe(0.75);
		expect(seen).toEqual([0.75]);
	});
});

/** A manifest that reports a last ingest time, as the Postgres one does. */
class DatedStore extends FakeStore {
	lastIngestAt: string | null = null;
	override async status(): Promise<CorpusStatusSummary> {
		return { ...(await super.status()), lastIngestAt: this.lastIngestAt };
	}
}

/** A ledger that keeps every event it is given. */
class LedgerStub {
	readonly events: SubstrateEvent[] = [];
	async ensureAppendMode(): Promise<boolean> {
		return true;
	}
	async lastHash(): Promise<string | null> {
		return null;
	}
	async hasEvent(): Promise<boolean> {
		return true;
	}
	async insertEvent(event: SubstrateEvent): Promise<void> {
		this.events.push(event);
	}
}

interface World {
	substrate: Substrate;
	store: DatedStore;
	ledger: LedgerStub;
	observability: Observability;
	gauge(name: string): number | null;
}

const running: Observability[] = [];
afterAll(() => {
	for (const observability of running) observability.stop();
});

async function world(env: Record<string, string | undefined> = { SUBSTRATE_CORPUS: "on" }): Promise<World> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	running.push(observability);
	const store = new DatedStore();
	const ledger = new LedgerStub();
	const substrate = new Substrate(config, { index: null, greptime: ledger as never, corpus: { store, plane: new FakePlane() } }, observability.observer);
	const gauge = (name: string): number | null => {
		const metric = observability.snapshot().find((candidate) => candidate.name === name);
		return metric?.kind === "gauge" ? (metric.points[0]?.value ?? null) : null;
	};
	return { substrate, store, ledger, observability, gauge };
}

function canary(payload: Record<string, unknown>, surface: "substrate" | "omp" = "substrate") {
	return { surface, kind: "note" as const, summary: "docs canary report", session_id: "docs-canary:t", payload: { action: "docs.canary", runtime: "docs-canary", ...payload } };
}

const ingestBody = (body: string) => ({ protocol: CORPUS_PROTOCOL, documents: [makeDocument("acme/atlas", "docs/a.md", body)], tombstones: [] });

describe("an ingest request", () => {
	test("sets the throughput gauge and the SLO reading when it sent documents, and an idle request leaves the gauge at 0 and the reading empty", async () => {
		const w = await world();
		expect(w.gauge(CORPUS_INGEST_RATE_METRIC)).toBeNull();
		const first = await w.substrate.corpusIngest(ingestBody("# A\nthe first document"), "omp");
		expect(first.ok).toBe(true);
		const rate = defined(w.gauge(CORPUS_INGEST_RATE_METRIC), "ingest gauge");
		expect(rate).toBeGreaterThan(0);
		const readings = await w.substrate.fabricSources().corpus();
		expect(readings.ingestDocsPerS).toBe(rate);

		// The same document again is unchanged: nothing is sent, so the gauge reads 0 and the objective is not judged.
		const second = await w.substrate.corpusIngest(ingestBody("# A\nthe first document"), "omp");
		expect(second.ok).toBe(true);
		expect(w.gauge(CORPUS_INGEST_RATE_METRIC)).toBe(0);
		expect((await w.substrate.fabricSources().corpus()).ingestDocsPerS).toBeNull();
	});

	test("a refused request records nothing", async () => {
		const w = await world();
		const refused = await w.substrate.corpusIngest({ protocol: 999 }, "omp");
		expect(refused.ok).toBe(false);
		expect(w.gauge(CORPUS_INGEST_RATE_METRIC)).toBeNull();
		expect((await w.substrate.fabricSources().corpus()).ingestDocsPerS).toBeNull();
	});

	test("with the corpus off nothing is recorded and the freshness gauge is never installed", async () => {
		const w = await world({});
		const reply = await w.substrate.corpusIngest(ingestBody("# A\nbody"), "omp");
		expect(reply.ok).toBe(false);
		await w.substrate.refreshCorpusReadings();
		expect(w.gauge(CORPUS_INGEST_RATE_METRIC)).toBeNull();
		expect(w.gauge(CORPUS_FRESHNESS_METRIC)).toBeNull();
		expect(w.observability.snapshot().some((metric) => metric.name === CORPUS_FRESHNESS_METRIC)).toBe(false);
	});
});

describe("freshness", () => {
	test("is the age of the manifest's last ingest, read from the store on a fabric read, a status read and a refresh, and it grows", async () => {
		const w = await world();
		expect(w.gauge(CORPUS_FRESHNESS_METRIC)).toBeNull();
		w.store.lastIngestAt = new Date(Date.now() - 3_600_000).toISOString();
		const readings = await w.substrate.fabricSources().corpus();
		expect(defined(readings.freshnessS)).toBeGreaterThanOrEqual(3600);
		expect(defined(readings.freshnessS)).toBeLessThan(3660);
		expect(defined(w.gauge(CORPUS_FRESHNESS_METRIC))).toBeGreaterThanOrEqual(3600);

		const other = await world();
		other.store.lastIngestAt = new Date(Date.now() - 7_200_000).toISOString();
		await other.substrate.corpusStatus("omp");
		expect(defined(other.gauge(CORPUS_FRESHNESS_METRIC))).toBeGreaterThanOrEqual(7200);

		const third = await world();
		third.store.lastIngestAt = new Date(Date.now() - 600_000).toISOString();
		await third.substrate.refreshCorpusReadings();
		expect(defined(third.gauge(CORPUS_FRESHNESS_METRIC))).toBeGreaterThanOrEqual(600);
	});

	test("an empty manifest has no freshness, and a store that fails keeps the last reading instead of failing the read", async () => {
		const w = await world();
		expect((await w.substrate.fabricSources().corpus()).freshnessS).toBeNull();
		w.store.lastIngestAt = new Date(Date.now() - 1_000_000).toISOString();
		await w.substrate.refreshCorpusReadings();
		const before = defined((await w.substrate.fabricSources().corpus()).freshnessS);
		w.store.status = async () => {
			throw new Error("connection lost");
		};
		await w.substrate.refreshCorpusReadings();
		expect(defined((await w.substrate.fabricSources().corpus()).freshnessS)).toBeGreaterThanOrEqual(before);
	});
});

describe("a stored docs.canary report", () => {
	test("sets the golden recall reading and gauge, and a payload that is not a recall changes nothing", async () => {
		const w = await world();
		await w.substrate.emit(canary({ golden_recall5: 0.8 }));
		expect(w.ledger.events).toHaveLength(1);
		expect(w.gauge(CORPUS_GOLDEN_RECALL5_METRIC)).toBe(0.8);
		expect((await w.substrate.fabricSources().corpus()).recall5).toBe(0.8);
		await w.substrate.emit(canary({ golden_recall5: 7 }));
		await w.substrate.emit(canary({}));
		expect(w.gauge(CORPUS_GOLDEN_RECALL5_METRIC)).toBe(0.8);
	});

	test("only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored", async () => {
		const w = await world();
		await w.substrate.emit(canary({ golden_recall5: 0.4 }, "omp"));
		await w.substrate.emit({ ...canary({ golden_recall5: 0.4 }), payload: { action: "docs.canary", runtime: "other", golden_recall5: 0.4 } });
		await w.substrate.emit({ ...canary({ golden_recall5: 0.4 }), payload: { action: "other", runtime: "docs-canary", golden_recall5: 0.4 } });
		expect(w.gauge(CORPUS_GOLDEN_RECALL5_METRIC)).toBeNull();
	});

	test("with the corpus off the report is stored and the reading is not kept", async () => {
		const w = await world({});
		await w.substrate.emit(canary({ golden_recall5: 0.8 }));
		expect(w.ledger.events).toHaveLength(1);
		expect(w.gauge(CORPUS_GOLDEN_RECALL5_METRIC)).toBeNull();
	});
});

describe("the fabric's corpus source", () => {
	test("carries the flag, the three thresholds as configured and a corpus-off server reads unconfigured", async () => {
		const on = await world({ SUBSTRATE_CORPUS: "on", SUBSTRATE_DOCS_SLO_FRESHNESS_S: "600", SUBSTRATE_DOCS_SLO_RECALL5: "0.7", SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S: "2" });
		expect(on.substrate.fabricSources().config).toMatchObject({ corpusEnabled: true, docsSlo: { freshnessS: 600, recall5: 0.7, ingestDocsPerS: 2 } });
		const off = await world({});
		expect(off.substrate.fabricSources().config).toMatchObject({ corpusEnabled: false, docsSlo: { freshnessS: 86_400, recall5: 0.6, ingestDocsPerS: 0.2 } });
	});
});
