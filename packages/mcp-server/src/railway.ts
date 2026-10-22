import type { DocsBackend, RailwayConfig } from "./config.ts";

/** Single source of truth lives in `config.ts`; re-exported so planes keep one import. */
export type { DocsBackend } from "./config.ts";
/** Backward default: existing hosts serve the RAGFlow plane until opted in. */
export const DEFAULT_DOCS_BACKEND: DocsBackend = "ragflow";

/** Canonical planning-graph shapes live in `types.ts`; re-exported for fabric callers. */
export type { PlanningGraphHint, PlanningGraphRelation } from "./types.ts";
import type { PlanningGraphHint } from "./types.ts";

/** The LightRAG image this Railway project hosts, next to RAGFlow. */
export const LIGHTRAG_DOCKER_IMAGE = "ghcr.io/hkuds/lightrag:latest";
/** LightRAG's HTTP port inside its container. */
export const LIGHTRAG_DEFAULT_PORT = 9621;
/** Service name used for Railway private DNS when none is pinned. */
export const LIGHTRAG_DEFAULT_SERVICE_NAME = "lightrag";

/** The fetch surface the health probe needs: injectable for rehearsal fakes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Count every entity named across hints (additive; duplicates count once). */
export function planningNodeCount(hints: readonly PlanningGraphHint[] | undefined): number {
	if (hints === undefined || hints.length === 0) return 0;
	const seen = new Set<string>();
	for (const hint of hints) {
		for (const entity of hint.entities) seen.add(entity);
	}
	return seen.size;
}

/**
 * LightRAG hosting states on Railway (SPE-19385). One service, one state:
 * - `PROVISIONING`: the deploy is still rolling out (or was just requested).
 * - `RUNNING`: the health endpoint answers 2xx.
 * - `DEGRADED`: configured but the health endpoint is non-2xx, or health was
 *   never probed and nothing proves the service is up.
 * - `UNAVAILABLE`: Railway (or the LightRAG service) is not configured, or
 *   the health endpoint is unreachable.
 */
export const LIGHTRAG_HOSTING_STATES = ["PROVISIONING", "RUNNING", "DEGRADED", "UNAVAILABLE"] as const;
export type LightragHostingState = (typeof LIGHTRAG_HOSTING_STATES)[number];

/** Liveness path on the LightRAG server, polled by `monitor`/`lightragHosting`. */
export const LIGHTRAG_HEALTH_PATH = "/health";

/**
 * Map probe facts onto one hosting state. Pure (no I/O) so the fabric can
 * reuse it without another network call.
 */
export function resolveLightragHostingState(input: { configured: boolean; healthy?: boolean; provisioning?: boolean }): LightragHostingState {
	if (input.provisioning === true) return "PROVISIONING";
	if (!input.configured) return "UNAVAILABLE";
	if (input.healthy === true) return "RUNNING";
	if (input.healthy === false) return "DEGRADED";
	return "DEGRADED";
}

/** One compliance finding. `advisory` findings never flip `compliant`. */
export interface RailwayComplianceCheck {
	id: string;
	passed: boolean;
	detail: string;
	advisory?: boolean;
}

export interface RailwayComplianceSnapshot {
	state: "success" | "unavailable";
	reason?: string;
	checks: RailwayComplianceCheck[];
	/** True when every non-advisory check passed; true by default. */
	compliant: boolean;
	/** The backend this evidence is attributed to. */
	docsBackend: DocsBackend;
	/** Distinct planning entities covered by the supplied hints. */
	planningNodeCount: number;
	/** LightRAG hosting state at snapshot time (SPE-19385). */
	hostingState?: LightragHostingState;
}


/** What the orchestrator would provision: one LightRAG service in this project. */
export interface LightragServicePlan {
	image: string;
	serviceName: string;
	internalUrl: string;
	projectId: string | null;
	environmentId: string | null;
	project: string | null;
}

/** One hosted resource the orchestrator reports. */
export interface RailwayResource {
	kind: "lightrag";
	serviceId: string | null;
	serviceName: string;
	image: string;
	internalUrl: string;
	project: string | null;
	status: "configured";
}

export type OrchestratorOutcome<T> = ({ state: "success" } & T) | ({ state: "unavailable"; reason: string } & Partial<T>);

/** The LightRAG `/health` probe result: transport failure is still `success` with `ok: false`. */
export type LightragHealth =
	| { state: "success"; ok: true; url: string }
	| { state: "success"; ok: false; url: string; reason: string }
	| { state: "unavailable"; reason: string };

/**
 * Provisions and reports the LightRAG service hosted in the same Railway
 * project as RAGFlow.
 *
 * Railway-side mutations (create/get-service) are stubs: they return the
 * success shape with the exact plan, but perform no API call yet — the live
 * call goes through the Railway MCP integration (GraphQL `serviceCreate` /
 * `service` against `RAILWAY_TOKEN`), which is not wired in this cut. The
 * LightRAG `/health` probe is real but only fires when `health()` is called,
 * with an injectable fetch, and it never logs or returns the API key.
 */
