/**
 * The evidence bundle for one Graph ID: what the substrate can prove about the
 * work done under that key.
 *
 * A **stub**, and marked as one in the bundle itself. What is real today: both hash
 * chains verified, the SLO verdicts with their sample counts, and the MCP audit's
 * allowed/denied tally. What is not: the Solana anchor and its signature, which
 * Phase 6 adds, and the per-node Linear/Notion cross-check, which Phase 2 does.
 * `pending` names them in the bundle rather than leaving a reader to assume the
 * absence means "nothing to report" — an evidence document that overstates itself
 * is worse than one that is honestly partial.
 */
import type { AuditRecord, AuditStats, ChainVerdict } from "@substrate/audit";
import { auditStats } from "@substrate/audit";
import type { MetricSnapshot, SloResult } from "@substrate/observability";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";

export interface ChainEvidence {
	ok: boolean | null;
	records: number;
	brokenAt?: string | number;
	reason?: string;
}

export interface EvidenceInput {
	graph_id: string;
	generated?: Date;
	service: { name: string; version: string; instance: string };
	slos: SloResult[];
	/** `substrate verify <graph_id>` over the Greptime app-event chain. */
	appChain: ChainEvidence;
	audit: {
		chain: ChainVerdict & { unparseable?: number };
		durable: boolean;
		path: string | null;
		/** The records for this graph, plus any denial — a denial has no graph to file under. */
		records: AuditRecord[];
	};
	metrics?: MetricSnapshot[];
	notes?: string[];
}

export interface EvidenceUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface EvidenceBundle {
	schema: "substrate.evidence/v0";
	stub: true;
	graph_id: string;
	generated: string;
	service: { name: string; version: string; instance: string };
	chains: {
		app_events: ChainEvidence;
		mcp_audit: ChainEvidence & { durable: boolean; path: string | null; unparseable: number };
	};
	slos: SloResult[];
	slo_summary: { ok: number; breached: number; insufficient: number; unmeasurable: number };
	audit: AuditStats & { records: AuditRecord[] };
	usage: EvidenceUsage | null;
	pending: string[];
	notes: string[];
}

/** What this bundle cannot yet attest to, and which phase closes each gap. */
const PENDING = [
	"Solana devnet Merkle anchor and signature over the hour containing these events (Phase 6)",
	"per-node cross-check against the Linear issue and Notion page states (Phase 2)",
	"model spend reconciled against the provider's own billing, rather than as collectors reported it",
];

/**
 * Usage totals for this graph, read back out of the metric snapshot.
 *
 * `graph_id` may have collapsed to `_overflow` under the series cap, in which case
 * this graph's own totals are not separable and `null` is returned rather than
 * another graph's numbers. That is the cardinality guard being honest about its
 * cost at the one place the cost is visible.
 */
export function usageForGraph(snapshot: MetricSnapshot[] | undefined, graphId: string): EvidenceUsage | null {
	if (!snapshot) return null;
	const tokens = findCounter(snapshot, METRIC.tokens);
	const cost = findCounter(snapshot, METRIC.cost);
	if (!tokens && !cost) return null;
	const inputTokens = tokens ? sumCounter(tokens, { graph_id: graphId, direction: "input" }) : 0;
	const outputTokens = tokens ? sumCounter(tokens, { graph_id: graphId, direction: "output" }) : 0;
	const costUsd = cost ? sumCounter(cost, { graph_id: graphId }) : 0;
	if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return null;
	return { inputTokens, outputTokens, costUsd };
}

export function buildEvidence(input: EvidenceInput): EvidenceBundle {
	const verdict = input.audit.chain;
	return {
		schema: "substrate.evidence/v0",
		stub: true,
		graph_id: input.graph_id,
		generated: (input.generated ?? new Date()).toISOString(),
		service: input.service,
		chains: {
			app_events: input.appChain,
			mcp_audit: {
				ok: verdict.ok,
				records: verdict.records,
				// `brokenAt` is omitted when the verdict has no locatable position, so a
				// reader sees the reason rather than a sentinel. `reason` is always carried.
				...(verdict.ok
					? {}
					: {
							...(verdict.brokenAt >= 0 ? { brokenAt: verdict.brokenAt } : {}),
							reason: verdict.reason,
						}),
				durable: input.audit.durable,
				path: input.audit.path,
				unparseable: verdict.unparseable ?? 0,
			},
		},
		slos: input.slos,
		slo_summary: {
			ok: input.slos.filter((slo) => slo.status === "ok").length,
			breached: input.slos.filter((slo) => slo.status === "breached").length,
			insufficient: input.slos.filter((slo) => slo.status === "insufficient-data").length,
			unmeasurable: input.slos.filter((slo) => slo.status === "unmeasurable").length,
		},
		audit: { ...auditStats(input.audit.records), records: input.audit.records },
		usage: usageForGraph(input.metrics, input.graph_id),
		pending: PENDING,
		notes: [
			...(input.audit.durable
				? []
				: ["The MCP audit chain is not durable in this deployment: SUBSTRATE_AUDIT_PATH is unset, so the chain lives in memory and ends at the next restart."]),
			...(input.notes ?? []),
		],
	};
}
