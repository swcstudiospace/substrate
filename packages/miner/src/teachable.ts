/**
 * Teachable Moments miner (Phase 4)
 * Reverse skills: extract observations, edges, learnings from session events/handoffs
 * NOT recall of prior knowledge. Framed for A2A AgentCard.skills[].
 * Solana devnet anchor stub (record + "tx" for verifiable).
 */

import type { TeachableMoment, AgentCard, Surface } from "../../mcp-server/src/types.ts";
import { anchorMemoOnDevnet, planesFromEnv } from "../../mcp-server/src/planes.ts";

export function extractTeachableFromEvents(graphId: string, events: any[], sessionSummary?: string): TeachableMoment {
  const observations: string[] = [];
  const edges: string[] = [];
  const learnings: string[] = [];

  for (const e of events || []) {
    const s = (e.summary || e.body || "").toLowerCase();
    if (s.includes("error") || s.includes("fail") || s.includes("edge")) edges.push(e.summary || String(e));
    if (s.includes("learned") || s.includes("note") || s.includes("observe")) observations.push(e.summary || String(e));
    if (s.includes("lesson") || s.includes("do next") || s.includes("better")) learnings.push(e.summary || String(e));
  }

  if (observations.length === 0) observations.push("session produced no explicit observation");
  if (edges.length === 0) edges.push("no failure edges captured");
  if (learnings.length === 0) learnings.push("no explicit learning captured");

  return {
    graph_id: graphId,
    framing: `session-${graphId.slice(0,6)}-learnings`,
    observations: observations.slice(0, 5),
    edges: edges.slice(0, 3),
    learnings: learnings.slice(0, 3),
    session_summary: sessionSummary,
    prev_event_hash: events?.[0]?.hash || "0",
    ts: new Date().toISOString(),
  };
}

export function makeAgentCard(agent: string, surface: Surface, teachables: TeachableMoment[]): AgentCard {
  return {
    agent,
    surface,
    version: "v0.3-a2a",
    skills: teachables.map(t => ({ name: t.framing, framing: t.framing, tags: ["teachable-moment", "session-learn", surface] })),
    teachables,
  };
}

export async function anchorTeachableOnSolanaDevnet(
	teachable: TeachableMoment,
): Promise<{ solana_anchor: string; note: string }> {
	const solana = planesFromEnv().solana;
	if (!solana) {
		return { solana_anchor: "", note: "SOLANA_RPC_URL or SOLANA_ANCHOR_KEYPAIR is not set" };
	}
	const memo = `substrate:${teachable.graph_id}:${teachable.framing}`;
	const result = await anchorMemoOnDevnet(solana, memo);
	if (!result.signature) return { solana_anchor: "", note: result.error ?? "devnet memo failed" };
	return { solana_anchor: result.signature, note: "devnet memo" };
}

export function verifyTeachableAnchor(teachable: TeachableMoment): boolean {
	return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(teachable.solana_anchor ?? "");
}
