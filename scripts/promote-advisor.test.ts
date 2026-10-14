/**
 * The promotion advisor against hand-computed fixtures (uplift-5 U5-7).
 *
 * The fixtures are written against the PROPOSED thresholds in the flag registry
 * (budgets: shadow share <= 1 % of >= 100 decisions over 24 h; SWR: would-serve-
 * stale >= 10 % of >= 100 misses and brief p95 <= 800 ms; profile: >= 700 bytes
 * saved per brief; memory expiry: zero served expired entries over 7 d). If an
 * operator changes a proposal on purpose, the numbers below are what to redo.
 * Each expectation is arithmetic done by hand and written beside its fixture.
 *
 * What each group proves, and the bug it would catch:
 * - verdicts: the four outcomes come out for the right evidence, including the
 *   boundary values (`<=` and `>=` are inclusive) and a `bypass` flood that must
 *   not dilute a share;
 * - precedence: a measured miss outranks a gap, an unreadable series outranks a
 *   thin one, so a flag is never `ready` on partial evidence;
 * - window honesty: a history that does not span the window, a truncated
 *   answer, a retention shorter than the window and a malformed point are
 *   never `ready`;
 * - read-only: every request is a GET with redirects off, the bearer goes only
 *   in the header (first entry of a list) and is never in the output, and a
 *   failing network is a verdict rather than an exit code;
 * - the CLI: usage errors exit 2, everything else 0, `--flag` narrows, an
 *   `--offline` fixture makes no request.
 */
import { describe, expect, test } from "bun:test";
import { type Evidence, flagByName, policyFlags } from "../packages/mcp-server/src/flag-registry.ts";
import {
	type Criterion,
	type FlagVerdict,
	type Getter,
	type Report,
	type SeriesResult,
	buildReport,
	judgeCriterion,
	judgeFlag,
	keyOf,
	liveGetter,
	main,
	parseFixture,
	parseSeriesAnswer,
} from "./promote-advisor.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

interface PointSpec {
	/** Hours before NOW. */
	ago: number;
	label?: string;
	value: number | null;
	count?: number;
}

interface BodyOptions {
	windowHours: number;
	windowCapped?: boolean;
	truncated?: boolean;
	/** Default true; false lists exactly the given points (a history with holes). */
	fill?: boolean;
}

/**
 * A sampler that was up writes a row every interval, so a fixture that lists only the interesting points gets
 * unlabelled zero rows (value 0, count 0, so no sum, share or maximum changes) every 3 h between its oldest point and
 * now. `fill: false` is the hole: only what the fixture lists, for the gap tests.
 */
function steady(points: readonly PointSpec[]): PointSpec[] {
	if (points.length === 0) return [...points];
	const oldest = Math.max(...points.map((point) => point.ago));
	const fillers: PointSpec[] = [{ ago: 0.1, value: 0, count: 0 }];
	for (let ago = oldest - 3; ago > 0.5; ago -= 3) fillers.push({ ago, value: 0, count: 0 });
	return [...points, ...fillers];
}

function body(series: string, labelKey: string | null, points: readonly PointSpec[], options: BodyOptions): Record<string, unknown> {
	return {
		enabled: true,
		series,
		kind: "counter",
		unit: "x",
		aggregate: "sum",
		from: new Date(NOW - options.windowHours * HOUR).toISOString(),
		to: new Date(NOW).toISOString(),
		windowCapped: options.windowCapped ?? false,
		retentionDays: 14,
		stepS: 60,
		truncated: options.truncated ?? false,
		points: (options.fill === false ? points : steady(points)).map((point) => ({
			ts: new Date(NOW - point.ago * HOUR).toISOString(),
			labels: point.label === undefined || labelKey === null ? {} : { [labelKey]: point.label },
			value: point.value,
			count: point.count ?? point.value ?? 0,
		})),
	};
}

const ok = (series: string, labelKey: string | null, points: readonly PointSpec[], windowHours: number, extra: Partial<BodyOptions> = {}) => ({
	status: 200,
	body: body(series, labelKey, points, { windowHours, ...extra }),
});
const HISTORY_OFF = { status: 404, body: { enabled: false } };
const NOT_RECORDED = { status: 400, body: { enabled: true, error: "series is not one of the recorded series" } };

