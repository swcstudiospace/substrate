---
phase: 57-tandem-memory
verified: 2026-10-26
status: passed
score: 5 of 5 success criteria MET in the repository with fakes; two live-only items unverified (listed under Residual risks)
verified_on: gsd/v16-int at 979b5e2 (phase commits 77d18bc, 084eb69, a26841d, 2aaa19a, 824ceda, 979b5e2)
---

# 57-VERIFICATION: Tandem memory, LightRAG with Hindsight, with provenance and forget

## Gates

Not run by the author of this record. Orchestrator figures for `gsd/v16-int` at 979b5e2: 7480 pass, 2 skip, 0 fail; audit gate 0 unlisted; `check:phase-close` pass; config-reference check pass. Evidence below was read from files and test names.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Retain metadata carries `graph_id`, `session_id` and `node_id` when known; recall hits expose them; document ids unchanged | MET | `memory-retain.ts` (`RETAIN_JOIN_KEYS`), `memory-recall.ts` (hit exposes `graph_id`); tests added in `memory-retain.test.ts` (+118 lines) and `memory-recall.test.ts` (+79 lines); commit 77d18bc. |
| 2 | A docs answer with LightRAG up carries LightRAG chunks and Hindsight citations, deduplicated, with provenance; with LightRAG down the existing degraded fallback is unchanged | MET | `tandem-recall.test.ts` (`mergeTandem dedupe`, `ranking`, `cap and per-origin floor`, `items`, `parseTandemOptions`); `service-tandem-scope.test.ts` `describe("docs search with tandem OFF")` (unchanged behaviour) and `describe("docs search with tandem ON")`; fallback path described in `docs/docs-search-ingest.md`. Default off. |
| 3 | A forget primitive removes plane documents for entries superseded by rollback or expiry, by entry id, emits one ledger note per call; a replayed parked retain for it answers gone; the index keeps the row | MET for the primitive and for rollback; see note | `memory-forget.test.ts` (`forgetEntries: one outcome per entry`, `idempotency`, `plane failures`, `races at the mark`, `bounds`, `memory.forget payload validator and builder`); `service-forget.test.ts` (`"a parked retain replay for a forgotten entry answers gone: it sends nothing and leaves the outbox"`, `Substrate.memoryForget: the ledger note`, `cache generations`, `recall, the brief and memory search stop serving a forgotten entry`); `index-store.memory-forget.test.ts` (every memory reader filters on `superseded_by IS NULL`). Note: only a rollback commit calls the primitive; no expiry or operator caller exists. |
| 4 | A consistency verifier compares the memory index, the Hindsight documents and the ledger events, reports drift as JSON with a non-zero exit code, and repairs nothing without an explicit flag | MET (with fakes) | `consistency-verify.test.ts` (`a clean run`, `index_entry_missing_in_plane`, `forgotten entries`, `plane_document_orphan and duplicate_document`, `hash_mismatch`, `ledger comparison`, `an unreachable store`, `planRepairs`); `consistency-run.test.ts` (`exit codes`, `--repair`, `executeRepairPlan refuses what the planner would never make`, `the entry process`); `packages/cli/src/consistency.test.ts`; runbook `docs/runbooks/consistency-verify.md`. |
| 5 | The brief's recall injection can be scoped to the claimed node's graph, off by default, within its own budget | MET | `service-tandem-scope.test.ts` `describe("the brief's recall with SUBSTRATE_BRIEF_RECALL_SCOPE off")` and `...=graph`; `config-contextual-recall.test.ts` (defaults, typos named without echoing the value, caps); flag in `docs/config-reference.md`, `.env.example` and the flag registry; `docs/data-planes.md` "Graph scope". |

## Residual risks

- **Unverified against a live system:** the Hindsight document-listing route the verifier uses (`GET <plane>/v1/default/banks/<bank>/documents?limit=&offset=`) is unverified against Hindsight 0.9.1; when the plane lacks it the orphan and duplicate checks are skipped and reported. What a live LightRAG returns to the tandem leg is also unverified (none is deployed).
- The ledger pairing is a heuristic: the `memory.write` event carries no entry id, so identity within a (writer, scope, kind) bucket is approximate while counts are exact.
- A memory-only retain outbox (no `SUBSTRATE_RETAIN_OUTBOX_PATH`) cannot be read by the runner, so a missing plane document may be a retain still waiting.
- A checkpoint's `verified` memory status proves the entry hash and an anchored cited event, not that the event concerns the entry (phase 60).
- Criterion 3 names expiry; no automatic expiry caller of the forget primitive exists.
- The forget plane delete depends on Hindsight's document delete route being the one the existing `deleteDocument` uses; no live call was made.

## Operator-gated

Enabling `SUBSTRATE_DOCS_TANDEM` and `SUBSTRATE_BRIEF_RECALL_SCOPE` in production; any live Hindsight call; LightRAG itself.
