# Docs search and ingest (RAGFlow)

Agents answer docs questions from RAGFlow with citations, through the
substrate only. There is exactly one door: `substrate-mcp`
(`packages/mcp-server/src/planes/ragflow.ts`). No RAGFlow MCP server
appears in any agent config, and no package outside `mcp-server` imports
the client — `store-lock.test.ts` fails the build on either.

## Reference

| Surface | Call | Audit |
|---|---|---|
| MCP | `docs_search` `{question, datasets?, session_id?, context?}` | fail-open |
| MCP | `docs_ingest` `{dataset, commit?, pages[{path, source_url?, body, heading_path?}], session_id?}` | fail-closed |
| REST | `POST /docs/search` (same fields, `question` required) | fail-open |
| REST | `POST /docs/ingest` (bearer required; 401 anonymous, 403 guest) | fail-closed |
| REST | `POST /docs/merge-trigger[?wait=1]` `{dataset?, commit, content_sha256}` (bearer, loopback only; 202 accepted, `?wait=1` 200/503) | fail-closed, as `docs_ingest` |
| CLI | `substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]` | via the route |

`datasets` names configured datasets; unknown names are ignored and raw
ids are never accepted. `dataset` on ingest names one configured dataset.

## RAGFlow HTTP API shapes (uplift-2 R6)

The client (`planes/ragflow.ts`) speaks the shapes the RAGFlow HTTP API
reference documents (https://ragflow.io/docs/http_api_reference, read
2026-10-13), and the recording fake (`ragflow-fake.ts`) serves exactly
those and refuses the earlier rehearsal shapes. Every answer is read
twice: the HTTP status, and the business `code` in the body (`0` is
success; anything else is a failure even under HTTP 200).

| Operation | Call | Reference section |
|---|---|---|
| discover datasets | `GET /api/v1/datasets?page=1&page_size=100` → `data[{id, name}]`; held in process for 60 s, dropped by a create or a failed list | List datasets |
| create dataset | `POST /api/v1/datasets` `{name, embedding_model, chunk_method: "naive"}` → `data.id`; only on a name-miss (a taken name is suffixed by RAGFlow, never reused) | Create dataset |
| upload page | `POST /api/v1/datasets/{id}/documents` multipart form field `file` (one page per request; file name = repo path with `/` → `__`) → `data[0].id` | Upload documents |
| attach metadata | `PATCH /api/v1/datasets/{id}/documents/{doc}` `{meta_fields: {source_url, commit, heading_path}}`; a failed PATCH deletes the orphan and fails the page | Update document |
| parse | `POST /api/v1/datasets/{id}/chunks` `{document_ids}` | Parse documents |
| parse status | `GET /api/v1/datasets/{id}/documents?id={doc}` → `data.docs[0].run` (`DONE` ok; `FAIL`/`CANCEL` fail with `progress_msg`; else poll on; thirty polls two seconds apart, then `parse-timeout`) | List documents |
| delete | `DELETE /api/v1/datasets/{id}/documents` `{ids}`; the prune and the orphan clean-up are its only callers | Delete documents |
| retrieve | `POST /api/v1/retrieval` `{question, dataset_ids, page, page_size ≤ 10, similarity_threshold, vector_similarity_weight, top_k}` → `data.chunks[{content, document_id, document_keyword, id, similarity}]` | Retrieve chunks |

Retrieval knobs, defaults equal to RAGFlow's own so an unset knob changes
nothing: `SUBSTRATE_DOCS_SIMILARITY_THRESHOLD` (0.2),
`SUBSTRATE_DOCS_VECTOR_WEIGHT` (0.3; the documented legacy fallback of
`keywords_similarity_weight` 0.7), `SUBSTRATE_DOCS_TOP_K` (1024; the
reference marks `top_k` a deprecated alias of `knn_top_k`). Junk or
out-of-range values fall back.

**Live-unattested.** No call has been made against the deployment
(Phase 25 G1–G4 are operator-gated), so three things the reference raises
are recorded rather than resolved: the 1.0 Go backend renames
`chunk_method: "naive"` to `parser_id: "general"` on create; the
documented embedding-model format is `model_name@model_factory` and the
pinned `tei-bge-small` is bare; retrieval chunks document no metadata
echo, so a citation's `source_url` comes from the ingest record of its
document id (hence the state file) and `heading_path` is empty unless the
deployment echoes it.

