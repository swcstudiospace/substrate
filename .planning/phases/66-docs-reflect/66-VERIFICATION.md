---
phase: 66-docs-reflect
verified: 2026-10-30
status: gaps_found
score: 4 of 5 success criteria MET in the repository against fakes (criteria 1 to 4); criterion 5 PARTIAL (no LightRAG, Hindsight or reflect run; gap scores unverified against a live plane)
verified_on: main at 80afb6e5 (files read; nothing was run by the author of this record)
---

# 66-VERIFICATION: Docs Reflect, the docs RAG learns from use

## Gates

Not run by the author of this record. The orchestrator's brief states that Biome, the test suite and tsc were run in a worktree before PR #184 was opened, and that the Greptile merge gate (5/5, no open threads, CI green, squash) was run by the ship loop, with several rounds needed. This record cites no test counts or CI results. Its evidence is file paths, function names and test titles read at 80afb6e5. The CI workflow exports `SUBSTRATE_TEST_PG_URL` from a scratch Postgres job (`.github/workflows/ci.yml`, line 53), so the live-index tests (`corpus/reflect-store.test.ts`) run only when that job runs them. [INFERENCE: the repository does not show whether they ran for #184.]

## Success criteria

ROADMAP phase 66, success criteria 1 to 5.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, returned keys with scores, backend, scores) to `corpus_retrievals` (own migration step), with retention | MET | `corpus/telemetry.ts` `retrievalRowOf`, `queryTextOf`, `returnedOf`; `corpus/reflect-store.ts` `appendRetrieval`, `sweepRetrievals`; step 38 in `index-store.ts`; `docs-search.reflect.test.ts` "one search appends exactly one row: the query hash, the redacted capped text, at most ten returned keys with scores, the backend and the surface", "a question holding a credential keeps no text at all, only its hash", "retention drains every expired batch in one pass, and only rows older than the retention window"; `reflect-store.test.ts` "the sweep deletes only rows older than the retention, oldest first, and never more than the batch" (live Postgres only) |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate against a document key, audited, admission-limited, idempotent per session and document | MET | `mcp.ts` `docs_feedback`; `server.ts` `/docs/feedback`; `admission.ts` `docs_feedback: "write"`; `packages/audit/src/policy.ts` (fail-open list); `corpus/reflect-service.ts` `docsFeedbackReply`; `reflect-routes.test.ts` "a verdict is stored once per session and document, the latest wins, and another session adds its own", "a document the manifest does not hold as active answers unknown-document and stores nothing", "the audit record is written under docs_feedback with the document and the verdict, never the note". Residual risk: verdict stacking (below) |
| 3 | `scoreDocument` is pure and tested; `SUBSTRATE_DOCS_RERANK=shadow` records what the re-rank would change, `on` applies it, `off` is the default | MET | `packages/corpus/src/authority.ts` `scoreDocument`; `authority.test.ts` "more helpful feedback never lowers the score and, next to a negative, strictly raises it", "a superseded document scores strictly lower than the same document not superseded"; `corpus/rank.ts` `reflectCitations`; `rank.test.ts` "on re-orders by score times authority, annotates each corpus citation and reports the positions moved"; `docs-search.reflect.test.ts` "off, and a flag left unset, answer byte for byte what a service with none of the new flags answers", "shadow answers byte for byte what off answers, and records on the telemetry row what on would have changed". Residual risks: shadow report not readable by a shipped command; re-rank inert when the plane gives no scores |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged in its citations | MET | `packages/corpus/src/supersession.ts` `detectSupersession` (rules 1 to 3), `supersededByMarker`; marker reads in `scan.ts`, `adapters/github.ts`, `adapters/greptile-export.ts` (`entrySupersededBy`); `supersession.test.ts` "flags a document whose marker names an existing row of the same repository", "an archived file under a milestone directory is superseded by the live file with the same remainder", "a loop of markers flags none of its members, and a document leading into it is not flagged either"; `docs-search.reflect.test.ts` "on drops a superseded document below the document that replaced it, and its citation carries stale and superseded_by". Rule 3 has tests in the same file; their titles were not read for this record |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | PARTIAL | `packages/corpus/src/reflect.ts` `buildDigest`; `packages/cli/src/corpus/reflect.ts` `collectDigests`; `corpus/reflect-service.ts` `corpusReflectReply`, `corpusGapsReply`; `corpus/digest-retain.ts`; `service.ts` `retainDigest`; `memory-write.ts` (`resolve: "lww"` for `corpus-digest:` subjects); `memory-retain.ts` `retainDocumentId` (subject-derived `subj_` id); `planes/hindsight.ts` (`update_mode: "replace"`); `reflect-store.ts` `gaps`; `reflect-service.test.ts` "stores a digest as the corpus document (repo, DIGEST_PATH), kind digest, through the ingest path, and retains it", "stored digests share one retain budget and do not each wait 5s", "lists the queries whose best score was none or below the gap score, most searched first, and leaves out answered ones and degraded searches". PARTIAL because no reflect run has been made, both LightRAG and Hindsight are required and were not exercised live, the gap score depends on a plane score field the fixture does not show, and nothing schedules reflect |

## The reflect loop, traced from code

