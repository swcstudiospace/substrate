# Requirements: Agent Substrate v1.9 Wave 8

**Defined:** 2026-11-28
**Core Value:** CLI Agents and Grok Bot share one briefing, one event log, one skills library and one task key across Hindsight, LightRAG, DragonflyDB, GreptimeDB and TimescaleDB.

## v1 Requirements

### DG Gate

- [ ] **DG-1a**: System has a Dragonfly readiness probe/gate that reports whether DragonflyDB is running, healthy and within capacity before any E2 cache work
- [ ] **DG-1b**: Gate decision is implemented or documented: either the gate blocks E2 on not-ready, or records why it does not

### E2 Cache

- [ ] **E2-01**: Dragonfly shared-context cache serves CLI Agents and Grok Bot with cache-aside, TTLs and Lua atomic slots
- [ ] **E2-02**: Cache fallback to durable read is tested; stale/expired data is never served fresh

### E1 Steering

- [ ] **E1-01**: Live Steering sessions support multi-worktree execution via SessionRegistry and live-session bindings, single operator per session via CLI

### E3/E6 Memory

- [ ] **E3-01**: Unified memory fabric separates Hindsight bank ownership (writer) from LightRAG provenance (reader) with no silent competing writers
- [ ] **E6-01**: Episodic memory records session outcomes indexed with provenance, supercession visible

### E4/E7 Orchestration

- [ ] **E4-01**: CLI Agent + Grok Bot orchestration uses delegation handoffs with namespace and permission model
- [ ] **E7-01**: Leader fencing enforces single-writer session mutation with TTL'd queueing and dead-letter surfacing

### E5/E8 Observability

- [ ] **E5-01**: Observability loop carries correlation IDs across Timescale/Greptime/Dragonfly with dashboards and burn alerts
- [ ] **E8-01**: Session replay/audit appends to append-only audit with replay-to-checkpoint; summary mirrors to Linear/Notion read-only

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Plug-ins

- **PLUG-01**: Probe adapter (optional — decisions via code review, not a phase)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Hypertable conversion of non-time-series tables | Adopt-gate not met; only justified for proven volume |
| Reversible LightRAG→RAG-backend cutover | Owner decision 2026-11-16: not reversible |
| Leader as primary writer | Leader is GPX gate; Greptime owns ledger writes alone |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DG-1a | Phase 80 | Complete |
| DG-1b | Phase 81 | Complete |
| E2-01, E2-02 | Phase 82 | Complete |
| E1-01 | Phase 83 | Complete |
| E3-01, E6-01 | Phase 84 | Complete |
| E4-01, E7-01 | Phase 85 | Complete |
| E5-01, E8-01 | Phase 86 | Complete |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0 ✓

---
*Requirements defined: 2026-11-28*
*Last updated: 2026-11-28 after Wave 8 milestone creation; statuses → Complete 2026-11-28 after all 7 phases verified passed*
