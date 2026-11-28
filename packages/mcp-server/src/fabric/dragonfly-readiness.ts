/**
 * DG-1a DragonflyDB gate probe and readiness check (phase 80).
 *
 * Drives the verdict `{ state, reasons, metrics, checkedAt }` with state in
 * `ok | degraded | unavailable | unconfigured`, through the cache's own
 * `CacheRedis` connection (`ping`/`info`/`probeSet`/`dbsize`/`scan` on the
 * `bunRedis` client, gated and deadline-bound by `run`). This module opens no
 * socket of its own: the probe takes thunks, so tests inject fakes and
 * production reuses the one `bunRedis` connection the cache holds.
 *
 * Config that drives it: `DRAGONFLY_URL` (the endpoint policy already applied
 * in `config.ts`; refused URLs set `dragonflyRefused`), `SUBSTRATE_CACHE`
 * (`cacheEnabled`), and `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`
 * (`commandTimeoutMs`, default `COMMAND_TIMEOUT_MS`). Thresholds are
 * constants with test injection; no new flags were added in this phase.
 *
 * State precedence (first match wins): `unconfigured` (URL unset,
 * `dragonflyRefused`, or cache off) → `unavailable` (liveness or write
 * timeout/throw/mismatch) → `degraded` (memory headroom breach at or above
 * 0.80, or `evicted_keys` growth) → `ok`. Absent INFO fields (unbounded
 * server) are `unknown` in metrics, never `unavailable`. Reasons are bounded
 * phrases; no URL, host or socket detail is emitted.
 */
import { COMMAND_TIMEOUT_MS, type CacheRedis } from "../cache.ts";
import type { DragonflyReadinessState, DragonflyReadinessVerdict } from "./types.ts";

export type { DragonflyReadinessState, DragonflyReadinessVerdict };

/** Memory headroom: `used_memory_bytes / maxmemory_bytes` at or above this is a breach. */
export const HEADROOM_THRESHOLD = 0.8;
/** TTL of one probe's write round-trip key, seconds. The key self-cleans; no `DEL`. */
export const READINESS_TTL_S = 60;
/** Prefix of the one key per probe the write round-trip uses. */
export const READINESS_PREFIX = "substrate:v1:readiness:";

/** What the probe may drive: thunks, never a socket. */
export interface DragonflyReadinessDeps {
	ping: () => Promise<string>;
	info?: ((section: "memory" | "stats") => Promise<string>) | undefined;
	probeSet?: ((key: string, value: string, ttlSeconds: number) => Promise<void>) | undefined;
	get?: ((key: string) => Promise<string | null>) | undefined;
	dbsize?: (() => Promise<number>) | undefined;
	scan?: ((match: string, count: number, cursor: string) => Promise<[string, string[]]>) | undefined;
	now?: (() => number) | undefined;
	commandTimeoutMs?: number | undefined;
}

/** The configuration the probe reads: classes and presence only, no URL in the verdict. */
export interface DragonflyReadinessConfig {
	dragonflyUrl: string | undefined;
	cacheEnabled: boolean;
	dragonflyRefused: string | null;
}

/** In-memory baseline of `evicted_keys`; the first probe establishes it, so no growth false-positives. Re-established each boot. */
let evictedBaseline: number | null = null;

/** Test seam: reset the eviction baseline so a test's first probe establishes it. */
export function resetDragonflyReadinessBaseline(): void {
	evictedBaseline = null;
}

/** DG-1b (phase 81): the last DG-1a verdict, in process memory. The synchronous `dragonflyGateVerdict()` reads it; the gate never probes. */
let lastGateVerdict: DragonflyReadinessVerdict | null = null;

/** Test seam: record a gate verdict without a probe. */
export function recordDragonflyGateVerdict(verdict: DragonflyReadinessVerdict): void {
	lastGateVerdict = verdict;
}

/** Test seam: clear the last recorded gate verdict. */
export function resetDragonflyGateVerdict(): void {
	lastGateVerdict = null;
}

/**
 * The synchronous DG-1b gate verdict (phase 81) for `ReadThroughCache` enablement and E2 (phase 82):
 * the last probe verdict, or `unconfigured` when the gate is `off` or no probe has recorded one yet.
 * Never probes, never throws, never names an endpoint.
 */