export class RailwayResourceOrchestrator {
	constructor(
		private config: RailwayConfig | null,
		private fetchImpl: FetchLike = fetch,
	) {}

/**
	 * The URL a client uses to reach LightRAG: the configured URL wins,
	 * otherwise Railway private DNS in-project (`<service>.railway.internal`
	 * or the injected `RAILWAY_PRIVATE_DOMAIN`).
	 */
	lightragInternalUrl(): string | null {
		const reach = this.config?.lightrag ?? null;
		if (reach) return reach.url;
		if (!this.config) return null;
		const host = this.config.privateDomain ?? `${this.config.serviceName ?? LIGHTRAG_DEFAULT_SERVICE_NAME}.railway.internal`;
		return `http://${host}:${LIGHTRAG_DEFAULT_PORT}`;
	}

	/** The service this project should run: image, name, and in-project URL. */
	describeLightragService(image: string = LIGHTRAG_DOCKER_IMAGE): LightragServicePlan | null {
		if (!this.config) return null;
		const serviceName = this.config.serviceName ?? LIGHTRAG_DEFAULT_SERVICE_NAME;
		const internalUrl = this.lightragInternalUrl();
		if (!internalUrl) return null;
		return {
			image,
			serviceName,
			internalUrl,
			projectId: this.config.projectId,
			environmentId: this.config.environmentId,
			project: this.config.lightragProject,
		};
	}

