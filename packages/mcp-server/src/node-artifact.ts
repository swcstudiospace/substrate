/**
 * One node's artifact (phase 38, B-D3): its claim, Linear, Notion and Definition-of-Done steps, read from the graph's
 * verified event chain. Nothing here writes. A claim step is a lease decision the ledger recorded for the node, whether
 * or not a tracker was bound. A Linear or Notion step is a `mirror` event, and a DoD step is a `dod` event.
 */

/** The fields of a verified chain record this view reads. */
export interface ArtifactEvent {
	node_id?: string | null;
	ts?: string | null;
	hash?: string | null;
	prev?: string | null;
	payload?: unknown;
}

export type MirrorStatus = "ok" | "failed";

export interface NodeArtifact {
	node_id: string;
	/** Every lease decision the ledger recorded for the node, in time order. */
	claim: Array<{ ts: string | null; action: string }>;
	/** Claim, review and the rest of the Linear steps, and the relation outcomes (`op: "relate"`) with their edge. */
	linear: Array<{
		ts: string | null;
		op: string;
		status: MirrorStatus;
		reason: string | null;
		blocker_node: string | null;
		edge_kind: string | null;
	}>;
	notion: Array<{ ts: string | null; op: string; status: MirrorStatus; reason: string | null }>;
	/** `approved` when the gate accepted the evidence; `refused` for a refusal; `warning` for any other gate report. */
	dod: Array<{ ts: string | null; status: "approved" | "refused" | "warning"; reason: string | null }>;
}

/** The `payload.action` values a lease decision records: a claim, a release, or the expiry the reaper writes. */
const LEASE_DECISIONS = new Set(["granted", "renewed", "reclaimed", "stolen", "denied", "released", "noop", "forced", "expired"]);
const DOD_REFUSALS = new Set(["dod-required", "dod-refused", "dod-unavailable"]);

function fieldsOf(payload: unknown): Record<string, unknown> {
	return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * Time order. Two events in one millisecond are put in chain order where the chain links them, so an event whose
 * `prev` is the `hash` of another event in that group comes after it. Events the chain does not link keep the ledger's
 * order.
 */
function inLedgerOrder(events: readonly ArtifactEvent[]): ArtifactEvent[] {
	const byTime = [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
	const ordered: ArtifactEvent[] = [];
	let start = 0;
	while (start < byTime.length) {
		const first = byTime[start];
		let end = start + 1;
		while (end < byTime.length && byTime[end]?.ts === first?.ts) end++;
		ordered.push(...chainOrder(byTime.slice(start, end)));
		start = end;
	}
	return ordered;
}

/** One millisecond's events: take, in turn, the first event whose predecessor is already placed or is not in the group. */
function chainOrder(group: ArtifactEvent[]): ArtifactEvent[] {
	const waiting = [...group];
	const placed: ArtifactEvent[] = [];
	while (waiting.length > 0) {
		const unplaced = new Set(waiting.map((event) => event.hash ?? null));
		let index = waiting.findIndex((event) => !event.prev || !unplaced.has(event.prev));
		if (index < 0) index = 0; // a cycle or a broken link: keep the ledger's order
		placed.push(...waiting.splice(index, 1));
	}
	return placed;
}

/** The node's steps in time order. Only events carrying this node's id count, and nothing is inferred. */
export function nodeArtifact(events: readonly ArtifactEvent[], nodeId: string): NodeArtifact {
	const artifact: NodeArtifact = { node_id: nodeId, claim: [], linear: [], notion: [], dod: [] };
	for (const event of inLedgerOrder(events)) {
		if (event.node_id !== nodeId) continue;
		const fields = fieldsOf(event.payload);
		const ts = event.ts ?? null;
		const reason = textOf(fields.reason);
		const action = textOf(fields.action);
		if (action !== null && LEASE_DECISIONS.has(action)) {
			artifact.claim.push({ ts, action });
		} else if (action === "mirror") {
			const op = String(fields.op ?? "");
			const status: MirrorStatus = fields.status === "ok" ? "ok" : "failed";
			if (fields.target === "linear") {
				artifact.linear.push({
					ts,
					op,
					status,
					reason,
					blocker_node: textOf(fields.blocker_node),
					edge_kind: textOf(fields.edge_kind),
				});
			}
			if (fields.target === "notion") artifact.notion.push({ ts, op, status, reason });
		} else if (action === "dod") {
			const status = fields.status === "approved" ? "approved" : reason && DOD_REFUSALS.has(reason) ? "refused" : "warning";
			artifact.dod.push({ ts, status, reason });
		}
	}
	return artifact;
}
