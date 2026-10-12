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
| `agent-substrate` | `README.md`, `docs/`, `.planning/PROJECT.md` of this repo | merge to `main`, then `substrate docs refresh --dataset agent-substrate --commit SHA --dir <checkout>` |
| `programming-desk` | `docs/`, `skills/`, `contracts/`, `ARCHITECTURE.md`, `prompts-assembled/` of `swcstudiospace/programming-desk` | merge of that repo, then `docs refresh` against its checkout |
| `agent-skills` | every `SKILL.md` and `references/` in `swcstudiospace/agent-skills` | `substrate-skills-sync` after a fast-forward: the tick posts the corpus itself |
| `<product>` (`kanbanos`, `desklanes`, `clippyos`, `auctioning`) | that repo's docs | merge of that repo, then `docs refresh` against its checkout |

Embedding: TEI `bge-small`; no chat model is registered; retrieval only.
Discovery is by name and creation happens only on a name-miss.

The refresh travels only through `POST /docs/ingest`, every call carrying
`refresh: {id, part, parts, trigger}` with trigger `repo-merge` or
`skills-sync`. Parts upload and parse independently, but the pin advances
only when every part of the id is staged with its resolved page
identities (URL, document id, sha frozen at receipt): a failed, missing
or changed part keeps the prior pin, and the same commit never mints a
second generation. Each promotion records the whole-corpus manifest —
every served document id — and keeps the last five versions per dataset.
`docs_search` cites the pin commit only for chunks from the pinned
documents; stale, replaced or id-less chunks name the gap instead of a
false current. (The route and the MCP tool forward the `refresh` object
through validation; malformed metadata is refused before any plane call,
with a warning and nothing staged.)

The CLI reads a checkout's committed objects only (markdown under the roots
from the `--commit` literal; symlinks, over-cap blobs and unreadable objects
refuse the run before anything posts; calls packed by serialized wire size
under 5 MB so escaping cannot overshoot the intake; `--dir` must sit on
`--commit`) and the sync tick reads the library corpus from the merged commit
itself (`rev-parse` equality, `ls-tree`/`cat-file` on the commit literal,
never working-tree reads) after the projection. No caller numbers versions
and no path touches RAGFlow directly. Pins, the sync tracker and unfinished
`SUBSTRATE_DOCS_STATE_FILE` beside the ingest records (one atomic
snapshot), so a restart rebuilds truthful pins and resumes staging
instead of serving from an empty map.

### Skills-sync degradation

The sync goes live only on a completed `skills-sync` refresh posted from
the substrate surface; every other ingest — however committed — only
promotes pins. Until then the `agent-skills` dataset serves its last
pinned version with `pin_age_ms` on those citations and one `warning`
(`payload.action: "docs.ingest"`, reason `skills-sync-not-live`). A
failed refresh stays visible the same way and never marks the sync live
or advances the pin. No silent staleness: the pin age travels in the
reply. The tick needs a bearer (`SUBSTRATE_TOKEN_SUBSTRATE`, falling back
to `SUBSTRATE_TOKEN`) and the server needs `agent-skills/` in
`SUBSTRATE_DOCS_INGEST_ROOTS`; without either the refresh refuses loudly
and the dataset keeps serving its pin.

## Credentials

`RAGFLOW_URL` / `RAGFLOW_API_KEY` live only in the server env file
(`/etc/substrate/substrate.env`); `substrate-mcp` reads them starting
this phase. `RAGFLOW_MCP_URL` names the MCP transport this plane
deliberately does not use and is never read here. No command in this doc
prints a credential value.

## Rehearsal

The recording fake (`packages/mcp-server/src/ragflow-fake.ts`) exercises
explicit dataset IDs, the result cap, citations, redacted snippets, untrusted
framing, URL-event readback, degraded errors, ingest refusals, stripping,
idempotency, name resolution, retained manifests and skills-sync degradation.
It rejects retrieval without explicit dataset IDs. Discovery/creation on
the deployed plane is the operator's G2 step, not implicit creation by the
agent-facing ingest tool; see `docs/runbooks/docs-proof.md`.

## Repeatable proof

Use a fresh named harness for each proof cycle; `down` removes that cycle's
stores, processes and manifest. The shipped command exercises the rehearsal
paths listed below through the actual twin (`scripts/docs-smoke.ts`).

```sh
bun run rehearsal up --name <owned> --port 0 --ragflow-fixture
bun run smoke:docs -- --name <owned>
bun run rehearsal down --name <owned>
```

The smoke reads the named run directory's `state.json` and `consumer.env`
only — never the inherited environment and never the plane key — and
refuses (exit 2) with zero effects unless the run has the stand-in
enabled and ready, holds an operator bearer, serves loopback off the
production ports, matches the recorded twin and stand-in identity (ports,
endpoint, checkout, and both pids re-verified against reuse), and runs
from the recorded checkout. It then exercises explicit-`dataset_ids`
search over REST and MCP with `<= 10` truthful citations (exactly 10
served from a pool over ten, redacted snippets `<= 1200`, source URLs,
pin-or-gap commits with the pin bound to the promoted commit — selected
by source URL plus the new generation's own prose, never by commit match
— and stale chunks naming the gap, untrusted framing, URL-event readback,
dataset scoping), degraded empty-plus-reason on an injected retrieval
failure, the six ingest refusals with exact reasons and locator-only
warnings (redactor with both rule names, no-source-URL, outside-roots,
over-cap page and call, anonymous 401 on REST and at the MCP transport,
VM guest via the CLI preflight) plus resolve-by-name refusal of unknown
and raw-id datasets, remote-image stripping, hash idempotency, the 1 MB /
5 MB / 6 MB payload limits on each caller, version-pin promotion across
generations through the real server and CLI producer (committed-bytes-only
refresh, newly committed bytes served, untracked/dirty exclusion,
same-commit-no-second-generation, superseded chunks naming the gap,
last-five manifest retention proven exact against the bound own-state file
on a second dataset), multipart retention (a missing, failed, or
conflicting part keeps the old pin), skills-sync-not-live (pinned serve
with pin age plus exactly one warning), and the stand-in parse arms — on
its own tagged scratch session, clearing injected fixture controls in a
`finally` and cleaning its scratch checkout in a `finally`. Exit 0 means
every check passed, 1 a check failed. Output carries names, booleans,
counters and hashes only. Explicitly unproven here: server-side VM-guest
over REST (a whole-process config door limit, not a request marker; the
client side is proved via the CLI preflight), and live G1-G4
(operator-gated to a human MODEL on the real plane, see
`docs/runbooks/docs-proof.md`). No `dry_run`, RAG-manifest rebuilding, or
physical-deletion surface exists or is assumed.
