# Phase 2: Claims and dispatch - PLAN

**Milestone:** Agent Substrate v1.0
**Phase:** 2 (Claims and dispatch) +2.x SOTA
**Depends:** Phase 1 (Lane B), 0.5 governance
**Duration target:** one wave (discuss done; plan->execute parallel where safe)

## Objectives
Implement lease-backed claims, signed handoff packets, dispatcher that watches Linear dispatch and spawns/claims, drift detection, DoD gate. All per ROADMAP + ADR-0003 + CONTEXT.

## Acceptance (must pass live smoke)
1. `graph_claim` (via mcp) returns `{claimed, node, lease?}`. CAS: second different surface gets existing.
2. Lease columns: expires_at, heartbeat_at, lease_token (or Dragonfly key). TTL enforced on claim.
3. `graph_release`, `graph_complete` clear lease, emit events.
4. Heartbeat tool updates lease.
5. Signed handoff: memory or event with schema {goal, files[], dod[], blockers[], prev_hash, assignee, ts}. Hash verifiable.
6. Dispatcher (TS or py source restored): watches dispatch labels or mcp events, for each graph spawns worktree, calls claim with packet, enforces single holder.
7. Drift: `substrate drift <graph>` or collector flags when git HEAD != last claim event state.
8. DoD: release only if tests/smokes pass (hook in complete).
9. No double work proof: two surfaces racing → one wins, other sees claim.
10. Proofs live: mcp claim/release, heartbeat, dispatch sim, drift flag, tsc, health p95, event emitted with lease.
11. Artifacts: update .planning/STATE.md, ROADMAP.md, SUMMARY.md, phase SUMMARY. Commit focused.

## Work Breakdown (parallelizable where no dep)
### 1. Schema + Index (mcp-server)
- Edit packages/mcp-server/src/types.ts: extend GraphNode with:
  lease_expires_at?: string | null;
  lease_heartbeat_at?: string | null;
  lease_token?: string | null;
  lease_holder?: Surface | null;
- Edit packages/mcp-server/src/index-store.ts:
  - migrate(): alter table graph_nodes add lease_* cols if not exists; add index.
  - claimNode(... , ttlSeconds = 3600): CAS update with expires; if steal emit lease_stolen via service?
  - releaseNode, completeNode: clear lease fields.
  - add heartbeatLease(graphId, nodeId, token): update heartbeat if holder matches.
  - getLease or return lease in claim result.
  - Add signedHandoff storage or use memory_entries with kind 'handoff'.
- Update GraphView to include lease info.
- Add driftScan(repoOrGraph): compare git vs last claim events (use exec git, event log).

### 2. Service + MCP layer
- packages/mcp-server/src/service.ts:
  - claimNode: wrap index, emit "claim" with lease fields.
  - add heartbeat, handoff emit.
  - completeNode: check DoD? (stub for now, later hook).
- packages/mcp-server/src/mcp.ts:
  - Enhance graph_claim response with lease.
  - Add/register: graph_heartbeat, graph_handoff, graph_drift.
  - Keep backward (old claims ok).

### 3. Signed Handoff Packet
- types.ts: interface SignedHandoff { graph_id, node_id, assignee: Surface, goal: string, files: string[], dod: string[], blockers: string[], prev_event_hash: string, ts: string, signature?: string }
- Implement sign/verify stub (sha256 of canonical json for v0.3).
- On claim/complete, attach handoff if present.

### 4. Dispatcher (critical - source missing)
- Option A (preferred for speed): add packages/dispatcher/src/dispatcher.ts (TS, reuse substrate client).
  - Watch via mcp or polling Linear labels 'dispatch:<surface>'.
  - For new dispatch: clone worktree per graph_id, inject brief via mcp, call graph_claim with handoff packet.
  - Enforce lease: poll or sub to events.
  - Heartbeat loop.
- Option B: recreate py in packages/dispatcher/src/substrate_dispatcher/dispatch.py etc from pyc decompile logic + plan.
  Since pyc only, go TS for now (consistent with mcp, cli).
- Add CLI entry or systemd unit pattern.
- Update substrate.yaml or projector for dispatcher surface.

### 5. Drift + DoD + Proofs
- Add drift command or endpoint.
- In complete: require state tests or smoke (flag).
- Smoke script: packages/mcp-server/src/claim-smoke.ts or extend existing.
  - Two surfaces claim same node → verify one wins.
  - Lease TTL expire sim.
  - Handoff roundtrip.
  - Dispatch sim (mock label -> claim).
- Run tsc, health, event emit with lease fields.
- Update tests: service.test.ts, index tests for new lease paths.

### 6. Artifacts & Close
- Write .planning/phases/02-claims/SUMMARY.md with evidence (smokes, tsc, diffs).
- Update .planning/STATE.md (phase=2 complete, progress).
- Update .planning/ROADMAP.md (mark [x] Phase 2, add notes).
- Update root docs if needed.
- GSD: mark todos done, next phase.
- Focused git? (later).
- Cross: ensure A2A/Solana prep (pointers only).

## Order & Waves
Wave 1 (core, blocking):
- types + index-store migrate/claim lease (CAS+TTL).
- service/mcp claim enhancement + heartbeat.
- handoff schema + emit.
Wave 2 (parallel):
- dispatcher impl (TS).
- drift + DoD hooks.
Wave 3:
- smokes, proofs, tsc, health.
- artifacts.
- verify all acceptance.

## Verification (live, no mocks for final)
- bun tsc --noEmit (mcp + dispatcher).
- curl healthz shows p95.
- bun ... emit claim events visible.
- Manual: two mcp clients claim race.
- substrate claim --graph X --node Y --surface A then B.
- Dispatch sim produces worktree + claim.
- Drift detects mismatch.
- All ROADMAP criteria exercised.

## Risks & Mitigations
- No py source: implement TS dispatcher (additive).
- Dragonfly lease: start with PG only; mirror later (Phase 5?).
- DoD enforcement: stub + note for Phase 3.
- Time: focus core claim/lease + basic dispatcher first; defer full drift if needed but prove.
- Tests: keep existing pass; new only for lease paths.

## Files to Change/Create
- .planning/phases/02-claims/CONTEXT.md (done)
- .planning/phases/02-claims/PLAN.md (this)
- packages/mcp-server/src/types.ts
- packages/mcp-server/src/index-store.ts
- packages/mcp-server/src/service.ts
- packages/mcp-server/src/mcp.ts
- packages/mcp-server/src/claim-smoke.ts (new)
- packages/dispatcher/src/dispatcher.ts (new, or py)
- packages/dispatcher/package.json (update if TS)
- .planning/phases/02-claims/SUMMARY.md (new)
- .planning/STATE.md, ROADMAP.md (update)
- tests/...

## Post-Phase
- STATE current_phase=3 "Lane A"
- ROADMAP Phase 2 [x]
- All Phase 2 todos done.
- Ready for rivet VM sessions (Phase 3).

**Evidence first.** Implement only what proves the 8 criteria. Boring over clever. Use existing patterns (CAS already there, extend it).

Start with schema changes. Use edit for precision. Smoke after each wave.
