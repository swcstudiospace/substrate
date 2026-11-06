# Runbook — LightRAG storage topology, operator preflight and upgrade design

| | |
| --- | --- |
| Scope | Where LightRAG keeps its state when it is hosted as the docs plane, what an operator checks before the first ingest, and how an upgrade or an embedding change is done |
| Phase | 56 |
| Status | Decision record plus operator checklist. Nothing here is run by an agent. Every live step is OPERATOR-GATED |
| Untouched | The RAGFlow plane, the phase 46 parity gate (T4, T5), `DELETE /documents` (never used), every Railway service |

Evidence labels. **Repo** means read in this repository. **Upstream** means
read in the LightRAG source at tag v1.5.7 (`env.example`,
`lightrag/kg/__init__.py`, `lightrag/api/utils_api.py`,
`lightrag/api/routers/document_routes.py`, `lightrag/api/config.py`,
`lightrag/api/lightrag_server.py`), or in the release notes at
https://github.com/HKUDS/LightRAG/releases. **Railway** means a fact the
orchestrator read through the Railway API on 2026-10-26, read-only; this
runbook's author did not re-read it. **UNVERIFIED** means nobody read it.

## Facts that frame the decision

- Railway, project "Agent Substrate", production: Hindsight 0.9.1 (api,
  worker, control-plane), TEI cpu-1.8, one Postgres service
  (`railwayapp-templates/postgres-ssl:18`), a tailscale-forwarder and two
  `ragflow-oauth` function services. No LightRAG service exists in any
  project, and the RAGFlow service was deleted on 2026-10-25. Which services
  use the Postgres service is UNVERIFIED.
- Railway, project "Ultrathink", production: a Timescale service
  (`timescale-postgis-ssl:pg16-ts2.13`, 500 MB volume), GreptimeDB v1.1.4
  (500 MB volume), Dragonfly (image tag `latest`, 5000 MB volume) and an
  object bucket named `ledger-archive`.
- Repo: `docs/data-planes.md` carries the owner decision of 2026-09-26 that
  Dragonfly is a cache, not a queue, and `packages/mcp-server/src/cache.ts`
  states that nothing in it survives a restart (header, lines 1-34).
- Repo: the client never names a storage backend, a workspace, an embedding
  model or a dimension. The only LightRAG env names it reads are
  `LIGHTRAG_URL`, `LIGHTRAG_API_KEY` and their `SUBSTRATE_`-prefixed
  hosting-layer overrides (`packages/mcp-server/src/config.ts:58-63`,
  `131-142`). Everything below is a setting of the **LightRAG server**, not of
  substrate-mcp.
- Upstream: the default storage is file-based (`JsonKVStorage`,
  `JsonDocStatusStorage`, `NetworkXStorage`, `NanoVectorDBStorage`,
  `env.example` 1347-1350). It is documented as the test deployment. On a
  Railway service without a volume that default is lost on every redeploy.

## Decision

**Recommended: Postgres-only LightRAG storage on a dedicated Postgres service
with pgvector, in project "Agent Substrate", reached only through the
Tailscale forwarder.**

| Server setting | Value | Verified against |
| --- | --- | --- |
| `LIGHTRAG_KV_STORAGE` | `PGKVStorage` | Upstream `lightrag/kg/__init__.py` `STORAGE_IMPLEMENTATIONS["KV_STORAGE"]` |
| `LIGHTRAG_DOC_STATUS_STORAGE` | `PGDocStatusStorage` | `STORAGE_IMPLEMENTATIONS["DOC_STATUS_STORAGE"]` |
| `LIGHTRAG_VECTOR_STORAGE` | `PGVectorStorage` | `STORAGE_IMPLEMENTATIONS["VECTOR_STORAGE"]` |
| `LIGHTRAG_GRAPH_STORAGE` | `PGTableGraphStorage` | Upstream `env.example` 1338-1346 and `STORAGE_IMPLEMENTATIONS["GRAPH_STORAGE"]` |

