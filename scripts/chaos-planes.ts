#!/usr/bin/env bun
/**
 * Opt-in per-plane chaos for a rehearsal twin (`SUBSTRATE_GATE_CHAOS_PLANES=1` or
 * `bun scripts/chaos-planes.ts --name <instance>` or `rehearsal smoke --chaos-planes`).
 *
 * Planes, in order: index, cache, hindsight, ragflow. The Greptime ledger is not here;
 * the 60s ledger proof stays in `chaos-smoke.ts` and the gate's `outage.chaos`.
 * `CHAOS_REHEARSAL` is never set.
 *
 * Default off: exit 0, no docker, no HTTP. The index plane pauses only
 * `substrate-rehearsal-<name>-pg` through the harness's pause-target rules, for 20s
 * (longer than the 5s `/healthz` memo). An index-only outage stays HTTP 200, so the
 * body is what counts (`planes.index.ok === false`). Breaker state is not required.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CHAOS_PLANES = ["index", "cache", "hindsight", "ragflow"] as const;
export type ChaosPlane = (typeof CHAOS_PLANES)[number];

/** Longer than the 5s `/healthz` memo so a paused index is visible in a body. */
export const INDEX_CHAOS_WINDOW_MS = 20_000;

export function chaosPlanesEnabled(env: Record<string, string | undefined>): boolean {
	return env.SUBSTRATE_GATE_CHAOS_PLANES === "1";
}

export interface ChaosHealthBody {
	cache?: { enabled?: boolean };
	planes?: {
		index?: { ok?: boolean | null };
		hindsight?: { ok?: boolean | null };
		ragflow?: { ok?: boolean | null };
	};
}

export interface ChaosPlanesDeps {
	/** Direct CLI entry passes true. The flag-off hook passes false and must not touch docker or HTTP. */
	enabled: boolean;
	name: string;
	/** Twin URL from `consumer.env`. Ignored when `enabled` is false. */
	substrateUrl: string;
	pause(action: "pause" | "unpause"): Promise<void>;
	healthz(): Promise<ChaosHealthBody>;
	brief(): Promise<{ status: number }>;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface ChaosPlanesResult {
	exit: 0 | 1;
	skips: string[];
	detail: string;
}

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

/** Null when `raw` is an http(s) loopback URL. */
export function refuseChaosUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "refusing chaos target: the twin URL is not a URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "refusing chaos target: the twin URL is not http(s)";
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (LOOPBACK[host] !== true) return `refusing non-loopback chaos host ${url.hostname}`;
	return null;
}

function skipsFor(body: ChaosHealthBody): string[] {
	const skips: string[] = [];
	if (body.cache?.enabled !== true) skips.push("cache: rehearsal does not boot redis");
	if (body.planes?.hindsight?.ok === null || body.planes?.hindsight?.ok === undefined) skips.push("hindsight: plane is not configured");
	if (body.planes?.ragflow?.ok === null || body.planes?.ragflow?.ok === undefined) skips.push("ragflow: plane is not configured");
	return skips;
}

/**
 * Run the four planes. `enabled: false` returns immediately. Otherwise the index container
 * is paused and always unpaused, including when pause itself throws.
 */
