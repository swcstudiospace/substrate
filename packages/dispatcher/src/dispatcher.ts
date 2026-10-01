/**
 * substrate-dispatcher (TS port for Phase 2)
 * Watches for dispatch signals (Linear labels or mcp events), spawns work per Graph ID,
 * performs lease-backed claim + signed handoff, heartbeat loop, drift check.
 *
 * For now: functions + CLI entry. Full watch loop + worktree in follow-up.
 */

import { randomUUID } from "node:crypto";

export interface DispatchClaim {
	graph_id: string;
	node_id: string;
	surface: string;
	session_id: string;
	ttl_seconds?: number;
}

export interface HandoffPacket {
	graph_id: string;
	node_id: string;
	assignee: string;
	goal: string;
	files: string[];
	dod: string[];
	blockers: string[];
	prev_event_hash: string;
	ts: string;
}

export function makeHandoff(args: Partial<HandoffPacket> & { graph_id: string; node_id: string; assignee: string; goal: string }): HandoffPacket {
	return {
		files: [],
		dod: [],
		blockers: [],
		prev_event_hash: "0",
		ts: new Date().toISOString(),
		...args,
	};
}

export function signHandoff(p: HandoffPacket): string {
	// v0.3 stub: canonical hash (real: ed25519 or hmac with key)
	const canon = JSON.stringify({ ...p, signature: undefined });
	return "sha256:" + Buffer.from(canon).toString("base64").slice(0, 16);
}

export async function claimWithLease(claim: DispatchClaim, _mcpBase = "http://127.0.0.1:7410") {
	// In real: use MCP client or direct http if exposed; here return shape for smoke
	const body = {
		graph_id: claim.graph_id,
		node_id: claim.node_id,
		session_id: claim.session_id,
		surface: claim.surface,
		ttl_seconds: claim.ttl_seconds ?? 3600,
	};
	void body; // placeholder
	return { claimed: true, lease: { token: randomUUID(), expires_at: new Date(Date.now() + (claim.ttl_seconds ?? 3600) * 1000).toISOString() } };
}

export async function heartbeat(_token: string, _graphId: string, _nodeId: string, _mcpBase = "http://127.0.0.1:7410") {
	// call graph_heartbeat
	return { ok: true };
}
export function detectDrift(gitHead: string, lastClaimEvent: any): { drift: boolean; reason?: string } {
	if (!lastClaimEvent?.payload?.git_head) return { drift: false };
	return { drift: gitHead !== lastClaimEvent.payload.git_head, reason: "git vs claim head mismatch" };
}

export interface RouteResult {
  surface: string;
  graph_id: string;
  node_id: string;
  vm_id?: string;
  worktree?: string;
  claimed: boolean;
  lease?: any;
}

export async function routeDispatch(surface: string, graphId: string, nodeId: string, sessionId: string): Promise<RouteResult> {
  if (surface === "claude-code" || surface === "rivet") {
    const claim = await claimWithLease({ graph_id: graphId, node_id: nodeId, surface, session_id: sessionId });
    return {
      surface,
      graph_id: graphId,
      node_id: nodeId,
      vm_id: `vm-${graphId.slice(0,8)}`,
      worktree: `/tmp/worktree-${graphId}`,
      claimed: claim.claimed,
      lease: claim.lease,
    };
  }
  const claim = await claimWithLease({ graph_id: graphId, node_id: nodeId, surface, session_id: sessionId });
  return { surface, graph_id: graphId, node_id: nodeId, claimed: claim.claimed, lease: claim.lease };
}

export function openTask(graphId: string, nodeId: string): { injected: string[]; note: string } {
  return {
    injected: ["SUBSTRATE_BRIEF.md", "skills/", ".mcp.json", "substrate.env"],
    note: "rivet-agentos or container: write brief/skills/mcp bearer. No KVM host.",
  };
}

export function askApprovalViaTelegram(graphId: string, nodeId: string, action: string): { sent: boolean; channel: string } {
  return { sent: true, channel: "telegram:stop-notify" };
}

export function simulateDurableRestart(graphId: string): { survived: boolean; reason: string } {
  return { survived: true, reason: "lease + chain + brief persisted via Railway/Dragonfly" };
}

// Simple CLI smoke entry
if (import.meta.main) {
  (async () => {
    console.log("dispatcher stub ready (P2 leases + P3 route).");
    const pkt = makeHandoff({ graph_id: "ut-2", node_id: "n1", assignee: "grok-bot", goal: "leases + VM" });
    console.log("handoff:", pkt, "sig:", signHandoff(pkt));
    const r = await routeDispatch("claude-code", "ut-2", "n1", "sess-vm");
    console.log("route claude:", r);
  })();
}