The three `PG*` class names were read in `lightrag/kg/__init__.py` at v1.5.7;
`/tmp/lightrag-up/env.example` names only `PGTableGraphStorage` and
`PGGraphStorage`, so the other three are confirmed from the registry file,
not from `env.example`. All four need `POSTGRES_USER`, `POSTGRES_PASSWORD` and
`POSTGRES_DATABASE` (`STORAGE_ENV_REQUIREMENTS`); host, port, pool size, SSL
mode and retry settings are `POSTGRES_*` names listed in upstream
`env.example` 1363-1412. Set them in the Railway service variables; no value
belongs in this repo.

Why this shape:

- `PGTableGraphStorage` keeps the graph in plain PostgreSQL tables and needs
  no Apache AGE: upstream `env.example` 1341-1346 says it runs on PostgreSQL
  14+ with no extension beyond what the vector store needs, and that the
  official `pgvector/pgvector:pg18` image is sufficient. `PGGraphStorage` is
  the only option that needs the AGE-bundled image. The v1.5.6 release notes
  introduce `PGTableGraphStorage` as the preferred PostgreSQL graph backend
  that replaces the AGE one.
- One database covers KV, doc status, vectors and graph, so there is one
  backup and one restore path (see "Volume, backup and restore").
- The state is durable ingest bookkeeping (the doc-status table records which
  documents parsed). Losing it forces a full re-ingest.

Vector index: upstream `env.example` 1373-1375 says to use `HNSW_HALFVEC`
for embeddings of 2000 dimensions or more, and that it needs pgvector 0.7.0
or newer. The upstream example embedding is `text-embedding-3-large` at 3072
dimensions (`env.example` 1238-1246), which is above 2000. Pick the
embedding first, then the index type (`POSTGRES_VECTOR_INDEX_TYPE`).
Whether the index build fails on 3072 dimensions with `HNSW` is UNVERIFIED.

### Options not chosen

**Dragonfly (`RedisKVStorage`, `RedisDocStatusStorage`).** Rejected. Owner
decision 2026-09-26: Dragonfly is a cache and holds nothing that must survive
a restart. LightRAG's KV and doc-status stores are durable ingest bookkeeping.
Upstream also offers no Redis implementation of the vector or graph stores
(`STORAGE_IMPLEMENTATIONS`), so Redis could not be the only backend anyway.
`cache.ts` and `CACHE_CLASSES` stay closed to this use.

**The Timescale service in project "Ultrathink".** Rejected, for three reasons
that are verified or Railway-reported: it is the substrate coordination index,
and a docs-plane ingest or a vector rebuild must not share its failure
domain; its volume is 500 MB; and the owner decisions keep the data planes
separate (`docs/data-planes.md` topology table). pgvector availability on
this image is unverified; check
`select * from pg_available_extensions where name = 'vector'` before any
decision that depends on it. That check does not change the first three
reasons.

**Reusing the existing Postgres service in project "Agent Substrate"
(`postgres-ssl:18`).** An option that needs the owner's decision. What is
known: it is a Railway Postgres 18 service. What is UNVERIFIED: which
services use it, whether the `vector` extension is available there (run the
`pg_available_extensions` query above), its volume size and its headroom.
Risks to weigh if the owner chooses it:

- a shared failure domain with whatever already uses it (a long vector index
  build or a re-ingest competes for IO and connections);
- a shared connection limit, since upstream's pool defaults to
  `POSTGRES_MAX_CONNECTIONS` 25 (`env.example` 1369);
- a `CREATE EXTENSION vector` on a database another service owns, which is a
  change to that service;
- a restore of this database now also restores or discards the other tenant's
  data.

Use a separate database at minimum, and a separate service unless the owner
decides otherwise. Hosting cost for a new service needs cost approval (see
preflight).

## Isolation and identity settings

