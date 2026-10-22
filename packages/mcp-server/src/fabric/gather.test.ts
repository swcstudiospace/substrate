import { describe, expect, test } from "bun:test";
import { gatherFabricFacts } from "./gather.ts";
import { buildFabricStatus } from "./status.ts";
import { FABRIC_RESOURCES, type FabricCostView, type FabricFacts, type FabricHealthParts, type FabricHealthView, type FabricSources } from "./types.ts";

const NOW = "2026-10-21T00:00:00.000Z";
const COST: FabricCostView = { status: "ok", projectedMonthlyUsd: 3, budgetUsd: 50 };

/** The synchronous view: every breaker closed, the cache answering. */
function snapshot(): FabricHealthView {
	return {
		cache: { enabled: true, connected: true, mode: "on", hits: 9, misses: 1, errors: 0, bypasses: 0 },
		eventBus: { enabled: true },
		breakers: {
			greptime: { state: "closed" },
			index: { state: "closed" },
			cache: { state: "closed" },
			hindsight: { state: "closed" },
			ragflow: { state: "closed" },
		},
	};
}

/** Every plane answers its healthy reading. */
function healthyParts(): FabricHealthParts {
	return {
		greptime: Promise.resolve({ up: true, eventsWritable: true, writeTimedOut: false, writeUnread: false }),
		index: Promise.resolve(true),
		hindsight: Promise.resolve(true),
		ragflow: Promise.resolve(true),
	};
}

/** A promise that never settles: a plane that misses every deadline. */
function never<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

function sources(overrides: Partial<FabricSources> = {}): FabricSources {
	return {
		now: () => NOW,
		health: () => healthyParts(),
		snapshot,
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

function rowOf(facts: FabricFacts, resource: string) {
	const row = buildFabricStatus(facts).resources.find((candidate) => candidate.resource === resource);
	if (row === undefined) throw new Error(`no row for ${resource}`);
	return row;
}

describe("gatherFabricFacts", () => {
	test("every plane that answers reports its real state", async () => {
		const facts = await gatherFabricFacts(sources());
		expect(facts.checkedAt).toBe(NOW);
		const status = buildFabricStatus(facts);
		expect(status.resources).toHaveLength(FABRIC_RESOURCES.length);
		expect(rowOf(facts, "greptime").state).toBe("ok");
		expect(rowOf(facts, "timescaledb-index").state).toBe("ok");
		expect(facts.railway).toEqual({ status: "ok", projectedMonthlyUsd: 3, budgetUsd: 50 });
	});

	test("a plane that never answers is unavailable with the timeout reason, and the others keep their real state", async () => {
		const facts = await gatherFabricFacts(
			sources({ health: () => ({ ...healthyParts(), index: never<boolean>() }) }),
			{ deadlineMs: 20 },
		);
		const index = rowOf(facts, "timescaledb-index");
		expect(index.state).toBe("unavailable");
		expect(index.source).toBe("health().index: timeout");
		expect(rowOf(facts, "greptime").state).toBe("ok");
		expect(rowOf(facts, "hindsight").state).toBe("ok");
		expect(rowOf(facts, "ragflow").state).toBe("ok");
		expect(rowOf(facts, "dragonfly").state).toBe("ok");
		expect(buildFabricStatus(facts).resources).toHaveLength(FABRIC_RESOURCES.length);
	});

	test("a plane that throws is failed, named as such, never a silent default", async () => {
		const facts = await gatherFabricFacts(
			sources({
				health: () => ({
					...healthyParts(),
					hindsight: Promise.reject(new Error("boom")),
				}),
			}),
		);
		expect(facts.services.hindsight.answered).toBeNull();
		expect(facts.services.hindsight.source).toBe("health().planes.hindsight: failed");
		expect(rowOf(facts, "greptime").state).toBe("ok");
	});

	test("a Greptime that never answers leaves the index and the other planes unaffected", async () => {
		const facts = await gatherFabricFacts(
			sources({ health: () => ({ ...healthyParts(), greptime: never<{ up: boolean; eventsWritable: boolean; writeTimedOut: boolean; writeUnread: boolean }>() }) }),
			{ deadlineMs: 20 },
		);
		expect(rowOf(facts, "greptime")).toMatchObject({ state: "unavailable" });
		expect(rowOf(facts, "timescaledb-index").state).toBe("ok");
	});

	test("a cost read that misses its deadline is unknown, so no cost suggestion can rest on it", async () => {
		const facts = await gatherFabricFacts(sources({ railwayCost: () => never<FabricCostView>() }), { deadlineMs: 20 });
		expect(facts.railway).toEqual({ status: "unknown", projectedMonthlyUsd: null, budgetUsd: null });
	});

	test("a dragonfly endpoint refused by policy is held, and its row is degraded", async () => {
		const base = sources();
		const facts = await gatherFabricFacts({ ...base, config: { ...base.config, dragonflyRefused: true } });
		expect(facts.services.dragonfly.held).toBe(true);
		expect(rowOf(facts, "dragonfly").state).toBe("degraded");
	});

	test("Hindsight retains parked in the outbox make Hindsight degraded", async () => {
		const facts = await gatherFabricFacts(sources({ outbox: () => ({ size: 2, oldestAt: "2026-10-20T23:00:00.000Z" }) }));
		expect(facts.services.hindsight.degraded).toBe(true);
		expect(facts.outbox).toEqual({ parked: 2, oldestAt: "2026-10-20T23:00:00.000Z" });
	});
});

describe("a stalled write on the Greptime row", () => {
	test("a write probe still waiting at its bound makes the Greptime row unavailable with the timeout reason, never ok", async () => {
		const facts = await gatherFabricFacts(
			sources({ health: () => ({ ...healthyParts(), greptime: Promise.resolve({ up: true, eventsWritable: true, writeTimedOut: true, writeUnread: false }) }) }),
		);
		const row = rowOf(facts, "greptime");
		expect(row.state).toBe("unavailable");
		expect(row.source).toBe("health().greptime: timeout");
		expect(buildFabricStatus(facts).counts.ok).toBeLessThan(FABRIC_RESOURCES.length);
	});
});
