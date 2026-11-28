/**
 * Dragonfly read-through cache.
 *
 * Cache only. A missing URL, `SUBSTRATE_CACHE=0`, a refused connection or a bad
 * value all return the same answer the caller would have got with no cache.
 * Nothing here is a queue, a lock, a session or a pub/sub channel: a restart
 * drops every key, and generation counters make a write visible without a scan.
 *
 * The client is Bun's `RedisClient` (Bun 1.4). It is constructed on the first
 * command, with a short connect timeout and the same budget on every command
 * (`SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` / `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`,
 * 250 ms each for the loopback redis production runs), no offline queue and no
 * reconnect retries, so one request never waits on a second attempt. A failed
 * connect also starts a `CACHE_CONNECT_COOLDOWN_MS` cooldown during which every
 * command is refused before any socket is touched. Each command goes through the
 * cache's plane gate (uplift-2 R2) *together with the connect it needed*, so the
 * breaker sees exactly one outcome per request and a dead Dragonfly costs one
 * timeout, not one per request.
 *
 * One class is generation-free: `brief-snapshot` holds the last *complete*
 * brief per surface and arguments (uplift-2 R1), read only when the live
 * compose came back degraded. It is still a cache — a restart drops it and the
 * brief composes as before. The admission buckets (uplift-3 N3, `admission.ts`)
 * are the one key class that is not a cached answer: `budget:<surface>:<class>`,
 * stepped by one `EVAL` through `script()`, always with a TTL, and a cache that
 * cannot answer admits every caller.
 *
 * `recall-snapshot` (uplift-4 S5) holds the warm Hindsight recall the brief appends in
 * `SUBSTRATE_BRIEF_RECALL=enforce`. The prefetcher writes its own-bank entries without
 * generations. The brief's cross-bank fan-out passes the memory and recall generations
 * with each read, so a write or a retain landing refreshes the next brief at once. A prefetched entry lives twice
 * `SUBSTRATE_BRIEF_RECALL_TTL_S` (fresh for the first half, stale for the second). A fan-out entry lives
 * `SUBSTRATE_BRIEF_RECALL_TTL_S` itself, with no stale half, because its `refreshAt` is that TTL.
 */
import { createHash } from "node:crypto";
import { RedisClient } from "bun";
import { BreakerOpenError, callPlane, type PlaneGate } from "@substrate/observability";
import type { SubstrateConfig } from "./config.ts";
// DG-1b (phase 81): this import closes a loop (`fabric/dragonfly-readiness.ts` imports
// `COMMAND_TIMEOUT_MS` and `CacheRedis` from here), but both sides only use each other
// inside function bodies, never at module scope, so either load order resolves.
import { dragonflyGateVerdict } from "./fabric/dragonfly-readiness.ts";
import { REDACTED, redact } from "./redact.ts";
import { MAX_RECALL_TTL_S } from "./recall-snapshot.ts";

export const CACHE_PREFIX = "substrate:v1";

/**
 * Seconds. Brief 5 min, memory search 10 min, graph view 1 min, last-good brief 1 h, docs search 5 min. The recall snapshot's
 * class limit is the setting's maximum, so a fan-out entry lives the configured `SUBSTRATE_BRIEF_RECALL_TTL_S` (its `refreshAt`).
 */
export const CACHE_TTL = {
	brief: 300,
	"memory-search": 600,
	"graph-view": 60,
	"brief-snapshot": 3600,
	"recall-snapshot": MAX_RECALL_TTL_S,
	"docs-search": 300,
	emb: 604_800,
	// E2 (phase 82): the shared lane's `context` TTL. `output` (60 s) and `recall` (600 s) govern their own writes through `SHARED_KIND_TTL` (`fabric/shared-context.ts`); every shared write carries its kind's TTL, this is only the class ceiling.
	shared: 300,
} as const;

export type CacheClass = keyof typeof CACHE_TTL;
export type CacheMode = "off" | "on" | "degraded";
export type CacheResult = "hit" | "miss" | "bypass" | "error" | "coalesced" | "stale" | "refresh" | "would_serve_stale";
/** `SUBSTRATE_CACHE_SWR`: `off` never serves stale, `shadow` only counts `would_serve_stale`, `enforce` serves it. */
export type CacheSwrMode = "off" | "shadow" | "enforce";
/** `SUBSTRATE_DRAGONFLY_GATE` (DG-1b, phase 81): `off` never gates, `enforce` bypasses reads (durable read, never stale, never throws) while the last DG-1a verdict is neither `ok` nor `degraded`; `degraded` still serves. */
export type DragonflyGateMode = "off" | "enforce";

/**
 * Every key class under `substrate:v1:`. The closed set behind the metric label
 * `substrate.cache.operations{class}` and `scripts/cache-stats.ts`: the five
 * request classes plus the two that are not a cached answer (`budget` buckets,
 * `gen` counters).
 */
export const CACHE_CLASSES = ["brief", "memory-search", "graph-view", "brief-snapshot", "recall-snapshot", "docs-search", "emb", "shared", "budget", "gen"] as const;
export type CacheKeyClass = (typeof CACHE_CLASSES)[number];

/** The class a `substrate:v1:` key belongs to, or null for anything else. Reads the key name only. */
export function classOf(key: string): CacheKeyClass | null {
	const prefix = `${CACHE_PREFIX}:`;
	if (!key.startsWith(prefix)) return null;
	const rest = key.slice(prefix.length);
	const end = rest.indexOf(":");
	const head = end === -1 ? rest : rest.slice(0, end);
	return (CACHE_CLASSES as readonly string[]).includes(head) ? (head as CacheKeyClass) : null;
}

export const MEMORY_GENERATION_KEY = `${CACHE_PREFIX}:gen:memory`;

/**
 * `SUBSTRATE_CACHE_BUMP_SCOPE=narrow` (uplift-5 U5-3): bumped after a successful Hindsight
 * retain and after an outbox replay, instead of the memory generation. Read only by the entries
 * whose answer holds a Hindsight recall (`memory_recall`, and the merged `memory_search`); a brief
 * reads recall through the generation-free `recall-snapshot` and a paged search reads the index
 * alone, so neither lists it. Under `legacy` nothing writes or reads it.
 */
export const RECALL_GENERATION_KEY = `${CACHE_PREFIX}:gen:recall`;

/** Bumped on every graph write, so a brief that lists other graphs refreshes too. */
export const GRAPHS_GENERATION_KEY = `${CACHE_PREFIX}:gen:graphs`;

export function graphGenerationKey(graphId: string): string {
	return `${CACHE_PREFIX}:gen:graph:${graphId}`;
}

/**
 * Bumped by every successful docs ingest and every recorded dataset version
 * (uplift-2 R6), so a refresh invalidates every cached `docs_search` answer
 * at once; the pins are also part of the key.
 */
export const DOCS_GENERATION_KEY = `${CACHE_PREFIX}:gen:docs`;

/**
 * When memory was last forgotten, in epoch ms, deployment-wide (not per repo). A plain value set with a TTL, not a
 * counter, so it is read as a time and never as a generation. It lives in the `gen` class beside the counters and
 * is read by no cached answer: only the saved-brief readers ask it (`snapshotSurvivesForget`), because a
 * `brief-snapshot` has no generation and so cannot see a forget through the memory and recall counters.
 */
export const FORGET_MARK_KEY = `${CACHE_PREFIX}:gen:forgotten`;

/** Seconds the mark outlives the longest saved brief it has to guard, so a snapshot saved just before a forget is covered to its last second. */
export const FORGET_MARK_MARGIN_S = 300;

/**
 * The forget mark's lifetime for a `briefSnapshotTtlS`: the longest saved brief it has to guard, plus the margin. The one
 * place it is computed, so `Substrate.memoryForget` and the cross-layer reconcile judge the same number.
 */
export function forgetMarkTtlS(briefSnapshotTtlS: number): number {
	return Math.max(briefSnapshotTtlS, CACHE_TTL["brief-snapshot"]) + FORGET_MARK_MARGIN_S;
}

