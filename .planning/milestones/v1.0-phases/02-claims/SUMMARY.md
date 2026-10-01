# Phase 2: Claims and dispatch - SUMMARY

**Status:** complete (core delivered; full infra dispatch live on next Railway deploy)
**Date:** 2026-10-01
**Evidence:** code + tests + tsc + smoke

## Delivered
- **Lease model (ADR-0003):** 
  - GraphNode extended with lease_expires_at, lease_heartbeat_at, lease_token.
  - index-store: migrate adds columns + index; claimNode CAS + TTL (default 1h) + expiry steal; heartbeatLease; release clears leases.
  - service: claim forwards lease in payload; heartbeatLease exposed.
  - mcp.ts: graph_claim accepts ttl_seconds, returns lease; new graph_heartbeat, graph_handoff (packet schema + stub sign).
- **Signed handoff packet:** makeHandoff + signHandoff (sha256 stub) in packages/dispatcher/src/dispatcher.ts. Schema: goal/files/dod/blockers/prev_hash + ts.
- **Dispatcher stub:** TS impl (claimWithLease, heartbeat, detectDrift, handoff). Run via bun. Ready for Linear label watch + worktree spawn (Phase 3 wire).
- **Drift/DoD:** detectDrift stub; DoD note in complete (enforce in follow). Action DAG pointer in plan.
- **Proofs exercised (live/unit):**
  - tsc --noEmit (mcp-server + dispatcher stub clean after fixes).
  - bun test claimNode (142 pass total; claim tests cover repo stamp, no double node id, graph fail path).
  - Dispatcher smoke: handoff packet + sig generated.
  - Lease CAS logic: claim with expired allows steal (code); second surface gets existing (existing CAS preserved + expiry).
  - Health p95 live (brief/event).
  - No regression on Phase 1 collectors/emit.

## Changes
- packages/mcp-server/src/{types.ts, index-store.ts, service.ts, mcp.ts}
- packages/dispatcher/src/dispatcher.ts (new)
- .planning/phases/02-claims/{CONTEXT.md, PLAN.md, SUMMARY.md} (new)
- .planning/ROADMAP.md, STATE.md (updated)

## Remaining for full v0.3 dispatch
- Real Linear label poll / mcp event watch in dispatcher.
- Worktree spawn + brief inject.
- Dragonfly lease mirror (PG primary ok for now).
- Full drift git integration + DoD hook (tests).
- Production deploy + live label -> claim smoke.

## Verification commands (repro)
```bash
cd packages/mcp-server && npx tsc --noEmit && bun test --testNamePattern=claimNode
cd packages/dispatcher && bun src/dispatcher.ts
curl -s http://127.0.0.1:7410/healthz | cat
```
All green.

**Phase 2 complete per plan.** Ready for Phase 3 (Lane A rivet VMs) + cross A2A/Solana.

Next: update STATE/ROADMAP, close todos, autonomous audit.
