---
phase: 66-docs-reflect
milestone: v1.7
requirements: [REFLECT-01, REFLECT-02, REFLECT-03, REFLECT-04, REFLECT-05]
status: merged to main in PR #184 (squash 80afb6e5); partial (see Deviations and What remains); no live LightRAG or Hindsight run, no reflect run, no verdict recorded, every flag off
---

# 66-SUMMARY: Docs Reflect, what the docs RAG learns from use

Merged to main by PR #184 (squash 80afb6e5, parent 8af55c5e, 76 files, +7199 / -84, committed 2026-10-30). Decisions are in [66-CONTEXT.md](66-CONTEXT.md); the operator page is [docs/corpus-reflect.md](../../../docs/corpus-reflect.md). Every claim below was read at 80afb6e5 with `git show`. Nothing was run by the author of this record.

## What was built

- **Retrieval telemetry (REFLECT-01).** `packages/mcp-server/src/corpus/telemetry.ts`. `retrievalRowOf` builds one row per `docs_search`: the query hash (`queryHash`), the query text only when the redactor changes neither the whole query nor its kept part (`queryTextOf`, cut to 200 characters), at most ten returned keys with scores (`returnedOf`), `topScore`, `degraded`, backend and surface. `RetrievalRecorder.record` returns at once. A write has a 2000 ms budget, at most 50 writes are in flight, and drops and failures are counted. `service.ts` `recordRetrieval` calls it after the answer is built, and only while `SUBSTRATE_DOCS_TELEMETRY=on`.
- **Retention.** `sweepExpiredRetrievals` deletes at most 1000 rows per batch, at most 50 batches, within 2000 ms per pass. `service.ts` `startRetrievalSweep` returns at once unless telemetry is on. `packages/mcp-server/src/index.ts` line 125 calls it at boot, and the hourly timer runs from there.
- **Feedback (REFLECT-02).** `docsFeedbackReply` in `corpus/reflect-service.ts` stores one verdict (`helpful`, `unhelpful`, `stale`, `wrong`, `duplicate`) per document key and `${surface}/${session_id ?? "surface"}` in `corpus_feedback`. It accepts a document only when the manifest holds it as an active row; otherwise it answers 404 `unknown-document`. Doors: `POST /docs/feedback` (`server.ts`), MCP tool `docs_feedback` (`mcp.ts`, registered without a flag), admission class `write` (`admission.ts`), audit fail-open (`packages/audit/src/policy.ts`, `observe.ts`). The `note` field is parsed and dropped.
- **Authority (REFLECT-03).** `packages/corpus/src/authority.ts` `scoreDocument` is `0.35 tier + 0.20 kind + 0.15 recency + 0.30 feedback`, multiplied by 0.4 when superseded. The feedback term is `(helpful + 2) / (helpful + costed negatives + 4)`, with costs unhelpful 1, stale 1.5, wrong 2 and duplicate 1. Recency halves every 365 days; an unknown age counts 0.5.
- **Authority index.** `corpus/authority-index.ts` `AuthorityIndex` is a per-process snapshot of the active manifest rows and their supersession. It is rebuilt when the manifest version moves (version checked every 30 s). Feedback counts are cached for 60 s. A lookup waits at most 500 ms. Every read fails open. Above `AUTHORITY_MAX_ROWS` (100 000) the snapshot is `partial` and copy comparison is off.
- **Re-rank (REFLECT-03).** `corpus/rank.ts` `reflectCitations`. `off` returns the citations unchanged. `shadow` returns them unchanged and reports the order `on` would take, which goes into the telemetry row's `rerank`. `on` multiplies each corpus citation's plane score by `0.5 + 0.5 × authority`, reorders the corpus citations within the slots they already held, annotates `stale` and `superseded_by`, and sets `rerank: {applied: true, moved}` on the answer. `service.ts` `reflectAnswer` runs after the docs cache, so a cached answer never holds the re-rank.
- **Supersession (REFLECT-04).** `packages/corpus/src/supersession.ts` `detectSupersession`, three rules applied in order. (1) An explicit `superseded-by` front-matter marker, read through `entrySupersededBy` by `scan.ts`, `adapters/github.ts` and `adapters/greptile-export.ts` and stored in `corpus_documents.superseded_by`. (2) A live document and its `milestones/` archive. (3) The same path in exactly two `local/*` copies of one source with different sha256; the older copy is superseded. Chains resolve to their end and loops flag nothing.
- **Digests (REFLECT-05).** `packages/corpus/src/reflect.ts` `buildDigest` produces deterministic markdown from `.planning/STATE.md`, `ROADMAP.md` and, when present, `PROJECT.md`. Its key is `corpus-digest:<repo>` and its virtual path is `.substrate/digest.md` (`packages/corpus/src/protocol.ts`). The CLI side, `packages/cli/src/corpus/reflect.ts`, collects checkouts, refuses symlinked planning paths and is a dry run unless `--execute`. The server side, `corpusReflectReply`, stores each digest through `ingestCorpus` as kind `digest`, tier 1. It then retains each stored digest in Hindsight through `service.ts` `retainDigest`, under one 8 s budget and four at a time. `corpus/digest-retain.ts` splits a digest into `corpus-digest:<repo>`, `:decisions` and `:open` parts of at most 4000 characters. Each part is a governed `fact` at `repo:<repo>` scope with `source_event` set to the run's session id and `resolve: "lww"` (`packages/mcp-server/src/memory-write.ts`), so a newer digest retires the standing row.
- **Gaps (REFLECT-05).** `GET /corpus/gaps` (`server.ts`) calls `corpusGapsReply`, which calls `bunReflectStore.gaps` in `corpus/reflect-store.ts`. That query covers 30 days, excludes degraded rows, groups by query hash and keeps the hashes whose best score is null or below `SUBSTRATE_DOCS_GAP_SCORE`. The CLI is `substrate corpus status --gaps` (`packages/cli/src/corpus/index.ts`).
- **Storage.** Migration step 38 `corpus_reflect` in `packages/mcp-server/src/index-store.ts`: the column `corpus_documents.superseded_by`, the tables `corpus_retrievals` and `corpus_feedback`, and three indexes. It has no `optIn`, so it runs at every boot and its tables stay empty while the flags are off. `rollback-compat.test.ts` names it and the archive contract allowlists both tables.
- **Flags.** `loadDocsReflectSettings` in `packages/mcp-server/src/config.ts`; rows in `flag-registry.ts`. `SUBSTRATE_DOCS_TELEMETRY` is off unless `on`. `SUBSTRATE_DOCS_TELEMETRY_RETENTION_DAYS` defaults to 30 and accepts 1 to 365. `SUBSTRATE_DOCS_RERANK` is `off` unless it is `shadow` or `on`. `SUBSTRATE_DOCS_GAP_SCORE` defaults to 0.2. The feedback, reflect and gaps doors also need `SUBSTRATE_CORPUS=on` (`reflectDeps` in `service.ts`). Reflect also needs the LightRAG backend (`gateOf(..., true)` in `reflect-service.ts`).

