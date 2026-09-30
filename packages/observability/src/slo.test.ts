import { describe, expect, test } from "bun:test";
import { METRIC, SubstrateInstruments } from "./instruments.ts";
import { DEFAULT_THRESHOLDS, breaches, evaluateSlos, sloCatalogue } from "./slo.ts";

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

describe("brief p95 < 800 ms", () => {
	test("met when 95 % of briefs landed at or below the 800 ms boundary", () => {
		// 96 fast, 4 slow: the verdict is the exact count below the boundary, not an
		// interpolated quantile.
		const instruments = briefs([...Array.from({ length: 96 }, () => 400), ...Array.from({ length: 4 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot()), "brief.p95");

		expect(result.status).toBe("ok");
		expect(result.samples).toBe(100);
		expect(result.detail).toContain("96.00 %");
	});

	test("breached when 94 % did", () => {
		const instruments = briefs([...Array.from({ length: 94 }, () => 400), ...Array.from({ length: 6 }, () => 3000)]);
		const result = slo(evaluateSlos(instruments.snapshot()), "brief.p95");

		expect(result.status).toBe("breached");
		expect(breaches(evaluateSlos(instruments.snapshot())).map((entry) => entry.id)).toContain("brief.p95");
	});

	test("exactly 95 % at or below the threshold is met", () => {
		const instruments = briefs([...Array.from({ length: 95 }, () => 400), ...Array.from({ length: 5 }, () => 3000)]);
		expect(slo(evaluateSlos(instruments.snapshot()), "brief.p95").status).toBe("ok");
	});

	test("a brief at exactly 800 ms counts as inside, and the objective says so rather than claiming `<`", () => {
		// SPE-4793 words this `p95 < 800 ms`. A bucket bound is an inclusive upper edge in
		// OTLP — the 800 ms bucket holds (400, 800] — so no bucketed histogram can separate
		// 800.000 from 799.999, and `<= 800 ms` is the strongest claim this data supports.
		// The fix was to state that in the objective instead of checking `<=` while calling
		// it `<`, which handed out a green verdict at the stated failure boundary in silence.
		const result = slo(evaluateSlos(briefs(Array.from({ length: 30 }, () => 800)).snapshot()), "brief.p95");

		expect(result.status).toBe("ok");
		expect(result.statement).toContain("<= 800 ms");
		expect(result.statement).not.toMatch(/p95 of \S+ < 800/);
		expect(result.detail).toContain("exactly 800 ms counts as inside");
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
		for (const target of sloCatalogue()) {
			const names = target.kind === "latency-quantile" ? [target.metric] : [target.numerator.metric, target.denominator.metric];
			for (const name of names) expect(registered).toContain(name);
		}
		expect(registered).toContain(METRIC.briefDuration);
	});
});
