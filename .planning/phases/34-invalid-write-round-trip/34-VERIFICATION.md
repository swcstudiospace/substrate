---
phase: 34-invalid-write-round-trip
verified: 2026-10-21T07:35Z
status: passed
score: 2 of 2 criteria proven. Criterion 1 PASS. Criterion 2 PASS: stored content (memory rows, skills registry rows, uploads with their metadata, plane documents, the docs state file) is compared on every refusal
verified_on: fix/phase-34-content-checks be7bcfe (on origin/main 0c7f395; code tree unchanged from ed5cb93 apart from the round-trip test file)
covered_files: [".planning/phases/34-invalid-write-round-trip/PLAN.md", ".planning/phases/34-invalid-write-round-trip/SUMMARY.md", "packages/mcp-server/src/invalid-write-roundtrip.test.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/skills/request.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/skills/request.ts", "docs/memory-governance.md"]
---

# 34-VERIFICATION: Invalid-write round trip

Verified by the orchestrator on 2026-10-21. The first verification (efa3ee4) returned `gaps_found`: criterion 2 compared row counts, audit records, and upload counts only. Commit 92579d5 adds the content checks. Commit be7bcfe closes three review findings on PR #88: docs uploads were compared by count only, the seed shared a key with a refused batch, and the seed waited on polls. Greptile raised the gap on PR #87 (PRRT_kwDOUoNcVM6upax6).

## Proven in-repo

| Claim | Evidence |
|---|---|
| Round-trip suite passes on a throwaway Postgres 16 (`substrate_test`), zero skips | `bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts` on be7bcfe: 71 pass, 0 fail, 1 file, 0 skip, 0 todo; 3.4 s |
| Types clean | `bunx tsc --noEmit` exit 0 on be7bcfe |
| Content checks catch what counts cannot | Four mutations in throwaway copies of the suite, not committed (three on 92579d5, one on be7bcfe). Each gave a failure on its content assertion while the count checks stayed green: a body rewrite on a memory row (the 403 loop's first case; the failing hunk is `content` only); a `content_sha256` rewrite on a skills registry row (`registryState` reads four columns and does not include it); a rewrite of the docs state file (the state file read `"tampered"` while the upload count matched); an in-place metadata edit on an upload plus a deleted plane document (the `storedDocs` diff shows `documents` losing `doc-upload-1` and `tampered` added to upload metadata) |
| The seed key is distinct | Throwaway premise test: after the seed, posting the mixed batch's first page alone makes a second upload (`uploads` length 2), so a refused batch's page reaching the store would be a visible write |
| Other suites | Not re-run on be7bcfe. The commits change only the round-trip test file. Earlier run on efa3ee4, before the content checks: 188 pass across the round-trip, http, and skills/request suites |
| CI and Greptile on the PR head | Merge gate, recorded on the PR, not here |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status | PASS | POST /memory: 403 for shape (`invalid-write-roundtrip.test.ts:397`), 400 for a non-object body (`:414`). MCP memory_write: `:449`, non-object argument list `:459`. POST /skills/propose: 400, git never called (`:547`, `:564`). MCP skills_propose: `:618`, `:633`. POST /skills/approve: 400 (`:687`, `:701`). MCP skills_approve: `:725`. POST /docs/ingest: 400, zero uploads (`:831`, `:843`). MCP docs_ingest: `:856` |
| 2 | Before-and-after checks of stored content prove nothing was persisted or mutated on refusal. Row count alone is insufficient | PASS | Each refusal compares `storedState` (per table: row count and digest of every row, `:318`) before and after: memory `:398/:404`, `:415/:421`, `:450/:454`, `:460/:464`, `:471/:482`; skills propose `:549/:556`, `:566/:574`, `:620/:627`, `:635/:641`; skills approve `:688/:693`, `:702/:708`, `:726/:730`. Skills refusals also compare `registryState` (four columns, `:328`), which is kept. Docs refusals run on a store holding the seed page (`seed`, `:765`; `seeded()`, `:797`), whose source URL no refused batch uses, and compare `storedDocs` (`:747`: deep copies of the uploads with their metadata, the plane's documents, and the per-test state file via `SUBSTRATE_DOCS_STATE_FILE`) before and after: `:837`, `:850`, `:862`. Each valid control moves the digest it writes to: `:391-392`, `:442-444`, `:541-542`, `:611-612`; docs valid control `:811-827` |

## Remaining caveats

- Docs are compared on the RAGFlow fake (`fake.uploads`, `fake.documents`). Nothing here reads a live RAGFlow dataset.
- Digests and counts are whole-table. They assume nothing else writes these tables during the run, the same assumption the count checks already made.
- CI runs the suite against its own Postgres service. That run, with Greptile, is the merge gate for the PR head.
