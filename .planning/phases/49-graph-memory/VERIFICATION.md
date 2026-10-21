---
phase: 49-graph-memory
verified: 2026-10-21
status: passed in-repo. Causality is recorded as session order; the live ledger is not exercised
score: 2 of 2 acceptance criteria proven in-repo (graph-linked results; causal recall)
verified_on: gsd/v15-49-graph-memory on the tree merged with origin/main 4c2c48e
covered_files: ["packages/mcp-server/src/memory-graph.ts", "packages/mcp-server/src/memory-graph.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/service.ts", "docs/memory-governance.md"]
---

# 49-VERIFICATION: Graph-linked memory and causal recall from Greptime events

## Gates on the merged tree

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Config reference | `bun run config:reference -- --check` | up to date |
| Targeted | `memory-graph.test.ts`, `mcp.test.ts` | 77 pass, 0 fail |
| Full bun suite | `bun test` against `substrate_test_p49`, on the review-fixed tree | 5924 pass, 2 skip, 0 fail (5926 tests, 220 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES unchanged at 27 |

## Acceptance criteria

| Criterion | Evidence in repo | Status |
|---|---|---|
| `memory_search` returns graph-linked results | With `graph_linked`, each returned graph carries its newest five ledger events, newest first; one read per graph; a graph with no events gets an empty list; a hanging read is released at its budget with a reason; a failed read drops only its part | Proven in-repo against the ledger stub |
| Recall uses causal | With `causal`, an entry with a source event carries the events that preceded it in its session, nearest first, at most five; an entry without a source event gets an empty chain; one session read per session | Proven in-repo against the ledger stub |

## Not proven

- The live ledger returning the same rows for these reads (the stub returns fixed rows).
- That the preceding events caused the memory. The reply says so, and the feature reports sequence only.
