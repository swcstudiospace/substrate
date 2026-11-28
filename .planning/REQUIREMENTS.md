# Requirements: Agent Substrate v1.11 Live Fabric Interop (Wave 9)

**Defined:** 2026-11-28
**Core Value:** Substrate states stay live — FSM states-as-docs reflected in LightRAG in realtime, relationships learned, events refreshing docs, state shared across sessions, steering injected live, recall available mid-session.

## v1 Requirements

### F1 Live STATE reflection

- [ ] **F1-01**: Post-write hook ingests STATE.md + phase SUMMARY transitions to LightRAG with run lineage
- [ ] **F1-02**: Freshness SLI reports ingest lag; stale states detectable, never silently served

### F2 Hindsight relationships

- [ ] **F2-01**: Relation extractor records file/markdown relations (imports, refs, phase deps) with provenance
- [ ] **F2-02**: Recall returns relationship context; loop updates relations on new evidence

### F3 Event-driven doc refresh

- [ ] **F3-01**: File/change events in Greptime map to debounced, coalesced LightRAG re-ingest
- [ ] **F3-02**: Failed refreshes surface to dead-letter; no event loss on restarts

### F4 State sharing

- [ ] **F4-01**: SessionRegistry snapshot read API keyed by session/graph/worktree with freshness metadata
- [ ] **F4-02**: Cross-project reads work without credential leaks; degraded reads labeled

### F5 Steering injection v2

- [ ] **F5-01**: Subscription filters select steering-worthy events; injections idempotent + ordered per session
- [ ] **F5-02**: Injection failures visible with retry; never duplicates a TODO

### F6 In-session recall

- [ ] **F6-01**: On-demand recall path serves brief + ad-hoc queries with provenance in budget
- [ ] **F6-02**: Misses degrade gracefully with explicit provenance gaps (never fabricated)

### F7 Ingest + steering test

- [ ] **F7-01**: All 15 repos ingested to live LightRAG with per-repo evidence (operator live window)
- [ ] **F7-02**: End-to-end test proves doc edit → event → refresh → state update → steering injection

## v2 Requirements

Deferred.

- **F8**: Cross-machine state sync over linked machines (linking exists; state sync future)

## Out of Scope

| Feature | Reason |
|---|---|
| Hypertable conversion of non-time-series tables | Adopt-gate not met (baseline guardrail) |
| Reversible LightRAG→RAG cutover | Owner decision 2026-11-16: not reversible |
| Solana anchor changes | No anchor work in this milestone; ledger as-is |
| History rewrite for secrets | Never without explicit HITL approval |
| Greptile review | Skipped per explicit operator approval (merge-no-greptile) |

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| F1-01, F1-02 | Phase 100 | Pending |
| F2-01, F2-02 | Phase 101 | Pending |
| F3-01, F3-02 | Phase 102 | Pending |
| F4-01, F4-02 | Phase 103 | Pending |
| F5-01, F5-02 | Phase 104 | Pending |
| F6-01, F6-02 | Phase 105 | Pending |
| F7-01, F7-02 | Phase 106 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-11-28*
*Last updated: 2026-11-28 after v1.11 milestone creation*
