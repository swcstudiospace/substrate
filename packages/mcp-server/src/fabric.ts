/**
 * Enterprise unified resource fabric: one status, one optimisation list and
 * one compliance report across the RAG (LightRAG/RAGFlow), docs and Railway
 * planes.
 *
 * Every dependency is injected and optional. An absent probe is reported
 * explicitly (`reason: "...-not-configured"`), never silently defaulted, and
 * probe failures are recorded in the payload rather than thrown — status and
 * compliance must stay answerable when a plane is down. The one exception is
 * Railway absence in the compliance report, which yields a partial-but-still-
 * compliant report: no Railway means no cost evidence, not a violation.
 */
import type { LightragHostingState } from "./railway.ts";
import { resolveLightragHostingState } from "./railway.ts";

export type { DocsBackend, PlanningGraphHint, PlanningGraphRelation } from "./railway.ts";

/** LightRAG-specific health: graph integrity, vector coverage, planning size. */
export interface LightRagStatus {
	configured: boolean;
	/** The graph index is reachable and internally consistent. */
	graphHealthy: boolean;
	/** Nodes in the knowledge graph. */
	graphNodeCount: number;
	/** Vectors in the store. */
	vectorCount: number;
	/** Fraction (0..1) of graph nodes with a live vector. */
	vectorCoverage: number;
	/** Distinct planning entities indexed (from planning-graph hints). */
	planningNodeCount: number;
	/** Which backend this status was read from. */
	docsBackend: DocsBackend;
	/** Railway hosting state for the LightRAG service (SPE-19385); backfilled by `getStatus` when a probe omits it. */
	hostingState?: LightragHostingState;
	reason?: string;
}

export interface LightRagProbe {
	getLightRagStatus(): Promise<LightRagStatus>;
}

/** Docs-plane reachability for the compliance report. */
export interface DocsPlaneStatus {
	configured: boolean;
	datasetCount: number;
	degraded: boolean;
	docsBackend: DocsBackend;
	reason?: string;
}

export interface DocsPlaneProbe {
	getDocsPlaneStatus(): Promise<DocsPlaneStatus>;
}

export interface FabricDeps {
	railway?: RailwayResourceOrchestrator | null;
	lightrag?: LightRagProbe | null;
	docs?: DocsPlaneProbe | null;
	/** Backend assumed when no probe reports one. Backward default: ragflow. */
	docsBackend?: DocsBackend;
}

export interface FabricResourceSummary {
	state: "success" | "unavailable";
	resourceCount: number;
	reason?: string;
}


export interface FabricStatus {
	state: "success";
	resources: FabricResourceSummary[];
	lightrag: LightRagStatus;
	railway: FabricResourceSummary;
	docs: DocsPlaneStatus;
}


export type OptimizationPlane = "rag" | "railway" | "docs";

export interface Optimization {
	id: string;
	plane: OptimizationPlane;
	action: string;
	reason: string;
}

export interface ComplianceCheck {
	id: string;
	plane: OptimizationPlane;
	passed: boolean;
	detail: string;
	advisory?: boolean;
}

export interface ComplianceReport {
	/** True when every non-advisory check passed; true by default. */
	compliant: boolean;
	checks: ComplianceCheck[];
	/** Fraction (0..1) of planes with configured evidence. */
	auditCoverage: number;
}

/** Below this coverage the planner should reindex the planning graph. */
export const REINDEX_COVERAGE_THRESHOLD = 0.8;

function defaultLightRagStatus(docsBackend: DocsBackend): LightRagStatus {
	return {
		configured: false,
		graphHealthy: false,
		graphNodeCount: 0,
		vectorCount: 0,
		vectorCoverage: 0,
		planningNodeCount: 0,
		docsBackend,
		reason: "lightrag-not-configured",
	};
}

function defaultDocsStatus(docsBackend: DocsBackend): DocsPlaneStatus {
	return {
		configured: false,
		datasetCount: 0,
		degraded: false,
		docsBackend,
		reason: "docs-probe-not-configured",
	};
}

export class EnterpriseUnifiedResourceFabric {
	private readonly deps: FabricDeps;

	constructor(deps: FabricDeps = {}) {
		this.deps = deps;
	}

	async getStatus(): Promise<FabricStatus> {
		const backend: DocsBackend = this.deps.docsBackend ?? DEFAULT_DOCS_BACKEND;
		const lightrag = this.deps.lightrag
			? await this.deps.lightrag.getLightRagStatus().catch((error: unknown) => ({
					...defaultLightRagStatus(backend),
					reason: error instanceof Error ? error.message : "lightrag-probe-failed",
				}))
			: defaultLightRagStatus(backend);
		const docs = this.deps.docs
			? await this.deps.docs.getDocsPlaneStatus().catch((error: unknown) => ({
					...defaultDocsStatus(backend),
					reason: error instanceof Error ? error.message : "docs-probe-failed",
				}))
			: defaultDocsStatus(backend);
		let railway: FabricResourceSummary;
		if (!this.deps.railway) {
			railway = { state: "unavailable", resourceCount: 0, reason: "railway-not-configured" };
		} else {
			try {
				const listed = await this.deps.railway.listResources();
				railway =
					listed.state === "success"
						? { state: "success", resourceCount: listed.resources.length }
						: { state: "unavailable", resourceCount: 0, reason: "railway-not-configured" };
			} catch (error: unknown) {
				railway = {
					state: "unavailable",
					resourceCount: 0,
					reason: error instanceof Error ? error.message : "railway-list-failed",
				};
			}
		}
		const hostingState = lightrag.hostingState ?? resolveLightragHostingState({ configured: lightrag.configured, healthy: lightrag.configured ? lightrag.graphHealthy : undefined });
		return { state: "success", resources: [], lightrag: { ...lightrag, hostingState }, railway, docs };
	}

