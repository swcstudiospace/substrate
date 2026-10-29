/**
 * The fabric compliance report (phase 51, SOTA-07). Pure: every check is PASS, FAIL or NOT_APPLICABLE, and
 * its evidence names resources, data planes, tools and counts only. No URL, host, token or error text
 * reaches a check.
 *
 * An unconfigured resource is NOT_APPLICABLE, never PASS: a check cannot pass on a thing that is not there.
 */
import { auditMode } from "@substrate/audit";
import { redact } from "../redact.ts";
import {
	DB_PLANES,
	FABRIC_TOOLS,
	RESOURCE_OF_PLANE,
	type FabricCheck,
	type FabricCheckStatus,
	type FabricCompliance,
	type FabricFacts,
	type FabricResourceStatus,
	type FabricStatus,
	type FabricSuggestion,
} from "./types.ts";
import { configuredEndpointClasses } from "./status.ts";

/** The compliance checks over the facts, the status and the suggestions the same call reports. Pure. */
export function buildFabricCompliance(input: {
	facts: FabricFacts;
	status: FabricStatus;
	suggestions: readonly FabricSuggestion[];
}): FabricCompliance {
	const { facts, status, suggestions } = input;
	const checks: FabricCheck[] = [
		endpointsPrivateCheck(facts),
		endpointPolicyCheck(facts),
		teiEndpointCheck(facts),
		auditCheck(),
		secretFreeReportCheck(status, suggestions),
		...status.resources.map(resourceCheck),
	];
	const counts: Record<FabricCheckStatus, number> = { PASS: 0, FAIL: 0, NOT_APPLICABLE: 0 };
	for (const check of checks) counts[check.status] += 1;
	return { checkedAt: facts.checkedAt, checks, counts };
}

/** Every configured data plane is loopback or proxy. A direct one is a FAIL, under either policy. */
function endpointsPrivateCheck(facts: FabricFacts): FabricCheck {
	const id = "db-endpoints-private";
	const planes = DB_PLANES.filter((plane) => facts.endpoints[plane] !== undefined);
	if (planes.length === 0) return { id, status: "NOT_APPLICABLE", evidence: "no data-plane endpoint is configured" };
	const direct = planes.filter((plane) => facts.endpoints[plane] === "direct").map((plane) => RESOURCE_OF_PLANE[plane]);
	if (direct.length > 0) {
		return { id, status: "FAIL", evidence: `direct endpoint(s) under policy ${facts.endpointPolicy}: ${direct.join(", ")}` };
	}
	return { id, status: "PASS", evidence: `${planes.length} configured endpoint(s), all loopback or proxy` };
}

/** The endpoint policy is enforce, so a direct endpoint refuses boot rather than being reported. */
function endpointPolicyCheck(facts: FabricFacts): FabricCheck {
	const id = "db-endpoint-policy-enforce";
	if (configuredEndpointClasses(facts).length === 0) {
		return { id, status: "NOT_APPLICABLE", evidence: "no data-plane endpoint is configured" };
	}
	if (facts.endpointPolicy === "enforce") {
		return { id, status: "PASS", evidence: "policy enforce: a direct endpoint refuses boot" };
	}
	return { id, status: "FAIL", evidence: "policy warn: a direct endpoint is reported at boot and still runs" };
}

/**
 * The embedding service's endpoint is loopback or an allowed proxy (phase 64). The text sent to it is document content, so a
 * TEI URL that reaches the public network is a FAIL under either policy; an unset one is not applicable, never a pass.
 */
function teiEndpointCheck(facts: FabricFacts): FabricCheck {
	const id = "tei-endpoint-private";
	const endpointClass = facts.tei.endpointClass;
	if (endpointClass === null) return { id, status: "NOT_APPLICABLE", evidence: "TEI is not configured" };
	if (endpointClass === "direct") {
		return { id, status: "FAIL", evidence: `direct endpoint under policy ${facts.endpointPolicy}: tei is neither loopback nor in the proxy allow list` };
	}
	return { id, status: "PASS", evidence: `tei endpoint is ${endpointClass}` };
}

/** Every fabric tool is a read, so each must have an explicit fail-open audit decision. */
function auditCheck(): FabricCheck {
	const id = "audit-policy-fabric-tools";
	const notOpen = FABRIC_TOOLS.filter((tool) => auditMode(tool) !== "fail-open");
	if (notOpen.length > 0) return { id, status: "FAIL", evidence: `not fail-open: ${notOpen.join(", ")}` };
	return { id, status: "PASS", evidence: `${FABRIC_TOOLS.length} tool(s), all fail-open` };
}

/**
 * The report, as serialised, is unchanged by the redaction rules: no field carries a secret-shaped value. The TEI row's
 * model name may be one `/info` merely reported (`modelSource: "observed"`), which is remote text, so it is covered too.
 */
function secretFreeReportCheck(status: FabricStatus, suggestions: readonly FabricSuggestion[]): FabricCheck {
	const id = "report-redaction";
	const report = JSON.stringify({ resources: status.resources, suggestions });
	if (redact(report) !== report) return { id, status: "FAIL", evidence: "a report field matched a redaction rule" };
	return {
		id,
		status: "PASS",
		evidence: `${status.resources.length} resource row(s) and ${suggestions.length} suggestion(s) checked; none matched a redaction rule`,
	};
}

/** One resource's state: ok passes, degraded or unavailable fails, and unconfigured is not applicable. */
function resourceCheck(row: FabricResourceStatus): FabricCheck {
	const id = `resource-state.${row.resource}`;
	if (row.state === "unconfigured") {
		return { id, status: "NOT_APPLICABLE", evidence: "not configured; reported as not applicable, never as a pass" };
	}
	if (row.state === "ok") return { id, status: "PASS", evidence: `state ok; endpoint class ${row.endpointClass}` };
	return { id, status: "FAIL", evidence: `state ${row.state}; source: ${row.source}` };
}
