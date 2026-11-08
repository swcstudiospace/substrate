/**
 * The evidence bundle for one Graph ID: what the substrate can prove about the
 * work done under that key.
 *
 * A **stub**, and marked as one in the bundle itself. What is real today: both hash
 * chains verified, the hourly devnet anchor of each hour the graph's events sit in
 * (`anchors`), the teachable moments that sit in those hours (`teachables`), the SLO
 * verdicts with their sample counts, and the MCP audit's allowed/denied tally. What is
 * not: the per-node Linear/Notion cross-check, which Phase 2 does, and model spend
 * reconciled against the provider's billing. `pending` names them in the bundle rather
 * than leaving a reader to assume the absence means "nothing to report" — an evidence
 * document that overstates itself is worse than one that is honestly partial.
 */
import type { AuditRecord, AuditStats, ChainVerdict } from "@substrate/audit";
import { auditStats } from "@substrate/audit";
import type { MetricSnapshot, SloResult } from "@substrate/observability";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";

/**
 * What a chain's verdict says, in the three states a reader has to tell apart.
 *
 * `ok` alone could not: `null` meant both "this deployment has no such chain to check"
 * and "the chain exists and the store would not answer", and only the second is a
 * failure. `substrate evidence` exits non-zero on a chain it could not verify — that is
 * its contract — and it used to exit 0 through a ledger outage because the bundle gave
 * it no way to distinguish the two. `ok` is kept beside it: it is what the HTML renders
 * and what the older readers of this schema check.
 */
type ChainState = "verified" | "broken" | "unverifiable" | "not-configured";

/** Whether a bundle's audit section is about one graph only. See `EvidenceInput.audit`. */
type AuditAttribution = "exact" | "ambiguous";

export interface ChainEvidence {
	ok: boolean | null;
	/** Optional for a bundle written before this field existed; treat its absence as `ok`. */
	state?: ChainState;
	records: number;
	brokenAt?: string | number;
	reason?: string;
}

/** The state a verdict's `ok` implies, for a caller that has only the boolean. */
export function chainStateOf(chain: Pick<ChainEvidence, "ok" | "state">): ChainState {
	if (chain.state) return chain.state;
	if (chain.ok === true) return "verified";
	if (chain.ok === false) return "broken";
	return "unverifiable";
}

/**
 * One hour's anchor, as the bundle states it (D41-1, D41-5).
 *
 * `anchored`: the hour's devnet transaction reads back and its memo recomputes to the hour.
 * `pending`: not anchored yet, and still inside the window in which it may be.
 * `unverified`: anything else. An hour that cannot be checked fails closed, and `reason`
 * says why. `tx_sig`, `slot` and `explorer_url` are absent for an hour with no anchor.
 */
export type AnchorState = "anchored" | "pending" | "unverified";

export interface AnchorEvidence {
	period_start: string;
	period_end: string;
	status: AnchorState;
	event_count: number;
	root: string | null;
	tx_sig?: string;
	slot?: number;
	/** The Solana devnet transaction page for `tx_sig`. */
	explorer_url?: string;
	reason?: string;
	/** True when the ledger or the stored leaves contradict this hour's anchored head (D73-03); absent otherwise. */
	head_failed?: boolean;
	/** The graph's v3 pointer for this hour (design 5): `verified` when a pointer confirmed on chain names it, `failed` when one fails its checks, `absent` when none names it. */
	pointer?: "verified" | "failed" | "absent";
}

/**
 * One teachable moment (E-D2, D41-4): an accepted and verified teachable, identified by its
 * ledger event and by the digest of the observation it recorded.
 */
export interface TeachableEvidence {
	event_id: string;
	graph_id: string;
	session_id?: string;
	/** The observation digest: the sha256 the teachable event carries for its accepted entry. */
	content_sha256: string;
	/** The start of the hour the event is anchored under; null when it has no ingest record. */
	hour: string | null;
	/** Whether `hour` is `anchored`, which puts the event inside an anchored root. */
	anchored: boolean;
	/** The transaction of `hour`, when that hour has one. */
	tx_sig?: string;
	explorer_url?: string;
	/** Why the event is not anchored although its hour is, when known: `tampered` when its content no longer matches the ledger's hash. */
	reason?: string;
}

