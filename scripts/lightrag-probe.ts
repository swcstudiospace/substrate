#!/usr/bin/env bun
/**
 * The timed LightRAG health probe (phase 46, SC3): the evidence Task 6
 * records after the operator approves the pinned production deploy.
 *
 * Reads the plane's reach only through `lightragFromEnv` (config.ts) —
 * `LIGHTRAG_URL` required, `LIGHTRAG_API_KEY` optional, never a new reader
 * and never an echoed key — and sends GET to `LIGHTRAG_HEALTH_PATH`
 * (railway.ts, currently "/health"; the path is the repo constant, not a
 * checked deployment fact) with the `x-api-key` and bearer headers the
 * plane client sends, so the probe exercises the same door a docs search
 * opens.
 *
 * Parameters, with the OD-5 defaults: `--samples 20`, `--window-s 60`
 * (samples evenly spaced across the window), `--timeout-ms 1000`,
 * `--p95-max-ms 500`. Each sample records status and latency; the JSON
 * report carries p50, p95, max, the failure count and the verdict. Exit
 * codes: 0 every sample 2xx and p95 within the bound; 1 otherwise (a
 * failed sample or a hot tail); 2 refused before any socket — an unset
 * `LIGHTRAG_URL` or a malformed flag. The URL's host is printed only when
 * it is loopback or the configured private host
 * (`RAILWAY_PRIVATE_DOMAIN`); a public host prints as null, and the key
 * never appears anywhere.
 */
import { lightragFromEnv, railwayHostingFromEnv } from "../packages/mcp-server/src/config.ts";
import { LIGHTRAG_HEALTH_PATH } from "../packages/mcp-server/src/railway.ts";

export const PROBE_DEFAULTS = { samples: 20, windowS: 60, timeoutMs: 1000, p95MaxMs: 500 } as const;

export interface ProbeSample {
	ok: boolean;
	status: number | null;
	latency_ms: number;
	error?: string;
}

export interface ProbeOptions {
	url: string;
	apiKey?: string;
	samples: number;
	windowS: number;
	timeoutMs: number;
	p95MaxMs: number;
	privateHost?: string | null;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface ProbeResult {
	/** The URL's host, only when loopback or the configured private host; null otherwise. */
	url_host: string | null;
	samples: number;
	p50_ms: number;
	p95_ms: number;
	max_ms: number;
	failures: number;
	ok: boolean;
	threshold_p95_ms: number;
}

export type ParsedProbeArgs =
	| { ok: true; samples: number; windowS: number; timeoutMs: number; p95MaxMs: number }
	| { ok: false; reason: string };

/** The flag table: one value per flag, the OD-5 defaults when omitted. */
export function parseProbeArgs(argv: readonly string[]): ParsedProbeArgs {
	const parsed = { samples: PROBE_DEFAULTS.samples, windowS: PROBE_DEFAULTS.windowS, timeoutMs: PROBE_DEFAULTS.timeoutMs, p95MaxMs: PROBE_DEFAULTS.p95MaxMs };
	const counts: Record<string, number | undefined> = { "--samples": undefined, "--window-s": undefined, "--timeout-ms": undefined, "--p95-max-ms": undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index] ?? "";
		if (!(flag in counts) || index + 1 >= argv.length) return { ok: false, reason: `usage: bun scripts/lightrag-probe.ts [--samples N] [--window-s S] [--timeout-ms MS] [--p95-max-ms MS]; unexpected ${flag}` };
		const value = Number(argv[index + 1]);
		if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return { ok: false, reason: `${flag} needs a positive integer, got ${String(argv[index + 1])}` };
		counts[flag] = value;
		index += 1;
	}
	const samples = counts["--samples"] ?? parsed.samples;
	const windowS = counts["--window-s"] ?? parsed.windowS;
	const timeoutMs = counts["--timeout-ms"] ?? parsed.timeoutMs;
	const p95MaxMs = counts["--p95-max-ms"] ?? parsed.p95MaxMs;
	if (samples < 2) return { ok: false, reason: "--samples needs at least 2 so p95 and p50 differ" };
	return { ok: true, samples, windowS, timeoutMs, p95MaxMs };
}

