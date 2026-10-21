/**
 * One node's artifact (phase 38, B-D3): its claim, Linear, Notion and Definition-of-Done steps, read from the graph's
 * verified event chain. Nothing here writes. Each step is an event the mirror or the DoD gate already recorded with
 * the node's id: a `mirror` note when a target wrote cleanly, a `mirror` warning when it failed, and a `dod` note or
 * warning per gate decision.
 */

/** The fields of a verified chain record this view reads. */
export interface ArtifactEvent {
	node_id?: string | null;
	ts?: string | null;
	payload?: unknown;
}

export type MirrorStatus = "ok" | "failed";

export interface NodeArtifact {
	node_id: string;
	/** The lease operations the node went through, in order. A repeat of the same op is one step. */
	claim: Array<{ ts: string | null; op: string }>;
	linear: Array<{ ts: string | null; op: string; status: MirrorStatus; reason: string | null }>;
	notion: Array<{ ts: string | null; op: string; status: MirrorStatus; reason: string | null }>;
	/** `approved` when the gate accepted the evidence; `refused` for a refusal; `warning` for any other gate report. */
	dod: Array<{ ts: string | null; status: "approved" | "refused" | "warning"; reason: string | null }>;
}

const LEASE_OPS = new Set(["claim", "steal", "release", "expire", "force", "review", "done", "close"]);
const DOD_REFUSALS = new Set(["dod-required", "dod-refused", "dod-unavailable"]);

function fieldsOf(payload: unknown): Record<string, unknown> {
	return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** The node's steps in chain order. Only events carrying this node's id count, and nothing is inferred. */
export function nodeArtifact(events: readonly ArtifactEvent[], nodeId: string): NodeArtifact {
	const artifact: NodeArtifact = { node_id: nodeId, claim: [], linear: [], notion: [], dod: [] };
	for (const event of events) {
		if (event.node_id !== nodeId) continue;
		const fields = fieldsOf(event.payload);
		const ts = event.ts ?? null;
		const reason = typeof fields.reason === "string" ? fields.reason : null;
		if (fields.action === "mirror") {
			const op = String(fields.op ?? "");
			const status: MirrorStatus = fields.status === "ok" ? "ok" : "failed";
			if (LEASE_OPS.has(op) && artifact.claim[artifact.claim.length - 1]?.op !== op) artifact.claim.push({ ts, op });
			if (fields.target === "linear") artifact.linear.push({ ts, op, status, reason });
			if (fields.target === "notion") artifact.notion.push({ ts, op, status, reason });
		} else if (fields.action === "dod") {
			const status = fields.status === "approved" ? "approved" : reason && DOD_REFUSALS.has(reason) ? "refused" : "warning";
			artifact.dod.push({ ts, status, reason });
		}
	}
	return artifact;
}
