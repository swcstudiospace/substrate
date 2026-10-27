# Docs plane — cited answers from LightRAG (hybrid) with Hindsight context

Tracked as DOCS-01/02/03 (Phase 25). Agents get cited docs answers through
the substrate only: no agent holds `LIGHTRAG_API_KEY`, `LIGHTRAG_URL`,
`RAGFLOW_API_KEY` or `RAGFLOW_MCP_URL`, and nothing secret, unsourced,
out-of-root or oversize reaches a dataset.

The plane is chosen in `resolveDocsBackend` (`packages/mcp-server/src/config.ts:74`).
`SUBSTRATE_DOCS_BACKEND` (`lightrag` or `ragflow`, case-insensitive) wins.
Otherwise a set `LIGHTRAG_URL` selects `lightrag`, and an unset one selects
`ragflow`. So with `LIGHTRAG_URL` unset the default docs backend is RAGFlow
(`config.ts:75`). `lightragFromEnv` (`config.ts:58`) reads `LIGHTRAG_URL` and
the optional `LIGHTRAG_API_KEY`. RAGFlow remains the plane until the
pending phase 46 cutover; it is not a runtime fallback for LightRAG (see
"Failure and fallback" below).

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
`lightrag circuit open` (`planes/lightrag.ts:73-75`), and the reply is the
Hindsight fallback when recall finds something. Anonymous callers get
`unauthenticated` with no plane call and no event; every authenticated
search emits exactly one event (`docs.search` note or warning), fail-open,
without the query text.

`docs_search` also takes an optional `context` boolean, default `false`, on
both backends. With `true`, the reply adds recalled memories and the
session's recent events, framed as untrusted. The section "Hybrid retrieval
and context augmentation" in `docs/docs-search-ingest.md` sets out its
budgets and degraded reasons.

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

The dataset registry (`packages/mcp-server/src/docs/registry.ts`) is code:
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

## Hybrid retrieval and context

Retrieval on the LightRAG plane is a graph-hybrid query; the mode and the
context block are described in `docs/docs-search-ingest.md`, section "Hybrid
retrieval and context augmentation". In brief:

- The query mode defaults to `hybrid` (`DEFAULT_QUERY_MODE`,
  `planes/lightrag.ts:40`). A leading `/mix` or `/hybrid` in the question
  selects that mode and is stripped from the query (`resolveQueryMode`,
  `planes/lightrag.ts:118-130`).
- `context` is opt-in and off by default on every backend
  (`service.ts:4554`). With `context: true` a successful LightRAG answer
  carries the Hindsight context block beside its citations.

## Failure and fallback

On the LightRAG plane a failed query is retried under the plane's retry
policy. If it still fails, or the LightRAG breaker is open, the answer
falls back to Hindsight recall (`lightragFallback`, `docs-search.ts:895-921`):

- The reply is Hindsight-sourced: `backend: "hindsight"`,
  `fallback: "hindsight"`, `degraded: true`, and `reason` names the LightRAG
  failure. Its notice reads "Served from Hindsight fallback: <reason>."
  (`hindsightFallbackReply`, `docs-search.ts:617-626`).
- A warning event `docs search failed: <reason>` carries
  `fallback: "hindsight"` (`docs-search.ts:908-917`).
- A degraded reply is never cached (`docs-search.ts:144`).
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

## Proof

Isolated: unit tests against in-process fakes, and `bun run smoke:docs`
(`scripts/docs-smoke.ts`) against a twin started with
`rehearsal up --ragflow-fixture` — a loopback fake RAGFlow with scriptable
timeout/error-code/malformed modes, run-dir manifest and fixture registry
(see `docs/rehearsal.md`). Live (operator-approved, explicitly not run here):
the five gated steps in `docs/rehearsal.md`.
