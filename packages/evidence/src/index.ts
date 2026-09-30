/**
 * `@substrate/evidence` — the per-graph evidence bundle, as JSON and as one
 * self-contained HTML file.
 *
 * Behind `substrate evidence --graph ut-…` and `POST /evidence`.
 */
export {
	type ChainEvidence,
	type EvidenceBundle,
	type EvidenceInput,
	type EvidenceUsage,
	buildEvidence,
	usageForGraph,
} from "./report.ts";

export { escapeHtml, renderEvidenceHtml } from "./html.ts";
