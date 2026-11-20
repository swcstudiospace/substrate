---
phase: 25-docs-search-and-ingest-ragflow
plan: "02"
subsystem: docs-ingest
tags: [ragflow, docs-ingest, redaction-gates, store-lock, cli]
requires: [25-01]
provides: [fail-closed-ingest, ingest-cli, substrate-only-door-lock]
affects: [25-03-datasets]
tech-stack:
  added: []
  patterns: [refuse-never-clean-and-publish, hash-idempotency, locator-only-events]
key-files:
  created:
    - packages/mcp-server/src/docs-ingest.ts
    - packages/mcp-server/src/docs-ingest.test.ts
    - packages/cli/src/docs.ts
    - packages/cli/src/docs.test.ts
  modified:
    - packages/mcp-server/src/planes/ragflow.ts
    - packages/mcp-server/src/ragflow-fake.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/server.test.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/observe.test.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/store-lock.test.ts
    - packages/cli/src/index.ts
decisions:
  - "VM-guest refusal is an environment signal (SUBSTRATE_VM_GUEST=1): no guest concept existed in the tree; server refuses via config.vmGuest, CLI refuses pre-post"
  - "RAGFLOW credential store-lock scoped to non-test files: the service/MCP/REST proofs legitimately pass RAGFLOW_URL into loadConfig with reserved example hosts"
  - "CLI cap pin is text-based: importing the engine module from packages/cli would itself break the substrate-only door"
metrics:
  duration: "~90 min across two sessions"
  completed: "2026-10-10"
actuals:
  tokens: 90000
  tasks: 3
  commits: 4
status: complete
---

# Phase 25 Plan 02: Fail-closed ingest path Summary

DOCS-02 publication path: gated redacting idempotent ingest over MCP plus REST plus CLI, six loud refusals, substrate-only door locked by tests.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Build docs_ingest gates plus hash idempotency against the fake | b3bcaf6 | docs-ingest.ts, docs-ingest.test.ts, planes/ragflow.ts (upload/poll), ragflow-fake.ts (upload/parse) |
| 2 | Register MCP tool plus REST route plus CLI with fail-closed audit | 295e40e | mcp.ts, server.ts, observe.ts, config.ts, service.ts, cli/docs.ts, cli/docs.test.ts, cli/index.ts |
| 3 | Extend the store lock for the substrate-only door | f372925 | store-lock.test.ts |
| — | Ingest transport proofs (MCP + REST) | 23eeee0 | docs-ingest.test.ts, server.test.ts |

## Must-haves

- docs_ingest (MCP, POST /docs/ingest, substrate docs ingest) redacts before upload, strips remote images and is idempotent by content hash: TRUE (findingRules over REDACTION_RULES + skill scan pre-upload; strip counts; source_url-keyed sha records skip/replace)
- Refuses a page without a source URL, outside the configured roots or over the size caps, and any unauthenticated caller or VM guest: TRUE (all six proven; refusals carry rule names + hashes only, refused values never logged)
- No RAGFlow (retired, superseded by LightRAG) MCP exists in any agent config and no package outside mcp-server imports the client: TRUE (store-lock: config scan, import scan, credential scan — 23/23 green)

## Deviations from Plan

None in behavior. Two scoping notes:

1. **Transport proofs landed as a fourth commit** (23eeee0) rather than inside Task 2 — same content the plan's verify step requires, committed separately for a clean per-surface history.
2. **observe.test.ts pin extended** with the two new tool names (the Phase 17 registration rule working as designed); a self-inflicted `desktop_run` deletion during the observe edit was caught by that same pin test and repaired before commit.

## Verification

- `bun test` ingest (12 tests), CLI docs (6), store-lock (23), server routes, mcp, observe, config, policy: all green
- `bunx tsc --noEmit`: clean
- event-sources suite untouched and green (no kind added)

## Threat Flags

None beyond the plan's register (T-25-05..T-25-08 mitigated as specified; no new npm packages).

## Self-Check: PASSED

- All created files exist; commits b3bcaf6/295e40e/f372925/23eeee0 in log; no files outside the phase scope touched.
