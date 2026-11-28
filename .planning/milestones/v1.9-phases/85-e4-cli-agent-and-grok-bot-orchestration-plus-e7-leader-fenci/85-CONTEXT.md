# Phase 85: E4 CLI Agent and Grok Bot orchestration plus E7 Leader fencing - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

E4 CLI Agent + Grok Bot orchestration (delegation handoffs with namespace + permission model, per-agent audit) + E7 Leader fencing (single-writer session mutation gate with TTL'd queueing and dead-letter surfacing). Reuse Phase 83 SessionRegistry ownership and Phase 58 signed handoffs; no new coordination store.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Handoff packet**: reuse signed `coord_handoff` (goal/files/DoD/blockers/prev_event_hash) + namespace (`agent:<surface>`) + permission model (allowlist from Phase 72 repo allowlist).
- **E7 fencing**: `leaderFence.acquire(session, worktree)` issues a fencing token on lease renewal (`lease_id` + epoch CAS); stale fencing tokens are rejected (epoch mismatch) — single-writer guaranteed.
- **TTL queueing + DLQ**: delegation queue entries carry TTL (default 900s lease TTL); expired/dead entries move to dead-letter surface (count + list via `substrate handoff list`), never silently dropped.
- **Audit**: every handoff/fence event is appended to ledger with actor/surface/session attribution.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 83 `session-registry.ts` (operator/lease reuse), Phase 80/81 gate, `coord_handoff` signed packets, Phase 72 allowlist (`repo allowlist and scoped credentials`), `graph_claim`/`graph_release` holder checks

### Established Patterns
- Lease holder = (surface, session_id), epoch CAS, TTL 900s; signed handoffs with prev hash; fail-open reads; fake-only tests

### Integration Points
- `coord_handoff` MCP surface; CLI `substrate handoff` + `substrate queue` surfaces; audit ledger query

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/enhancement-design.md` E4/E7 rows, `.planning/execution-plan.md` Lane E (namespace + permission model, TTL queueing, dead-letter surfacing).

</specifics>

<deferred>
## Deferred Ideas

None. Fair-queue priorities beyond TTL expiry belong to a later orchestration phase if proven necessary.

</deferred>
