# R6 plan — RAGFlow (retired) docs plane: durable versions, cached reads, bounded growth, verified shapes, async merge trigger

Scope: PROPOSAL.md §R6; BP-5.1, DP-ret, A-4, DP-cache. Branch `ultrathink/uplift-2`, in place. Edit only; no gates run here.

## Shapes (RAGFlow (retired) "HTTP API" reference, https://ragflow (retired).io/docs/http_api_reference, read 2026-10-13)
1. `POST /api/v1/datasets` `{name, embedding_model, chunk_method:"naive"}` → `{code:0, data:{id,…}}` (§Create dataset).
2. `GET /api/v1/datasets?page&page_size` → `{code:0, data:[{id,name,…}]}` (§List datasets).
3. `POST /api/v1/datasets/{id}/documents` multipart `file` → `{code:0, data:[{id,name,run:"UNSTART",…}]}` (§Upload documents); metadata via `PATCH …/documents/{doc}` `{meta_fields}` (§Update document).
4. `POST /api/v1/datasets/{id}/chunks` `{document_ids}` → `{code:0}` (§Parse documents).
5. `GET /api/v1/datasets/{id}/documents?id=` → `{code:0, data:{docs:[{id, run: UNSTART|RUNNING|CANCEL|DONE|FAIL|SCHEDULE | "0".."5", progress_msg}]}}` (§List documents).
6. `DELETE /api/v1/datasets/{id}/documents` `{ids}` → `{code:0}` (§Delete documents).
7. `POST /api/v1/retrieval` `{question, dataset_ids, page, page_size, similarity_threshold (0.2), vector_similarity_weight (legacy; 1−keywords 0.7 = 0.3), top_k (deprecated alias of knn_top_k, 1024)}` → `{code:0, data:{chunks:[{content, document_id, document_keyword, id, similarity, dataset_id}]}}` (§Retrieve chunks).
Every answer: HTTP status + business `code` (0 = success) checked separately (§ERROR CODES).

## Steps
- `planes/ragflow (retired).ts`: route table, business-code check, multipart upload + meta PATCH, `parseDocuments`, `pollParseStatus` over list-by-id, `deleteDocuments`, retrieval knobs (`RetrievalKnobs`, defaults = RAGFlow (retired)'s), documented chunk field names, `documentName(path)`.
- `ragflow (retired)-fake.ts`: documented request/response shapes only; JSON upload → 400 "No file part!"; old `/documents/{id}/parse` → 404; parse progression UNSTART→RUNNING→DONE|FAIL; delete; list failure/delete failure knobs.
- `docs-datasets.ts`: `DatasetListSource` + `DatasetListCache` (60 s, invalidate on create/failure); versions ↔ JSON helpers; deps thread the source.
- `docs-ingest.ts`: prune (flag) after parse success, `pruned_document_id` / `prune: "failed: …"`; state file v2 `{version:2, records, versions}` with one-way v1 migration; filename from path.
- `docs-search.ts`: list via source, knobs, `sourceUrlOf` (ingest records → citation URL), degraded set.
- `cache.ts`: class `docs-search` (300 s), `DOCS_GENERATION_KEY`, `shapeOk`.
- `config.ts`: `// uplift-2 R6` — `docsPruneSuperseded`, `docsRetrieval`.
- `service.ts`: R6 field block (versions, list cache, skills-sync tracker, jobs); `searchDocs` cached + pinned; `ingestDocs` prune/bump/persist; `latestDocsVersion`, `startDocsRefresh` (202 jobs, per-dataset chain, same-identity dedupe, `wait`).
- `server.ts`: merge-trigger uses the service; `?wait=1` synchronous; version store removed from the server.
- `infra/vps/substrate-mcp.service`: `Environment=SUBSTRATE_DOCS_STATE_FILE=/var/lib/substrate/docs-ingest.json`.
- Docs: `docs/docs-search-ingest.md`, `docs/data-planes.md` (Documents row, RAGFlow (retired) table).
- Tests: new `docs-plane-hardening.test.ts`; `ragflow (retired).test.ts` op table; `server.test.ts` sync tests use `?wait=1`.
- `06-SUMMARY.md`, `env-notes/06.md`.
