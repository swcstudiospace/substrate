---
phase: 34-invalid-write-round-trip
verified: 2026-10-21T07:06Z
status: passed
score: 2 of 2 criteria proven. Criterion 1 PASS. Criterion 2 PASS: content digests and the docs state file are compared on every refusal
verified_on: fix/phase-34-content-checks 92579d5 (on origin/main 0c7f395; code tree unchanged from ed5cb93 apart from the round-trip test file)
covered_files: [".planning/phases/34-invalid-write-round-trip/PLAN.md", ".planning/phases/34-invalid-write-round-trip/SUMMARY.md", "packages/mcp-server/src/invalid-write-roundtrip.test.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/skills/request.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/skills/request.ts", "docs/memory-governance.md"]
---

# 34-VERIFICATION: Invalid-write round trip

Verified by the orchestrator on 2026-10-21. The first verification (efa3ee4) returned `gaps_found`: criterion 2 compared row counts, audit records, and upload counts only. Commit 92579d5 adds the content checks, and this record covers that commit. Greptile raised the gap on PR #87 (PRRT_kwDOUoNcVM6upax6).

## Proven in-repo

| Claim | Evidence |
|---|---|
| Round-trip suite passes on a throwaway Postgres 16 (`substrate_test`), zero skips | `bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts` on 92579d5: 71 pass, 0 fail, 1 file, 0 skip, 0 todo |
| Types clean | `bunx tsc --noEmit` exit 0 on 92579d5 |
| Content checks catch what counts cannot | Three mutations in a throwaway copy of the suite, not committed. Each gave exactly one failure, on its content assertion, while the count, registry-state, and upload checks stayed green: a body rewrite on a memory row (the 403 loop's first case; the failing hunk is `content` only); a `content_sha256` rewrite on a skills registry row (the approve loop's first case; `registryState` reads four columns and does not include it); a rewrite of the docs state file (the REST docs loop's first case; the state file read `"tampered"`, and the upload count still matched) |
| Other suites | Not re-run on 92579d5. The commit changes only the round-trip test file. Earlier run on efa3ee4, before the content checks: 188 pass across the round-trip, http, and skills/request suites |
| CI and Greptile on the PR head | Merge gate, recorded on the PR, not here |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status | PASS | POST /memory: 403 for shape (`invalid-write-roundtrip.test.ts:397`), 400 for a non-object body (`:414`). MCP memory_write: `:449`, non-object argument list `:459`. POST /skills/propose: 400, git never called (`:547`, `:564`). MCP skills_propose: `:618`, `:633`. POST /skills/approve: 400 (`:687`, `:701`). MCP skills_approve: `:725`. POST /docs/ingest: 400, zero uploads (`:822`, `:835`). MCP docs_ingest: `:849` |
| 2 | Before-and-after checks of stored content prove nothing was persisted or mutated on refusal. Row count alone is insufficient | PASS | Each refusal compares `storedState` (per table: row count and a digest of every row, `:318`) before and after: memory `:398/:404`, `:415/:421`, `:450/:454`, `:460/:464`, `:471/:482`; skills propose `:549/:556`, `:566/:574`, `:620/:627`, `:635/:641`; skills approve `:688/:693`, `:702/:708`, `:726/:730`. Skills refusals also compare `registryState` (four columns, `:328`), which is kept. Docs refusals run on a store that already holds one valid page (`seeded()`, `:789`) and compare the upload list and the per-test state file (`docsStateOf`, `SUBSTRATE_DOCS_STATE_FILE`): `:828/:829`, `:842/:843`, `:855/:856`. Each valid control moves the digest it writes to: `:391-392`, `:442-444`, `:541-542`, `:611-612`, docs `:802-818` |

## Remaining caveats

- Docs uploads are counted on the RAGFlow fake (`fake.uploads`). Nothing here reads a live RAGFlow dataset.
- Digests and counts are whole-table. They assume nothing else writes these tables during the run, the same assumption the count checks already made.
- CI runs the suite against its own Postgres service. That run, with Greptile, is the merge gate for the PR head.
