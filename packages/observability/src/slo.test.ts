import { describe, expect, test } from "bun:test";
import { METRIC, SubstrateInstruments } from "./instruments.ts";
import { findCounter, sumCounter } from "./metrics.ts";
import {
	DOCS_FRESHNESS_ID,
	evaluateDocsFreshnessSlo,
	type DocsFreshnessReading,
	ADMISSION_SLO,
	CAPACITY_RING_MAX,
	CapacityRing,
	DEFAULT_THRESHOLDS,
	INDEX_VOLUME_ENV,
	PLANE_BUCKET_MS,
	PLANE_WINDOW_MS,
	PlaneWindow,
	breaches,
	briefBySurfaceObjectives,
	evaluateAdmissionSlo,
	evaluateCapacitySlos,
	docsSearchObjective,
	evaluateDocsSlos,
	evaluatePlaneSlos,
	evaluateSlos,
	SERVED_TOKENS_ENV,
	servedTokensBySurface,
	sloCatalogue,
	type PlaneSloResult,
} from "./slo.ts";
import { BURN_MIN_SPAN_MS, BURN_WINDOW_MS, type BurnResult, BurnLedger, evaluateBurnSlos, loadBurnThresholds } from "./burn.ts";

function slo(results: ReturnType<typeof evaluateSlos>, id: string) {
	const found = results.find((result) => result.id === id);
	if (!found) throw new Error(`no SLO ${id}`);
	return found;
}

function briefs(latencies: number[]): SubstrateInstruments {
	const instruments = new SubstrateInstruments();
	for (const durationMs of latencies) instruments.recordBrief({ surface: "omp", ok: true, durationMs });
	return instruments;
}

describe("the catalogue", () => {
	test("states the four objectives SPE-4793 asks for", () => {
		expect(sloCatalogue().map((target) => target.id)).toEqual([
			"brief.p95",
			"emit.success",
			"lease.steal_rate",
			"quarantine.rate",
		]);
	});

	test("the defaults are the numbers in the ticket", () => {
		expect(DEFAULT_THRESHOLDS.briefP95Ms).toBe(800);
		expect(DEFAULT_THRESHOLDS.emitSuccessRatio).toBe(0.995);
	});

	test("an operator's threshold overrides the default and reaches the statement", () => {
		const [brief] = sloCatalogue({ briefP95Ms: 400 });
		expect(brief?.statement).toContain("400 ms");
	});

	test("an undefined override does not wipe the default", () => {
		// `loadObservabilityConfig` returns `undefined` for every unset threshold, so
		// spreading it must not overwrite the defaults with holes.
		const [brief] = sloCatalogue({ briefP95Ms: undefined });
		expect(brief?.statement).toContain("800 ms");
	});
});

describe("admission.limited_rate (uplift-3 N3), beside the catalogue", () => {
	function decided(counts: { allowed?: number; limited?: number; shadow?: number; bypass?: number }): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		const record = (decision: "allowed" | "limited" | "shadow_limited" | "bypass", times = 0) => {
			for (let index = 0; index < times; index += 1) instruments.recordAdmission({ surface: "cursor", klass: "read", decision });
		};
		record("allowed", counts.allowed);
		record("limited", counts.limited);
		record("shadow_limited", counts.shadow);
		record("bypass", counts.bypass);
		return instruments;
	}

	test("is not in the catalogue, and needs 100 decisions before it is judged", () => {
		expect(sloCatalogue().some((target) => target.id === ADMISSION_SLO.id)).toBe(false);
		expect(ADMISSION_SLO).toMatchObject({ id: "admission.limited_rate", kind: "ratio-ceiling", target: 0.01, minSamples: 100 });
		const result = evaluateAdmissionSlo(decided({ allowed: 98, limited: 1 }).snapshot());
		expect(result).toMatchObject({ id: "admission.limited_rate", status: "insufficient-data", samples: 99, unit: "ratio", target: 0.01 });
		expect(result.observed).toBeCloseTo(1 / 99);
		expect(evaluateAdmissionSlo(new SubstrateInstruments().snapshot())).toMatchObject({ status: "insufficient-data", samples: 0, observed: null });
	});

	test("limited over everything the bucket decided: shadow refusals count as decisions, not as refusals", () => {
		const ok = evaluateAdmissionSlo(decided({ allowed: 50, shadow: 49, limited: 1 }).snapshot());
		expect(ok).toMatchObject({ status: "ok", samples: 100, observed: 0.01 });
		expect(ok.detail).toBe("1 of 100 (1.000 %); objective is at most 1.000 %");
		const breached = evaluateAdmissionSlo(decided({ allowed: 98, limited: 2 }).snapshot());
		expect(breached).toMatchObject({ status: "breached", samples: 100, observed: 0.02 });
	});

	test("a bypass is not a decision: a cache outage neither dilutes the rate nor counts toward the sample floor", () => {
		const result = evaluateAdmissionSlo(decided({ allowed: 90, limited: 2, bypass: 500 }).snapshot());
		expect(result).toMatchObject({ status: "insufficient-data", samples: 92 });
		const judged = evaluateAdmissionSlo(decided({ allowed: 97, limited: 3, bypass: 900 }).snapshot());
		expect(judged).toMatchObject({ status: "breached", samples: 100, observed: 0.03 });
	});
});

