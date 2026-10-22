/**
 * The unified resource fabric (phase 51, SOTA-07): shared types.
 *
 * Every value a report can carry is a name, an enum, a count or a fixed phrase. No URL, host,
 * port, token or error text is typed into the fabric, so none can reach a status, a suggestion
 * or a compliance check.
 */
import type { DbPlane, EndpointClass } from "../db-endpoints.ts";

/** The six resources the fabric reports, in report order. */
export const FABRIC_RESOURCES = [
	"dragonfly",
	"timescaledb-index",
	"greptime",
	"ragflow",
	"hindsight",
	"tailscale-proxy",
] as const;
export type FabricResourceName = (typeof FABRIC_RESOURCES)[number];

/** The resources that have their own health reading. `tailscale-proxy` is derived from the endpoint classes. */
export type ServiceName = Exclude<FabricResourceName, "tailscale-proxy">;

/** The data planes that carry an endpoint class (phase 48), in the order the boot names them. */
export const DB_PLANES: readonly DbPlane[] = ["greptime", "postgres", "dragonfly"];

/** Which resource a data plane is. The index plane is the TimescaleDB index. */
export const RESOURCE_OF_PLANE: Readonly<Record<DbPlane, FabricResourceName>> = {
	greptime: "greptime",
	postgres: "timescaledb-index",
	dragonfly: "dragonfly",
};

export type FabricState = "ok" | "degraded" | "unavailable" | "unconfigured";
export type FabricEndpointClass = EndpointClass | "unset" | "not-applicable";
export type FabricSeverity = "info" | "attention";
export type BreakerReading = "closed" | "open" | "half-open" | "off";
export type CostReading = "ok" | "over-budget" | "unpriced" | "unavailable" | "unconfigured" | "unknown";

/** The MCP tools this module serves. Each one is read-only and fail-open. */
export const FABRIC_TOOLS = ["fabric_status", "fabric_optimize", "fabric_compliance"] as const;

export interface FabricResourceStatus {
	resource: FabricResourceName;
	endpointClass: FabricEndpointClass;
	state: FabricState;
	/** A fixed phrase naming where the reading came from. Never an error text. */
	source: string;
	checkedAt: string;
}

export interface FabricStatus {
	checkedAt: string;
	resources: FabricResourceStatus[];
	counts: Record<FabricState, number>;
}

/** `resource` is `railway` for a cost finding: the Railway control plane is an input to the suggestions, not a row. */
export interface FabricSuggestion {
	id: string;
	resource: FabricResourceName | "railway";
	action: string;
	evidence: string;
	severity: FabricSeverity;
}

export type FabricCheckStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";

export interface FabricCheck {
	id: string;
	status: FabricCheckStatus;
	evidence: string;
}

export interface FabricCompliance {
	checkedAt: string;
	checks: FabricCheck[];
	counts: Record<FabricCheckStatus, number>;
}

/** One service's reading, as the gather step saw it. Booleans and enums only. */
export interface ServiceReading {
	/** A URL, a store or a key is configured for it. */
	configured: boolean;
	/** Configured, but deliberately not in use: an endpoint refused by policy, or a cache switched off. */
	held: boolean;
	/** The health answer. `null` when there is none (not probed yet, or no answer in time). */
	answered: boolean | null;
	breaker: BreakerReading;
	/** The resource's own degradation signal: a cache in degraded mode, a ledger that is not writable, a Hindsight backlog. */
	degraded: boolean;
	source: string;
}

export interface FabricFacts {
	checkedAt: string;
	endpointPolicy: "warn" | "enforce";
	/** The class of each configured data plane. An unconfigured plane has no entry. */
	endpoints: Partial<Record<DbPlane, EndpointClass>>;
	services: Record<ServiceName, ServiceReading>;
	cache: { mode: "off" | "on" | "degraded"; hits: number; misses: number; errors: number; bypasses: number } | null;
	eventBusEnabled: boolean | null;
	/** The Hindsight retain outbox: retains parked for delivery. */
	outbox: { parked: number; oldestAt: string | null };
	railway: { status: CostReading; projectedMonthlyUsd: number | null; budgetUsd: number | null };
}

/** The structural view of `Substrate.health()` that the fabric reads. */
export interface FabricHealthView {
	index: boolean;
	greptime: boolean;
	eventsWritable: boolean;
	cache: {
		enabled: boolean;
		connected: boolean;
		mode: "off" | "on" | "degraded";
		hits: number;
		misses: number;
		errors: number;
		bypasses: number;
	};
	eventBus: { enabled: boolean };
	planes: Record<
		"greptime" | "index" | "cache" | "hindsight" | "ragflow",
		{ ok: boolean | null; breaker: { state: "closed" | "open" | "half-open" } | null }
	>;
}

/** The structural view of the Railway cost report that the fabric reads. */
export interface FabricCostView {
	status: CostReading;
	projectedMonthlyUsd: number | null;
	budgetUsd: number | null;
}

/** The configuration the fabric reads. Classes and presence only: no URL is in this view. */
export interface FabricConfigView {
	endpointPolicy: "warn" | "enforce";
	endpointClasses: Partial<Record<DbPlane, EndpointClass>>;
	configured: Record<ServiceName, boolean>;
	/** The Dragonfly URL was refused by policy: the cache is off, and the boot record says why. */
	dragonflyRefused: boolean;
}

export interface FabricSources {
	now(): string;
	health(): Promise<FabricHealthView>;
	railwayCost(): Promise<FabricCostView>;
	outbox(): { size: number; oldestAt: string | null };
	config: FabricConfigView;
}
