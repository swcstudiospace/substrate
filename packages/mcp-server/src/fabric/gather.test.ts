import { describe, expect, test } from "bun:test";
import { gatherFabricFacts } from "./gather.ts";
import { buildFabricStatus } from "./status.ts";
import { FABRIC_RESOURCES, type FabricCostView, type FabricHealthView, type FabricSources } from "./types.ts";

const NOW = "2026-10-21T00:00:00.000Z";

function healthView(): FabricHealthView {
	const breaker = null;
	return {
		index: true,
		greptime: true,
		eventsWritable: true,
		cache: { enabled: true, connected: true, mode: "on", hits: 9, misses: 1, errors: 0, bypasses: 0 },
		eventBus: { enabled: true },
		planes: {
			greptime: { ok: true, breaker },
			index: { ok: true, breaker },
			cache: { ok: true, breaker },
			hindsight: { ok: true, breaker },
			ragflow: { ok: true, breaker },
		},
	};
}

const COST: FabricCostView = { status: "ok", projectedMonthlyUsd: 3, budgetUsd: 50 };

function sources(overrides: Partial<FabricSources> = {}): FabricSources {
	return {
		now: () => NOW,
		health: async () => healthView(),
		railwayCost: async () => COST,
		outbox: () => ({ size: 0, oldestAt: null }),
		config: {
			endpointPolicy: "enforce",
			endpointClasses: { greptime: "proxy" },
			configured: { dragonfly: true, "timescaledb-index": true, greptime: true, ragflow: true, hindsight: true },
			dragonflyRefused: false,
		},
		...overrides,
	};
}

/** A promise that never settles: a source that misses every deadline. */
function never<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

describe("gatherFabricFacts", () => {
	test("a healthy source is read into facts that the status reports as ok", async () => {
		const facts = await gatherFabricFacts(sources());
		expect(facts.checkedAt).toBe(NOW);
		const status = buildFabricStatus(facts);
		expect(status.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
		expect(facts.railway).toEqual({ status: "ok", projectedMonthlyUsd: 3, budgetUsd: 50 });
	});

	test("a health read that misses its deadline leaves its rows unavailable, and the call still returns six rows", async () => {
		const facts = await gatherFabricFacts(sources({ health: () => never<FabricHealthView>() }), { deadlineMs: 20 });
		const status = buildFabricStatus(facts);
		expect(status.resources).toHaveLength(FABRIC_RESOURCES.length);
		for (const name of ["greptime", "ragflow", "hindsight"] as const) {
			const row = status.resources.find((candidate) => candidate.resource === name);
			expect(row?.state).toBe("unavailable");
			expect(row?.source).toBe("health(): no answer in time");
		}
		expect(status.resources.find((row) => row.resource === "tailscale-proxy")?.state).toBe("ok");
	});

	test("a health read that throws is a failed read, named as such, not a silent default", async () => {
		const facts = await gatherFabricFacts(
			sources({
				health: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(facts.services.greptime.source).toBe("health(): read failed");
		expect(facts.services.greptime.answered).toBeNull();
		expect(facts.cache).toBeNull();
		expect(facts.eventBusEnabled).toBeNull();
	});

	test("a cost read that misses its deadline is unknown, so no cost suggestion can rest on it", async () => {
		const facts = await gatherFabricFacts(sources({ railwayCost: () => never<FabricCostView>() }), { deadlineMs: 20 });
		expect(facts.railway).toEqual({ status: "unknown", projectedMonthlyUsd: null, budgetUsd: null });
	});

	test("a dragonfly endpoint refused by policy is held, and its row is degraded", async () => {
		const base = sources();
		const facts = await gatherFabricFacts({ ...base, config: { ...base.config, dragonflyRefused: true, configured: { ...base.config.configured, dragonfly: true } } });
		expect(facts.services.dragonfly.held).toBe(true);
		expect(buildFabricStatus(facts).resources.find((row) => row.resource === "dragonfly")?.state).toBe("degraded");
	});

	test("the Hindsight outbox counts as the Hindsight degradation when retains are parked", async () => {
		const facts = await gatherFabricFacts(sources({ outbox: () => ({ size: 2, oldestAt: "2026-10-20T23:00:00.000Z" }) }));
		expect(facts.services.hindsight.degraded).toBe(true);
		expect(facts.outbox).toEqual({ parked: 2, oldestAt: "2026-10-20T23:00:00.000Z" });
	});
});