export async function runChaosPlanes(deps: ChaosPlanesDeps): Promise<ChaosPlanesResult> {
	if (!deps.enabled) return { exit: 0, skips: [], detail: "chaos planes off" };
	const refused = refuseChaosUrl(deps.substrateUrl);
	if (refused !== null) return { exit: 1, skips: [], detail: refused };

	let paused = false;
	const skips: string[] = [];
	let sawIndexOutage = false;
	let briefsOk = true;
	let failure = "";
	try {
		try {
			await deps.pause("pause");
			paused = true;
		} catch (cause) {
			failure = `index pause failed: ${String((cause as Error)?.message ?? cause).split("\n")[0]?.slice(0, 200)}`;
		}
		if (paused) {
			const start = deps.now();
			let sampled = false;
			while (!sampled || deps.now() - start < INDEX_CHAOS_WINDOW_MS) {
				const body = await deps.healthz();
				if (!sampled) skips.push(...skipsFor(body));
				sampled = true;
				if (body.planes?.index?.ok === false) sawIndexOutage = true;
				const brief = await deps.brief();
				if (brief.status !== 200) briefsOk = false;
				if (deps.now() - start >= INDEX_CHAOS_WINDOW_MS) break;
				await deps.sleep(1000);
			}
		}
	} finally {
		try {
			await deps.pause("unpause");
		} catch (cause) {
			const line = String((cause as Error)?.message ?? cause).split("\n")[0]?.slice(0, 200);
			failure = failure === "" ? `index unpause failed: ${line}` : `${failure}; unpause failed: ${line}`;
		}
	}

	if (failure !== "") return { exit: 1, skips, detail: failure };
	if (!briefsOk) return { exit: 1, skips, detail: "a /brief during the index pause was not HTTP 200" };
	if (!sawIndexOutage) return { exit: 1, skips, detail: "no /healthz body reported planes.index.ok false during the index pause" };
	const skipNote = skips.length === 0 ? "no plane skipped" : `skipped ${skips.join("; ")}`;
	return { exit: 0, skips, detail: `index outage observed; ${skipNote}` };
}

/** Read the instance's consumer.env and drive the real twin. Holds the name lock around pause and the window. */
export async function chaosPlanesFromInstance(name: string, runDir: string): Promise<ChaosPlanesResult> {
	const { parseShellExports, pauseScratchStoreUnlocked, withNameLock, refuseSmokeUrl } = await import("./rehearsal.ts");
	let text = "";
	try {
		text = readFileSync(join(runDir, "consumer.env"), "utf8");
	} catch {
		return { exit: 1, skips: [], detail: `no consumer.env for instance ${name}` };
	}
	const record = parseShellExports(text);
	const base = (record.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
	const token = record.SUBSTRATE_TOKEN ?? "";
	if (refuseSmokeUrl(base) !== null) return { exit: 1, skips: [], detail: refuseSmokeUrl(base) ?? "refused" };
	return await withNameLock(runDir, name, () =>
		runChaosPlanes({
			enabled: true,
			name,
			substrateUrl: base,
			async pause(action) {
				await pauseScratchStoreUnlocked(name, "index", action);
			},
			async healthz() {
				const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) });
				return (await res.json()) as ChaosHealthBody;
			},
			async brief() {
				const res = await fetch(`${base}/brief`, {
					method: "POST",
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					body: JSON.stringify({ repo: "rehearsal/chaos-planes", branch: "chaos" }),
					signal: AbortSignal.timeout(10_000),
				});
				return { status: res.status };
			},
			now: () => Date.now(),
			sleep: (ms) => Bun.sleep(ms),
		}),
	);
}

async function main(argv: readonly string[]): Promise<number> {
	let name: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--name") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				process.stderr.write("[chaos-planes] --name needs a value\n");
				return 2;
			}
			name = value;
			i++;
			continue;
		}
		process.stderr.write(`[chaos-planes] unknown option ${token}\nusage: bun scripts/chaos-planes.ts --name <instance>\n`);
		return 2;
	}
	if (name === null) {
		process.stderr.write("[chaos-planes] --name is required\nusage: bun scripts/chaos-planes.ts --name <instance>\n");
		return 2;
	}
	const { parseName, runDirFor, RehearsalRefused } = await import("./rehearsal.ts");
	try {
		const parsed = parseName(name);
		const result = await chaosPlanesFromInstance(parsed, runDirFor(parsed));
		const stream = result.exit === 0 ? process.stdout : process.stderr;
		stream.write(`[chaos-planes] ${result.detail}\n`);
		return result.exit;
	} catch (cause) {
		if (cause instanceof RehearsalRefused) {
			process.stderr.write(`[chaos-planes] refused: ${cause.message}.\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
