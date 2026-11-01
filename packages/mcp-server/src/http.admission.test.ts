/**
 * Admission budgets over a real socket (uplift-3 N3).
 *
 * Same harness shape as `http.test.ts`, with a `ReadThroughCache` over the fake
 * budget redis from `admission.test.ts` so the bucket is real and the clock is
 * the test's. What is pinned is what a caller sees: the order of 401 and 429,
 * the 429's header and body, that a refused request did nothing, that `shadow`
 * refuses nothing, that an MCP batch pays per member, that a dead cache admits,
 * and that the monitor routes are never metered.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { BreakerOpenError, METRIC, findCounter, sumCounter } from "@substrate/observability";
import { FakeBudgetRedis } from "./admission.test.ts";
import { ReadThroughCache } from "./cache.ts";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

interface Harness {
	base: string;
	observability: Observability;
	redis: FakeBudgetRedis;
	clock: { now: number };
	close(): void;
}

const running: Harness[] = [];

async function start(env: Record<string, string | undefined> = {}, stores: Partial<{ greptime: unknown }> = {}): Promise<Harness> {
	const config: SubstrateConfig = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const redis = new FakeBudgetRedis();
	const clock = { now: 1_700_000_000_000 };
	const substrate = new Substrate(
		config,
		{ index: null, greptime: null, cache: new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => clock.now }), ...stores } as ConstructorParameters<
			typeof Substrate
		>[1],
		observability.observer,
	);
	const server = createHttpServer(substrate, config, observability, { now: () => clock.now });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		redis,
		clock,
		close() {
			if (closed) return;
			closed = true;
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

afterAll(() => {
	for (const harness of running) harness.close();
});

function decisions(harness: Harness, where: Record<string, string>): number {
	const counter = findCounter(harness.observability.snapshot(), METRIC.admissionDecisions);
	return counter ? sumCounter(counter, where) : 0;
}

function ledger() {
	const written: Array<{ surface: string; kind: string }> = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: { surface: string; kind: string }) => {
				written.push(event);
			},
		},
	};
}

const ENFORCE = { SUBSTRATE_BUDGETS: "enforce", SUBSTRATE_TOKEN_CURSOR: "tok-cursor", SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" };
const JSON_BODY = { "content-type": "application/json" };
const CURSOR = { ...JSON_BODY, authorization: "Bearer tok-cursor" };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function toolCall(id: number, name: string, args: unknown = {}) {
	return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("precedence", () => {
	test("a missing or unknown bearer is 401 before any bucket is consulted, even an empty one", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_RPS: "1", SUBSTRATE_BUDGET_READ_BURST: "1" });
		const untokened = await fetch(`${harness.base}/brief`, { method: "POST", headers: JSON_BODY, body: "{}" });
		expect(untokened.status).toBe(401);
		expect(harness.redis.calls).toEqual([]);

		expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(429);
		const unknown = await fetch(`${harness.base}/brief`, { method: "POST", headers: { ...JSON_BODY, authorization: "Bearer tok-nobody" }, body: "{}" });
		expect(unknown.status).toBe(401);
		expect(harness.redis.calls).toHaveLength(2);
	});
});

describe("enforce", () => {
	test("refuses the (burst + 1)th write with 429, an integer Retry-After and the bounded body, stores nothing, and admits after the wait", async () => {
		const { written, greptime } = ledger();
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_WRITE_RPS: "1", SUBSTRATE_BUDGET_WRITE_BURST: "2" }, { greptime });
		const post = () =>
			fetch(`${harness.base}/events`, { method: "POST", headers: CURSOR, body: JSON.stringify({ kind: "note", summary: "budgeted" }) });

		expect((await post()).status).toBe(202);
		expect((await post()).status).toBe(202);
		const refused = await post();
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("1");
		expect(refused.headers.get("content-type")).toBe("application/json");
		expect(await refused.json()).toEqual({ error: "budget", class: "write", retry_after_s: 1 });
		expect(written).toHaveLength(2);
		expect(decisions(harness, { surface: "cursor", class: "write", decision: "limited" })).toBe(1);
		expect(decisions(harness, { surface: "cursor", class: "write", decision: "allowed" })).toBe(2);
		// The refusal is counted, not audited: no tool-call record for it.
		const audit = findCounter(harness.observability.snapshot(), METRIC.toolCalls);
		expect(audit ? sumCounter(audit, { tool: "events" }) : 0).toBe(2);

		harness.clock.now += 1_000;
		expect((await post()).status).toBe(202);
		expect(written).toHaveLength(3);
	});

	test("the bucket key carries a TTL of the burst's refill time", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_RPS: "2", SUBSTRATE_BUDGET_READ_BURST: "10" });
		await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" });
		expect(harness.redis.buckets.get("substrate:v1:budget:cursor:read")?.ttlMs).toBe(5_000);
	});

	test("untokened bridge callers share the anonymous bucket whatever surface the body names; a tokened surface has its own", async () => {
		const { written, greptime } = ledger();
		const harness = await start(
			{ ...ENFORCE, SUBSTRATE_ALLOW_ANONYMOUS: "1", SUBSTRATE_BUDGET_ANONYMOUS_RPS: "1", SUBSTRATE_BUDGET_ANONYMOUS_BURST: "1" },
			{ greptime },
		);
		const post = (headers: Record<string, string>, surface: string) =>
			fetch(`${harness.base}/events`, { method: "POST", headers: { ...JSON_BODY, ...headers }, body: JSON.stringify({ kind: "note", summary: "anon", surface }) });

		expect((await post({}, "hermes")).status).toBe(202);
		expect((await post({}, "omp")).status).toBe(429);
		expect((await post({ authorization: "Bearer tok-grok" }, "grok-bot")).status).toBe(202);
		expect(written.map((event) => event.surface)).toEqual(["hermes", "grok-bot"]);
		expect(decisions(harness, { surface: "anonymous", decision: "limited" })).toBe(1);
		expect(decisions(harness, { surface: "omp" })).toBe(0);
		expect([...harness.redis.buckets.keys()]).toEqual(["substrate:v1:budget:anonymous:write", "substrate:v1:budget:grok-bot:write"]);
	});

	test("a per-surface override applies to that surface alone", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_GROK_BOT_READ_RPS: "1", SUBSTRATE_BUDGET_GROK_BOT_READ_BURST: "1" });
		const brief = (token: string) => fetch(`${harness.base}/brief`, { method: "POST", headers: { ...JSON_BODY, authorization: `Bearer ${token}` }, body: "{}" });
		expect((await brief("tok-grok")).status).toBe(200);
		expect((await brief("tok-grok")).status).toBe(429);
		expect((await brief("tok-cursor")).status).toBe(200);
		expect((await brief("tok-cursor")).status).toBe(200);
	});
});

describe("shadow (the default)", () => {
	test("never refuses and counts shadow_limited for what enforce would have refused", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_CURSOR: "tok-cursor", SUBSTRATE_BUDGET_READ_RPS: "1", SUBSTRATE_BUDGET_READ_BURST: "1" });
		for (let index = 0; index < 3; index += 1) {
			expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		}
		expect(decisions(harness, { surface: "cursor", class: "read", decision: "allowed" })).toBe(1);
		expect(decisions(harness, { surface: "cursor", class: "read", decision: "shadow_limited" })).toBe(2);
		expect(decisions(harness, { decision: "limited" })).toBe(0);

		const slo = (await (await fetch(`${harness.base}/slo`, { headers: CURSOR })).json()) as { admission: { id: string; status: string; samples: number } };
		expect(slo.admission).toMatchObject({ id: "admission.limited_rate", status: "insufficient-data", samples: 3 });
	});

	test("off runs no script at all", async () => {
		const harness = await start({ SUBSTRATE_BUDGETS: "off", SUBSTRATE_TOKEN_CURSOR: "tok-cursor" });
		expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		expect(harness.redis.calls).toEqual([]);
		expect(findCounter(harness.observability.snapshot(), METRIC.admissionDecisions)?.points ?? []).toEqual([]);
	});
});

describe("MCP batches", () => {
	test("a batch costs one token per tool call and an over-budget batch is one 429 with a JSON-RPC error per member and no member run", async () => {
		const { written, greptime } = ledger();
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_WRITE_RPS: "1", SUBSTRATE_BUDGET_WRITE_BURST: "3" }, { greptime });
		const emit = (id: number) => toolCall(id, "events_emit", { kind: "note", summary: `batch ${id}` });
		const post = (body: unknown) => fetch(`${harness.base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...CURSOR }, body: JSON.stringify(body) });

		const refused = await post([emit(1), emit(2), emit(3), emit(4)]);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("1");
		const errors = (await refused.json()) as Array<{ id: number; error: { code: number; data: unknown } }>;
		expect(errors.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
		expect(errors.every((entry) => entry.error.code === -32000)).toBe(true);
		expect(errors[0]?.error.data).toEqual({ error: "budget", class: "write", retry_after_s: 1 });
		expect(written).toEqual([]);
		expect(decisions(harness, { surface: "cursor", class: "write", decision: "limited" })).toBe(1);
		// Refused before the audit: nothing was recorded as a tool call.
		expect(findCounter(harness.observability.snapshot(), METRIC.toolCalls)?.points ?? []).toEqual([]);

		// A batch the bucket can hold is admitted and debited whole: the fourth token is gone.
		const admitted = await post([emit(1), emit(2), emit(3)]);
		expect(admitted.status).not.toBe(429);
		expect(harness.redis.buckets.get("substrate:v1:budget:cursor:write")?.state.tokens).toBe(0);
		const single = await post(emit(5));
		expect(single.status).toBe(429);
		expect(await single.json()).toMatchObject({ jsonrpc: "2.0", id: 5, error: { data: { error: "budget", class: "write" } } });
	});

	test("a request with no tool call — tools/list — is not metered", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_BURST: "1" });
		await fetch(`${harness.base}/mcp`, {
			method: "POST",
			headers: { ...MCP_HEADERS, ...CURSOR },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(harness.redis.calls).toEqual([]);
	});
});

describe("when the cache cannot answer", () => {
	test("every decision is a bypass and nothing is refused, in enforce", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_RPS: "1", SUBSTRATE_BUDGET_READ_BURST: "1" });
		harness.redis.fail = "connect ECONNREFUSED redis://default:s3cret@db.internal:6379";
		for (let index = 0; index < 3; index += 1) {
			expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		}
		expect(decisions(harness, { surface: "cursor", class: "read", decision: "bypass" })).toBe(3);
		expect(decisions(harness, { decision: "limited" })).toBe(0);
		// The SLO does not count a bypass as a decision.
		const slo = (await (await fetch(`${harness.base}/slo`, { headers: CURSOR })).json()) as { admission: { samples: number } };
		expect(slo.admission.samples).toBe(0);
	});

	test("a harness with no cache at all admits everything as a bypass", async () => {
		const config = loadConfig(ENFORCE);
		const observability = createObservability(config, ENFORCE);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: null } as ConstructorParameters<typeof Substrate>[1], observability.observer);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			expect((await fetch(`http://127.0.0.1:${port}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
			expect(sumCounter(defined(findCounter(observability.snapshot(), METRIC.admissionDecisions)), { decision: "bypass" })).toBe(1);
		} finally {
			observability.stop();
			server.close();
		}
	});

	test("an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one", async () => {
		const open = await start(ENFORCE);
		open.redis.refusal = new BreakerOpenError("cache", 2_000);
		expect((await fetch(`${open.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		expect(decisions(open, { decision: "bypass" })).toBe(1);

		const closed = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_BREAKER: "fail-closed" });
		closed.redis.refusal = new BreakerOpenError("cache", 2_000);
		const refused = await fetch(`${closed.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" });
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe("2");
		expect(await refused.json()).toEqual({ error: "cache_unavailable", class: "read", retry_after_s: 2 });
		expect(decisions(closed, { decision: "refused" })).toBe(1);
	});
});

describe("what is never metered", () => {
	test("/healthz, /metrics and /slo cost nothing even when the read bucket is empty", async () => {
		const harness = await start({ ...ENFORCE, SUBSTRATE_BUDGET_READ_RPS: "1", SUBSTRATE_BUDGET_READ_BURST: "1" });
		expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(200);
		expect((await fetch(`${harness.base}/brief`, { method: "POST", headers: CURSOR, body: "{}" })).status).toBe(429);
		for (const route of ["/healthz", "/metrics", "/slo", "/healthz"]) {
			expect((await fetch(`${harness.base}${route}`, { headers: CURSOR })).status).not.toBe(429);
		}
		expect(harness.redis.calls).toHaveLength(2);
		expect(decisions(harness, { surface: "cursor" })).toBe(2);
	});
});
