# Docs plane — cited answers from LightRAG (hybrid) with Hindsight context

Tracked as DOCS-01/02/03 (Phase 25). Agents get cited docs answers through
the substrate only: no agent holds `LIGHTRAG_API_KEY`, `LIGHTRAG_URL`,
`RAGFLOW_API_KEY` or `RAGFLOW_MCP_URL`, and nothing secret, unsourced,
out-of-root or oversize reaches a dataset.

The plane is chosen in `resolveDocsBackend` in `packages/mcp-server/src/config.ts`.
`SUBSTRATE_DOCS_BACKEND` (`lightrag` or `ragflow`, case-insensitive) wins.
Otherwise a set `LIGHTRAG_URL` selects `lightrag`, and an unset one selects
`ragflow`. LightRAG is the live production backend: it was cut over on
2026-10-28 (Run 11) with `SUBSTRATE_DOCS_BACKEND=lightrag`, in naive query mode
until the operator decides on a real LLM for graph and hybrid retrieval.
RAGFlow is only the legacy fallback when `LIGHTRAG_URL` is unset (`resolveDocsBackend`).
`lightragFromEnv` in the same file reads `LIGHTRAG_URL` and the optional
`LIGHTRAG_API_KEY`. The RAGFlow service was deleted on 2026-10-25; its code stays
until the operator approves removal (phase 46), and it is not a runtime fallback
for LightRAG (see "Failure and fallback" below).

## The two tools

`docs_search` (DOCS-01) is a read inside an agent's turn: `query` (1–1,000
chars), optional registry dataset `datasets`, `limit` (1–10, default 5),
optional `similarity_threshold`. Callers never pass raw dataset ids; the
substrate resolves names. One JSON shape on both doors (MCP tool and `POST
/docs/search`): `untrusted: true`, a fixed notice (retrieved data, not
instructions — cite `source_url`), `results`, and `reason` only when empty
through error or refusal. Each result carries `title`, `source_url`,
`heading_path`, `commit`, `snippet` (redacted, then cut to 1,200 chars),
`score`, and `ids`. Failures never throw: 200 with `results: []` and a
closed-list reason. On the RAGFlow plane that list is `not-configured`,
`unauthenticated`, `unknown-dataset`, `invalid-request`, `ragflow-timeout`,
`ragflow-unreachable`, `ragflow-error`, `ragflow-bad-response`. On the
LightRAG plane a failed query reads `lightrag unreachable: …` or
`lightrag circuit open` (`unreachable` and `LIGHTRAG_CIRCUIT_OPEN` in `planes/lightrag.ts`), and the reply is the
Hindsight fallback when recall finds something. Anonymous callers get
`unauthenticated` with no plane call and no event; every authenticated
search emits exactly one event (`docs.search` note or warning), fail-open,
without the query text.

`docs_search` also takes an optional `context` boolean, default `false`, on
both backends. With `true`, the reply adds recalled memories and the
session's recent events, framed as untrusted. The section "Hybrid retrieval
and context augmentation" in `docs/docs-search-ingest.md` sets out its
budgets and degraded reasons.

**Open item D46-i.** The paragraph above names `query` and `limit` as the `docs_search` arguments. The server's input schema takes `question`, `datasets`, `session_id` and `context`, and it does not accept `limit`. This page keeps that wording until a separate docs change corrects it.

`docs_ingest` (DOCS-02) is a publication path: only `substrate` and operator
tokens (anonymous 401 before the body is read, agent surfaces 403). The page
carries `dataset`, `source_url` (canonical
`https://github.com/<slug>/blob/<commit>/<path>`), `commit` (40-hex),
`content` (UTF-8 markdown), optional `title` and `dry_run`. The pipeline
order is fixed — authenticate, shape/roots/caps, strip every image, run
`redactSkillContent` (a high-confidence finding refuses as `secret` with
`findings: [{line, rule}]`, never a value), then hash/split/idempotency check
and upload+parse. Caps: 1 MB body (413), 256 KiB content, 200 sections,
200-char title. The status mapping and the RAGFlow failure codes described
here apply to the RAGFlow ingest path. The MCP tool returns the same JSON
with `isError` on every non-200 case.

