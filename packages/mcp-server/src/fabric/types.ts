/**
 * The unified resource fabric (phase 51, SOTA-07): shared types.
 *
 * Every value a report can carry is a name, an enum, a count or a fixed phrase. No URL, host, port, token or error text
 * is typed into the fabric, so none can reach a status, a suggestion or a compliance check.
 */
import type { SloBreach, SloReadings, SloThresholds } from "@substrate/corpus";
import type { DbPlane, EndpointClass } from "../db-endpoints.ts";
import type { TeiModelSource } from "../planes/tei.ts";

/** The nine resources the fabric reports, in report order. */
export const FABRIC_RESOURCES = [
	"dragonfly",
	"timescaledb-index",
	"greptime",
	"ragflow",
	"lightrag",
	"hindsight",
	"tei",
	"tailscale-proxy",
	"corpus",
] as const;
export type FabricResourceName = (typeof FABRIC_RESOURCES)[number];

/** The resources that have their own health reading. `tailscale-proxy` is derived from the endpoint classes and `corpus` from the docs plane's objectives. */
export type ServiceName = Exclude<FabricResourceName, "tailscale-proxy" | "corpus">;

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

/**
 * The embedding service's reading (phase 64): a model name, where that name came from, a dimension and a latency.
 * Never a URL or a key. `model` is the pin, else the model learned from an embed, else the last one `/info` named;
 * `modelSource` says which, and is `none` only while `model` is null.
 */
export interface FabricTeiDetail {
	model: string | null;
	modelSource: TeiModelSource;
	dimension: number | null;
	latencyMs: number | null;
}

/** One objective of the corpus row: the reading (`null` while nobody has measured it) against the threshold it is judged by (`null` when the objective is not set). */
export interface SloLine {
	reading: number | null;
	threshold: number | null;
}

/** The corpus row's detail (phase 70): the readings with their thresholds, and the objectives that are breached. Numbers and names only. */
export interface CorpusDetail {
	freshnessS: SloLine;
	recall5: SloLine;
	ingestDocsPerS: SloLine;
	syncLag: SloLine;
	breaches: SloBreach[];
}

export interface FabricResourceStatus {
	resource: FabricResourceName;
	endpointClass: FabricEndpointClass;
	state: FabricState;
	/** A fixed phrase naming where the reading came from. Never an error text. */
	source: string;
	checkedAt: string;
	/** Present on the `tei` row only when TEI is configured: the embedding client's breaker, read at the status call. Folded into `state` by {@link serviceState}; never shown as an error. */
	breaker?: BreakerReading;
	/** Present on the `tei` row (only when TEI is configured) and on the `corpus` row. */
	detail?: FabricTeiDetail | CorpusDetail;
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

/** What the corpus row judges: the three readings against the thresholds, and why the readings are missing when they could not be read in time. */
export interface CorpusSloFacts {
	/** `SUBSTRATE_CORPUS=on`. */
	enabled: boolean;
	readings: SloReadings;
	thresholds: SloThresholds;
	unread: "timeout" | "failed" | null;
}

/** What the corpus source answers with: the readings the server holds, and why the manifest read behind them failed when it did. */
export interface CorpusSourceReading {
	readings: SloReadings;
	unread: "timeout" | "failed" | null;
}

export interface FabricFacts {
	checkedAt: string;
	endpointPolicy: "warn" | "enforce";
	/** The class of each configured data plane. An unconfigured plane has no entry. */
	endpoints: Partial<Record<DbPlane, EndpointClass>>;
	services: Record<ServiceName, ServiceReading>;
	/** The embedding service: the class of `TEI_URL` (null when unset) and what the client has seen. */
	tei: { endpointClass: EndpointClass | null } & FabricTeiDetail;
	cache: { mode: "off" | "on" | "degraded"; hits: number; misses: number; errors: number; bypasses: number } | null;
	eventBusEnabled: boolean | null;
	/** The Hindsight retain outbox: retains parked for delivery. */
	outbox: { parked: number; oldestAt: string | null };
	railway: { status: CostReading; projectedMonthlyUsd: number | null; budgetUsd: number | null };
	corpus: CorpusSloFacts;
}

/** The synchronous part of the health reading: counters and breaker states that need no probe. */
export interface FabricHealthView {
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
	/** What the embedding client has seen (phase 64). */
	tei: FabricTeiDetail;
	breakers: Record<"greptime" | "index" | "cache" | "hindsight" | "ragflow" | "lightrag" | "tei", { readonly state: "closed" | "open" | "half-open" } | null>;
}

/**
 * The probes behind the health reading. Each settles on its own, so the fabric can give a plane that does not answer in
 * time its own unavailable reading while the other planes keep theirs.
 */
export interface FabricHealthParts {
	/** `up` is the ping's answer; `eventsWritable` is the ledger's write verdict; `writeTimedOut` is a write still waiting at its bound; `writeUnread` is no write verdict yet. */
	greptime: Promise<{ readonly up: boolean; readonly eventsWritable: boolean; readonly writeTimedOut: boolean; readonly writeUnread: boolean }>;
	index: Promise<boolean>;
	hindsight: Promise<boolean | null>;
	ragflow: Promise<boolean | null>;
	lightrag: Promise<boolean | null>;
	/** `null` when TEI is not configured; otherwise whether `/health` and `/info` answered and the model is the pinned one. */
	tei: Promise<boolean | null>;
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
	/** The class of `TEI_URL`; null when it is unset. */
	teiEndpoint: EndpointClass | null;
	/** The Dragonfly URL was refused by policy: the cache is off, and the boot record says why. */
	dragonflyRefused: boolean;
	/** `SUBSTRATE_CORPUS=on`. */
	corpusEnabled: boolean;
	/** The docs plane's three objectives. */
	docsSlo: SloThresholds;
}

export interface FabricSources {
	now(): string;
	/** The probes for this read. Calls in one window share them, and each settles on its own. */
	health(): FabricHealthParts;
	/** The synchronous counters and breaker states, read at the moment of the call. */
	snapshot(): FabricHealthView;
	railwayCost(): Promise<FabricCostView>;
	/**
	 * The corpus readings (phase 70). Read under the same per-source deadline as the planes; a manifest read that failed or ran out
	 * of its own, shorter bound is reported in `unread`, never swallowed.
	 */
	corpus(): Promise<CorpusSourceReading>;
	outbox(): { size: number; oldestAt: string | null };
	config: FabricConfigView;
}
