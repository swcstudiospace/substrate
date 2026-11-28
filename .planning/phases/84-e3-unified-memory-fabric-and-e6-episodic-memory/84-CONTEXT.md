# Phase 84: E3 unified memory fabric and E6 episodic memory - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

E3 unified memory fabric + E6 episodic memory: remember/recall/summarise/forget over Hindsight banks (owner) + LightRAG provenance (reader only); session outcomes indexed with provenance, supercession visible. No silent competing writers. Gate-aware via DG-1b (Dragonfly shared-context consumption per E2 rules).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Hindsight owns the bank**: `planes/hindsight.ts` retain/recall remain the only writers; LightRAG path writes provenance rows only (`lightrag-provenance` input validation), never memory banks.
- **Fabric seam**: new `fabric/memory-fabric.ts` with `MemoryFabric` routing `remember→Hindsight`, `recall→Hindsight+LightRAG provenance join` (provenance metadata only, no LightRAG content writes), `forget→Hindsight forget`.
- **Episodic record**: session outcome `{session_id, graph_id, outcome, summary, provenance}` appended to ledger (Greptime `agent_events` style) + retrievable via `session_registry`/`graph_get`; supercession links prior episode via `supersedes_id`.
- **No competing writers**: any LightRAG write attempt through the fabric is rejected (audit event).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `planes/hindsight.ts` (retain/recall/forget), `planes/lightrag.ts` (query/provenance), `service.ts` memory surfaces, `session-registry.ts` (Phase 83)

### Established Patterns
- Hindsight bank = owner; provenance carries source bank + hash; forget is mark-not-delete (v1.6 phase 57/60); strict TS; fake-only tests

### Integration Points
- `memory_write` / `memory_recall` / `memory_forget` MCP tools; ledger append for episodic outcomes
- E4 orchestration (Phase 85) consumes fabric routes; this phase only produces the fabric + episodic record + tests

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/enhancement-design.md` E3/E6 rows, `.planning/execution-plan.md` Lane D (Hindsight bank owner; LightRAG provenance-only), `.planning/audit/baseline.md` (Hindsight = owner; no dual-write).

</specifics>

<deferred>
## Deferred Ideas

None. RAG hybrid tuning (LightRAG graph mode) belongs to Phase 46 debt, not here.

</deferred>