/** The nearest-rank percentile of an unsorted sample set. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
	return sorted[rank - 1] ?? 0;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The URL's host when the report may name it (loopback or the configured private host), null otherwise. */
export function probeUrlHost(url: string, privateHost: string | null): string | null {
	try {
		const host = new URL(url).hostname;
		return LOOPBACK_HOSTS.has(host) || (privateHost !== null && host === privateHost) ? host : null;
	} catch {
		return null;
	}
}

/** One GET to the health path, timed, with the same auth headers the plane client sends. */
async function sampleOnce(options: ProbeOptions): Promise<ProbeSample> {
	const started = (options.now ?? Date.now)();
	let status: number | null = null;
	try {
		const headers: Record<string, string> = options.apiKey ? { "x-api-key": options.apiKey, authorization: `Bearer ${options.apiKey}` } : {};
		const response = await (options.fetchImpl ?? fetch)(`${options.url}${LIGHTRAG_HEALTH_PATH}`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		status = response.status;
		const latency = (options.now ?? Date.now)() - started;
		return { ok: response.status >= 200 && response.status <= 299, status, latency_ms: latency };
	} catch (cause) {
		const latency = (options.now ?? Date.now)() - started;
		const detail = String(cause instanceof Error ? cause.message : cause).slice(0, 200);
		return { ok: false, status: null, latency_ms: latency, ...(detail ? { error: detail } : {}) };
	}
}

/** Run every sample evenly spaced across the window and compute the verdict. */
export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
	const sleep =
		options.sleep ??
		((ms: number): Promise<void> => {
			const settled = Promise.withResolvers<void>();
			setTimeout(settled.resolve, ms);
			return settled.promise;
		});
	const intervalMs = Math.max(0, Math.round((options.windowS * 1000) / options.samples));
	const samples: ProbeSample[] = [];
	for (let index = 0; index < options.samples; index += 1) {
		if (index > 0 && intervalMs > 0) await sleep(intervalMs);
		samples.push(await sampleOnce(options));
	}
	const latencies = samples.map((sample) => sample.latency_ms);
	const failures = samples.filter((sample) => !sample.ok).length;
	const p50 = percentile(latencies, 0.5);
	const p95 = percentile(latencies, 0.95);
	const max = latencies.length > 0 ? Math.max(...latencies) : 0;
	return {
		url_host: probeUrlHost(options.url, options.privateHost ?? null),
		samples: samples.length,
		p50_ms: p50,
		p95_ms: p95,
		max_ms: max,
		failures,
		ok: failures === 0 && p95 <= options.p95MaxMs,
		threshold_p95_ms: options.p95MaxMs,
	};
}

export interface ProbeIo {
	out: (text: string) => void;
	err: (text: string) => void;
}

/** The CLI entry: refuse before any socket when the reach is unset, then run and print the JSON verdict. */
export async function main(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	io: ProbeIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
	fetchImpl?: typeof fetch,
	sleep?: (ms: number) => Promise<void>,
): Promise<number> {
	const parsed = parseProbeArgs(argv);
	if (!parsed.ok) {
		io.err(`lightrag-probe: ${parsed.reason}\n`);
		return 2;
	}
	const reach = lightragFromEnv(env);
	if (reach === null) {
		io.err("lightrag-probe: LIGHTRAG_URL is unset; refusing to probe before any socket is opened\n");
		return 2;
	}
	const hosting = railwayHostingFromEnv(env);
	const result = await runProbe({
		url: reach.url,
		...(reach.apiKey !== undefined ? { apiKey: reach.apiKey } : {}),
		samples: parsed.samples,
		windowS: parsed.windowS,
		timeoutMs: parsed.timeoutMs,
		p95MaxMs: parsed.p95MaxMs,
		privateHost: hosting?.privateDomain ?? null,
		...(fetchImpl !== undefined ? { fetchImpl } : {}),
		...(sleep !== undefined ? { sleep } : {}),
	});
	io.out(
		`${JSON.stringify({
			url_host: result.url_host,
			samples: result.samples,
			p50_ms: result.p50_ms,
			p95_ms: result.p95_ms,
			max_ms: result.max_ms,
			failures: result.failures,
			ok: result.ok,
			threshold_p95_ms: result.threshold_p95_ms,
		})}\n`,
	);
	return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