describe("brief p95 <= 800 ms", () => {
	test("met when 95 % of briefs landed below the 800 ms boundary", () => {
		// 96 fast, 4 slow: the verdict is the exact count below the boundary, not an
		// interpolated quantile. These are provably below it, so the sentence carries no
		// bucket-edge caveat.
		const instruments = briefs([...Array.from({ length: 96 }, () => 400), ...Array.from({ length: 4 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot()), "brief.p95");

		expect(result.status).toBe("ok");
		expect(result.samples).toBe(100);
		expect(result.detail).toContain("96.00 % of 100 observations were below 800 ms");
		expect(result.detail).not.toContain("rests on");
	});

	test("breached when 94 % did", () => {
		const instruments = briefs([...Array.from({ length: 94 }, () => 400), ...Array.from({ length: 6 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot()), "brief.p95");

		expect(result.status).toBe("breached");
		expect(breaches(evaluateSlos(instruments.snapshot())).map((entry) => entry.id)).toContain("brief.p95");
	});

	test("exactly 95 % below the threshold is met", () => {
		const instruments = briefs([...Array.from({ length: 95 }, () => 400), ...Array.from({ length: 5 }, () => 3000)]);
		expect(slo(evaluateSlos(instruments.snapshot()), "brief.p95").status).toBe("ok");
	});

	test("a healthy run inside the boundary bucket is `ok`", () => {
		// The regression this file exists for. 96 briefs at 600 ms and 4 at 3 s meets the
		// objective with room to spare, but 600 ms sits in the (400, 800] bucket, so
		// nothing about it is *provably* below 800. Judging on the below-count alone made
		// that `unmeasurable` — which enforces `p95 <= 400 ms` and leaves every healthy
		// distribution in the band the objective exists to allow unable to report `ok`.
		const instruments = briefs([...Array.from({ length: 96 }, () => 600), ...Array.from({ length: 4 }, () => 3000)]);
		const results = evaluateSlos(instruments.snapshot());
		const result = slo(results, "brief.p95");

		expect(result.status).toBe("ok");
		expect(result.samples).toBe(100);
		expect(breaches(results).map((entry) => entry.id)).not.toContain("brief.p95");
	});

	test("an `ok` carried by the boundary bucket says so, and names the bucket edge", () => {
		// `ok` here counts the (400, 800] bucket, whose upper edge is inclusive in OTLP, so
		// it cannot exclude briefs at exactly 800 ms. That is stated in the sentence rather
		// than left as an unqualified green tick.
		const instruments = briefs([...Array.from({ length: 96 }, () => 600), ...Array.from({ length: 4 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot()), "brief.p95");

		expect(result.detail).toContain("96.00 % of 100 observations were at or below 800 ms");
		expect(result.detail).toContain("only 0.00 % provably below it");
		expect(result.detail).toContain("400–800 ms bucket, whose upper edge is inclusive");
		expect(result.detail).toContain("briefs at exactly 800 ms count as meeting it");
	});

	test("the objective is stated as the `<=` the histogram can decide, not the ticket's `<`", () => {
		// SPE-4793 words it `p95 < 800 ms`. A bucket bound is an inclusive upper edge in
		// OTLP — the 800 ms bucket holds (400, 800] — so no bucketed histogram can separate
		// 800.000 from 799.999. A run at exactly 800 ms is therefore met, and the statement
		// prints the claim the check actually makes.
		const result = slo(evaluateSlos(briefs(Array.from({ length: 30 }, () => 800)).snapshot()), "brief.p95");

		expect(result.statement).toContain("<= 800 ms");
		expect(result.status).toBe("ok");
		expect(result.detail).toContain("100.00 % of 30 observations were at or below 800 ms");
		expect(result.detail).toContain("briefs at exactly 800 ms count as meeting it");
	});

	test("narrowing with a bucket bound under the threshold rules the boundary bucket out", () => {
		// The remedy the detail points at: judged at 400 ms, the same 600 ms run is a clean
		// breach, with no bucket-edge caveat either way.
		const instruments = briefs([...Array.from({ length: 96 }, () => 600), ...Array.from({ length: 4 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot(), sloCatalogue({ briefP95Ms: 400 })), "brief.p95");

		expect(result.status).toBe("breached");
		expect(result.detail).toContain("0.00 % of 100 observations were at or below 400 ms");
	});

	test("a brief a fraction above the boundary is outside it", () => {
		const instruments = briefs(Array.from({ length: 30 }, () => 800.5));
		expect(slo(evaluateSlos(instruments.snapshot()), "brief.p95").status).toBe("breached");
	});

	test("too few observations is `insufficient-data`, never `ok`", () => {
		// A green SLO computed from three samples is a claim the data does not support,
		// and it is exactly what an evidence bundle must not carry.
		const result = slo(evaluateSlos(briefs([1, 2, 3]).snapshot()), "brief.p95");

		expect(result.status).toBe("insufficient-data");
		expect(result.detail).toContain("3 of 20");
	});

	test("no data at all is reported as such, not as a pass", () => {
		expect(slo(evaluateSlos(new SubstrateInstruments().snapshot()), "brief.p95").status).toBe("insufficient-data");
	});

	test("a threshold that is not a bucket bound is `unmeasurable`", () => {
		// A bucketed histogram cannot answer it exactly, and interpolating quietly would
		// be a verdict the data does not support.
		const instruments = briefs(Array.from({ length: 30 }, () => 100));
		const result = slo(evaluateSlos(instruments.snapshot(), sloCatalogue({ briefP95Ms: 750 })), "brief.p95");

		expect(result.status).toBe("unmeasurable");
		expect(result.detail).toContain("not one of this histogram's bucket bounds");
	});

	test("reports an interpolated p95 alongside the verdict, and says when it is off the top", () => {
		const fast = slo(evaluateSlos(briefs(Array.from({ length: 30 }, () => 30)).snapshot()), "brief.p95");
		expect(fast.observed).toBeGreaterThan(25);
		expect(fast.observed).toBeLessThanOrEqual(50);

		const slow = slo(evaluateSlos(briefs(Array.from({ length: 30 }, () => 20_000)).snapshot()), "brief.p95");
		expect(slow.observed).toBeNull();
		expect(slow.detail).toContain("> 8000");
	});
});

describe("emit success >= 99.5 %", () => {
	function emits(stored: number, dropped: number): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < stored; i++) instruments.recordEmit({ surface: "omp", kind: "shell", stored: true, durationMs: 1 });
		for (let i = 0; i < dropped; i++)
			instruments.recordEmit({ surface: "omp", kind: "shell", stored: false, durationMs: 1 });
		return instruments;
	}

	test("met at 999 of 1000", () => {
		const result = slo(evaluateSlos(emits(999, 1).snapshot()), "emit.success");
		expect(result.status).toBe("ok");
		expect(result.observed).toBeCloseTo(0.999, 6);
	});

	test("breached at 99 of 100", () => {
		expect(slo(evaluateSlos(emits(99, 1).snapshot()), "emit.success").status).toBe("breached");
	});

	test("a ledger that took nothing at all is breached, not unmeasured", () => {
		const result = slo(evaluateSlos(emits(0, 60).snapshot()), "emit.success");
		expect(result.status).toBe("breached");
		expect(result.observed).toBe(0);
	});

	test("too few emits is not yet judged", () => {
		expect(slo(evaluateSlos(emits(1, 1).snapshot()), "emit.success").status).toBe("insufficient-data");
	});
});

describe("lease-steal and quarantine rates", () => {
	function claims(options: { granted: number; stolen?: number; quarantined?: number }): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < options.granted; i++) instruments.recordClaim({ surface: "omp", outcome: "granted" });
		for (let i = 0; i < (options.stolen ?? 0); i++) instruments.recordClaim({ surface: "omp", outcome: "stolen" });
		for (let i = 0; i < (options.quarantined ?? 0); i++)
			instruments.recordQuarantine({ surface: "omp", reason: "unrecorded-claim" });
		return instruments;
	}

	test("no steals in 100 claims is met", () => {
		expect(slo(evaluateSlos(claims({ granted: 100 }).snapshot()), "lease.steal_rate").status).toBe("ok");
	});

	test("one steal in 100 breaches the 0.5 % ceiling", () => {
		const result = slo(evaluateSlos(claims({ granted: 99, stolen: 1 }).snapshot()), "lease.steal_rate");
		expect(result.status).toBe("breached");
		expect(result.detail).toContain("at most");
	});

	test("the quarantine rate is quarantines over claims, across two metrics", () => {
		const result = slo(evaluateSlos(claims({ granted: 100, quarantined: 5 }).snapshot()), "quarantine.rate");
		expect(result.status).toBe("breached");
		expect(result.observed).toBeCloseTo(0.05, 6);
		expect(result.samples).toBe(100);
	});

	test("a ceiling with no claims yet is not judged", () => {
		expect(slo(evaluateSlos(new SubstrateInstruments().snapshot()), "quarantine.rate").status).toBe("insufficient-data");
	});

	test("the ceilings can be relaxed by an operator who has a baseline", () => {
		// The defaults are provisional: no lease expiry exists yet, so there is nothing
		// to derive them from.
		const instruments = claims({ granted: 99, stolen: 1 });
		const relaxed = sloCatalogue({ leaseStealRatio: 0.02 });
		expect(slo(evaluateSlos(instruments.snapshot(), relaxed), "lease.steal_rate").status).toBe("ok");
	});
});

describe("naming", () => {
	test("every objective names a metric the instruments actually register", () => {
		// A catalogue that referred to a metric nothing records would report
		// `insufficient-data` forever and look like a quiet system.
		const registered = new Set(new SubstrateInstruments().snapshot().map((metric) => metric.name));
		for (const target of [...sloCatalogue(), docsSearchObjective()]) {
			const names = target.kind === "latency-quantile" ? [target.metric] : [target.numerator.metric, target.denominator.metric];
			for (const name of names) expect(registered).toContain(name);
		}
		expect(registered).toContain(METRIC.briefDuration);
	});
});

describe("docs.search.p95 (uplift-3 N5)", () => {
	function searches(latencies: number[]): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		for (const durationMs of latencies) {
			instruments.recordDocsSearch({ surface: "grok-bot", outcome: "hit", cached: false, durationMs, citations: {} });
		}
		return instruments;
	}

	test("is one row beside the catalogue, never in it, with the 2,000 ms default stated inclusively", () => {
		expect(sloCatalogue().map((target) => target.id)).not.toContain("docs.search.p95");
		const [row] = evaluateDocsSlos(new SubstrateInstruments().snapshot());
		expect(row?.id).toBe("docs.search.p95");
		expect(row?.statement).toBe(`p95 of ${METRIC.docsDuration} <= 2000 ms`);
		expect(DEFAULT_THRESHOLDS.docsSearchP95Ms).toBe(2000);
	});

	test("too few searches is `insufficient-data`, never `ok`", () => {
		expect(slo(evaluateDocsSlos(new SubstrateInstruments().snapshot()), "docs.search.p95").status).toBe("insufficient-data");
		const result = slo(evaluateDocsSlos(searches(Array.from({ length: 19 }, () => 100)).snapshot()), "docs.search.p95");
		expect(result.status).toBe("insufficient-data");
		expect(result.detail).toContain("19 of 20");
	});

	test("judged exactly at the histogram's own 2,000 ms edge: 95 % at or below is ok, less is breached", () => {
		const ok = evaluateDocsSlos(searches([...Array.from({ length: 95 }, () => 1500), ...Array.from({ length: 5 }, () => 3000)]).snapshot());
		expect(slo(ok, "docs.search.p95").status).toBe("ok");
		const breached = evaluateDocsSlos(searches([...Array.from({ length: 94 }, () => 1500), ...Array.from({ length: 6 }, () => 3000)]).snapshot());
		expect(slo(breached, "docs.search.p95").status).toBe("breached");
		// A search that cost the whole default budget sits above the edge.
		const budgeted = evaluateDocsSlos(searches(Array.from({ length: 30 }, () => 4000)).snapshot());
		expect(slo(budgeted, "docs.search.p95").status).toBe("breached");
	});

	test("an operator's threshold reaches the statement, but only one of the histogram's edges is decidable", () => {
		const tuned = slo(evaluateDocsSlos(searches(Array.from({ length: 30 }, () => 500)).snapshot(), { docsSearchP95Ms: 1000 }), "docs.search.p95");
		expect(tuned.statement).toContain("1000 ms");
		expect(tuned.status).toBe("ok");
		expect(slo(evaluateDocsSlos(searches(Array.from({ length: 30 }, () => 500)).snapshot(), { docsSearchP95Ms: 1500 }), "docs.search.p95").status).toBe(
			"unmeasurable",
		);
	});
});

describe("brief.p95 per surface (uplift-3 N7)", () => {
	/** Briefs per surface, each list one latency per brief; graph ids vary so the per-surface merge spans series. */
	function perSurface(bySurface: Record<string, number[]>): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		for (const [surface, latencies] of Object.entries(bySurface)) {
			latencies.forEach((durationMs, index) => {
				instruments.recordBrief({ surface, graph_id: index % 2 === 0 ? "ut-a" : "ut-b", ok: true, durationMs });
			});
		}
		return instruments;
	}
	const fast = (n: number) => Array.from({ length: n }, () => 100);

	test("is empty with no histogram and empty while no surface reaches minSamples; a surface at 19 is absent", () => {
		expect(briefBySurfaceObjectives([])).toEqual([]);
		expect(briefBySurfaceObjectives(new SubstrateInstruments().snapshot())).toEqual([]);
		const rows = briefBySurfaceObjectives(perSurface({ "grok-bot": fast(19), omp: fast(5) }).snapshot());
		expect(rows).toEqual([]);
	});

	test("one brief.p95 row per surface at or above 20 samples, in the catalogue's shape plus the surface, sorted", () => {
		const rows = briefBySurfaceObjectives(perSurface({ omp: fast(20), "grok-bot": fast(25), cursor: fast(19) }).snapshot());
		expect(rows.map((row) => [row.surface, row.id, row.samples, row.status])).toEqual([
			["grok-bot", "brief.p95", 25, "ok"],
			["omp", "brief.p95", 20, "ok"],
		]);
		expect(rows[0]?.statement).toBe(`p95 of ${METRIC.briefDuration}{surface=grok-bot} <= 800 ms`);
		expect(rows[0]?.target).toBe(800);
		expect(rows[0]?.unit).toBe("ms");
		// The global objective is unchanged: it still blends every surface.
		expect(slo(evaluateSlos(perSurface({ omp: fast(20), "grok-bot": fast(25) }).snapshot()), "brief.p95").samples).toBe(45);
		expect(sloCatalogue().map((target) => target.id)).toEqual(["brief.p95", "emit.success", "lease.steal_rate", "quarantine.rate"]);
	});

	test("a slow surface is breached on its own row while a fast one stays ok, and the blend can hide it", () => {
		const instruments = perSurface({ "grok-bot": Array.from({ length: 20 }, () => 1500), omp: fast(400) });
		const rows = briefBySurfaceObjectives(instruments.snapshot());
		expect(rows.find((row) => row.surface === "grok-bot")?.status).toBe("breached");
		expect(rows.find((row) => row.surface === "omp")?.status).toBe("ok");
		// 20 slow of 420: 95.2 % at or below 800 ms, so the global row reads ok.
		expect(slo(evaluateSlos(instruments.snapshot()), "brief.p95").status).toBe("ok");
	});

	test("takes the operator's briefP95Ms and minSamples like the global objective", () => {
		const snapshot = perSurface({ "grok-bot": Array.from({ length: 10 }, () => 300) }).snapshot();
		expect(briefBySurfaceObjectives(snapshot)).toEqual([]);
		const [row] = briefBySurfaceObjectives(snapshot, { minSamples: 10, briefP95Ms: 400 });
		expect(row?.statement).toContain("400 ms");
		expect(row?.status).toBe("ok");
		expect(briefBySurfaceObjectives(snapshot, { minSamples: 10, briefP95Ms: 200 })[0]?.status).toBe("breached");
	});
});

describe("the quota-burn objectives (SPE-10477)", () => {
	const HOUR = BURN_WINDOW_MS;
	// The ceilings every judged reading in this block runs under; a fresh registry is
	// handed to each evaluation, so successive snapshots carry growing *cumulative*
	// totals and the ledger takes the rate from their delta.
	const CEILINGS = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000000", SUBSTRATE_BURN_COST_USD_PER_HOUR: "40" };

	/** One usage burst: the instruments after recording `count` tokens (or `usd` spend). */
	function usageAfter(count: number, usd = 0): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		const payload: Record<string, number> = {};
		if (count > 0) payload.input_tokens = count;
		if (usd > 0) payload.cost_usd = usd;
		instruments.recordUsage({ surface: "omp", payload });
		return instruments;
	}

	function burn(results: BurnResult[], id: string) {
		const found = results.find((result) => result.id === id);
		if (!found) throw new Error(`no burn objective ${id}`);
		return found;
	}

	function fedLedger(first: SubstrateInstruments, atMs: number): BurnLedger {
		// The first evaluation feeds the ledger its base sample — which only happens
		// when the objective is judged, so the ceilings must be set here. Its own
		// verdict is always `insufficient-data`, exactly what a single reading deserves.
		const ledger = new BurnLedger(HOUR, 0);
		evaluateBurnSlos(first.snapshot(), { env: CEILINGS, ledger, now: atMs });
		return ledger;
	}

	test("over the ceiling breaches: a half-hour rate extrapolated to the hour", () => {
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000000" };
		const ledger = fedLedger(usageAfter(0), 0);
		const result = burn(evaluateBurnSlos(usageAfter(600_000).snapshot(), { env, ledger, now: HOUR / 2 }), "burn.tokens");

		// 600k tokens in 30 minutes is 1.2M per hour: caught in half the window.
		expect(result.status).toBe("breached");
		expect(result.observed).toBe(1_200_000);
		expect(result.samples).toBe(2);
		expect(result.detail).toContain("1200000 tokens/h");
		expect(result.detail).toContain("over the 1000000 tokens/h ceiling");
	});

	test("under the ceiling is met, and exactly at it is met too", () => {
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000000" };
		const ledger = fedLedger(usageAfter(0), 0);
		const under = burn(evaluateBurnSlos(usageAfter(400_000).snapshot(), { env, ledger, now: HOUR / 2 }), "burn.tokens");
		expect(under.status).toBe("ok");
		expect(under.detail).toContain("800000 tokens/h");

		// 500k in the half hour lands exactly on the ceiling: a ceiling is met at it,
		// the same inclusive reading the ratio-ceiling catalogue entries take.
		const fresh = fedLedger(usageAfter(0), 0);
		const at = burn(evaluateBurnSlos(usageAfter(500_000).snapshot(), { env, ledger: fresh, now: HOUR / 2 }), "burn.tokens");
		expect(at.status).toBe("ok");
	});

	test("the cost objective runs the same math in dollars", () => {
		const env = { SUBSTRATE_BURN_COST_USD_PER_HOUR: "40" };
		const ledger = fedLedger(usageAfter(0, 25), 0);
		// The cumulative total moved from 25 to 50: 25 dollars over the half hour.
		const result = burn(evaluateBurnSlos(usageAfter(0, 50).snapshot(), { env, ledger, now: HOUR / 2 }), "burn.cost_usd");

		expect(result.status).toBe("breached");
		expect(result.observed).toBeCloseTo(50, 6);
		expect(result.detail).toContain("50.00 USD/h");
		expect(result.statement).toContain("<= 40.00 USD");
	});

	test("an unset threshold is reported as unconfigured and never breaches", () => {
		const results = evaluateBurnSlos(usageAfter(10_000_000).snapshot(), { env: {}, ledger: new BurnLedger(HOUR, 0), now: 0 });

		expect(results.map((result) => result.id)).toEqual(["burn.tokens", "burn.cost_usd"]);
		for (const result of results) {
			expect(result.status).toBe("unconfigured");
			expect(result.observed).toBe(null);
			expect(result.target).toBe(null);
		}
		// The objective still says what it would check, and who owns the number.
		expect(results[0]?.statement).toContain("SUBSTRATE_BURN_TOKENS_PER_HOUR (unset)");
	});

	test("a malformed threshold warns once and is treated as unset", () => {
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "soon-ish", SUBSTRATE_BURN_COST_USD_PER_HOUR: "-5" };
		const warnings: string[] = [];
		const ledger = new BurnLedger(HOUR, 0);

		const first = evaluateBurnSlos(usageAfter(0).snapshot(), { env, ledger, now: 0, warn: (m) => warnings.push(m) });
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("SUBSTRATE_BURN_TOKENS_PER_HOUR");
		expect(warnings[0]).toContain("treated as unset");
		expect(warnings[1]).toContain("SUBSTRATE_BURN_COST_USD_PER_HOUR");
		expect(burn(first, "burn.tokens").status).toBe("unconfigured");
	});

	test("the default writer reports a malformed ceiling once per variable, ever", () => {
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "soon-ish" };
		const lines: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			loadBurnThresholds(env);
			loadBurnThresholds(env);
		} finally {
			process.stderr.write = original;
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("SUBSTRATE_BURN_TOKENS_PER_HOUR");
	});

	test("a rate is not invented from a single reading, or from a too-short span", () => {
		const ledger = new BurnLedger(HOUR, BURN_MIN_SPAN_MS);
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000000" };

		// One sample says nothing. Nor do two samples a minute apart, when the honest
		// per-hour answer needs five minutes of span to be more than noise.
		evaluateBurnSlos(usageAfter(0).snapshot(), { env, ledger, now: 0 });
		const oneMinute = burn(evaluateBurnSlos(usageAfter(50_000).snapshot(), { env, ledger, now: 60_000 }), "burn.tokens");
		expect(oneMinute.status).toBe("insufficient-data");

		// At five minutes of span the first verdict lands: 100k tokens over five
		// minutes is 1.2M per hour, over the ceiling.
		const fiveMinutes = burn(evaluateBurnSlos(usageAfter(100_000).snapshot(), { env, ledger, now: BURN_MIN_SPAN_MS }), "burn.tokens");
		expect(fiveMinutes.status).toBe("breached");
		expect(fiveMinutes.observed).toBe(1_200_000);
	});

	test("a sample older than the window is dropped, not divided across", () => {
		const ledger = fedLedger(usageAfter(0), 0);
		const env = { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000000" };

		// Two hours of silence: the base sample has fallen out of the window, so the
		// honest verdict is insufficient-data, not a rate divided across the gap.
		const result = burn(evaluateBurnSlos(usageAfter(50_000).snapshot(), { env, ledger, now: 2 * HOUR }), "burn.tokens");
		expect(result.status).toBe("insufficient-data");
	});

	test("a counter reset drops the history rather than subtracting across it", () => {
		// A restart hands the process a fresh registry; subtracting its total from the
		// old one would read the restart itself as negative spend.
		const ledger = new BurnLedger(HOUR, 0);
		expect(ledger.observe("substrate.tokens", 100, 0).perHour).toBe(null);
		expect(ledger.observe("substrate.tokens", 90, 60_000).perHour).toBe(null);
		const reading = ledger.observe("substrate.tokens", 90 + 100, 2 * 60_000);
		// 100 tokens across the one minute after the reset: 6000 per hour.
		expect(reading.perHour).toBe(6000);
		expect(reading.samples).toBe(2);
	});

	test("a reset whose first new read lands in the same second still starts fresh", () => {
		// The coalesced same-second sample is the reset's own first reading, not a
		// base to subtract the restart across.
		const ledger = new BurnLedger(HOUR, 0);
		expect(ledger.observe("substrate.tokens", 100, 0).samples).toBe(1);
		const reading = ledger.observe("substrate.tokens", 90, 400);
		expect(reading.samples).toBe(1);
		expect(reading.perHour).toBe(null);
		// 100 tokens across the one second after the reset: 360000 per hour.
		expect(ledger.observe("substrate.tokens", 190, 1_400).perHour).toBe(360_000);
	});

	test("a fast /slo poller still leaves a five-minute span: same-second reads coalesce", () => {
		// The ring used to bound samples by count alone, so a host reading /slo
		// twice a second filled it in four minutes — under the five-minute minimum
		// span — and both burn checks answered `insufficient-data` forever no
		// matter what was spent. Same-second reads are one sample: the cap bounds
		// seconds of history, not reads, while a genuinely idle hour (samples
		// older than the window) is still dropped, not divided across.
		const ledger = new BurnLedger(HOUR, BURN_MIN_SPAN_MS);
		let reading = ledger.observe("substrate.tokens", 0, 0);
		reading = ledger.observe("substrate.tokens", 5, 500);
		expect(reading.samples).toBe(1); // half a second later is still one second of history

		while (reading.samples < 480) {
			const second = Math.ceil(reading.spanMs / 1000) + 1;
			reading = ledger.observe("substrate.tokens", 10 * second, second * 1000 + 250);
		}
		expect(reading.samples).toBe(480); // the cap: 480 distinct seconds
		expect(reading.spanMs).toBeGreaterThanOrEqual(BURN_MIN_SPAN_MS);
		expect(reading.perHour).not.toBe(null);
	});
});