## Citation shape

Each `docs_search` result carries `{title, source_url, heading_path,
commit, dataset_commit?, snippet, score, document_id, chunk_id}` where
every text field is redacted — `snippet` additionally capped at 1,200
characters — `source_url` is the chunk's own when it carries one, else
the ingest record's for that document id, else `dataset:<name>`, and
callers cite `source_url`, never the chunk. `commit` is resolved **per
document**, in this order: (1) the commit the ingest record holds for
that document id — the current document of a source URL, or one of its
replaced-but-unpruned predecessors (the record keeps the last five with
their own commits, so with the prune off a retrieval that returns an
older document cites that older commit, never the dataset's newest pin);
(2) a recorded document that was uploaded by a direct `docs_ingest`
without a `commit` → `dataset-pin:<name>:unpinned` (it does not borrow
the dataset pin, which it may predate or postdate); (3) a document the
records never uploaded (another writer, or records lost) →
`dataset-pin:<name>:unrecorded` — never the dataset pin either (Greptile
round 2), for the same reason. The dataset's newest recorded version from
the version store travels separately as `dataset_commit` on every
citation once one is recorded; it is the dataset's version, not
necessarily that document's.
The reply carries an untrusted-docs notice; one `note` event
(`payload.action: "docs.search"`) lists the returned URLs; a search that
served nothing yields `{chunks: [], degraded: true, reason}` — never a
throw inside an agent's turn. At most 10 results, each retrieved over
explicit `dataset_ids` with `page_size <= 10`.

### Fan-out under one budget (uplift-3 N5)

The datasets are retrieved **concurrently** — one retrieval per resolved
dataset, at most the configured three — under one shared deadline,
`SUBSTRATE_DOCS_SEARCH_BUDGET_MS` (default 4000; `0` keeps only the
plane client's own 4 s per-call timeout, which is the pre-N5 behaviour
and the rollback). A search therefore costs its slowest dataset, not the
sum, and a stalled dataset costs the budget. Failure is isolated per
dataset: a dataset that fails or outlives the deadline is listed in the
reply as `degraded_datasets: [{dataset, reason}]` — `reason` is the plane
client's bounded reason (`ragflow 503`, `ragflow circuit open`,
`deadline (4000 ms docs budget)`), redacted and capped at 200 characters
— while the other datasets' citations are returned, still score-sorted
and capped at 10. The reply is `degraded: true` only when **no** dataset
answered; then `reason` is the first failure and `degraded_datasets`
names them all. The single `note` event is unchanged apart from carrying
`degraded_datasets` when it is non-empty, so a partial answer is visible
in the ledger. A partially served reply is **never cached** (R6's rule
"a degraded reply is never stored", extended): the next caller retries
the missing dataset instead of inheriting a hole for a TTL.
One exception to "leave together": while the RAGFlow breaker is
**half-open** (it admits exactly one probe), the first resolved dataset is
retrieved alone as that probe and the rest leave once it has settled —
still under the one shared budget — so a recovery search does not see its
siblings refused as `ragflow circuit open` behind a probe that succeeded
(Greptile round 1, PR #61). A closed or open breaker changes nothing.

### Metrics (uplift-3 N5)

Every search is measured end to end around the answer cache, as the
caller waited for it: `substrate.docs.duration{surface, cached}`
(histogram, its own edges so 2,000 and 4,000 ms are exact),
`substrate.docs.search{surface, outcome=hit|empty|degraded, cached}`
(`hit`: at least one citation; `empty`: a real answer with none;
`degraded`: `degraded: true`) and
`substrate.docs.citations{provenance=recorded|unrecorded|unpinned}`, one
per returned citation, so `unrecorded / total` reads directly as the
share of answers the ingest records cannot vouch for. `GET /slo` carries
the `docs` row `docs.search.p95` (≤ 2,000 ms, `insufficient-data` below
20 searches; `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS`) beside the catalogue —
see `docs/observability.md`.

### Caches (uplift-2 R6)

Two reads are cached. The dataset list is held in process for 60 s after
a successful discovery (dropped by a create or a failed list), so one
search costs N retrievals, not `1 + N` plane calls, and ingest and refresh
share the same list. The answer itself is cached in Dragonfly under the
`docs-search` class (TTL 300 s): key = caller surface + normalised
question (trimmed, whitespace collapsed, lower-cased) + sorted dataset
names + the current pins + the degraded set, under the generation
`substrate:v1:gen:docs`, which every ingest that stored anything (a
successful one, or one that failed after an earlier page landed — the
outcome's `changed`) and every recorded version bumps — a refresh
invalidates every cached answer at once. The same condition persists the
ingest records, so a page pruned before a later page failed is never
named by the state file after a restart (Greptile round 2). A
degraded reply is never stored, nor (uplift-3 N5) a partially served one
with `degraded_datasets`; a cache hit makes no plane call and emits
no `note`.

## Hybrid retrieval and context augmentation

Every retrieval is a hybrid search: RAGFlow combines keyword and vector similarity, and `vector_similarity_weight` sets the vector share. The keyword share is its complement, and the two sum to 1. `docs_search` can also add a `context` block built from recalled memories and the caller's session ledger. The context is read-side only and is never stored.

### Vector weight

The weight sent as `vector_similarity_weight` resolves in `loadConfig` (`config.ts`). The first match wins:

1. `SUBSTRATE_DOCS_VECTOR_WEIGHT`, when set to a usable value.
2. `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT`, when set.
3. `0.3`, RAGFlow's own default.

`SUBSTRATE_DOCS_VECTOR_WEIGHT` keeps precedence because it predates this setting. A blank value counts as unset for both variables.

The two variables do not validate alike:

- `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT` must be a number in [0, 1]. Anything else makes `loadConfig` throw a `ConfigError` that names `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT`. The check runs even when `SUBSTRATE_DOCS_VECTOR_WEIGHT` is also set.
- `SUBSTRATE_DOCS_VECTOR_WEIGHT` is not a configuration error. A value that is not a number, or lies outside [0, 1], falls back to the RAGFlow weight (then 0.3).

### Reranker

`SUBSTRATE_RAGFLOW_RERANK_ID` names a reranker model. The value is trimmed. Unset or blank, the retrieval request carries no `rerank_id` field. When set, every `POST /api/v1/retrieval` carries `rerank_id` with that id. The reranker is opt-in: the code records that RAGFlow ships no reranker by default (D46-b), and the deployed RAGFlow version is not attested, so the substrate never turns one on by itself.

### The `context` block

`docs_search` takes an optional `context` boolean, default `false`. `POST /docs/search` takes the same field, and the MCP input schema declares it a boolean.

- Unset or `false`: the reply has no `context` key, and nothing is read from memory or the ledger.
- `true`: the reply gains `context`, computed for that call.

| Field | Content |
|---|---|
| `memories` | The first 3 recall hits for the question, in the order recall returns them, each `{id, text, scope, repo}`. `scope` and `repo` are `null` when the hit has none. `text` is redacted, then cut to 400 characters. |
| `events` | Up to 5 of the most recent ledger rows of the `session_id`, in time order, each `{id, ts, kind, surface, summary}`. `ts` is ISO-8601. `summary` is redacted, then cut to 200 characters. |
| `untrusted` | The notice the chunks carry (`UNTRUSTED_DOCS_NOTICE`). |
| `degraded` | Absent when every source answered. Otherwise the reasons, joined by `; `, redacted and capped at 300 characters. |

The reasons in `degraded` are:

- `no-session`: there is no `session_id`, or it is empty. `events` is `[]`, the ledger is not read, and the memories still come.
- `ledger-not-configured`: no ledger is configured. `events` is `[]`.
- `ledger: <reason>`: the ledger read failed or missed its budget. A miss reads `ledger: deadline exceeded`. `events` is `[]`.
- `recall: <reason>`: the recall failed, timed out, or answered degraded. The reason is the recall's own, for example `recall: recall-timeout: budget exceeded`, `recall: hindsight recall failed: …`, `recall: partial recall: …` or `recall: vm-guest`. A partial recall keeps the memories it returned.

### Budgets

| Read | Bound | Where it is set |
|---|---|---|
| Recall | `HINDSIGHT_SEARCH_RECALL_BUDGET_MS`, default 1500 ms | `hindsightBudgets.searchRecallBudgetMs` |
| Ledger read | 1000 ms, fixed | `DOCS_CONTEXT_LEDGER_BUDGET_MS` |

The recall does not run under `SUBSTRATE_DOCS_SEARCH_BUDGET_MS`. That budget is the shared deadline of the chunk retrieval fan-out only.

The ledger read has no row limit: `readEvents` returns every row of the session in time order, and the last five are kept. The 1000 ms budget is the only bound on that read.

The two reads run in parallel, and both start after the chunk answer is ready. A `context: true` reply therefore takes the chunk search time plus the slower of the two reads, which is at most 1500 ms with the default recall budget.

### Cache and ordering

The chunk answer is cached as before, and that store happens before any context leg starts, so the cache entry never carries `context`. Context does not change the datasets searched, the cache key or the chunks. A cache hit still reads the context for that call. An empty question skips the cache for the chunks, and its context is still read. A reply with `context` is never stored.

The `substrate.docs.duration` and `substrate.docs.search` measurements wrap the whole call, so they include the context legs.

### Untrusted context

Memory text and event summaries are untrusted evidence. Both are redacted before they are cut, so a cut never shows text the redactor removes. The context carries no source URL and is never cited as a source. Nothing in it is an instruction: a caller must not act on a directive found in a memory or an event.

### REST

`POST /docs/search` takes `context` with the same meaning. A `context` that is not a JSON boolean, `null` included, answers `400` with `{"error": "datasets must be a string array, session_id a string and context a boolean"}` before the search runs.

## The six ingest refusals

`docs_ingest` scans the body AND the outgoing metadata (`source_url`,
`commit`, `heading_path`) before upload and refuses loudly (fail-closed,
`warning` event `docs.ingest.refused` carrying rule names, reasons and
hashes only — never values) on: a redactor finding (refuse, never
clean-and-publish); a page with no source URL; a path outside the
configured roots (`docs/`, `README.md`, `.planning/PROJECT.md`, or
`SUBSTRATE_DOCS_INGEST_ROOTS`) — both the posted `path` and the
client-resolved `real_path` must sit under the roots after dot-segment
normalization, so `docs/../` escapes and symlink escapes are refused; a
page over 1 MB or a call over 5 MB total (the route reads up to 6 MB and
answers 413 past that); an unauthenticated caller; a VM guest
(`SUBSTRATE_VM_GUEST=1`).
Remote images (`http(s)` img tags and markdown image syntax) are stripped
before upload and counted in the `note` event. Uploads are idempotent by
content hash, keyed by dataset plus source URL (unchanged skips, changed
replaces), with per-page in-flight locks so concurrent retries share one
upload, and always carry `{source_url, commit, heading_path}` metadata
(`meta_fields`). A replacement reports the superseded document id; with
`SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1` (default off — nothing is deleted
unless the operator turns it on) the superseded document is deleted
through the documented delete call once the replacement has parsed, the
result carries `pruned_document_id` and the `note` payload
`pruned_document_ids`; a failed delete is non-fatal, logged on stderr and
recorded on the result as `prune: "failed: <reason>"`, with no new event.
Records persist across restarts in `SUBSTRATE_DOCS_STATE_FILE` (the unit
sets `/var/lib/substrate/docs-ingest.json`): a version-2 JSON file
holding the ingest records (hashes and document ids only) and the
per-dataset version lists; a version-1 file (records only) loads and is
rewritten at version 2 on the next save. Without the variable both stay
process-local. Parse budget is thirty polls two seconds apart.

## Datasets

| Dataset | Source | Refresh trigger |
|---|---|---|
| `agent-substrate` | `README.md`, `docs/`, `.planning/PROJECT.md` of this repo | merge to `main` |
| `programming-desk` | `docs/`, `skills/`, `contracts/`, `ARCHITECTURE.md`, `prompts-assembled/` of `swcstudiospace/programming-desk` | merge of that repo |
| `agent-skills` | every `SKILL.md` and `references/` in `swcstudiospace/agent-skills` | `substrate-skills-sync` after a fast-forward |
| `<product>` (`kanbanos`, `desklanes`, `clippyos`, `auctioning`) | that repo's docs | merge of that repo |

Embedding: TEI `bge-small`; no chat model is registered; retrieval only.
Discovery is by name and creation happens only on a name-miss. Each
refresh records `{dataset, version, commit, content_sha256, ingested_at}`
and keeps the last five versions per dataset — a bookkeeping list in the
state file (the pins search cites, the merge-trigger's idempotency key),
not a retention policy on the plane: documents are retired only by the
opt-in prune above.

### The merge trigger (uplift-2 R6: asynchronous)

`POST /docs/merge-trigger` `{dataset?, commit, content_sha256}` is the
documented refresh for the dataset this checkout holds (`agent-substrate`
by default). After the same doors as before — 401 untokened, 403 off
loopback or a VM guest, 400 unknown dataset or missing hash, the
`docs_ingest` audit record, a quiet 200 noop on an unconfigured plane or
a dataset with no local checkout, and a 200 `idempotent: true` when the
newest recorded version already carries the commit and hash — it answers
**202** `{accepted: true, job, dataset, commit}` at once and runs the
refresh in the background: ensure the dataset (discover, create on miss),
the guarded ingest of the configured roots, then record the version, in
that order, so a refused ingest records nothing. One job per dataset runs
at a time; a trigger for a dataset whose job is still running or queued
with the same commit and hash answers that job's id with `queued: true`;
a different identity is queued behind it under a new id. Every outcome
lands on stderr (`docs merge-trigger <job> <dataset> <commit>: v3
recorded` / `failed — <reason>`); a success lands in the version store
and the ingest records, both persisted. `?wait=1` keeps the synchronous
answer for operators and tests: 200 with the version (and `job`), 503
with the reason. The skills-sync tick (`packages/projector/src/skills-sync.ts`)
treats any 2xx as delivered, so its 3 s budget now holds.

The `agent-skills` refresh reads a local checkout when `SUBSTRATE_AGENT_SKILLS_ROOT` names one: an
absolute path (a relative value is refused with a boot warning and treated as unset). Each directory
`<name>/` at the checkout root contributes its `<name>/SKILL.md` and its `<name>/references/` tree,
when it has them, read with the scanner and size caps the `agent-substrate` checkout uses. Dot-directories
and links are skipped. Only those roots pass the ingest guard for that dataset; `agent-substrate` keeps
`SUBSTRATE_DOCS_INGEST_ROOTS`. Unset, the trigger is the noop above and records no version. A checkout
that cannot be read fails the job with `checkout-unreadable` (503 under `?wait=1`) and records no version;
the pinned version keeps serving, with `pin_age_ms` on its citations, until a refresh succeeds (D42-5).

### Freshness and trigger lag (uplift-4 S7)

Two signals, both computed in-process from the persisted state file
(`SUBSTRATE_DOCS_STATE_FILE`): no RAGFlow call and no new key. The lag warning
is settled by one unref'd timer (`SUBSTRATE_DOCS_LAG_CHECK_S`, below).

- **Freshness**: `substrate.docs.freshness_seconds{dataset}` is the time since
  the newest `versions[].ingested_at` of the dataset (clamped at 0). Report-only
  threshold `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H` (default `168`; `0` reports the
  age without judging it).
- **Trigger lag**: every merge-trigger that starts a job (a new identity, not a
  200 idempotent or a noop) is recorded in the state file's optional `triggers`
  member, last 20 per dataset: `{commit, content_sha256, received_at}`. A
  retry of the same commit and hash keeps its first `received_at`. A dataset is
  `lagging` when its newest accepted trigger has no recorded version for that
  commit after `SUBSTRATE_DOCS_TRIGGER_LAG_MIN` minutes (default `15`; `0`
  stops recording triggers and detecting lag). The gauge is
  `substrate.docs.trigger_lag_seconds{dataset}` (0 once it landed).

Where they show: `GET /metrics` gains a `gauges` member (only once a dataset
has data). These two labelled gauges are served **only** there: the registry's
own unlabelled gauges (such as `substrate.index.archive.age_seconds`) are in
`metrics[]` and in OTLP, but the OTLP exporter does not carry the docs gauges,
so they are read from `/metrics`. `GET /slo` gains a `docs.freshness` row in the
`docs` array beside `docs.search.p95`, with per-dataset detail. The row appears
only when a dataset has a recorded version or an accepted trigger, and like
the rest of `docs` it is never folded into `breached`. The `dataset` label is
always a name of the trigger table.

The lag also raises one `warning` event (`substrate` surface,
`payload.action: "docs.freshness"`, `state: "lagging"`) per dataset per breach:
the marker is written to the state file's `lag` member before the event is
emitted and marked `warned` only after the ledger accepted it; while the breach
lasts nothing more is emitted; when it clears, one `note`
(`state: "recovered"`) is emitted and the marker removed. Delivery is a single
background pass started by a timer (`SUBSTRATE_DOCS_LAG_CHECK_S`, default `60`,
floor `15`, ceiling `3600`), so a breach is announced even when nobody reads
`/slo`, and `GET /slo` and `GET /metrics` only read the verdicts: they never emit
or write a state file, and answer from the in-memory state without waiting on
the state-file hydrate (the first read after a boot can show no datasets until
the timer's first pass, which runs at start, has loaded it). Each emit has a 5 s
deadline that counts as a failure; a failed delivery is retried no sooner than
60 s later; and a failing emit or save is logged and never fails a trigger or a
read. With `SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0` and no marker left behind a pass
finds nothing owed and does nothing. The timer is stopped at shutdown, and the
pass in flight is awaited inside the same two-second bound as the other flushes.

The dedupe is best effort, not exactly-once. With `SUBSTRATE_DOCS_STATE_FILE`
unset the markers live in the process and a restart can warn again; a failed
state write is logged and swallowed, so a lost write can do the same; a crash
between the emit and the second write, or an emit that finished after its
deadline, can repeat one warning. A warning is never silently lost.

What this does **not** prove. The offline golden harness proves the pipeline,
not relevance. Freshness proves the corpus was refreshed recently, not that it
is at the repository HEAD: HEAD is known only to the post-merge hook, so a hook
that never fired leaves no trigger and no lag. The lag signal catches the
other failure, a trigger the server accepted that never became an ingest (a
refused ingest, a plane outage, a crash); a trigger counts as landed only when
a recorded version carries both its commit and its content hash. A state file
without the new members loads exactly as before, and a run that never accepted
a trigger writes none. The row reads `insufficient-data` until a dataset has a
recorded ingest and `unconfigured` when both thresholds are 0.

Rollback. Setting `SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0` in the substrate-mcp
environment and restarting it (an operator step; nothing in the repo changes the
host) stops recording and judging triggers; members already in the file are
ignored and a marker left behind clears with one `note`. Freshness itself has
no off switch: with `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H=0` too the age is only
reported, but the `docs.freshness` row (`unconfigured`) and the `/metrics`
gauges still appear for any dataset with a recorded version. Removing them
means reverting the code.

### Skills-sync degradation

The Phase 22 sync unit is not yet live, so no fast-forward evidence
exists. Until the first real fast-forward, the `agent-skills` refresh
emits one `warning` (`payload.action: "docs.ingest"`, reason
`skills-sync-not-live`) and search serves `agent-skills` from its last
pinned version with `pin_age_ms` on those citations. No silent staleness:
the pin age travels in the reply. The evidence reaches the server as the
sync tick's merge-trigger for `agent-skills` (uplift-2 R6: the trigger
flips the tracker, even where it is a no-checkout noop), so from the
first delivered trigger on, `agent-skills` citations stop carrying
`pin_age_ms` for that process. No new timer, no new surface; when the
operator flips the sync unit live, no code change is needed.

## Credentials

`RAGFLOW_URL` / `RAGFLOW_API_KEY` live only in the server env file
(`/etc/substrate/substrate.env`); `substrate-mcp` reads them starting
this phase. `RAGFLOW_MCP_URL` names the MCP transport this plane
deliberately does not use and is never read here. No command in this doc
prints a credential value.

## Rehearsal

Every behavior above is proven against the recording fake
(`packages/mcp-server/src/ragflow-fake.ts`): the documented request and
response shapes (multipart upload, `meta_fields`, parse, list-by-id
status, delete, the three retrieval knobs, `chunk_method` on create),
explicit-`dataset_ids`, `<= 10` results, citation shape, redacted
snippets, untrusted framing, URL-listing event, empty-plus-reason
errors, all six refusals, image stripping, hash idempotency,
resolve-by-name, create-on-miss with the pinned model, both degradation
arms, the v1 → v2 state file, pins surviving a restart, both caches and
their invalidation, the prune on and off, and the 202 contract. The fake
fails any retrieval missing `dataset_ids`, a JSON upload body and the
pre-R6 poll route. Live proof (first probe, discovery/creation, real
ingest, real served search) is operator-gated — see
`docs/runbooks/docs-proof.md`.

Since uplift-3 N5 the fake also serves a question-aware answer per dataset
(`answer`) and records how many retrievals overlapped (`maxInFlight`),
which is how the fan-out, the budget and the per-dataset isolation are
proven (`docs-search.test.ts`).

## Golden questions (uplift-3 N5)

`scripts/docs-golden.ts` scores a docs search against
`fixtures/docs-golden/*.json` — per question: the datasets, the expected
source URLs (and commits), graded relevance, and the thresholds the
fixture must meet. Scores: precision@k, recall of the expected URLs, NDCG
from the grades over the distinct cited URLs, citation provenance
coverage (share of citations whose commit is a recorded one), commit
match, and a redaction check (no citation field changes under the
redactor; no `forbidden` string appears). Two tiers share the scorer:

- **Offline** (`bun run docs:golden`, and `scripts/docs-golden.test.ts` in
  CI): the real `searchDocs` over a `RagflowFake` that retrieves by
  lexical overlap from the sanitized corpus in
  `fixtures/docs-golden/corpus/` (`packages/mcp-server/src/docs-golden.ts`,
  inside the package because the store lock lets nothing outside import
  the fake). It proves scope isolation, provenance, ordering, the cap,
  redaction of a planted placeholder and the scorer — not relevance;
  every committed fixture must pass its thresholds.
- **Live** (`SUBSTRATE_URL=… SUBSTRATE_TOKEN=… bun run docs:golden -- --live`,
  opt-in): `POST /docs/search` only; scores are printed, never asserted.
  It refuses (exit 3) when a fixture's `corpus_manifest.sha256` is not the
  corpus on disk (`--manifest` prints it), when a fixture carries no
  operator-attested `corpus_manifest.dataset_commit`, or when a live
  citation's `dataset_commit` is not that pin — so a score is only ever
  read against the corpus it was written for. Without the two variables
  it exits 2 with a usage line and opens no socket.

See `fixtures/docs-golden/README.md` for the fixture shape.

### Live canary (uplift-4 S7, opt-in)

`bun scripts/docs-golden.ts --live --emit` is the canary a daily staged timer
runs (`infra/vps/substrate-docs-canary.{service,timer}`; shipped, **not**
installed by any code). Unlike plain `--live` it asserts: every fixture goes
through the loopback `POST /docs/search` as `omp` (bearer from
`SUBSTRATE_TOKEN_OMP`, first entry of a list, else the tokens dir, else
`SUBSTRATE_TOKEN`), is scored with the offline tier's scorer (expected sources,
commit pins, redaction) and must also cite only the attested
`dataset_commit`. A table is printed and the exit status is 0 (all pass),
1 (a regression), 2 (refused: not configured), 3 (could not run: stale
fixtures or manifest, search refused or unreachable, or a degraded answer —
an outage is the SLO's to report, not a regression; nothing is posted) or 4
(all pass but the dedupe record could not be cleared).

It refuses by name, exit 2 with no socket opened, unless both
`SUBSTRATE_DOCS_CANARY=1` and `SUBSTRATE_DOCS_CANARY_MANIFEST` are set, and
when `SUBSTRATE_URL` (default loopback) is not a loopback address. The manifest
is a JSON file `{"sha256": "<bun scripts/docs-golden.ts --manifest>",
"dataset_commit": "<commit the corpus was ingested under>"}` that the
operator writes after ingesting `fixtures/docs-golden/corpus/`; its `sha256`
must equal the corpus on disk. On a regression it posts one `warning` as
`substrate` (`payload.action: "docs.canary"`, fixture ids and metric names
only) when the failing set differs from the one recorded in
`SUBSTRATE_DOCS_CANARY_STATE` (default `/var/lib/substrate/docs-canary-last.json`);
a failed post keeps the old record, so the next run posts again. The record is
written through a temp file and a rename. It is
read-only against RAGFlow and uses no key of its own.

Seeding the corpus and its pins (do this BEFORE enabling the canary). Search
adds `dataset_commit` to a citation only from a dataset's recorded version
(the `versions` list of `SUBSTRATE_DOCS_STATE_FILE`); `docs ingest` stores
documents and ingest records but records no version. The only route that
records a version is a merge-trigger job (`recordDocsVersion` in the refresh),
and the route runs one only for `agent-substrate`, from the checkout's configured
roots, and for `agent-skills` once `SUBSTRATE_AGENT_SKILLS_ROOT` names a checkout;
for every other dataset the trigger is a noop. The fixtures use `agent-substrate`,
`programming-desk` and `agent-skills`, so the `programming-desk` pin cannot come from
an HTTP route and is written by the operator.
Pick one commit value `COMMIT` (a release SHA is fine) and use it everywhere:

1. Make the pages ingestible: set `SUBSTRATE_DOCS_INGEST_ROOTS` on substrate-mcp
   to include `fixtures/docs-golden/corpus/` (repo-relative roots) and restart
   it; the datasets must already exist on the plane (`docs ingest` refuses
   `unknown-dataset`; the merge-trigger creates `agent-substrate` on a miss).
2. For every file under `fixtures/docs-golden/corpus/<dataset>/<slug>.md`, from
   the checkout: `substrate docs ingest --dataset <dataset> --path
   fixtures/docs-golden/corpus/<dataset>/<slug>.md --source-url
   https://example.com/<dataset>/<slug> --commit COMMIT`. Each call prints
   `key=value` lines (`status=ingested`, or `unchanged`/`replaced`); any other
   status is a refusal to fix first. The source URLs and `COMMIT` must be exactly
   those, since the fixtures expect them.
3. Record one version per dataset. Stop substrate-mcp (it reads the state file
   once at start and rewrites it on every save), and in the state file's
   `versions` member add, per dataset name, a one-element list
   `{"dataset": "<name>", "dataset_id": "<the plane's id for it>", "version":
   "v1", "commit": "COMMIT", "content_sha256": "<sha256 of the corpus
   manifest or any non-empty hash>", "ingested_at": "<ISO time>"}`, keeping
   the existing members; then start substrate-mcp. (For `agent-substrate`
   alone a `POST /docs/merge-trigger?wait=1` with `commit` = `COMMIT` records
   the version itself, but it ingests the checkout's roots.)
4. Verify before enabling: `POST /docs/search` as `omp` with a fixture's
   question and its `datasets`, and check that every chunk carries
   `dataset_commit` equal to `COMMIT` and the expected `source_url`. A chunk
   without `dataset_commit` means that dataset still has no pin.
5. Write the manifest `{"sha256": "<bun scripts/docs-golden.ts --manifest>",
   "dataset_commit": "COMMIT"}`; uncomment `SUBSTRATE_DOCS_CANARY=1` and set
   `SUBSTRATE_DOCS_CANARY_MANIFEST` on the drop-in; run the unit once
   (`systemctl start substrate-docs-canary.service`), read the journal, then
   `systemctl enable --now substrate-docs-canary.timer`.

The canary scores commit expectations against the attested `COMMIT` (the
committed fixtures keep stating `golden-v1` for the offline tier). A missing or
unreadable manifest, or a citation without `dataset_commit` (no pin), is a
named setup failure: exit 3, a line on stderr, nothing posted. Rollback:
`systemctl disable --now substrate-docs-canary.timer`, remove the two lines
(the job then exits 2 by itself) and delete the unit files.
