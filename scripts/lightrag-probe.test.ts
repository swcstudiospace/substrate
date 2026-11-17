/**
 * The probe's offline proof (SC3 build): a clean window exits 0, one failed
 * sample and a hot p95 exit 1, an unset LIGHTRAG_URL exits 2 before any
 * socket, and no output ever carries the key. Latencies come from an
 * injected clock, fetches from an injected fake, sleeps from a no-op, so
 * the tests run in milliseconds.
 */
import { describe, expect, test } from "bun:test";
import { parseProbeArgs, percentile, probeUrlHost, runProbe, main, PROBE_DEFAULTS, type ProbeOptions } from "./lightrag-probe.ts";

function scriptedFetch(script: Array<{ status?: number; latencyMs: number; body?: string }>): { fetchImpl: typeof fetch; requests: string[]; seenAuth: (string | undefined)[]; clock: () => number } {
	let index = 0;
	const requests: string[] = [];
	const seenAuth: (string | undefined)[] = [];
	// The clock only moves when a fetch completes, by that fetch's scripted
	// latency: a sample's `now()` pair measures exactly the latency its fetch
	// scripted, with no real time passing anywhere.
	let current = 0;
	const clock = () => current;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const entry = script[Math.min(index, script.length - 1)] ?? { latencyMs: 1 };
		index += 1;
		requests.push(String(input));
		seenAuth.push((init?.headers as Record<string, string> | undefined)?.authorization);
		current += entry.latencyMs;
		if (entry.status === undefined) throw new Error("injected transport failure");
		return new Response(entry.body ?? "ok", { status: entry.status });
	}) as typeof fetch;
	return { fetchImpl, requests, seenAuth, clock };
}

function options(over: Partial<ProbeOptions>, script: Array<{ status?: number; latencyMs: number }>): ProbeOptions {
	const fake = scriptedFetch(script);
	return {
		url: over.url ?? "http://127.0.0.1:8000",
		samples: over.samples ?? 6,
		windowS: over.windowS ?? 1,
		timeoutMs: over.timeoutMs ?? 1000,
		p95MaxMs: over.p95MaxMs ?? 100,
		...(over.apiKey !== undefined ? { apiKey: over.apiKey } : {}),
		...(over.privateHost !== undefined ? { privateHost: over.privateHost } : {}),
		fetchImpl: fake.fetchImpl,
		sleep: async () => undefined,
		now: fake.clock,
	};
}