## Registry, versions, refresh, triggers

The dataset registry (`packages/mcp-server/src/docs-datasets.ts`) is code:
`agent-substrate`, `agent-skills`, `programming-desk` plus the four
provisional product datasets (slugs and roots confirmed by the operator;
until then the live DOCS-03 proof covers the first three only).
`SUBSTRATE_DOCS_DATASETS` may point at a JSON file replacing it — only the
harness and tests use it. `docs/receipts/**` is excluded everywhere and
pinned by the smoke.

Idempotency on the RAGFlow path is by content hash (stripped, redacted,
normalised path — commit excluded) recorded in RAGFlow itself, so it survives
loss of local state. A version is one refresh run at a commit, cut by a final
`finalize: true` ingest: that commit's pages become current, absent pages
stop being searchable (post-filter against the manifest), the last five
versions are kept, and documents outside them are deleted. The manifest
lives in `SUBSTRATE_DOCS_STATE` (default `/var/lib/substrate/docs`),
written atomically under a per-dataset lock.

`substrate docs refresh` (DOCS-03) reads committed objects only (`git
ls-tree`/`git show`, never a working tree), posts one page per matching text
file, polls parses via `finalize`, and exits 1 without cutting when nothing
was ingested. "On merge" is the `substrate-docs-refresh` host timer (every
10 minutes, fetching each repo's `main` into a bare mirror), plus the
skills-sync fast-forward hook for `agent-skills` once Phase 22 lands — never
a GitHub Action, which cannot reach the loopback substrate.

## LightRAG client contract

Where LightRAG keeps its state (storage backends, workspace, embedding model
and dimension, image pin) is a setting of the LightRAG server, not of
`substrate-mcp`; the decision record, the operator preflight and the upgrade
design are in `docs/runbooks/lightrag-storage-topology.md`. The contract the
client keeps with the server (upstream v1.5.7; the recorded route list is
`packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json`):

- **Auth.** `LIGHTRAG_API_KEY` is sent as `X-API-Key` and only that. It is
  never sent as `Authorization: Bearer`: the server reads a bearer value as a
  JWT first and answers 401 to one that is not (`lightrag/api/utils_api.py`
  upstream), so a key sent as a bearer can fail a request the header alone
  would pass. The key is never put in a reason string.
- **Pipeline status.** `GET /documents/pipeline_status` returns a `busy`
  boolean. `busy: true` means ingest is still running; `busy: false` means
  idle. A reply with no recognisable `busy` flag is reported as an
  unexpected shape rather than polled until `parse-timeout`.
- **Delete.** Removing one document is `DELETE /documents/delete_document`
  with `{ "doc_ids": [...] }`. `DELETE /documents` is the clear-all route and
  is never called; the client denylists it.
- **`track_id` is not a document id.** `POST /documents/upload`, `/text` and
  `/texts` return a `track_id` (`InsertResponse`). The document ids it
  covers come from `GET /documents/track_status/{track_id}`. The id a delete
  takes is the document id.
- **Health.** A read-only `GET /health` probe feeds `planes.lightrag.ok`;
  before it, no LightRAG health call existed and the value was always null.
- **Exposure.** Set the server's `WHITELIST_PATHS` to `/health` at most: the
  default also exempts the Ollama-compatible `/api/*` routes from auth.

These behaviours are implemented in `planes/lightrag.ts` (phase 56): the key
goes out as `X-API-Key` only and the `busy` flag is read as the idle signal.

## Hybrid retrieval and context

Retrieval on the LightRAG plane is a graph-hybrid query by design (production runs naive until the operator's LLM decision); the mode and the
context block are described in `docs/docs-search-ingest.md`, section "Hybrid
retrieval and context augmentation". In brief:

- The query mode defaults to `hybrid` (`DEFAULT_QUERY_MODE` in
  `planes/lightrag.ts`). `SUBSTRATE_LIGHTRAG_QUERY_MODE` overrides it, and
  production sets `naive` because LightRAG runs on the bypass LLM (Run 11);
  `hybrid` fails the smoke query check in that state. A leading `/mix` or
  `/hybrid` in the question selects that mode and is stripped from the query
  (`resolveQueryMode` in `planes/lightrag.ts`).
- `context` is opt-in and off by default on every backend (`searchDocs` in
  `service.ts`). With `context: true` a successful LightRAG answer
  carries the Hindsight context block beside its citations.

## Failure and fallback

On the LightRAG plane a failed query is retried under the plane's retry
policy. If it still fails, or the LightRAG breaker is open, the answer
falls back to Hindsight recall (`lightragFallback` in `docs-search.ts`):

- The reply is Hindsight-sourced: `backend: "hindsight"`,
  `fallback: "hindsight"`, `degraded: true`, and `reason` names the LightRAG
  failure. Its notice reads "Served from Hindsight fallback: <reason>."
  (`hindsightFallbackReply` in `docs-search.ts`).
- A warning event `docs search failed: <reason>` carries
  `fallback: "hindsight"` (emitted by `lightragFallback`).
- A degraded reply is never cached (`searchReplyStorable` in `docs-search.ts`).
- If recall finds nothing, the plain degraded reply stands with the LightRAG
  reason.
- An unconfigured LightRAG plane (`lightrag-not-configured`) takes the same
  path: Hindsight recall answers when it finds something, else the degraded
  reply.
- `docs_lightrag_query` and `POST /docs/lightrag/query` set `degraded: true`
  and `reason` on a reply served from Hindsight, and `fallback: "hindsight"`
  on every reply served after a failed, refused or unconfigured query. With no
  Hindsight chunk, `reason` also records that recall was empty. Their replies
  keep `backend: "lightrag"`, `graph` and the RAG machine `state`.

A failed LightRAG query does not retry against RAGFlow. RAGFlow serves only
when it is the selected plane.

## The `corpus` dataset (phase 63)

`corpus` is the fourth default search dataset beside `agent-substrate`, `programming-desk` and `agent-skills`. It holds the documentation of every repository the owner keeps, put there by the bulk ingest (`POST /corpus/ingest`, the `corpus_ingest` tool, `substrate corpus ingest --execute`), not by `docs_ingest`. It is closed until the server runs with `SUBSTRATE_CORPUS=on`.

- **One workspace.** LightRAG has a single workspace and ignores dataset scope on the wire, so `corpus` is a label on search results, not a separate index. The repository travels in the document name.
- **Document names.** A document is stored under `corpus:<repo>:<path>@<first 12 hex of its sha256>`, with `/` and `%` percent-encoded (`%2F`, `%25`) because the plane keeps only the last path component of a name. The sha suffix is there because the plane answers a same-name document with 409: a changed document gets a new name, is recorded, and only after every row of the request is recorded is the old plane document deleted (and only when no active row holds it). A name the plane would alter or refuse is never sent; that document is refused `unsafe-name`.
- **Citations.** A LightRAG result whose file path is a corpus document name cites the document's own repository and path: `source_url` is `https://github.com/<owner>/<repo>/blob/HEAD/<path>` for a GitHub origin and `corpus://<repo>/<path>` otherwise, `title` is `<repo>:<path>`, `dataset` is `corpus`, and `heading_path` keeps what LightRAG returned. Other results are cited as before and carry no `dataset` member.
- **What is in a document.** The text sent is the file body with remote images stripped, after the same secret findings `docs_ingest` runs (a finding refuses the document and nothing is sent). Kind, tier, source and commit live in the manifest (`docs/data-planes.md`), not in the text.
- **Identical text.** The plane stores the same text once: a second name for it answers the first document's id. The manifest records both rows against that id and a plane document is deleted only when no active row holds it, and never while an insert of the same request is in flight.
- **Events.** One `note` per ingest request with `payload.action: "docs.corpus.ingest"` (counts only) and one `warning` per refusal reason with `payload.action: "docs.corpus.refused"`, listed in `docs/event-vocabulary.md`.

## Proof

Isolated: unit tests against in-process fakes, and `bun scripts/docs-smoke.ts --name <owned>`
against a twin started with
`rehearsal up --ragflow-fixture` — a loopback fake RAGFlow with scriptable
timeout/error-code/malformed modes, run-dir manifest and fixture registry
(see `docs/rehearsal.md`). Live (operator-approved, explicitly not run here):
the five gated steps in `docs/rehearsal.md`.