/** What the forget mark holds, as the cross-layer reconcile reads it. `disabled` when the cache is off. */
export type ForgetMarkRead = { state: "disabled" } | { state: "absent" } | { state: "present"; atMs: number };

/**
 * Soonest future timestamp, in epoch ms. A cached answer must not outlive the
 * next lease expiry or reverify deadline baked into it.
 */
export function earliestRefreshAt(stamps: ReadonlyArray<string | null | undefined>, now = Date.now()): number | null {
	let best: number | null = null;
	for (const stamp of stamps) {
		if (!stamp) continue;
		const ms = Date.parse(stamp);
		if (!Number.isFinite(ms) || ms <= now) continue;
		if (best === null || ms < best) best = ms;
	}
	return best;
}

export interface CacheHealth {
	enabled: boolean;
	connected: boolean;
	mode: CacheMode;
	hits: number;
	misses: number;
	bypasses: number;
	errors: number;
	/** Identical concurrent misses that shared another caller's load (uplift-4 S4). */
	coalesced?: number;
	/** Answers served from a last-good value inside the stale window (`SUBSTRATE_CACHE_SWR=enforce`). */
	stale?: number;
	/** Misses `enforce` would have answered stale; counted under `shadow`. */
	wouldServeStale?: number;
	/** Background refreshes started behind a stale answer. */
	refreshes?: number;
	/** Epoch ms until which a failed connect is not retried; null when not cooling down. */
	cooldownUntil: number | null;
	/** Why the cache is off despite a URL being set — a DOCS-06 refusal. Absent otherwise. */
	reason?: string;
}

export interface CacheSample {
	result: CacheResult;
	mode: CacheMode;
	/** The key class the operation belonged to; the metric labels it `class`. */
	cacheClass?: CacheKeyClass;
}

/** What `ReadThroughCache.script` answers. `ok: false` is a bounded, redacted reason the caller treats as cache-off; `breakerRetryAfterMs` is set only when the plane's breaker refused the command, so nothing was sent: the wait until its next probe. */
export type ScriptOutcome = { ok: true; value: unknown } | { ok: false; reason: string; breakerRetryAfterMs?: number };

/** The commands the cache uses. Tests pass a fake; production uses Bun. */
export interface CacheRedis {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds: number): Promise<void>;
	incr(key: string): Promise<number>;
	/** One round trip for several keys. A fake without it is read with concurrent GETs. */
	mget?(keys: readonly string[]): Promise<Array<string | null>>;
	/**
	 * Run a Lua script atomically (uplift-3 N3 admission). A fake without it makes
	 * every admission decision a bypass, which is the cache-off answer.
	 */
	eval?(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
	/** When the client is refusing to reconnect, epoch ms; absent or null otherwise. */
	cooldownUntil?(): number | null;
	/**
	 * One SCAN step over `match` from `cursor` (`"0"` to start), at most `count` keys a page. Returns the next cursor and the page. Read-only: used by the reconcile scan.
	 */
	scan?(match: string, count: number, cursor: string): Promise<[string, string[]]>;
	/** Remove keys with UNLINK. Returns how many were removed. Used only by the confirmed reconcile repair. */
	unlink?(keys: readonly string[]): Promise<number>;
	/** DG-1a gate probe (phase 80): `PING` through the gated, deadline-bound `run` path. Absent on fakes that predate it; the probe answers `unavailable`, never throws. */
	ping?(): Promise<string>;
	/** DG-1a gate probe: `INFO <section>` as raw text through `run`, using the `cache-stats.ts` field keyset. Absent on older fakes. */
	info?(section: "memory" | "stats"): Promise<string>;
	/** DG-1a gate probe: a write round-trip outside the cache's key/TTL policy (`run("set", …)`). Absent on older fakes. */
	probeSet?(key: string, value: string, ttlSeconds: number): Promise<void>;
	/** DG-1a optional visibility: `DBSIZE` as a count; reported in probe metrics only, never changes state. */
	dbsize?(): Promise<number>;
}

export interface ReadThroughOptions {
	redis: CacheRedis | null;
	enabled: boolean;
	now?: (() => number) | undefined;
	log?: (line: string) => void;
	commandTimeoutMs?: number;
	record?: ((sample: CacheSample) => void) | undefined;
	/** The DOCS-06 refusal to report in health, if the cache was refused. */
	refusedReason?: string;
	/** Stale-while-revalidate mode and window (`SUBSTRATE_CACHE_SWR`, `SUBSTRATE_CACHE_SWR_WINDOW_S`). Absent is `off`. */
	swr?: { mode: CacheSwrMode; windowS?: number };
	/** DG-1b (`SUBSTRATE_DRAGONFLY_GATE`): `off` (absent) never gates; `enforce` bypasses reads while the last DG-1a verdict is neither `ok` nor `degraded`. The verdict is read per call, so a probe recorded after construction governs from then on. */
	gateMode?: DragonflyGateMode;
	/** Hard cap on registered loads; beyond it requests load independently. */
	maxInflight?: number;
	/** A registered load older than this is not joined (a hung loader must not capture later callers), ms. */
	flightMaxAgeMs?: number;
}

/** A last-good value for a key whose generation moved (uplift-4 S4). */
export interface LastGood<T> {
	value: T;
	/** Epoch ms the value was composed. */
	atMs: number;
	/** Epoch ms the value stops being true (a lease or reverify deadline); null means none. Never absent: an unknown deadline is not a last-good. */
	untilMs: number | null;
}

/** One load, with the same hooks a plain `getOrLoad` request has. */
export interface RefreshLoad<T> {
	load: () => Promise<T>;
	refreshAt?: (value: T) => number | null;
	store?: (value: T) => boolean;
	/** Runs once after a storable refresh, to write the generation-free last-good. Never fails the refresh. */
	stored?: (value: T) => Promise<void> | void;
}

/** How a call takes part in stale-while-revalidate; absent means single-flight only. */
export interface StaleServing<T> {
	/** The generation-free last-good value or null. Must not count as a cache read (`peekQuiet`). */
	lastGood: () => Promise<LastGood<T> | null>;
	/** Called when a refresh starts: returns a load with its own state, so a refresh never touches the caller's closures. */
	refresh: () => RefreshLoad<T>;
	/** Called synchronously, `enforce` only, when a stale value is about to be returned. */
	served?: (ageMs: number) => void;
}

/**
 * A request waits at most this long for one command, connect included.
 * Production's cache is a loopback redis (sub-millisecond), so 250 ms is
 * generous: it only ever matters when the server is wedged, and then a brief
 * must not spend its budget waiting on a cache it can do without. The old
 * 800 ms was sized for a tailnet hop to the Railway Dragonfly that production
 * no longer uses. Both are overridable (`ReadThroughOptions.commandTimeoutMs`,
 * `BunRedisOptions.connectTimeoutMs`; env in `config.ts`).
 */
export const COMMAND_TIMEOUT_MS = 250;
export const CONNECT_TIMEOUT_MS = 250;
/**
 * After a failed connect, how long `open()` refuses before trying the socket
 * again. Without it every request during an outage paid the full connect
 * timeout; with it only the first does, and the rest bypass in microseconds.
 */
export const CACHE_CONNECT_COOLDOWN_MS = 5_000;
const LOG_INTERVAL_MS = 60_000;
/** Most registered loads at once (single-flight and refreshes share the map). */
export const MAX_INFLIGHT = 256;
/** Most background refreshes at once. */
export const MAX_REFRESHES = 16;
/** A registered load older than this is no longer joined, ms. Generous: the brief's own budget is 1.2 s. */
export const FLIGHT_MAX_AGE_MS = 15_000;
export const DEFAULT_SWR_WINDOW_S = 30;
export const MAX_SWR_WINDOW_S = 300;

/**
 * Stable JSON: object keys sorted, `undefined` dropped. The hash input, so two
 * calls with the same arguments and surface share a key whatever order the
 * fields were written in.
 */
export function canonical(value: unknown): string {
	return JSON.stringify(order(value));
}

