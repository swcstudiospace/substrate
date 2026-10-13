/**
 * Dragonfly read-through cache.
 *
 * Cache only. A missing URL, `SUBSTRATE_CACHE=0`, a refused connection or a bad
 * value all return the same answer the caller would have got with no cache.
 * Nothing here is a queue, a lock, a session or a pub/sub channel: a restart
 * drops every key, and generation counters make a write visible without a scan.
 *
 * The client is Bun's `RedisClient` (Bun 1.4). It is constructed on the first
 * command, with an 800 ms connect timeout and the same budget on every command,
 * no offline queue and no reconnect retries, so one request never waits on a
 * second attempt. A failed connect also starts a `CACHE_CONNECT_COOLDOWN_MS`
 * cooldown during which `open()` refuses without touching the socket, and every
 * connect and command goes through the cache's plane gate (uplift-2 R2), so a
 * dead Dragonfly costs one timeout, not one per request.
 */
import { createHash } from "node:crypto";
import { RedisClient } from "bun";
import { BreakerOpenError, callPlane, type PlaneGate } from "@substrate/observability";
import type { SubstrateConfig } from "./config.ts";
import { REDACTED, redact } from "./redact.ts";

export const CACHE_PREFIX = "substrate:v1";

/** Seconds. Brief 5 min, memory search 10 min, graph view 1 min. */
export const CACHE_TTL = {
	brief: 300,
	"memory-search": 600,
	"graph-view": 60,
} as const;

export type CacheClass = keyof typeof CACHE_TTL;
export type CacheMode = "off" | "on" | "degraded";
export type CacheResult = "hit" | "miss" | "bypass" | "error";

export const MEMORY_GENERATION_KEY = `${CACHE_PREFIX}:gen:memory`;

/** Bumped on every graph write, so a brief that lists other graphs refreshes too. */
export const GRAPHS_GENERATION_KEY = `${CACHE_PREFIX}:gen:graphs`;

export function graphGenerationKey(graphId: string): string {
	return `${CACHE_PREFIX}:gen:graph:${graphId}`;
}

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
	/** Epoch ms until which a failed connect is not retried; null when not cooling down. */
	cooldownUntil: number | null;
	/** Why the cache is off despite a URL being set — a DOCS-06 refusal. Absent otherwise. */
	reason?: string;
}

export interface CacheSample {
	result: CacheResult;
	mode: CacheMode;
}

/** The three commands the cache uses. Tests pass a fake; production uses Bun. */
export interface CacheRedis {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds: number): Promise<void>;
	incr(key: string): Promise<number>;
	/** When the client is refusing to reconnect, epoch ms; absent or null otherwise. */
	cooldownUntil?(): number | null;
}

export interface ReadThroughOptions {
	redis: CacheRedis | null;
	enabled: boolean;
	now?: () => number;
	log?: (line: string) => void;
	commandTimeoutMs?: number;
	record?: (sample: CacheSample) => void;
	/** The DOCS-06 refusal to report in health, if the cache was refused. */
	refusedReason?: string;
}

/**
 * A request waits at most this long for one command, connect included. The
 * budget clears the tailnet hop to the Railway Dragonfly (measured 180-310 ms
 * RTT) while keeping a single command well inside the 1.5 s brief budget the
 * caller aborts at.
 */
export const COMMAND_TIMEOUT_MS = 800;
export const CONNECT_TIMEOUT_MS = 800;
/**
 * After a failed connect, how long `open()` refuses before trying the socket
 * again. Without it every request during an outage paid the 800 ms connect
 * timeout; with it only the first does, and the rest bypass in microseconds.
 */
export const CACHE_CONNECT_COOLDOWN_MS = 5_000;
const LOG_INTERVAL_MS = 60_000;

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

export interface BunRedisOptions {
	gate?: PlaneGate | null;
	now?: () => number;
	cooldownMs?: number;
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
		if (cooldownUntil !== null && now() < cooldownUntil) {
			return Promise.reject(new Error(`cache connect cooling down for ${Math.ceil((cooldownUntil - now()) / 1000)} s`));
		}
		cooldownUntil = null;
		// Built on the first command. `enableOfflineQueue: false` rejects a
		// command sent before connect, so connect finishes first. A failure
		// drops this client and starts the cooldown; the next request after
		// it opens a new one. That is not a retry of the request that just failed.
		const next = new RedisClient(url, {
			connectionTimeout: CONNECT_TIMEOUT_MS,
			idleTimeout: 0,
			autoReconnect: false,
			maxRetries: 0,
			enableOfflineQueue: false,
		});
		client = next;
		const flight = callPlane(gate, "connect", () => next.connect()).then(
			() => next,
			(cause: unknown) => {
				discard(next);
				// An open breaker is already refusing; the cooldown is for the
				// case where the socket itself failed.
				if (!(cause instanceof BreakerOpenError)) cooldownUntil = now() + cooldownMs;
				throw cause;
			},
		);
		const settled = flight.finally(() => {
			if (opening === settled) opening = null;
		});
		opening = settled;
		return settled;
	};

	const run = async <T>(op: "get" | "set" | "incr", command: (redis: RedisClient) => Promise<T>): Promise<T> => {
		const redis = await open();
		try {
			return await callPlane(gate, op, () => command(redis));
		} catch (cause) {
			discard(redis);
			throw cause;
		}
	};

	return {
		get: (key) => run("get", (redis) => redis.get(key)),
		set: (key, value, ttlSeconds) => run("set", (redis) => redis.set(key, value, "EX", ttlSeconds).then(() => undefined)),
		incr: (key) => run("incr", (redis) => redis.incr(key)),
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
		redis: bunRedis(config.dragonflyUrl, { gate: options.gate, now: options.now }),
		enabled: true,
		record,
		now: options.now,
	});
}

