# Phase 83: E1 Live Steering multi-worktree sessions - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

E1 Live Steering multi-worktree sessions: a `SessionRegistry` over existing `graph_nodes`/`graph_bindings` leases + `live_session_bindings`, exposing which sessions are live for which worktree, with a single operator per session via CLI (settled decision) and conflict detection when two sessions target the same files. Reuse — do not duplicate — phase 58 (durable steering), 67 (Live Steering GA), 68 (Worktree Fleet), 71 (multi-session boundary).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Registry is a view, not a new store**: `SessionRegistry` reads `graph_nodes` (claimed_by/lease/epoch) + `live_session_bindings` + `worktrees` tables; no schema migration (adopt-gate: no new time-series tables; hypertable policy honored).
- **Single operator via CLI**: `substrate session operator --session <id> --take|--release` (release via `graph_release`); only the operator session can mutate steering for that worktree — enforced by reusing the existing lease-holder check (`holder=(surface,session_id)`), not a new auth layer.
- **Conflict detect**: `substrate session conflicts [--graph <id>]` lists (worktree, file) pairs claimed by ≥2 live sessions; read-only, sorted, deterministic.
- **Gate-aware**: read paths degrade to last-known when Dragonfly/Timescale unavailable (fabric style, never throw).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/index-store.ts` — `graph_nodes`, `graph_bindings`, `live_session_bindings`, `worktrees` rows
- Planning/worktree modules: `planning/` (present + session binding), worktree fleet (68), steering (58)
- CLI: `packages/cli/src/` — command shape, `SubstrateConfig` reuse

### Established Patterns
- Lease ops (`graph_claim`/`heartbeat`/`release`/`complete`) with `lease_id` + epoch CAS; strict TS; fake-only tests

### Integration Points
- `graph_get`/`session banner` reads; CLI surface only (no HTTP routes)
- Consumed by E4 orchestration (Phase 85); this phase only produces registry + CLI + conflict detect

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/enhancement-design.md` E1 row, `.planning/execution-plan.md` Lane C (SessionRegistry + live-session bindings; single-operator CLI), `.planning/audit/baseline.md` (§2 single-operator via CLI).

</specifics>

<deferred>
## Deferred Ideas

None. Cross-worktree steering fan-out and fair-queueing belong to E4/E7 (Phase 85).

</deferred>
