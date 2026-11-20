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

function withCorpus(patch: Partial<FabricFacts["corpus"]>): FabricFacts {
	return healthyFacts({ corpus: { ...healthyFacts().corpus, ...patch } });
}

describe("the corpus row (phase 70)", () => {
	test("unconfigured while SUBSTRATE_CORPUS is off, whatever the readings say, and carries no detail", () => {
		const row = rowOf(withCorpus({ enabled: false, readings: { freshnessS: 10_000_000, recall5: 0, ingestDocsPerS: 0 } }), "corpus");
		expect(row).toMatchObject({ state: "unconfigured", endpointClass: "not-applicable", source: "config.corpus" });
		expect(row.detail).toBeUndefined();
	});

	test("ok with the three readings and their thresholds in the detail when every objective holds", () => {
		expect(rowOf(healthyFacts(), "corpus")).toMatchObject({
			state: "ok",
			endpointClass: "not-applicable",
			source: "corpus.slo",
			detail: {
				freshnessS: { reading: 3600, threshold: 86_400 },
				recall5: { reading: 0.9, threshold: 0.6 },
				ingestDocsPerS: { reading: 1, threshold: 0.2 },
				breaches: [],
			},
		});
	});

	test("degraded and named when a reading breaches its threshold, each objective on its own", () => {
		const stale = rowOf(withCorpus({ readings: { freshnessS: 86_401, recall5: 0.9, ingestDocsPerS: 1 } }), "corpus");
		expect(stale).toMatchObject({ state: "degraded", source: "corpus.slo: breached freshness", detail: { breaches: ["freshness"] } });
		const poor = rowOf(withCorpus({ readings: { freshnessS: 1, recall5: 0.59, ingestDocsPerS: 1 } }), "corpus");
		expect(poor).toMatchObject({ state: "degraded", source: "corpus.slo: breached recall5" });
		const slow = rowOf(withCorpus({ readings: { freshnessS: 1, recall5: 0.9, ingestDocsPerS: 0.19 } }), "corpus");
		expect(slow).toMatchObject({ state: "degraded", source: "corpus.slo: breached ingest" });
		const all = rowOf(withCorpus({ readings: { freshnessS: 999_999, recall5: 0, ingestDocsPerS: 0.01 } }), "corpus");
		expect(all.source).toBe("corpus.slo: breached freshness,recall5,ingest");
	});

	test("a reading exactly on its threshold holds, and a reading nobody has taken is not a breach", () => {
		expect(rowOf(withCorpus({ readings: { freshnessS: 86_400, recall5: 0.6, ingestDocsPerS: 0.2 } }), "corpus").state).toBe("ok");
		const unread = rowOf(withCorpus({ readings: { freshnessS: null, recall5: null, ingestDocsPerS: null } }), "corpus");
		expect(unread).toMatchObject({ state: "ok", detail: { freshnessS: { reading: null }, breaches: [] } });
	});

	test("the thresholds are the flags' values, not the defaults", () => {
		const row = rowOf(withCorpus({ thresholds: { freshnessS: 60, recall5: 0.95, ingestDocsPerS: 5 } }), "corpus");
		expect(row).toMatchObject({ state: "degraded", detail: { freshnessS: { threshold: 60 }, breaches: ["freshness", "recall5", "ingest"] } });
	});

	test("readings that could not be read in time are degraded with the reason, never ok", () => {
		expect(rowOf(withCorpus({ unread: "timeout", readings: { freshnessS: null, recall5: null, ingestDocsPerS: null } }), "corpus")).toMatchObject({
			state: "degraded",
			source: "corpus.slo: timeout",
		});
		expect(rowOf(withCorpus({ unread: "failed" }), "corpus").source).toBe("corpus.slo: failed");
	});
});

describe("buildFabricStatus", () => {
	test("reports exactly the eight resources, in report order, tei between hindsight and the proxy layer, the corpus last", () => {
		const status = buildFabricStatus(healthyFacts());
		expect(status.resources.map((row) => row.resource)).toEqual([...FABRIC_RESOURCES]);
		expect(status.resources.at(-1)?.resource).toBe("corpus");
		expect(FABRIC_RESOURCES).toHaveLength(8);
	});

	test("an unconfigured TEI is unconfigured with no detail; a configured one carries its model, dimension and latency and never a URL", () => {
		expect(rowOf(unconfiguredFacts(), "tei")).toMatchObject({ state: "unconfigured", endpointClass: "unset" });
		expect(rowOf(unconfiguredFacts(), "tei").detail).toBeUndefined();
		const row = rowOf(healthyFacts(), "tei");
		expect(row).toMatchObject({ state: "ok", endpointClass: "loopback", source: "probe().tei", detail: { model: "test-model", modelSource: "pinned", dimension: 384, latencyMs: 12 } });
		expect(JSON.stringify(row)).not.toContain("http");
	});

	test("a TEI with no pin and no embed yet still shows the model /info named, and says it was only observed", () => {
		const facts = healthyFacts({ tei: { endpointClass: "loopback", model: "seen-model", modelSource: "observed", dimension: null, latencyMs: 9 } });
		expect(rowOf(facts, "tei").detail).toEqual({ model: "seen-model", modelSource: "observed", dimension: null, latencyMs: 9 });
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
		expect(rowOf(withService("lightrag", { answered: false }), "lightrag").state).toBe("unavailable");
	});

	test("a configured LightRAG answers like its siblings: true is ok, false, null and an open breaker are not", () => {
		expect(rowOf(healthyFacts(), "lightrag").state).toBe("ok");
		expect(rowOf(withService("lightrag", { answered: false }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { answered: null }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { breaker: "open" }), "lightrag").state).toBe("unavailable");
		expect(rowOf(withService("lightrag", { breaker: "half-open" }), "lightrag").state).toBe("degraded");
	});

	test("an unconfigured LightRAG is unconfigured however it was probed, and the hindsight row is independent", () => {
		expect(rowOf(withService("lightrag", { configured: false, answered: true }), "lightrag").state).toBe("unconfigured");
		const legacy = withService("hindsight", { configured: false, answered: null, breaker: "off" });
		expect(rowOf(legacy, "hindsight").state).toBe("unconfigured");
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