/** Admission decisions over 24 h: the oldest point is 23.5 h back, so 98 % of the window is covered. */
function decisions(counts: Record<string, number>, windowHours = 24, oldest = 23.5) {
	const labels = Object.entries(counts);
	return ok(
		"admission.decisions",
		"decision",
		labels.flatMap(([label, total], index) => {
			// Split each count over two intervals so sums, not single points, are what is judged.
			const first = Math.floor(total / 2);
			return [
				{ ago: oldest - index * 0.01, label, value: first },
				{ ago: 1, label, value: total - first },
			].filter((point) => point.value > 0);
		}),
		windowHours,
	);
}

const answer = (fixture: { status: number; body: unknown }, needs: Evidence["needs"] = "core"): SeriesResult => parseSeriesAnswer(fixture, needs);

function fixtureOf(entries: Record<string, { status: number; body: unknown }>, slo?: { status: number; body: unknown }): string {
	return JSON.stringify({ series: entries, ...(slo === undefined ? {} : { slo }) });
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
	json: Report | null;
}

/** A tokens directory that does not exist, so a live-mode run never reads a bearer from the machine the tests run on. */
const NO_TOKENS = "/nonexistent-substrate-tokens-for-test";

async function run(argv: readonly string[], files: Record<string, string>, env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, { SUBSTRATE_TOKENS_DIR: NO_TOKENS, ...env }, {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		fetchImpl,
		readFile: (path) => {
			if (!Object.hasOwn(files, path)) throw new Error("ENOENT");
			return files[path]!;
		},
	});
	let json: Report | null = null;
	if (argv.includes("--json")) json = JSON.parse(stdout) as Report;
	return { code, stdout, stderr, json };
}

const verdictOf = (report: Report | null, flag: string): FlagVerdict => report!.flags.find((entry) => entry.flag === flag)!;

