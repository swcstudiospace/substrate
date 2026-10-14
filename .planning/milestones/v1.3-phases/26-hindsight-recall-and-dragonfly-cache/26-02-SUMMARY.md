---
phase: 26-hindsight-recall-and-dragonfly-cache
plan: "02"
subsystem: hindsight-retain
tags: [hindsight, memory-retain, memory-search-merge, gate-accepted-forward]
requires: [26-01-recall-path]
provides: [retain-forward, derived-search-merge]
affects: [26-03-cache-deltas]
tech-stack:
  added: []
  patterns: [post-accept-background-forward, refuse-on-finding, locator-only-warning]
key-files:
  created:
    - packages/mcp-server/src/memory-retain.ts
    - packages/mcp-server/src/memory-retain.test.ts
    - packages/mcp-server/src/memory-search.ts
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/memory-recall.ts
    - packages/mcp-server/src/memory-recall.test.ts
  intentionally-unchanged:
    - packages/mcp-server/src/index-store.ts
    - packages/mcp-server/src/store-lock.test.ts
    - .env.example
  intentionally-unchanged:
    - packages/mcp-server/src/index-store.ts
metrics:
  duration: "~3 h"
  completed: "2026-10-10"
actuals:
  tokens: 85000
  tasks: 3
  commits: 3
status: complete
---

# Phase 26 Plan 02: Gate-accepted retain forward plus derived search merge Summary

Gate-accepted Hindsight retain plus derived-marked search merge with the credential perimeter pinned: only accepted, sourced, redacted memories land once in their writer's bank; search merges plane hits as visibly derived; HINDSIGHT_* is test-pinned to the server module.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Forward gate-accepted memories to the writer's sub-<surface> bank | 4f38856 | memory-retain.ts, memory-retain.test.ts |
| 2 | Merge Hindsight hits into memory_search marked derived | eff6b2e | memory-search.ts, service.ts, memory-recall.ts, memory-recall.test.ts |
| 3 | Pin the credential perimeter and name the new reader | e622e6c | store-lock.test.ts, .env.example, memory-recall.test.ts |

## Must-haves

- An accepted (verified_persisted) memory is forwarded redacted with source into the writer's sub-<surface> bank, idempotent by document_id; refusal or failure emits memory.retain.failed and never re-opens the write: TRUE (8 tests: faithful copy, upsert retry, unaccepted-silent, unsourced-refused, unredacted-refused with rule names, plane-failure warns, vm-guest refused, unconfigured silent)
- memory_search merges Hindsight hits marked derived with source bank named; outage yields index-only with reason: TRUE (merge module plus merge-shape tests: attribution survives, index first and unmarked, outage degrades to index-only; service.searchMemory parallel load under memory-search class; paged path intentionally index-only)
- No HINDSIGHT_* string outside mcp-server; .env.example names the new reader: TRUE (env-read scan plus credential-value scan with catch/no-fire bodies; routing values exempt; example names planes/hindsight.ts and documents HINDSIGHT_BANKS)

## Deviations from Plan

- service.ts carries both wirings (writeMemory background forward; searchMemory merge): plan file list incomplete, same Rule-2 justification as 26-01.
- index-store.ts intentionally unchanged: nothing to hook — `result.entry` is the stored entry.
- Unconfigured-plane semantics refined (degraded false with informative reason) so unconfigured deployments keep complete index answers.
- Two edit-tool range errors clobbered `this.dodGateTest`, the `cache` seam line, and two import lines in service.ts: all restored, tsc clean after.

## Verification

- `bun test memory-retain memory-recall planes/hindsight store-lock event-sources cache policy`: 187 pass, 0 fail
- `bunx tsc --noEmit`: clean
- Full `bun test` last ran under 26-01: 2811 pass, 58 skip, 1 pre-existing environmental rehearsal port-guard failure
