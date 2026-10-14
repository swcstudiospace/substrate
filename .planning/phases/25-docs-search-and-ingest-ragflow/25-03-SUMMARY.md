# 25-03 Summary: docs_search core (validation, mapping, never-throw taxonomy)

**Wave:** 2 · **Plan:** 25-03 (Tasks 1–3) · **Live proof:** EXPLICITLY NOT RUN (no network calls; see §5)

## 1. What was built

- **Task 1 — `validateSearchInput()`** (`docs/search.ts`): query required
  1–1000 chars; datasets optional registry names defaulting to every
  id-known registry entry; limit int 1–10 default 5; `similarity_threshold`
  optional finite-number passthrough. Registry membership is checked
  synchronously first, so an unknown name short-circuits to
  `unknown-dataset` with zero RAGFlow calls; unresolvable names are skipped
  and an empty resolved set likewise returns `unknown-dataset`, so
  retrieval always receives a non-empty explicit `dataset_ids`. No exported
  function accepts raw RAGFlow ids — a same-tenant id passed as a "name" is
  `unknown-dataset`.
- **Task 2 — `runSearch()` mapping** (D25-02/D25-04): retrieval with
  `page_size = limit` (headroom for 25-02's version post-filter noted in
  code); each chunk mapped through `lookupSource` (local manifest seam for
  25-02) then the default `listDocuments` + `meta_fields` fallback to
  `{title, source_url, heading_path, commit, snippet, score,
  ids{dataset_id, document_id, chunk_id}}`; snippet is `redact()`-then-cut
  to 1200 chars; sourceless chunks dropped with `dropped:<n>`; top level
  `{untrusted: true, notice: SEARCH_NOTICE, results, reason?, dropped?}`.
  A failing document fallback drops the chunk rather than failing the
  search. `metaFromDocument()` is exported for 25-04 reuse.
- **Task 3 — never-throw taxonomy** (D25-03): every failure returns
  `{results: [], reason}` — all eight reasons reachable
  (`not-configured`, `unauthenticated`, `unknown-dataset`,
  `invalid-request`, `ragflow-timeout`, `ragflow-unreachable`,
  `ragflow-error`, `ragflow-bad-response`). Kept RAGFlow messages go in
  `detail`, redacted, URL-stripped, and cut to 200 chars. The file header
  documents the search path as outside the 1.5 s brief budget (configured
  RAGFlow timeout, default 10 s).
- **Manifest coordination:** `docs/manifest.ts` had not landed, so the
  lookup is defined locally as `SourceMeta` + `lookupSource`/`lookupDocument`
  seams against 25-02's interface. Sibling files never touched.

## 2. Must-haves, observable

- `bun test packages/mcp-server/src/docs/search.test.ts` → **22 pass, 0 fail**
  (boundary limits 0/1/10/11, empty/1001-char queries, unknown-name and
  invalid-input zero-call short-circuits, default-set expansion, raw-id
  rejection, full-field result, redact-first cut-boundary secret,
  drop counting, zero-result clean shape, all eight reasons, hostile-message
  redaction + 200-char cut, failing-list mapping).
- Adjacent suites (`registry`, `ragflow`) unaffected: 52 pass total.
- `bunx tsc --noEmit` → only the 3 pre-existing `@substrate/ledger`
  errors in untouched files (identical to the 25-01 baseline).
- `grep -c "http" packages/mcp-server/src/docs/search.test.ts` fixtures are
  runtime-assembled (`"https://" + …`, `"http://" + …`); no secret, URL, key,
  or raw body appears in a diff or reply.

## 3. Verification (run once at end, per plan)

- `bun test packages/mcp-server/src/docs/search.test.ts` → 22 pass, 0 fail.
- `bun test …/search.test.ts …/registry.test.ts …/ragflow.test.ts` → 52 pass.
- `bunx tsc --noEmit` → 3 pre-existing ledger errors only; no error in
  `search.ts` / `search.test.ts`.

## 4. Files

New: `packages/mcp-server/src/docs/search.ts`,
`packages/mcp-server/src/docs/search.test.ts`.
Not touched: `registry.ts`, `ragflow.ts`, `redact.ts`, `config.ts`,
sibling-owned `ingest.ts` / `manifest.ts` / `versions.ts`, routes/tools/events
(25-04 consumes `runSearch` / `validateSearchInput`).

## 5. Live proof — NOT RUN

No `RAGFLOW_URL` traffic was made: all retrieval runs against an in-process
fake client. Operator live step 5 (first half) must still prove search
against the deployed RAGFlow with datasets present and sourced results.

## 6. Open / risks

- Default `lookupDocument` lists (first page, 100) per dataset per search;
  fine for this phase's registries, revisit if a registry grows past it.
- `detail` is an extra field beyond D25-02's listed top-level keys; 25-04
  should confirm the route/MCP mapping passes it through or drops it.
- Empty-resolved-default (registry with zero known ids) answers
  `unknown-dataset`; flagged in code as the closest closed-list token.