describe("verdicts for the admission budgets (shadow share of decisions)", () => {
	const budgets = (counts: Record<string, number>) => fixtureOf({ "admission.decisions": decisions(counts) });
	const judge = async (counts: Record<string, number>): Promise<FlagVerdict> =>
		verdictOf((await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": budgets(counts) })).json, "SUBSTRATE_BUDGETS");

	test("ready: 6 shadow-limited of 996 decisions is 0.6024 %, under 1 %, with 996 samples", async () => {
		// allowed 990 + shadow_limited 6 + limited 0 = 996; numerator shadow_limited + limited = 6; 6 / 996.
		const verdict = await judge({ allowed: 990, shadow_limited: 6 });
		expect(verdict.verdict).toBe("ready");
		const [criterion] = verdict.criteria as [Criterion];
		expect(criterion.observed).toBeCloseTo(6 / 996, 12);
		expect(criterion.samples).toBe(996);
		expect(criterion.threshold).toBe(0.01);
		expect(criterion.comparator).toBe("<=");
		expect(criterion.proposed).toBe(true);
	});

	test("hold: 40 refused-or-shadow-refused of 1000 is 4 %, and a 5000-count bypass does not dilute it", async () => {
		// allowed 960 + shadow_limited 30 + limited 10 = 1000; numerator 40; 40 / 1000 = 4 %.
		// If bypass (not a decision) were in the denominator: 40 / 6000 = 0.67 %, which would read ready.
		const verdict = await judge({ allowed: 960, shadow_limited: 30, limited: 10, bypass: 5000 });
		expect(verdict.verdict).toBe("hold");
		expect(verdict.criteria[0]!.observed).toBeCloseTo(0.04, 12);
		expect(verdict.criteria[0]!.samples).toBe(1000);
	});

	test("the bound is inclusive: exactly 10 of 1000 is 1 % and ready; 11 of 1000 holds", async () => {
		expect((await judge({ allowed: 990, shadow_limited: 10 })).verdict).toBe("ready");
		expect((await judge({ allowed: 989, shadow_limited: 11 })).verdict).toBe("hold");
	});

	test("insufficient-data below the 100-decision floor, whatever the share (2 of 80 is 2.5 %, not a hold)", async () => {
		const verdict = await judge({ allowed: 78, shadow_limited: 2 });
		expect(verdict.verdict).toBe("insufficient-data");
		expect(verdict.criteria[0]!.observed).toBeNull();
		expect(verdict.criteria[0]!.samples).toBe(80);
	});

	test("the floor is inclusive: exactly 100 decisions is judged", async () => {
		expect((await judge({ allowed: 99, shadow_limited: 1 })).verdict).toBe("ready");
	});

	test("insufficient-data when the history spans 2 h of the 24 h window, even with plenty of decisions", async () => {
		const only2h = fixtureOf({ "admission.decisions": decisions({ allowed: 5000, shadow_limited: 1 }, 24, 2) });
		const report = (await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": only2h })).json;
		const [criterion] = verdictOf(report, "SUBSTRATE_BUDGETS").criteria as [Criterion];
		expect(criterion.verdict).toBe("insufficient-data");
		expect(criterion.detail).toContain("covers 2.0 h of the 24h window");
	});

	test("a history that spans the window but has a hole is insufficient-data: 22.5 h with no row in a 24 h window", async () => {
		// 23.5 h ago and 1 h ago only (no filler rows): coverage from the first point is 23.5 h of 24 (98 %), yet the middle is empty.
		const holey = ok("admission.decisions", "decision", [{ ago: 23.5, label: "allowed", value: 500 }, { ago: 1, label: "allowed", value: 500 }], 24, { fill: false });
		const report = (await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({ "admission.decisions": holey }) })).json;
		const [criterion] = verdictOf(report, "SUBSTRATE_BUDGETS").criteria as [Criterion];
		expect(criterion.verdict).toBe("insufficient-data");
		expect(criterion.detail).toContain("22.5 h gap");
		expect(criterion.observed).toBeNull();
	});

	test("the gap bound is 25 % of the window (6 h of 24 h) and counts the stretch after the last row: 5.5 h passes, 8.5 h does not", async () => {
		const everyThreeHours = (last: number) => {
			const points = [];
			for (let ago = 23.5; ago >= last - 0.001; ago -= 3) points.push({ ago, label: "allowed", value: 100 });
			return points;
		};
		const verdictFor = async (last: number): Promise<Criterion> => {
			const body = ok("admission.decisions", "decision", everyThreeHours(last), 24, { fill: false });
			const report = (await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({ "admission.decisions": body }) })).json;
			return verdictOf(report, "SUBSTRATE_BUDGETS").criteria[0]!;
		};
		// Rows 23.5, 20.5, ..., 5.5 h ago: every gap is 3 h and 5.5 h of the window are after the last row.
		expect(await verdictFor(5.5)).toMatchObject({ verdict: "ready", observed: 0 });
		// Rows 23.5, ..., 8.5 h ago: the 8.5 h after the last row is a sampler that stopped.
		const stopped = await verdictFor(8.5);
		expect(stopped.verdict).toBe("insufficient-data");
		expect(stopped.detail).toContain("8.5 h gap");
	});

	test("series-unavailable when the history is off, with the hint to turn it on", async () => {
		const report = (await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({ "admission.decisions": HISTORY_OFF }) })).json;
		const [criterion] = verdictOf(report, "SUBSTRATE_BUDGETS").criteria as [Criterion];
		expect(criterion.verdict).toBe("series-unavailable");
		expect(criterion.hint).toContain("SUBSTRATE_METRICS_HISTORY=on");
	});
});

