# Corpus evaluation and objectives (v1.7 phase 70)

The docs plane is only as good as the answers it gives. This page explains how that is measured without any labels, how the measure is guarded in CI, and which three readings the server judges against objectives you can set. The operator's path through all of it is [`runbooks/docs-rag-operations.md`](runbooks/docs-rag-operations.md); the corpus itself is [`corpus.md`](corpus.md) and [`runbooks/corpus-ingest.md`](runbooks/corpus-ingest.md).

## The golden set

A golden set is a list of questions with the document each should find. This one is generated from the documents themselves, so it grows with the corpus and needs no one to write it (`generateGolden` in `packages/corpus/src/eval.ts`). For each Markdown document it derives up to three questions, in this order:

1. the level-1 title;
2. each level-2 heading joined with the title (`Title Heading`);
3. the first sentence of the first paragraph, cut to 12 words.

The expected answer is the document's key, `repo:path`. Headings and paragraphs inside code fences and a YAML front matter block are ignored, and link text, code spans and emphasis are reduced to the words a reader sees.

A question is **dropped, never guessed**, when it cannot name one document:

- it is shorter than 3 words;
- it is a phrase that occurs in more than one document's title (the same title in two repositories, or a title that is a phrase of a longer one);
- the same phrase is asked by two documents (a copy, or an archive under `milestones/`).

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
| `bun scripts/docs-eval.ts` (and `scripts/docs-eval.test.ts` inside `bun test`) | an offline, deterministic lexical retriever over `packages/corpus/fixtures/eval/` | the pipeline logic: ranking inputs, de-duplication, re-rank | every CI run, no network |
| `bun scripts/docs-eval.ts --live URL`, and the docs canary | the server's `POST /docs/search` over this checkout's `docs/` | the live corpus: is each document findable | by hand, and daily from the staged canary timer |
| `substrate corpus eval --server URL` | the same route, over the documents the local scan found | the same, for any set of roots | by hand or from a timer |

### The offline harness (CI)

CI cannot reach a live docs plane, so a lexical retriever stands in. It does not say how good embeddings are. It guards the logic around them: what reaches ranking (tokenising, the title counted three times in all), the collapse of exact duplicates to one result under the lexically smallest key, and the re-rank step (`rerank?: (hits) => hits`, where the authority scores plug in). The fixture corpus is about thirty invented documents in three repositories with an archive copy of a live page, a near-duplicate, and one title in two repositories.

`bun scripts/docs-eval.ts` prints the metrics and compares them with `scripts/docs-eval.baseline.json`:

- a fall of more than **0.02** in recall at 5, or **0.03** in MRR, fails (exit 1);
- fewer questions than the baseline asked fails too, so a generator that loses questions cannot read as a pass;
- a group of exact-duplicate documents that the retriever does not answer as its smallest key fails (a de-duplication regression moves no score, because a copied page asks no question, so each group is probed directly);
- an improvement passes and prints a hint to record it.

`bun scripts/docs-eval.ts --json` prints one object. `scripts/docs-eval.test.ts` runs the same thing inside `bun test`, so the CI workflow gains no step (see [`ci.md`](ci.md)); it also proves the failure path against a doctored baseline and a deliberately broken re-rank.

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

### The CLI

`substrate corpus eval [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--max-queries N] [--server URL] [--json]` generates the golden set from the documents the local scan found (titles, headings and opening sentences, read from the working tree; a file that cannot be read is counted and named, never fatal) and prints how many questions it would ask. With `--server URL` it asks them of `POST /docs/search` with the CLI's token and prints the metrics. It is read-only on both sides and asks at most 500 questions (`--max-queries` lowers that, never raises it). The exit code is 0 when recall at 5 holds `SUBSTRATE_DOCS_SLO_RECALL5`, and 1 when it is breached or when any question failed, came back degraded or went unasked, so a timer can alert on it; a usage error is 2. Without `--server` it asks nothing and exits 0.

## The three objectives

Freshness, ingest throughput and retrieval quality are series in the metrics history, objectives in flags, and one row, `corpus`, in `fabric_status`.

