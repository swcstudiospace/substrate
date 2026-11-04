# Corpus evaluation and objectives (v1.7 phase 70)

The docs plane is only as good as the answers it gives. This page explains how that is measured without any labels, how the measure is guarded in CI, and which three readings the server judges against objectives you can set. The operator's path through all of it is [`runbooks/docs-rag-operations.md`](runbooks/docs-rag-operations.md); the corpus itself is [`corpus.md`](corpus.md) and [`runbooks/corpus-ingest.md`](runbooks/corpus-ingest.md).

## The golden set

A golden set is a list of questions with the document each should find. This one is generated from the documents themselves, so it grows with the corpus and needs no one to write it (`generateGolden` in `packages/corpus/src/eval.ts`). For each Markdown document it derives up to three questions, in this order:

1. the level-1 title;
2. each level-2 heading joined with the title (`Title Heading`);
3. the first sentence of the first paragraph, cut to 12 words.

The expected answer is the document's key, `repo:path`. Headings and paragraphs inside code fences and a YAML front matter block are ignored, and link text, code spans and emphasis are reduced to the words a reader sees. A fence closes as CommonMark closes it: on a run of the same character (backticks or tildes) at least as long as the one that opened it, with no text after it, so a four-backtick block that shows a three-backtick example stays one block, and a fence that never closes runs to the end of the document.

Documents with identical text (a copy, or an archive under `milestones/`) are **one answer group**: the copy with the smallest key asks the questions, and a hit on any copy of the group answers them (`alsoExpected`), so a retriever that returns the canonical copy and one that returns another copy both score a hit. Identity is decided on the **whole text** (line endings normalised, compared by a SHA-256 digest): two pages that share their first 200,000 characters, the most the outline reads, but differ later are two groups, so the questions they share are dropped as ambiguous rather than answered by either. Copies must be identical; only the canonical copy's first 200,000 characters are read for questions.

A question is **dropped, never guessed**, when it cannot name one group:

- it is shorter than 3 words;
- it is a phrase that occurs in more than one group's title (the same title in two repositories, or a title that is a phrase of a longer one);
- the same phrase is asked by two different groups. Who asks a phrase is counted over every candidate **before** any sampling, so what one page keeps never depends on what another page happened to sample.

The selection is deterministic: documents are visited in key order, and when a cap bites (3 questions per document, 2000 for a whole set by default) the title is kept and the rest are chosen with a seeded generator, so the same corpus gives the same questions on every machine.

### The metrics

`scoreRun` folds the ranked answers of any retriever into `{ queries, recall1, recall5, recall10, mrr, p50Ms, p95Ms }`:

| Metric | Meaning |
| --- | --- |
| `recall@k` | The share of questions whose expected document is among the first `k` answers. |
| `mrr` | The mean of 1 over the rank of the expected document; a miss adds 0. |
| `p50Ms`, `p95Ms` | Nearest-rank percentiles of the time one question took. |

## Three places it runs

| Where | Retriever | Guards | Runs |
| --- | --- | --- | --- |
| `bun scripts/docs-eval.ts` (and `scripts/docs-eval.test.ts` inside `bun test`) | an offline, deterministic lexical retriever over `packages/corpus/fixtures/eval/`, alone and behind the production search code | the pipeline logic: ranking inputs, de-duplication, re-rank, and the server's own handling of an answer | every CI run, no network |
| `bun scripts/docs-eval.ts --live URL`, and the docs canary | the server's `POST /docs/search` over this checkout's `docs/` | the live corpus: is each document findable | by hand, and daily from the staged canary timer |
| `substrate corpus eval --server URL` | the same route, over the documents the local scan found | the same, for any set of roots | by hand or from a timer |

### The offline harness (CI)

CI cannot reach a live docs plane, so a lexical retriever stands in. It does not say how good embeddings are. It guards the logic around them: what reaches ranking (tokenising, the title counted three times in all), the collapse of exact duplicates to one result under the lexically smallest key, and the re-rank step (`rerank?: (hits) => hits`, where the authority scores plug in). The fixture corpus is about thirty invented documents in three repositories with an archive copy of a live page, a near-duplicate, and one title in two repositories.

The same questions are answered twice, and the baseline file keeps one entry for each:

| Baseline | What answers | What a regression in it means |
| --- | --- | --- |
| `lexical` | the retriever alone (`packages/corpus/src/eval-lexical.ts`) | the tokenising, the title weight, the collapse of exact duplicates or the re-rank hook moved |
| `server` | the production `Substrate.searchDocs` over a fake LightRAG plane that serves the same retriever's hits, worst first (`packages/mcp-server/src/docs-eval-server.ts`) | something in the server's own path moved: the plane client's parsing of the answer, the citation of a corpus document under its URL, the sort by score, the cap of ten, or the reduction to one key per document |

What neither one guards: embedding quality (the live tier is for that), the plane's own ranking (the fake plane plays it), and a de-duplication step the server does not have. `searchDocs` holds no de-duplication of its own; it relies on the plane keeping one copy of identical text, which the fake models as the retriever's collapse. The duplicate probe runs on both paths, so the day the server starts answering two copies of one page, or the wrong one, it fails.

`bun scripts/docs-eval.ts` prints the metrics and compares them with `scripts/docs-eval.baseline.json`:

- a fall of more than **0.02** in recall at 5, or **0.03** in MRR, fails (exit 1);
- fewer questions than the baseline asked fails too, so a generator that loses questions cannot read as a pass;
- a group of exact-duplicate documents that the retriever does not answer as its smallest key fails (a de-duplication regression moves no score, because a copy is one answer group and a hit on either copy counts, so each group is probed directly);
- an improvement passes and prints a hint to record it.

`bun scripts/docs-eval.ts --json` prints one object (`score` and `baseline` for the lexical run, and `server` with its own). `scripts/docs-eval.test.ts` runs the same thing inside `bun test`, so the CI workflow gains no step (see [`ci.md`](ci.md)); it also proves the failure path against a doctored baseline and a deliberately broken re-rank, on both runs.

**Updating the baseline.** When a change to the generator, the retriever or the fixtures is intended, run `bun scripts/docs-eval.ts --write-baseline`, read the diff of `scripts/docs-eval.baseline.json` and commit it with the change. Never edit the numbers by hand to make a failure go away: a failure means ranking, de-duplication or the re-rank moved, and the first question is whether it should have.

### Live

`bun scripts/docs-eval.ts --live URL [--json]` is read-only. It needs `SUBSTRATE_TOKEN` (the bearer, named here and never printed), generates the golden set from the Markdown under this checkout's `docs/` (up to 500 questions) and asks `POST /docs/search` for the `corpus` dataset. The repository name the documents are expected under is `SUBSTRATE_DOCS_EVAL_REPO` (default `swcstudiospace/agent-substrate`); until this repository's documents are in the corpus under that name every question misses.

| Exit | Meaning |
| --- | --- |
| 0 | every question was answered and recall at 5 holds `SUBSTRATE_DOCS_SLO_RECALL5` |
| 1 | recall at 5 is under the objective |
| 2 | usage, or no `SUBSTRATE_TOKEN` (nothing is sent) |
| 3 | not every question could be scored: one failed, came back degraded (a plane outage, which is not a retrieval miss), the run stopped after five failures in a row or at its 10 minute deadline, or nothing was answered |

A partial score is never presented as a pass: the line it prints says how many were answered, failed and degraded.

**A question that looks like it carries a credential is never sent.** The golden set is written from local documents, and a first paragraph can hold a real key that ingest refused as `secret-findings`. Before each request the live run applies the same check ingest applies (the shared redactor: a question it would change is held back). A held-back question is not sent, not scored and not counted as failed; the run says how many (`N questions were not sent: they look like they contain a credential (the same check ingest applies)`, and `skippedUnsafe` in `--json`), never which. Because `packages/corpus` is pure and cannot import the redactor, the check is a required option of the shared runner (`LiveOptions.unsafe`), and every caller passes it: the CLI, `scripts/docs-eval.ts` and, through it, the canary. A run in which every question was held back is unscored (exit 3 for the script, 1 for the CLI, never a pass), and the canary reports no recall for it.

### The CLI

`substrate corpus eval [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--max-queries N] [--server URL] [--json]` generates the golden set from the documents the local scan found (titles, headings and opening sentences, read from the working tree; a file that cannot be read is counted and named, never fatal) and prints how many questions it would ask. With `--server URL` it asks them of `POST /docs/search` with the CLI's token and prints the metrics. It is read-only on both sides and asks at most 500 questions (`--max-queries` lowers that, never raises it). The exit code is 0 when recall at 5 holds `SUBSTRATE_DOCS_SLO_RECALL5`, and 1 when it is breached or when any question failed, came back degraded or went unasked, so a timer can alert on it; a usage error is 2. Without `--server` it asks nothing and exits 0.

