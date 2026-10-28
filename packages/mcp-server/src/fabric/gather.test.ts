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
			lightrag: { state: "closed" },
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
		lightrag: Promise.resolve(true),
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
			configured: { dragonfly: true, "timescaledb-index": true, greptime: true, ragflow: true, lightrag: true, hindsight: true },
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
		expect(rowOf(facts, "lightrag").state).toBe("ok");
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

describe("the LightRAG row", () => {
	test("a configured LightRAG whose probe answers true is ok, read from planes.lightrag", async () => {
		const facts = await gatherFabricFacts(sources());
		expect(facts.services.lightrag).toEqual({
			configured: true,
			held: false,
			answered: true,
			breaker: "closed",
			degraded: false,
			source: "health().planes.lightrag",
		});
		expect(rowOf(facts, "lightrag")).toMatchObject({ state: "ok", endpointClass: "not-applicable", source: "health().planes.lightrag" });
	});

	test("a probe that answers false is unavailable, never a pass", async () => {
		const facts = await gatherFabricFacts(sources({ health: () => ({ ...healthyParts(), lightrag: Promise.resolve(false) }) }));
		expect(rowOf(facts, "lightrag").state).toBe("unavailable");
		expect(rowOf(facts, "ragflow").state).toBe("ok");
	});

	test("a probe that misses the deadline is unavailable with the timeout reason, and the other rows keep their state", async () => {
		const facts = await gatherFabricFacts(sources({ health: () => ({ ...healthyParts(), lightrag: never<boolean | null>() }) }), { deadlineMs: 20 });
		const row = rowOf(facts, "lightrag");
		expect(row.state).toBe("unavailable");
		expect(row.source).toBe("health().planes.lightrag: timeout");
		expect(rowOf(facts, "ragflow").state).toBe("ok");
		expect(rowOf(facts, "greptime").state).toBe("ok");
	});

	test("a probe that throws is failed, named as such", async () => {
		const facts = await gatherFabricFacts(sources({ health: () => ({ ...healthyParts(), lightrag: Promise.reject(new Error("boom")) }) }));
		expect(rowOf(facts, "lightrag")).toMatchObject({ state: "unavailable", source: "health().planes.lightrag: failed" });
	});

	test("an unconfigured LightRAG is unconfigured, and a null probe answer never makes it healthy", async () => {
		const base = sources();
		const facts = await gatherFabricFacts({
			...base,
			health: () => ({ ...healthyParts(), lightrag: Promise.resolve(null) }),
			config: { ...base.config, configured: { ...base.config.configured, lightrag: false } },
		});
		expect(rowOf(facts, "lightrag").state).toBe("unconfigured");
		expect(buildFabricStatus(facts).counts.ok).toBe(FABRIC_RESOURCES.length - 1);
	});

	test("a configured LightRAG with no probe answer (null) is unavailable, not ok", async () => {
		const facts = await gatherFabricFacts(sources({ health: () => ({ ...healthyParts(), lightrag: Promise.resolve(null) }) }));
		expect(rowOf(facts, "lightrag").state).toBe("unavailable");
	});

	test("LightRAG set and RAGFlow unset: the lightrag row is live and the ragflow row is unconfigured", async () => {
		const base = sources();
		const facts = await gatherFabricFacts({
			...base,
			health: () => ({ ...healthyParts(), ragflow: Promise.resolve(null) }),
			config: { ...base.config, configured: { ...base.config.configured, ragflow: false } },
		});
		expect(rowOf(facts, "lightrag").state).toBe("ok");
		expect(rowOf(facts, "ragflow").state).toBe("unconfigured");
	});

	test("the LightRAG breaker state appears on its row: open is unavailable, half-open is degraded, off reads off", async () => {
		const withBreaker = (breaker: FabricHealthView["breakers"]["lightrag"]) =>
			gatherFabricFacts(sources({ snapshot: () => ({ ...snapshot(), breakers: { ...snapshot().breakers, lightrag: breaker } }) }));
		const open = await withBreaker({ state: "open" });
		expect(open.services.lightrag.breaker).toBe("open");
		expect(rowOf(open, "lightrag").state).toBe("unavailable");
		const halfOpen = await withBreaker({ state: "half-open" });
		expect(halfOpen.services.lightrag.breaker).toBe("half-open");
		expect(rowOf(halfOpen, "lightrag").state).toBe("degraded");
		const off = await withBreaker(null);
		expect(off.services.lightrag.breaker).toBe("off");
		expect(rowOf(off, "lightrag").state).toBe("ok");
	});
});
