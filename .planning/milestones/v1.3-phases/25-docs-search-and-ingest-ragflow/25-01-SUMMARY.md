---
phase: 25-docs-search-and-ingest-ragflow
plan: "01"
subsystem: docs-search
tags: [ragflow, docs-search, retrieval, rehearsal-fake]
requires: []
provides: [ragflow-plane-client, recording-ragflow-fake, docs-search-tool-route]
affects: [25-02-ingest, 25-03-datasets]
tech-stack:
  added: []
  patterns: [recording-fake-fetch-injection, fail-open-read, citation-reply]
key-files:
  created:
    - packages/mcp-server/src/planes/ragflow.ts
    - packages/mcp-server/src/planes/ragflow.test.ts
    - packages/mcp-server/src/ragflow-fake.ts
    - packages/mcp-server/src/docs-search.ts
    - packages/mcp-server/src/docs-search.test.ts
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/server.test.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/config.ts
decisions:
  - "Per-dataset retrieval calls (one per readable dataset) so every citation carries its dataset name for the commit fallback; merged, score-sorted, sliced to 10"
  - "FetchLike seam type instead of typeof fetch: Bun's fetch carries preconnect, which fakes cannot satisfy"
  - "VM-guest refusal deferred to plan 25-02 with the ingest gates (SUBSTRATE_VM_GUEST server/CLI signal)"
metrics:
  duration: "~50 min"
  completed: "2026-10-10"
actuals:
  tokens: 60000
  tasks: 3
  commits: 3
status: complete
---

# Phase 25 Plan 01: Substrate-only RAGFlow (retired, superseded by LightRAG) retrieval path Summary

JWT-free read path for docs: RAGFlow (retired, superseded by LightRAG) retrieval through `substrate-mcp` only, proven against a recording fake — explicit dataset ids, <= 10 cited redacted results, untrusted framing, URL-listing event, empty-plus-reason errors.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Port planesFromEnv plus bearer carriage into planes/ragflow.ts with the recording fake | 8817bab | planes/ragflow.ts, planes/ragflow.test.ts, ragflow-fake.ts |
| 2 | Build docs_search with citation shape, untrusted framing and fail-open errors | d53c098 | docs-search.ts, docs-search.test.ts |
| 3 | Register MCP tool plus REST route plus metric and audit names | a51d3c8 | mcp.ts, server.ts, server.test.ts, observe.ts, config.ts, service.ts |

## Must-haves

- docs_search (MCP and POST /docs/search) queries explicit dataset ids and returns at most 10 results with title, source URL, heading path, commit, redacted snippet <= 1200 chars, score and ids: TRUE (per-dataset calls, wire test pins ids + clamp, service/MCP/REST proofs)
- Reply marked untrusted, one note event lists returned URLs, error yields empty result with reason: TRUE
- No retrieval without dataset_ids possible (fake fails it, test pins page_size <= 10): TRUE (client throws pre-network, fake 400s, test asserts both)

## Deviations from Plan

None - plan executed exactly as written. Two implementation details worth noting (not deviations):

1. **FetchLike seam**: `typeof fetch` under Bun includes `preconnect`, which an injected fake cannot satisfy; a minimal structural `FetchLike` type is used for all seams (client, docs-search deps, Substrate stores, server.test serve helper).
2. **Commit fallback pre-ingest**: with no ingest pins yet, `commit` falls back to `dataset-pin:<name>:unpinned` — names the gap, never blank, never invented. Plan 25-03 wires real pins.

## Verification

- `bun test planes/ragflow.test.ts docs-search.test.ts server.test.ts event-sources.test.ts observe.test.ts mcp.test.ts config.test.ts store-lock.test.ts policy.test.ts`: all green
- `bunx tsc --noEmit`: clean
- Anti-pattern gate: fake returns 400 for retrieval without dataset_ids; client throws before any network call

## Threat Flags

None beyond the plan's register (T-25-01..T-25-04 all mitigated as specified; no new npm packages).

## Self-Check: PASSED

- All created files exist; commits 8817bab/d53c098/a51d3c8 in log; no unrelated files touched.
