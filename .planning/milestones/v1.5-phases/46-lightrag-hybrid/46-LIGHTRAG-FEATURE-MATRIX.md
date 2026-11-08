# Phase 46: LightRAG feature matrix

Every LightRAG v1.5.x feature the substrate client exposes, classified from
`packages/mcp-server/src/planes/lightrag.ts` and the route fixture
`planes/__fixtures__/lightrag-v1.5.7-routes.json` (HKUDS/LightRAG tag v1.5.7,
derived from upstream source, not recorded from a live server).

Status meanings:

- **enabled**: the code calls the feature and a test exercises it.
- **disabled**: the code refuses or does not send it, with the reason stated.
- **unavailable**: not on the server contract in the fixture, or not called.

Live evidence is limited to what the plan records: production runs `naive`
query mode (Run 11, 2026-10-28, six-check smoke). Nothing in this matrix was
run against a live LLM route. Hybrid and graph modes are tested only with the
fake server.

## Query modes (`POST /query`, `mode` field)

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| `naive` | `mode: "naive"` | enabled | Production default since Run 11 (`SUBSTRATE_LIGHTRAG_QUERY_MODE=naive`); `lightrag.test.ts` "a naive default in the config sends mode naive for a question with no prefix" |
| `local` | `mode: "local"` | enabled | Accepted by `isLightragQueryMode`; `lightrag.test.ts` "isLightragQueryMode accepts exactly the five modes the client sends" and "explicit mode, then a graph prefix, then the fallback, then hybrid". No live call. |
| `global` | `mode: "global"` | enabled | As `local`. No live call. |
| `hybrid` | `mode: "hybrid"` (the code default) | enabled, fake server only | `lightrag.test.ts` "sends query, default hybrid mode, clamped top_k and only_need_context". Graph mode: needs the operator LLM route; production runs naive because `hybrid` fails the smoke query on the bypass LLM. |
| `mix` | `mode: "mix"`, or `/mix` prefix | enabled, fake server only | `lightrag.test.ts` "a leading /mix prefix selects mix and is stripped from the query". Graph mode: needs the operator LLM route. |
| `bypass` | `mode: "bypass"` | disabled | Upstream accepts it (`QueryRequest` in the fixture), but the client's five-mode set does not include it, so it is never sent. `bypass` names the server's no-LLM setting (`infra/railway/lightrag-llm-bypass.ts`), not a retrieval mode the substrate asks for. |

## Query selection

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| Default mode from config | `SUBSTRATE_LIGHTRAG_QUERY_MODE` | enabled | `lightrag.test.ts` "an unset config sends exactly the request it always did: hybrid, no extra keys"; `config.test.ts` "SUBSTRATE_LIGHTRAG_QUERY_MODE" |
| Question prefix `/mix`, `/hybrid` | stripped from the query | enabled | `lightrag.test.ts` "a /mix or /hybrid prefix beats a naive default, and an explicit mode beats the prefix" |
| Precedence | explicit mode, then prefix, then config default, then hybrid | enabled | `lightrag.test.ts` "explicit mode, then a graph prefix, then the fallback, then hybrid" |
| Top-k clamp | `top_k` clamped to 10 | enabled | `lightrag.test.ts` "sends query, default hybrid mode, clamped top_k and only_need_context" |

## HTTP routes (fixture v1.5.7)

| Route | Client function | Status | Evidence |
| --- | --- | --- | --- |
| `POST /query` | `queryWithGraph`, `queryForTool`, `retrieveChunks` | enabled | `lightrag.contract.test.ts`; `lightrag.test.ts` "parses a bare array…", "parses the { response: string } form…" |
| `POST /documents/upload` | `uploadDocument` (multipart) | enabled | `lightrag.test.ts` "multipart upload carries file, file_source, source_url, commit and heading_path" |
| `POST /documents/text` | `uploadDocument` fallback on 404 | enabled | `lightrag.test.ts` "on a 404 from the multipart route, falls back to POST /documents/text with the same metadata" |
| `POST /documents/texts` | bulk batches (`lightrag-bulk.ts`) | enabled | `lightrag-bulk.test.ts` "more documents than one request may carry are split in order, with one pipeline wait"; "a 413 … retries the batch in halves" |
| `POST /documents/scan` | `scanDocuments` (pipeline trigger) | enabled | `lightrag.test.ts`; `docs-ingest.test.ts` |
| `GET /documents/pipeline_status` | `pollParseStatus`, bulk waits | enabled | `lightrag-bulk.test.ts` "a busy plane is waited on and retried; one that stays busy fails the ids as plane-unavailable" |
| `GET /documents/track_status/{track_id}` | `resolveDocumentIds` | enabled | `lightrag.test.ts` "returns the real document ids, from the url-encoded track id route" |
| `POST /documents/paginated` | bulk listing in `createLightragBulkPlane` (`PlaneListing`) | enabled | `lightrag-bulk.test.ts` "every page is read in order at the largest page size…"; "a page that fails fails the whole listing" |
| `DELETE /documents/delete_document` | `deleteDocuments` | enabled | `lightrag.test.ts` "sends doc_ids to the per-document route, never the clear-all one"; `lightrag-bulk.test.ts` "ids go in requests of at most the delete limit…" |
| `GET /health` | `probeLightrag` | enabled | `lightrag.test.ts` "an authenticated healthy answer is ok with busy and version" |
| `DELETE /documents` (clear-all) | none | disabled, permanently | Denylisted in the fixture. `isClearAllRequest` refuses it before any network I/O (`LIGHTRAG_CLEAR_ALL_REFUSED`). `lightrag.test.ts` "every spelling of DELETE /documents is recognised, the per-document route is not"; "no client function, whatever its arguments, emits DELETE /documents" |

