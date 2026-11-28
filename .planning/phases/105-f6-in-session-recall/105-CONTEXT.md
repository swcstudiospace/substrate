# Phase 105: F6 in-session recall - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

On-demand recall during sessions (brief + ad-hoc queries) with provenance and a latency budget; misses degrade gracefully with explicit gaps, never fabricated.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **Path**: single `recall` entry serving brief-prefill + ad-hoc tool calls; budget enforced via deadline (fallback: Hindsight-only, then empty-with-reason).
- **Provenance**: every hit carries bank + document + freshness; gaps explicit.
- **Budget**: default 1.5s (brief path precedent); tunable flag, tested with fake timers.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `memory_brief`/`memory_search`/`memory_recall` surfaces, Hindsight recall, LightRAG query, Phase 84 fabric routing

### Established Patterns
- Latency budgets with degraded answers; no fabricated content; fake-only tests

### Integration Points
- Consumes F2 relationship context; F7 exercises the path live

</code>

<specifics>
## Specific Ideas

User intent: Substrate should be able to recall during sessions — memory/provenance available mid-session.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
