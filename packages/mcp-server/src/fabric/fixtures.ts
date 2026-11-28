/** Facts builders for the fabric's tests. Every value is a name, an enum or a count, as in production. */
import { SLO_DEFAULTS } from "@substrate/corpus";
import type { DragonflyReadinessVerdict, FabricFacts, ServiceName, ServiceReading } from "./types.ts";

/** A service that is configured, answers, has a closed breaker and is not degraded. */

export const CHECKED_AT = "2026-10-21T00:00:00.000Z";
/** DG-1a verdict fixtures (phase 80): the four gate states with the same metrics vocabulary the probe emits. */
export const READINESS_CHECKED_AT = "2026-11-28T00:00:00.000Z";
export function okReadiness(): DragonflyReadinessVerdict {
	return { state: "ok", reasons: [], metrics: { used_memory_bytes: 10_000_000, maxmemory_bytes: 100_000_000, headroom_ratio: 0.1, evicted_keys: 0, evicted_keys_baseline: 0 }, checkedAt: READINESS_CHECKED_AT };
}
export function degradedReadiness(): DragonflyReadinessVerdict {
	return { state: "degraded", reasons: ["memory headroom ratio at or above 0.80"], metrics: { used_memory_bytes: 90_000_000, maxmemory_bytes: 100_000_000, headroom_ratio: 0.9, evicted_keys: 0, evicted_keys_baseline: 0 }, checkedAt: READINESS_CHECKED_AT };
}
export function unavailableReadiness(): DragonflyReadinessVerdict {
	return { state: "unavailable", reasons: ["ping failed"], metrics: {}, checkedAt: READINESS_CHECKED_AT };
}
export function unconfiguredReadiness(): DragonflyReadinessVerdict {
	return { state: "unconfigured", reasons: ["dragonfly url unset"], metrics: {}, checkedAt: READINESS_CHECKED_AT };
}
export function readyService(source = "health().test"): ServiceReading {
	return { configured: true, held: false, answered: true, breaker: "closed", degraded: false, source };
}

/** A service nothing configures. */
export function absentService(): ServiceReading {
	return { configured: false, held: false, answered: null, breaker: "off", degraded: false, source: "config" };
}

export function healthyServices(): Record<ServiceName, ServiceReading> {
	return {
		dragonfly: readyService("health().cache"),
		"timescaledb-index": readyService("health().index"),
		greptime: readyService("health().greptime"),
		lightrag: readyService("health().planes.lightrag"),
		hindsight: readyService("health().planes.hindsight"),
		tei: readyService("probe().tei"),
	};
}

/** Every resource configured and answering, every data plane and the embedding service behind a proxy or loopback, the cache answering, the bus on, the corpus within its objectives. */
export function healthyFacts(overrides: Partial<FabricFacts> = {}): FabricFacts {
	return {
		checkedAt: CHECKED_AT,
		endpointPolicy: "enforce",
		endpoints: { greptime: "proxy", postgres: "loopback", dragonfly: "loopback" },
		services: healthyServices(),
		tei: { endpointClass: "loopback", model: "test-model", modelSource: "pinned", dimension: 384, latencyMs: 12 },
		cache: { mode: "on", hits: 90, misses: 10, errors: 0, bypasses: 0 },
		eventBusEnabled: true,
		outbox: { parked: 0, oldestAt: null },
		railway: { status: "ok", projectedMonthlyUsd: 3, budgetUsd: 50 },
		corpus: { enabled: true, readings: { freshnessS: 3600, recall5: 0.9, ingestDocsPerS: 1 }, thresholds: { ...SLO_DEFAULTS }, unread: null },
		...overrides,
	};
}

/** Nothing is configured: no endpoints, no services, no cache, no cost read. */
export function unconfiguredFacts(): FabricFacts {
	const services: Record<ServiceName, ServiceReading> = {
		dragonfly: absentService(),
		"timescaledb-index": absentService(),
		greptime: absentService(),
		lightrag: absentService(),
		hindsight: absentService(),
		tei: absentService(),
	};
	return {
		checkedAt: CHECKED_AT,
		endpointPolicy: "warn",
		endpoints: {},
		services,
		tei: { endpointClass: null, model: null, modelSource: "none", dimension: null, latencyMs: null },
		cache: null,
		eventBusEnabled: null,
		outbox: { parked: 0, oldestAt: null },
		railway: { status: "unconfigured", projectedMonthlyUsd: null, budgetUsd: null },
		corpus: { enabled: false, readings: { freshnessS: null, recall5: null, ingestDocsPerS: null }, thresholds: { ...SLO_DEFAULTS }, unread: null },
	};
}