describe("verdicts and precedence for the cache stale-while-revalidate flag", () => {
	/** Two criteria: would_serve_stale share of misses (extended) and the brief p95 (core). */
	const swr = (cache: { status: number; body: unknown }, brief: { status: number; body: unknown }) =>
		fixtureOf({ "cache.operations": cache, "brief.p95": brief });
	const cacheOps = (counts: Record<string, number>) =>
		ok(
			"cache.operations",
			"result",
			Object.entries(counts).map(([label, value], index) => ({ ago: 23.5 - index * 0.01, label, value })),
			24,
		);
	const briefP95 = (values: readonly number[], count = 40) =>
		ok(
			"brief.p95",
			"surface",
			values.map((value, index) => ({ ago: 23.5 - index, label: "grok-bot", value, count })),
			24,
		);
	const judge = async (fixture: string): Promise<FlagVerdict> => verdictOf((await run(["--flag", "SUBSTRATE_CACHE_SWR", "--offline", "f.json", "--json"], { "f.json": fixture })).json, "SUBSTRATE_CACHE_SWR");

	test("ready: 100 would-serve-stale of 900 misses is 11.1 % (>= 10 %) and the worst p95 of 120 briefs is 700 ms (<= 800)", async () => {
		// share = would_serve_stale / miss = 100 / 900: the shadow probe counts would_serve_stale IN ADDITION to the miss of the same request; hits are not misses.
		const verdict = await judge(swr(cacheOps({ hit: 2000, miss: 900, would_serve_stale: 100 }), briefP95([400, 650, 700])));
		expect(verdict.verdict).toBe("ready");
		expect(verdict.criteria[0]!.observed).toBeCloseTo(100 / 900, 12);
		expect(verdict.criteria[0]!.samples).toBe(900);
		expect(verdict.criteria[1]!.observed).toBe(700);
		expect(verdict.criteria[1]!.samples).toBe(120);
	});

	test("hold outranks every other outcome: a ready cache share cannot carry a 1600 ms p95", async () => {
		const verdict = await judge(swr(cacheOps({ miss: 900, would_serve_stale: 100 }), briefP95([400, 1600, 700])));
		expect(verdict.verdict).toBe("hold");
		expect(verdict.criteria.map((criterion) => criterion.verdict)).toEqual(["ready", "hold"]);
	});

	test("hold also outranks series-unavailable: a measured miss is decisive", async () => {
		const verdict = await judge(swr(NOT_RECORDED, briefP95([1600])));
		expect(verdict.criteria.map((criterion) => criterion.verdict)).toEqual(["series-unavailable", "insufficient-data"]);
		const held = await judge(swr(NOT_RECORDED, briefP95([1600, 1600, 1600])));
		expect(held.criteria.map((criterion) => criterion.verdict)).toEqual(["series-unavailable", "hold"]);
		expect(held.verdict).toBe("hold");
	});

	test("series-unavailable outranks insufficient-data, and an extended series that is not recorded says how to enable it", async () => {
		// One p95 sample interval of 40 briefs is below the floor of 100: insufficient. The cache series answers 400: unavailable.
		const verdict = await judge(swr(NOT_RECORDED, briefP95([400])));
		expect(verdict.verdict).toBe("series-unavailable");
		expect(verdict.criteria[0]!.hint).toContain("SUBSTRATE_METRICS_HISTORY_SERIES=extended");
	});

	test("insufficient-data outranks ready: one thin criterion keeps the flag from ready", async () => {
		const verdict = await judge(swr(cacheOps({ miss: 900, would_serve_stale: 100 }), briefP95([400], 40)));
		expect(verdict.criteria.map((criterion) => criterion.verdict)).toEqual(["ready", "insufficient-data"]);
		expect(verdict.verdict).toBe("insufficient-data");
	});

	test("would_serve_stale is a subset of miss: the share is over miss alone, so exactly 100 of 1000 misses is 10 % and ready, 99 of 1000 holds", async () => {
		// Over miss + would_serve_stale (the old denominator, double-counting) 100 / 1100 = 9.09 % would hold.
		const ready = await judge(swr(cacheOps({ miss: 1000, would_serve_stale: 100 }), briefP95([400, 650, 700])));
		expect(ready.criteria[0]).toMatchObject({ verdict: "ready", observed: 0.1, samples: 1000 });
		const held = await judge(swr(cacheOps({ miss: 1000, would_serve_stale: 99 }), briefP95([400, 650, 700])));
		expect(held.criteria[0]).toMatchObject({ verdict: "hold", observed: 0.099 });
	});

	test("the share is a lower bound and says so, in the JSON and on the printed line", async () => {
		const fixture = swr(cacheOps({ miss: 900, would_serve_stale: 100 }), briefP95([400, 650, 700]));
		const verdict = await judge(fixture);
		expect(verdict.criteria[0]!.note).toContain("lower bound");
		expect(verdict.criteria[1]!.note).toBeNull();
		const text = (await run(["--flag", "SUBSTRATE_CACHE_SWR", "--offline", "f.json"], { "f.json": fixture })).stdout;
		expect(text).toContain("(lower bound: cache.operations sums every cache class, would_serve_stale is brief-only)");
	});
});

