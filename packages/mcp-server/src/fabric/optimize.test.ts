import { describe, expect, test } from "bun:test";
import { healthyFacts, healthyServices } from "./fixtures.ts";
import { buildFabricSuggestions, CACHE_MIN_READS } from "./optimize.ts";
import { buildFabricStatus } from "./status.ts";
import type { FabricFacts, ServiceName } from "./types.ts";

function suggest(facts: FabricFacts) {
	return buildFabricSuggestions(buildFabricStatus(facts), facts);
}

function ids(facts: FabricFacts): string[] {
	return suggest(facts).map((suggestion) => suggestion.id);
}

function withService(name: ServiceName, patch: Partial<FabricFacts["services"][ServiceName]>): FabricFacts {
	const services = healthyServices();
	services[name] = { ...services[name], ...patch };
	return healthyFacts({ services });
}

function absentFacts(): FabricFacts {
	const absent = { configured: false, held: false, answered: null, breaker: "off" as const, degraded: false, source: "config" };
	return healthyFacts({
		endpoints: {},
		services: {
			dragonfly: absent,
			"timescaledb-index": absent,
			greptime: absent,
			ragflow: absent,
			hindsight: absent,
		},
		cache: null,
		eventBusEnabled: null,
		railway: { status: "unconfigured", projectedMonthlyUsd: null, budgetUsd: null },
	});
}

describe("buildFabricSuggestions", () => {
	test("a healthy fabric emits no suggestion", () => {
		expect(suggest(healthyFacts())).toEqual([]);
	});

	test("nothing configured emits nothing, because no rule has evidence", () => {
		expect(suggest(absentFacts())).toEqual([]);
	});

	test("the same facts give the same suggestions in the same order", () => {
		const facts = healthyFacts({
			endpoints: { greptime: "direct", postgres: "direct", dragonfly: "proxy" },
			eventBusEnabled: false,
			railway: { status: "over-budget", projectedMonthlyUsd: 80, budgetUsd: 50 },
		});
		expect(suggest(facts)).toEqual(suggest(facts));
	});

	test("order is attention before info, then report order of the resource, then id", () => {
		const facts = healthyFacts({
			endpoints: { greptime: "direct", postgres: "direct", dragonfly: "loopback" },
			eventBusEnabled: false,
			railway: { status: "over-budget", projectedMonthlyUsd: 80, budgetUsd: 50 },
		});
		expect(ids(facts)).toEqual([
			"endpoint-direct.timescaledb-index",
			"endpoint-direct.greptime",
			"railway-over-budget",
			"pubsub-hints-off",
		]);
	});

	test("a direct endpoint is named by its resource and is an attention item", () => {
		const suggestions = suggest(healthyFacts({ endpoints: { greptime: "direct", postgres: "loopback", dragonfly: "loopback" } }));
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({ id: "endpoint-direct.greptime", resource: "greptime", severity: "attention" });
	});

	test("the enforce suggestion fires under warn when every endpoint is private, and not when one is direct", () => {
		const warnPrivate = healthyFacts({ endpointPolicy: "warn", endpoints: { greptime: "proxy", postgres: "loopback" } });
		expect(ids(warnPrivate)).toContain("endpoint-policy-warn");
		const warnDirect = healthyFacts({ endpointPolicy: "warn", endpoints: { greptime: "direct" } });
		expect(ids(warnDirect)).not.toContain("endpoint-policy-warn");
		expect(ids(healthyFacts({ endpointPolicy: "enforce", endpoints: { greptime: "proxy" } }))).not.toContain("endpoint-policy-warn");
	});

	test("an unavailable resource is named with the source of its reading", () => {
		const found = suggest(withService("ragflow", { answered: false, source: "health().planes.ragflow" })).find(
			(suggestion) => suggestion.id === "unavailable.ragflow",
		);
		expect(found).toMatchObject({ resource: "ragflow", severity: "attention" });
		expect(found?.evidence).toBe("state unavailable; source: health().planes.ragflow");
	});

	test("the Hindsight backlog fires only when Hindsight is degraded and retains are parked", () => {
		const degradedHindsight = { ...healthyServices(), hindsight: { ...healthyServices().hindsight, degraded: true } };
		const backlog = healthyFacts({ services: degradedHindsight, outbox: { parked: 3, oldestAt: "2026-10-20T23:00:00.000Z" } });
		const found = suggest(backlog).find((suggestion) => suggestion.id === "hindsight-outbox-backlog");
		expect(found?.evidence).toBe("3 retain(s) parked, oldest parked at 2026-10-20T23:00:00.000Z");

		expect(ids(healthyFacts({ services: degradedHindsight }))).not.toContain("hindsight-outbox-backlog");
		expect(ids(healthyFacts({ outbox: { parked: 3, oldestAt: null } }))).not.toContain("hindsight-outbox-backlog");
	});

	test("the cache hit-ratio suggestion needs enough reads and a low ratio", () => {
		const low = healthyFacts({ cache: { mode: "on", hits: 10, misses: CACHE_MIN_READS - 10, errors: 0, bypasses: 0 } });
		expect(suggest(low).find((suggestion) => suggestion.id === "cache-low-hit-ratio")?.evidence).toBe(
			`10 hit(s) and ${CACHE_MIN_READS - 10} miss(es); hit ratio 20%`,
		);

		const tooFew = healthyFacts({ cache: { mode: "on", hits: 10, misses: CACHE_MIN_READS - 11, errors: 0, bypasses: 0 } });
		expect(ids(tooFew)).not.toContain("cache-low-hit-ratio");

		const good = healthyFacts({ cache: { mode: "on", hits: 40, misses: 10, errors: 0, bypasses: 0 } });
		expect(ids(good)).not.toContain("cache-low-hit-ratio");
	});

	test("a degraded cache is named with its counters when they are known", () => {
		const degraded = healthyFacts({
			services: { ...healthyServices(), dragonfly: { ...healthyServices().dragonfly, degraded: true } },
			cache: { mode: "degraded", hits: 5, misses: 5, errors: 4, bypasses: 2 },
		});
		const found = suggest(degraded).find((suggestion) => suggestion.id === "cache-degraded");
		expect(found?.evidence).toBe("state degraded; cache mode degraded; 4 error(s), 2 bypass(es)");
	});

	test("the wake-up bus suggestion fires only when the cache answers and the bus is off", () => {
		expect(ids(healthyFacts({ eventBusEnabled: false }))).toContain("pubsub-hints-off");
		expect(ids(healthyFacts({ eventBusEnabled: true }))).not.toContain("pubsub-hints-off");
		const cacheDown = withService("dragonfly", { answered: false });
		expect(ids({ ...cacheDown, eventBusEnabled: false })).not.toContain("pubsub-hints-off");
	});

	test("an over-budget projection is named with both figures", () => {
		const over = healthyFacts({ railway: { status: "over-budget", projectedMonthlyUsd: 62.5, budgetUsd: 50 } });
		expect(suggest(over).find((suggestion) => suggestion.id === "railway-over-budget")?.evidence).toBe(
			"projected 62.50 USD a month against a budget of 50.00 USD",
		);
	});

	test("an unknown cost read is silent, and an unpriced cost line is an info suggestion", () => {
		expect(ids(healthyFacts({ railway: { status: "unknown", projectedMonthlyUsd: null, budgetUsd: null } }))).toEqual([]);
		const unpriced = healthyFacts({ railway: { status: "unpriced", projectedMonthlyUsd: null, budgetUsd: 50 } });
		expect(suggest(unpriced)).toEqual([expect.objectContaining({ id: "railway-unpriced", resource: "railway", severity: "info" })]);
	});
});
