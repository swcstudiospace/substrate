/**
 * Optimisation suggestions across the fabric (phase 51, SOTA-07). Pure and advisory: nothing here executes,
 * writes or changes configuration.
 *
 * Each rule fires only on its own trigger and carries the observed evidence it fired on, so a suggestion
 * with no evidence is never emitted. The output order is fixed by the rules, not by the input: attention
 * before info, then report order of the resource, then id.
 */
import { configuredEndpointClasses } from "./status.ts";
import {
	DB_PLANES,
	FABRIC_RESOURCES,
	RESOURCE_OF_PLANE,
	type FabricFacts,
	type FabricResourceStatus,
	type FabricResourceName,
	type FabricSeverity,
	type FabricStatus,
	type FabricSuggestion,
} from "./types.ts";

/** A hit ratio needs this many reads behind it before it is evidence rather than noise. */
export const CACHE_MIN_READS = 50;
/** A hit ratio below this is worth a suggestion. */
export const CACHE_LOW_HIT_RATIO = 0.5;

const RESOURCE_RANK: readonly string[] = [...FABRIC_RESOURCES, "railway"];
const SEVERITY_RANK: Readonly<Record<FabricSeverity, number>> = { attention: 0, info: 1 };

/** The suggestions the status and the facts support, in the fixed order. Pure. */
export function buildFabricSuggestions(status: FabricStatus, facts: FabricFacts): FabricSuggestion[] {
	const rows = new Map<FabricResourceName, FabricResourceStatus>(
		status.resources.map((row): [FabricResourceName, FabricResourceStatus] => [row.resource, row]),
	);
	const found: FabricSuggestion[] = [];

	for (const plane of DB_PLANES) {
		if (facts.endpoints[plane] !== "direct") continue;
		const resource = RESOURCE_OF_PLANE[plane];
		found.push({
			id: `endpoint-direct.${resource}`,
			resource,
			action: "Point the endpoint at a loopback forwarder, or list its host:port in SUBSTRATE_DB_PROXY_ALLOW.",
			evidence: `${resource} endpoint class is direct under policy ${facts.endpointPolicy}`,
			severity: "attention",
		});
	}

	const classes = configuredEndpointClasses(facts);
	if (facts.endpointPolicy === "warn" && classes.length > 0 && !classes.includes("direct")) {
		found.push({
			id: "endpoint-policy-warn",
			resource: "tailscale-proxy",
			action: "Set SUBSTRATE_DB_ENDPOINT_POLICY=enforce, so a direct endpoint refuses boot instead of being reported.",
			evidence: `policy warn; ${classes.length} configured endpoint(s), all loopback or proxy`,
			severity: "info",
		});
	}

	for (const row of status.resources) {
		if (row.state !== "unavailable") continue;
		found.push({
			id: `unavailable.${row.resource}`,
			resource: row.resource,
			action: "Check this resource's endpoint and breaker. Calls to it fail until it answers again.",
			evidence: `state unavailable; source: ${row.source}`,
			severity: "attention",
		});
	}

	const hindsight = rows.get("hindsight");
	if (hindsight?.state === "degraded" && facts.outbox.parked > 0) {
		found.push({
			id: "hindsight-outbox-backlog",
			resource: "hindsight",
			action: "Hindsight is not accepting retains, so they wait in the outbox. Check its endpoint and breaker; parked retains drain once it answers.",
			evidence: `${facts.outbox.parked} retain(s) parked, oldest parked at ${facts.outbox.oldestAt ?? "an unknown time"}`,
			severity: "attention",
		});
	}

	const greptime = rows.get("greptime");
	if (greptime?.state === "degraded") {
		found.push({
			id: "greptime-degraded",
			resource: "greptime",
			action: "The ledger answers but is not writable, or its breaker is half-open. Check the append-only mode and the write probe in /healthz.",
			evidence: `state degraded; source: ${greptime.source}`,
			severity: "attention",
		});
	}

	const dragonfly = rows.get("dragonfly");
	if (dragonfly?.state === "degraded") {
		const counters = facts.cache;
		found.push({
			id: "cache-degraded",
			resource: "dragonfly",
			action: "Reads fall through to their source while the cache is degraded or held. Check the Dragonfly endpoint, its refusal or breaker reason, and SUBSTRATE_CACHE.",
			evidence:
				counters === null
					? `state degraded; source: ${dragonfly.source}`
					: `state degraded; cache mode ${counters.mode}; ${counters.errors} error(s), ${counters.bypasses} bypass(es)`,
			severity: "attention",
		});
	}

	const cache = facts.cache;
	if (dragonfly?.state === "ok" && cache !== null && cache.hits + cache.misses >= CACHE_MIN_READS) {
		const ratio = cache.hits / (cache.hits + cache.misses);
		if (ratio < CACHE_LOW_HIT_RATIO) {
			found.push({
				id: "cache-low-hit-ratio",
				resource: "dragonfly",
				action: "Most cache reads miss. Review which reads are cacheable, and whether their TTLs are too short for the reuse they see.",
				evidence: `${cache.hits} hit(s) and ${cache.misses} miss(es); hit ratio ${(ratio * 100).toFixed(0)}%`,
				severity: "info",
			});
		}
	}

	if (dragonfly?.state === "ok" && facts.eventBusEnabled === false) {
		found.push({
			id: "pubsub-hints-off",
			resource: "dragonfly",
			action: "Turn SUBSTRATE_EVENT_BUS on if cross-process wake-up hints are wanted.",
			evidence: "dragonfly answers, and the wake-up bus is off, so no hint is published",
			severity: "info",
		});
	}

	const railway = facts.railway;
	if (railway.status === "over-budget" && railway.projectedMonthlyUsd !== null && railway.budgetUsd !== null) {
		found.push({
			id: "railway-over-budget",
			resource: "railway",
			action: "Reduce the measured usage, or review the budget in SUBSTRATE_RAILWAY_BUDGET_USD. Per-service scaling stays with railway_scale_suggest.",
			evidence: `projected ${railway.projectedMonthlyUsd.toFixed(2)} USD a month against a budget of ${railway.budgetUsd.toFixed(2)} USD`,
			severity: "attention",
		});
	}

	if (railway.status === "unpriced") {
		found.push({
			id: "railway-unpriced",
			resource: "railway",
			action: "Set the SUBSTRATE_RAILWAY_PRICE_*_USD value for each measured line that has no price.",
			evidence: "a measured line has usage and no unit price, so no monthly total is projected",
			severity: "info",
		});
	}

	return found.sort(
		(a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			RESOURCE_RANK.indexOf(a.resource) - RESOURCE_RANK.indexOf(b.resource) ||
			compareIds(a.id, b.id),
	);
}

function compareIds(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
