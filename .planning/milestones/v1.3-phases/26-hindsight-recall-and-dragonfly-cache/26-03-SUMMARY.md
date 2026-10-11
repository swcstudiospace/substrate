---
phase: 26-hindsight-recall-and-dragonfly-cache
plan: "03"
subsystem: hindsight-cache
tags: [dragonfly, recall-cache, claims-freshness, redis-refusal, runbook, gated-live]
requires: [26-02-retain-forward]
provides: [recall-cache-coverage, redis-refusal, proof-runbook, validation-map]
affects: []
tech-stack:
  added: []
  patterns: [class-semantics-reuse, fail-open-refusal, rehearsal-first-gated-live]
key-files:
  created:
    - docs/runbooks/hindsight-cache-proof.md
    - .planning/phases/26-hindsight-recall-and-dragonfly-cache/26-VALIDATION.md
  modified:
    - packages/mcp-server/src/cache.ts
    - packages/mcp-server/src/cache.test.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/config.test.ts
    - docs/data-planes.md
decisions:
  - "Recall caches under the existing memory-search class (600 s, generation-bound); degraded answers are served but never stored so the next call re-probes the plane"
  - "Unparseable Redis URLs pass through to the runtime fail-open path; only plaintext non-loopback redis:// refuses (minimal behavior change)"
  - "0.0.0.0 and the full 127.0.0.0/8 range count as loopback alongside localhost and ::1 (brackets stripped)"
  - "Claims pin verifies the accept-bump mechanism; a failure would have meant fixing bump coverage, never the claims compose"
metrics:
  duration: "~2 h"
  completed: "2026-10-10"
actuals:
  tokens: 60000
  tasks: 3
  commits: 3
status: complete
---

# Phase 26 Plan 03: Cache deltas, refusal, and the gated proof Summary

Repeated reads are cached without hiding fresh claims or fresh retains, off-host plaintext redis cannot enable the cache, and the operator holds a runbook whose every live step is still ungated-proof with proof and rollback named. Executor performed no live touch.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Cache recall results and pin claims freshness | d7aa837 | cache.ts, cache.test.ts, service.ts |
| 2 | Refuse plaintext non-loopback redis:// and document the wiring change | fabde52 | config.ts, config.test.ts, docs/data-planes.md |
| 3 | Write the proof runbook and stop at the live gates | d01f8ce | docs/runbooks/hindsight-cache-proof.md, 26-VALIDATION.md |

## Must-haves

- Recall results cache under memory-search class semantics with the memory generation bound; a second identical recall is a hit and a fresh retain is never hidden: TRUE (generation-bound 600 s entries; degraded never stored; hit and Dragonfly-down equivalence tests)
- A claim newer than 60 s is visible in a brief served right after a cache hit on identical arguments; plaintext non-loopback redis:// refused fail-open with healthz telling the story: TRUE (claims pin via accept-bump; refusal with logged reason, health off, answers uncached)
- Every live touch is an explicit OPERATOR-GATED step the executor stops at: TRUE (G1 version probe, G2 bank ensure plus first recall, G3 first retain, G4 cache/topology change plus DOCS-07 headless proof — all mapped with proof and rollback, none run)

## Deviations from Plan

- shapeOk for the memory-search class now also accepts the recall `{results}` shape: required for recall entries to hit (a validator that rejects the shape it is asked to store can never hit).
- Merged search writes two cache entries (outer merged search plus the inner recall shared with the tool): documented in the updated sets/bypasses expectations.
- data-planes bank-table reader cell updated from the `agentId: "*"` wildcard claim to the per-bank fan-out truth (the old text contradicted the implemented D26-03 design).
- One data-planes sentence was truncated mid-edit by the 768-char tool limit: recovered verbatim from git diff and verified.

## Verification

- `bun test cache.test.ts config.test.ts brief.test.ts`: 72 pass, 0 fail
- `bunx tsc --noEmit`: clean
- Existing `searchMemory matches` expectations updated for the two-entry merged caching (equality intent preserved)