describe("the per-plane availability objectives (uplift-2 R2)", () => {
	const ALL = { greptime: true, index: true, cache: true, hindsight: true, ragflow: true };

	/** `n` plane calls on `plane`, `bad` of them failed. */
	function calls(instruments: SubstrateInstruments, plane: "greptime" | "index" | "cache" | "hindsight" | "ragflow", n: number, bad = 0) {
		for (let i = 0; i < n; i++) {
			const outcome = i < bad ? (i % 3 === 0 ? "timeout" : i % 3 === 1 ? "error" : "open") : "ok";
			instruments.recordPlane({ plane, op: "op", outcome, durationMs: 10, ...(outcome === "ok" ? {} : { reason: "x" }) });
		}
	}

	function plane(results: PlaneSloResult[], id: string): PlaneSloResult {
		const found = results.find((result) => result.id === id);
		if (!found) throw new Error(`no plane objective ${id}`);
		return found;
	}

	test("names one objective per plane, in the catalogue's shape, and never breaches an unconfigured plane", () => {
		const results = evaluatePlaneSlos([], { configured: { greptime: true }, window: new PlaneWindow(), now: 0 });
		expect(results.map((result) => result.id)).toEqual([
			"plane.greptime.availability",
			"plane.index.availability",
			"plane.cache.availability",
			"plane.hindsight.availability",
			"plane.ragflow.availability",
			"plane.lightrag.availability",
		]);
		expect(plane(results, "plane.index.availability")).toMatchObject({ status: "unconfigured", observed: null, samples: 0, unit: "ratio", target: 0.99 });
		expect(plane(results, "plane.index.availability").detail).toContain("not configured");
		expect(plane(results, "plane.greptime.availability").status).toBe("insufficient-data");
		expect(plane(results, "plane.greptime.availability").statement).toContain("substrate.plane.duration{plane=greptime} >= 99.00 %");
	});

	test("one reading judges nothing; two readings judge the calls between them", () => {
		const instruments = new SubstrateInstruments();
		const window = new PlaneWindow();
		calls(instruments, "greptime", 50);
		const first = plane(evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 0 }), "plane.greptime.availability");
		expect(first.status).toBe("insufficient-data");
		expect(first.samples).toBe(0);
		calls(instruments, "greptime", 40);
		const second = plane(evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 30_000 }), "plane.greptime.availability");
		expect(second).toMatchObject({ status: "ok", observed: 1, samples: 40 });
		expect(second.detail).toContain("40 of 40 calls ok");
	});

	test("breached when more than 1 % of the window's calls did not get an answer, counting open-breaker refusals", () => {
		const instruments = new SubstrateInstruments();
		const window = new PlaneWindow();
		evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 0 });
		calls(instruments, "hindsight", 100, 3);
		const result = plane(evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 60_000 }), "plane.hindsight.availability");
		expect(result).toMatchObject({ status: "breached", observed: 0.97, samples: 100 });
		expect(result.detail).toContain("97 of 100 calls ok");
		// The ragflow plane is untouched: enough readings, no calls.
		expect(plane(evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 61_000 }), "plane.ragflow.availability").status).toBe(
			"insufficient-data",
		);
	});

	test("an operator's threshold and minimum sample count apply", () => {
		const instruments = new SubstrateInstruments();
		const window = new PlaneWindow();
		evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 0 });
		calls(instruments, "index", 10, 1);
		const strict = plane(
			evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 1000, target: 0.95, minSamples: 5 }),
			"plane.index.availability",
		);
		expect(strict).toMatchObject({ status: "breached", target: 0.95, samples: 10 });
		const lax = plane(
			evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 2000, target: 0.9, minSamples: 5 }),
			"plane.index.availability",
		);
		expect(lax.status).toBe("ok");
		expect(DEFAULT_THRESHOLDS.planeAvailability).toBe(0.99);
	});

	test("the window rolls: calls older than an hour drop out, and a restart starts the history over", () => {
		const instruments = new SubstrateInstruments();
		const window = new PlaneWindow();
		evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 0 });
		calls(instruments, "cache", 100, 50);
		evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 60_000 });
		calls(instruments, "cache", 100);
		// Two readings inside the hour still see the bad minute.
		expect(plane(evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: 120_000 }), "plane.cache.availability").status).toBe("breached");
		// An hour past the first reading, the base moves to the second and the bad minute is gone.
		calls(instruments, "cache", 100);
		const later = plane(
			evaluatePlaneSlos(instruments.snapshot(), { configured: ALL, window, now: PLANE_WINDOW_MS + 1 }),
			"plane.cache.availability",
		);
		expect(later.status).toBe("ok");
		expect(later.samples).toBe(200);
		// A fresh registry (restart) reads lower than the last sample: history dropped, nothing judged.
		const fresh = new SubstrateInstruments();
		calls(fresh, "cache", 5);
		expect(plane(evaluatePlaneSlos(fresh.snapshot(), { configured: ALL, window, now: PLANE_WINDOW_MS + 2000 }), "plane.cache.availability").status).toBe(
			"insufficient-data",
		);
	});

	test("same-bucket readings coalesce, so a fast poller does not fill the ring", () => {
		// A bucket keeps its first reading as the baseline and its newest as the
		// head; the answer is head − baseline of the oldest kept bucket. With 1 s
		// buckets here: the 500 ms reading joins the 0 ms bucket (baseline stays
		// 1/1), the 1600 ms reading replaces the 1500 ms head: ok 3−1, total 4−1.
		const window = new PlaneWindow(PLANE_WINDOW_MS, 1000);
		expect(window.observe("greptime", 1, 1, 0)).toEqual({ ok: 0, total: 0, spanMs: 0, samples: 1 });
		expect(window.observe("greptime", 2, 2, 500)).toEqual({ ok: 1, total: 1, spanMs: 500, samples: 1 });
		expect(window.observe("greptime", 3, 3, 1500)).toEqual({ ok: 2, total: 2, spanMs: 1500, samples: 2 });
		expect(window.observe("greptime", 3, 4, 1600)).toEqual({ ok: 2, total: 3, spanMs: 1600, samples: 2 });
		// A bucket leaves once its newest reading is older than the window; the
		// next bucket's first reading becomes the baseline.
		expect(window.observe("greptime", 10, 10, 1600 + PLANE_WINDOW_MS)).toEqual({ ok: 7, total: 7, spanMs: PLANE_WINDOW_MS + 100, samples: 2 });
		expect(window.observe("greptime", 11, 12, 2601 + PLANE_WINDOW_MS)).toEqual({ ok: 1, total: 2, spanMs: 1001, samples: 2 });
	});

	test("two readings inside one bucket still judge: a fresh process read twice within 10 s", () => {
		// Greptile round 1 regression: with the newest reading as the bucket's
		// baseline, the second reading collapsed to zero calls and `insufficient-data`.
		const window = new PlaneWindow();
		expect(window.observe("index", 0, 0, 0).spanMs).toBe(0);
		expect(window.observe("index", 9, 10, 1000)).toEqual({ ok: 9, total: 10, spanMs: 1000, samples: 1 });
	});

	test("the window covers the hour whatever the scrape rate (Greptile round 1)", () => {
		// Default buckets are 10 s, so an hour is 360 of them. A 1 Hz poller for 61
		// minutes used to keep eight minutes of history under a count cap; now a
		// failure burst in the first 30 s is still judged 59 minutes later and gone
		// only once it is older than the hour.
		expect(PLANE_BUCKET_MS).toBe(10_000);
		const window = new PlaneWindow();
		let ok = 0;
		let total = 0;
		let reading = window.observe("hindsight", ok, total, 0);
		for (let second = 1; second <= 61 * 60; second++) {
			// One call a second, failing for the first 30 s only.
			total += 1;
			if (second > 30) ok += 1;
			reading = window.observe("hindsight", ok, total, second * 1000);
			if (second === 59 * 60) {
				// Baseline: bucket 0's first reading (second 0); 355 buckets kept.
				expect(reading.samples).toBe(355);
				expect(reading.spanMs).toBe(59 * 60 * 1000);
				expect(reading.total - reading.ok).toBe(30);
			}
		}
		// 61 minutes in: bucket 5 (newest reading at 59 s) has rolled off; the
		// baseline is bucket 6's first reading (second 60, after the burst).
		expect(reading.samples).toBe(361);
		expect(reading.spanMs).toBe(PLANE_WINDOW_MS);
		expect(reading.total - reading.ok).toBe(0);
		expect(reading.total).toBe(3600);

		// A slow poller covers the same hour with fewer readings.
		const slow = new PlaneWindow();
		let last = slow.observe("ragflow", 0, 0, 0);
		for (let minute = 1; minute <= 61; minute++) last = slow.observe("ragflow", minute * 60, minute * 60, minute * 60_000);
		expect(last.samples).toBe(61);
		expect(last.spanMs).toBe(PLANE_WINDOW_MS);
		expect(last.total).toBe(3600);
	});
});

