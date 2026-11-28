# Phase 102: F3 Greptime event-driven doc refresh - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

Agent/file-change events recorded in Greptime trigger debounced, coalesced LightRAG re-ingest of affected docs; failures surface to dead-letter; no event loss across restarts.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **Event source**: Greptime `agent_events` filtered to file/change kinds; cursor persisted (durable offset, survives restarts).
- **Debounce/coalesce**: per-doc window (default 60s), bursts collapse to one re-ingest; DLQ entry after bounded retries.
- **Reuse**: F1 ingest path for the actual re-ingest (single writer).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Greptime ledger client (`packages/ledger/src/`), LightRAG ingest client, Phase 76 telemetry buffer/DLQ precedent, Phase 80-81 gate patterns

### Established Patterns
- Append-only ledger; fail-open reads; fake-only tests

### Integration Points
- F1 ingest path; F5 steering consumes refresh events

</code>

<specifics>
## Specific Ideas

User intent: Greptime events enable quick updates for LightRAG — a nice RAG + graph kept fresh by the event stream.

</specifics>

<deferred>
## Deferred Ideas

None. Backfill of historical events is out of scope (forward-only).

</deferred>
