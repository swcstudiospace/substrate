import { describe, expect, test } from "bun:test";
import { healthyFacts, unconfiguredFacts } from "./fixtures.ts";
import { buildFabricCompliance } from "./compliance.ts";
import { buildFabricSuggestions } from "./optimize.ts";
import { buildFabricStatus } from "./status.ts";
import type { FabricCheck, FabricFacts, FabricSuggestion } from "./types.ts";

function report(facts: FabricFacts, suggestions?: FabricSuggestion[]) {
	const status = buildFabricStatus(facts);
	return buildFabricCompliance({ facts, status, suggestions: suggestions ?? buildFabricSuggestions(status, facts) });
}

function check(facts: FabricFacts, id: string): FabricCheck {
	const found = report(facts).checks.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no check ${id}`);
	return found;
}

describe("buildFabricCompliance", () => {
	test("enforce with a direct endpoint outside the allow list fails the private-endpoint check and names the plane", () => {
		const facts = healthyFacts({ endpointPolicy: "enforce", endpoints: { greptime: "direct", postgres: "loopback" } });
		const found = check(facts, "db-endpoints-private");
		expect(found.status).toBe("FAIL");
		expect(found.evidence).toBe("direct endpoint(s) under policy enforce: greptime");
		expect(check(facts, "db-endpoint-policy-enforce").status).toBe("PASS");
	});

	test("all endpoints behind a loopback or proxy passes the private-endpoint check", () => {
		const facts = healthyFacts({ endpoints: { greptime: "proxy", postgres: "loopback", dragonfly: "loopback" } });
		expect(check(facts, "db-endpoints-private")).toMatchObject({ status: "PASS", evidence: "3 configured endpoint(s), all loopback or proxy" });
	});

	test("warn fails the enforce check while the endpoints are private", () => {
		const facts = healthyFacts({ endpointPolicy: "warn", endpoints: { greptime: "proxy" } });
		expect(check(facts, "db-endpoint-policy-enforce").status).toBe("FAIL");
		expect(check(facts, "db-endpoints-private").status).toBe("PASS");
	});

	test("with no data-plane endpoint configured, both endpoint checks are not applicable", () => {
		const facts = healthyFacts({ endpoints: {} });
		expect(check(facts, "db-endpoints-private").status).toBe("NOT_APPLICABLE");
		expect(check(facts, "db-endpoint-policy-enforce").status).toBe("NOT_APPLICABLE");
	});

	test("a TEI URL that is neither loopback nor an allowed proxy fails the TEI endpoint check; loopback and proxy pass; unset is not applicable", () => {
		const direct = check(healthyFacts({ tei: { endpointClass: "direct", model: "m", modelSource: "pinned", dimension: 3, latencyMs: 1 } }), "tei-endpoint-private");
		expect(direct.status).toBe("FAIL");
		expect(direct.evidence).not.toContain("http");
		expect(check(healthyFacts(), "tei-endpoint-private")).toMatchObject({ status: "PASS", evidence: "tei endpoint is loopback" });
		const proxied = healthyFacts({ tei: { endpointClass: "proxy", model: "m", modelSource: "pinned", dimension: 3, latencyMs: 1 } });
		expect(check(proxied, "tei-endpoint-private").status).toBe("PASS");
		expect(check(unconfiguredFacts(), "tei-endpoint-private").status).toBe("NOT_APPLICABLE");
	});

	test("an unconfigured resource is never a pass: every resource check is not applicable", () => {
		const { checks } = report(unconfiguredFacts());
		const resourceChecks = checks.filter((candidate) => candidate.id.startsWith("resource-state."));
		expect(resourceChecks).toHaveLength(9);
		for (const candidate of resourceChecks) expect(candidate.status).toBe("NOT_APPLICABLE");
	});

	test("a degraded or unavailable resource fails its check, and an ok one passes", () => {
		const facts = healthyFacts({
			services: { ...healthyFacts().services, lightrag: { configured: true, held: false, answered: false, breaker: "closed", degraded: false, source: "health().planes.lightrag" } },
		});
		expect(check(facts, "resource-state.lightrag")).toMatchObject({ status: "FAIL", evidence: "state unavailable; source: health().planes.lightrag" });
		expect(check(facts, "resource-state.greptime").status).toBe("PASS");
	});

	test("a LightRAG that does not answer fails its check, and an unconfigured one is not applicable", () => {
		const facts = healthyFacts({
			services: { ...healthyFacts().services, lightrag: { configured: true, held: false, answered: false, breaker: "closed", degraded: false, source: "health().planes.lightrag" } },
		});
		expect(check(facts, "resource-state.lightrag")).toMatchObject({ status: "FAIL", evidence: "state unavailable; source: health().planes.lightrag" });
		const absent = healthyFacts({
			services: { ...healthyFacts().services, lightrag: { configured: false, held: false, answered: null, breaker: "off", degraded: false, source: "health().planes.lightrag" } },
		});
		expect(check(absent, "resource-state.lightrag").status).toBe("NOT_APPLICABLE");
	});

	test("every fabric tool is fail-open in the audit, so the audit check passes", () => {
		expect(check(healthyFacts(), "audit-policy-fabric-tools")).toEqual({
			id: "audit-policy-fabric-tools",
			status: "PASS",
			evidence: "3 tool(s), all fail-open",
		});
	});

	test("a clean report passes the redaction check", () => {
		expect(check(healthyFacts(), "report-redaction").status).toBe("PASS");
	});

	test("a model only observed from /info is reported and passes the redaction check, and a secret-shaped one fails it", () => {
		const observed = healthyFacts({ tei: { endpointClass: "loopback", model: "seen-model", modelSource: "observed", dimension: null, latencyMs: 9 } });
		expect(check(observed, "report-redaction").status).toBe("PASS");
		const leaky = healthyFacts({ tei: { endpointClass: "loopback", model: `sk-${"a".repeat(24)}`, modelSource: "observed", dimension: null, latencyMs: 9 } });
		expect(check(leaky, "report-redaction").status).toBe("FAIL");
	});

	test("a secret-shaped value in a report field fails the redaction check", () => {
		const facts = healthyFacts();
		const status = buildFabricStatus(facts);
		const leaky: FabricSuggestion = {
			id: "synthetic",
			resource: "greptime",
			action: "none",
			evidence: `key sk-${"a".repeat(24)}`,
			severity: "info",
		};
		const found = buildFabricCompliance({ facts, status, suggestions: [leaky] }).checks.find((candidate) => candidate.id === "report-redaction");
		expect(found?.status).toBe("FAIL");
	});

	test("the counts add up to the checks, and the report is dated by its facts", () => {
		const facts = healthyFacts();
		const compliance = report(facts);
		const total = compliance.counts.PASS + compliance.counts.FAIL + compliance.counts.NOT_APPLICABLE;
		expect(total).toBe(compliance.checks.length);
		expect(compliance.checkedAt).toBe(facts.checkedAt);
	});
});
