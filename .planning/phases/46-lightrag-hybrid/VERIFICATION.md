---
phase: 46-lightrag-hybrid
verified: 2026-10-26
status: human_needed
score: 1 of 6 acceptance criteria proven in repository; 2 and 3 need operator approval for live steps; 4 and 5 are not met
verified_on: gsd/autonomous-run-2026-10-24 at 2c82176
covered_files: ["packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "docs/docs-plane.md"]
---

# 46-VERIFICATION: LightRAG hybrid RAG and the RAGFlow migration

## Gates on the verified tree

| Check | Command | Result |
|---|---|---|
| Composite gate | `env -u SUBSTRATE_TEST_PG_URL bun run verify` | exit 0: typecheck clean; `bun test` 6086 pass, 177 skip (Postgres-only, run in CI), 0 fail; Python suites pass; repo locks pass |
| Python suites | `uv run --no-project --with httpx==0.28.1 --with pytest==9.1.1 python -m pytest packages/miner/tests packages/dispatcher/tests` | 321 passed |
| Repo locks | `bun run check:phase-close` | exit 0 in three runs, 2.2 to 2.3 s |
| Fail-before for the degraded contract | new and changed tests run on `0570e77` | five fail, the replay pin passes before and after |

## Acceptance criteria

| # | Criterion (PLAN.md) | Evidence in repository | Status |
|---|---|---|---|
| 1 | `docs_search` returns context-augmented results on the LightRAG hybrid plane | Tests `5e3c694`; docs `2a29aed`; context and deadline fixes `280860b`, `39b28c2`; one degraded contract for `docs_search` and `docs_lightrag_query` `2c82176` | pass in repository, against fakes |
| 2 | RAGFlow dataset archived with a verified checksum | T5 is a HARD_STOP and has not run | human_needed: needs operator approval for this run |
| 3 | LightRAG deployed to production with a timed health probe | T6 is a HARD_STOP and has not run | human_needed: needs operator approval for this run |
| 4 | Parity gate: zero dataset, source and version mismatches; sampled citations match at 100 percent | T3 recorded in PLAN (ten queries, fail closed). T4 comparator is BLOCKED on T5 and a read-only RAGFlow export. T7 is a HARD_STOP | not met |
| 5 | Logged cutover with delta pass; RAGFlow removal only after criteria 1 to 4 and the RAG-dependent phases | T8 is a HARD_STOP. W1 to W4 removal is on operator hold until LightRAG deploys | not met |
| 6 | Each live step needs the operator's approval for that run | No approval granted | standing rule |

## Not proven

- LightRAG live behaviour: no deploy, fakes only.
- That recalled memories improve answers. The context block proves the plumbing and the caps only.
- Presentation differences between `docs_search` and `docs_lightrag_query` that are not degraded semantics: the no-hit fallback marker, the `backend` and `graph` fields, the notice text, the no-hit reason suffix, the chunk field names, and a stale comment in `types.ts`. They are listed in commit `2c82176` and remain open.

## Human verification items

1. Approve T5, the RAGFlow archive with checksum (criterion 2). Then approve T6, the LightRAG deploy and health probe (criterion 3).
2. Choose the LLM route for LightRAG: an API key, or the bridge `/chat` contract, which is not yet readable.
3. Confirm the phrase "phase 46 cutover" in `docs/docs-plane.md`, which comes from the re-scope brief and is not defined in `docs/`.
4. After T5 and the RAGFlow export, review the T4 comparator design before T7.
