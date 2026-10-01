# Research Proposal: Self-Improving Memory Bank + DB Schema Upgrades + Realtime Event Model (n5/n6/n7/n8)

**Graph**: ut-muovla5o-7fc9086d
**PR**: https://github.com/swcstudiospace/agent-substrate/pull/10
**Date**: 2026-10-01 (post v1.0 milestone archive)
**Scope**: Proposal + design only. No migrations, no new services, no ROADMAP/STATE edits during research. Sidebar to main autonomous work.

## Current State (Fresh Inventory, 2026-10-01)

**No in-repo database engines or migration tools** (confirmed via rg + file scan):
- No sqlite, prisma, alembic, schema.sql, migrations/, docker-compose in repo.
- All persistence via **substrate-mcp only** to Railway backing stores.

**Backing (all accessed exclusively through substrate-mcp; private endpoints):**
- **GreptimeDB** (events ledger): `agent_events` (append-only with `append_mode=true`, hash+prev chain from Phase 6, fail-closed on rewrite). `events.emit` normalizes + hashes on ingest.
- **Postgres/Timescale** (index): `graph_index`, `graph_nodes` (leases: expires/heartbeat/token, claimed_*), `graph_steps`, `memory_entries` (id, scope, kind, body, source_event, writer, trust, ttl, created; GIN FTS on body), `anchors` (hourly Merkle + Solana).
- **DragonflyDB** (ioredis, Railway): brief snapshots (graph_id → JSON, TTL), write outbox (degraded path), policy cache, lease mirror (TTL), circuit breakers. Governance (ADR-0001/2) uses it heavily.

**File layer (durable, git-auditable, source of truth for plans):**
- `.planning/phases/*/{CONTEXT,PLAN,SUMMARY}.md` (and archived v1.0-phases).
- `.substrate/BRIEF.md`.
- Phase SUMMARY finalization + explicit "Lesson" tags are the de-facto write points today.
- Brief composed from: index (graphs/claims) + Greptime (recent actions) + memory_entries (warnings/decisions) + Dragonfly snapshot (degraded).

**Current gaps (for n5/n6):**
- No explicit "memory bank" records with phase/milestone linkage, citation IDs, success scoring, or digest rollups.
- No structured phase lifecycle events (`phase.started|blocked|awaiting_decision|completed`, `plan.generated`, criteria pass/fail).
- Realtime: polling + outbox via Dragonfly only. No push (LISTEN/NOTIFY would require confirmed Postgres primary + approval).
- No embeddings/vector (sqlite-vss or pgvector never present).
- Self-improving: none (no weighting, no auto-digest beyond manual SUMMARYs). Manual gating only so far.
- Hindsight: Railway app (evidence/llm traces via events); generic "memory bank" concept here.

**Leverage underused features (v0.3 SOTA):**
- Timescale hypertables + compression/continuous aggregates on events.
- Greptime append_mode + compaction/TTL.
- Dragonfly for hot snapshots/outbox/leases + policy.
- Postgres JSONB + FTS + lease CAS already in use.
- Existing policy gate + redaction + hash chain + Solana anchors.

## n5: Self-Improving Memory Bank Proposal

**Design (storage-agnostic first, then map to current backing):**

**Record schema** (extend `memory_entries` or add `memory_records` table/view; also emit as kind `memory.record`):
```json
{
  "id": "uuid-or-content-hash",
  "phase_id": "01-lane-b",
  "milestone_id": "v1.0",
  "timestamp": "...",
  "type": "lesson|decision|edge|outcome|observation",
  "summary_text": "...",
  "outcome": "success|partial|blocked|deferred",
  "success_score": 0.0-1.0 (initial from SUMMARY, updated on reuse),
  "source_path": ".planning/.../SUMMARY.md:42",
  "tags": ["teachable-moment", "handoff", "lease-race", "a2a"],
  "embedding": null,  // Phase 2 only
  "citation_id": "mem:uuid"   // always present for PLAN citation
}
```