/**
 * Get-or-load. Values are JSON envelopes `{ v }` so a string, `null` and a
 * broken payload are distinguishable. A command that errors is not retried.
 */
export class ReadThroughCache {
	private readonly redis: CacheRedis | null;
	private readonly enabled: boolean;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly commandTimeoutMs: number;
	private readonly recordSample: ((sample: CacheSample) => void) | undefined;
	private readonly refusedReason: string | undefined;
	private hits = 0;
	private misses = 0;
	private bypasses = 0;
	private errors = 0;
	private degraded = false;
	private connected = false;
	private readonly staleGenerations = new Set<string>();
	private lastLogAt = Number.NEGATIVE_INFINITY;

	constructor(options: ReadThroughOptions) {
		this.redis = options.redis;
		this.enabled = options.enabled && options.redis !== null;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((line) => process.stderr.write(line));
		this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
		this.recordSample = options.record;
		this.refusedReason = options.refusedReason;
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
	}): Promise<T> {
		if (!this.enabled || !this.redis) {
			this.count("bypass");
			this.note("cache off");
			return request.load();
		}
		// A bump that did not land leaves the previous generation readable. Stay
		// on the source until a later bump advances it. A successful GET does not.
		if (request.generations.some((key) => this.staleGenerations.has(key))) {
			this.count("bypass");
			this.note("generation not advanced");
			return request.load();
		}
		const redis = this.redis;
		let generation: string;
		try {
			const parts: string[] = [];
			for (const key of request.generations) {
				const value = await this.attempt(() => redis.get(key));
				parts.push(value ?? "0");
			}
			generation = parts.join(":");
		} catch (cause) {
			this.fail(cause, true);
			return request.load();
		}

		const key = cacheKey(request.klass, request.surface, generation, request.args);
		let malformed = false;
		try {
			const raw = await this.attempt(() => redis.get(key));
			if (raw !== null) {
				const parsed = parseEnvelope<T>(raw, request.klass);
				if (parsed.ok) {
					this.noteConnected();
					this.count("hit");
					return parsed.value;
				}
				// A bad payload is not a miss: the key was there, and the caller
				// is served from the source. The fresh envelope replaces it below.
				this.count("error");
				this.count("bypass");
				this.note("malformed cache value");
				malformed = true;
			}
		} catch (cause) {
			this.fail(cause, true);
			return request.load();
		}

		if (!malformed) this.count("miss");
		const value = await request.load();
		// An incomplete source answer (a brief built while a read failed) must
		// not sit in the cache until the class TTL. The caller still gets it.
		// The GETs already landed, so Dragonfly is up even when the source is not.
		if (request.store?.(value) === false) {
			this.noteConnected();
			return value;
		}
		let encoded: string;
		try {
			encoded = JSON.stringify({ v: value });
		} catch {
			// A value that cannot be stored is still the answer. Do not retry.
			this.count("error");
			return value;
		}
		const ttl = cacheTtl(request.klass, request.refreshAt?.(value) ?? null, this.now());
		if (ttl === null) return value;
		try {
			await this.attempt(() => redis.set(key, encoded, ttl));
			this.noteConnected();
		} catch (cause) {
			// The caller already has the source value, and nothing was saved.
			// A malformed value already counted its bypass; count this one only
			// when that did not happen.
			this.fail(cause, !malformed);
		}
		const roundTrip = parseEnvelope<T>(encoded, request.klass);
		return roundTrip.ok ? roundTrip.value : value;
	}

	/**
	 * Bump a generation. A failure marks that generation stale: later reads of it
	 * bypass until a bump succeeds. Leaving the old key readable would serve the
	 * pre-write answer for the whole TTL.
	 */
	async bump(key: string): Promise<void> {
		if (!this.enabled || !this.redis) return;
		try {
			await this.attempt(() => this.redis!.incr(key));
			this.staleGenerations.delete(key);
			this.noteConnected();
		} catch (cause) {
			this.staleGenerations.add(key);
			this.fail(cause, false);
		}
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

	private count(result: CacheResult): void {
		if (result === "hit") this.hits += 1;
		else if (result === "miss") this.misses += 1;
		else if (result === "bypass") this.bypasses += 1;
		else this.errors += 1;
		try {
			this.recordSample?.({ result, mode: this.mode() });
		} catch {
			// A metric sink must not fail the read it is counting.
		}
	}

	/**
	 * Command failed. `bypass` is set when the caller was not served from a
	 * stored entry: the read missed the cache entirely, or the save was rejected.
	 * The line is redacted and emitted at most once a minute.
	 */
	private fail(cause: unknown, bypass: boolean): void {
		this.degraded = true;
		this.connected = false;
		this.count("error");
		if (bypass) this.count("bypass");
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
	if (klass === "brief") return typeof value === "string";
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
