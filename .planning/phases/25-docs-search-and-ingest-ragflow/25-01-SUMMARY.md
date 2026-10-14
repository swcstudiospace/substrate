# 25-01 Summary: RAGFlow foundation (registry, config, client, redact rule)

**Wave:** 1 · **Plans:** DOCS-01/DOCS-02 foundation · **Live proof:** EXPLICITLY NOT RUN (no network calls; see §5)

## 1. What was built

- **Task 1 — research note** (`packages/mcp-server/src/docs/ragflow.ts`, top comment block):
  deployed tag **0.27.1** (infiniflow/ragflow); confirmed shapes — Bearer auth,
  `{code, message, data}` envelope (109/108/101/102), `POST /api/v1/retrieval`
  `{question, dataset_ids, page, page_size, similarity_threshold}` →
  `{chunks: [{id, content, document_id, dataset_id, similarity, document_keyword}]}`,
  `GET /api/v1/datasets?page=&page_size=`, `POST /api/v1/datasets`
  `{name, description, chunk_method: "naive"}` (+ minimal retry),
  `PUT /api/v1/datasets/{id} {embedding_model}`,
  document list `{docs: [{id, name, run, meta_fields}]}` with
  `run ∈ UNSTART/FAIL/CANCEL/DONE`, multipart `file` upload,
  `PUT …/documents/{doc} {meta_fields}`, `POST …/chunks {document_ids}`,
  `DELETE …/documents {ids}`. Sources: local seed/retrieval clients and the
  neighbouring deployment's integration notes — read from disk only, zero live calls.
  **D25-17 choice:** default to preference 3 (post-filter; later plan 25-02) —
  no enable/disable flag and no retrieval `document_ids` filter appear in the
  observed sources; both stay OPEN for the operator live step, as does the
  single-document status endpoint.
- **Task 2 — registry** (`docs/registry.ts` + test): `DatasetEntry`
  {name, slug, include, exclude, trigger, datasetId?}, all eight entries
  (agent-substrate excludes `docs/receipts/**`, pinned by test; four product
  entries provisional per operator question 3), `loadRegistry()` with
  `SUBSTRATE_DOCS_DATASETS` replace-semantics validated without throwing,
  `resolveDatasetId()` (static id → cached list lookup → typed
  `unknown-dataset`; names only, never raw ids).
- **Task 3 — config** (`config.ts` + test): `ragflow` block (url, apiKey,
  timeoutMs default 10 s) and `docs` block (stateDir default
  `/var/lib/substrate/docs`, embeddingModel, datasetsFile). URL rule:
  `https:` anywhere, `http:` to loopback/single-label only; dotted-public
  `http:` rejected into `configWarnings` on the existing channel, never a
  throw. Neither-set → `ragflow: null` with no warning (keeps rehearsal
  zero-warning tests green); partial/invalid → named-key warning.
- **Task 4 — client + redact rule** (`docs/ragflow.ts` + test; `redact.ts` +
  parity coverage): `RagflowClient` (Bearer-only to configured origin, manual
  redirects with cross-origin refusal, config timeout incl. TimeoutError,
  errors via `redact()`+`redactKnown()` cut to 200 chars, never URL/key/body);
  fake-transport tests prove timeout / non-zero code / malformed JSON /
  cross-origin-refused / same-origin-followed plus upload/parse/list/update/
  delete/ensureDataset (with minimal-create retry + embedding PUT).
  `ragflow-` high-confidence rule on both passes: event rule, skill finding,
  `docs/redaction.md` row (now thirty-one rules), lock detector + planted
  offender, event fixture, skill sample.

## 2. Must-haves, observable

- `grep -n D25-17 packages/mcp-server/src/docs/ragflow.ts` → research block + choice.
- `bun test` on the touched suites: **299 pass, 0 fail** (7 files).
- `bunx tsc --noEmit`: clean for all touched files; 3 remaining errors are
  pre-existing `@substrate/ledger` resolution in untouched files
  (verified identical on the clean tree via stash).
- No existing test changed outcome except intended parity coverage
  (rule count 30→31, new detector/offender/fixture/sample rows).

## 3. Verification (run once at end, per plan)

- `bun test packages/mcp-server/src/docs/ packages/mcp-server/src/config.test.ts
  packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts
  packages/mcp-server/src/redact-contract.test.ts packages/mcp-server/src/redact-adversarial.test.ts`
  → 299 pass, 1 skip, 0 fail.
- `bunx tsc --noEmit` → only the 3 pre-existing ledger errors above.

## 4. Files

Modified: `packages/mcp-server/src/{config.ts,config.test.ts,redact.ts,redact.test.ts,
redact-lock.test.ts}`, `docs/redaction.md`.
New: `packages/mcp-server/src/docs/{registry.ts,registry.test.ts,ragflow.ts,ragflow.test.ts}`.
Not touched (later plans): `service.ts` (injection seam), routes, tools, CLI, timer, harness fixture.

## 5. Live proof — NOT RUN

No `RAGFLOW_URL` traffic was made: no live RAGFlow exists in this
environment and the contract forbids it. Operator live step 1 (read-only
version/dataset/embedding-model query) must still confirm the Task 1
shapes against the deployed 0.27.1 tag, plus the D25-17 preferences 1–2.

## 6. Open / risks

- Rehearsal `zero warnings` tests pin silent-when-absent: a fully missing
  ragflow block warns nowhere (documented in §1); partial/invalid warns.
- `ensureDataset` create-response id extraction is tolerant (`id` /
  `dataset_id` / string rows); confirm the exact 0.27.1 create shape live.
- Markdown `chunk_method` beyond `naive` unconfirmed; client defaults to
  `naive` with the seed's parser_config, retrying minimal.