function order(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(order);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			if (source[key] !== undefined) out[key] = order(source[key]);
		}
		return out;
	}
	return value;
}

/**
 * `substrate:v1:<class>:<hash>`. The hash covers the normalized arguments, the
 * caller's surface and the generation, so a write that bumps the generation
 * misses without deleting anything.
 */
export function cacheKey(klass: CacheClass, surface: string, generation: string, args: unknown): string {
	const hash = createHash("sha256").update(canonical({ surface, generation, args })).digest("hex");
	return `${CACHE_PREFIX}:${klass}:${hash}`;
}

/**
 * The generation-free key a snapshot lives under: `substrate:v1:<class>:<sha256(surface, args)>`.
 * No generation on purpose — a snapshot is the last good answer for these
 * arguments whatever has been written since, and it is read only when the
 * live answer is degraded.
 */
export function snapshotKey(klass: CacheClass, surface: string, args: unknown): string {
	const hash = createHash("sha256").update(canonical({ surface, args })).digest("hex");
	return `${CACHE_PREFIX}:${klass}:${hash}`;
}

/**
 * `substrate:v1:<class>:<digest>` for a caller that already holds the content hash. The embedding cache keys
 * `emb` entries by `sha256(model + "\n" + text)`, so the key says which model a vector came from.
 */
export function digestKey(klass: CacheClass, digest: string): string {
	return `${CACHE_PREFIX}:${klass}:${digest}`;
}

/** The widest embedding the `emb` class accepts, a bound on what one entry can hold. */
export const EMB_MAX_DIM = 8192;

export interface BunRedisOptions {
	gate?: PlaneGate | null | undefined;
	now?: (() => number) | undefined;
	cooldownMs?: number;
	connectTimeoutMs?: number;
	/** The deadline every command races inside the plane gate; `COMMAND_TIMEOUT_MS` by default. */
	commandTimeoutMs?: number;
}

/**
 * `run`'s answer, or an error named `TimeoutError` once `ms` has passed. Named
 * so `callPlane` observes it as a timeout, not as a generic error.
 */
function deadline<T>(run: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		const error = new Error(`cache ${what} timed out after ${ms} ms`);
		error.name = "TimeoutError";
		reject(error);
	}, ms);
	timer.unref?.();
	run.then(resolve, reject).finally(() => clearTimeout(timer));
	return promise;
}

/** Bun's client behind the three commands; exported for the socket-level tests only. */
export function bunRedis(url: string, options: BunRedisOptions = {}): CacheRedis {
	const gate = options.gate ?? null;
	const now = options.now ?? Date.now;
	const cooldownMs = options.cooldownMs ?? CACHE_CONNECT_COOLDOWN_MS;
	let client: RedisClient | null = null;
	let opening: Promise<RedisClient> | null = null;
	let cooldownUntil: number | null = null;
	const discard = (redis: RedisClient): void => {
		if (client !== redis) return;
		client = null;
		opening = null;
		try {
			redis.close();
		} catch {
			// The socket is already gone.
		}
	};

	const open = (): Promise<RedisClient> => {
		if (client?.connected) return Promise.resolve(client);
		if (opening) return opening;
		cooldownUntil = null;
		// Built on the first command. `enableOfflineQueue: false` rejects a
		// command sent before connect, so connect finishes first. A failure
		// drops this client and starts the cooldown; the next request after
		// it opens a new one. That is not a retry of the request that just failed.
		const next = new RedisClient(url, {
			connectionTimeout: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
			idleTimeout: 0,
			autoReconnect: false,
			maxRetries: 0,
			enableOfflineQueue: false,
		});
		client = next;
		const flight = next.connect().then(
			() => next,
			(cause: unknown) => {
				discard(next);
				cooldownUntil = now() + cooldownMs;
				throw cause;
			},
		);
		const settled = flight.finally(() => {
			if (opening === settled) opening = null;
		});
		opening = settled;
		return settled;
	};

	const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
	// The deadline lives inside the gated operation (Greptile round 1): a
	// connected server that stops replying used to leave the command pending
	// past the outer `attempt()` budget, so the breaker saw nothing and the
	// wedged connection was kept for the next request to time out on again. Now
	// the gate records the timeout and the connection is discarded, so the next
	// call reconnects — subject to the connect cooldown.
	//
	// The connect is part of the same gated operation (Greptile round 2). When
	// it was gated on its own, a server that accepted connections but never
	// answered commands never opened the breaker: each timeout discarded the
	// connection, and the next request's successful reconnect was a breaker
	// success that reset the count before its command timed out. Now a request
	// is one outcome — a failed connect still charges the breaker, a successful
	// one on its own never clears it — and an open breaker refuses before any
	// socket is opened, so no cooldown starts from a refusal.
	const run = <T>(op: "get" | "mget" | "set" | "incr" | "eval" | "scan" | "unlink" | "ping" | "info" | "dbsize", command: (redis: RedisClient) => Promise<T>): Promise<T> => {
		// The cooldown is checked outside the gate: a refusal is not a plane outcome.
		if (cooldownUntil !== null && now() < cooldownUntil) {
			return Promise.reject(new Error(`cache connect cooling down for ${Math.ceil((cooldownUntil - now()) / 1000)} s`));
		}
		return callPlane(gate, op, async () => {
			const redis = await open();
			try {
				return await deadline(command(redis), commandTimeoutMs, op);
			} catch (cause) {
				discard(redis);
				throw cause;
			}
		});
	};

	return {
		get: (key) => run("get", (redis) => redis.get(key)),
		mget: (keys) => run("mget", (redis) => redis.mget(...keys)),
		set: (key, value, ttlSeconds) => run("set", (redis) => redis.set(key, value, "EX", ttlSeconds).then(() => undefined)),
		incr: (key) => run("incr", (redis) => redis.incr(key)),
		// Bun spells it `eval(script, numkeys, ...keysAndArgs)`; the whole script is
		// sent each time rather than `EVALSHA`, so a flushed or restarted server
		// never answers NOSCRIPT inside the one command budget a request has.
		eval: (script, keys, args) => run("eval", (redis) => redis.eval(script, keys.length, ...keys, ...args)),
		scan: (match, count, cursor) => run("scan", (redis) => redis.scan(cursor, "MATCH", match, "COUNT", count)),
		unlink: (keys) => run("unlink", (redis) => redis.unlink(...keys)),
		// DG-1a gate probe (phase 80): PING/INFO/DBSIZE ride the same `send` path as the presence client; no second RedisClient lifecycle.
		// `PING`/`INFO`/`DBSIZE` have no typed Bun method, so they use `send` like `presence-client.ts` and `scripts/cache-stats.ts`.
		ping: () =>
			run("ping", async (redis) => {
				const reply: unknown = await redis.send("PING", []);
				if (typeof reply !== "string") throw new Error("dragonfly ping reply is not a string");
				return reply;
			}),
		info: (section) =>
			run("info", async (redis) => {
				const reply: unknown = await redis.send("INFO", [section]);
				if (typeof reply !== "string") throw new Error("dragonfly info reply is not a string");
				return reply;
			}),
		probeSet: (key, value, ttlSeconds) => run("set", (redis) => redis.set(key, value, "EX", ttlSeconds).then(() => undefined)),
		dbsize: () =>
			run("dbsize", async (redis) => {
				const reply: unknown = await redis.send("DBSIZE", []);
				if (typeof reply !== "number" || !Number.isFinite(reply)) throw new Error("dragonfly dbsize reply is not a number");
				return reply;
			}),
		cooldownUntil: () => (cooldownUntil !== null && now() < cooldownUntil ? cooldownUntil : null),
	};
}

export interface CreateCacheOptions {
	record?: (sample: CacheSample) => void;
	/** The cache's plane gate (uplift-2 R2); null runs every command unwrapped. */
	gate?: PlaneGate | null;
	/** Clock for the connect cooldown; tests move it. */
	now?: () => number;
}

