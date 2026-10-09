/**
 * Dragonfly read-through cache.
 *
 * Cache only. A missing URL, `SUBSTRATE_CACHE=0`, a refused connection or a bad
 * value all return the same answer the caller would have got with no cache.
 * Nothing here is a queue, a lock, a session or a pub/sub channel: a restart
 * drops every key, and generation counters make a write visible without a scan.
 *
 * The client is Bun's `RedisClient` (Bun 1.4). It is constructed on the first
 * command, with a 150 ms connect timeout and the same budget on every command,
 * no offline queue and no reconnect retries, so one request never waits on a
 * second attempt.
 */
import { createHash } from "node:crypto";
import { RedisClient } from "bun";
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

export function graphGenerationKey(graphId: string): string {
	return `${CACHE_PREFIX}:gen:graph:${graphId}`;
}

export interface CacheHealth {
	enabled: boolean;
	connected: boolean;
	mode: CacheMode;
	hits: number;
	misses: number;
	bypasses: number;
	errors: number;
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
}

export interface ReadThroughOptions {
	redis: CacheRedis | null;
	enabled: boolean;
	now?: () => number;
	log?: (line: string) => void;
	commandTimeoutMs?: number;
	record?: (sample: CacheSample) => void;
}

/** A request waits at most this long for one command, connect included. */
export const COMMAND_TIMEOUT_MS = 150;
export const CONNECT_TIMEOUT_MS = 150;
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

function bunRedis(url: string): CacheRedis {
	let client: RedisClient | null = null;
	const connect = (): RedisClient => {
		client ??= new RedisClient(url, {
			connectionTimeout: CONNECT_TIMEOUT_MS,
			idleTimeout: 0,
			autoReconnect: false,
			maxRetries: 0,
			enableOfflineQueue: false,
		});
		return client;
	};
	return {
		get: (key) => connect().get(key),
		set: (key, value, ttlSeconds) => connect().set(key, value, "EX", ttlSeconds).then(() => undefined),
		incr: (key) => connect().incr(key),
	};
}

export function createReadThroughCache(
	config: SubstrateConfig,
	record?: (sample: CacheSample) => void,
): ReadThroughCache {
	if (!config.cacheEnabled || !config.dragonflyUrl) {
		return new ReadThroughCache({ redis: null, enabled: false, record });
	}
	return new ReadThroughCache({ redis: bunRedis(config.dragonflyUrl), enabled: true, record });
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
	private hits = 0;
	private misses = 0;
	private bypasses = 0;
	private errors = 0;
	private degraded = false;
	private connected = false;
	private lastLogAt = Number.NEGATIVE_INFINITY;

	constructor(options: ReadThroughOptions) {
		this.redis = options.redis;
		this.enabled = options.enabled && options.redis !== null;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((line) => process.stderr.write(line));
		this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
		this.recordSample = options.record;
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
	}): Promise<T> {
		if (!this.enabled || !this.redis) {
			this.count("bypass");
			this.note("cache off");
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
				const parsed = parseEnvelope<T>(raw);
				if (parsed.ok) {
					this.connected = true;
					this.degraded = false;
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
		let encoded: string;
		try {
			encoded = JSON.stringify({ v: value });
		} catch {
			// A value that cannot be stored is still the answer. Do not retry.
			this.count("error");
			return value;
		}
		try {
			await this.attempt(() => redis.set(key, encoded, CACHE_TTL[request.klass]));
			this.connected = true;
			this.degraded = false;
		} catch (cause) {
			// The caller already has the source value. Count the error; do not
			// retry the write.
			this.fail(cause, false);
		}
		const roundTrip = parseEnvelope<T>(encoded);
		return roundTrip.ok ? roundTrip.value : value;
	}

	/** Bump a generation. A failure leaves the previous entries until their TTL. */
	async bump(key: string): Promise<void> {
		if (!this.enabled || !this.redis) return;
		try {
			await this.attempt(() => this.redis!.incr(key));
			this.connected = true;
			this.degraded = false;
		} catch (cause) {
			this.fail(cause, false);
		}
	}

	private mode(): CacheMode {
		if (!this.enabled) return "off";
		return this.degraded ? "degraded" : "on";
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
	 * Command failed. `bypass` is set when the read did not use the cache at all.
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

function parseEnvelope<T>(raw: string): { ok: true; value: T } | { ok: false } {
	try {
		const parsed = JSON.parse(raw) as { v?: T };
		if (!parsed || typeof parsed !== "object" || !("v" in parsed)) return { ok: false };
		return { ok: true, value: parsed.v as T };
	} catch {
		return { ok: false };
	}
}
