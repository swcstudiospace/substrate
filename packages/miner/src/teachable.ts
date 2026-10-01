/**
 * Teachable Moments miner (Phase 4)
 * Reverse skills: extract observations, edges, learnings from session events/handoffs
 * NOT recall of prior knowledge. Framed for A2A AgentCard.skills[].
 * Solana devnet anchor stub (record + "tx" for verifiable).
 */

import type { TeachableMoment, AgentCard, Surface } from "../../mcp-server/src/types.ts";

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

export function anchorTeachableOnSolanaDevnet(teachable: TeachableMoment): { solana_anchor: string; note: string } {
  // Stub: in real, use @solana/web3.js to send memo with graph+framing+hash to devnet
  const anchor = `solana-devnet-memo:${teachable.graph_id}:${teachable.framing}:${Date.now()}`;
  return { solana_anchor: anchor, note: "devnet memo; real tx would carry prev_hash + edges for replay" };
}

export function verifyTeachableAnchor(teachable: TeachableMoment): boolean {
  return !!teachable.solana_anchor && teachable.solana_anchor.includes("solana-devnet");
}
