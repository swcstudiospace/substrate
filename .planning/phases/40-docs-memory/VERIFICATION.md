---
phase: 40-docs-memory
verified: 2026-10-21
status: gaps_found
score: 1 of 3 criteria met as written; 2 open
verified_on: gsd/v13x-40-docs-memory, two commits on origin/main acb6767 (PR #91). Full suite and typecheck run on the tree after the doc and comment edits, before the records were committed
covered_files: ["packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/recall-snapshot.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/brief-recall.test.ts", "packages/mcp-server/src/brief-recall-fanout.test.ts", "packages/mcp-server/src/mental-model-refresh.ts", "packages/mcp-server/src/mental-model-refresh.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "docs/data-planes.md", "docs/memory-governance.md", "docs/config-reference.md", "docs/event-vocabulary.md", "docs/runbooks/memory-mcp-retirement.md"]
---

> Status detail, kept verbatim from the original frontmatter: partial. Criterion 1 proven in-repo, no live effect yet. Criterion 2 blocked on a restore drill and approval. Criterion 3 not met as written. The closed-set value is gaps_found because criterion 3 is a gap as written; criterion 2 stays operator-gated.
# 40-VERIFICATION: DOCS-MEMORY

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` on the phase tree: exit 0 |
| Full suite passes | `bun test` with `SUBSTRATE_TEST_PG_URL` on the verification Postgres: 5774 pass, 2 skip (`cache-conformance.test.ts:127`, `redact.test.ts:813`, both pre-existing), 0 fail. 5776 tests in 214 files, 168 s, no `ENOSPC` |
| Targeted suites pass | Before the full run, 609 pass across the brief, recall, memory-recall, cache, config, flag-registry, event-sources, vocabulary-lock and config-reference tests |
| Fan-out key and cap | `brief-recall-fanout.test.ts`; `brief-recall.test.ts` cases A to J on the new contract |
| Mental-model refresh | `mental-model-refresh.test.ts`; `config.test.ts` `HINDSIGHT_MENTAL_MODELS` block; the event-catalog and vocabulary-lock tests |

## Live checks made on 2026-10-21 (read-only)

| Check | Result |
|---|---|
| `substrate-mcp` service | active; health planes greptime, index, cache, hindsight, ragflow all `ok`, breakers closed |
| TCP reachability of configured endpoints | Hindsight, Greptime, Dragonfly, Timescale and RAGFlow all open |
| Hindsight API (`/v1/default/banks`) | 200; 11 banks; default bank `ultrathink` present |
| Production recall settings | `SUBSTRATE_BRIEF_RECALL` unset (default off); `HINDSIGHT_BANKS` unset; `HINDSIGHT_MENTAL_MODELS` unset |
| Retain outbox | `SUBSTRATE_RETAIN_OUTBOX_PATH` set; the outbox file is absent, so nothing is parked |

## Not proven (not run)

- Fan-out under `enforce` against the live VPS.
- A mental-model refresh against Hindsight.
- The restore drill for the D-D3 retirement.
- The retirement itself. It needs the drill and operator approval.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | D-D1: cross-surface recall in the brief is a bounded, cached fan-out over the `sub-*` banks | PASS in-repo. No live effect: recall is off and `HINDSIGHT_BANKS` is empty on the server | the fan-out tests above; the live settings table |
| 2 | Claude Code's `hindsight` MCP and Hermes supermemory retired once the `sub-*` banks answer, restore routes recorded first | NOT MET. Restore routes are recorded in `docs/runbooks/memory-mcp-retirement.md`. The drill and approval are pending. Not every `sub-*` bank answers: `sub-grok-bot` is absent from the VPS bank list, and Hermes supermemory has no configured integration here | runbook; the Hindsight bank check |
| 3 | A weekly `reflect` per bank: mental models replace stale detail | NOT MET as written. Shipped: a weekly refresh of config-named models through the refresh endpoint. `reflect` is not used because it persists nothing. Accepting the narrower scope is the user's call | `mental-model-refresh.test.ts`; SUMMARY deviations |