| Reading | Series | Instrument | Set by | Objective | Default |
| --- | --- | --- | --- | --- | --- |
| Age of the newest manifest change, in seconds | `corpus.freshness_seconds` | `substrate.corpus.freshness_seconds` | the manifest's last ingest time, read on each history sample, each `fabric_status`, each `GET /corpus/status` and after each ingest request | at most `SUBSTRATE_DOCS_SLO_FRESHNESS_S` | 86400 |
| Documents per second of the last ingest request | `corpus.ingest_docs_per_s` | `substrate.corpus.ingest_docs_per_second` | after each `POST /corpus/ingest`: documents ingested or updated over the request's wall time | at least `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` | 0.2 |
| Golden-set recall at 5 | `corpus.golden_recall5` | `substrate.corpus.golden_recall5` | a stored `docs.canary` event from the `substrate` surface carrying `payload.golden_recall5` | at least `SUBSTRATE_DOCS_SLO_RECALL5` | 0.6 |

The three series are in the `extended` tier of the history (`SUBSTRATE_METRICS_HISTORY_SERIES=extended`, see [`dashboards.md`](dashboards.md)), with panels on the data-planes dashboard. All three are gauges, set only while `SUBSTRATE_CORPUS=on`, kept in memory and not restored after a restart: a freshly started server has no recall reading until the next canary report and no ingest reading until the next request, and freshness is read from the manifest at once. A reading nobody has taken is **not** a breach.

Things worth knowing before you set a threshold:

- **Freshness is the age of the newest ingested document**, not of the last sync. A corpus in which nothing changed for a day reads a day old. Raise `SUBSTRATE_DOCS_SLO_FRESHNESS_S` for a set of repositories that rarely change, or read the sync lag metric of the phase 65 sync units instead. A corpus with no ingested document has no freshness.
- **An idle request is not a slow one.** A request that found every document unchanged sets the gauge to 0 and is not judged: the `fabric_status` reading stays empty until a request that sent documents, and it is that request's rate that is compared with the objective.
- **A thin set of documents gives a coarse recall.** The objective means something once the golden set has a few dozen questions; the number asked is in every report.

### `fabric_status`

The `corpus` row is `unconfigured` while `SUBSTRATE_CORPUS` is off. Otherwise its `detail` carries `freshnessS`, `recall5` and `ingestDocsPerS`, each as `{ reading, threshold }` (`reading` is `null` until measured), and `breaches`. The row is `degraded` when a reading is past its threshold (`source: "corpus.slo: breached freshness,recall5,ingest"`, naming the ones that are) or when the readings could not be read within the fabric's per-source deadline (`corpus.slo: timeout` or `failed`); otherwise it is `ok`. A degraded row also raises one `corpus-slo` suggestion from `fabric_optimize` and a failed `resource-state.corpus` check from `fabric_compliance`. The existing `docs.freshness` warning (a merge trigger with no recorded ingest) is a separate signal and keeps working.

### The docs canary

`scripts/docs-golden.ts --live --emit` (the staged daily canary, [`docs-search-ingest.md`](docs-search-ingest.md)) additionally asks up to 200 golden questions after its fixtures. It prints `golden recall@5`, posts one `note` event (`docs.canary.report`: `payload.action: "docs.canary"`, `golden_recall5`, `golden_asked`) on every run that measured it, carries `golden_recall5` in the regression warning when it posts one, and exits 1 when the recall is under `SUBSTRATE_DOCS_SLO_RECALL5`. It does not measure, and says so on stderr, when the checkout has no `docs/` or any question failed or came back degraded.

## Flags

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_DOCS_SLO_FRESHNESS_S` | server | `86400` | Seconds the newest manifest change may be old. A whole number of 1 or more; anything else (unset, empty, zero, negative, not a number) is the default. |
| `SUBSTRATE_DOCS_SLO_RECALL5` | server, CLI, canary, script | `0.6` | The lowest golden-set recall at 5 that holds, above 0 up to 1; anything else is the default. |
| `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` | server | `0.2` | The lowest documents per second an ingest request that sent documents may average, above 0; anything else is the default. |
| `SUBSTRATE_DOCS_EVAL_REPO` | script, canary | `swcstudiospace/agent-substrate` | The repository name this checkout's `docs/` is expected under in the corpus. |

An invalid value is the default rather than an error, so a typo can never switch an objective off.
