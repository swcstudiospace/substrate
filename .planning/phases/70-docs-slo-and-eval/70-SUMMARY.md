---
phase: 70-docs-slo-and-eval
milestone: v1.7
requirements: [EVAL-01, EVAL-02, EVAL-03, EVAL-04, EVAL-05]
status: merged to main in PR #182 (squash 8af55c5e) and the docs lint in PR #176 (squash d4cd350c); partial (see Deviations and What remains); no live docs-plane run, no canary installed, no production corpus measurement
---

# 70-SUMMARY: Docs SLO and eval, measured without labels and guarded in CI

Built in one orchestrated wave of edit-only units (no gsd-plan-phase run; `.planning/ROADMAP.md` at 8af55c5e, phase 70, "Plans: none written"). Decisions are in [70-CONTEXT.md](70-CONTEXT.md). The verification record is [70-VERIFICATION.md](70-VERIFICATION.md). Operator pages: [docs/corpus-eval.md](../../../docs/corpus-eval.md) and [docs/runbooks/docs-rag-operations.md](../../../docs/runbooks/docs-rag-operations.md). File references are to the trees at the squash commits named above; the worktree's own HEAD is older and does not contain 8af55c5e.

## What was built

- **Golden set generator, `packages/corpus/src/eval.ts`.** `generateGolden` derives up to three questions per document from its level-1 title, each level-2 heading joined to the title, and the first sentence of the first paragraph cut to 12 words (`GOLDEN_QUERIES_PER_DOCUMENT = 3`, `GOLDEN_LEAD_WORDS = 12`). The expected answer is the document key `repo:path`. Identical texts form one answer group, and a question is dropped when it is under 3 words or its phrase is ambiguous across groups. `scoreRun` returns `recall1`, `recall5`, `recall10`, `mrr` and nearest-rank `p50Ms`/`p95Ms`.
- **Offline retriever, `packages/corpus/src/eval-lexical.ts`.** BM25 over the fixture corpus, with the title counted three times (`TITLE_EXTRA_WEIGHT = 2` extra), exact duplicates collapsed to the smallest key, and a `rerank` hook applied after collapse and before the limit.
- **Live runner, `packages/corpus/src/eval-live.ts`.** Asks `POST /docs/search` for dataset `corpus`, `LIVE_MAX_QUERIES = 500`, a 10 s timeout per question, a 600 s run deadline and a stop after 5 consecutive failures. A question the caller's `unsafe` check would change is held back and counted, never sent.
- **SLO thresholds, `packages/corpus/src/slo.ts`.** `SLO_DEFAULTS` = freshness 86 400 s, `recall5` 0.6, ingest 0.2 documents/s, read from `SUBSTRATE_DOCS_SLO_FRESHNESS_S`, `SUBSTRATE_DOCS_SLO_RECALL5` and `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`. `sloBreaches` treats a `null` reading as no breach.
- **Server SLO state, `packages/mcp-server/src/corpus/slo.ts`.** `CorpusSloState` holds the three readings. Freshness is the age of the manifest's last ingest; the ingest reading counts only requests that uploaded documents; `recordGolden` accepts a `golden_recall5` in [0, 1] from a `docs.canary` payload.
- **Server search path under test, `packages/mcp-server/src/docs-eval-server.ts`.** `createServerEvalSearch` runs the production `Substrate.searchDocs` against a fake LightRAG `/query` that serves the lexical hits.
- **Offline harness, `scripts/docs-eval.ts`, with `scripts/docs-eval.baseline.json` and `scripts/docs-eval.test.ts`.** Scores the golden set twice (`lexical` and `server`). Fails on a recall@5 fall over 0.02 or an MRR fall over 0.03, on fewer questions than the baseline, or on a duplicate group not answered as its smallest key. Runs inside `bun test`.
- **Live mode and canary, `scripts/docs-eval.ts --live URL`, `scripts/docs-golden.ts --live --emit`.** The CLI reads this checkout's `docs/` (`collectLocalDocuments`, recursive, `maxFiles` 5000, depth 8) and exits 0, 1 (SLO breach) or 3 (not every question scored). The canary asks at most 200 of them (`CANARY_GOLDEN_MAX_QUERIES`) and posts a `golden_recall5` note; it measures only when `SUBSTRATE_CORPUS=on` (`measureGolden`, `scripts/docs-golden.ts` near line 664).
- **CLI, `packages/cli/src/corpus/eval.ts` and `index.ts`.** `substrate corpus eval [--root DIR] ... [--server URL] [--json]`. Without `--server` it only counts questions and exits 0. With a server it exits 1 on a breach or an unscored run.
- **Metric series and fabric row.** `CORPUS_FRESHNESS_METRIC`, `CORPUS_INGEST_RATE_METRIC`, `CORPUS_GOLDEN_RECALL5_METRIC` in `packages/observability/src/instruments.ts` (lines 721 to 724); series `corpus.freshness_seconds`, `corpus.ingest_docs_per_s`, `corpus.golden_recall5` in `packages/mcp-server/src/metrics-history.ts` (lines 161 to 163 and 415 to 417); the `corpus` row of `fabric_status` in `packages/mcp-server/src/fabric/status.ts` (`corpusRow`, line 75). A `docs.canary` event is accepted only from the `substrate` token (`packages/mcp-server/src/reserved-actions.ts`, header comment).
- **Staged canary unit, `infra/vps/substrate-docs-canary.service`, `.timer`, `.service.d/10-environment.conf`, `30-sandbox.conf.example`.** The timer fires daily at 04:41 UTC; the service has `ConditionPathExists` on the release's `scripts/docs-golden.ts`. Nothing installs it.
- **Operator runbook, `docs/runbooks/docs-rag-operations.md`** (170 lines): ten numbered steps (1 deploy the release, 2 turn the corpus on, 3 first inventory and plan, 4 first ingest, 5 sync and canary timers, 6 re-rank, 7 read the objectives, 8 what each alert means, 9 CI and the baseline, 10 roll back), each with a check.
- **Docs lint, `scripts/docs-lint.ts` and `scripts/docs-lint.test.ts` (PR #176, squash d4cd350c).** Checks that every relative link and image in `docs/`, `.planning/` (archives included) and four root documents resolves, and that every `docs/` page and live `.planning/` file opens with a level-1 title. Links come from `Bun.markdown.render` callbacks. `scripts/planning-integrity.test.ts` loses its legacy exemption list; the archived roadmaps and pattern records were repaired.
- **Eval fixture corpus, `packages/corpus/fixtures/eval/`.** `manifest.json` lists 33 documents: 12 in `acme/atlas` (including an archive copy at `milestones/v1.1/docs/backup-restore.md`, identical to `docs/backup-restore.md`), 11 in `acme/harbor`, 10 in `acme/lantern`. The set includes a near-duplicate (`push-notifications-draft.md`) and a README.

## Key decisions

- **D70-1, generated set, held.** Queries come from the corpus itself, with no labels (`packages/corpus/src/eval.ts`, header).
- **D70-2, lexical stand-in in CI, held.** CI cannot reach a live plane. `docs/corpus-eval.md` ("The offline harness") says the lexical retriever guards pipeline logic and says nothing about embedding quality.
- **D70-3, history path reused, held.** The three series go through `metrics-history.ts`, as the context decided.
- **D70-4, lint as a `bun test` file, held.** `docs/ci.md` (d4cd350c, lint section) states the CI commands did not change.
- **D70-5, runbook as deliverable, held.** The runbook exists; its step-level status is in Deviations.
- **Changed from the roadmap wording: the live flag.** The roadmap's criterion 1 says "with `--execute`"; the code uses `--live URL` (`scripts/docs-eval.ts`, header, line 8). The offline run needs no flag.
- **Changed in review: the canary's golden check is gated on `SUBSTRATE_CORPUS=on`.** The `SUBSTRATE_CORPUS` row of `packages/mcp-server/src/flag-registry.ts` (line 849) says the canary skips its golden check when it is off; `measureGolden` in `scripts/docs-golden.ts` (line 666) returns `null` unless the variable is `on`.

## Deviations from the plan

- **The baseline is self-supervised, and it is 1.0 on every metric.** `scripts/docs-eval.baseline.json` at 8af55c5e records `queries: 93`, `recall1`, `recall5`, `recall10` and `mrr` all `1` for both `lexical` and `server`. The file was written by `--write-baseline` once (`docs/corpus-eval.md`, "Updating the baseline"). The queries are built from text the same retriever indexes, so a perfect score measures the pipeline on its own documents, not retrieval quality [INFERENCE from reading `eval.ts` and `eval-lexical.ts`; not measured]. The sensitivity is shown by the tests that doctor the re-rank (`scripts/docs-eval.test.ts`, "a re-rank that puts the best hit last fails" and "a re-rank that drops the leading hit fails it too"), not by the baseline values.
- **Criterion 5 of the roadmap is not met as written.** It asks that "the golden set has a case for each new runbook and the eval finds it." Nothing asserts a case per runbook. The generator does walk `docs/` recursively, so `docs/runbooks/docs-rag-operations.md` would produce questions if it has a title or heading, but that was not observed in a run.
- **Criterion 3 names "sync lag"; no such series exists here.** The three series are freshness, ingest rate and golden recall. Freshness is the age of the newest manifest change, which is not the same as sync lag. The trigger-lag warning (`docs.freshness`) is named in the runbook's failure table and belongs to phase 65.
- **The runbook says two things wait that are not true of later main.** Step 5 says the sync units are staged by phase 65; `infra/vps/substrate-corpus-sync.*` is not in the 8af55c5e tree. Step 6 says the re-rank waits because nothing reads `SUBSTRATE_DOCS_RERANK`; that is true at 8af55c5e, but `packages/mcp-server/src/config.ts` at 80afb6e5 (PR #184) reads it. The runbook text at 80afb6e5 still says it waits (`docs/runbooks/docs-rag-operations.md`, lines 120 and 165). Step 10 names `substrate corpus reconcile`; no such command exists in `packages/cli/src` at 8af55c5e.
- **The roadmap's broken-link counts do not match the commit.** Roadmap criterion 4 says 42 links in three roadmaps and 8 in v1.3 pattern records. The d4cd350c commit message says "44 findings". Not reconciled here.
- **The `EVAL-01..05` checkboxes in `.planning/REQUIREMENTS.md` are still `[ ]` and the traceability row says "Planned"** at 8af55c5e. This record does not change them.

## Findings

Review rounds are recorded in the commit messages of 8af55c5e and d4cd350c; their content is the only evidence read here:

- **Round 1.** Reserved canary reports; a failed manifest read degrades the corpus row; copies score as one answer; partial scans are labelled; a ranking guard through the server; throughput counts uploads; fences.
- **Round 2.** The golden check follows `SUBSTRATE_CORPUS`; rank slots for non-corpus results; copy groups in the CLI eval; one timestamp for freshness; an unscored verdict.
- **Round 3.** Questions that look like credentials are never sent (`unsafe` in `eval-live.ts`, and the redactor check in `scripts/docs-eval.ts`); copies are grouped on the whole text, not the first 200 000 characters.
- **Round 4.** `golden_asked` counts the questions measured, not generated.
- **Follow-up.** A dropped leading hit stays a document, so the plane client does not retry an empty body.
- **Lint.** The first version used regular expressions; the fix (d4cd350c, second commit) reads links and titles with Bun's markdown parser, after the regex reading misread titled, reference and angle-wrapped destinations.

Greptile 5/5 and the ship-loop merge gate for each PR are reported by the orchestrator; they were not read from PR threads here.

## What remains

- No live run of `--live` or of the canary against any deployment, so no production recall number exists. The first production reading needs the corpus ingested under `SUBSTRATE_DOCS_EVAL_REPO` and `SUBSTRATE_CORPUS=on`.
- The canary timer and service are staged. Installing them and setting `SUBSTRATE_DOCS_CANARY=1` with an attested manifest is an operator step.
- The golden baseline is self-supervised. A human-labelled set does not exist.
- `scripts/docs-golden.ts` keeps its own hand-written fixtures in `fixtures/docs-golden/` (four JSON files at 8af55c5e). They are a second, older set with thresholds set for the toy retriever, and the header of `scripts/docs-golden.ts` says so.
- The SLO defaults (`recall5` 0.6, ingest 0.2 documents/s, freshness one day) have no derivation in the commit [INFERENCE: no source states how they were chosen].
- The docs lint does not check anchors: `brokenRelativeLinks` strips `#fragment` before the existence check, and `scripts/docs-lint.test.ts` asserts "does not check anchors alone".
- The runbook drift listed under Deviations.