**Workspace.** `WORKSPACE` is a server-level setting for all storage types
(`lightrag/api/config.py` 479-482; `env.example` 1329-1334). The valid
characters are `a-z`, `A-Z`, `0-9` and `_`. Upstream does not reject other
characters: it logs a warning and rewrites each one to `_`
(`config.py` 977-986), so two different names can collapse to one. Choose
names that already satisfy the constraint, for example `docs_v1`. The client
sends no workspace (repo: `planes/lightrag.ts` sends none), so the workspace
is selected only by which server process, with which `WORKSPACE`, the
`LIGHTRAG_URL` points at. Whether upstream also accepts a per-request
workspace header is UNVERIFIED: no such header appears in the config or
server files that were read.

**Embedding model and dimension are locked to the data.** Set
`EMBEDDING_BINDING`, `EMBEDDING_MODEL` and `EMBEDDING_DIM` once, before the
first ingest. Changing the model or the dimension invalidates every stored
vector. The rule: re-ingest everything into a **new workspace**, verify, then
switch. Never change the embedding in place on a populated workspace. How
upstream reacts to a mismatch (error at startup, silent bad recall, table
migration) is UNVERIFIED for PostgreSQL; the v1.5.3 release notes say only
that an existing **Milvus** deployment is auto-migrated once, on the next
`initialize_storages()`, into a model-suffixed collection, and that note does
not cover PostgreSQL. Do not assume it does.

**Pin the image.** `.env.example` used to name
`ghcr.io/hkuds/lightrag:latest`. Never deploy `latest`: a redeploy would move
the server version under a populated store. Pin an explicit version tag, or a
digest, matching the version recorded in the preflight. v1.5.7 is the version
the client contract was written against
(`packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json`,
being added in phase 56). The exact tag name published on `ghcr.io` for
v1.5.7 is UNVERIFIED; read it from the registry before pinning.

## Authentication and exposure

- Authenticate with `LIGHTRAG_API_KEY` on the server and the `X-API-Key`
  header on the client (`utils_api.py` 404-418 and 479-495; upstream
  `env.example` 160-163). The substrate client sends that header only.
- **The JWT bearer pitfall.** The server parses an `Authorization: Bearer`
  header as a JWT *before* it looks at `X-API-Key` (`utils_api.py` 427-468).
  A bearer value that is not a valid token makes `validate_token` raise 401
  (`lightrag/api/auth.py`, `validate_token`), and the dependency re-raises
  any 401 (`utils_api.py` 469-473). The API key in the same request is never
  consulted. Before phase 56 the client sent the key in both headers
  (`planes/lightrag.ts:184`, repo at the time of writing). Do not send the key
  as a bearer; the `.env.example` comment was corrected to match. Whether the
  pre-change client was failing against a key-protected v1.5.7 server is
  UNVERIFIED; it was not exercised.
- **`WHITELIST_PATHS`.** The upstream default is `/health,/api/*` (`config.py`
  847; `env.example` 164-178). `/api/*` is the Ollama-compatible route family
  (`/api/chat`, `/api/generate`, ...). Those routes call the LLM and read the
  knowledge base and stay unauthenticated even when a key is set. Upstream's
  own startup warning says so (`utils_api.py` 810-837) and
  recommends `WHITELIST_PATHS=/health`. Set it to `/health` at most.
- `/health` is a liveness probe that stays reachable; an unauthenticated
  caller gets only status, versions, `auth_mode` and `pipeline_busy`, and the
  full storage and model configuration only with a valid key
  (`lightrag_api_lightrag_server.py`, `/health` handler).
- Private reach only: no public TCP proxy and no public domain. The service is
  reached through the Tailscale forwarder like the other planes
  (`docs/railway-tailscale.md`, `docs/data-planes.md`). Bind and expose per
  upstream's rule: do not expose `0.0.0.0` without `LIGHTRAG_API_KEY` or
  `AUTH_ACCOUNTS` (`env.example` 11).
