---
phase: 46-ragflow (retired)-hybrid
verified: 2026-10-21
status: human_needed
score: 2 of 2 acceptance criteria proven in-repo (context-augmented docs_search; tests for hybrid)
verified_on: gsd/v13x-46-rag on its final tree, based on origin/main 92ef7c2
covered_files: ["packages/mcp-server/src/planes/ragflow (retired).ts", "packages/mcp-server/src/planes/ragflow (retired).test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", ".env.example", "docs/docs-search-ingest.md", "docs/docs-plane.md", "docs/config-reference.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. Live RAGFlow (retired) behaviour is unattested and was not run

# 46-VERIFICATION: RAGFlow (retired) hybrid retrieval with Hindsight and Greptime context

## Gates on the final tree

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Config reference | `bun run config:reference -- --check` | up to date |
| Targeted | `bun test` on `docs-search.test.ts`, `server.test.ts`, `planes/ragflow (retired).test.ts` | 135 pass, 0 fail |
| Full bun suite | `bun test` against `substrate_test_p46`, on the review-fixed tree | 5905 pass, 2 skip, 0 fail (5907 tests, 219 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES unchanged at 27 |

## Acceptance criteria

| Criterion | Evidence in repo | Status |
|---|---|---|
| `docs_search` returns context-augmented results | With `context: true`, the reply carries memories from the Hindsight fake and the last five session events from the ledger stub; with no session it degrades to `no-session`; a recall failure keeps the chunks and sets a reason; a hanging ledger returns within its budget with `ledger` in `degraded`; a context reply is not stored in the cache; REST and MCP accept the flag | Proven in-repo against fakes |
| Tests for hybrid | The wire body carries the configured vector weight (0.7 in the test) and `rerank_id` only when configured; defaults give 0.3 and no `rerank_id`; an out-of-range RAGFlow (retired) weight throws `ConfigError` naming the variable with no request made | Proven in-repo against the RAGFlow (retired) fake |

## Not proven

- The deployed RAGFlow (retired) version accepting `vector_similarity_weight` and `rerank_id` as sent. The version is unattested (`ragflow (retired).ts` comment), and no live call was made.
- That recalled memories improve answers. The context proves the plumbing and the caps only.
