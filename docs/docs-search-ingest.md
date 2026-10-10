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
| CLI | `substrate docs ingest --dataset NAME --path PATH --source-url URL [--commit C] [--heading H] [--session I]` | via the route |

`datasets` names configured datasets; unknown names are ignored and raw
ids are never accepted. `dataset` on ingest names one configured dataset.

## Citation shape

Each `docs_search` result carries `{title, source_url, heading_path,
commit, snippet, score, document_id, chunk_id}` where every text field is
redacted — `snippet` additionally capped at 1,200 characters — `commit`
falls back to the dataset version pinned at ingest time (and names the gap
when nothing is pinned yet), and callers cite `source_url`, never the
chunk. The reply carries an untrusted-docs notice; one `note` event
(`payload.action: "docs.search"`) lists the returned URLs; any error
yields `{chunks: [], degraded: true, reason}` — never a throw inside an
agent's turn. At most 10 results, each retrieved over explicit
`dataset_ids` with `page_size <= 10`.

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
upload, and always send `{source_url, commit, heading_path}` metadata. A
replacement reports the superseded document id for the G3 retire step; the
delete path is unverified, so the id is exposed rather than a guessed
endpoint called. Records persist across restarts in
`SUBSTRATE_DOCS_STATE_FILE` when set (hashes and ids only); without it
they stay process-local. Parse budget is thirty polls two seconds apart.

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
and keeps the last five versions per dataset.

### Skills-sync degradation

The Phase 22 sync unit is not yet live, so no fast-forward evidence
exists. Until the first real fast-forward, the `agent-skills` refresh
emits one `warning` (`payload.action: "docs.ingest"`, reason
`skills-sync-not-live`) and search serves `agent-skills` from its last
pinned version with `pin_age_ms` on those citations. No silent staleness:
the pin age travels in the reply. The hook lives in the sync tick's
projection step (`noteSkillsSyncFastForward`) — no new timer, no new
surface. When the operator flips the sync unit live, no code change is
needed.

## Credentials

`RAGFLOW_URL` / `RAGFLOW_API_KEY` live only in the server env file
(`/etc/substrate/substrate.env`); `substrate-mcp` reads them starting
this phase. `RAGFLOW_MCP_URL` names the MCP transport this plane
deliberately does not use and is never read here. No command in this doc
prints a credential value.

## Rehearsal

Every behavior above is proven against the recording fake
(`packages/mcp-server/src/ragflow-fake.ts`): explicit-`dataset_ids`,
`<= 10` results, citation shape, redacted snippets, untrusted framing,
URL-listing event, empty-plus-reason errors, all six refusals, image
stripping, hash idempotency, resolve-by-name, create-on-miss with the
pinned model, and both degradation arms. The fake fails any retrieval
missing `dataset_ids`. Live proof (first probe, discovery/creation, real
ingest, real served search) is operator-gated — see
`docs/runbooks/docs-proof.md`.