export function dragonflyGateVerdict(mode: "off" | "enforce"): DragonflyReadinessVerdict {
	if (mode === "off") {
		return { state: "unconfigured", reasons: ["dragonfly gate is off"], metrics: {}, checkedAt: new Date().toISOString() };
	}
	if (lastGateVerdict === null) {
		return { state: "unconfigured", reasons: ["dragonfly gate has no recorded verdict"], metrics: {}, checkedAt: new Date().toISOString() };
	}
	return lastGateVerdict;
}

/** `field:value` lines of an INFO section, only the named fields kept (the `cache-stats.ts` keyset). */
function infoFields(text: unknown, names: readonly string[]): Map<string, string> {
	const found = new Map<string, string>();
	if (typeof text !== "string") return found;
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const name = line.slice(0, at);
		if (names.includes(name)) found.set(name, line.slice(at + 1).trim());
	}
	return found;
}

function numberOrNull(raw: string | undefined): number | null {
	if (raw === undefined || raw === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** `work`'s answer, or a throw once `ms` has passed. Never leaks the wrapped error's text. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
	const { promise: timeout, resolve: expire } = Promise.withResolvers<{ readonly kind: "timeout" }>();
	const timer = setTimeout(() => expire({ kind: "timeout" }), ms);
	timer.unref?.();
	const settled = work.then(
		(value) => ({ kind: "ok" as const, value }),
		() => ({ kind: "failed" as const }),
	);
	const raced = await Promise.race([settled, timeout]);
	clearTimeout(timer);
	if (raced.kind === "timeout") throw new Error("timeout");
	if (raced.kind === "failed") throw new Error("failed");
	return raced.value;
}

function verdict(
	state: DragonflyReadinessState,
	reasons: string[],
	metrics: Record<string, number | string | null>,
	nowMs: number,
): DragonflyReadinessVerdict {
	return { state, reasons, metrics, checkedAt: new Date(nowMs).toISOString() };
}

/**
 * One DG-1a probe. Never throws: every failure is a verdict, and a missing
 * endpoint or any error yields a bounded, redacted reason. Every verdict is
 * recorded as the synchronous DG-1b gate verdict (`dragonflyGateVerdict`),
 * so the production consumers (healthz, fabric) feed the gate with no
 * wiring change and no second probe.
 */
export async function probeDragonflyReadiness(
	deps: DragonflyReadinessDeps,
	config: DragonflyReadinessConfig,
): Promise<DragonflyReadinessVerdict> {
	const verdict = await probeDragonflyReadinessCore(deps, config);
	recordDragonflyGateVerdict(verdict);
	return verdict;
}

/** The probe itself; `probeDragonflyReadiness` above records its verdict. */
async function probeDragonflyReadinessCore(
	deps: DragonflyReadinessDeps,
	config: DragonflyReadinessConfig,
): Promise<DragonflyReadinessVerdict> {
	const now = deps.now ?? Date.now;
	const commandTimeoutMs = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
	const nowMs = now();

	if (!config.dragonflyUrl || config.dragonflyRefused !== null || !config.cacheEnabled) {
		const reason =
			config.dragonflyRefused !== null
				? "dragonfly endpoint refused by policy"
				: config.dragonflyUrl === undefined
					? "dragonfly url unset"
					: "cache disabled";
		return verdict("unconfigured", [reason], {}, nowMs);
	}

	const metrics: Record<string, number | string | null> = {};
	const reasons: string[] = [];
	let unavailable: string | null = null;
	let degraded: string | null = null;

	// (1) Liveness: PING → PONG within the command timeout.
	try {
		const pong = await bounded(deps.ping(), commandTimeoutMs);
		if (pong !== "PONG") unavailable = "ping did not answer PONG";
	} catch {
		unavailable = "ping failed";
	}
	if (unavailable !== null) return verdict("unavailable", [unavailable], metrics, nowMs);

	// (2) + (3) Capacity headroom and eviction pressure from INFO.
	if (deps.info !== undefined) {
		let memory: Map<string, string> = new Map();
		let stats: Map<string, string> = new Map();
		try {
			memory = infoFields(await bounded(deps.info("memory"), commandTimeoutMs), ["maxmemory_bytes", "used_memory_bytes"]);
		} catch {
			memory = new Map();
		}
		try {
			stats = infoFields(await bounded(deps.info("stats"), commandTimeoutMs), ["evicted_keys"]);
		} catch {
			stats = new Map();
		}
		const maxmemory = numberOrNull(memory.get("maxmemory_bytes"));
		const used = numberOrNull(memory.get("used_memory_bytes"));
		const evicted = numberOrNull(stats.get("evicted_keys"));
		metrics.used_memory_bytes = used;
		metrics.maxmemory_bytes = maxmemory;
		if (maxmemory !== null && maxmemory > 0 && used !== null) {
			const ratio = used / maxmemory;
			metrics.headroom_ratio = ratio;
			if (ratio >= HEADROOM_THRESHOLD) degraded = "memory headroom ratio at or above 0.80";
		} else {
			metrics.headroom_ratio = null;
		}
		metrics.evicted_keys = evicted;
		metrics.evicted_keys_baseline = evictedBaseline;
		if (evicted !== null) {
			if (evictedBaseline === null) {
				evictedBaseline = evicted;
			} else if (evicted < evictedBaseline) {
				evictedBaseline = evicted;
			} else {
				if (evicted > evictedBaseline && degraded === null) degraded = "evicted keys grew since previous probe";
				evictedBaseline = evicted;
			}
		}
	} else {
		metrics.used_memory_bytes = null;
		metrics.maxmemory_bytes = null;
		metrics.headroom_ratio = null;
		metrics.evicted_keys = null;
		metrics.evicted_keys_baseline = evictedBaseline;
	}

	// (4) Write round-trip: one key per probe, 60 s TTL, self-cleaning.
	if (deps.probeSet !== undefined && deps.get !== undefined) {
		const key = `${READINESS_PREFIX}${nowMs}`;
		const value = String(nowMs);
		try {
			await bounded(deps.probeSet(key, value, READINESS_TTL_S), commandTimeoutMs);
			const roundTrip = await bounded(deps.get(key), commandTimeoutMs);
			if (roundTrip !== value) return verdict("unavailable", ["write round-trip mismatch"], metrics, nowMs);
		} catch {
			return verdict("unavailable", ["write round-trip failed"], metrics, nowMs);
		}
	}

	// (5) Optional visibility: metrics only, never changes state.
	if (deps.dbsize !== undefined) {
		try {
			metrics.dbsize = await bounded(deps.dbsize(), commandTimeoutMs);
		} catch {
			metrics.dbsize = null;
		}
	}
	if (deps.scan !== undefined) {
		try {
			const [, keys] = await bounded(deps.scan(`${READINESS_PREFIX}*`, 10, "0"), commandTimeoutMs);
			metrics.scan_keys = keys.length;
		} catch {
			metrics.scan_keys = null;
		}
	}

	if (degraded !== null) reasons.push(degraded);
	return verdict(degraded !== null ? "degraded" : "ok", reasons, metrics, nowMs);
}

/**
 * The production probe over the cache's own connection: reuses the
 * `CacheRedis` the read-through cache holds (the same gate and socket),
 * never a second `RedisClient`. A client without `ping` answers
 * `unavailable` from the probe, never throws.
 */
export function makeDragonflyProbe(
	redis: CacheRedis | null,
	config: DragonflyReadinessConfig,
	overrides: { now?: (() => number) | undefined; commandTimeoutMs?: number | undefined } = {},
): () => Promise<DragonflyReadinessVerdict | null> {
	return async () => {
		if (redis === null) return null;
		const deps: DragonflyReadinessDeps = {
			ping: () => {
				if (redis.ping === undefined) return Promise.reject(new Error("ping unsupported"));
				return redis.ping();
			},
			now: overrides.now,
			commandTimeoutMs: overrides.commandTimeoutMs,
		};
		if (redis.info !== undefined) deps.info = (section) => redis.info?.(section) ?? Promise.reject(new Error("info unsupported"));
		if (redis.probeSet !== undefined) deps.probeSet = (key, value, ttl) => redis.probeSet?.(key, value, ttl) ?? Promise.reject(new Error("probeSet unsupported"));
		if (redis.get !== undefined) deps.get = (key) => redis.get(key);
		if (redis.dbsize !== undefined) deps.dbsize = () => redis.dbsize?.() ?? Promise.reject(new Error("dbsize unsupported"));
		if (redis.scan !== undefined) deps.scan = (match, count, cursor) => redis.scan?.(match, count, cursor) ?? Promise.reject(new Error("scan unsupported"));
		return probeDragonflyReadiness(deps, config);
	};
}