**Write triggers (only at explicit boundaries):**
- Auto: on SUMMARY.md finalization (extract ## Lesson / outcome / edge cases).
- Manual: `## Lesson` or `## Edge` blocks in CONTEXT/PLAN (flagged by writer).
- Always: go through governed `memory.write` (policy gate from Phase 0.5).
- Never: hidden runtime injection.

**Retrieval / ranking (v1, no vector):**
- At "discuss" step only: top-K (recency_decay * success_score * keyword/tag_match) injected visibly into CONTEXT.md.
- Every use in a PLAN.md **must cite record ID** (e.g. `mem:abc123`).
- User can audit/veto by ID.

**Pruning / self-improving (gated):**
- No deletion. Old records rolled into milestone-digest (one summary row per milestone after N phases).
- Originals archived to cold git path (`.planning/milestones/.../memory-digests/`).
- Self-improving v1: success_score bumped on later citation + observed outcome (e.g. "this lesson prevented a bug").
- Agent-driven auto-weighting or pruning: **explicit user sign-off required first** (manual-gated initially). No silent self-improvement.

**Integration:**
- Discuss: retrieve + inject with citations.
- Summary: extract + write + score.
- Ledger tie-in: memory records can be anchored (Phase 6 style) for teachables.
- A2A: teachable moments become special `type: teachable-moment` records surfaced in AgentCard.skills[].

**Backing map (current, no new infra):**
- Hot: Dragonfly snapshot + Postgres `memory_entries` (extend columns).
- Durable: git files + Greptime event emission of the record.
- Optional future (after approval): sqlite-vss or pgvector for embeddings.

**Proof for proposal**: A past phase SUMMARY produces a citable record; discuss injects it with ID; PLAN cites it; digest rolls old ones.

## n6: Database Schema Upgrades + Realtime Event Model

**Grounded recommendation**: **Extend existing** (Postgres index + Greptime events + Dragonfly) rather than introduce new SQLite. Zero new infra, leverages governance/leases/append-only already shipped in v1.0. SQLite fallback only if user explicitly rejects Railway backing.

**Proposed extensions (additive, non-breaking):**

**Phase lifecycle table** (in Postgres index, or derived view over events):
- `phase_lifecycles(id, graph_id, node_id, phase_name, status, started_at, completed_at, blockers_json, decisions_count, last_event_id)`
- Or simply emit structured events and derive.

**Structured events** (extend EVENT_KINDS + Greptime payload):
- `phase.started`, `phase.blocked`, `phase.awaiting_decision`, `phase.completed`
- `plan.generated`, `acceptance_criteria.passed|failed`
- `memory.record_written`, `lease.stolen`, `handoff.signed`
- Payload: JSONB (already supported) + graph/node/phase refs.

**Outbox + realtime transport (grounded in "nothing push exists today"):**
- Primary: Dragonfly outbox list (already used for degraded writes) + polling consumer (current collector style).
- Push option: thin SSE/websocket server that tails new Greptime/Postgres rows (or Dragonfly stream).
- Webhook/Slack/Telegram on `phase.blocked|awaiting_decision` (reuse existing stop-notify path).
- Exactly-once: use existing event hash/prev + outbox dedup.
- No LISTEN/NOTIFY until explicit Postgres primary confirmation + user approval.

**Leverage underused features:**
- **Timescale**: Convert/partition `agent_events` or new phase table as hypertable → time-series queries, compression, continuous aggregates (phase duration, block rate, p95 discuss time).
- **Greptime**: Use append_mode + TTL/compaction already enforced; add structured columns for phase events.
- **Dragonfly**: Extend snapshot/outbox/lease for phase state cache + low-latency "current open phases".
- **Postgres**: JSONB for all payloads, GIN/FTS already on memory, add indexes on (graph_id, phase_name, status), lease CAS already present.
- **Ledger tie-in**: New events participate in hash chain + Solana anchors (teachables + phase lifecycle).

**Tradeoffs (explicit for sign-off):**
- Extend current (low effort/risk, seconds latency via polling/SSE, reuses Dragonfly/governance): recommended.
- New SQLite (file-based, git-friendly, but duplicates existing index + requires new client/migrate path).
- Full Postgres push (LISTEN/NOTIFY + JSONB power): only after confirming Railway Postgres is primary target + approval. Higher infra commitment.

**Consumer example**: Local dashboard (static HTML + SSE) or Slack alert on blocked/awaiting showing live phase status + citation to record ID.

## n7: Critique — What's Missing/Ambiguous (Updated with Scan)

1. **DB inventory**: Confirmed none in-repo (rg scan + package/docker review). Backing is exclusively Railway via substrate-mcp. SQLite-first in original n6 draft is **overridden** — recommend extend existing.
2. **"Hindsight"**: Railway app (evidence + LLM traces via events). Treat as generic memory concept here; confirm if specific lib intended.
3. **Parallel vs queue**: This research ran as parallel sidebar (per original scope + PR). Now v1.0 autonomous complete, proposals can feed v1.1+ or new milestone. No ROADMAP/STATE touched.
4. **Self-improving automation**: Explicitly gated. Recommend manual-only writes + human/approval gate for weighting/pruning initially. Agent auto only after separate sign-off.
5. **If DB found later**: Re-draft n5/n6 against real schema (not needed — scan clean).
6. **Other ambiguities resolved**:
   - Current memory is hybrid (files + indexed + Dragonfly snapshot) — proposal formalizes rather than replaces.
   - Realtime latency: seconds via polling/SSE acceptable for phase visibility; instant push requires infra decision.
   - Teachables/A2A already partially in v1.0 (Phase 4/6) — memory bank extends them.

**Open for user**:
- Confirm extend-Railway vs introduce SQLite.
- Manual-gated self-improving only?
- Run proposals as v1.1 phases or separate milestone?
- Any specific Hindsight details?

## n8: Prioritized Proposal + Sign-Off

**Tier 1 (low effort/risk, immediate — candidate small incremental phase or docs update)**:
- Formalize memory bank: extend `memory_entries` + file SUMMARY extraction + citation-by-ID in discuss/plan.
- Add structured phase events + outbox/SSE stub (Dragonfly + polling).
- Milestone digests + basic success scoring.

**Tier 2 (medium, high leverage — separate milestone)**:
- Timescale hypertables + continuous aggregates on events.
- Full outbox + webhook/SSE dashboard for phase lifecycle.
- Digest pruning + teachable anchoring in memory bank.
- Leverage Dragonfly more for phase state.

**Tier 3 (higher effort/risk, deferred)**:
- Vector similarity (pgvector or sqlite-vss) — only after DB target approved.
- True push (LISTEN/NOTIFY) — requires Postgres confirmation.
- Agent-driven self-improving weighting/pruning beyond gated.

**Must resolve before scheduling**:
- DB target confirmation (extend vs new).
- Hindsight clarification.
- Parallel/queue decision.
- Sign-off on manual-gated writes vs agent auto.

**Evidence in this proposal**: All grounded in current code (index-store DDL, event hash chain, brief composition, Dragonfly governance ADRs, Greptime append-only, leases). No unapproved scope.

**Next**: User sign-off per tier. On approval, create phase(s) via normal gsd process (no silent edits).

---

**Verification for this research**:
- Scan output + code reads confirm "no in-repo DB".
- Designs compatible with v1.0 shipped (governance, leases, append-only, Dragonfly, hash chain, A2A stubs).
- PR #10 + Linear/Notion updates carry the proposal.

Ready for review / sign-off.
