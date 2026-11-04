/**
 * Aggregate status across the nine fabric resources (phase 51, SOTA-07; the embedding service joined in phase 64 and the corpus in phase 70). Pure: it reads a facts object and
 * returns rows, so it is testable without a service, a socket or a clock.
 *
 * State rules, applied in this order for a service row:
 *   1. not configured                        -> unconfigured (never ok)
 *   2. configured but held by policy         -> degraded
 *   3. breaker open, or no true answer       -> unavailable
 *   4. breaker half-open, or own degradation -> degraded
 *   5. otherwise                             -> ok
 *
 * The tailscale-proxy row reads only the phase-48 endpoint classes: unconfigured when no data-plane
 * endpoint is set, degraded when any endpoint is direct, ok otherwise. No network probe backs it.
 *
 * The corpus row (phase 70) judges the docs plane's objectives, the sync lag only once it has a threshold, and reads nothing but the facts: unconfigured when
 * `SUBSTRATE_CORPUS` is off, degraded when a reading breaches its threshold or the readings could not be read in time,
 * ok otherwise. A reading nobody has taken yet is not a breach, so a corpus that has not ingested or been evaluated is ok.
 */
import { sloBreaches } from "@substrate/corpus";
import type { EndpointClass } from "../db-endpoints.ts";
import {
	DB_PLANES,
	type CorpusDetail,
	type FabricFacts,
	type FabricResourceStatus,
	type FabricState,
	type FabricStatus,
	type ServiceName,
	type ServiceReading,
} from "./types.ts";

/** The state of one service row. Pure. */
export function serviceState(reading: ServiceReading): FabricState {
	if (!reading.configured) return "unconfigured";
	if (reading.held) return "degraded";
	if (reading.breaker === "open" || reading.answered !== true) return "unavailable";
	if (reading.breaker === "half-open" || reading.degraded) return "degraded";
	return "ok";
}

/** The endpoint classes of the configured data planes, in boot order. */
export function configuredEndpointClasses(facts: FabricFacts): EndpointClass[] {
	const classes: EndpointClass[] = [];
	for (const plane of DB_PLANES) {
		const endpointClass = facts.endpoints[plane];
		if (endpointClass !== undefined) classes.push(endpointClass);
	}
	return classes;
}

/** The Tailscale layer: the phase-48 endpoint classes, worst first. Pure. */
export function proxyRow(facts: FabricFacts): FabricResourceStatus {
	const classes = configuredEndpointClasses(facts);
	if (classes.length === 0) {
		return {
			resource: "tailscale-proxy",
			endpointClass: "unset",
			state: "unconfigured",
			source: "config.dbEndpoints",
			checkedAt: facts.checkedAt,
		};
	}
	const direct = classes.includes("direct");
	const endpointClass: EndpointClass = direct ? "direct" : classes.includes("proxy") ? "proxy" : "loopback";
	return {
		resource: "tailscale-proxy",
		endpointClass,
		state: direct ? "degraded" : "ok",
		source: "config.dbEndpoints",
		checkedAt: facts.checkedAt,
	};
}

/** The docs plane's objectives as one row. Pure. */
export function corpusRow(facts: FabricFacts): FabricResourceStatus {
	const { enabled, readings, thresholds, unread } = facts.corpus;
	const base = { resource: "corpus", endpointClass: "not-applicable", checkedAt: facts.checkedAt } as const;
	if (!enabled) return { ...base, state: "unconfigured", source: "config.corpus" };
	const breaches = sloBreaches(readings, thresholds);
	const detail: CorpusDetail = {
		freshnessS: { reading: readings.freshnessS, threshold: thresholds.freshnessS },
		recall5: { reading: readings.recall5, threshold: thresholds.recall5 },
		ingestDocsPerS: { reading: readings.ingestDocsPerS, threshold: thresholds.ingestDocsPerS },
		syncLag: { reading: readings.syncLagS ?? null, threshold: thresholds.syncLagS ?? null },
		breaches,
	};
	if (unread !== null) return { ...base, state: "degraded", source: `corpus.slo: ${unread}`, detail };
	if (breaches.length > 0) return { ...base, state: "degraded", source: `corpus.slo: breached ${breaches.join(",")}`, detail };
	return { ...base, state: "ok", source: "corpus.slo", detail };
}

/** The eight rows in report order, with per-state counts. Pure. */
export function buildFabricStatus(facts: FabricFacts): FabricStatus {
	const at = facts.checkedAt;
	const resources: FabricResourceStatus[] = [
		serviceRow("dragonfly", facts.endpoints.dragonfly ?? "unset", facts.services.dragonfly, at),
		serviceRow("timescaledb-index", facts.endpoints.postgres ?? "unset", facts.services["timescaledb-index"], at),
		serviceRow("greptime", facts.endpoints.greptime ?? "unset", facts.services.greptime, at),
		serviceRow("ragflow", "not-applicable", facts.services.ragflow, at),
		serviceRow("lightrag", "not-applicable", facts.services.lightrag, at),
		serviceRow("hindsight", "not-applicable", facts.services.hindsight, at),
		teiRow(facts, at),
		proxyRow(facts),
		corpusRow(facts),
	];
	const counts: FabricStatus["counts"] = { ok: 0, degraded: 0, unavailable: 0, unconfigured: 0 };
	for (const row of resources) counts[row.state] += 1;
	return { checkedAt: at, resources, counts };
}

/** The embedding service's row: its class is `TEI_URL`'s; a configured one carries its breaker, and the model, its source, the dimension and the latency the client saw. */
function teiRow(facts: FabricFacts, checkedAt: string): FabricResourceStatus {
	const row = serviceRow("tei", facts.tei.endpointClass ?? "unset", facts.services.tei, checkedAt);
	if (!facts.services.tei.configured) return row;
	const { model, modelSource, dimension, latencyMs } = facts.tei;
	return { ...row, breaker: facts.services.tei.breaker, detail: { model, modelSource, dimension, latencyMs } };
}

function serviceRow(
	resource: ServiceName,
	endpointClass: FabricResourceStatus["endpointClass"],
	reading: ServiceReading,
	checkedAt: string,
): FabricResourceStatus {
	return { resource, endpointClass, state: serviceState(reading), source: reading.source, checkedAt };
}