export function createReadThroughCache(config: SubstrateConfig, options: CreateCacheOptions = {}): ReadThroughCache {
	const { record } = options;
	if (config.dragonflyRefused) {
		process.stderr.write(`[substrate] cache off: ${config.dragonflyRefused}\n`);
		return new ReadThroughCache({ redis: null, enabled: false, record, refusedReason: config.dragonflyRefused });
	}
	if (!config.cacheEnabled || !config.dragonflyUrl) {
		return new ReadThroughCache({ redis: null, enabled: false, record });
	}
	return new ReadThroughCache({
		redis: bunRedis(config.dragonflyUrl, {
			gate: options.gate,
			now: options.now,
			connectTimeoutMs: config.cacheConnectTimeoutMs,
			commandTimeoutMs: config.cacheCommandTimeoutMs,
		}),
		enabled: true,
		record,
		now: options.now,
		commandTimeoutMs: config.cacheCommandTimeoutMs,
		swr: { mode: config.cacheSwr, windowS: config.cacheSwrWindowS },
		gateMode: config.dragonflyGate,
	});
}

/**
 * E2 (phase 82) Lua claim-once for the shared lane: `KEYS[1]` is the claim slot, `ARGV[1]` the caller's claimId, `ARGV[2]` the slot TTL in seconds. Returns `1` when this caller won the slot (the key was absent and is now set), `0` when another caller already holds it. One round trip through the `eval` seam — no client-side race, no second client.
 */
export const SHARED_CLAIM_SCRIPT = `if redis.call("exists", KEYS[1]) == 1 then return 0 end
redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
return 1`;

/**
 * Get-or-load. Values are JSON envelopes `{ v }` so a string, `null` and a
 * broken payload are distinguishable. A command that errors is not retried.
 *
 * Identical concurrent misses share one load (uplift-4 S4): the in-flight map
 * is keyed by the final cache key, capped, and an entry is deleted the moment
 * its promise settles, whether it resolved, resolved degraded or rejected.
 * With `SUBSTRATE_CACHE_SWR=enforce` a generation-bump miss that has a
 * last-good value younger than the window is answered with it while one
 * background load refreshes the entry.
 */
export class ReadThroughCache {
	private readonly redis: CacheRedis | null;
	private readonly enabled: boolean;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly commandTimeoutMs: number;
	private readonly recordSample: ((sample: CacheSample) => void) | undefined;
	private readonly refusedReason: string | undefined;
	private readonly swrMode: CacheSwrMode;
	private readonly gateMode: DragonflyGateMode;
	private readonly swrWindowMs: number;
	private readonly maxInflight: number;
	private readonly flightMaxAgeMs: number;
	private hits = 0;
	private misses = 0;
	private bypasses = 0;
	private errors = 0;
	private coalesced = 0;
	private stale = 0;
	private wouldServeStale = 0;
	private refreshes = 0;
	private degraded = false;
	private connected = false;
	private readonly staleGenerations = new Set<string>();
	private readonly inflight = new Map<string, InFlight>();
	private refreshing = 0;
	/** Keys with a refresh whose load has not settled, a deadline-expired one included: one refresh per key is strict. */
	private readonly refreshingKeys = new Set<string>();
	private lastLogAt = Number.NEGATIVE_INFINITY;

	constructor(options: ReadThroughOptions) {
		this.redis = options.redis;
		this.enabled = options.enabled && options.redis !== null;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((line) => process.stderr.write(line));
		this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
		this.recordSample = options.record;
		this.refusedReason = options.refusedReason;
		this.swrMode = options.swr?.mode ?? "off";
		this.gateMode = options.gateMode ?? "off";
		this.swrWindowMs = swrWindowMs(options.swr?.windowS);
		this.maxInflight = Math.max(0, Math.floor(options.maxInflight ?? MAX_INFLIGHT));
		this.flightMaxAgeMs = Math.max(1, Math.floor(options.flightMaxAgeMs ?? FLIGHT_MAX_AGE_MS));
	}

	/** The gated redis client this cache reads through, or null when it is off. The reconcile pairs read the cache through it, so an open breaker reports `unavailable`. */
	redisClient(): CacheRedis | null {
		return this.redis;
	}

	/**
	 * DG-1b (phase 81): whether a read may be served from the cache at all.
	 * `off` never gates. Under `enforce` the last DG-1a verdict must be `ok`
	 * or `degraded`; anything else (including no probe yet, `unconfigured`)
	 * bypasses to the durable read. The verdict is read per call, never
	 * baked into `enabled` at construction: the first probe runs after the
	 * cache is built, so an enablement-time check would disable the cache
	 * for the process lifetime. Never throws; a missing verdict blocks.
	 *
	 * Public since E2 (phase 82): `SharedContextStore` reads it for its
	 * write-skip and claim decisions, so the store never needs a second copy
	 * of the gate rule or its own `gateMode` — the cache is the single owner.
	 */
	gateAllows(): boolean {
		if (this.gateMode !== "enforce") return true;
		const state = dragonflyGateVerdict("enforce").state;
		return state === "ok" || state === "degraded";
	}

	health(): CacheHealth {
		return {
			enabled: this.enabled,
			connected: this.connected,
			mode: this.mode(),
			hits: this.hits,
			misses: this.misses,
			bypasses: this.bypasses,
			errors: this.errors,
			coalesced: this.coalesced,
			stale: this.stale,
			wouldServeStale: this.wouldServeStale,
			refreshes: this.refreshes,
			cooldownUntil: this.redis?.cooldownUntil?.() ?? null,
			...(this.refusedReason !== undefined ? { reason: this.refusedReason } : {}),
		};
	}

	/**
	 * Return the cached value or call `load`. Generation keys are read first
	 * and embedded in the cache key. A failure of any command skips the cache.
	 */
	async getOrLoad<T>(request: {
		klass: CacheClass;
		surface: string;
		args: unknown;
		generations: readonly string[];
		load: () => Promise<T>;
		/** When the loaded value stops being true. Null uses the class TTL. */
		refreshAt?: (value: T) => number | null;
		/** False skips the write. The caller still receives `load`'s value. */
		store?: (value: T) => boolean;
		/** Stale-while-revalidate for this call (uplift-4 S4); absent means single-flight only. */
		swr?: StaleServing<T>;
		/**
		 * This caller's own budget, ms, with `onDeadline` building the answer it gives when the budget
		 * runs out (its degraded reply). A caller that joins another caller's load waits at most this
		 * long for it, however long the owner's own budget is, and then answers `onDeadline()` without
		 * starting a load of its own and without cancelling the shared one. Both must be set.
		 */
		deadlineMs?: number;
		onDeadline?: () => T;
		/** True skips the fresh-hit read, so the load always runs and its answer replaces the entry. Generations are still read and loads still coalesce; stale-while-revalidate is not served. */
		refresh?: boolean;
	}): Promise<T> {
		const klass = request.klass;
		if (!this.enabled || !this.redis) {
			this.count("bypass", klass);
			this.note("cache off");
			return request.load();
		}
		// DG-1b (phase 81): a gate that does not allow serving bypasses to the durable read. Never stale, never throws.
		if (!this.gateAllows()) {
			this.count("bypass", klass);
			this.note("dragonfly gate blocked");
			return request.load();
		}
		// A bump that did not land leaves the previous generation readable. Stay
		// on the source until a later bump advances it. A successful GET does not.
		if (request.generations.some((key) => this.staleGenerations.has(key))) {
			this.count("bypass", klass);
			this.note("generation not advanced");
			return request.load();
		}
		const redis = this.redis;
		let generation: string;
		try {
			const values = await this.attempt(() => readAll(redis, request.generations));
			generation = values.map((value) => value ?? "0").join(":");
		} catch (cause) {
			this.fail(cause, true, klass);
			return request.load();
		}

		const key = cacheKey(klass, request.surface, generation, request.args);
		let malformed = false;
		try {
			const raw = request.refresh ? null : await this.attempt(() => redis.get(key));
			if (raw !== null) {
				const parsed = parseEnvelope<T>(raw, klass);
				if (parsed.ok) {
					this.noteConnected();
					this.count("hit", klass);
					return parsed.value;
				}
				// A bad payload is not a miss: the key was there, and the caller
				// is served from the source. The fresh envelope replaces it below.
				this.count("error", klass);
				this.count("bypass", klass);
				this.note("malformed cache value");
				malformed = true;
			}
		} catch (cause) {
			this.fail(cause, true, klass);
			return request.load();
		}

		// A refresh is answered by its own load, never by a last-good value.
		const swr = request.refresh ? undefined : request.swr;
		if (!malformed) this.count("miss", klass);
		if (swr && this.swrMode === "enforce") {
			const stale = await this.staleDecision(swr);
			if (stale !== null) {
				this.count("stale", klass);
				try {
					swr.served?.(stale.ageMs);
				} catch {
					// An advertisement hook must not fail the answer it describes.
				}
				this.startRefresh(klass, key, redis, swr);
				return stale.value;
			}
		} else if (swr && this.swrMode === "shadow") {
			// Shadow takes the same decision beside the load, so it adds no serial
			// round trip; the caller is served live exactly as under `off`.
			// The probe only records a count, so it is started and never awaited: a slow
			// snapshot read must not hold a finished answer, nor the flight slot. It cannot
			// reject (`staleDecision` swallows its own failures); the catch is belt and braces.
			void this.staleDecision(swr)
				.then((stale) => {
					if (stale !== null) this.count("would_serve_stale", klass);
				})
				.catch(() => {});
		}
		return this.loadShared(klass, key, redis, request, malformed);
	}