	/**
	 * Plan a LightRAG service create. Stub: no Railway API call yet — the
	 * live path is `serviceCreate` via the Railway MCP integration using
	 * `RAILWAY_TOKEN`, with `image: LIGHTRAG_DOCKER_IMAGE`.
	 */
	async createLightragService(args: { serviceName?: string; image?: string } = {}): Promise<OrchestratorOutcome<{ plan: LightragServicePlan }>> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		const plan = this.describeLightragService(args.image);
		if (!plan) return { state: "unavailable", reason: "railway-not-configured" };
		if (args.serviceName) plan.serviceName = args.serviceName;
		return { state: "success", plan };
	}

	/**
	 * Describe a hosted service. Stub: no Railway API call yet — the live
	 * path is the `service` query via the Railway MCP integration.
	 */
	async getService(args: { serviceId: string }): Promise<OrchestratorOutcome<{ service: RailwayResource }>> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		const plan = this.describeLightragService();
		if (!plan) return { state: "unavailable", reason: "railway-not-configured" };
		return {
			state: "success",
			service: {
				kind: "lightrag",
				serviceId: args.serviceId || this.config.serviceId,
				serviceName: plan.serviceName,
				image: plan.image,
				internalUrl: plan.internalUrl,
				project: plan.project,
				status: "configured",
			},
		};
	}

	async listResources(_args: { projectId?: string } = {}): Promise<OrchestratorOutcome<{ resources: RailwayResource[] }>> {
		if (!this.config) return { state: "unavailable", resources: [], reason: "railway-not-configured" };
		const plan = this.describeLightragService();
		if (!plan) return { state: "unavailable", resources: [], reason: "railway-not-configured" };
		return {
			state: "success",
			resources: [
				{
					kind: "lightrag",
					serviceId: this.config.serviceId,
					serviceName: plan.serviceName,
					image: plan.image,
					internalUrl: plan.internalUrl,
					project: plan.project,
					status: "configured",
				},
			],
		};
	}

	async scaleService(_args: { serviceId: string; environmentId: string; replicas: number }): Promise<OrchestratorOutcome<{ ok: true }>> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		// Stub: horizontal scaling goes through the Railway MCP integration.
		return { state: "success", ok: true };
	}

	async getCost(_args: { projectId?: string } = {}): Promise<OrchestratorOutcome<{ usage: Record<string, never> }>> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		// Stub: usage metering goes through the Railway MCP integration.
		return { state: "success", usage: {} };
	}

	async monitor(
		args: { serviceId?: string; environmentId?: string; probe?: boolean; provisioning?: boolean; timeoutMs?: number } = {},
	): Promise<
		OrchestratorOutcome<{
			status: {
				configured: true;
				internalUrl: string;
				project: string | null;
				apiKeyPresent: boolean;
			};
			/** LightRAG hosting state (SPE-19385). */
			hostingState: LightragHostingState;
			reason?: string;
		}>
	> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		const internalUrl = this.lightragInternalUrl();
		if (!internalUrl) return { state: "unavailable", reason: "railway-not-configured" };
		void args.serviceId;
		void args.environmentId;
		const status = {
			configured: true as const,
			internalUrl,
			project: this.config.lightragProject,
			apiKeyPresent: (this.config.apiKey ?? "").length > 0,
		};
		if (args.probe === true) {
			const probed = await this.health(args.timeoutMs);
			if (probed.state === "unavailable") {
				return { state: "success", status, hostingState: "UNAVAILABLE", reason: probed.reason };
			}
			return {
				state: "success",
				status,
				hostingState: resolveLightragHostingState({ configured: true, healthy: probed.ok, provisioning: args.provisioning }),
				...(probed.ok ? {} : { reason: probed.reason }),
			};
		}
		return {
			state: "success",
			status,
			hostingState: resolveLightragHostingState({ configured: true, provisioning: args.provisioning }),
			reason: "lightrag-health-unprobed",
		};
	}

	/**
	 * The LightRAG hosting status for the fabric (SPE-19387): the
	 * provision plan plus the probed (or configuration-derived) hosting
	 * state. Never throws for "not configured" — that answers
	 * `UNAVAILABLE` explicitly.
	 */
	async lightragHosting(
		args: { serviceName?: string; image?: string; probe?: boolean; provisioning?: boolean; timeoutMs?: number } = {},
	): Promise<
		OrchestratorOutcome<{
			hostingState: LightragHostingState;
			plan: LightragServicePlan;
			status: Record<string, unknown>;
			reason?: string;
		}>
	> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		const plan = this.describeLightragService(args.image);
		if (!plan) return { state: "unavailable", reason: "railway-not-configured" };
		if (args.serviceName) plan.serviceName = args.serviceName;
		const probed = await this.monitor({ probe: args.probe, provisioning: args.provisioning, timeoutMs: args.timeoutMs });
		if (probed.state === "unavailable") {
			return { state: "unavailable", reason: probed.reason };
		}
		return {
			state: "success",
			hostingState: probed.hostingState,
			plan,
			status: { ...probed.status, image: plan.image },
			...("reason" in probed && probed.reason ? { reason: probed.reason } : {}),
		};
	}

	/**
	 * Compliance evidence for the fabric (SPE-19385): configuration
	 * readiness, LightRAG hosting state, and planning-graph coverage from
	 * ingest hints. Unconfigured Railway is `unavailable` with an
	 * advisory-only finding, so the fabric's report stays
	 * compliant-but-partial rather than failing closed.
	 */
	async complianceSnapshot(
		args: { graphHints?: readonly PlanningGraphHint[]; docsBackend?: DocsBackend; provisioning?: boolean; healthy?: boolean } = {},
	): Promise<RailwayComplianceSnapshot> {
		const docsBackend = args.docsBackend ?? DEFAULT_DOCS_BACKEND;
		const hints = args.graphHints;
		const nodes = planningNodeCount(hints);
		if (!this.config) {
			return {
				state: "unavailable",
				reason: "railway-not-configured",
				checks: [
					{
						id: "railway-configured",
						passed: false,
						advisory: true,
						detail: "railway-not-configured: cost/compliance evidence unavailable",
					},
				],
				compliant: true,
				docsBackend,
				planningNodeCount: nodes,
				hostingState: "UNAVAILABLE",
			};
		}
		const hostingState = resolveLightragHostingState({ configured: true, healthy: args.healthy, provisioning: args.provisioning });
		const checks: RailwayComplianceCheck[] = [
			{
				id: "railway-configured",
				passed: true,
				detail: "railway project scope present",
			},
			{
				id: "railway-token",
				passed: this.config.token !== null,
				detail:
					this.config.token !== null
						? "railway api token present"
						: "railway api token missing: cost/compliance calls will refuse",
			},
			{
				id: "railway-docs-backend",
				passed: true,
				advisory: true,
				detail: `docs backend attributed as ${docsBackend}`,
			},
			{
				id: "railway-lightrag-hosting",
				passed: hostingState === "RUNNING" || hostingState === "PROVISIONING",
				advisory: true,
				detail: `lightrag hosting ${hostingState} (${LIGHTRAG_DOCKER_IMAGE})`,
			},
		];
		if (hints !== undefined) {
			checks.push({
				id: "railway-planning-coverage",
				passed: nodes > 0,
				advisory: true,
				detail: hints.length === 0 ? "no planning graph hints supplied" : `${nodes} planning nodes under railway evidence`,
			});
		}
		return {
			state: "success",
			checks,
			compliant: checks.every((check) => check.advisory === true || check.passed),
			docsBackend,
			planningNodeCount: nodes,
			hostingState,
		};
	}


	/**
	 * Probe the LightRAG `/health` endpoint. Auth is `LIGHTRAG_API_KEY`, sent as
	 * `x-api-key` (the header LightRAG checks) and as a bearer; the key is never logged or echoed back.
	 */
	async health(timeoutMs = 4000): Promise<LightragHealth> {
		if (!this.config) return { state: "unavailable", reason: "railway-not-configured" };
		const base = this.lightragInternalUrl();
		if (!base) return { state: "unavailable", reason: "lightrag-not-configured" };
		const url = `${base}${LIGHTRAG_HEALTH_PATH}`;
		try {
			const apiKey = this.config.apiKey;
			const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {};
			const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers });
			if (!response.ok) return { state: "success", ok: false, url, reason: `lightrag ${response.status}` };
			return { state: "success", ok: true, url };
		} catch (cause) {
			const detail = String(cause instanceof Error ? cause.message : cause).slice(0, 200);
			return { state: "success", ok: false, url, reason: `lightrag unreachable: ${detail}` };
		}
	}
}