describe("ratio, sum and share criteria with hand-computed boundaries", () => {
	const profile = flagByName("SUBSTRATE_BRIEF_PROFILE")!.policy!.evidence[0]!;
	const expiry = flagByName("SUBSTRATE_MEMORY_EXPIRY")!.policy!.evidence[0]!;
	const recall = flagByName("SUBSTRATE_BRIEF_RECALL")!.policy!.evidence;
	const results = (entries: Record<string, { status: number; body: unknown }>, window: string, needs: Evidence["needs"] = "core") =>
		new Map(Object.entries(entries).map(([series, fixture]) => [keyOf(series, window), answer(fixture, series === "brief.profile_bytes_saved" || series === "memory.expired" ? "extended" : needs)]));

	test("bytes saved per brief: 42000 bytes over 60 briefs is exactly 700, which meets >= 700; 41940 is 699 and holds", () => {
		const briefs = ok("brief.p95", "surface", [{ ago: 70, label: "grok-bot", value: 300, count: 30 }, { ago: 2, label: "grok-bot", value: 300, count: 30 }], 72);
		const saved = (total: number) =>
			ok("brief.profile_bytes_saved", null, [{ ago: 70, value: total / 2 }, { ago: 2, value: total / 2 }], 72);
		expect(judgeCriterion(profile, results({ "brief.profile_bytes_saved": saved(42_000), "brief.p95": briefs }, "3d"))).toMatchObject({ verdict: "ready", observed: 700, samples: 60 });
		expect(judgeCriterion(profile, results({ "brief.profile_bytes_saved": saved(41_940), "brief.p95": briefs }, "3d"))).toMatchObject({ verdict: "hold", observed: 699 });
	});

	test("fewer than 30 briefs is insufficient-data however large the saving", () => {
		const briefs = ok("brief.p95", "surface", [{ ago: 70, label: "grok-bot", value: 300, count: 29 }], 72);
		const saved = ok("brief.profile_bytes_saved", null, [{ ago: 70, value: 1_000_000 }], 72);
		expect(judgeCriterion(profile, results({ "brief.profile_bytes_saved": saved, "brief.p95": briefs }, "3d"))).toMatchObject({ verdict: "insufficient-data", samples: 29 });
	});

	test("memory expiry: no served expired entry over a covered 7 d is ready (observed 0); 3 served is a hold; hidden is not counted", () => {
		const covered = ok("emit.success", null, [{ ago: 160, value: 1, count: 10 }, { ago: 3, value: 1, count: 10 }], 168);
		const served = (n: number) => ok("memory.expired", "mode", [{ ago: 100, label: "hidden", value: 5 }, ...(n > 0 ? [{ ago: 50, label: "served", value: n }] : [])], 168);
		expect(judgeCriterion(expiry, results({ "memory.expired": served(0), "emit.success": covered }, "7d"))).toMatchObject({ verdict: "ready", observed: 0 });
		expect(judgeCriterion(expiry, results({ "memory.expired": served(3), "emit.success": covered }, "7d"))).toMatchObject({ verdict: "hold", observed: 3 });
	});

	test("memory expiry: an empty answer is only ready when something else proves the 7 d were covered", () => {
		const empty = ok("memory.expired", "mode", [], 168);
		const thin = ok("emit.success", null, [{ ago: 5, value: 1, count: 10 }], 168);
		expect(judgeCriterion(expiry, results({ "memory.expired": empty, "emit.success": thin }, "7d"))).toMatchObject({ verdict: "insufficient-data", observed: null });
	});

	test("recall shares: would_include + included over every brief counted; 60 of 100 is 60 % (>= 50 %), 49 of 100 holds", () => {
		const [include] = recall as [Evidence, ...Evidence[]];
		const counts = (counts: Record<string, number>) =>
			ok("brief.recall", "result", Object.entries(counts).map(([label, value], index) => ({ ago: 70 - index, label, value })), 72);
		expect(judgeCriterion(include, results({ "brief.recall": counts({ would_include: 40, included: 20, cold: 30, stale: 10 }) }, "3d"))).toMatchObject({ verdict: "ready", observed: 0.6, samples: 100 });
		expect(judgeCriterion(include, results({ "brief.recall": counts({ would_include: 49, cold: 51 }) }, "3d"))).toMatchObject({ verdict: "hold", observed: 0.49 });
	});

	test("recall cold+stale is strictly under 30 %: exactly 30 of 100 holds, 29 passes", () => {
		const coldStale = recall[1]!;
		const counts = (cold: number) => ok("brief.recall", "result", [{ ago: 70, label: "cold", value: cold }, { ago: 69, label: "would_include", value: 100 - cold }], 72);
		expect(judgeCriterion(coldStale, results({ "brief.recall": counts(30) }, "3d")).verdict).toBe("hold");
		expect(judgeCriterion(coldStale, results({ "brief.recall": counts(29) }, "3d")).verdict).toBe("ready");
	});
});