## Key decisions

- **D66-1, telemetry keeps a hash and capped text, never a snippet. Held.** `retrievalRowOf` stores no citation text.
- **D66-2, no Hindsight reflect, mental models, observations or directives. Held.** `packages/mcp-server/src/planes/hindsight.ts` has no call to any of them. The pin is 0.9.1 (`.github/hindsight-pin.json`).
- **D66-3, digests go through the governance gate. Held.** `service.ts` `retainDigest` writes through `writeMemoryWithLeg`. The leg's own outcome is reported, and an undelivered leg is `pending`, never `stored` as delivered (`digest-retain.ts`, `retainDigestOutcome`).
- **D66-4, authority is a pure function and the re-rank ships shadow first. Held.** `scoreDocument` takes only its inputs, and `off` is the default.
- **D66-5, supersession comes from facts the corpus already has. Held.** The three rules in `supersession.ts`.
- **D66-6, a gap is a query with no citation or a low score, aggregated by query hash. Held.** `isGap` and the `gaps` SQL say the same.
- **Decided in code, not in the context.** The digest reads `PROJECT.md` as well as STATE and ROADMAP. A digest whose retain leg is not delivered yet is reported `hindsight:pending`, not as a failure.

## Deviations from the plan

- **Step 38 is not an opt-in migration.** The opt-in steps are 33 and 34 (`steering-audit`) and 37 (`steering-sessions`). Step 38 always runs, and its tables are empty while every flag is off. An operator therefore cannot defer it with a flag; it must be rehearsed like steps 33 to 36, as its own comment says.
- **Digest sources.** ROADMAP success criterion 5 names STATE and ROADMAP. The code also reads PROJECT.md when it exists.
- **Gap wording.** `docs/corpus-reflect.md` says a query that returned nothing "counts as best 0". The code and `reflect-routes.test.ts` show `best: null`. The SQL counts such a query as a gap either way.
- **Column name collision.** `corpus_documents.superseded_by` holds a repo-relative marker path. The citation field `superseded_by` holds a document key (`repo:path`). The same name carries two different shapes.
- **Re-rank scope.** Only citations with `dataset: "corpus"` are touched. Those come from the LightRAG path (`docs-search.ts` `withCorpusProvenance`). RAGFlow answers are never re-ranked or annotated.

## Findings

The squash message records "reflect review round 1" and "round 2" and eight further fix commits; the feature commit is the first of eleven bullets. The Greptile findings are not in the repository, and this record cites none. The orchestrator's brief states that the Greptile gate passed 5/5 after several rounds.

## What remains

- No live run. LightRAG, Hindsight and the Postgres index were not exercised against a deployment. Every test uses fakes, except `reflect-store.test.ts`, which runs only when `SUBSTRATE_TEST_PG_URL` is set.
- Operator-gated and not done: setting any of the four flags; enabling `SUBSTRATE_CORPUS` and LightRAG for the reflect, feedback and gaps doors; running `substrate corpus reflect --execute`; wiring any agent or hook to call `docs_feedback`; rehearsing step 38 on a restored dump. There is no scheduler for reflect, and nothing in the repository calls `docs_feedback`.
- The re-rank and the stale annotations depend on corpus citations, which exist only after the phase 63 ingest. That ingest has not run in production.
- The shadow report described in `docs/corpus-reflect.md` cannot be read by any shipped command. The residual risks, with their evidence, are in [66-VERIFICATION.md](66-VERIFICATION.md).