describe("lightrag-probe", () => {
	test("defaults are the OD-5 window; junk flags are refusals", () => {
		expect(PROBE_DEFAULTS).toEqual({ samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 500 });
		expect(parseProbeArgs([])).toEqual({ ok: true, samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 500 });
		expect(parseProbeArgs(["--samples", "40", "--p95-max-ms", "250"])).toEqual({ ok: true, samples: 40, windowS: 60, timeoutMs: 1000, p95MaxMs: 250 });
		expect(parseProbeArgs(["--samples"]).ok).toBe(false);
		expect(parseProbeArgs(["--samples", "0"]).ok).toBe(false);
		expect(parseProbeArgs(["--samples", "yes"]).ok).toBe(false);
		expect(parseProbeArgs(["--samples", "1"]).ok).toBe(false);
		expect(parseProbeArgs(["--mystery", "1"]).ok).toBe(false);
	});

	test("all samples 2xx with p95 under the bound is ok; the report prints the loopback host", async () => {
		const result = await runProbe(options({}, [
			{ status: 200, latencyMs: 10 },
			{ status: 200, latencyMs: 10 },
			{ status: 204, latencyMs: 30 },
			{ status: 200, latencyMs: 10 },
			{ status: 200, latencyMs: 10 },
			{ status: 200, latencyMs: 12 },
		]));
		expect(result).toMatchObject({ url_host: "127.0.0.1", samples: 6, failures: 0, ok: true, threshold_p95_ms: 100 });
		expect(result.p95_ms).toBeGreaterThan(0);
		expect(result.max_ms).toBeGreaterThanOrEqual(result.p95_ms);
		expect(result.p50_ms).toBeLessThanOrEqual(result.p95_ms);
	});

	test("one failed sample and a hot p95 each fail the verdict", async () => {
		const failed = await runProbe(options({}, [{ status: 503, latencyMs: 5 }, { status: 200, latencyMs: 10 }, { status: 200, latencyMs: 10 }, { status: 200, latencyMs: 10 }, { status: 200, latencyMs: 10 }, { status: 200, latencyMs: 10 }]));
		expect(failed).toMatchObject({ failures: 1, ok: false });
		const hot = await runProbe(options({}, [{ status: 200, latencyMs: 5 }, { status: 200, latencyMs: 900 }, { status: 200, latencyMs: 950 }, { status: 200, latencyMs: 900 }, { status: 200, latencyMs: 5 }, { status: 200, latencyMs: 5 }]));
		expect(hot).toMatchObject({ failures: 0, ok: false });
		expect(hot.p95_ms).toBeGreaterThan(hot.threshold_p95_ms);
	});

	test("percentile is nearest-rank over the sorted samples", () => {
		expect(percentile([], 0.95)).toBe(0);
		expect(percentile([7], 0.5)).toBe(7);
		expect(percentile([30, 10, 20], 0.5)).toBe(20);
		expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
		expect(percentile([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 0.5)).toBe(5);
	});

	test("the host is named only for loopback or the configured private host", () => {
		expect(probeUrlHost("http://127.0.0.1:8000", null)).toBe("127.0.0.1");
		expect(probeUrlHost("http://localhost:8000/", null)).toBe("localhost");
		expect(probeUrlHost("http://lightrag.railway.internal:8000", "lightrag.railway.internal")).toBe("lightrag.railway.internal");
		expect(probeUrlHost("http://lightrag.railway.internal:8000", null)).toBeNull();
		expect(probeUrlHost("not a url", null)).toBeNull();
	});

	test("main: a clean window exits 0 and prints one JSON line that never carries the key", async () => {
		const out: string[] = [];
		const fake = scriptedFetch([{ status: 200, latencyMs: 10 }]);
		const code = await main([], { LIGHTRAG_URL: "http://127.0.0.1:8000", LIGHTRAG_API_KEY: "secret-key-value-42" }, { out: (t) => out.push(t), err: () => undefined }, fake.fetchImpl, async () => undefined);
		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]).not.toContain("secret-key-value-42");
		const report = JSON.parse(out[0] ?? "{}") as { url_host: string | null; ok: boolean; samples: number };
		expect(report).toMatchObject({ url_host: "127.0.0.1", ok: true, samples: 20 });
		expect(fake.requests.every((request) => request.endsWith("/health"))).toBe(true);
		expect(fake.seenAuth[0]).toContain("Bearer ");
	});

	test("main: a failing window exits 1; a public host is not named", async () => {
		const out: string[] = [];
		const fake = scriptedFetch([{ status: 503, latencyMs: 5 }]);
		const code = await main(["--samples", "4"], { LIGHTRAG_URL: "http://lightrag.example.internal" }, { out: (t) => out.push(t), err: () => undefined }, fake.fetchImpl, async () => undefined);
		expect(code).toBe(1);
		const report = JSON.parse(out[0] ?? "{}") as { url_host: string | null; failures: number; ok: boolean };
		expect(report.url_host).toBeNull();
		expect(report.ok).toBe(false);
	});

	test("main: an unset LIGHTRAG_URL exits 2 before any socket, and so does a junk flag", async () => {
		const calls: string[] = [];
		const err: string[] = [];
		const spy = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response("should not happen", { status: 200 });
		}) as typeof fetch;
		expect(await main([], {}, { out: () => undefined, err: (t) => err.push(t) }, spy)).toBe(2);
		expect(calls).toEqual([]);
		expect(err[0]).toContain("LIGHTRAG_URL");
		expect(await main(["--nope", "1"], { LIGHTRAG_URL: "http://127.0.0.1" }, { out: () => undefined, err: () => undefined }, spy)).toBe(2);
		expect(calls).toEqual([]);
	});
});