describe("the capacity runway objective (uplift-3 N2)", () => {
	const GB = 1_073_741_824;
	const MB = 1_048_576;
	const DAY = 24 * 60 * 60 * 1000;
	const T0 = Date.parse("2026-10-13T00:00:00Z");

	/** `hours` of samples, one every 10 minutes, growing `perDay` bytes a day from `start`. */
	function ring(hours: number, perDay: number, start = 2 * GB): CapacityRing {
		const out = new CapacityRing();
		for (let minute = 0; minute <= hours * 60; minute += 10) {
			out.record(T0 + minute * 60_000, Math.round(start + (perDay * minute) / (24 * 60)));
		}
		return out;
	}

	test("48 h growing 100 MB/day against a 10 GB volume is (10 GB - current) / 100 MB days", () => {
		const samples = ring(48, 100 * MB);
		const [result] = evaluateCapacitySlos(samples, { volumeBytes: 10 * GB });
		const current = samples.samples().at(-1)!.databaseBytes;
		expect(result!.id).toBe("capacity.index.runway_days");
		expect(result!.status).toBe("ok");
		expect(result!.bytesPerDay).toBeCloseTo(100 * MB, -3);
		expect(result!.observed).toBeCloseTo((10 * GB - current) / (100 * MB), 1);
		expect(result!.unit).toBe("days");
		expect(result!.target).toBe(14);
		expect(result!.samples).toBe(samples.size);
		expect(result!.volumeBytes).toBe(10 * GB);
		expect(result!.currentBytes).toBe(current);
		expect(result!.detail).toContain("days of runway");
	});

	test("under 24 h of samples is insufficient-data, whatever the growth", () => {
		const [result] = evaluateCapacitySlos(ring(23, 100 * GB), { volumeBytes: 10 * GB });
		expect(result!.status).toBe("insufficient-data");
		expect(result!.observed).toBeNull();
		expect(result!.detail).toContain("23.0 h");
		expect(result!.detail).toContain("24 h apart");
	});

	test("an unset volume is insufficient-data and names the variable", () => {
		const [result] = evaluateCapacitySlos(ring(48, 100 * MB), { volumeBytes: null });
		expect(result!.status).toBe("insufficient-data");
		expect(result!.detail).toContain(INDEX_VOLUME_ENV);
		expect(result!.statement).toContain("unset");
		expect(result!.volumeBytes).toBeNull();
	});

	test("less runway than the floor is breached; a full volume has none", () => {
		const [tight] = evaluateCapacitySlos(ring(48, 1 * GB, 2 * GB), { volumeBytes: 10 * GB });
		expect(tight!.status).toBe("breached");
		expect(tight!.observed).toBeCloseTo(6, 0);
		const [full] = evaluateCapacitySlos(ring(48, 1 * MB, 10 * GB), { volumeBytes: 10 * GB });
		expect(full!.status).toBe("breached");
		expect(full!.observed).toBe(0);
		expect(full!.detail).toContain("no runway remains");
	});

	test("an index that is not growing has an unbounded runway and is ok", () => {
		const [result] = evaluateCapacitySlos(ring(48, -50 * MB, 5 * GB), { volumeBytes: 10 * GB });
		expect(result!.status).toBe("ok");
		expect(result!.observed).toBeNull();
		expect(result!.bytesPerDay).toBeLessThan(0);
		expect(result!.detail).toContain("not growing");
	});

	test("the floor is a threshold", () => {
		const [result] = evaluateCapacitySlos(ring(48, 100 * MB), { volumeBytes: 10 * GB, targetDays: 1000 });
		expect(result!.status).toBe("breached");
		expect(result!.target).toBe(1000);
	});

	test("one bulk ingest at the end does not set the rate alone", () => {
		const samples = ring(48, 0, 2 * GB);
		samples.record(T0 + 48 * 60 * 60_000 + 60_000 * 15, 2 * GB + 500 * MB);
		const [result] = evaluateCapacitySlos(samples, { volumeBytes: 10 * GB });
		// First-to-last would say 250 MB/day; the fit over 289 flat samples says far less.
		expect(result!.bytesPerDay).toBeLessThan(30 * MB);
	});

	test("the ring keeps the first read of each minute bucket, ignores junk and a clock behind it, and is bounded", () => {
		const samples = new CapacityRing();
		samples.record(T0, 100);
		// A later read in the same bucket never moves the sample's time or size.
		samples.record(T0 + 30_000, 110);
		samples.record(T0 + 59_999, 111);
		expect(samples.samples()).toEqual([{ at: T0, databaseBytes: 100 }]);
		samples.record(T0 + 90_000, 120);
		expect(samples.size).toBe(2);
		samples.record(T0 + 80_000, 999);
		samples.record(T0 + 200_000, Number.NaN);
		samples.record(T0 + 200_000, -1);
		expect(samples.size).toBe(2);
		for (let i = 0; i < CAPACITY_RING_MAX + 10; i++) samples.record(T0 + 1_000_000 + i * 60_000, i);
		expect(samples.size).toBe(CAPACITY_RING_MAX);
		expect(samples.samples()[0]?.databaseBytes).toBe(10);
		const restored = new CapacityRing(samples.samples());
		expect(restored.samples()).toEqual(samples.samples());
	});

	test("the ring holds the day's minute buckets plus a margin", () => {
		expect(CAPACITY_RING_MAX).toBeGreaterThan(24 * 60);
	});

	test("a 5 s poller for 25 h builds a ring that spans at least 24 h and is judged (Greptile round 1, PR #61)", () => {
		// Replacing the newest sample on every read kept moving its time forward
		// and never started a new one, so the ring never held two samples a day
		// apart and the runway stayed insufficient-data forever.
		const samples = new CapacityRing();
		const start = T0 + 17_000;
		for (let t = 0; t <= 25 * 3_600_000; t += 5_000) {
			samples.record(start + t, Math.round(2 * GB + (100 * MB * t) / DAY));
		}
		const retained = samples.samples();
		expect(retained.length).toBeGreaterThan(24 * 60);
		// Never two samples in one bucket, and timestamps stay on first reads.
		for (let i = 1; i < retained.length; i++) {
			expect(Math.floor(retained[i]!.at / 60_000)).toBeGreaterThan(Math.floor(retained[i - 1]!.at / 60_000));
		}
		expect(retained[retained.length - 1]!.at - retained[0]!.at).toBeGreaterThanOrEqual(24 * 3_600_000);
		const [result] = evaluateCapacitySlos(samples, { volumeBytes: 10 * GB });
		expect(result!.status).toBe("ok");
		expect(result!.bytesPerDay).toBeCloseTo(100 * MB, -3);
		expect(result!.observed).toBeGreaterThan(70);
	});

	test("a 5 s poller for 23 h is still insufficient-data", () => {
		const samples = new CapacityRing();
		for (let t = 0; t <= 23 * 3_600_000; t += 5_000) samples.record(T0 + t, 2 * GB);
		expect(evaluateCapacitySlos(samples, { volumeBytes: 10 * GB })[0]!.status).toBe("insufficient-data");
	});
});

