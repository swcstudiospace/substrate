---
phase: 34-invalid-write-round-trip
verified: 2026-10-21T06:17Z
status: gaps_found
score: 1 of 2 criteria proven. Criterion 1 PASS. Criterion 2 NOT MET: row counts and audits only, no content-level before-and-after checks
verified_on: origin/main efa3ee4 (code tree b8f8331; PR #81 merged as 2cba958, PR #80 merged as ed5cb93, PR #86 docs only)
covered_files: [".planning/phases/34-invalid-write-round-trip/PLAN.md", ".planning/phases/34-invalid-write-round-trip/SUMMARY.md", "packages/mcp-server/src/invalid-write-roundtrip.test.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/skills/request.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/skills/request.ts", "docs/memory-governance.md"]
---

# 34-VERIFICATION: Invalid-write round trip

Verified by the orchestrator on 2026-10-21. The executor's SUMMARY says its tests and `tsc` were not run. This is the first execution, against final main. Status is `gaps_found`: criterion 2 requires before-and-after checks of stored content, and the suite checks row counts, audits, and upload counts only.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Round-trip suites pass on a throwaway Postgres 16 (`substrate_test`) | `bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts packages/mcp-server/src/http.test.ts packages/mcp-server/src/skills/request.test.ts`: 188 pass, 0 fail, 3 files, 0 skip, 0 todo |
| Types clean | `bunx tsc --noEmit` exit 0 on efa3ee4 |
| Full suite on the same code | CI "Typecheck, tests and repo locks" SUCCESS on PR #80 head d2bc79f (same code tree) |
| Greptile on the same code | SUCCESS, 0 comments added on d2bc79f |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status | PASS | POST /memory: 403 for shape, 400 for a non-object body (`invalid-write-roundtrip.test.ts:347`). MCP memory_write (`:398`). POST /skills/propose: 400, git never called (`:484`). MCP skills_propose (`:548`). POST /skills/approve: 400 (`:644`). MCP skills_approve (`:680`). POST /docs/ingest: 400, zero uploads (`:705`, `:745`). MCP docs_ingest (`:772`) |
| 2 | Before-and-after checks of stored content prove nothing was persisted or mutated on refusal. Row count alone is insufficient | NOT MET | Refusals compare whole-table row counts and audit records (`rowCounts(...)` toEqual before, at `:374`, `:391`, `:422`, `:432`). Docs refusals compare `fake.uploads` only (`:752`, `:766`, `:779`). No test compares memory record content, skills registry row content, or docs state, and `SUBSTRATE_DOCS_STATE_FILE` is not set in the suite. Greptile flagged this on PR #87 (thread PRRT_kwDOUoNcVM6upax6) |

## Not proven (required to close phase 34)

- Content-level before-and-after checks, per refusal, for: memory records (memory_entries, memory_quarantine, memory_reviews), skills registry rows, and docs state. For docs, set `SUBSTRATE_DOCS_STATE_FILE` and compare its content, not only upload counts.
- Nothing operator-gated in this phase.
- CI ran the suite against its own Postgres service. This record's run used a local throwaway Postgres 16. Both passed.