	/**
	 * RAG-first optimisation suggestions: reindex the planning graph when
	 * vector coverage slips, repair an unhealthy graph, refresh degraded
	 * docs datasets, and configure Railway when cost evidence is missing.
	 */
	async suggestOptimizations(args: { coverageThreshold?: number } = {}): Promise<Optimization[]> {
		const threshold = args.coverageThreshold ?? REINDEX_COVERAGE_THRESHOLD;
		const { lightrag, docs, railway } = await this.getStatus();
		const suggestions: Optimization[] = [];
		if (!lightrag.configured) {
			suggestions.push({
				id: "configure-lightrag",
				plane: "rag",
				action: "configure lightrag backend",
				reason: lightrag.reason ?? "lightrag-not-configured",
			});
		} else {
			if (!lightrag.graphHealthy) {
				suggestions.push({
					id: "repair-graph",
					plane: "rag",
					action: "repair knowledge graph",
					reason: lightrag.reason ?? "graph reported unhealthy",
				});
			}
			if (lightrag.vectorCount > 0 && lightrag.vectorCoverage < threshold) {
				suggestions.push({
					id: "reindex-planning",
					plane: "rag",
					action: "reindex planning graph",
					reason: `vector coverage ${lightrag.vectorCoverage.toFixed(2)} below ${threshold.toFixed(2)} over ${lightrag.planningNodeCount} planning nodes`,
				});
			}
			if (lightrag.planningNodeCount === 0) {
				suggestions.push({
					id: "index-planning-graph",
					plane: "rag",
					action: "index planning graph",
					reason: "no planning nodes indexed: attach planning graph hints at ingest",
				});
			}
			if (lightrag.hostingState === "PROVISIONING") {
				suggestions.push({
					id: "await-lightrag-provisioning",
					plane: "rag",
					action: "await lightrag provisioning",
					reason: "lightrag service is provisioning on railway: re-check hosting state before reindexing",
				});
			}
		}
		if (docs.configured && docs.degraded) {
			suggestions.push({
				id: "refresh-docs-datasets",
				plane: "docs",
				action: "refresh degraded docs datasets",
				reason: docs.reason ?? "docs plane degraded",
			});
		}
		if (railway.state === "unavailable") {
			suggestions.push({
				id: "configure-railway",
				plane: "railway",
				action: "configure railway for cost/compliance evidence",
				reason: railway.reason ?? "railway-not-configured",
			});
		}
		return suggestions;
	}

	/**
	 * Compliance across the docs, RAG and Railway planes. Railway absence
	 * yields a partial report (no cost evidence) that stays compliant:
	 * unconfigured is advisory, never a violation.
	 */
	async complianceReport(): Promise<ComplianceReport> {
		const { lightrag, docs, railway } = await this.getStatus();
		const checks: ComplianceCheck[] = [
			{
				id: "docs-plane-configured",
				plane: "docs",
				passed: !docs.configured ? true : !docs.degraded,
				advisory: !docs.configured ? true : undefined,
				detail: !docs.configured
					? (docs.reason ?? "docs probe not configured: docs evidence unavailable")
					: docs.degraded
						? (docs.reason ?? `docs plane degraded over ${docs.datasetCount} datasets`)
						: `docs plane healthy over ${docs.datasetCount} datasets via ${docs.docsBackend}`,
			},
			{
				id: "rag-graph-healthy",
				plane: "rag",
				passed: !lightrag.configured ? true : lightrag.graphHealthy,
				advisory: !lightrag.configured ? true : undefined,
				detail: !lightrag.configured
					? (lightrag.reason ?? "lightrag not configured: graph evidence unavailable")
					: lightrag.graphHealthy
						? `graph healthy: ${lightrag.graphNodeCount} nodes, ${lightrag.vectorCount} vectors via ${lightrag.docsBackend}`
						: (lightrag.reason ?? "knowledge graph reported unhealthy"),
			},
			{
				id: "rag-vector-coverage",
				plane: "rag",
				passed: !lightrag.configured ? true : lightrag.vectorCoverage >= REINDEX_COVERAGE_THRESHOLD,
				advisory: !lightrag.configured ? true : undefined,
				detail: !lightrag.configured
					? "vector coverage unknown without a configured backend"
					: `vector coverage ${lightrag.vectorCoverage.toFixed(2)} over ${lightrag.planningNodeCount} planning nodes`,
			},
		];
		let partial: true | undefined;
		let reason: string | undefined;
		if (!this.deps.railway) {
			partial = true;
			reason = "railway-not-configured";
			checks.push({
				id: "railway-configured",
				plane: "railway",
				passed: false,
				advisory: true,
				detail: "railway-not-configured: cost/compliance evidence unavailable",
			});
		} else {
			let snapshot: { state: string; checks: RailwayComplianceCheck[]; reason?: string };
			try {
				snapshot = await this.deps.railway.complianceSnapshot({ docsBackend: lightrag.docsBackend });
			} catch (error: unknown) {
				partial = true;
				reason = error instanceof Error ? error.message : "railway-compliance-failed";
				snapshot = { state: "unavailable", checks: [], reason };
			}
			if (snapshot.state !== "success") {
				partial = true;
				reason = snapshot.reason ?? "railway-not-configured";
			}
			for (const check of snapshot.checks) {
				checks.push({ ...check, plane: "railway" });
			}
		}
		const planes = [lightrag.configured, docs.configured, this.deps.railway !== undefined && this.deps.railway !== null];
		const covered = planes.filter((present) => present).length;
		return {
			compliant: checks.every((check) => check.advisory === true || check.passed),
			...(partial !== undefined ? { partial, reason } : {}),
			checks,
			auditCoverage: covered / planes.length,
		};
	}
}
