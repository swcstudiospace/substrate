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
decisions:
  - "Provenance is request.source_event (the run that proved the entry); no receipt_path field exists on MemoryWriteRequest, so a future MCP param can add it — unsourced writes refuse with retain.unsourced plus a warning"
  - "document_id is the raw index idempotency key (traceable both directions); update_mode replace makes retry an upsert"
  - "Redaction gate is redact(text) !== text with per-rule naming via applyRule; a diff with no named rule reports structural"
  - "Unconfigured plane is informative (degraded false with reason), not failed — index-only answers stay complete"
  - "Paged memory_search stays index-only: plane hits ignore the subject prefix and keyset cursor, so merging would corrupt paging"
  - "No index-store.ts change needed: result.entry already carries the stored entry, so the forward reads nothing back"
metrics:
  duration: "~2 h"
  completed: "2026-10-10"
actuals:
  tokens: 70000
  tasks: 2
  commits: 2
status: partial
---

# Phase 26 Plan 02: Gate-accepted retain forward plus derived search merge Summary

STATUS: PARTIAL — Tasks 1 and 2 complete and green (forward module plus 8 tests, merge module plus service wiring, 187 targeted tests pass, tsc clean). Task 3 (credential perimeter plus .env.example) NOT executed — budget stop. No live touches performed.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Forward gate-accepted memories to the writer's sub-<surface> bank | 4f38856 | memory-retain.ts, memory-retain.test.ts |
| 2 | Merge Hindsight hits into memory_search marked derived | eff6b2e | memory-search.ts, service.ts, memory-recall.ts, memory-recall.test.ts |
| 3 | Pin the credential perimeter and name the new reader | NOT DONE | store-lock.test.ts, .env.example |

## Must-haves

- An accepted (verified_persisted) memory is forwarded redacted with source into the writer's sub-<surface> bank, idempotent by document_id; refusal or failure emits memory.retain.failed and never re-opens the write: TRUE (8 tests: faithful copy, upsert retry, unaccepted-silent, unsourced-refused, unredacted-refused with rule names, plane-failure warns, vm-guest refused, unconfigured silent)
- memory_search merges Hindsight hits marked derived with source bank named; outage yields index-only with reason: TRUE (merge module; service.searchMemory parallel load under memory-search class; paged path intentionally index-only)
- No HINDSIGHT_* string outside mcp-server; .env.example names the new reader: NOT DONE (Task 3)

## Remaining work (mechanical, no design open)

1. store-lock.test.ts: add `HINDSIGHT_*` env-read scan (fail on any `HINDSIGHT_` string in `**/*.ts` outside `packages/mcp-server/src`) plus the credential-value scan for `HINDSIGHT_URL`/`HINDSIGHT_API_KEY` mirroring the RAGFLOW block (exempt `HINDSIGHT_BANK_PREFIX`/`HINDSIGHT_BANKS` routing values and `*.test.ts` fixtures). Verify: `bun test store-lock.test.ts`.
2. .env.example: update the Hindsight note from "Unused by substrate-mcp" to "Read by substrate-mcp planes/hindsight.ts since Phase 26; the desk gateway keeps its own keys for its own paths". Optionally document `HINDSIGHT_BANKS` (comma/whitespace-separated explicit fan-out set; unset reads the caller's bank only).
3. Recall-test merge extensions (plan asks): attribution-survives-merge, outage-degrades-to-index-only, index-first ordering — via `mergeDerivedHits` in memory-recall.test.ts.
4. Commit Task 3 separately, then proceed to 26-03.

## Deviations from Plan

- service.ts carries both wirings (writeMemory background forward; searchMemory merge): plan file list incomplete, same Rule-2 justification as 26-01.
- index-store.ts intentionally unchanged: nothing to hook — `result.entry` is the stored entry.
- Unconfigured-plane semantics refined (degraded false with informative reason) so unconfigured deployments keep complete index answers.
- Two edit-tool range errors clobbered `this.dodGateTest`, the `cache` seam line, and two import lines in service.ts: all restored, tsc clean after.

## Verification

- `bun test memory-retain memory-recall planes/hindsight store-lock event-sources cache policy`: 187 pass, 0 fail
- `bunx tsc --noEmit`: clean
- Full `bun test` last ran under 26-01: 2811 pass, 58 skip, 1 pre-existing environmental rehearsal port-guard failure