- A LightRAG started with the bypass LLM (`infra/railway/lightrag-llm-bypass.ts`)
  must set `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` on the substrate, because the
  graph modes (`hybrid`, `mix`, `local`, `global`) need a real LLM to build
  the knowledge graph they read.

## Volume, backup and restore

- Size the Postgres volume for the corpus. Vectors dominate: one row per chunk
  at the embedding dimension, plus the HNSW index. A number for this corpus is
  UNVERIFIED; measure it on the scratch workspace ingest and add headroom for a
  second full copy, because the upgrade path below holds two workspaces at
  once.
- Back up with `pg_dump -Fc` on a schedule the owner picks, to storage outside
  the Postgres service's own volume. The `ledger-archive` bucket is the
  ledger's; do not reuse it without the owner's decision.
- Restore drill, on a scratch database: `pg_restore` the latest dump, point a
  scratch LightRAG at it with the same embedding and workspace, and run the
  fixed query sample from "Upgrade and re-index design". A backup that has not
  been restored is not a backup.
- Because LightRAG state is derived from the docs in git (below), the last
  resort is a full re-ingest; the dump shortens recovery, it is not the only
  copy.

## Observability

- Liveness and readiness: `GET /health` (see above).
- Ingest progress and the destructive-job fence: `GET /documents/pipeline_status`
  returns a `busy` boolean, `job_name`, `docs`, `batchs`, `cur_batch`,
  `latest_message` and a recovery-fence projection
  (`document_routes.py`, `PipelineStatusResponse`, 1380-1420). `busy` is true
  while the processing loop or a destructive job runs. The phase 56 client
  reads `busy` as the signal that ingest is still running; an unrecognised
  shape is reported, not looped on.
- The phase 56 health probe feeds `planes.lightrag.ok` (before it, no LightRAG
  health call existed and the value was always null, `service.ts:6180`).
- `GET /health` for an authenticated caller also names the effective storage
  classes, the workspace, the LLM and the embedding model
  (`lightrag_api_lightrag_server.py`, `/health` handler, `configuration`
  block). Use that read, not a guess, to fill in the preflight below.

## Operator preflight checklist

HARD_STOP: none of this is run by an agent run. An operator runs it, in order,
and stops at the first failure. No step prints a key value; header values are
read from the server env file by name.

1. HARD_STOP: record the live `/openapi.json` of the deployed server and diff
   its routes and methods against
   `packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json`.
   Any route the client uses that is missing or changed blocks the cutover.
   `/openapi.json` is served only when API docs are enabled (upstream
   `ENABLE_API_DOCS`, v1.5.7rc2 release note; the default is UNVERIFIED), so
   enable it for the check or fetch it from a local run of the same image.
2. HARD_STOP: record the server version (the version fields `/health` reports to
   an unauthenticated caller; exact field names UNVERIFIED for `/health`) and the pinned image tag or digest. It must not be
   `latest`.
3. HARD_STOP: record the storage env values by name and class: the four
   `LIGHTRAG_*_STORAGE` names above, and the `POSTGRES_*` names present (never
   the values). Compare with the `configuration` block of an authenticated
   `/health`.
4. HARD_STOP: record the embedding binding, model and `EMBEDDING_DIM`, the
   vector index type, and the `WORKSPACE`. These are locked to the data.
5. HARD_STOP: record that `WHITELIST_PATHS` is `/health` (or narrower) and
   that `LIGHTRAG_API_KEY` is set.
