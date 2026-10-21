/**
 * `@substrate/evidence` — the per-graph evidence bundle, as JSON and as one
 * self-contained HTML file.
 *
 * Behind `substrate evidence --graph ut-…` and `POST /evidence`.
 */
export {
	type AnchorEvidence,
	type AnchorState,
	type AuditAttribution,
	type ChainEvidence,
	type ChainState,
	type EvidenceBundle,
	type EvidenceInput,
	type EvidenceUsage,
	type TeachableEvidence,
	buildEvidence,
	chainStateOf,
	usageForGraph,
} from "./report.ts";

export { devnetExplorerTxUrl } from "./explorer.ts";
export { escapeHtml, renderEvidenceHtml } from "./html.ts";
