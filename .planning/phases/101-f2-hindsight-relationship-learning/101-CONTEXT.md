# Phase 101: F2 Hindsight relationship learning - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

A relation extractor records cross-file and cross-markdown relationships (imports, references, phase dependencies) into Hindsight banks with provenance; recall carries relationship context; new evidence updates relations (self-improvement loop).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **Extractor scope**: TS/JS imports + markdown links + phase `Depends on` edges; deterministic, no LLM needed for v1.
- **Storage**: Hindsight episodes with typed relation payloads; bank owner = extractor surface; provenance = source path + commit.
- **Recall join**: relationship context appended to recall replies as metadata, never mixed into content.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/planes/hindsight.ts` (retain/recall), `fabric/memory-fabric.ts` (Phase 84 routing precedent)
- Hindsight 0.9.1 api/worker live on VPS

### Established Patterns
- Bank = owner; no dual-write; fake-only tests; provenance metadata-only

### Integration Points
- F6 (Phase 105) consumes relationship-enriched recall

</code>

<specifics>
## Specific Ideas

User intent: Hindsight self-improves by creating relationships between files and markdowns, readable by other agents in realtime.

</specifics>

<deferred>
## Deferred Ideas

None. LLM-based relation inference is future work, not v1.

</deferred>
