# Phase 2: Claims and dispatch - CONTEXT

**Source of truth:** Agent Substrate Build Plan (Notion) + v0.3 SOTA Addendum.
**Phase Goal:** Linear labels drive who works on what. Graph-of-Thought claims become lease-backed, single-holder, replayable via signed handoffs. Dispatcher watches, spawns, enforces DoD.

**Current state (post Phase 1):**
- Phase 0 live: substrate-mcp on Railway (Greptime + Timescale).
- Phase 1: collectors (grok, herdr, orca-tee), GrokBot connector v0.4, substrate-yaml-projector, OTLP p95 in health, graph_claim/release/complete partial CAS in index-store + service.
- Graph index in Postgres (via Railway). Nodes have claimed_by, claimed_at, claim_session.
- ClaimNode already does CAS (null or same surface).
- ADR-0003 accepted: lease model + signed handoff foundations.
- No TTL/heartbeat/lease table yet. No signed handoff packet. Dispatcher is pyc-only (no source).
- Surfaces: claude-code, hermes, omp, grok-build, grok-bot, muse, cursor, rivet.
- A2A Agent Cards / teachable moments planned Phase 4; Solana anchors Phase 6.

**Success Criteria (ROADMAP v0.3):**
1. graph.claim returns lease (holder, expires_at, token) or existing. CAS prevents double-claim.
2. graph.release / graph.complete ends lease, emits.
3. substrate-dispatcher watches `dispatch:<surface>` (or Linear labels), spawns per-graph worktree, calls claim with signed packet.
4. Leases have TTL + heartbeat (Dragonfly mirror or PG). Steal emits `lease_stolen`.
5. Signed handoff packet: canonical {goal, files, DoD, blockers, prev_event_hash, graph_id, node_id, assignee}. Signed or hashed.
6. Drift scan: git state vs events/claims flags stale.
7. DoD gate respected before release.
8. Proof: no double-claim, dispatch claim produces work, drift warning, replay from handoff.

**v0.3 Enterprise SOTA additions:**
- Production: leases with TTL/heartbeat, signed replayable handoffs, circuit on steal.
- Multi-surface dispatch (claude, hermes, grokbot, rivet).
- Audit: claim events carry lease token + handoff hash.
- Dragonfly for low-lat lease state (outbox).
- No double work; respect DoD (tests green, no open blockers).

**Constraints:**
- Postgres index (Railway) is cache; Notion/Linear source of truth.
- Fail closed on lease conflict.
- Additive to Phase 1 collectors/emit.
- Compatible with v0.2 claims (no lease = eternal until release).
- No QEMU/KVM; host is bare.
- Use existing substrate.yaml, mcp tools pattern.

**Dependencies:**
- Phase 0 infra.
- Phase 1 Lane B surfaces + OTLP.
- Phase 0.5 governance (policy, redaction).

**Risks:**
- Race on claim without proper CAS.
- Dispatcher source missing (pyc only) → need restore/impl.
- Dragonfly not yet wired for leases (Phase 0 infra has it for memory?).
- Drift detection needs git integration.

**Decisions made:**
- Extend GraphNode with lease_* fields.
- Add lease table or columns + Dragonfly mirror.
- Claim returns lease info.
- Handoff via memory kind or dedicated event.
- Dispatcher: implement TS shim or recreate py for watch+spawn+claim.
- Proofs must be live (claim/release smoke, dispatch sim, drift).

**Next:** PLAN.md → implement leases, dispatcher, signed handoff, drift, proofs. Then artifacts update, STATE advance to Phase 3.

**References:**
- .planning/ROADMAP.md Phase 2
- docs/adr/0003-...
- packages/mcp-server/src/{index-store.ts,service.ts,mcp.ts,types.ts}
- Notion Agent Task Graph + Build Plan v0.2/0.3
