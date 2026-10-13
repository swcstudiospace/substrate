# Docs search and ingest (RAGFlow)

Agents answer docs questions from RAGFlow with citations, through the
substrate only. There is exactly one door: `substrate-mcp`
(`packages/mcp-server/src/planes/ragflow.ts`). No RAGFlow MCP server
appears in any agent config, and no package outside `mcp-server` imports
the client — `store-lock.test.ts` fails the build on either.

## Reference

| Surface | Call | Audit |
|---|---|---|
| MCP | `docs_search` `{question, datasets?, session_id?}` | fail-open |
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
commit, snippet, score, document_id, chunk_id}` where every text field is
redacted — `snippet` additionally capped at 1,200 characters —
`source_url` is the chunk's own when it carries one, else the ingest
record's for that document id, else `dataset:<name>`, and callers cite
`source_url`, never the chunk. `commit` is resolved **per document**, in
this order: (1) the commit the ingest record holds for that document id
— the current document of a source URL, or one of its replaced-but-
unpruned predecessors (the record keeps the last five with their own
commits, so with the prune off a retrieval that returns an older
document cites that older commit, never the dataset's newest pin);
(2) a recorded document that was uploaded by a direct `docs_ingest`
without a `commit` → `dataset-pin:<name>:unpinned` (it does not borrow
the dataset pin, which it may predate or postdate); (3) a document the
records never uploaded (another writer, or records lost) → the dataset's
newest pin from the version store; (4) neither → `dataset-pin:<name>:unpinned`.
The reply carries an untrusted-docs notice; one `note` event
(`payload.action: "docs.search"`) lists the returned URLs; any error
yields `{chunks: [], degraded: true, reason}` — never a throw inside an
agent's turn. At most 10 results, each retrieved over explicit
`dataset_ids` with `page_size <= 10`.

### Caches (uplift-2 R6)

Two reads are cached. The dataset list is held in process for 60 s after
a successful discovery (dropped by a create or a failed list), so one
search costs N retrievals, not `1 + N` plane calls, and ingest and refresh
share the same list. The answer itself is cached in Dragonfly under the
`docs-search` class (TTL 300 s): key = caller surface + normalised
question (trimmed, whitespace collapsed, lower-cased) + sorted dataset
names + the current pins + the degraded set, under the generation
`substrate:v1:gen:docs`, which every successful ingest and every recorded
version bumps — a refresh invalidates every cached answer at once. A
degraded reply is never stored; a cache hit makes no plane call and emits
no `note`.

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
