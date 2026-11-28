# Phase 82: E2 Dragonfly shared-context cache for CLI Agents and Grok Bot - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

E2 Dragonfly shared-context/output cache for CLI Agents and Grok Bot. Build on the DG-1a/DG-1b gate (`dragonflyGateVerdict`, `SUBSTRATE_DRAGONFLY_GATE`) and the existing `ReadThroughCache`: namespaced session/worktree context + recent output + hot-retrieval results, per-class TTL, Lua atomic slots for claim-style writes, and a tested fallback to durable read. No E1 steering, no memory-fabric changes (Phase 83/84).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Reuse `ReadThroughCache`** (`cache.ts`): add a `sharedContext` lane (namespace `substrate:v1:shared:`) alongside brief/search classes — no second client.
- **Key namespace**: `substrate:v1:shared:<agent>|<graph>|<kind>:<stable-key>` — agent = `herdr|claude-code|grok|s reminiscent`, kind ∈ {context, output, recall}. `classOf()` maps `shared` → per-class TTL (60s output, 300s context, 600s recall — revisit from `CACHE_TTL`).
- **Lua atomic slot claim**: `eval` script `if hincrby...` claim-once per key (caller supplies `claimId`, server returns won/lost) — single round-trip, no client-side race. Reuse the `eval` seam already in `CacheRedis`.
- **Fallback (tested)**: gate `unavailable/unconfigured` OR expired → durable fetch (existing `load`) or `request.load()`; stale never served fresh; `bypasses` counted.
- **Gate-aware**: `off` behaves as today; `enforce` blocks serving shared cache on non-ok verdict (except `degraded`).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cache.ts` `ReadThroughCache`, `CACHE_CLASSES`, `CLASS_TTL`, `classOf`, `bunRedis` (gated/deadline `run`), `eval` seam, gate wiring from Phase 81 (`gateAllows`, `gateMode`)
- `fabric/dragonfly-readiness.ts` `dragonflyGateVerdict()`
- Scripts: `scripts/cache-stats.ts` (INFO keyset)

### Established Patterns
- Namespace + generation counters (`substrate:v1:*`); TTL per class; `bypasses` metrics; fake-only tests

### Integration Points
- `createReadThroughCache` (service wiring) — shared lane reads/writes
- E1 (Phase 83) and E3 (Phase 84) consume shared keys; this phase only produces the substrate + tests

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/enhancement-design.md` E2 row, `.planning/execution-plan.md` Lane B (cache-aside, TTLs, Lua atomic slots; fallback tests), `.planning/audit/baseline.md` (cache-only Dragonfly, non-sensitive only).

</specifics>

<deferred>
## Deferred Ideas

None. Lua slot semantics beyond claim-once (fair queueing, priorities) belong to E4/E7 (Phase 85) if needed.

</deferred>
