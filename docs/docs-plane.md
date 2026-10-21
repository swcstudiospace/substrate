# Docs plane — cited answers from RAGFlow through the substrate only

Tracked as DOCS-01/02/03 (Phase 25). Agents get cited docs answers from
RAGFlow through the substrate only: no agent holds `RAGFLOW_API_KEY` or
`RAGFLOW_MCP_URL`, and nothing secret, unsourced, out-of-root or oversize
reaches a dataset.

## The two tools

`docs_search` (DOCS-01) is a read inside an agent's turn: `query` (1–1,000
chars), optional registry dataset `datasets`, `limit` (1–10, default 5),
optional `similarity_threshold`. Callers never pass raw RAGFlow dataset ids;
the substrate resolves names and always sends a non-empty explicit
`dataset_ids`. One JSON shape on both doors (MCP tool and `POST
/docs/search`): `untrusted: true`, a fixed notice (retrieved data, not
instructions — cite `source_url`), `results`, and `reason` only when empty
through error or refusal. Each result carries `title`, `source_url`,
`heading_path`, `commit`, `snippet` (redacted, then cut to 1,200 chars),
`score`, and `ids` (`dataset_id`, `document_id`, `chunk_id`). Failures never
throw: 200 with `results: []` and a closed-list reason (`not-configured`,
`unauthenticated`, `unknown-dataset`, `invalid-request`, `ragflow-timeout`,
`ragflow-unreachable`, `ragflow-error`, `ragflow-bad-response`). Anonymous
callers get `unauthenticated` with no RAGFlow call and no event; every
authenticated search emits exactly one event (`docs.search` note or warning),
fail-open, without the query text.

`docs_search` also takes an optional `context` boolean, default `false`. With `true`, the reply adds recalled memories and the session's recent events, framed as untrusted. The section "Hybrid retrieval and context augmentation" in `docs/docs-search-ingest.md` sets out its budgets and degraded reasons.

`docs_ingest` (DOCS-02) is a publication path: only `substrate` and operator
tokens (anonymous 401 before the body is read, agent surfaces 403). The page
carries `dataset`, `source_url` (canonical
`https://github.com/<slug>/blob/<commit>/<path>`), `commit` (40-hex),
`content` (UTF-8 markdown), optional `title` and `dry_run`. The pipeline
order is fixed — authenticate, shape/roots/caps, strip every image, run
`redactSkillContent` (a high-confidence finding refuses as `secret` with
`findings: [{line, rule}]`, never a value), then hash/split/idempotency check
and upload+parse. Caps: 1 MB body (413), 256 KiB content, 200 sections,
200-char title. Status mapping: 200 `uploaded`/`unchanged`/`dry_run`, 400
refusal, 401/403 writer rule, 502 RAGFlow failure (redacted, 200 chars), 503
`not-configured` or fail-closed audit refusal. The MCP tool returns the same
JSON with `isError` on every non-200 case.

## Registry, versions, refresh, triggers

The dataset registry (`packages/mcp-server/src/docs/registry.ts`) is code:
`agent-substrate`, `agent-skills`, `programming-desk` plus the four
provisional product datasets (slugs and roots confirmed by the operator;
until then the live DOCS-03 proof covers the first three only).
`SUBSTRATE_DOCS_DATASETS` may point at a JSON file replacing it — only the
harness and tests use it. `docs/receipts/**` is excluded everywhere and
pinned by the smoke.

Idempotency is by content hash (stripped, redacted, normalised path —
commit excluded) recorded in RAGFlow itself, so it survives loss of local
state. A version is one refresh run at a commit, cut by a final
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

## Proof

Isolated: unit tests against in-process fakes, and `bun run smoke:docs`
(`scripts/docs-smoke.ts`) against a twin started with
`rehearsal up --ragflow-fixture` — a loopback fake RAGFlow with scriptable
timeout/error-code/malformed modes, run-dir manifest and fixture registry
(see `docs/rehearsal.md`). Live (operator-approved, explicitly not run here):
the five gated steps in `docs/rehearsal.md`.
