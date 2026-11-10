/**
 * The timed LightRAG health probe (SOTA-02, Phase 46, Task 5), driven by a scripted fetch and a fake clock. No test
 * waits real time: the fake sleep advances the clock, so the 60-second window costs nothing to run.
 */
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../packages/mcp-server/src/planes/lightrag.ts";
import { parseProbeArgs, percentile, PROBE_DEFAULTS, printableHost, runProbe, type ProbeDeps } from "./lightrag-probe.ts";

type Step = { status: number; latencyMs: number } | { throws: string; latencyMs: number };

/**
 * A LightRAG stand-in that answers the scripted steps in order (the last step repeats) and advances a fake clock by
 * each step's latency. Records every request's URL, LightRAG auth headers and whether it carried a timeout signal.
 */
function scripted(steps: readonly Step[]) {
	let clock = 0;
	const calls: Array<{ url: string; apiKey: string | null; authorization: string | null; timed: boolean }> = [];
	const sleeps: number[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const step: Step = steps[Math.min(calls.length, steps.length - 1)] ?? { status: 200, latencyMs: 0 };
		const headers = new Headers(init?.headers);
		calls.push({ url: String(input), apiKey: headers.get("x-api-key"), authorization: headers.get("authorization"), timed: init?.signal !== undefined });
		clock += step.latencyMs;
		if ("throws" in step) throw new Error(step.throws);
		return new Response(null, { status: step.status });
	};
	const deps = (env: Record<string, string | undefined>): ProbeDeps => ({
		env,
		fetchImpl,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	return { calls, sleeps, deps };
}

const OK_100 = Array.from({ length: 20 }, (): Step => ({ status: 200, latencyMs: 100 }));
const URL_ENV = { LIGHTRAG_URL: "http://127.0.0.1:9621" };

describe("LightRAG probe sampling", () => {
	test("20 samples over 60 seconds, all 2xx and p95 within the bound, exits 0", async () => {
		const fake = scripted([{ status: 200, latencyMs: 120 }]);
		const outcome = await runProbe(PROBE_DEFAULTS, fake.deps(URL_ENV));
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ ok: true, samples: 20, window_s: 60, failures: 0, p50_ms: 120, p95_ms: 120, max_ms: 120, host: "127.0.0.1" });
		expect(fake.calls).toHaveLength(20);
		expect(fake.calls[0]?.url).toBe("http://127.0.0.1:9621/health");
		// Evenly spaced: 19 gaps of 3 s span the 57 s from the first sample to the last inside the 60 s window.
		expect(fake.sleeps).toEqual(Array.from({ length: 19 }, () => 3000));
	});

	test("a sample that answers non-2xx makes the probe exit 1 and names its status", async () => {
		const steps = [...OK_100.slice(0, 19), { status: 503, latencyMs: 100 }];
		const outcome = await runProbe(PROBE_DEFAULTS, scripted(steps).deps(URL_ENV));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, failures: 1, failure_reasons: ["lightrag 503"] });
	});

	test("p95 over the bound exits 1 even when every sample answers 2xx", async () => {
		const outcome = await runProbe(PROBE_DEFAULTS, scripted([{ status: 200, latencyMs: 600 }]).deps(URL_ENV));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, failures: 0, p95_ms: 600 });
	});

	test("p95 exactly at the bound passes: the bound is at most 500 ms", async () => {
		const outcome = await runProbe(PROBE_DEFAULTS, scripted([{ status: 200, latencyMs: 500 }]).deps(URL_ENV));
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ ok: true, failures: 0, p95_ms: 500 });
	});

	test("p95 one millisecond over the bound exits 1", async () => {
		const outcome = await runProbe(PROBE_DEFAULTS, scripted([{ status: 200, latencyMs: 501 }]).deps(URL_ENV));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, failures: 0, p95_ms: 501 });
	});

	test("every 2xx status is a passing sample: 204 passes", async () => {
		const outcome = await runProbe(PROBE_DEFAULTS, scripted([{ status: 204, latencyMs: 100 }]).deps(URL_ENV));
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ ok: true, failures: 0 });
	});

	test("a 3xx status is not 2xx: a redirect fails the sample and names its status", async () => {
		const outcome = await runProbe(PROBE_DEFAULTS, scripted([{ status: 301, latencyMs: 100 }]).deps(URL_ENV));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, failures: 20, failure_reasons: expect.arrayContaining(["lightrag 301"]) });
	});

	test("percentiles are nearest-rank: one slow sample in twenty is the max, not the p95", async () => {
		const steps = [...OK_100.slice(0, 19), { status: 200, latencyMs: 900 }];
		const outcome = await runProbe(PROBE_DEFAULTS, scripted(steps).deps(URL_ENV));
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ p50_ms: 100, p95_ms: 100, max_ms: 900 });
	});

	test("a sample over the per-request timeout is a failure, and every request carries a timeout signal", async () => {
		const steps: Step[] = [{ throws: "The operation timed out.", latencyMs: 1000 }, { status: 200, latencyMs: 100 }];
		const fake = scripted(steps);
		const outcome = await runProbe(PROBE_DEFAULTS, fake.deps(URL_ENV));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ failures: 1 });
		expect(String((outcome.report.failure_reasons as string[])[0])).toStartWith("lightrag unreachable");
		expect(fake.calls.every((call) => call.timed)).toBe(true);
	});

	test("an unset LIGHTRAG_URL exits 2 with no request and no wait", async () => {
		const fake = scripted(OK_100);
		const outcome = await runProbe(PROBE_DEFAULTS, fake.deps({}));
		expect(outcome.exitCode).toBe(2);
		expect(outcome.report.ok).toBe(false);
		expect(fake.calls).toHaveLength(0);
		expect(fake.sleeps).toHaveLength(0);
	});
});

