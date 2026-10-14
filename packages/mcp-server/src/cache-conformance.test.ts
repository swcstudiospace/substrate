/**
 * Cache key-class and Redis command conformance.
 *
 * Static cases read `cache.ts` and `docs/data-planes.md` and need no server.
 * Live cases run only when `SUBSTRATE_CONFORMANCE_REDIS_URL` is a loopback URL
 * (`conformance-loopback`). A Dragonfly URL, when set, must be loopback too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CACHE_CLASSES, CACHE_PREFIX, MEMORY_GENERATION_KEY, bunRedis, cacheKey, classOf, snapshotKey, type CacheClass } from "./cache.ts";

const EXPECTED_CLASSES = ["brief", "memory-search", "graph-view", "brief-snapshot", "recall-snapshot", "docs-search", "budget", "gen"] as const;

const FORBIDDEN_CLASSES = ["idempotency", "idem", "mirror"];

const REDIS_OPS = '"get" | "mget" | "set" | "incr" | "eval"';

const DOCS_SENTENCE = "An idempotency mirror stays a target, not a current key";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Host of a redis URL, or a `conformance-loopback` error that omits any password. */
function loopbackHost(raw: string, which: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`conformance-loopback: ${which} is not a parseable loopback URL`);
	}
	const host = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`conformance-loopback: ${which} host ${host || "(empty)"} is not loopback`);
	}
	return host;
}

interface LiveShape {
	get: string | null;
	mget: Array<string | null>;
	incr: number;
	eval: unknown;
}

async function exercise(url: string, suffix: string): Promise<LiveShape> {
	const key = `${CACHE_PREFIX}:conformance:${suffix}`;
	const missing = `${CACHE_PREFIX}:conformance:missing:${suffix}`;
	const counter = `${CACHE_PREFIX}:conformance:counter:${suffix}`;
	expect(classOf(key)).toBeNull();
	expect(classOf(missing)).toBeNull();
	expect(classOf(counter)).toBeNull();

	const redis = bunRedis(url);
	const value = `conformance-${suffix}`;
	await redis.set(key, value, 30);
	const got = await redis.get(key);
	expect(got).toBe(value);
	const many = await redis.mget?.([key, missing]);
	expect(many).toEqual([value, null]);
	await redis.set(counter, "0", 30);
	const stepped = await redis.incr(counter);
	expect(stepped).toBe(1);
	const echoed = await redis.eval?.("return ARGV[1]", [key], ["conformance-eval"]);
	expect(echoed).toBe("conformance-eval");
	return { get: got, mget: many ?? [], incr: stepped, eval: echoed };
}

describe("cache conformance", () => {
	test("closed key classes exclude an idempotency mirror", () => {
		expect([...CACHE_CLASSES]).toEqual([...EXPECTED_CLASSES]);
		expect(CACHE_PREFIX).toBe("substrate:v1");
		for (const forbidden of FORBIDDEN_CLASSES) {
			expect(CACHE_CLASSES as readonly string[]).not.toContain(forbidden);
		}
		expect(classOf(`${CACHE_PREFIX}:idempotency:abc`)).toBeNull();
		expect(classOf(`${CACHE_PREFIX}:mirror:abc`)).toBeNull();

		const builders: CacheClass[] = ["brief", "memory-search", "graph-view", "brief-snapshot", "recall-snapshot", "docs-search"];
		for (const klass of builders) {
			const keyed = cacheKey(klass, "conformance", "1", { n: 1 });
			const snapped = snapshotKey(klass, "conformance", { n: 1 });
			expect(keyed.startsWith(`${CACHE_PREFIX}:${klass}:`)).toBe(true);
			expect(snapped.startsWith(`${CACHE_PREFIX}:${klass}:`)).toBe(true);
			expect(classOf(keyed)).toBe(klass);
			expect(classOf(snapped)).toBe(klass);
		}
		expect(classOf(`${CACHE_PREFIX}:budget:surface:read`)).toBe("budget");
		expect(classOf(`${CACHE_PREFIX}:gen:memory`)).toBe("gen");
		expect(MEMORY_GENERATION_KEY).toBe(`${CACHE_PREFIX}:gen:memory`);
		expect(classOf(MEMORY_GENERATION_KEY)).toBe("gen");
	});

	test("admission does not carry an idempotency payload key", () => {
		const admission = readFileSync(fileURLToPath(new URL("./admission.ts", import.meta.url)), "utf8");
		expect(admission).not.toContain("idempotency_key");
		expect(admission).not.toContain("_ik");
	});

	test("bunRedis commands are get, mget, set, incr, and eval", () => {
		const source = readFileSync(fileURLToPath(new URL("./cache.ts", import.meta.url)), "utf8");
		expect(source).toContain(REDIS_OPS);
		const code = stripComments(source);
		expect(code).toContain(REDIS_OPS);
		for (const call of ["evalsha", "publish", "subscribe", "blpop"]) {
			expect(code.toLowerCase()).not.toContain(call);
		}
		expect(code).not.toContain(`${CACHE_PREFIX}:idempotency`);
		expect(code).not.toContain(`${CACHE_PREFIX}:mirror`);
		expect(code).not.toMatch(/["'`]idempotency:/);
		expect(code).not.toMatch(/["'`]mirror:/);
	});

	test("docs keep the idempotency mirror as a target, not a current key", () => {
		const docs = readFileSync(fileURLToPath(new URL("../../../docs/data-planes.md", import.meta.url)), "utf8");
		expect(docs).toContain(DOCS_SENTENCE);
	});

	const redisUrl = process.env.SUBSTRATE_CONFORMANCE_REDIS_URL;
	const dragonflyUrl = process.env.SUBSTRATE_CONFORMANCE_DRAGONFLY_URL;

	if (!redisUrl) {
		test.skip("live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)", () => {});
	} else {
		test("live loopback redis matches the command set", async () => {
			loopbackHost(redisUrl, "SUBSTRATE_CONFORMANCE_REDIS_URL");
			if (dragonflyUrl) loopbackHost(dragonflyUrl, "SUBSTRATE_CONFORMANCE_DRAGONFLY_URL");
			const suffix = randomBytes(8).toString("hex");
			const redis = await exercise(redisUrl, `redis-${suffix}`);
			if (!dragonflyUrl) return;
			const dragonfly = await exercise(dragonflyUrl, `dragonfly-${suffix}`);
			expect(typeof redis.get).toBe(typeof dragonfly.get);
			expect(redis.get).toBe(`conformance-redis-${suffix}`);
			expect(dragonfly.get).toBe(`conformance-dragonfly-${suffix}`);
			expect(redis.eval).toBe(dragonfly.eval);
			expect(typeof redis.incr).toBe("number");
			expect(typeof dragonfly.incr).toBe("number");
			expect(redis.mget).toHaveLength(dragonfly.mget.length);
		});
	}
});
