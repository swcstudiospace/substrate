#!/usr/bin/env bun
/**
 * The timed LightRAG health probe (SOTA-02, Phase 46, Task 5). It samples `GET <LIGHTRAG_URL><LIGHTRAG_HEALTH_PATH>`
 * evenly across a window and prints p50, p95, max and the failure count as JSON. It exits 0 only when every sample
 * answered 2xx and p95 is at most the bound. It exits 1 when a sample failed or p95 is over the bound, and 2 when the
 * arguments are bad or `LIGHTRAG_URL` is unset, in which case no socket is opened.
 *
 * The reach is read by `lightragFromEnv` (config.ts), the one LightRAG reader. The key goes out as the `X-API-Key`
 * and bearer headers the LightRAG client sends, and it is never printed. The URL host is printed only when it is
 * loopback or a private network name.
 *
 * Defaults are the OD-5 thresholds in 46-PLAN.md: 20 samples over 60 seconds, a 1000 ms per-request timeout, and a
 * p95 of at most 500 ms.
 */
import { lightragFromEnv } from "../packages/mcp-server/src/config.ts";
// Mirrors planes/lightrag.ts FetchLike so the probe does not depend on the plane client.
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
import { LIGHTRAG_HEALTH_PATH } from "../packages/mcp-server/src/railway.ts";

export interface ProbeOptions {
	samples: number;
	windowS: number;
	timeoutMs: number;
	p95MaxMs: number;
}

/** The OD-5 thresholds, set before any run. */
export const PROBE_DEFAULTS: ProbeOptions = { samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 500 };

/** Each flag, the option it sets, and the smallest whole number it accepts. */
const FLAGS: Record<string, [keyof ProbeOptions, number]> = {
	"--samples": ["samples", 1],
	"--window-s": ["windowS", 0],
	"--timeout-ms": ["timeoutMs", 1],
	"--p95-max-ms": ["p95MaxMs", 1],
};

/** Parse `--flag value` pairs over the defaults. A string is the refusal reason. */
export function parseProbeArgs(argv: readonly string[]): ProbeOptions | string {
	const options: ProbeOptions = { ...PROBE_DEFAULTS };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index] ?? "";
		const spec = Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : undefined;
		if (spec === undefined) return `unknown argument ${flag}`;
		const [key, minimum] = spec;
		const raw = argv[index + 1];
		if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < minimum) return `${flag} needs a whole number of at least ${minimum}`;
		options[key] = Number(raw);
	}
	return options;
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
export function percentile(sorted: readonly number[], quantile: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(quantile * sorted.length)));
	return sorted[rank - 1] ?? 0;
}

/** The host when it is loopback or a private network name; a placeholder otherwise, so a public endpoint is not echoed. */
export function printableHost(url: string): string {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return "<invalid-url>";
	}
	const private_ = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) || /\.(internal|local)$/.test(host);
	return private_ ? host : "<public-host>";
}

export interface ProbeDeps {
	env: Record<string, string | undefined>;
	fetchImpl: FetchLike;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

export interface ProbeOutcome {
	exitCode: 0 | 1 | 2;
	report: Record<string, unknown>;
}

interface SampleResult {
	latencyMs: number;
	reason?: string;
}

/** One request under the per-request timeout. A transport failure or a non-2xx status is the sample's reason. */
async function oneSample(url: string, headers: Record<string, string>, timeoutMs: number, deps: ProbeDeps): Promise<SampleResult> {
	const started = deps.now();
	try {
		const response = await deps.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
		const latencyMs = Math.round(deps.now() - started);
		await response.body?.cancel();
		if (response.status < 200 || response.status > 299) return { latencyMs, reason: `lightrag ${response.status}` };
		return { latencyMs };
	} catch (cause) {
		const detail = String(cause instanceof Error ? cause.message : cause).slice(0, 200);
		return { latencyMs: Math.round(deps.now() - started), reason: `lightrag unreachable: ${detail}` };
	}
}

/**
 * Run the probe. Samples are spaced evenly over the window (`windowS / samples` apart), so `samples` requests span it.
 * Every sample is taken, even after a failure, so the percentiles describe the whole window.
 */
export async function runProbe(options: ProbeOptions, deps: ProbeDeps): Promise<ProbeOutcome> {
	const config = lightragFromEnv(deps.env);
	if (config === null) return { exitCode: 2, report: { ok: false, reason: "LIGHTRAG_URL is unset: nothing was probed" } };
	const url = `${config.url}${LIGHTRAG_HEALTH_PATH}`;
	const headers: Record<string, string> = config.apiKey ? { "X-API-Key": config.apiKey, authorization: `Bearer ${config.apiKey}` } : {};
	const intervalMs = (options.windowS * 1000) / options.samples;
	const latencies: number[] = [];
	const reasons: string[] = [];
	for (let index = 0; index < options.samples; index += 1) {
		if (index > 0 && intervalMs > 0) await deps.sleep(intervalMs);
		const sample = await oneSample(url, headers, options.timeoutMs, deps);
		latencies.push(sample.latencyMs);
		if (sample.reason !== undefined) reasons.push(sample.reason);
	}
	const sorted = [...latencies].sort((left, right) => left - right);
	const p95 = percentile(sorted, 0.95);
	const ok = reasons.length === 0 && p95 <= options.p95MaxMs;
	return {
		exitCode: ok ? 0 : 1,
		report: {
			ok,
			host: printableHost(url),
			samples: options.samples,
			window_s: options.windowS,
			timeout_ms: options.timeoutMs,
			p95_max_ms: options.p95MaxMs,
			p50_ms: percentile(sorted, 0.5),
			p95_ms: p95,
			max_ms: sorted[sorted.length - 1] ?? 0,
			failures: reasons.length,
			failure_reasons: reasons,
		},
	};
}

if (import.meta.main) {
	const options = parseProbeArgs(process.argv.slice(2));
	if (typeof options === "string") {
		process.stdout.write(`${JSON.stringify({ ok: false, reason: options })}\n`);
		process.exitCode = 2;
	} else {
		const outcome = await runProbe(options, {
			env: process.env,
			fetchImpl: fetch,
			now: () => performance.now(),
			sleep: (ms) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				return promise;
			},
		});
		process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
		process.exitCode = outcome.exitCode;
	}
}