6. HARD_STOP: confirm `DELETE /documents` is never used. It is the clear-all
   route (`document_routes.py` 5749-5775: "Clear all documents from the RAG
   system"). The client denylists it, and per-document removal goes through
   `DELETE /documents/delete_document` with `doc_ids` (`document_routes.py`
   6186-6233). Superseded-document pruning stays off
   (`SUBSTRATE_DOCS_PRUNE_SUPERSEDED` unset) until a scratch delete has been
   verified.
7. HARD_STOP: first ingest goes into a **scratch workspace**, not the target
   one. Check that the ids the upload returns (`track_id`, not a document id;
   `InsertResponse`, `document_routes.py` 926-942) resolve through
   `GET /documents/track_status/{track_id}` to the documents that a later
   per-document delete would take. The ingest stores the id the upload
   returned as the record's `document_id` and later passes it to the delete
   (`docs-ingest.ts:1002-1058`); the pre-phase-56 client reads that id from
   `track_id` when no document id is present (`planes/lightrag.ts:237` and
   `452-458`). A `track_id` is not a document id, so confirm on the scratch
   workspace that the id the client stores is the one `delete_document`
   accepts before pruning is ever turned on.
8. HARD_STOP: the phase 46 parity gate (T4, T5) is unchanged and is run
   against the scratch ingest before any switch.
9. HARD_STOP: cost approval for the new Postgres service and the LightRAG
   service, and the owner's decision if the existing Postgres service is
   proposed instead.
10. HARD_STOP: `select * from pg_available_extensions where name = 'vector'`
    on the chosen Postgres returns a row, and the extension version meets
    0.7.0 if `HNSW_HALFVEC` is chosen.
11. HARD_STOP: after the operator has deployed the server (never by an agent),
    run the live smoke runner from the repo root with the target's
    `LIGHTRAG_URL` and `LIGHTRAG_API_KEY` in the environment:
    `bun packages/mcp-server/src/lightrag-smoke-run.ts --confirm-live [--json]`.
    It health-checks, proves an anonymous request is refused, ingests and
    queries one synthetic document, deletes only that document, and checks the
    clear-all denylist. Exit codes: 0 all checks passed, 1 a check failed
    (`unauthenticated-access-allowed` means the server needs an API key),
    2 usage or config (no `--confirm-live`, no `LIGHTRAG_URL`), 3 unreachable.
    `--no-auth-expected` skips only the anonymous check, for a deliberately
    keyless server, and the output warns about it.

## Upgrade and re-index design

Design only. Nothing in this section is built or run.

**Principle.** LightRAG state is derived. The sources are the docs in git
(the `docs_ingest` roots) and the planning scrape (`.planning/` pages). A
LightRAG version upgrade, a storage change or an embedding change is therefore
the same procedure: build a new workspace or instance from source, verify it
against the old one, switch, keep the old one for a retention window.

**What `docs_ingest` gives that procedure (repo, read).**

- Uploads are idempotent by content hash, keyed by dataset plus source URL,
  with per-page in-flight locks (`packages/mcp-server/src/docs-ingest.ts`
  header, lines 15-17). The LightRAG record key is
  `lightrag::<dataset id>::<source url>` (`docs-ingest.ts:661-669`).
- The hash is the sanitized body, plus the entities and relations of a
  planning page's graph hint, so a graph correction with unchanged markdown
  is a change (`changeSha`, `docs-ingest.ts:681-690`).
- The state file (`SUBSTRATE_DOCS_STATE_FILE`) is version 2: the records and
  the per-dataset version lists. It is written to a temporary name and
  renamed into place (`saveIngestRecords`, `docs-ingest.ts:1187-1197`). A
  missing or corrupt file loads as empty tables, never a throw, and the cost
  of lost dedup is a duplicate upload (`loadIngestRecords`,
  `docs-ingest.ts:1124-1150`, comment at 1102-1112). So an interrupted ingest
  resumes: pages already recorded as stored are `unchanged` on the next run
  and are not uploaded again.
- A page's record is written only after the upload, the parse start and the
  parse poll have all succeeded (`docs-ingest.ts:1002-1058`), so a page that
  did not finish is retried. Whether a crash between the server's acceptance
  and the record write produces a duplicate upload is UNVERIFIED.
- Planning pages are re-scanned by the server's planning refresh
  (`Substrate.runPlanningRefresh`, `service.ts`), which keeps one hash per
  page. With `SUBSTRATE_PLANNING_HASH_STORE=on` those hashes are stored, so a
  restarted server resumes from them. With it off they live in memory only,
  and a restart re-indexes every planning page.

**Consequence the operator must plan for.** The record table says `unchanged`
for every page it has stored. The client sends no dataset id and no workspace
to LightRAG (`planes/lightrag.ts`), so a new workspace at the server is
invisible to the state file. Re-ingesting into a new workspace with the old
state file uploads **nothing**. Point `SUBSTRATE_DOCS_STATE_FILE` at a new,
empty path for the re-ingest, or the check passes against an empty workspace.
Also: upstream rejects a same-name upload with HTTP 409 rather than reporting
a duplicate (`InsertResponse` docstring, `document_routes.py` 930-934), which
matters when an ingest is retried against a populated workspace; how the
client maps that 409 is UNVERIFIED.

**Procedure (dry-run first, each step operator-gated).**

1. Dry run: list the sources the ingest would send, and their count, from the
   scan (`scanIngestPages`, `docs-ingest.ts:122`) without calling LightRAG.
   Record the count and the corpus hash. (An offline docs-ingest dry-run
   switch is UNVERIFIED; the offline `bun run docs:golden` harness proves the
   search pipeline, not an ingest.)
2. Stand up the new instance or workspace: a new `WORKSPACE` value on a new
   service (or the same service restarted, but then rollback needs the old
   env kept), the new version pin, the new embedding if that is the change,
   and the same four storage classes. Run the preflight checklist against it.
3. Re-ingest from source into the new workspace with a fresh
   `SUBSTRATE_DOCS_STATE_FILE`, using the existing resumable `docs_ingest`.
   Interrupt-and-resume is safe by the idempotency above. Watch
   `pipeline_status.busy` until it is false and `/documents/track_status`
   shows no failed documents. Failed documents are re-run with upstream's
   `POST /documents/reprocess_failed` (`document_routes.py` 6661); client use
   of it is UNVERIFIED.
4. Verify parity: run `docs_search` on a fixed query sample (the golden
   questions, plus a sample drawn from real `docs.search` events) against the
   old and the new workspace. Compare cited source URLs per query, using the
   same scorer as `bun run docs:golden`. The acceptance threshold (for
   example recall against the old workspace) is the owner's to set; none is
   specified here.
5. Switch: change `LIGHTRAG_URL` (and `LIGHTRAG_API_KEY` if the instance
   changed) for substrate-mcp, or repoint the forwarder, and restart per the
   usual deploy runbook. Keep the **new** state file as the live one. The
   docs-search cache is keyed to a docs generation counter
   (`gen:docs`, bumped on ingest); confirm that the switch does not serve a
   stale cached answer (UNVERIFIED: whether a URL change alone bumps it).
6. Retention: keep the old workspace, its state file and its latest dump for
   a window the owner sets. Do not run `DELETE /documents` on it, ever; retire
   it by dropping the old workspace's tables, or the old database, by an
   operator, after the window.

**Rollback.** Switch back: restore the old `LIGHTRAG_URL`, key and the old
state file, and restart. This works only while the old workspace is intact,
which is why retirement waits for the window. If the old workspace was altered
in place (do not do that), the rollback is a restore from the last `pg_dump -Fc`.

**Upstream notes that bear on an upgrade (release notes, read on
2026-10-26):**

- v1.5.3: an existing Milvus deployment is migrated once, automatically, at
  the next `initialize_storages()`, with extra startup time on large
  collections. Not applicable to the PostgreSQL topology chosen here.
- v1.5.6: introduces `PGTableGraphStorage` as the preferred PostgreSQL graph
  backend, replacing the AGE-based `PGGraphStorage`.
- v1.5.7rc2: adds an offline tool to migrate a graph from Apache AGE to
  PostgreSQL tables (PR 3620). Only relevant to a deployment that began on
  `PGGraphStorage`; this topology starts on `PGTableGraphStorage`.
- Whether any release changes the schema of the `PG*` tables, the document-id
  derivation, or the chunking in a way that requires a re-index is UNVERIFIED
  for versions other than those named. Treat every minor-version bump as a
  re-index until a release note says otherwise.

## The LLM proxies (why LightRAG runs on a bypass LLM today)

LightRAG needs a real LLM for the graph modes. Today it runs with the bypass
LLM (`infra/railway/lightrag-llm-bypass.ts`) because no LLM the host holds a
login for is reachable from Railway. What the VPS has, read on the host
(not re-verified by this runbook's author), all on loopback:

1. `shunt`, `127.0.0.1:3001`, Anthropic-compatible `POST /v1/messages`.
   Claude routes pass the caller's credential on to Anthropic, so a dummy key
   answers 401 `invalid x-api-key`: reachable, not authenticated. Grok routes
   use a stored xAI OAuth session; when that session is dead the answer is a
   401 naming `invalid_grant` and `shunt login xai`.
2. `aio-grok-proxy`, `127.0.0.1:41417`, Anthropic-compatible
   `POST /v1/messages`. It ignores the client key and uses the host's
   SuperGrok session: model `grok-4.6` with a dummy `x-api-key` returned 200
   with a text answer. This is the one path that works today. A non-Grok model
   name is forwarded to Anthropic and answers 401.
3. `hermes proxy`, planned on `127.0.0.1:8645`, xAI OpenAI-compatible
   `POST /v1/chat/completions`. It is not running (it needs
   `hermes auth add xai-oauth --type oauth`), so a connection is refused.

Check them any time, from the repo root on the VPS. It sends one 8-token
request per proxy with a dummy key and prints one state per provider
(`ok`, `unauthenticated`, `unreachable`, `invalid`), never a key or a body:

```sh
bun scripts/llm-proxy-smoke.ts [--json] [--only <name>]...
```

Exit 0 when at least one provider is `ok`, 1 when none is, 2 on a usage
error. The probes are `shunt` (a Claude route), `shunt-grok` (a Grok route on
the same port), `aio-grok-proxy` and `hermes`. `LLM_PROXY_SHUNT_URL`,
`LLM_PROXY_AIO_GROK_URL` and `LLM_PROXY_HERMES_URL` override a base URL;
an `http:` URL to a non-loopback host is refused before any request, so the
dummy key never goes to a remote cleartext host. `LLM_PROXY_DUMMY_KEY` and
`LLM_PROXY_TIMEOUT_MS` (default 20000) are the other settings; all five are in
`docs/config-reference.md`.

**Why Railway cannot use them.** All three listen on the VPS's loopback. The
Tailscale forwarder carries traffic one way, from the VPS to Railway services
(`docs/railway-tailscale.md`), not from Railway to the VPS. Exposing a proxy
publicly to close that gap would be a security hole, not a workaround:
`aio-grok-proxy` ignores the client key, so anyone who can reach it spends the
operator's SuperGrok subscription login.

**What a real LLM for LightRAG takes (two steps, both operator work).**

1. A live login on the host: `shunt login xai` and/or
   `hermes auth add xai-oauth --type oauth`. Re-run the smoke until a provider
   reports `ok`. `aio-grok-proxy` already does.
2. A deliberate network path from the Railway LightRAG service to that proxy.
   This needs a design decision (for example an authenticated, private path
   that does not publish the login) and is not made here. Until then LightRAG
   keeps the bypass LLM and the substrate keeps `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive`.

## Related

- `docs/docs-plane.md` — the client contract and the failure and fallback path.
- `docs/data-planes.md` — topology, owner decisions, forwarder reach.
- `docs/runbooks/docs-proof.md` — the RAGFlow-era operator gates; the phase 46
  parity gate (T4, T5) lives with the cutover plan.