	/**
	 * A generation-free last-good value, younger than the window and not past
	 * the deadline it names. Null for anything else, a failing read included.
	 */
	private async staleDecision<T>(swr: StaleServing<T>): Promise<{ value: T; ageMs: number } | null> {
		let good: LastGood<T> | null;
		try {
			good = await swr.lastGood();
		} catch {
			return null;
		}
		if (good === null) return null;
		const now = this.now();
		const ageMs = now - good.atMs;
		// A timestamp from the future is not evidence of freshness.
		if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= this.swrWindowMs) return null;
		if (good.untilMs !== null && (!Number.isFinite(good.untilMs) || good.untilMs <= now)) return null;
		return { value: good.value, ageMs };
	}

	/**
	 * Load once per key. A caller that finds a live load for its key waits for
	 * it. When that load was degraded (not storable) the waiter loads for itself,
	 * because "degraded" is a fact about the owner's closure, not about the key.
	 * Beyond `maxInflight` requests load independently.
	 */
	private async loadShared<T>(
		klass: CacheClass,
		key: string,
		redis: CacheRedis,
		spec: LoadSpec<T>,
		malformed: boolean,
	): Promise<T> {
		const existing = this.liveFlight(key);
		if (existing !== null) {
			this.count("coalesced", klass);
			const startedAt = this.now();
			// A waiter keeps its own deadline: the owner may have a longer budget than this caller.
			const shared = await this.withDeadline(existing.promise as Promise<Flight<T>>, spec.onDeadline !== undefined, spec.deadlineMs);
			if (shared === TIMED_OUT) return (spec.onDeadline as () => T)();
			if (shared.storable) return cloneShared(shared.value);
			// The owner's answer was degraded: load for ourselves, inside what is left of our own budget.
			const left = spec.deadlineMs === undefined ? undefined : spec.deadlineMs - (this.now() - startedAt);
			// Budget already spent: answer before the load is even started (an argument would be evaluated first).
			if (left !== undefined && left <= 0 && spec.onDeadline !== undefined) return spec.onDeadline();
			const own = await this.withDeadline(this.loadStore(klass, key, redis, spec, malformed), spec.onDeadline !== undefined, left);
			return own === TIMED_OUT ? (spec.onDeadline as () => T)() : own.value;
		}
		if (this.inflight.size >= this.maxInflight) return (await this.loadStore(klass, key, redis, spec, malformed)).value;
		return (await this.registerFlight(key, this.loadStore(klass, key, redis, spec, malformed))).value;
	}

	/**
	 * `work`, or `TIMED_OUT` once `ms` has passed, when the caller gave both a budget and an
	 * `onDeadline` to answer with. Neither a budget nor an answer: `work` unchanged. The losing
	 * side is left running (a shared load must finish for its other waiters); the timer is
	 * unref'd and cleared on every path.
	 */
	private async withDeadline<V>(work: Promise<V>, canAnswer: boolean, ms: number | undefined): Promise<V | typeof TIMED_OUT> {
		if (ms === undefined || !canAnswer) return work;
		if (ms <= 0) {
			work.catch(() => {});
			return TIMED_OUT;
		}
		const expired = Promise.withResolvers<typeof TIMED_OUT>();
		const timer = setTimeout(() => expired.resolve(TIMED_OUT), ms);
		timer.unref?.();
		try {
			return await Promise.race([work, expired.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The registered load for `key` unless it is older than `flightMaxAgeMs` (a hung loader must not capture every later caller). */
	private liveFlight(key: string): InFlight | null {
		const entry = this.inflight.get(key);
		if (entry === undefined) return null;
		return this.now() - entry.startedAt > this.flightMaxAgeMs ? null : entry;
	}

	/** Register `work` under `key`; the entry is removed when `work` settles, however it settles. */
	private registerFlight<T>(key: string, work: Promise<Flight<T>>): Promise<Flight<T>> {
		const entry: InFlight = { startedAt: this.now(), promise: work };
		entry.promise = work.finally(() => {
			if (this.inflight.get(key) === entry) this.inflight.delete(key);
		});
		this.inflight.set(key, entry);
		return entry.promise as Promise<Flight<T>>;
	}

	/**
	 * One background refresh per key, at most `MAX_REFRESHES` at once, errors
	 * swallowed and counted. The refresh's own load state comes from
	 * `swr.refresh()`, so it never touches the closure of the call it follows.
	 */
	private startRefresh<T>(klass: CacheClass, key: string, redis: CacheRedis, swr: StaleServing<T>): void {
		if (this.refreshingKeys.has(key) || this.liveFlight(key) !== null || this.inflight.size >= this.maxInflight || this.refreshing >= MAX_REFRESHES) return;
		let spec: RefreshLoad<T>;
		try {
			spec = swr.refresh();
		} catch {
			this.count("error", klass);
			return;
		}
		this.refreshing += 1;
		this.refreshingKeys.add(key);
		this.count("refresh", klass);
		// The deadline is a backstop for a loader that never settles (the brief's own
		// compose budget and the command timeouts bound the normal case). When it
		// fires the flight is released and `abort.timedOut` stops the late load from
		// writing anything, but the slot and the key stay counted until the load
		// itself settles, so neither MAX_REFRESHES nor one-refresh-per-key loosens.
		const abort: RefreshAbort = { timedOut: false };
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			abort.timedOut = true;
			expired.reject(new Error("cache refresh timed out"));
		}, this.flightMaxAgeMs);
		timer.unref?.();
		const run = this.loadStore(klass, key, redis, spec, false, spec.stored, abort);
		const work: Promise<Flight<T>> = Promise.race([run, expired.promise])
			.catch((): Flight<T> => {
				this.count("error", klass);
				return { value: undefined as T, storable: false };
			})
			.finally(() => {
				clearTimeout(timer);
			});
		void run
			.catch(() => {})
			.finally(() => {
				this.refreshing -= 1;
				this.refreshingKeys.delete(key);
			});
		void this.registerFlight(key, work);
	}

	/**
	 * Run `load`, decide whether the answer is storable and save it. `stored`
	 * runs once for a storable answer; a failure of it never fails the load.
	 */
	private async loadStore<T>(
		klass: CacheClass,
		key: string,
		redis: CacheRedis,
		spec: LoadSpec<T>,
		malformed: boolean,
		stored?: (value: T) => Promise<void> | void,
		abort?: RefreshAbort,
	): Promise<Flight<T>> {
		const value = await spec.load();
		// An incomplete source answer (a brief built while a read failed) must
		// not sit in the cache until the class TTL. The caller still gets it.
		// The GETs already landed, so Dragonfly is up even when the source is not.
		if (spec.store?.(value) === false) {
			this.noteConnected();
			return { value, storable: false };
		}
		// A refresh that outlived its deadline must not overwrite what a newer one stored.
		if (abort?.timedOut) return { value, storable: false };
		const saved = await this.persist(klass, key, redis, value, spec.refreshAt?.(value) ?? null, malformed);
		if (stored && !abort?.timedOut) {
			try {
				await stored(value);
			} catch {
				this.count("error", klass);
			}
		}
		return { value: saved, storable: true };
	}

	private async persist<T>(
		klass: CacheClass,
		key: string,
		redis: CacheRedis,
		value: T,
		refreshAt: number | null,
		malformed: boolean,
	): Promise<T> {
		let encoded: string;
		try {
			encoded = JSON.stringify({ v: value });
		} catch {
			// A value that cannot be stored is still the answer. Do not retry.
			this.count("error", klass);
			return value;
		}
		const ttl = cacheTtl(klass, refreshAt, this.now());
		if (ttl === null) return value;
		try {
			await this.attempt(() => redis.set(key, encoded, ttl));
			this.noteConnected();
		} catch (cause) {
			// The caller already has the source value, and nothing was saved.
			// A malformed value already counted its bypass; count this one only
			// when that did not happen.
			this.fail(cause, !malformed, klass);
		}
		const roundTrip = parseEnvelope<T>(encoded, klass);
		return roundTrip.ok ? roundTrip.value : value;
	}

	/**
	 * Bump a generation. A failure marks that generation stale: later reads of it
	 * bypass until a bump succeeds. Leaving the old key readable would serve the
	 * pre-write answer for the whole TTL.
	 */
	async bump(key: string): Promise<void> {
		const redis = this.redis;
		if (!this.enabled || !redis) return;
		try {
			await this.attempt(() => redis.incr(key));
			this.staleGenerations.delete(key);
			this.noteConnected();
		} catch (cause) {
			this.staleGenerations.add(key);
			this.fail(cause, false, "gen");
		}
	}

	/**
	 * The forget mark as the cross-layer reconcile reads it. A failed read throws, so the caller reports the cache as
	 * unverifiable; it never answers `absent` for a read that failed, because an absent mark means "no forget". `disabled`
	 * when the cache is off.
	 */
	async readForgetMark(): Promise<ForgetMarkRead> {
		if (!this.enabled || !this.redis) return { state: "disabled" };
		const redis = this.redis;
		let raw: string | null;
		try {
			raw = await this.attempt(() => redis.get(FORGET_MARK_KEY));
			this.noteConnected();
		} catch (cause) {
			this.fail(cause, false, "gen");
			throw cause;
		}
		if (raw === null) return { state: "absent" };
		const atMs = Number(raw);
		if (!Number.isFinite(atMs)) throw new Error("the forget mark is not a time");
		return { state: "present", atMs };
	}

	/**
	 * Record a forget: set {@link FORGET_MARK_KEY} to now, held for `ttlSeconds`. A failed write marks the key stale, the
	 * way a failed bump marks a generation: until a later write lands, no saved brief is served (`snapshotSurvivesForget`
	 * answers false), because a mark that may be set but cannot be read back is not "no forget".
	 */
	async markForget(ttlSeconds: number): Promise<void> {
		if (!this.enabled || !this.redis) return;
		const redis = this.redis;
		try {
			await this.attempt(() => redis.set(FORGET_MARK_KEY, String(this.now()), Math.max(1, Math.ceil(ttlSeconds))));
			this.staleGenerations.delete(FORGET_MARK_KEY);
			this.noteConnected();
		} catch (cause) {
			this.staleGenerations.add(FORGET_MARK_KEY);
			this.fail(cause, false, "gen");
		}
	}

	/**
	 * Whether a saved brief composed at `at` (the snapshot's own ISO timestamp) may be served: it must be strictly later
	 * than the last forget. False for a mark that cannot be checked (the read failed, the value is not a time, the last
	 * mark write failed) and for an unreadable `at`. `quiet` counts and degrades nothing, for the stale-while-revalidate
	 * probe, which is an optimisation; the degraded fallback is not quiet, like `peek`.
	 */
	async snapshotSurvivesForget(at: string, quiet: boolean): Promise<boolean> {
		if (!this.enabled || !this.redis) return false;
		const atMs = Date.parse(at);
		if (!Number.isFinite(atMs)) return false;
		if (this.staleGenerations.has(FORGET_MARK_KEY)) return false;
		const redis = this.redis;
		try {
			const raw = await this.attempt(() => redis.get(FORGET_MARK_KEY));
			if (!quiet) this.noteConnected();
			if (raw === null) return true;
			const markedMs = Number(raw);
			return Number.isFinite(markedMs) && atMs > markedMs;
		} catch (cause) {
			if (!quiet) this.fail(cause, true, "gen");
			return false;
		}
	}

	/**
	 * Read a generation-free entry (uplift-2 R1 snapshots). Null when the cache
	 * is off, the key is absent, the value fails the class shape or the command
	 * errors; the caller treats every null the same way.
	 */
	async peek<T>(klass: CacheClass, surface: string, args: unknown): Promise<T | null> {
		// Not a counted bypass: the brief this read belongs to already counted one.
		if (!this.enabled || !this.redis) return null;
		// DG-1b (phase 81): a gate that does not allow serving never serves a snapshot; the caller composes live.
		if (!this.gateAllows()) return null;
		const redis = this.redis;
		try {
			const raw = await this.attempt(() => redis.get(snapshotKey(klass, surface, args)));
			this.noteConnected();
			if (raw === null) {
				this.count("miss", klass);
				return null;
			}
			const parsed = parseEnvelope<T>(raw, klass);
			if (!parsed.ok) {
				this.count("error", klass);
				this.note("malformed cache value");
				return null;
			}
			this.count("hit", klass);
			return parsed.value;
		} catch (cause) {
			this.fail(cause, true, klass);
			return null;
		}
	}

	/**
	 * `peek` for the stale-while-revalidate probe: the same read, but nothing
	 * about it is counted (the probe is not a read the caller asked for, so it
	 * must not move the hit ratio) and a failure is silent and never marks the
	 * cache degraded: the probe is an optimisation, and the answer is the live load.
	 */
	async peekQuiet<T>(klass: CacheClass, surface: string, args: unknown): Promise<T | null> {
		if (!this.enabled || !this.redis) return null;
		// DG-1b (phase 81): as `peek`, a blocked gate never serves a snapshot.
		if (!this.gateAllows()) return null;
		const redis = this.redis;
		try {
			const raw = await this.attempt(() => redis.get(snapshotKey(klass, surface, args)));
			if (raw === null) return null;
			const parsed = parseEnvelope<T>(raw, klass);
			return parsed.ok ? parsed.value : null;
		} catch {
			return null;
		}
	}

	/**
	 * Read generation-free entries by digest in one round trip (`MGET`): one answer per digest, null for a miss, a
	 * value that fails the class shape, a failed command or a cache that is off. Counts one hit, miss or error per
	 * digest. Never throws.
	 */
	async peekMany<T>(klass: CacheClass, digests: readonly string[]): Promise<Array<T | null>> {
		const none = digests.map((): T | null => null);
		if (!this.enabled || !this.redis || digests.length === 0) return none;
		// DG-1b (phase 81): a blocked gate never serves a cached entry; callers read the durable source.
		if (!this.gateAllows()) return none;
		const redis = this.redis;
		try {
			const raws = await this.attempt(() =>
				readAll(
					redis,
					digests.map((digest) => digestKey(klass, digest)),
				),
			);
			this.noteConnected();
			return digests.map((_, index): T | null => {
				const raw = raws[index] ?? null;
				if (raw === null) {
					this.count("miss", klass);
					return null;
				}
				const parsed = parseEnvelope<T>(raw, klass);
				if (!parsed.ok) {
					this.count("error", klass);
					this.note("malformed cache value");
					return null;
				}
				this.count("hit", klass);
				return parsed.value;
			});
		} catch (cause) {
			this.fail(cause, true, klass);
			return none;
		}
	}

	/**
	 * Write one generation-free entry by digest, always with a TTL: `ttlSeconds` below 1 writes nothing. Never throws;
	 * false means nothing was stored (cache off, bad shape, failed command).
	 */
	async putEntry(klass: CacheClass, digest: string, value: unknown, ttlSeconds: number): Promise<boolean> {
		return this.writeKey(klass, digestKey(klass, digest), value, ttlSeconds < 1 ? 0 : ttlSeconds);
	}

	/**
	 * Write a generation-free entry with its own TTL. `ttlSeconds` ≤ 0 writes
	 * nothing — that is how `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=0` switches the
	 * feature off. Never throws; the caller already has its answer.
	 */
	async put(klass: CacheClass, surface: string, args: unknown, value: unknown, ttlSeconds: number): Promise<boolean> {
		return this.writeKey(klass, snapshotKey(klass, surface, args), value, ttlSeconds);
	}

	private async writeKey(klass: CacheClass, key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
		if (!this.enabled || !this.redis || ttlSeconds <= 0 || !shapeOk(klass, value)) return false;
		const redis = this.redis;
		let encoded: string;
		try {
			encoded = JSON.stringify({ v: value });
		} catch {
			this.count("error", klass);
			return false;
		}
		try {
			await this.attempt(() => redis.set(key, encoded, Math.floor(ttlSeconds)));
			this.noteConnected();
			return true;
		} catch (cause) {
			this.fail(cause, false, klass);
			return false;
		}
	}
	/**
	 * Read one E2 shared-lane entry by its exact `substrate:v1:shared:` key (`fabric/shared-context.ts` builds it). Null when the cache is off, the gate blocks serving, the key is absent or expired, the value fails the shared shape, or the command errors — every null is the same to the caller: fall back to the durable load. Unlike `peek`, a gate block counts one `bypass`: the lane's fallback read is this call, and the bypass belongs with the read that was refused. Never throws; an expired key is a miss, so a stale value is never served.
	 */
	async getShared<T>(key: string): Promise<T | null> {
		if (!this.enabled || !this.redis) {
			this.count("bypass", "shared");
			this.note("cache off");
			return null;
		}
		// DG-1b (phase 81): a gate that does not allow serving never serves a shared entry; the caller loads durably.
		if (!this.gateAllows()) {
			this.count("bypass", "shared");
			this.note("dragonfly gate blocked");
			return null;
		}
		const redis = this.redis;
		try {
			const raw = await this.attempt(() => redis.get(key));
			this.noteConnected();
			if (raw === null) {
				this.count("miss", "shared");
				return null;
			}
			const parsed = parseEnvelope<T>(raw, "shared");
			if (!parsed.ok) {
				this.count("error", "shared");
				this.count("bypass", "shared");
				this.note("malformed cache value");
				return null;
			}
			this.count("hit", "shared");
			return parsed.value;
		} catch (cause) {
			this.fail(cause, true, "shared");
			return null;
		}
	}

	/**
	 * Write one E2 shared-lane entry by its exact key with its own TTL — the per-kind TTL the store passes (`output` 60 s, `context` 300 s, `recall` 600 s). `ttlSeconds` ≤ 0 writes nothing. Never throws; the caller already has its answer. Writes are not gate-blocked (DG-1b leaves the write path for the probe): a write under a blocked gate is never read back until the gate allows.
	 */
	async putShared(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
		return this.writeKey("shared", key, value, ttlSeconds);
	}

	/**
	 * E2 (phase 82) Lua claim-once on a shared-lane slot: one `eval` round trip. `"won"` when this caller claimed the slot, `"lost"` when another caller already holds it, `"bypass"` when no command could be sent (cache off, gate blocked, no `EVAL`, or a failed/timed-out script — `script()` already counted that failure as an `error`; the store counts claim bypasses separately). Never throws. The TTL is the slot's own lifetime, at least one second.
	 */
	async claimShared(key: string, claimId: string, ttlSeconds: number): Promise<"won" | "lost" | "bypass"> {
		if (!this.enabled || !this.redis) return "bypass";
		if (!this.gateAllows()) return "bypass";
		const ttl = Math.max(1, Math.floor(ttlSeconds));
		const outcome = await this.script(SHARED_CLAIM_SCRIPT, [key], [claimId, String(ttl)]);
		if (!outcome.ok) return "bypass";
		return outcome.value === 1 ? "won" : "lost";
	}

	/**
	 * Run a script atomically (uplift-3 N3): the admission bucket's one round
	 * trip. `ok: false` is the cache off, a client without `EVAL`, or a command
	 * that failed or timed out — every one a reason the caller admits and counts
	 * a bypass, so the reason is bounded and redacted and never the answer.
	 * A failure degrades the cache like any other failed command; not a counted
	 * bypass, because no read was served from the source in its place.
	 * A breaker refusal also carries `breakerRetryAfterMs`: no command was sent.
	 */
	async script(script: string, keys: readonly string[], args: readonly string[]): Promise<ScriptOutcome> {
		if (!this.enabled || !this.redis) return { ok: false, reason: "cache off" };
		const redis = this.redis;
		const evaluate = redis.eval;
		if (!evaluate) return { ok: false, reason: "cache client has no EVAL" };
		try {
			const value = await this.attempt(() => evaluate.call(redis, script, keys, args));
			this.noteConnected();
			return { ok: true, value };
		} catch (cause) {
			this.fail(cause, false, "budget");
			const reason = redact(stripRedisUrl(cause instanceof Error ? cause.message : String(cause)));
			return cause instanceof BreakerOpenError ? { ok: false, reason, breakerRetryAfterMs: cause.retryAfterMs } : { ok: false, reason };
		}
	}

	/**
	 * Keys under `match`, read-only: a SCAN loop that stops at the end of the cursor or once `limit` keys are in hand.
	 * `truncated` is true when keys remained past the limit, so a partial list is never read as a whole one. Empty when
	 * the cache is off. A client without SCAN, or a failed command, throws: a scan that did not run must not read as clean.
	 */
	async scanKeys(match: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
		const redis = this.redis;
		// A cache that is off cannot be enumerated, so the scan is incomplete: a reconcile over it is never clean.
		if (!this.enabled || !redis) return { keys: [], truncated: true };
		const scan = redis.scan;
		if (!scan) throw new Error("cache client has no SCAN");
		const cap = Math.max(1, Math.floor(limit));
		const scanCount = 500;
		const found = new Set<string>();
		let cursor = "0";
		do {
			const [next, page] = await this.attempt(() => scan.call(redis, match, scanCount, cursor));
			cursor = next;
			for (const key of page) found.add(key);
		} while (cursor !== "0" && found.size <= cap);
		this.noteConnected();
		const keys = [...found];
		return { keys: keys.slice(0, cap), truncated: cursor !== "0" || keys.length > cap };
	}

	/**
	 * Remove keys with UNLINK in batches of at most 500 and return how many went. The only write the reconcile path makes,
	 * and only from the confirmed repair. Nothing is removed when the cache is off; a client without UNLINK throws. `onBatch`
	 * is called once after each batch with that batch's removed count, before the next batch starts, so a caller whose later
	 * batch fails still knows what the earlier ones removed.
	 */
	async unlinkKeys(keys: readonly string[], onBatch?: (removed: number) => void): Promise<number> {
		const redis = this.redis;
		if (!this.enabled || !redis) return 0;
		const unlink = redis.unlink;
		if (!unlink) throw new Error("cache client has no UNLINK");
		const batchSize = 500;
		let removed = 0;
		for (let from = 0; from < keys.length; from += batchSize) {
			const batch = keys.slice(from, from + batchSize);
			const batchRemoved = await this.attempt(() => unlink.call(redis, batch));
			removed += batchRemoved;
			onBatch?.(batchRemoved);
		}
		if (keys.length > 0) this.noteConnected();
		return removed;
	}

	private mode(): CacheMode {
		if (!this.enabled) return "off";
		return this.degraded || this.staleGenerations.size > 0 ? "degraded" : "on";
	}

	/** A live command. A stale generation stays degraded until its bump lands. */
	private noteConnected(): void {
		this.connected = true;
		if (this.staleGenerations.size === 0) this.degraded = false;
	}

	private count(result: CacheResult, klass: CacheKeyClass): void {
		if (result === "hit") this.hits += 1;
		else if (result === "miss") this.misses += 1;
		else if (result === "bypass") this.bypasses += 1;
		else if (result === "coalesced") this.coalesced += 1;
		else if (result === "stale") this.stale += 1;
		else if (result === "would_serve_stale") this.wouldServeStale += 1;
		else if (result === "refresh") this.refreshes += 1;
		else this.errors += 1;
		try {
			this.recordSample?.({ result, mode: this.mode(), cacheClass: klass });
		} catch {
			// A metric sink must not fail the read it is counting.
		}
	}

	/**
	 * Command failed. `bypass` is set when the caller was not served from a
	 * stored entry: the read missed the cache entirely, or the save was rejected.
	 * The line is redacted and emitted at most once a minute.
	 */
	private fail(cause: unknown, bypass: boolean, klass: CacheKeyClass): void {
		this.degraded = true;
		this.connected = false;
		this.count("error", klass);
		if (bypass) this.count("bypass", klass);
		this.note(cause instanceof Error ? cause.message : String(cause));
	}

	private note(reason: string): void {
		const now = this.now();
		if (now - this.lastLogAt < LOG_INTERVAL_MS) return;
		this.lastLogAt = now;
		this.log(`[substrate] cache bypass: ${redact(stripRedisUrl(reason))}\n`);
	}

	private attempt<T>(run: () => Promise<T>): Promise<T> {
		const ms = this.commandTimeoutMs;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("cache command timed out")), ms);
			timer.unref?.();
			run().then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(cause) => {
					clearTimeout(timer);
					reject(cause);
				},
			);
		});
	}
}

