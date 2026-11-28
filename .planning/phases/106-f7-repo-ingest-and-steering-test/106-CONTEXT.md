# Phase 106: F7 15-repo ingest verification + steering test - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — live test phase)

<domain>
## Phase Boundary

Ingest all 15 originally-provided repos to live LightRAG with per-repo evidence (operator live window granted), then prove the full loop: doc edit → event → refresh → state update → steering injection observed.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **Ingest**: reuse `scripts/lightrag_ingestion_orchestrator.py` state machine against live LightRAG; per-repo evidence rows (docs count, samples).
- **E2E proof**: controlled doc edit in a scratch repo → observe event → refresh → STATE/SUMMARY update → steering injection lands in a live test session's TODOs.
- **Safety**: scratch repos only; no production doc mutation; live window recorded in SUMMARY.
- **Ledgered intelligence proof**: one curated promotion (explicit action, content hash, rationale, session identity) → ledger receipt recorded → verify-on-recall shows trusted badge; duplicate hash spends nothing; outage queues pending with replay. Devnet only, fail-closed config; secrets redacted, never promoted.
- **Temporal + cache proof**: windowed recency queries reconcile out-of-order events without dupes (staleness detector fires past threshold); version-keyed cache hit preserves provenance, invalidation on state-version bump verified, outage still serves source-of-truth.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lightrag_ingestion_orchestrator.py` + `.lightrag_ingest_state.json`, 15-repos evidence doc, F1/F3/F4/F5 paths under test

### Established Patterns
- Live proofs recorded with evidence, never fabricated; operator-gated services documented

### Integration Points
- Exercises F1–F6 together; closes the Wave 9 loop

</code>

<specifics>
## Specific Ideas

User intent: with repos ingested, actually test steering properly — markdowns updating in realtime update states, update sessions, enable live steering.

</specifics>

<deferred>
## Deferred Ideas

None. This is the milestone-closing proof.

</deferred>
