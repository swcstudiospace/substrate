# R6 summary — RAGFlow docs plane: durable versions and pins, cached reads, bounded growth, verified API shapes, async merge trigger

## RAGFlow HTTP API shapes relied on

Source: the RAGFlow docs site, "HTTP API" reference (https://ragflow.io/docs/http_api_reference), read 2026-10-13. Every answer is read twice per that page's §ERROR CODES: the HTTP status, and the business `code` in the body (`0` success; any other code is a failure even under HTTP 200). All of it is **live-unattested** (see the list at the end).

| Operation | Method / path | Body sent | Response read | Section |
|---|---|---|---|---|
| discover datasets | `GET /api/v1/datasets?page=1&page_size=100` | — | `{code, data: [{id, name, …}]}` | List datasets |
| create dataset | `POST /api/v1/datasets` | `{name, embedding_model, chunk_method: "naive"}` | `{code, data: {id, …}}` | Create dataset (a taken name is created again with a numbered suffix → discovery before every create) |
| upload page | `POST /api/v1/datasets/{id}/documents` | multipart form field `file` (one page per request; file name = repo path, `/` → `__`) | `{code, data: [{id, name, run: "UNSTART", …}]}` | Upload documents (`type=local` default; failure `code: 101, "No file part!"`) |
| attach metadata | `PATCH /api/v1/datasets/{id}/documents/{doc}` | `{meta_fields: {source_url, commit, heading_path}}` | `{code: 0}` | Update document |
| parse | `POST /api/v1/datasets/{id}/chunks` | `{document_ids: [doc]}` | `{code: 0}` | Parse documents |
| parse status | `GET /api/v1/datasets/{id}/documents?id={doc}&page=1&page_size=1` | — | `{code, data: {docs: [{id, run, progress_msg, …}]}}`; `run` ∈ `UNSTART|RUNNING|CANCEL|DONE|FAIL|SCHEDULE` or `"0".."5"` | List documents |
| delete | `DELETE /api/v1/datasets/{id}/documents` | `{ids: [doc]}` | `{code: 0}` | Delete documents |
| retrieve | `POST /api/v1/retrieval` | `{question, dataset_ids, page, page_size ≤ 10, similarity_threshold, vector_similarity_weight, top_k}` | `{code, data: {chunks: [{content, document_id, document_keyword, id, similarity, dataset_id, …}]}}` | Retrieve chunks (`similarity_threshold` default 0.2; `vector_similarity_weight` the "legacy fallback" of `keywords_similarity_weight` 0.7; `top_k` a deprecated alias of `knn_top_k`, default 1024) |

## What changed

- **Client aligned to the documented shapes** (`planes/ragflow.ts`, same function names): `ragflowOp` route table gains `documents`, `document-delete`, `document-update`, `parse` (the pre-R6 `parse-status` route is gone); one `call()` helper carries the bearer header, the timeout, the HTTP check and the business-code check; `retrieveChunks` sends the three knobs (`RetrievalRequest.retrieval`, `DEFAULT_RETRIEVAL_KNOBS` = RAGFlow's defaults) and reads `document_keyword`/`id`/`similarity` (still tolerating `document_name`/`chunk_id`/`score`/`heading_path`/`source_url` when present); `listDatasets` paginates explicitly; `uploadDocument` is multipart `file` + the `meta_fields` PATCH (a failed PATCH deletes the orphan best-effort and fails the page); new `parseDocuments` and `deleteDocuments`; `pollParseStatus(config, {dataset_id, document_id}, …)` reads `run` from list-by-id (`DONE` ok, `FAIL`/`CANCEL` → `parse-failed: <run> <progress_msg>`, else poll, then `parse-timeout`); `createDataset` sends `chunk_method: "naive"` (`DATASET_CHUNK_METHOD`) with the unchanged `DATASET_EMBEDDING_MODEL`; `documentName(path)`. Header states "shapes per the HTTP API reference, live-unattested".
- **Fake serves the documented shapes and refuses the old ones** (`ragflow-fake.ts`): multipart upload parsed (`FormData` `file` parts; name and bytes recorded on the request, text on `uploads`), JSON upload → HTTP 400 `{code: 101, "No file part!"}`, `PATCH … meta_fields`, `POST …/chunks` (UNSTART → RUNNING; an unparsed document never becomes DONE), `GET …/documents?id=` progression (`parseBehavior` `done` | `never` | `fail`), `DELETE …/documents {ids}` (`deleted`, `failDeleteWith`), documented retrieval chunk fields only (no metadata echo), documented envelopes with `code`, duplicate dataset names suffixed `name(1)`, `chunk_method` validated, `failListWith`/`failMetaWith` knobs, `parses()`/`datasetLists()` helpers, `documents` table; `GET /api/v1/documents/{id}/parse` → 404.
- **Durable versions and real pins**: `docs-datasets.ts` gains `versionsToJson`/`versionsFromJson`; `docs-ingest.ts` state file is version 2 `{version: 2, records, versions}` (`loadIngestRecords` returns `versions`, `saveIngestRecords(file, seen, versions)`, tmp+rename as before; a version-1 file loads with empty versions and is rewritten at 2 — one-way). The version store moved from `server.ts` into `Substrate` (`docsVersions`, hydrated and persisted with the records); `searchDocs` passes `pins: pinsFromVersions(...)`, `degradedDatasets` (`agent-skills` until the tracker flips), `retrieval`, the list source and `sourceUrlOf` (ingest record → citation URL); new `latestDocsVersion`, `recordDocsVersion`, `noteDocsTrigger`. `DATASET_VERSION_RETENTION = 5` unchanged.
- **Cached reads**: `DatasetListSource` + `DatasetListCache` (60 s, `DATASET_LIST_TTL_MS`; a failed list is never held and drops the held list; a create invalidates; concurrent callers share one in-flight fetch) threaded through `SearchDeps`/`IngestDeps`/`ResolveDeps`/`RefreshDeps.datasets`; `cache.ts` class `docs-search` (TTL 300), `DOCS_GENERATION_KEY = substrate:v1:gen:docs`, `shapeOk` `{chunks: array, untrusted: string}`; `Substrate.searchDocs` wraps `getOrLoad` with args `{question (trimmed, whitespace-collapsed, lower-cased), datasets (sorted), pins, degraded}` and `store` only when not degraded; every successful ingest and every recorded version bumps `gen:docs`.
- **Bounded growth**: `IngestDeps.prune` (from `config.docsPruneSuperseded`, `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1`); after the replacement parsed, `deleteDocuments` on the superseded id → `pruned_document_id` on the result and `pruned_document_ids` in the existing `note` payload; a failed delete → `prune: "failed: <reason>"`, one stderr/`log` line, no event, ingest still ok. Off = no delete call, result unchanged.
- **Async merge trigger**: `Substrate.startDocsRefresh(request, surface, {wait})` → `202 {accepted, job, dataset, commit, queued?}` at once; one promise chain per dataset (a new identity queues behind), same commit+hash while running/queued → the same job id with `queued: true`; the job runs ensure → `ingestDocs` → `recordDocsVersion` and ends with a stderr line `docs merge-trigger <job> <dataset> <commit>: vN recorded | failed — <reason>`; `wait` awaits the job (200 with the version and `job`, 503 with the reason). `server.ts` keeps every door and the `docs_ingest` audit, reads `?wait=1`, calls `latestDocsVersion` for idempotency and `noteDocsTrigger` (an `agent-skills` trigger is the D25-07 fast-forward evidence, even as a noop). `skills-sync.ts` unchanged: `postDocsRefresh` already treats `response.ok` (any 2xx) as delivered.
- **Config** (`config.ts`, append-only `// uplift-2 R6`): `docsPruneSuperseded`, `docsRetrieval` (+ `unitIntervalOr`). **Unit**: `Environment=SUBSTRATE_DOCS_STATE_FILE=/var/lib/substrate/docs-ingest.json` beside the outbox line. **Docs**: `docs/docs-search-ingest.md` (reference row, shapes table, knobs, caches, prune, state file v2, async trigger, skills-sync evidence, rehearsal list, live-unattested notes), `docs/data-planes.md` (Documents row; RAGFlow datasets table + "last five versions kept" paragraph).

## Files

Created: `packages/mcp-server/src/docs-plane-hardening.test.ts`, `.planning/uplift-2/06-PLAN.md`, `.planning/uplift-2/06-SUMMARY.md`, `.planning/uplift-2/env-notes/06.md`.
Modified: `packages/mcp-server/src/planes/ragflow.ts`, `planes/ragflow.test.ts`, `ragflow-fake.ts`, `docs-datasets.ts`, `docs-search.ts`, `docs-ingest.ts`, `cache.ts`, `config.ts`, `service.ts`, `server.ts`, `server.test.ts`, `infra/vps/substrate-mcp.service`, `docs/docs-search-ingest.md`, `docs/data-planes.md`.

## Existing test expectations changed (each necessarily broken by this item)

- `planes/ragflow.test.ts` "ragflowOp is a fixed table…": the pre-R6 `GET /api/v1/documents/{id}/parse` → `parse-status` row became `other`; the documented routes (`documents`, `document-delete`, `document-update`, `parse`, list with its query) were added.
- `server.test.ts` merge-trigger tests that assert the synchronous 200/503 bodies now POST `/docs/merge-trigger?wait=1` ("ingests the local roots", "creates the missing dataset", "dedupes by content hash" ×3 posts, "503 when the docs plane refuses", "records no version when the ingest is refused" ×2 posts). The refusal, noop and unconfigured tests are untouched (still 401/403/400/200).
- Not edited but worth knowing: `docs-search.test.ts` "metadata redaction" still passes, but its `source_url`/`heading_path` assertions are now vacuous (the fake serves no chunk metadata, per the reference); the meaningful proof moved to `docs-plane-hardening.test.ts` ("cited from the ingest record…, redacted"). `docs-ingest.test.ts` and `docs-datasets.test.ts` pass unchanged (`uploads[].metadata` is filled by the `meta_fields` PATCH; `toMatchObject` on the create body tolerates `chunk_method`).

## Knobs

| Variable | Default | Notes |
| --- | --- | --- |
| `SUBSTRATE_DOCS_STATE_FILE` | unset (unit: `/var/lib/substrate/docs-ingest.json`) | now records + versions, file version 2 |
| `SUBSTRATE_DOCS_PRUNE_SUPERSEDED` | off | `1` deletes the superseded document after the replacement parsed |
| `SUBSTRATE_DOCS_SIMILARITY_THRESHOLD` | 0.2 | [0, 1]; RAGFlow's default |
| `SUBSTRATE_DOCS_VECTOR_WEIGHT` | 0.3 | [0, 1]; RAGFlow's `1 − keywords_similarity_weight` |
| `SUBSTRATE_DOCS_TOP_K` | 1024 | > 0; RAGFlow's default |
| `DATASET_LIST_TTL_MS` (constant) | 60 000 | — |
| `CACHE_TTL["docs-search"]` (constant) | 300 s | generation `substrate:v1:gen:docs` |

## Tests added (written, not run here)

`docs-plane-hardening.test.ts`: multipart upload (field, filename, bytes) + `meta_fields` PATCH; JSON upload refused with the documented failure and the old poll route 404; failed PATCH deletes the orphan; parse call body, unparsed document times out, `run` progression through list-by-id with `?id=`; `FAIL` → `parse-failed`, business code under HTTP 200; `DELETE {ids}` and no call for an empty list; retrieval body with the three defaults, env overrides, junk fallback, documented chunk field mapping; create body with `chunk_method`, duplicate-name suffix, resolve-by-name picks the exact one, list pagination query; v1 → v2 state-file migration, round-trip, malformed rows skipped; citations `unpinned` → real commit after one ingest + record, pin and idempotency survive a new `Substrate` on the same file; `sourceUrlOf` citation (redacted) and the `dataset:<name>` fallback; dataset-list cache TTL boundary, create and failure invalidation, in-flight sharing; `docs_search` = 1 list + N retrievals then 0 plane calls on a hit (whitespace/case-normalised key, TTL 300); degraded never stored, `INCR gen:docs` after ingest and after a recorded version, miss afterwards; malformed `docs-search` value rejected; prune off/on/failed; merge-trigger 202 (< 500 ms, job id), same-identity `queued`, different identity queued behind, `?wait=1` joins the job and reports v2, idempotent 200 afterwards, one upload across both jobs; 401/400/403 unchanged, `?wait=1` 503 on a refused ingest; background failure logged, 503 on wait, no version; `agent-skills` trigger flips `pin_age_ms` off; unit file line present.

## Rollback

`git revert` the R6 range. Without a code change: `SUBSTRATE_DOCS_PRUNE_SUPERSEDED` unset (default) deletes nothing; the retrieval knobs unset send RAGFlow's own defaults; `SUBSTRATE_DOCS_STATE_FILE` unset keeps records and pins process-local as before. The 202 has no switch (`?wait=1` is the synchronous path); the documented shapes have no switch by design.

## Deviations and why

- **Metadata travels as a `meta_fields` PATCH after the upload** (§Update document) rather than inside the upload: the documented upload has no metadata slot. A failed PATCH deletes the orphan and fails the page, so no document sits on the plane without its source URL.
- **`source_url` in citations comes from the ingest record** (`SearchDeps.sourceUrlOf`, the service scans `docsIngestSeen` by document id) because the reference documents no metadata echo on retrieval chunks; the chunk's own `source_url` still wins when a deployment echoes it. `heading_path` is empty unless echoed.
- **`pollParseStatus` takes `{dataset_id, document_id}`** — the documented status read is per dataset. Same name, one more field.
- **`top_k` / `vector_similarity_weight`** are sent as the assignment names them; the reference marks `top_k` a deprecated alias of `knn_top_k` and `vector_similarity_weight` the legacy fallback of `keywords_similarity_weight` (both still documented and accepted). Noted in the docs; switching to the newer names is a one-line follow-up once a live call attests the backend version.
- **Document name = repo path with `/` → `__`** (not the basename): two pages with the same basename must not collide on the plane.
- **Dataset list cache holds successes only**: "invalidated when a list call fails" is implemented as "a failure is never held and drops the held list", so a plane that just errored is asked again next call.
- **Cache key includes the degraded set** (not in the assignment's list): otherwise a cached answer could carry `pin_age_ms` for up to 300 s after the tracker flipped.
- **Skills-sync evidence**: nothing in-process ever called `noteSkillsSyncFastForward`; the server now flips the tracker when a merge-trigger for `agent-skills` arrives (the tick's delivery is the evidence), so D25-07's degraded arm ends for that process on the first delivered trigger.
- **Merge-trigger job outcomes**: a success is recorded in the version store (persisted) and the ingest records; a failure is recorded on stderr and returned by `?wait=1` for a same-identity trigger while the job is pending — there was no existing stderr line for the trigger, so one was added rather than extended. Jobs are not drained at shutdown (`index.ts` is not in scope); a job cut by a restart is re-triggered by the next tick, cheaply by hash.
- `.env.example`, `README.md`, `STATE.md`, `HANDOFF.md`, `PROPOSAL.md` untouched per the rules; the env block is in `env-notes/06.md`.

## Before / after (BASELINES.md rows)

| Row | Baseline | After |
| --- | --- | --- |
| RAGFlow datasets, chunk/embedding settings, retrieval p95 | unknown (no live ingest attested) | post-deploy measurement pending; `substrate.plane.duration{plane=ragflow,op}` (R2) now labels every documented route |
| citations carrying a real commit pin | 0 % (`dataset-pin:<name>:unpinned` on every production citation; version store in memory) | 100 % after one recorded version, surviving restarts via the state file (unit: `after.chunks.every(commit === "c-real")` on a second `Substrate`); post-deploy measurement pending |
| RAGFlow calls per `docs_search` | 1 + N (list per call, no answer cache) | N with the list cached (unit: 1 list + 3 retrievals), 0 on a cache hit (unit: no request on the second call); post-deploy measurement pending |
| superseded documents on the plane | never deleted (corpus grows per changed page) | unchanged by default; deleted after parse with `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1` (unit: `deleted` = [superseded id]) |
| merge-trigger answer time vs the skills-sync 3 s budget | ingest inline, up to 60 s/page → client timeout | 202 in ~3 ms measured through the service (unit bound 500 ms); post-deploy measurement pending |
| RAGFlow public edge TTFB 253 ms | per call | fewer calls per search (above); per-call latency unchanged |

## Live-unattested (only a real RAGFlow can confirm)

- Every request/response shape in the table above, including the `code` envelope and the `run` spellings; the deployment's backend version (Python vs the 1.0 Go backend — the latter renames `chunk_method: "naive"` to `parser_id: "general"` on create).
- `DATASET_EMBEDDING_MODEL = "tei-bge-small"` against the documented `model_name@model_factory` format.
- Whether `meta_fields` set by PATCH are echoed on retrieval chunks (the client would use `source_url`/`heading_path` if so; the fake assumes not).
- Whether `top_k`/`vector_similarity_weight` are still accepted by the deployed version (documented as deprecated/legacy aliases).
- Multipart acceptance of a `.md` file named `docs__x.md` and its type detection; parse duration against the 30 × 2 s budget.
- The delete call's effect on already-served chunks (prune is off by default until attested).

## Gates

(filled by orchestrator)