/** A load's outcome as the in-flight map shares it. */
interface Flight<T> {
	value: T;
	/** False when the owner's `store` refused the value (a degraded answer); waiters then load for themselves. */
	storable: boolean;
}

interface InFlight {
	startedAt: number;
	promise: Promise<Flight<unknown>>;
}

/** Set when a background refresh outlives its deadline; the late load then writes nothing. */
interface RefreshAbort {
	timedOut: boolean;
}

/** What a deadline-bound wait answers when its own timer wins. */
const TIMED_OUT = Symbol("cache wait timed out");

interface LoadSpec<T> {
	deadlineMs?: number;
	onDeadline?: () => T;
	load: () => Promise<T>;
	refreshAt?: (value: T) => number | null;
	store?: (value: T) => boolean;
}

/** Waiters on one flight each get their own copy: a caller may edit what it was given. */
function cloneShared<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

function swrWindowMs(windowS: number | undefined): number {
	const seconds = windowS !== undefined && Number.isFinite(windowS) && windowS > 0 ? windowS : DEFAULT_SWR_WINDOW_S;
	return Math.min(MAX_SWR_WINDOW_S, seconds) * 1000;
}

/**
 * Every generation key in one round trip. Bun's client has `MGET`; a fake or
 * an older client without it is read with concurrent GETs, which is the same
 * wall time on loopback and still one `attempt()` budget.
 */
