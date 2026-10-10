---
phase: 25-docs-search-and-ingest-ragflow
plan: "03"
subsystem: docs-datasets
tags: [ragflow, datasets, refresh, degradation, runbook]
requires: [25-02]
provides: [dataset-lifecycle, plane-docs, gated-live-inventory]
affects: []
tech-stack:
  added: []
  patterns: [discover-first-resolve, warn-once-degradation, rehearsal-first-gated-live]
key-files:
  created:
    - packages/mcp-server/src/docs-datasets.ts
    - packages/mcp-server/src/docs-datasets.test.ts
    - docs/docs-search-ingest.md
    - docs/runbooks/docs-proof.md
    - .planning/phases/25-docs-search-and-ingest-ragflow/25-VALIDATION.md
  modified:
    - packages/mcp-server/src/planes/ragflow.ts
    - packages/mcp-server/src/ragflow-fake.ts
    - packages/mcp-server/src/docs-search.ts
    - docs/data-planes.md
    - .env.example
decisions:
  - "createDataset lives in planes/ragflow.ts and the fake grows a create route (both outside the plan's file list — the client is the natural home; noted, not hidden)"
  - "DatasetPin.ingested_at and citation pin_age_ms are optional: pre-ingest replies are unchanged, degraded serves carry the age"
  - "Version numbers derive from max existing + 1 so retention eviction never reuses a number"
  - "No service.ts hook wiring this phase: the sync tick's projection step (Phase 22 code) calls noteSkillsSyncFastForward; the entry point ships, the call site is not this phase's"
metrics:
  duration: "~75 min"
  completed: "2026-10-10"
actuals:
  tokens: 70000
  tasks: 3
  commits: 4
status: complete
---

| 1 | Build dataset resolve plus refresh plus degradation hook | 446d50d | docs-datasets.ts, docs-datasets.test.ts, planes/ragflow.ts (createDataset), ragflow-fake.ts (create), docs-search.ts (pin age) |
| 2 | Document the plane and update the data-planes wiring row | 1274c30 | docs-search-ingest.md, data-planes.md, .env.example |
| 3 | Map the G1-G4 gated live steps and stop (checkpoint) | 79dc28c | docs-proof.md, 25-VALIDATION.md |
documentation, and the G1-G4 gated inventory — rehearsal proven, live
steps untouched.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Build dataset resolve plus refresh plus degradation hook | (lifecycle) | docs-datasets.ts, docs-datasets.test.ts, planes/ragflow.ts (createDataset), ragflow-fake.ts (create), docs-search.ts (pin age) |
| 2 | Document the plane and update the data-planes wiring row | (docs) | docs-search-ingest.md, data-planes.md, .env.example |
| 3 | Map the G1-G4 gated live steps and stop (checkpoint) | (gates) | docs-proof.md, 25-VALIDATION.md |

## Must-haves

- Datasets exist by name and refresh as documented, keeping the last five versions: TRUE (resolve reuses, create only on miss with TEI bge-small; 7 refreshes keep v3–v7 with monotonic numbers)
- agent-skills refresh degrades explicitly with warning and pin-aged serve while sync is not live: TRUE (warn-once `skills-sync-not-live`; serve carries pin + age; age in search reply; fast-forward flips live)
- Every real RAGFlow touch is an explicit OPERATOR-GATED step the executor performed none of: TRUE (G1–G4 mapped with commands, proof reads, rollbacks; zero live calls)

## Deviations from Plan

Behavior: none. Three file-scope notes (all above): createDataset + fake
create route outside the plan's file list; pin-age touches docs-search.ts;
no service.ts wiring (the sync-tick call site belongs to Phase 22).

Two repairs during execution, both caught before commit: a mis-anchored
edit briefly dropped `commit` from DatasetPin (restored, tsc-clean), and
a test over-asserted the commit fallback across unpinned datasets
(scoped to the pinned dataset).

## Verification

- `bun test` datasets (9 tests) plus all 25-01/25-02 suites: green
- `bunx tsc --noEmit`: clean
- `grep -c OPERATOR-GATED`: 5 in runbook, 2 in validation map
- `grep -c planes/ragflow.ts`: data-planes + plane doc name the new reader

## Threat Flags

None beyond the plan's register (T-25-09..T-25-11 mitigated; refresh
fires only on fast-forward evidence; discover-by-name prevents
duplicates; no new npm packages).

## CHECKPOINT

**Type:** human-verify
**Gate:** blocking (autonomous:false plan; G1–G4 are operator approvals)
**Progress:** 3/3 tasks complete; executor stopped before any live touch

**Awaiting:** operator approval per gate in `docs/runbooks/docs-proof.md`
(G1 probe → G2 discovery/creation → G3 ingest → G4 served search), each
with its proof read pasted into the phase report before the next gate.

## Self-Check: PASSED

- All created files exist; lifecycle/docs/gate commits in log; no live system touched.
