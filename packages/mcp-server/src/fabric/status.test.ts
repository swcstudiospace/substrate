import { describe, expect, test } from "bun:test";
import { healthyFacts, healthyServices, unconfiguredFacts } from "./fixtures.ts";
import { buildFabricStatus } from "./status.ts";
import { FABRIC_RESOURCES, type FabricFacts, type FabricResourceName, type FabricResourceStatus, type ServiceName } from "./types.ts";

function rowOf(facts: FabricFacts, resource: FabricResourceName): FabricResourceStatus {
	const row = buildFabricStatus(facts).resources.find((candidate) => candidate.resource === resource);
	if (row === undefined) throw new Error(`no row for ${resource}`);
	return row;
}

function withService(name: ServiceName, patch: Partial<FabricFacts["services"][ServiceName]>): FabricFacts {
	const services = healthyServices();
	services[name] = { ...services[name], ...patch };
	return healthyFacts({ services });
}

describe("buildFabricStatus", () => {
	test("reports exactly the eight resources, in report order, tei between hindsight and the proxy layer", () => {
		const status = buildFabricStatus(healthyFacts());
		expect(status.resources.map((row) => row.resource)).toEqual([...FABRIC_RESOURCES]);
	});

	test("an unconfigured TEI is unconfigured with no detail; a configured one carries its model, dimension and latency and never a URL", () => {
		expect(rowOf(unconfiguredFacts(), "tei")).toMatchObject({ state: "unconfigured", endpointClass: "unset" });
		expect(rowOf(unconfiguredFacts(), "tei").detail).toBeUndefined();
		const row = rowOf(healthyFacts(), "tei");
		expect(row).toMatchObject({ state: "ok", endpointClass: "loopback", source: "probe().tei", detail: { model: "test-model", dimension: 384, latencyMs: 12 } });
		expect(JSON.stringify(row)).not.toContain("http");
	});

	test("a configured TEI that does not answer or whose breaker is open is unavailable, a half-open one degraded", () => {
		expect(rowOf(withService("tei", { answered: false }), "tei").state).toBe("unavailable");
		expect(rowOf(withService("tei", { answered: null }), "tei").state).toBe("unavailable");
		expect(rowOf(withService("tei", { breaker: "open" }), "tei").state).toBe("unavailable");
		expect(rowOf(withService("tei", { breaker: "half-open" }), "tei").state).toBe("degraded");
	});

	test("a resource nothing configures is unconfigured and never ok", () => {
		const status = buildFabricStatus(unconfiguredFacts());
		for (const row of status.resources) expect(row.state).toBe("unconfigured");
		expect(status.counts.ok).toBe(0);
	});

	test("a configured resource that gives no true answer is unavailable, not ok", () => {
		expect(rowOf(withService("greptime", { answered: null }), "greptime").state).toBe("unavailable");
		expect(rowOf(withService("ragflow", { answered: false }), "ragflow").state).toBe("unavailable");
	});

	test("a configured LightRAG answers like its siblings: true is ok, false, null and an open breaker are not", () => {
		expect(rowOf(healthyFacts(), "lightrag").state).toBe("ok");
		expect(rowOf(withService("lightrag", { answered: false }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { answered: null }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { breaker: "open" }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { breaker: "half-open" }), "lightrag").state).toBe("degraded");
	});

	test("an unconfigured LightRAG is unconfigured however it was probed, and the ragflow row is independent", () => {
		expect(rowOf(withService("lightrag", { configured: false, answered: true }), "lightrag").state).toBe("unconfigured");
		const legacy = withService("ragflow", { configured: false, answered: null, breaker: "off" });
		expect(rowOf(legacy, "ragflow").state).toBe("unconfigured");
		expect(rowOf(legacy, "lightrag").state).toBe("ok");
	});

	test("an open breaker is unavailable even when the last answer was true", () => {
		expect(rowOf(withService("hindsight", { breaker: "open" }), "hindsight").state).toBe("unavailable");
	});

	test("a half-open breaker or the resource's own degradation is degraded", () => {
		expect(rowOf(withService("dragonfly", { breaker: "half-open" }), "dragonfly").state).toBe("degraded");
		expect(rowOf(withService("greptime", { degraded: true }), "greptime").state).toBe("degraded");
	});

	test("a configured resource held by policy is degraded, not ok", () => {
		expect(rowOf(withService("dragonfly", { held: true }), "dragonfly").state).toBe("degraded");
	});

	test("a configured, answering, closed resource with no degradation is ok", () => {
		const status = buildFabricStatus(healthyFacts());
		expect(status.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
		expect(status.counts.ok).toBe(FABRIC_RESOURCES.length);
	});

	test("every row carries the checked-at time and the source phrase of its reading", () => {
		const facts = withService("greptime", { source: "health(): no answer in time" });
		const row = rowOf(facts, "greptime");
		expect(row.checkedAt).toBe(facts.checkedAt);
		expect(row.source).toBe("health(): no answer in time");
	});

	test("the HTTP planes report not-applicable as their endpoint class", () => {
		expect(rowOf(healthyFacts(), "ragflow").endpointClass).toBe("not-applicable");
		expect(rowOf(healthyFacts(), "lightrag").endpointClass).toBe("not-applicable");
		expect(rowOf(healthyFacts(), "hindsight").endpointClass).toBe("not-applicable");
	});

	test("a data plane with no endpoint reports unset, and the proxy layer is unconfigured", () => {
		const facts = healthyFacts({ endpoints: {} });
		expect(rowOf(facts, "greptime").endpointClass).toBe("unset");
		expect(rowOf(facts, "tailscale-proxy")).toMatchObject({ state: "unconfigured", endpointClass: "unset" });
	});

	test("the Tailscale layer is ok with proxy and loopback endpoints, and reports the worst class", () => {
		expect(rowOf(healthyFacts({ endpoints: { greptime: "proxy", postgres: "loopback" } }), "tailscale-proxy")).toMatchObject({
			state: "ok",
			endpointClass: "proxy",
		});
	});

	test("a direct endpoint makes the Tailscale layer degraded and is reported as direct", () => {
		const facts = healthyFacts({ endpoints: { greptime: "proxy", dragonfly: "direct" } });
		expect(rowOf(facts, "tailscale-proxy")).toMatchObject({ state: "degraded", endpointClass: "direct" });
		expect(rowOf(facts, "dragonfly").endpointClass).toBe("direct");
	});

	test("counts add up to the eight rows", () => {
		const status = buildFabricStatus(withService("greptime", { answered: false }));
		const total = status.counts.ok + status.counts.degraded + status.counts.unavailable + status.counts.unconfigured;
		expect(total).toBe(FABRIC_RESOURCES.length);
		expect(status.counts.unavailable).toBe(1);
	});
});