function readAll(redis: CacheRedis, keys: readonly string[]): Promise<Array<string | null>> {
	if (keys.length === 0) return Promise.resolve([]);
	if (redis.mget) return redis.mget(keys);
	return Promise.all(keys.map((key) => redis.get(key)));
}

/** Drop any Redis URL before redaction. `redis://:password@host` has no user, so the password rule does not match it. */
function stripRedisUrl(text: string): string {
	return text.replace(/\b(?:redis|rediss):\/\/\S+/gi, `redis://${REDACTED}`);
}

/** Class TTL, or sooner when the value names its own deadline. Null means do not store. */
function cacheTtl(klass: CacheClass, refreshAt: number | null, now: number): number | null {
	const cap = CACHE_TTL[klass];
	if (refreshAt === null || !Number.isFinite(refreshAt)) return cap;
	const seconds = Math.floor((refreshAt - now) / 1000);
	if (seconds < 1) return null;
	return Math.min(cap, seconds);
}

function shapeOk(klass: CacheClass, value: unknown): boolean {
	if (klass === "shared") {
		// E2 shared lane: the context is text, output/recall are objects; any JSON value round-trips the envelope. A value `JSON.stringify` drops or throws can never be a served value, so it is not storable either.
		return value !== undefined && typeof value !== "function" && typeof value !== "symbol" && typeof value !== "bigint";
	}
	if (klass === "brief") return typeof value === "string";
	if (klass === "brief-snapshot") {
		if (!value || typeof value !== "object") return false;
		const snapshot = value as { text?: unknown; at?: unknown };
		return typeof snapshot.text === "string" && typeof snapshot.at === "string";
	}
	if (klass === "recall-snapshot") {
		if (!value || typeof value !== "object") return false;
		const recalled = value as { bank?: unknown; at?: unknown; hits?: unknown };
		return typeof recalled.bank === "string" && typeof recalled.at === "string" && Array.isArray(recalled.hits);
	}
	if (klass === "docs-search") {
		if (!value || typeof value !== "object") return false;
		const reply = value as { chunks?: unknown; untrusted?: unknown };
		return Array.isArray(reply.chunks) && typeof reply.untrusted === "string";
	}
	if (klass === "emb") {
		if (!value || typeof value !== "object") return false;
		const entry = value as { dim?: unknown; b64?: unknown };
		return embeddingEntryOk(entry.dim, entry.b64);
	}
	if (klass === "memory-search") {
		if (Array.isArray(value)) return true;
		if (!value || typeof value !== "object") return false;
		if ("entries" in value && Array.isArray(value.entries)) return true;
		// Recall replies cache under the same class semantics (D26-06a).
		return "results" in value && Array.isArray(value.results);
	}
	if (value === null) return true;
	if (!value || typeof value !== "object") return false;
	const graph = value as { graph_id?: unknown; nodes?: unknown };
	return typeof graph.graph_id === "string" && Array.isArray(graph.nodes);
}