A scan that skipped a repository (a `git ls-files` that failed, a truncated tree, an unreadable directory) is a **partial** scan. The human output lists the skipped repositories, each with its source and reason (control characters in a reason are shown escaped), `--json` carries `partial: true` and `incomplete: { count, listed }`, and the one-line verdict is labelled `(partial: N repository(ies) not read completely)`, so a pass over part of the corpus cannot be read as a pass over all of it. A partial scan does not change the exit code: 0 when the objective holds, 1 when it is breached or the run could not be scored in full, exactly as for a complete scan.

A run in which any question went unanswered (failed, came back degraded, or was never asked) is **unscored**: the verdict line is `recall@5 not measured (N of M searches failed)` (or `were answered degraded`, or `no question could be generated`), never `holds the objective`, and `--json` carries `scored: false` and `verdict: "unscored"` (`"holds"` and `"breach"` are the other two). A recall under the objective among the answered questions still prints `FAIL` (the number is over the answered ones, as the counts line says). The exit code is 1 for an unscored run, as before.

Questions held back as credential-shaped (see [Live](#live)) are printed on their own line of the human output and carried as `skippedUnsafe` in `--json`; they are not in the denominator of `N of M searches`, and a run where all of them were held back reads `recall@5 not measured (every question looks like it contains a credential, so none was sent)`.

The scan drops byte-identical files across `local/*` collections before the questions are written, so the plane may cite a copy the questions never named. The CLI carries the scan's copy groups into the expected answers (`alsoExpected`): a hit on any copy of a kept document is a hit. The scan's report lists at most 200 groups and 20 copies each; copies it did not list are counted in a warning, because an answer that cites one of them is scored as a miss. Results that are not corpus documents (a memory recall hit, a page outside the corpus) keep their place in the ranking, so a document in sixth place is not counted at recall@5.

## The objectives

Freshness, ingest throughput, retrieval quality and sync lag are series in the metrics history, objectives in flags, and one row, `corpus`, in `fabric_status`. The sync lag is an objective only once its flag is set.

| Reading | Series | Instrument | Set by | Objective | Default |
| --- | --- | --- | --- | --- | --- |
| Age of the newest manifest change, in seconds | `corpus.freshness_seconds` | `substrate.corpus.freshness_seconds` | the manifest's last ingest time, read on each history sample, each `fabric_status`, each `GET /corpus/status` and after each ingest request | at most `SUBSTRATE_DOCS_SLO_FRESHNESS_S` | 86400 |
| Documents per second of the last ingest request | `corpus.ingest_docs_per_s` | `substrate.corpus.ingest_docs_per_second` | after each `POST /corpus/ingest`: documents the plane ingested (not metadata-only updates) over the request's wall time | at least `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` | 0.2 |
| Golden-set recall at 5 | `corpus.golden_recall5` | `substrate.corpus.golden_recall5` | a stored `docs.canary` event from the `substrate` surface carrying `payload.golden_recall5`; the action is reserved, so only the canary's own `substrate` token can write it (see [`event-vocabulary.md`](event-vocabulary.md)) | at least `SUBSTRATE_DOCS_SLO_RECALL5` | 0.6 |
| Lag the newest `docs.sync` note reported, in seconds | `corpus.sync_lag_seconds` | `substrate.corpus.sync_lag_seconds` | each stored `docs.sync` note that carries a `lag_s` (the sync CLI's note) | at most `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` when that is set; unset, shown with no verdict | unset |

The four series are in the `extended` tier of the history (`SUBSTRATE_METRICS_HISTORY_SERIES=extended`, see [`dashboards.md`](dashboards.md)); the first three have panels on the data-planes dashboard. The first three gauges are set only while `SUBSTRATE_CORPUS=on`. The sync lag is set by each stored `docs.sync` note, whatever `SUBSTRATE_CORPUS` says, and judged by the row only while it is on. All four are kept in memory and not restored after a restart: a freshly started server has no recall reading until the next canary report, no ingest reading until the next request and no sync lag until the next sync note, and freshness is read from the manifest at once. A reading nobody has taken is **not** a breach.

Things worth knowing before you set a threshold:

- **Freshness is the age of the newest ingested document**, not of the last sync. A corpus in which nothing changed for a day reads a day old. Raise `SUBSTRATE_DOCS_SLO_FRESHNESS_S` for a set of repositories that rarely change, or set `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` to judge how far behind its source the last sync ran. A corpus with no ingested document has no freshness.
- **An idle request is not a slow one, and a metadata refresh is not an upload.** The rate counts the documents the plane ingested (`counts.ingested`) over the request's wall time; rows refreshed in the manifest without a plane write (`updated`: the same bytes under another source, kind or tier) are not counted, so one slow upload cannot hide behind many cheap refreshes. A request that found everything unchanged, or only refreshed metadata, sets the gauge to 0 and is not judged: the `fabric_status` reading stays empty until a request that uploaded documents, and it is that request's rate that is compared with the objective.
- **A thin set of documents gives a coarse recall.** The objective means something once the golden set has a few dozen questions; the number asked is in every report.

### `fabric_status`

The `corpus` row is `unconfigured` while `SUBSTRATE_CORPUS` is off. Otherwise its `detail` carries `freshnessS`, `recall5`, `ingestDocsPerS` and `syncLag`, each as `{ reading, threshold }` (`reading` is `null` until measured; `threshold` is `null` for `syncLag` while `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` is unset, so the lag is shown with no verdict), and `breaches`. The row is `degraded` when a reading is past its threshold (`source: "corpus.slo: breached freshness,recall5,ingest,sync"`, naming the ones that are) or when the readings could not be read within the fabric's per-source deadline (`corpus.slo: timeout` or `failed`); otherwise it is `ok`. A degraded row also raises one `corpus-slo` suggestion from `fabric_optimize` and a failed `resource-state.corpus` check from `fabric_compliance`. The existing `docs.freshness` warning (a merge trigger with no recorded ingest) is a separate signal and keeps working.

The `source` of the row says which reading failed. The manifest read behind the freshness reading is one `max(ingested_at)` query, not the counts and groupings of `GET /corpus/status`, and refreshes that overlap (an ingest request, a fabric read, a history sample) share one read; a failed read is not handed to the next refresh. It has its own bound, 1 second, shorter than the fabric's 1.5 second deadline, so a read that is late is reported as `corpus.slo: timeout`, never taken as a fresh answer; a read that throws is `corpus.slo: failed`. In both cases the freshness series keeps its last good reading and is not refreshed, and the row stays `degraded` until a read succeeds.

### The docs canary

`scripts/docs-golden.ts --live --emit` (the staged daily canary, [`docs-search-ingest.md`](docs-search-ingest.md)) additionally asks up to 200 golden questions after its fixtures, **only when `SUBSTRATE_CORPUS` is `on` in the canary's environment**; with it off the canary runs its fixtures alone, sends no extra search and cannot exit 1 for the golden set. It prints `golden recall@5`, posts one `note` event (`docs.canary.report`: `payload.action: "docs.canary"`, `golden_recall5`, `golden_asked`) on every run that measured it, carries `golden_recall5` in the regression warning when it posts one, and exits 1 when the recall is under `SUBSTRATE_DOCS_SLO_RECALL5`. It does not measure, and says so on stderr, when the checkout has no `docs/` or any question failed or came back degraded.

The canary holds back credential-shaped questions the same way (`docs canary: N questions were not sent: …` on stderr); it still reports the recall of the others, with `golden_asked` counting the questions that were measured (answered and scored), never the ones that were generated and held back, and reports nothing when none could be sent.

A canary run over a **partial scan** reports nothing: when the walk of `docs/` was cut by its bounds (5000 files, 8 levels of directories), the recall is not reported as `golden_recall5`, and stderr says why (`the scan of docs/ was partial (file-limit|depth-limit)`). A recall over part of the documents would read as better than the corpus is.

## Flags

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_DOCS_SLO_FRESHNESS_S` | server | `86400` | Seconds the newest manifest change may be old. A whole number of 1 or more; anything else (unset, empty, zero, negative, not a number) is the default. |
| `SUBSTRATE_DOCS_SLO_RECALL5` | server, CLI, canary, script | `0.6` | The lowest golden-set recall at 5 that holds, above 0 up to 1; anything else is the default. |
| `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` | server | `0.2` | The lowest documents per second an ingest request that sent documents may average, above 0; anything else is the default. |
| `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | server | unset | Seconds the newest `docs.sync` note's lag may be, a whole number of 1 or more; unset is no verdict, and the row shows the lag only. |
| `SUBSTRATE_DOCS_EVAL_REPO` | script, canary | `swcstudiospace/agent-substrate` | The repository name this checkout's `docs/` is expected under in the corpus. |

An invalid value is the default rather than an error, so a typo can never switch an objective off.

The sync lag has no default, so an invalid value leaves it unset: no objective, and the row shows the lag with no verdict until a valid one is set.