describe("answers that must never read as ready", () => {
	const budgets = flagByName("SUBSTRATE_BUDGETS")!.policy!.evidence[0]!;
	const judge = (fixture: { status: number; body: unknown }) => judgeCriterion(budgets, new Map([[keyOf("admission.decisions", "24h"), answer(fixture)]]));
	const good = decisions({ allowed: 990, shadow_limited: 6 });

	test("the same numbers are ready, and become insufficient-data when truncated or when the retention is shorter than the window", () => {
		expect(judge(good).verdict).toBe("ready");
		const truncated = { status: 200, body: { ...(good.body as Record<string, unknown>), truncated: true } };
		expect(judge(truncated)).toMatchObject({ verdict: "insufficient-data", observed: null });
		const capped = { status: 200, body: { ...(good.body as Record<string, unknown>), windowCapped: true } };
		expect(judge(capped).detail).toContain("retention is shorter");
	});

	test("a malformed answer is series-unavailable, not a guess: no points, a non-numeric value, a bad timestamp, a negative count", () => {
		const base = good.body as Record<string, unknown>;
		const points = base.points as Array<Record<string, unknown>>;
		for (const broken of [
			{ ...base, points: undefined },
			{ ...base, points: [{ ...points[0], value: "6" }] },
			{ ...base, points: [{ ...points[0], ts: "not a time" }] },
			{ ...base, points: [{ ...points[0], count: -1 }] },
			{ ...base, from: undefined },
			{ ...base, to: base.from },
			{ ...base, enabled: undefined },
		]) {
			expect(judge({ status: 200, body: broken }).verdict).toBe("series-unavailable");
		}
	});

	test("every non-200 status is a closed reason: 401 names the bearer, 503 the store, 0 no answer, 429 admission", () => {
		expect(judge({ status: 401, body: null }).detail).toContain("bearer refused");
		expect(judge({ status: 401, body: null }).hint).toContain("SUBSTRATE_TOKEN");
		expect(judge({ status: 503, body: { error: "the history store could not answer" } }).detail).toContain("503");
		expect(judge({ status: 0, body: null }).detail).toContain("no answer");
		expect(judge({ status: 429, body: null }).detail).toContain("429");
		expect(judge({ status: 302, body: null }).detail).toContain("unexpected HTTP 302");
	});
});