/**
 * `dim` Float32 values from their base64 bytes, or null when the bytes are not that many or any value is NaN or
 * infinite: such a vector is never a usable embedding, so it must not be served from the cache.
 */
export function decodeEmbeddingBytes(dim: number, b64: string): Float32Array | null {
	const bytes = Buffer.from(b64, "base64");
	if (bytes.length !== dim * 4) return null;
	// A copy: a pooled Buffer's offset is not a multiple of four, which a Float32Array view needs.
	const vector = new Float32Array(new Uint8Array(bytes).buffer);
	for (const value of vector) {
		if (!Number.isFinite(value)) return null;
	}
	return vector;
}

/**
 * An `emb` entry is `{ dim, b64 }`: `dim` Float32 values as base64. The length of the text must be the length base64
 * gives `dim * 4` bytes, so a truncated or padded value is refused before it is decoded, and the decoded values must
 * all be finite.
 */
function embeddingEntryOk(dim: unknown, b64: unknown): boolean {
	if (typeof dim !== "number" || !Number.isInteger(dim) || dim < 1 || dim > EMB_MAX_DIM) return false;
	if (typeof b64 !== "string") return false;
	if (b64.length !== 4 * Math.ceil((dim * 4) / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
	return decodeEmbeddingBytes(dim, b64) !== null;
}

function parseEnvelope<T>(raw: string, klass: CacheClass): { ok: true; value: T } | { ok: false } {
	try {
		const parsed = JSON.parse(raw) as { v?: unknown };
		if (!parsed || typeof parsed !== "object" || !("v" in parsed)) return { ok: false };
		if (!shapeOk(klass, parsed.v)) return { ok: false };
		return { ok: true, value: parsed.v as T };
	} catch {
		return { ok: false };
	}
}