## Graph

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| Graph detail on a query | `data.entities`, `data.relations` (or under `data.graph`) on `POST /query` | enabled, fake server only | `lightrag.test.ts` "keeps graph detail on queryWithGraph" and "reads graph detail nested under data.graph as well"; `docs-search.test.ts` "search graph metadata (LightRAG path)" |
| Graph management routes (`/graphs`, `/graph/label/*`) | none | unavailable | Not in the v1.5.7 fixture, and the client never calls them. Graph coverage comes only from the query envelope. |

## Bulk ingest and corpus

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| Bulk corpus ingest | `createLightragBulkPlane` (`SUBSTRATE_CORPUS=on`) | enabled | `lightrag-bulk.test.ts`: the listing, delete, busy and batch-split tests above. Live ingest not run in this track. |
| Corpus citations | `dataset: "corpus"` from a corpus document name | enabled | `docs-search.test.ts` "a docs search through the service cites the commit the corpus manifest records" |

## Auth

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| `X-API-Key` header | every call | enabled | `lightrag.test.ts` "sends only X-API-Key (never an Authorization bearer) on every route when a key is set" |
| No key | keyless reach | enabled | `lightrag.test.ts` "sends neither auth header when no key is set, never 'Bearer undefined'" |
| Key never in a reason | transport and reach errors | enabled | `lightrag.test.ts` "the key never appears in a transport reason"; `config.test.ts` "the LightRAG API key never appears in a reach error" |

## Docs-search and RAG tool surface

| Feature | Route or option | Status | Evidence |
| --- | --- | --- | --- |
| `docs_search` on LightRAG, hybrid default | `searchDocs` (LightRAG path) | enabled, fake server only | `docs-search.test.ts` "criterion 1: docs_search answers from LightRAG in hybrid mode, with the Hindsight context block on a served answer, and only when asked" |
| `context: true` Hindsight block | `docsContextOf` | enabled | Same test: attached when asked, absent otherwise. Not stored. |
| Tandem recall (Hindsight merged into citations) | `startTandemLeg`, `mergeTandem` | enabled when `SUBSTRATE_DOCS_TANDEM=on` (off by default) | `tandem-recall.test.ts`, `service-tandem-scope.test.ts` |
| `docs_lightrag_query` and `POST /docs/lightrag/query` | `answerLightragQuery` | enabled | `mcp.test.ts` "docs_lightrag_query serves a Hindsight answer as degraded"; `server.test.ts` "the REST RAG breaker counts only plane failures" |

## Retry and degraded semantics

| Feature | Status | Evidence |
| --- | --- | --- |
| Retry with exponential backoff, fixed attempt count | enabled | `docs-search.test.ts` "a LightRAG retrieval that fails once is retried, and the retry's chunks are served, not degraded"; `server.test.ts` "a REST LightRAG query retried after a transient failure is served, not degraded" |
| Total time budget across attempts and waits | enabled | `docs-search.test.ts` "a LightRAG retry's backoff runs under the search budget…"; `server.test.ts` "the REST retry cap…" |
| No retry on breaker refusal, empty answer, or spent budget | enabled | `lightrag-attempts.ts` `retryableLightragFailure`; `docs-search.test.ts` "an empty LightRAG answer is never a success…" |
| Served, degraded (Hindsight), unavailable under one rule | enabled | `docs-search.test.ts` "a LightRAG search that fails every attempt is answered from Hindsight…" and "…is unavailable…"; `server.test.ts` "D-14: with LightRAG failing and recall empty…"; `mcp.test.ts` "with recall empty too, a failed LightRAG query is unavailable…" |