export interface EvidenceInput {
	/**
	 * The graph, in the form the substrate **stores** identifiers under.
	 *
	 * Not the raw string a caller asked with. Two reasons, and the second is why this is
	 * documented on the field rather than left to the call site.
	 *
	 * *It is the key.* The audit record and the metric attribute both hold a redacted,
	 * capped identifier — `sanitizeField` and `normalizeIdentifier` are the same transform —
	 * so reading either back with the raw string matched nothing, and a bundle reporting no
	 * tokens and no cost is indistinguishable from a graph that spent nothing.
	 * `normalizeIdentifier` states the rule: "cleaning them on the write path but querying
	 * with the raw value would mean a lookup that never matches".
	 *
	 * *It is a document.* An evidence bundle is written to a file, served over HTTP and
	 * archived. A caller can put a credential in a graph id, and the audit record redacts it
	 * — so echoing the raw string here would carry into the evidence document, and into the
	 * HTML rendered from it, exactly the value every other field went to the trouble of
	 * removing.
	 *
	 * For every ordinary `ut-…` identifier the two forms are the same string.
	 */
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
		/**
		 * The tally over **every** record for this graph, when `records` is a window of them.
		 *
		 * A bundle lists a bounded number of records, because a trail has no compaction. The
		 * counts must not be bounded with it: computing them from the listed window reported
		 * a graph past the window as having only the decisions that happened to be listed,
		 * which is a wrong number rather than a partial one. Omit it and the tally is
		 * computed from `records`, which is right when `records` is complete.
		 */
		stats?: AuditStats;
		/**
		 * Whether these decisions can be attributed to *this* graph and no other.
		 *
		 * `ambiguous` when the identifier is stored in a cleaned form, because two
		 * identifiers that clean to the same string are indistinguishable once stored — so
		 * the records and the tally may hold another graph's decisions, and nothing in the
		 * file can say which. A note explaining that is not enough: this bundle is *labelled*
		 * for one graph, and a reader takes its tally as that graph's. Saying so in prose
		 * while presenting the numbers anyway is the overstatement this document exists not
		 * to make, so it is a state a caller can act on and `substrate evidence` exits
		 * non-zero for it.
		 *
		 * Absent means `exact`, which is every ordinary `ut-…` identifier.
		 */
		attribution?: AuditAttribution;
	};
	metrics?: MetricSnapshot[];
	/** One entry per hour of the graph's verify report (D41-1). Absent is none. */
	anchors?: AnchorEvidence[];
	/** The graph's teachable moments, each with its hour and that hour's anchor (D41-4). */
	teachables?: TeachableEvidence[];
	notes?: string[];
}

interface EvidenceUsage {
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
	audit: AuditStats & { records: AuditRecord[]; attribution: AuditAttribution };
	usage: EvidenceUsage | null;
	anchors: AnchorEvidence[];
	teachables: TeachableEvidence[];
	pending: string[];
	notes: string[];
}

/** What this bundle cannot yet attest to, and which phase closes each gap. */
const PENDING = [
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
				// The audit chain is always present — it is this process's own file, or its
				// own memory — so it is never `not-configured`. `durable: false` is how a
				// memory-only chain is reported, and it is reported below.
				state: verdict.ok ? ("verified" as const) : ("broken" as const),
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
		audit: {
			...(input.audit.stats ?? auditStats(input.audit.records)),
			records: input.audit.records,
			attribution: input.audit.attribution ?? "exact",
		},
		// Keyed by the stored form, which is what `graph_id` is — see its doc comment.
		usage: usageForGraph(input.metrics, input.graph_id),
		anchors: input.anchors ?? [],
		teachables: input.teachables ?? [],
		pending: PENDING,
		notes: [
			...(input.audit.durable
				? []
				: ["The MCP audit chain is not durable in this deployment: SUBSTRATE_AUDIT_PATH is unset, so the chain lives in memory and ends at the next restart."]),
			...(input.notes ?? []),
		],
	};
}