describe("the advisor is read-only", () => {
	const answerAll = (status: number, payload: unknown): typeof fetch =>
		(async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

	test("every request is a GET with redirects off; the bearer is the first list entry, only in the header, and never in the output", async () => {
		const calls: Array<{ url: string; method: string | undefined; redirect: string | undefined; authorization: string | undefined; hasBody: boolean }> = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), method: init?.method, redirect: init?.redirect, authorization: headers.get("authorization") ?? undefined, hasBody: init?.body !== undefined });
			return new Response(JSON.stringify({ enabled: false }), { status: 404 });
		}) as unknown as typeof fetch;
		const env = { SUBSTRATE_URL: "http://127.0.0.1:9/", SUBSTRATE_TOKEN_SUBSTRATE: "tkone, tktwo" };
		const result = await run(["--json"], {}, env, fetchImpl);
		expect(result.code).toBe(0);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(call.redirect).toBe("manual");
			expect(call.hasBody).toBe(false);
			expect(call.authorization).toBe("Bearer tkone");
			expect(call.url.startsWith("http://127.0.0.1:9/slo")).toBe(true);
			expect(call.url).not.toContain("//slo");
		}
		for (const secret of ["tkone", "tktwo"]) {
			expect(result.stdout).not.toContain(secret);
			expect(result.stderr).not.toContain(secret);
		}
		// No duplicate reads: each (series, window) is fetched once however many criteria share it.
		const urls = calls.map((call) => call.url);
		expect(new Set(urls).size).toBe(urls.length);
		// And it asked for the series the criteria need and /slo for context, nothing else.
		expect(urls.filter((url) => !url.includes("/slo/history?series=") && !url.endsWith("/slo"))).toEqual([]);
	});

	test("with no bearer resolvable it sends none, and a 401 answer is a verdict, not a crash", async () => {
		let sent: string | null | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			sent = new Headers(init?.headers).get("authorization");
			return new Response("{}", { status: 401 });
		}) as unknown as typeof fetch;
		const result = await run(["--json", "--flag", "SUBSTRATE_BUDGETS"], {}, {}, fetchImpl);
		expect(sent).toBeNull();
		expect(result.code).toBe(0);
		expect(verdictOf(result.json, "SUBSTRATE_BUDGETS").criteria[0]!.detail).toContain("bearer refused");
	});

	test("a failing network is series-unavailable for every criterion, exit 0, and the error text is not echoed", async () => {
		const fetchImpl = (async () => {
			throw new Error("boom-secret-detail");
		}) as unknown as typeof fetch;
		const result = await run(["--json"], {}, {}, fetchImpl);
		expect(result.code).toBe(0);
		expect(result.json!.flags.length).toBeGreaterThan(0);
		expect(result.json!.flags.map((flag) => flag.verdict)).toEqual(result.json!.flags.map(() => "series-unavailable"));
		expect(result.stdout + result.stderr).not.toContain("boom-secret-detail");
	});

	test("an answer over the size cap is no answer, not a parse of a truncated body", async () => {
		const huge = (async () => new Response("x".repeat(4_000_001), { status: 200 })) as unknown as typeof fetch;
		const got = await liveGetter("http://127.0.0.1:9", null, huge)("/slo/history?series=emit.success&window=1h");
		expect(got.status).toBe(0);
	});

	test("an unparseable 200 body is a malformed answer, not an empty history", async () => {
		const result = await run(["--json", "--flag", "SUBSTRATE_BUDGETS"], {}, {}, answerAll(200, "not an object"));
		expect(verdictOf(result.json, "SUBSTRATE_BUDGETS").criteria[0]!.verdict).toBe("series-unavailable");
	});

	test("liveGetter exposes no way to name a method", async () => {
		const seen: Array<string | undefined> = [];
		const spy = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push(init?.method);
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const get: Getter = liveGetter("http://127.0.0.1:9", "tk", spy);
		await get("/slo");
		await get("/slo/history?series=emit.success&window=1h");
		expect(seen).toEqual(["GET", "GET"]);
	});
});

