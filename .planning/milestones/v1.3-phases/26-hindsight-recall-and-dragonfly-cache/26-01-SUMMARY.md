---
phase: 26-hindsight-recall-and-dragonfly-cache
plan: "01"
subsystem: hindsight-recall
tags: [hindsight, memory-recall, fan-out, rehearsal-fake, fail-open]
requires: []
provides: [hindsight-plane-client, recording-hindsight-fake, memory-recall-tool-route]
affects: [26-02-retain-forward, 26-03-cache-deltas]
tech-stack:
  added: []
  patterns: [result-returns-never-reject, shared-abort-budget-fan-out, derived-framing]
key-files:
  created:
    - packages/mcp-server/src/planes/hindsight.ts
    - packages/mcp-server/src/planes/hindsight.test.ts
    - packages/mcp-server/src/hindsight-fake.ts
    - packages/mcp-server/src/memory-recall.ts
    - packages/mcp-server/src/memory-recall.test.ts
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/store-lock.test.ts
decisions:
  - "Recall bank set is the caller's bank plus the explicit HINDSIGHT_BANKS list; unset config reads the caller's bank only, never a shared fallback"
  - "ensureBank success cached per process; failure retries next call — statelessness otherwise, one GET per forward worst case"
  - "HindsightDocument carries text so the G2 rollback read-back is verifiable"
  - "Paged memory_search stays index-only in 26-02; list path merges derived hits so cursors keep their integrity"
metrics:
  duration: "~3 h"
  completed: "2026-10-10"
actuals:
  tokens: 95000
  tasks: 3
  commits: 3
status: complete
---

# Phase 26 Plan 01: Substrate-side Hindsight recall path Summary

Substrate-side Hindsight recall end to end against a fake banks server: 0.9.1 client, recording fake, `memory_recall` tool plus route plus registrations, and the negative gates that forbid the acc30a8 stub shape — bounded, attributed, redacted, derived-marked hits with fail-open errors.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Port the 0.9.1 client into planes/hindsight.ts with the fake banks server | 43e7be6 | planes/hindsight.ts, hindsight-fake.ts, planes/hindsight.test.ts |
| 2 | Build memory_recall with derived framing and fail-open errors | 880994a | memory-recall.ts, memory-recall.test.ts |
| 3 | Register memory_recall on MCP plus REST and pin the anti-pattern gates | a32cb0d | mcp.ts, observe.ts, server.ts, service.ts, store-lock.test.ts |

## Must-haves

- memory_recall (MCP and POST /memory/recall) fans out over the configured sub-* banks under one abort budget, returns at most 4 hits per bank with the source bank named, redacted and framed derived: TRUE (caller's bank first, score merge, per-bank cap, untrusted-memory notice, redacted hits proven)
- The brief's synchronous compose path never imports planes/hindsight; errors yield empty plus reason, never a throw inside a turn: TRUE (import-edge test on brief.ts; Result returns throughout, outage yields empty-plus-reason)
- No recall without a bank path segment and no retain without document_id is possible: TRUE (fake 500s unbanked recall and 400s unkeyed retain; client throws pre-network on both programmer errors)

## Deviations from Plan

### Implementation additions (plan file list incomplete, no architectural change)

**1. service.ts carries the recall seam (Substrate.recallMemories plus hindsightFetch override)**
- **Found during:** Task 3 — the MCP tool and REST route need a backend; the plan lists mcp.ts/server.ts/observe.ts but no service seam.
- **Fix:** Thin `Substrate.recallMemories` mirroring `searchDocs` (env read lazily per call, fetch override for tests), plus the `hindsightFetch` stores-seam entry.
- **Commit:** a32cb0d

**2. Store-lock Hindsight block added in 26-01; HINDSIGHT_* string scan deferred to 26-02**
- **Found during:** Task 3 — the D26-01 import/config pins are testable now; the env-string perimeter belongs with 26-02's credential-perimeter task.
- **Fix:** store-lock.test.ts gains the no-Hindsight-MCP-config and no-cross-package-import pins now; 26-02 adds the HINDSIGHT_* string and credential-value scans.

### Repairs during execution

- `ensureBank` branched on transport `ok` instead of the 404 status (the `get` helper returns transport success with the status): fixed to branch on `status === 404`.
- Two edit-tool range errors clobbered `this.dodGateTest` assignment and the `cache` stores-seam line in service.ts: both restored, tsc clean after.

## Verification

- `bun test planes/hindsight.test.ts memory-recall.test.ts store-lock.test.ts event-sources.test.ts policy.test.ts`: 150 pass, 0 fail
- `bunx tsc --noEmit`: clean
- Full `bun test`: 2811 pass, 58 skip, 1 fail — the single failure is the pre-existing environmental `scripts/rehearsal.test.ts` port-guard test (production-checkout guard fires before the port assertion; baseline records 1 failure; scripts/ untouched by this plan)
