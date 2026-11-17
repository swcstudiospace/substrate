---
phase: 70-docs-slo-and-eval
verified: 2026-10-30
status: gaps_found
score: 3 of 5 success criteria MET in the repository (criteria 1, 2, 4), 2 PARTIAL (criteria 3, 5); no live run, the golden baseline is self-supervised and reads 1.0 on every metric
verified_on: main at 8af55c5e (PR #182) and d4cd350c (PR #176) (files read with git show; nothing was run by the author of this record)
---

# 70-VERIFICATION: Docs SLO and eval, measured without labels and guarded in CI

## Gates

Not run by the author of this record. The repository's single verify gate is the `verify` step list in `docs/ci.md` (d4cd350c, lines 59 and 65: install, types, Biome lint, tests against a scratch Postgres, the repo locks). The docs lint and the offline harness run inside `bun test`, so they are part of that gate and add no CI step (`docs/ci.md`, "Docs lint"; `docs/corpus-eval.md`, "The offline harness"). The orchestrator reports that Biome, tests and tsc were run in worktrees before each PR and that the Greptile merge gate (5/5, no open threads, CI green, squash) was run by the ship loop for each PR; that is not read from PR threads here. This record's evidence is file paths, test titles and constants read on main at 8af55c5e and d4cd350c. No test pass counts or timings are cited. The `test(` counts below are static occurrences in the source files, not executed results.

## Success criteria

The criteria are the five of the phase 70 entry in `.planning/ROADMAP.md` at 8af55c5e (lines 1180 to 1190).

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `generateGolden` derives queries from titles and headings with the expected document key; `scoreRun` computes recall at k, MRR and latency percentiles; `scripts/docs-eval.ts` runs them against a live server with `--execute` and against a fake retriever otherwise | MET (wording differs: the live flag is `--live URL`, not `--execute`) | `packages/corpus/src/eval.ts` at 8af55c5e: `generateGolden` (title, heading, lead per document; `expected` is the `repo:path` key), `scoreRun`, `recallAtK`, `mrr`, `percentile`. `scripts/docs-eval.ts` header (line 8): `bun scripts/docs-eval.ts --live URL [--json]`; offline mode runs `runOffline` (lexical) and `runServer` (fake plane). `packages/corpus/src/eval.test.ts` (29 `test(` blocks) and `eval-lexical.test.ts` (8) exist; not executed here. |
| 2 | A deterministic offline harness (a lexical retriever over a fixture corpus) runs in `bun test` and fails when ranking, de-duplication or the re-rank regress | MET (baseline self-supervised, see Residual risks) | `packages/corpus/src/eval-lexical.ts` (BM25, title weight, collapse of exact duplicates, `rerank` hook). `scripts/docs-eval.test.ts`: `describe("the committed offline harness ...")` (line 80), "a re-rank that puts the best hit last fails the comparison, in the retriever alone and through the server's search code" (line 165), "a re-rank that drops the leading hit fails it too, on both paths" (line 174), "the shipped pipeline collapses every group of identical documents to its smallest key, on both paths" (line 195), "a retriever that answers both copies of a page, or the wrong one, is reported" (line 207). Thresholds in `scripts/docs-eval.ts`: `RECALL5_TOLERANCE = 0.02`, `MRR_TOLERANCE = 0.03`. Baseline `scripts/docs-eval.baseline.json`: `lexical` and `server` each `{queries: 93, recall1: 1, recall5: 1, recall10: 1, mrr: 1}`. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` and the docs canary report a breach; the staged canary timer runs `docs-eval` | PARTIAL | Met in part: `packages/corpus/src/slo.ts` (`SLO_DEFAULTS`, `loadSloThresholds`, `sloBreaches`); `packages/mcp-server/src/flag-registry.ts` lines 855 to 857 (the three `SUBSTRATE_DOCS_SLO_*` flags); `packages/observability/src/instruments.ts` lines 721 to 724 (`substrate.corpus.freshness_seconds`, `substrate.corpus.ingest_docs_per_second`, `substrate.corpus.golden_recall5`); `packages/mcp-server/src/metrics-history.ts` lines 161 to 163 and 415 to 417; `packages/mcp-server/src/fabric/status.ts` `corpusRow` (line 75) and `fabric/gather.ts` line 163. Canary: `scripts/docs-golden.ts` `measureGolden` (line 664) and the breach check near line 630; the golden part calls `measureGoldenRecall` from `docs-eval.ts`, so the canary reuses the harness code rather than invoking the CLI. Gaps: no series named sync lag (only freshness, the age of the newest manifest change); the timer `infra/vps/substrate-docs-canary.timer` (`OnCalendar=*-*-* 04:41:00 UTC`) and its service are staged and not installed. |
| 4 | A test fails on a broken relative link anywhere in `docs/` and `.planning/` (archives included), and on a missing level-1 title in `docs/` and the live `.planning/` files | MET (mechanism); the roadmap's count of repaired links is not reconciled | `scripts/docs-lint.ts` (d4cd350c): `lintDocs`, `brokenRelativeLinks`, `missingTitle`, `titleRequired`; links read via `Bun.markdown.render`. `scripts/docs-lint.test.ts`: `describe("brokenRelativeLinks")` (line 25), `describe("missingTitle")` (line 96), `describe("lintDocs")` (line 123), "the committed documents ... have no broken relative link and every docs page and live planning file has a level-1 title" (line 163). `scripts/planning-integrity.test.ts`: the legacy exemption list is removed (d4cd350c stat: the file is changed by 42 lines). `docs/ci.md` (d4cd350c, lint section). Counts: the commit message says "44 findings"; the roadmap says 42 in three roadmaps and 8 in v1.3 pattern records (50). Not reconciled. Anchors are not checked: `brokenRelativeLinks` strips `#fragment` before the existence check. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the command that proves each step; the golden set has a case for each new runbook and the eval finds it | PARTIAL | Runbook part met: `docs/runbooks/docs-rag-operations.md` (170 lines) has sections 1 to 10, including "1. Deploy the release", "4. The first ingest", "5. The sync and canary timers", "10. Roll back, step by step", and a **Check.** line in each. Gaps: no case per runbook is asserted anywhere; `generateGolden` walks `docs/` recursively (`collectLocalDocuments`, `scripts/docs-eval.ts`, depth 8), so the runbook would produce questions if it has a title or heading, but the live eval that would show whether it is found has not run. Runbook drift: section 5 relies on `infra/vps/substrate-corpus-sync.*`, which is not in the 8af55c5e tree; section 6 says nothing reads `SUBSTRATE_DOCS_RERANK`, which is true at 8af55c5e but not at 80afb6e5 (`packages/mcp-server/src/config.ts` line 1547 reads it), and the runbook text at 80afb6e5 still says it waits (lines 120 and 165); section 10 names `substrate corpus reconcile`, which is not in `packages/cli/src` at 8af55c5e. |

## Baseline and golden set (what the harness reports)

- The golden set is not a file. `generateGolden` produces it from the documents on each run. The only recorded count is `scripts/docs-eval.baseline.json` at 8af55c5e: `queries: 93` for `lexical` and for `server`.
- That count was not regenerated here (no runs were permitted). Raw line counts in the 33 fixture documents give 33 level-1 lines, 66 level-2 lines and one lead per document, an upper bound of 132 candidates before the drop rules (copies, under 3 words, ambiguous phrases), the cap (3 per document; 2000 per set) and the answer-group rules. The 93 sits inside that bound; no finer claim is made.
- The recorded scores are `recall1 = recall5 = recall10 = mrr = 1` for both entries. `baselineOf` keeps four decimals; latency is not in the baseline.
- The baseline was written by running `bun scripts/docs-eval.ts --write-baseline` once (`docs/corpus-eval.md`, "Updating the baseline"). It is self-supervised: the queries are titles, headings and lead sentences of the same documents the index holds, and no human wrote or labelled a question.

## Residual risks

- **The baseline cannot show retrieval quality.** A perfect 1.0 on questions taken from the indexed text is what the harness reports; the guard is the comparison against that baseline plus the doctored-re-rank tests [INFERENCE from reading `eval.ts` and `eval-lexical.ts`]. A ranking regression that still answers the title query passes.
- **The `server` baseline measures the search code over a fake plane.** The plane's own ranking is the fake's (`packages/mcp-server/src/docs-eval-server.ts`, `EVAL_PLANE_URL` is `http://lightrag.example.test`); `docs/corpus-eval.md` says so.
- **The recall SLO default of 0.6 has no derivation in the commit** (`packages/corpus/src/slo.ts`, `SLO_DEFAULTS`) [INFERENCE: no source states how it was chosen].
- **`substrate corpus eval` without `--server` exits 0 and only counts questions** (`packages/cli/src/corpus/eval.ts` header). A timer that omits `--server` reads as a pass.
- **Exit codes differ by entry point.** `scripts/docs-eval.ts --live` exits 3 when not every question was scored; `substrate corpus eval` exits 1 for both a breach and an unscored run. The canary exits 1 on a golden breach as it does on a fixture regression (`scripts/docs-golden.ts`, the `goldenBreached` return).
- **The canary measures the golden set only when `SUBSTRATE_CORPUS=on`** (`measureGolden`, line 666). With the flag off, `fabric_status` has no recall reading and the breach cannot be seen there.
- **`--live` measures this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO`** (default `swcstudiospace/agent-substrate`). Until those documents are in the corpus under that name, every question misses (`docs/corpus-eval.md`, "Live").
- **Docs lint does not check anchors** (`brokenRelativeLinks` strips `#fragment`; `scripts/docs-lint.test.ts`, "does not check anchors alone, absolute paths or URLs with a scheme").
- **Two golden sets coexist.** `scripts/docs-golden.ts` keeps four hand-written fixtures in `fixtures/docs-golden/` (`credentials-redacted.json`, `review-gate.json`, `substrate-door.json`, `unanswerable.json`), with thresholds its header says are set for the toy retriever. They are not the phase 70 set.
- **The `EVAL-01..05` checkboxes in `.planning/REQUIREMENTS.md` remain `[ ]`, with the traceability row "Planned"**, at 8af55c5e (lines 74 to 78, 101). This record does not change them.
- **Runbook drift** listed under criterion 5.

## Operator-gated

Not run and not done by this phase:

- Deploying with `SUBSTRATE_CORPUS=on` and a LightRAG backend (`docs/runbooks/docs-rag-operations.md`, section 2).
- The first ingest against the live corpus, and `substrate corpus eval --server` against it (section 4, its check).
- Installing the canary: `infra/vps/substrate-docs-canary.service`, `.timer` and the drop-in; `SUBSTRATE_DOCS_CANARY=1` and `SUBSTRATE_DOCS_CANARY_MANIFEST` (an attested `{sha256, dataset_commit}`). The sync units named in runbook section 5 are not in the 8af55c5e tree and are not part of this phase's gate.
- Choosing the three `SUBSTRATE_DOCS_SLO_*` values (defaults 86 400 s, 0.6, 0.2 documents/s).
- Promoting the re-rank (`SUBSTRATE_DOCS_RERANK`, `shadow` then `on`), which needs a recorded number to beat (section 6).

Milestone-level operator gates (hook and timer installs in any host, Railway writes and deploys, devnet sends and anchor funding, the LightRAG LLM route, live bulk ingest, the Greptile knowledge-base export ingest) are outside this phase's scope and are not verified here.