describe("served.tokens_est per surface (uplift-4 S1)", () => {
	const HOUR = BURN_WINDOW_MS;
	const CEILING = { [SERVED_TOKENS_ENV]: "1000000" };

	/** The instruments after serving `tokens` estimated tokens to each named surface (bytes = tokens * 4). */
	function served(perSurface: Record<string, number>): SubstrateInstruments {
		const instruments = new SubstrateInstruments();
		for (const [surface, tokens] of Object.entries(perSurface)) instruments.recordServedTokens({ surface, tool: "brief", bytes: tokens * 4 });
		return instruments;
	}

	test("is empty until something was served", () => {
		expect(servedTokensBySurface([], { env: CEILING })).toEqual([]);
		expect(servedTokensBySurface(new SubstrateInstruments().snapshot(), { env: CEILING })).toEqual([]);
	});

	test("an unset ceiling is unconfigured, per surface, and says which variable to set", () => {
		const rows = servedTokensBySurface(served({ omp: 10, "grok-bot": 10_000_000 }).snapshot(), { env: {}, ledger: new BurnLedger(HOUR, 0), now: 0 });
		expect(rows.map((row) => [row.surface, row.id, row.status, row.observed, row.target])).toEqual([
			["grok-bot", "served.tokens_est", "unconfigured", null, null],
			["omp", "served.tokens_est", "unconfigured", null, null],
		]);
		expect(rows[0]!.detail).toContain(SERVED_TOKENS_ENV);
		expect(rows[0]!.statement).toContain("(unset)");
	});

	test("judged like the burn objectives: a rate from the delta of successive reads, per surface, never breaching another's", () => {
		const ledger = new BurnLedger(HOUR, 0);
		const first = servedTokensBySurface(served({ "grok-bot": 1, omp: 1 }).snapshot(), { env: CEILING, ledger, now: 0 });
		expect(first.map((row) => row.status)).toEqual(["insufficient-data", "insufficient-data"]);

		// 600k estimated tokens in a half hour is 1.2M an hour for the bot; the other surface stayed small.
		const rows = servedTokensBySurface(served({ "grok-bot": 600_001, omp: 11 }).snapshot(), { env: CEILING, ledger, now: HOUR / 2 });
		const bot = rows.find((row) => row.surface === "grok-bot")!;
		const omp = rows.find((row) => row.surface === "omp")!;
		expect(bot.status).toBe("breached");
		expect(bot.observed).toBe(1_200_000);
		expect(bot.samples).toBe(2);
		expect(bot.detail).toContain("over the 1000000 tokens/h ceiling");
		expect(omp.status).toBe("ok");
		expect(omp.observed).toBe(20);
	});

	test("it is labelled estimated everywhere, and is never the model-reported burn", () => {
		const instruments = served({ "grok-bot": 5_000_000 });
		const [row] = servedTokensBySurface(instruments.snapshot(), { env: CEILING, ledger: new BurnLedger(HOUR, 0), now: 0 });
		expect(row!.unit).toBe("tokens/h (estimated)");
		expect(row!.title).toContain("Estimated");
		expect(row!.statement).toContain("estimated");
		expect(row!.statement).toContain(METRIC.servedTokensEst);
		// The burn objective reads substrate.tokens only: served-only traffic gives it no series.
		const burn = evaluateBurnSlos(instruments.snapshot(), { env: { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1" }, ledger: new BurnLedger(HOUR, 0), now: 0 }).find((result) => result.id === "burn.tokens");
		expect(burn?.status).toBe("insufficient-data");
		// The model-reported counter holds nothing: the served estimate never reached it.
		expect(sumCounter(findCounter(instruments.snapshot(), METRIC.tokens)!)).toBe(0);
	});

	test("sharing the burn ledger keeps the series apart", () => {
		const ledger = new BurnLedger(HOUR, 0);
		const instruments = served({ "grok-bot": 100 });
		instruments.recordUsage({ surface: "grok-bot", payload: { input_tokens: 7 } });
		servedTokensBySurface(instruments.snapshot(), { env: CEILING, ledger, now: 0 });
		evaluateBurnSlos(instruments.snapshot(), { env: { SUBSTRATE_BURN_TOKENS_PER_HOUR: "1000" }, ledger, now: 0 });
		const kept = ledger.export();
		expect(kept[`${METRIC.servedTokensEst}|grok-bot`]?.at(-1)?.total).toBe(100);
		expect(kept[METRIC.tokens]?.at(-1)?.total).toBe(7);
	});

	test("a malformed ceiling is unset, with one warning", () => {
		const warnings: string[] = [];
		const [row] = servedTokensBySurface(served({ omp: 1 }).snapshot(), { env: { [SERVED_TOKENS_ENV]: "plenty" }, ledger: new BurnLedger(HOUR, 0), now: 0, warn: (message) => warnings.push(message) });
		expect(row!.status).toBe("unconfigured");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(SERVED_TOKENS_ENV);
		expect(warnings[0]).toContain("the served-tokens objective it configures is treated as unset");
		expect(warnings[0]).not.toContain("burn objective");
	});
});

describe("docs.freshness (uplift-4 S7)", () => {
	const options = { maxAgeHours: 168, triggerLagMinutes: 15 };
	const reading = (overrides: Partial<DocsFreshnessReading> = {}): DocsFreshnessReading => ({
		dataset: "agent-substrate",
		freshnessSeconds: 7200,
		triggerLagSeconds: 0,
		stale: false,
		lagging: false,
		...overrides,
	});

	test("is absent with no readings, so a deployment that never ingested sees no false ok", () => {
		expect(evaluateDocsFreshnessSlo([], options)).toEqual([]);
	});

	test("reads ok with fresh datasets, observing the oldest one in hours", () => {
		const [row] = evaluateDocsFreshnessSlo([reading(), reading({ dataset: "kanbanos", freshnessSeconds: 36_000 })], options);
		expect(row).toMatchObject({ id: DOCS_FRESHNESS_ID, status: "ok", observed: 10, unit: "hours", target: 168, samples: 2 });
		expect(row?.detail).toContain("agent-substrate 2.0 h old");
	});

	test("breaches on a stale dataset or a lagging trigger and names which", () => {
		const stale = evaluateDocsFreshnessSlo([reading({ freshnessSeconds: 200 * 3600, stale: true })], options)[0];
		expect(stale?.status).toBe("breached");
		expect(stale?.detail).toContain("(stale)");
		const lagging = evaluateDocsFreshnessSlo([reading({ lagging: true, triggerLagSeconds: 1500 })], options)[0];
		expect(lagging?.status).toBe("breached");
		expect(lagging?.detail).toContain("trigger unrecorded for 25 min");
		expect(lagging?.datasets).toEqual([{ dataset: "agent-substrate", freshness_seconds: 7200, trigger_lag_seconds: 1500, stale: false, lagging: true }]);
	});

	test("a dataset with only a trigger and no ingest has no age to observe: insufficient-data, never ok", () => {
		const [row] = evaluateDocsFreshnessSlo([reading({ freshnessSeconds: null, triggerLagSeconds: 60 })], options);
		expect(row?.observed).toBeNull();
		expect(row?.status).toBe("insufficient-data");
		expect(row?.detail).toContain("no ingest recorded");
	});

	test("both thresholds 0 reports unconfigured, not ok; age alone or lag alone with an observation is still judged", () => {
		const off = evaluateDocsFreshnessSlo([reading()], { maxAgeHours: 0, triggerLagMinutes: 0 })[0];
		expect(off?.status).toBe("unconfigured");
		expect(off?.statement).toContain("(age not judged)");
		expect(off?.statement).toContain("(lag not detected)");
		expect(off?.detail).toContain("neither threshold is set");
		expect(evaluateDocsFreshnessSlo([reading()], { maxAgeHours: 168, triggerLagMinutes: 0 })[0]?.status).toBe("ok");
		// Age off, lag on: judged only once a trigger has been read.
		expect(evaluateDocsFreshnessSlo([reading({ triggerLagSeconds: null })], { maxAgeHours: 0, triggerLagMinutes: 15 })[0]?.status).toBe("insufficient-data");
		expect(evaluateDocsFreshnessSlo([reading({ triggerLagSeconds: 0 })], { maxAgeHours: 0, triggerLagMinutes: 15 })[0]?.status).toBe("ok");
		// A breach still wins over an unconfigured reading.
		expect(evaluateDocsFreshnessSlo([reading({ lagging: true, triggerLagSeconds: 1500 })], { maxAgeHours: 0, triggerLagMinutes: 0 })[0]?.status).toBe("breached");
	});

	test("the statement follows the thresholds", () => {
		expect(evaluateDocsFreshnessSlo([reading()], options)[0]?.statement).toContain("<= 168 h old");
		expect(evaluateDocsFreshnessSlo([reading()], options)[0]?.statement).toContain("15 min");
	});
});
