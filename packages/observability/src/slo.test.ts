import { describe, expect, test } from "bun:test";
import { METRIC, SubstrateInstruments } from "./instruments.ts";
import { DEFAULT_THRESHOLDS, PLANE_WINDOW_MS, PlaneWindow, breaches, evaluatePlaneSlos, evaluateSlos, sloCatalogue, type PlaneSloResult } from "./slo.ts";
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
		for (const target of sloCatalogue()) {
			const names = target.kind === "latency-quantile" ? [target.metric] : [target.numerator.metric, target.denominator.metric];
			for (const name of names) expect(registered).toContain(name);
		}
		expect(registered).toContain(METRIC.briefDuration);
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

	test("same-second readings coalesce, so a fast poller does not fill the ring", () => {
		// A bucket holds the newest reading of its second (as `BurnLedger` does), and
		// the answer is newest − oldest-in-window. So the 500 ms reading replaces the
		// 0 ms one as the base, and the 1600 ms reading replaces the 1500 ms one as
		// the head: ok 3−2, total 4−2, span 1600−500.
		const window = new PlaneWindow();
		expect(window.observe("greptime", 1, 1, 0).samples).toBe(1);
		expect(window.observe("greptime", 2, 2, 500).samples).toBe(1);
		expect(window.observe("greptime", 3, 3, 1500)).toEqual({ ok: 1, total: 1, spanMs: 1000, samples: 2 });
		expect(window.observe("greptime", 3, 4, 1600)).toEqual({ ok: 1, total: 2, spanMs: 1100, samples: 2 });
		// Readings older than an hour relative to the newest drop; the oldest kept one is the base.
		expect(window.observe("greptime", 10, 10, 1600 + PLANE_WINDOW_MS)).toEqual({ ok: 7, total: 6, spanMs: PLANE_WINDOW_MS, samples: 2 });
		expect(window.observe("greptime", 11, 12, 2601 + PLANE_WINDOW_MS)).toEqual({ ok: 1, total: 2, spanMs: 1001, samples: 2 });
	});
});