describe("LightRAG probe secrecy and host", () => {
	test("the key is sent as X-API-Key and bearer, and never appears in the output", async () => {
		const key = "lr-probe-secret-value";
		const fake = scripted([{ status: 200, latencyMs: 100 }, { throws: "socket hang up", latencyMs: 50 }]);
		const outcome = await runProbe(PROBE_DEFAULTS, fake.deps({ LIGHTRAG_URL: "http://127.0.0.1:9621", LIGHTRAG_API_KEY: key }));
		expect(fake.calls[0]).toMatchObject({ apiKey: key, authorization: `Bearer ${key}` });
		expect(JSON.stringify(outcome.report)).not.toContain(key);
	});

	test("a private network host is printed; a public host is not", () => {
		expect(printableHost("http://lightrag.railway.internal:9621/health")).toBe("lightrag.railway.internal");
		expect(printableHost("http://10.0.0.5:9621/health")).toBe("10.0.0.5");
		expect(printableHost("http://localhost:9621/health")).toBe("localhost");
		expect(printableHost("https://lightrag.example.com/health")).toBe("<public-host>");
		expect(printableHost("not a url")).toBe("<invalid-url>");
	});
});

describe("LightRAG probe arguments and percentiles", () => {
	test("no arguments give the OD-5 thresholds; a flag overrides only its own value", () => {
		expect(parseProbeArgs([])).toEqual({ samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 500 });
		expect(parseProbeArgs(["--p95-max-ms", "250"])).toEqual({ samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 250 });
	});

	test("a zero sample count, a non-number, or an unknown flag is refused with a reason", () => {
		expect(parseProbeArgs(["--samples", "0"])).toBeTypeOf("string");
		expect(parseProbeArgs(["--timeout-ms", "soon"])).toBeTypeOf("string");
		expect(parseProbeArgs(["--bogus", "1"])).toBe("unknown argument --bogus");
		expect(parseProbeArgs(["--samples"])).toBeTypeOf("string");
	});

	test("nearest-rank percentile of 1..20: p50 is 10, p95 is 19; an empty list is 0", () => {
		const sorted = Array.from({ length: 20 }, (_, index) => index + 1);
		expect(percentile(sorted, 0.5)).toBe(10);
		expect(percentile(sorted, 0.95)).toBe(19);
		expect(percentile([], 0.95)).toBe(0);
	});
});
