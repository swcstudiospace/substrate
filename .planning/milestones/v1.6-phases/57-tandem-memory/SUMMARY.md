---
phase: 57-tandem-memory
milestone: v1.6
requirements: [SOTA-13]
status: implemented on gsd/v16-int (77d18bc, 084eb69, a26841d, 2aaa19a, 824ceda, 979b5e2); not merged; criteria 1 to 5 met with fakes
---

# 57-SUMMARY: Tandem memory, LightRAG with Hindsight, with provenance and forget

## What was built

- **57a, retain join keys (77d18bc).** Hindsight retain metadata carries `graph_id`, `session_id` and `node_id` when known (`RETAIN_JOIN_KEYS` in `memory-retain.ts`; a value that fails validation is dropped, never sent, and never fails the write); recall hits expose them (`memory-recall.ts`). Document ids are unchanged.
- **57b, forget.** `memory-forget.ts` (pure, dependency-injected: marker `forgotten:<forget_id>`, `forget_id = fg_ + 26 hex` derived from the sorted ids, reason and rollback or checkpoint id, so a retry reuses it; mark in the index first, then delete plane documents with bounded concurrency, then emit exactly one `memory.forget` note). `IndexStore.markMemoryForgotten` and `memoryEntriesCreatedAfter` (never overwrite an existing `superseded_by`). `memory-forget-plane.ts` and `Substrate.memoryForget` in `service.ts` (084eb69 library, a26841d wiring): the plane delete is chained behind any live or replayed retain of the same document, a plane failure never undoes the index mark and is retried by re-running the same request, and the recall and memory cache generations move when a row or a plane document changed. A parked retain replay for a forgotten entry answers `gone`.
- **57c, tandem recall.** `tandem-recall.ts` merges LightRAG chunks and Hindsight citations (normalised-digest dedupe, ranking, a cap with a per-origin floor); `docs-search.ts` has a tandem leg that adds the caller's Hindsight memory to a LightRAG answer as derived, never-cached items marked with their bank, under its own budget. The brief's recall can be scoped to the claimed node's graph (`SUBSTRATE_BRIEF_RECALL_SCOPE=graph`): up to three lines, their own budget, their own cache key part.
- **57d, consistency verifier (2aaa19a, CLI in 979b5e2).** `consistency-verify.ts` (pure) compares the TimescaleDB memory index, the Hindsight documents and the ledger's memory-write events; `consistency-run.ts` is the runner (exit codes 0 consistent, 1 drift, 2 usage or refusal, 3 a store unreachable or a check could not run); `substrate consistency verify` spawns it. `--repair` re-retains a current entry's missing plane document and deletes the plane document of a forgotten entry; `--repair-orphans` adds orphan deletion; the index and the ledger are never written. Runbook `docs/runbooks/consistency-verify.md`.
- **Flags, all default off, registered and documented:** `SUBSTRATE_DOCS_TANDEM`, `SUBSTRATE_DOCS_TANDEM_LIMIT`, `SUBSTRATE_DOCS_TANDEM_BUDGET_MS`, `SUBSTRATE_BRIEF_RECALL_SCOPE`. Warnings name the variable and the default taken, never the value.

## Key decisions

- Forgetting is a marker in an existing column, not a delete and not a schema change: every reader already filters on `superseded_by IS NULL` (`index-store.memory-forget.test.ts`).
- The forget primitive has no tool of its own; only a rollback commit reaches it.
- With LightRAG down, the existing Hindsight-fallback behaviour is unchanged and tandem adds nothing to a degraded reply.

## Deviations from the plan

- ROADMAP criterion 3 reads "superseded by rollback or expiry". The primitive accepts the reasons `rollback`, `expiry` and `operator`, but only a rollback commit calls it; no expiry or operator caller was wired.

## Findings

- **Fixed (a26841d):** the index sweeper deleted every superseded row after 90 days, which would have deleted forgotten rows and their audit record. A forgotten row is now kept (`index-sweep.ts`; tests in `index-sweep.test.ts` and `index-store.sweep.test.ts`).
- **Fixed (824ceda):** `memoryForget` did not bump the recall and memory generations when a plane delete newly succeeded, so a cached recall could still serve a forgotten entry; contextual-recall config warnings no longer echo the value they refused.
- **Fixed:** a type guard on the forget marker check claimed more than it verified (reported by the orchestrator; the current guard is `isForgetMarker` in `memory-forget.ts`, and the commit that changed it is not identified here: UNVERIFIED).
- **Not fixed, residual:** the `memory.write` ledger event carries no entry id, so the verifier pairs by writer, scope, kind and time, which is a heuristic; the Hindsight document-listing route the verifier calls is unverified against 0.9.1 (without it the orphan and duplicate checks are skipped and reported); a memory-only retain outbox cannot be read by the runner.

## What remains

- Enabling the tandem and graph-scope flags in production (operator-gated); a live check of the Hindsight listing route; a decision whether to add an entry id to the `memory.write` event; an expiry or operator trigger for the forget primitive if one is wanted.