describe("the CLI", () => {
	test("an --offline run makes no request, exits 0, and prints every policy flag with evidence plus the manual ones", async () => {
		let requests = 0;
		const fetchImpl = (async () => {
			requests += 1;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const result = await run(["--offline", "f.json", "--json"], { "f.json": fixtureOf({}) }, {}, fetchImpl);
		expect(requests).toBe(0);
		expect(result.code).toBe(0);
		expect(result.json!.source).toBe("offline");
		const judged = policyFlags().filter((flag) => flag.policy!.evidence.length > 0).map((flag) => flag.name);
		expect(result.json!.flags.map((flag) => flag.flag)).toEqual(judged);
		expect(result.json!.notJudged.map((entry) => entry.flag)).toEqual(policyFlags().filter((flag) => flag.policy!.evidence.length === 0).map((flag) => flag.name));
		// A series the fixture does not name is a series this substrate does not record.
		expect(new Set(result.json!.flags.map((flag) => flag.verdict))).toEqual(new Set(["series-unavailable"]));
	});

	test("--flag narrows to one flag, and a flag with no history evidence prints its manual check", async () => {
		const one = await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({}) });
		expect(one.json!.flags.map((flag) => flag.flag)).toEqual(["SUBSTRATE_BUDGETS"]);
		const manual = await run(["--flag", "SUBSTRATE_INDEX_SWEEP", "--offline", "f.json", "--json"], { "f.json": fixtureOf({}) });
		expect(manual.json!.flags).toEqual([]);
		expect(manual.json!.notJudged.map((entry) => entry.flag)).toEqual(["SUBSTRATE_INDEX_SWEEP"]);
		expect(manual.json!.notJudged[0]!.manual.length).toBeGreaterThan(0);
	});

	test("usage errors exit 2 and name the problem; --help exits 0", async () => {
		const files = { "f.json": fixtureOf({}), "bad.json": "{not json" };
		expect((await run(["--bogus"], files)).code).toBe(2);
		expect((await run(["--flag"], files)).code).toBe(2);
		const unknown = await run(["--flag", "NOT_A_FLAG", "--offline", "f.json"], files);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain("NOT_A_FLAG");
		expect((await run(["--flag", "SUBSTRATE_PORT", "--offline", "f.json"], files)).code).toBe(2);
		expect((await run(["--offline", "missing.json"], files)).code).toBe(2);
		expect((await run(["--offline", "bad.json"], files)).code).toBe(2);
		expect((await run(["--offline", "f.json"], { "f.json": JSON.stringify({ nothing: true }) })).code).toBe(2);
		expect((await run([], files, { SUBSTRATE_URL: "file:///etc/passwd" })).code).toBe(2);
		expect((await run(["--help"], files)).code).toBe(0);
	});

	test("an offline fixture key with @window wins over the bare series name", async () => {
		const wrong = decisions({ allowed: 10, shadow_limited: 10 });
		const right = decisions({ allowed: 990, shadow_limited: 6 });
		const fixture = fixtureOf({ "admission.decisions": wrong, "admission.decisions@24h": right });
		const result = await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixture });
		expect(verdictOf(result.json, "SUBSTRATE_BUDGETS").verdict).toBe("ready");
	});

	test("/slo context is reported when present and ignored when malformed", async () => {
		const slo = { status: 200, body: { history: { epoch: 3, since: "2026-10-13T09:12:04.118Z" } } };
		const withSlo = await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({}, slo) });
		expect(withSlo.json!.history).toEqual({ epoch: 3, since: "2026-10-13T09:12:04.118Z" });
		const broken = await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json", "--json"], { "f.json": fixtureOf({}, { status: 200, body: { history: { epoch: "x" } } }) });
		expect(broken.json!.history).toBeNull();
	});

	test("the text report carries the verdict, the observed number, the proposal marker and the operator step", async () => {
		const fixture = fixtureOf({ "admission.decisions": decisions({ allowed: 990, shadow_limited: 6 }) });
		const text = (await run(["--flag", "SUBSTRATE_BUDGETS", "--offline", "f.json"], { "f.json": fixture })).stdout;
		expect(text).toContain("SUBSTRATE_BUDGETS  shadow -> enforce  READY");
		expect(text).toContain("0.60 % <= 1.00 %");
		expect(text).toContain("996 samples, needs 100");
		expect(text).toContain("[PROPOSED]");
		expect(text).toContain("when ready: set SUBSTRATE_BUDGETS=enforce");
		expect(text).toContain("rollback:   set SUBSTRATE_BUDGETS=shadow");
		expect(text).not.toMatch(/NaN|undefined/);
	});
});

describe("buildReport and parseFixture", () => {
	test("each distinct series and window is fetched once; the coverage series of a memory criterion is fetched too", async () => {
		const asked: string[] = [];
		const get: Getter = async (path) => {
			asked.push(path);
			return { status: 404, body: { enabled: false } };
		};
		await buildReport([flagByName("SUBSTRATE_MEMORY_EXPIRY")!], get, "live");
		expect(asked).toEqual(["/slo/history?series=memory.expired&window=7d", "/slo/history?series=emit.success&window=7d", "/slo"]);
	});

	test("a fixture needs a series object and integer statuses", () => {
		expect(() => parseFixture("[]")).toThrow();
		expect(() => parseFixture('{"series": {"a": {"status": "200"}}}')).toThrow();
	});

	test("judgeFlag with no answers at all is series-unavailable for each criterion and never ready", () => {
		const verdict = judgeFlag(flagByName("SUBSTRATE_BRIEF_RECALL")!, new Map());
		expect(verdict.verdict).toBe("series-unavailable");
		expect(verdict.criteria.every((criterion) => criterion.verdict === "series-unavailable")).toBe(true);
	});
});