1. `docs_search` → telemetry row (flag on) → `corpus_retrievals` → `GET /corpus/gaps`. Connected in code (`service.ts` `recordRetrieval`, `RetrievalRecorder`, `bunReflectStore.gaps`).
2. `docs_feedback` → `corpus_feedback` → feedback counts (cache 60 s) → `feedbackTerm` and `staleByFeedback` → re-rank. Connected (`docsFeedback` calls `authorityIndex.invalidateFeedback`; `AuthorityIndex` reads `reflectStore()`). The invalidation applies to this process only.
3. Manifest change → authority snapshot (version check every 30 s) → `detectSupersession` → `stale` and `superseded_by` → re-rank. Connected (`snapshotOf`, `reflectAnswer`).
4. Digest: CLI scan → `POST /corpus/reflect` → `ingestCorpus` to LightRAG → `retainDigest` through the governed write → `lww` retirement in Hindsight. Connected.
5. The re-rank touches only citations with `dataset: "corpus"`. Those exist only after a phase 63 ingest into LightRAG, and that ingest has not run in production (see `63-VERIFICATION.md`).

Nothing in the repository calls `docs_feedback`: `git grep` at 80afb6e5 finds only the tool, the route, the audit and admission tables, the tests and the docs. No hook, skill or scheduled job runs `substrate corpus reflect`. The loop therefore closes only when an operator or an agent makes those calls.

Status: PARTIAL. The code path connects end to end; no run of it exists.

## Residual risks

- **Verdict stacking.** `corpus_feedback` is keyed by the caller's `session_id`, and `feedbackCounts` sums rows per document. One surface can post `stale` for the same document under three session ids and reach `STALE_FEEDBACK_MIN` (3) with more stale than helpful votes. `authority-index.test.ts` seeds exactly this with sessions `a`, `b` and `c`. Only the active-row check and the admission limit bound it, and the verdict is not tied to a retrieval the session made.
- **Plane score dependence.** `planes/lightrag.ts` `toChunk` reads a score only when the entry has one (`readNumber` over `score`, `similarity`, and others); `docs-search.ts` uses `hit.score ?? 0` and `chunk.score ?? 0`. The hand-written v1.5.7 fixture (`planes/__fixtures__/lightrag-v1.5.7-routes.json`) shows no score field. If the live query returns none, every answered search has `top_score` 0, so every query with a citation is a gap at the default 0.2. The re-rank's score multiplier is then 0 for every corpus citation, so the order is the plane's own while `stale` and `superseded_by` still apply. [INFERENCE until a live response is captured.]
- **Shadow report unreadable.** `reflect-store.ts` `appendRetrieval` writes the `rerank` column. No route, CLI command or SQL statement in the repository reads it (`gaps` selects `top_score` only). `reflectCounters()` in `service.ts` is read only by tests. `docs/corpus-reflect.md` "Reading a shadow report" assumes a read path that does not exist.
- **Failed digest retain is not retried.** `corpusReflectReply` retains only digests whose outcome is `ingested` or `updated`. A digest whose manifest row is unchanged is answered `unchanged` and is not retained again, so a refused or failed Hindsight leg is not retried by a later run. A `pending` leg is parked by the retain outbox (`memory-retain.ts`); this record did not trace the outbox's retry.
- **Per-process state.** The authority snapshot and the feedback counts are per process (`authority-index.ts` header). A verdict stored through one server reaches another within 60 s, and a manifest change within 30 s.
- **Feedback bound.** `feedbackCounts(FEEDBACK_MAX_KEYS)` keeps the 5000 most recently voted documents. Older documents lose their feedback in the re-rank.
- **Live Postgres tests are conditional.** `reflect-store.test.ts` skips unless `SUBSTRATE_TEST_PG_URL` is set. The gaps SQL, the feedback upsert and the sweep are verified only through that file or the fake.
- **No end-to-end test of the loop.** No test calls `docs_feedback` and then checks `docs_search` order through `Substrate`. The feedback-to-authority link is tested at the index seam (`authority-index.test.ts`); the reorder is tested at `rank.ts` and in `docs-search.reflect.test.ts` with seeded counts. The digest path is tested through `corpusReflectReply` with fakes.
- **Hindsight scope.** Pin 0.9.1 (`.github/hindsight-pin.json`). Reflect and mental models are not used (decision D66-2), so Hindsight's own learning surface is not part of the loop.
- **Column name collision.** `corpus_documents.superseded_by` holds a marker path; the citation field `superseded_by` holds a document key (see `66-SUMMARY.md`, Deviations).

## Operator-gated

- Setting `SUBSTRATE_DOCS_TELEMETRY`, `SUBSTRATE_DOCS_RERANK` (`shadow`, then `on`), `SUBSTRATE_DOCS_GAP_SCORE` or the retention. All default off or conservative, and this PR sets none of them.
- Enabling `SUBSTRATE_CORPUS` and the LightRAG backend, which the feedback, reflect and gaps doors and the re-rank need.
- Running `substrate corpus reflect --execute` against a live LightRAG and Hindsight. No schedule exists.
- Wiring an agent, hook or skill to call `docs_feedback`. None exists in the repository.
- Rehearsing migration step 38 on a restored dump before production (`docs/runbooks/rollback-compat.md`, the row this PR added). Step 38 runs at every boot, with no flag.
- The phase 63 live ingest, which the re-rank depends on.

## Planning records

At 80afb6e5, `.planning/REQUIREMENTS.md` still lists REFLECT-01 to REFLECT-05 unchecked (lines 41 to 45), and the traceability table lists them as "Planned" (line 97). This record does not change either.
