# Phase 7 Recall + Phase 8 Hot cache: external contracts

Research only, 2026-09-26. No repo edits, no installs, no calls to the owner's Railway services, `/etc/substrate/substrate.env` not read. Anything not seen directly in source or docs is marked **[INFERENCE]**.

**Citation keys**

| Key | Source | Pinned at |
|---|---|---|
| `am:` | github.com/rohitg00/agentmemory | tag **v0.9.29** = commit `2d38dafede67d0d4ed920cde94d2106e98825b8a` (lightweight tag, 2026-08-16) |
| `am@0.9.28:` | same repo | tag v0.9.28 = commit `6761a99ba1e609a9e2e4d5fda54e4b126def0a42` |
| `iii:` | github.com/iii-hq/iii, the engine that serves agentmemory's HTTP | tag `iii/v0.11.2` = commit `2b445957701f94dc5f56f900af314e9d59f3b0f7`. Agentmemory pins this version: `am:deploy/railway/Dockerfile:1-9`, `am:package.json:68` |
| `repo:` | this repo (agent-substrate), working tree on 2026-09-26 | — |
| `dragonfly@40553fd:` / `helio@ee6ed2c:` | dragonflydb/dragonfly and its vendored helio (§6) | Dragonfly tag **v2.0.0** = commit `40553fd842c2850b65787ed4da908d95aeab8834`, released 2026-09-16; helio `ee6ed2cde79b52d4a89cc75a9051f8e07e1e6b7f` |
| `bun@34cbb9a:`, plus the `V/J/F/C/T/D/CF` path keys in §7 | oven-sh/bun | tag **bun-v1.4.0** = commit `34cbb9a40b4bd1bd767d134a7065e66c2432a676`, the same build the host runs (`bun --revision` → `1.4.0+34cbb9a40`) |
| ioredis (§7.5) | redis/ioredis | tag v6.0.0 = commit `8ed2946504a36ae9b1e186b9dccc56afcd046d78` |

---

## 1. Agentmemory version surface

- **Latest release: v0.9.29, published 2026-08-16T13:56:45Z** (`gh release list -R rohitg00/agentmemory`). Earlier releases: v0.9.28 on 2026-07-19 and v0.9.27 on 2026-06-07. `main` has moved on without a release: `bcf4f0d` on 2026-09-26 is "perf(index): store vectors in fixed buckets…".
  - `am:src/version.ts:1`: `VERSION = "0.9.29"`
  - `am:package.json:3`
- **How a client reads the server version:**
  - `GET /agentmemory/health` → `.version`. Bearer-gated. `am:src/triggers/api.ts:266-298`, field at `:281`.
  - `GET /agentmemory/config/flags` → `.version`. Bearer-gated. `am:src/triggers/api.ts:245-252`.
  - `GET /agentmemory/livez` does **not** return a version. Its body is `{status, service, viewerPort, viewerSkipped, streamsPort}` (`am:src/triggers/api.ts:174-186`).
  - There is **no `/agentmemory/status` route**: none of the `api_path` values in `am:src/triggers/api.ts` is `status`. The CLI's `agentmemory status` combines `health`, `sessions`, `graph/stats`, `memories?count=true`, `config/flags` and `diagnostics/followup` (`am:src/cli.ts:1494-1501`), and reads `healthRes.version` (`:1509`).
- **The #817 isolation fix, and what actually shipped when.** Issue #817 is "AGENT_ID isolated scope not enforced on mem::search (REST /search, memory_recall, recall_context) → cross-agent memory leak". It is still **OPEN** on GitHub even though the fix shipped.
  - **v0.9.27** (commit `a6e22fa`, "v0.9.28 hotfix wave (#843, #825, #817, iii pin)", folded into 0.9.27 by `2515851`):
    - `mem::search` now applies the agent filter that smart-search already had.
    - Resolution order: an explicit `agentId` pins; `"*"` bypasses; isolated mode falls back to env `AGENT_ID`; with isolated mode on and no id from any source, the call **throws** instead of reading unscoped (fail-closed).
    - Search over-fetches whenever an agent filter is active.
    - The `recall_context` prompt also filters by agent.
    - Sources: `am:CHANGELOG.md:101`, `:131`. Code today is at `am:src/functions/search.ts:397-432`, `:474-475` and `:595`. Test added: `test/agent-isolation-search.test.ts` (+203 lines in `a6e22fa`).
  - **v0.9.28** (commit `6761a99`, #1057 "multi-agent memory leakage via /context"):
    - `mem::context` gets the same filter and fail-closed rule.
    - `api::context`, `api::session::start` and `event::session::started` now forward `agentId`.
    - Sources: `am:CHANGELOG.md:85`; code at `am:src/functions/context.ts:49-71`, `:167-179`. `git diff v0.9.27 v0.9.28` touches `context.ts`, `api.ts` and `events.ts`.
  - **v0.9.29** (commit `696cf7a`, #1205):
    - REST `/remember` now forwards `agentId`.
    - `memoryToObservation()` now carries `agentId` into the search shape. Before this, **every remembered memory was invisible to any agent-scoped search** (#1159, #1160, #1197).
    - Sources: `am:CHANGELOG.md:55`, `am:src/triggers/api.ts:1046-1048`, `am:src/state/memory-utils.ts:23-26`.
    - Verified against v0.9.28: `am@0.9.28:src/triggers/api.ts` forwards `project` but no `agentId`, and `am@0.9.28:src/state/memory-utils.ts` has no `agentId`.
  - **Still open in v0.9.29:** `POST /observe` drops `agentId` (#1159 is OPEN; the payload whitelist at `am:src/triggers/api.ts:317-324` has no `agentId`). An observation takes its `agentId` from the session row, or from env `AGENT_ID` when no row exists (`am:src/functions/observe.ts:157-171`).
- **Implication: the ROADMAP floor "≥ 0.9.28" is too low. The floor must be 0.9.29.** Phase 7 SC2 writes through `/remember` with `agentId=<surface>` and reads agent-scoped. On 0.9.28 the `agentId` is silently replaced by env `AGENT_ID` or dropped, and scoped recall returns 0 rows with no error (#1159 repro).

## 2. Agentmemory REST for a server-side client

**Transport and auth (all routes)**

- Base path: `https://<svc>.up.railway.app/agentmemory/*`. The Railway template exposes port 3111 behind Railway HTTPS (`am:deploy/railway/README.md:10-13`, `am:deploy/railway/railway.json:9`).
- **Bearer:** `Authorization: Bearer <AGENTMEMORY_SECRET>`. This is an exact-string compare, done as an HMAC-SHA256 timing-safe comparison (`am:src/auth.ts:6-10`). Only the header names `authorization` and `Authorization` are read.
  - Routes gated by middleware: `am:src/triggers/api.ts:147-166`.
  - Routes that check inside the handler: `:41-54`.
  - Both return **401 `{"error":"unauthorized"}`**.
  - With no secret configured, every route is open (`:45`, `:152`).
- **Railway secret gotcha:** the official entrypoint overwrites `AGENTMEMORY_SECRET` with the contents of `/data/.hmac`, generating that file on first boot (`am:deploy/railway/entrypoint.sh:80-96`). Setting the variable in Railway has no effect. The value appears once, in the first deploy log.
- **Body:** only a `Content-Type` containing `application/json` is parsed. Any other content type, or invalid JSON, yields `body = null`, which every route below rejects with 400 (`iii:engine/src/workers/rest_api/views.rs:384-402`).

| Route | Auth | Request (R = required) | Success response | Errors and notes |
|---|---|---|---|---|
| `GET /agentmemory/livez` | **none** (no middleware, `api.ts:187-191`) | — | 200 `{status:"ok", service:"agentmemory", viewerPort, viewerSkipped, streamsPort}` (`api.ts:174-186`) | Railway healthcheck path (`railway.json:9`). No version. |
| `GET /agentmemory/health` | bearer (middleware, `api.ts:294-297`) | — | 200, or **503 when `status=="critical"`** (`api.ts:273-274`). Body `{status:"healthy"\|"degraded"\|"critical", service, version, health: HealthSnapshot\|null, functionMetrics[], circuitBreaker, viewerPort, viewerSkipped, streamsPort}` (`api.ts:278-286`) | HealthSnapshot is `{connectionState, workers[], memory{heapUsed,heapTotal,rss,external}, cpu{…}, eventLoopLagMs, uptimeSeconds, kvConnectivity?{status,latencyMs?,error?}, status, alerts[], notes?}` (`types.ts:221-237`). It is refreshed every 30 s (`health/monitor.ts:96-100`). |
| `GET /agentmemory/config/flags` | bearer (`api.ts:195-196`, `:262`) | — | 200 `{version, provider, embeddingProvider:"embeddings"\|"none", flags[{key,label,enabled,default,affects,needsLlm,description,enableHow,docsHref}]}` (`api.ts:199-252`) | Confirms keyless mode (`provider`) and whether embeddings are on. |
| `POST /agentmemory/session/start` | bearer (middleware `api.ts:655`) | R `sessionId`, R `project`, R `cwd` (non-empty strings, `:604-614`); `title` (trimmed to ≤200 → `summary`/`firstPrompt`, `:615`, `:631-632`); `agentId` (≤128 chars, else env `AGENT_ID`, `:619-623`) | 200 `{session: Session, context: string}` (`:643-646`). Session is `{id, project, cwd, startedAt, status:"active", observationCount:0, summary?, firstPrompt?, agentId?}` (`:624-634`, `types.ts:1-15`) | 400 `{"error":"sessionId, project, and cwd are required non-empty strings"}`. The row is written with `kv.set` (`:635`), which replaces the whole value (`iii:engine/src/builtins/kv.rs:297-304`). Re-starting an existing id therefore resets `observationCount` and `startedAt`. Also runs `mem::context`, which **throws → 500** when isolated mode has no id (`:636-642`). **Only REST path that tags observations with a per-request agentId.** |
| `POST /agentmemory/session/end` | bearer (`:694`) | R `sessionId` (`:661-667`) | 200 `{success:true}` (`:685`) | Sets `endedAt` and `status:"completed"` (`:668-671`). Fires `event::session::stopped`, which summarizes, and consolidates when an LLM key exists (`:673-678`; `CHANGELOG.md:15`, `:58`). **An unknown id is upserted, not rejected:** `state::update` (`am:src/state/kv.ts:20-31`) creates a missing key as `{}` and applies the sets (`iii:engine/src/builtins/kv.rs:451-473`). That leaves a partial row `{endedAt, status}` with no `id` or `project` in the `sessions` scope, and 200 is still returned. So only end ids you started. |
| `POST /agentmemory/observe` | bearer (`:335`) | R `hookType`, R `sessionId`, R `project`, R `cwd`, R `timestamp` (strings, `:303-316`); optional `data` (any, `:323`). `hookType` is typed as HookType (`types.ts:139-151`) but only checked to be a string (`:318`). **No `agentId` field** (#1159) | **Always 201** with the function result (`:325-326`): `{observationId}` (`observe.ts:360`), or `{deduplicated:true, sessionId}` (in-process dedup, 5-min TTL: `dedup.ts:3`, `observe.ts:87-89`), or **`{success:false, error:"Session observation limit reached (500)"}`** (`observe.ts:147-154`; `MAX_OBS_PER_SESSION` defaults to 500, `config.ts:213`) | 400 `{"error":"hookType, sessionId, project, cwd, and timestamp are required strings"}`. `data` goes through the privacy filter (§4). agentId comes from the session row, else env (`observe.ts:157-171`). A session is created implicitly when missing (`:268-300`). Zero-LLM indexing: `title = tool_name\|hookType` (≤80), `narrative = prompt \| tool_input \| tool_output` **truncated to 400 chars** (`compress-synthetic.ts:79-101`). Tool fields are extracted only for `post_tool_use`, `post_tool_failure` and `prompt_submit` (`observe.ts:120-131`). **Poor fit for forwarding summaries.** |
| `POST /agentmemory/remember` | bearer (checked in handler `:1021-1022`; no middleware `:1057`) | R `content` (non-empty string, `:1023-1029`). Optional: `type` (`pattern\|preference\|architecture\|bug\|workflow\|fact`; anything else becomes `fact`, `remember.ts:50-60`), `concepts: string[]`, `files: string[]`, `ttlDays: number>0` (→ `forgetAfter`, `remember.ts:175-177`), `sourceObservationIds: string[]`, `project` (non-empty string, else 400, `api.ts:1030-1035`), `agentId` (trimmed to ≤128; body wins over env; `api.ts:1046-1048`, `remember.ts:147-150`; **0.9.29+ only**) | 201 `{success:true, memory: Memory, similarTo?: {id,title,similarity}}` (`remember.ts:230-241`). Memory is `{id:"mem_…", createdAt, updatedAt, type, title (first 80 chars of content), content, concepts, files, sessionIds:[], strength:7, version, parentId?, supersedes[], sourceObservationIds, isLatest, forgetAfter?, agentId?, project?, origin{channel:"agent",capturedAt}}` (`remember.ts:152-173`, `types.ts:102-125`) | 400 `{"error":"content is required"}` or `{"error":"project must be a non-empty string"}`. **201 `{success:false,error}`** when `files`, `concepts` or `sourceObservationIds` is not an array (`remember.ts:41-49`). **Supersession:** Jaccard > 0.7 against a latest memory in the same project (or an unscoped one) creates a new version, and removes the old version from BM25 and the vector index (`remember.ts:116-134`, `:179-190`). Writes are serialized under one global lock `mem:remember` (`:71`). **No privacy filter** on `content`. |
| `POST /agentmemory/search` | bearer (middleware `:486`) | R `query` (non-empty string, `:422-424`). Optional: `limit` (positive int, default 20, **max 100**; `:425-430`, `search.ts:387-394`), `project` (string, server-side filter), `cwd` (string, server-side filter), `format` (`full`\|`compact`\|`narrative`, default `full`), `token_budget` (positive int), `agentId` (body, else `?agentId=`; `api.ts:416-421`, `:460-474`) | 200 `{format, results, tokens_used, tokens_budget, truncated}` (`search.ts:641-688`). `full`: `[{observation: CompressedObservation, score, sessionId}]`. `compact`: `[{obsId, sessionId, title, type, score, timestamp}]`. `narrative`: `[{obsId, sessionId, title, narrative, score, timestamp}]` plus `text` | 400 for each bad field (`api.ts:422-455`). Throws → 500 (isolated mode with no id: `search.ts:420-432`). Ranking is hybrid (BM25 + vector + graph) when the vector index is populated, else BM25 only, and then `score` is a raw BM25 score (`search.ts:485-502`; `CHANGELOG.md:52`). CompressedObservation carries `id, sessionId, timestamp, type, title, narrative, facts, concepts, files, importance, agentId?` (`types.ts:64-83`). A remembered memory maps to `type:"decision"`, `narrative=content`, `concepts`, `agentId` (`memory-utils.ts:11-27`); **`project` is not in the result**. |
| `POST /agentmemory/smart-search` | bearer (checked in handler `:1192-1193`; no middleware `:1230`) | `query` **or** `expandIds` required (`:1194-1202`). `expandIds`: the first 20 of `string \| {obsId, sessionId}` (`smart-search.ts:132-140`). Optional: `limit` (**clamped to 1..100**, default 20, `:183`), `project` (**lessons only; does not filter results**, `:199-204`), `includeLessons` (default true, `:187`), `agentId` (explicit filter, `"*"` wildcard, `:109-117`), `sessionId` (drives the follow-up diagnostic only), `source`, or header `X-Agentmemory-Source` (`api.ts:1206-1221`) | 200 compact: `{mode:"compact", results:[{obsId, sessionId, title, type, score, timestamp}], lessons?:[{lessonId, content, confidence, score, createdAt, project?, tags[]}]}` (`smart-search.ts:212-219`, `:279-285`; `types.ts:284-301`). Expanded: `{mode:"expanded", results:[{obsId, sessionId, observation}], truncated}` (`:176`) | 400 `{"error":"query or expandIds is required"}`. 500 in isolated mode with no id (`:118-130`). **Compact results carry no content, agentId or concepts**, so reading `graph_id` needs a second `expandIds` call. `score` is the normalized RRF `combinedScore` (§3). |
| `POST /agentmemory/context` | bearer (`:399`) | R `sessionId`, R `project` (`:349-356`); `budget` (positive int, default `TOKEN_BUDGET`=2000, `config.ts:212`); `agentId` (body, else `?agentId=`, `:364-388`) | 200 `{context: "<agentmemory-context project=\"…\">…</agentmemory-context>" \| "", blocks, tokens}` (`context.ts:241-268`) | **Not query-driven.** It returns pinned slots, the project profile, ≤10 lessons, and the last 10 sessions of that project excluding `sessionId`, filtered by agent (`context.ts:73-179`). Not a recall API for `context_search`. |
| `POST /agentmemory/forget` | bearer (handler `:1068-1069`) | `sessionId` or `memoryId` required; `observationIds?` | 200, the `mem::forget` result | Useful as a retract path. 400 `{"error":"sessionId or memoryId is required"}` (`api.ts:1060-1084`). |

**Carrying `project`, agent, session ids and custom metadata**

- `project`:
  - Observations get it from their session row (`session/start` or the implicit create in `/observe`).
  - Memories store it as a top-level field.
- `agentId`: body field on `session/start`, `remember`, `search`, `smart-search` and `context`; `?agentId=` also works on `search`, `context`, `memories`, `observations` and `sessions` (`README.md:1372-1374`).
- Session ids are caller-chosen strings. Memories have `sessionIds: []`, and search sees them under the synthetic sessionId `"memory"` (`remember.ts:161`, `memory-utils.ts:14`).
- **There is no custom metadata or tags field on write** apart from `concepts[]`, `files[]` and `type`. `concepts` are BM25-indexed (`state/search-index.ts:235-246`) and come back in `full` results.
- A separate facet store exists: `POST /agentmemory/facets` `{targetId, targetType:"memory"|"observation"|"action", dimension, value}`, and `POST /agentmemory/facets/query` `{matchAll?|matchAny?: ["dim:value"], targetType?, limit≤50 default}`, which returns target IDs only (`functions/facets.ts:7-164`, `api.ts:3095-3114`).
  - Facet queries do not plug into search.
  - Every tag call does a full `kv.list` of all facets (`facets.ts:46`) [INFERENCE: O(n) per write].

**Limits, pagination, errors**

| Concern | Finding |
|---|---|
| Pagination | `search` and `smart-search`: `limit` only (≤100), with **no offset or cursor**. `GET /memories`: `?limit` (≤5000) and `?offset`, or `?count=true` (`api.ts:1960-1996`). |
| Max request body | **No cap in the HTTP layer.** The JSON body is collected unbounded (`iii:…/views.rs:384-402`); there is no `DefaultBodyLimit` in the router (`iii:…/api_core.rs:171-191`). The effective ceiling is the engine↔worker WebSocket frame of 16 MiB. Agentmemory guards responses at 15 MiB (`am:src/state/frame-guard.ts:1-6`); an over-frame payload "drops the worker and 404s every endpoint for ~1s" (`CHANGELOG.md:71`). **The substrate must cap its own forwarded payloads**; its REST cap is already 1 MB (`repo:packages/mcp-server/src/server.ts:32`). |
| Timeouts | `iii-http default_timeout: 180000` ms in the Railway config (`am:deploy/railway/entrypoint.sh:32`). The engine default is 30000 (`iii:…/rest_api/config.rs:17-19`). On expiry: **504** (`iii:…/api_core.rs:184-187`). Worker invocation timeout 180000 (`am:src/index.ts:204`). The client needs its own short deadline. |
| Concurrency | `concurrency_request_limit` defaults to 1024 (`iii:…/config.rs:21-23`), applied as `tower::ConcurrencyLimitLayer` (`api_core.rs:189-191`), which queues requests instead of rejecting them [INFERENCE from tower semantics]. |
| Rate limits | **None** in agentmemory (no 429 or rate limiter in `src/`; only provider code handles 429) and none in iii-http (config has only `middleware` hooks, `config.rs:26-45`). Any Railway edge limits are not documented here (Open questions). |
| Error shapes | Handler validation: `{error: string}` with 400, 401, 404 or 413. **Function throw → 500 `{"error": <message>, "error_id": <id>}`** (`iii:…/views.rs:704-721`). Middleware failure → 500 with the same shape, or 504 `{"error":"Middleware timeout"}` (`views.rs:217-237`). Some in-function validation errors come back as **201/200 `{success:false, error}`**, so clients must check `success`. |

## 3. Scoping semantics

- **The scope is set per server process.** `AGENT_ID` (trimmed, ≤128) and `AGENTMEMORY_AGENT_SCOPE` (`"isolated"` or anything else, which means `"shared"`) are read from the process env merged with `~/.agentmemory/.env` (`am:src/config.ts:316-346`).
  - **shared** (the default) tags writes with env `AGENT_ID` when a request supplies none, and does not filter recall by default.
  - **isolated** does the same tagging, and every recall path with no explicit id filters by env `AGENT_ID`. It throws (500) when no id resolves (`search.ts:410-432`, `smart-search.ts:108-130`, `context.ts:54-71`).
- **Each request can override the scope** with `agentId` in the body, or `?agentId=` where listed in §2.
  - **An explicit `agentId` filters in both modes**: `filterAgentId = explicit ?? (isolated ? env : undefined)` (`smart-search.ts:109-117`, `search.ts:411-419`).
  - `agentId:"*"` bypasses all filtering, including isolated mode.
- **How the filter works:** it runs *after* ranking, because the BM25 and vector indexes don't store `agentId`.
  - smart-search over-fetches `min(limit×3, 300)` (`smart-search.ts:189-210`).
  - `/search` over-fetches `max(limit×10, 100)` whenever any filter is on (`search.ts:474-475`, `:595`).
  - A narrow scope inside a large corpus can therefore return an underfilled page [INFERENCE].
- **Filtering by substrate metadata on the server:** there is **no generic metadata or tag filter**. What the server can filter on:
  - `agentId`, on every recall path.
  - `project` and `cwd`, **only on `/search`**:
    - Observations match on their session's `project` and `cwd`.
    - Memories match on their own `project`. A memory with **no project passes through** a project filter (`search.ts:538-568`), and `cwd` never applies to memories (`:564`).
    - smart-search ignores `project` for results (`smart-search.ts:199-204`).
  - So `surface` can be filtered on the server only if it *is* the `agentId`, and `repo` only if it *is* the `project` and the call uses `/search`.
  - `graph_id` has no server-side filter. Carry it in `concepts` (e.g. `graph:<id>`, which is BM25-indexed so a matching query also ranks higher) and in a header line of `content`, then filter on the client after over-fetching.
- **"Max 3 results per session":** `diversifyBySession` runs inside hybrid ranking (`hybrid-search.ts:242-245`, `:261-295`). How it works:
  - It takes candidates in score order, at most 3 per `sessionId`, until `max(limit, 20)`.
  - It then **back-fills** the remaining slots from the skipped candidates, in rank order (`:285-292`).
  - It therefore **reorders and never drops** hits while there are enough candidates.
- **What the cap means for a single-writer client:**
  - All `/remember` records share the synthetic session `"memory"` (`remember.ts:161`, `memory-utils.ts:14`). An all-memory result set therefore keeps pure score order: the top 3, then the back-fill in the same order. The cap has no visible effect.
  - The cap only reorders when observations from several sessions mix with each other.
  - Scores: `combinedScore = RRF(k=60)`, weighted BM25 0.4 / vector 0.6 / graph 0.3 (env `BM25_WEIGHT`, `VECTOR_WEIGHT`, `AGENTMEMORY_GRAPH_WEIGHT`), normalized by the best attainable score, × (1 + 0.05 × (matched streams − 1)) (`hybrid-search.ts:20-33`, `:198-224`; `config.ts:252-257`; `index.ts:379-388`). The range is about 0…1.1 [INFERENCE from the formula].
- Embeddings are off unless `EMBEDDING_PROVIDER` is set or a provider key is present (`config.ts:265-278`). With them off, ranking is BM25 + graph only, and `/search` falls back to BM25 alone with raw scores.

## 4. Privacy filter (agentmemory side)

- **Where it runs:** `stripPrivateData()` runs **only in `mem::observe`**, over the JSON-stringified `data` (falling back to `String(data)`) before storage (`am:src/functions/observe.ts:92-99`).
  - It is also exposed as the function `mem::privacy` (`privacy.ts:31-40`).
  - It is **not** applied to `/remember` content, `session/start` titles, search queries or any other route. `stripPrivateData` is imported only by `observe.ts` and `index.ts`.
- **Patterns** (`am:src/functions/privacy.ts:3-20`, applied `:22-29`):
  - `<private>…</private>` → `[REDACTED]`
  - Each of the following → `[REDACTED_SECRET]`:
    - `(api[_-]?key|secret|token|password|credential|auth)\s*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}` (case-insensitive)
    - `Bearer\s+[A-Za-z0-9._\-+/=]{20,}`
    - `sk-proj-…{20,}`
    - `(sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}`
    - `sk-ant-…{20,}`
    - `gh[pus]_…{36,}`
    - `github_pat_…{22,}`
    - `xoxb-…`
    - `AKIA[0-9A-Z]{16}`
    - `AIza…{35}`
    - JWT `eyJ….….…` (10+ chars per segment)
    - `npm_…{36}`
    - `glpat-…{20,}`
    - `dop_v1_…{64}`
- **Consequence for Phase 7:** the substrate forwards through `/remember`, so its own `redact()` is the only filter that runs.
- **Observed gap.** A throwaway `bun -e` against `repo:packages/mcp-server/src/redact.ts` left the following **unchanged** (fake values):
  - `AKIA…`
  - `AIza…`
  - `xoxb-…`
  - `npm_…`
  - `glpat-…`
  - `dop_v1_…`
  - `sk-proj-…`
  - `pk-…`
  - `<private>…</private>`
  - lowercase `api_key: …` (the substrate's `…_KEY=` rule is case-sensitive, `redact.ts:31`)
- The plan should add these classes to `redact()`, or run them as a second pass, before the first forward.

## 5. Native Hermes provider and Claude Code hooks (list only; NOT to be installed)

These are what `context_search` replaces: hindsight in Claude Code (`~/.claude.json` MCP entry) and supermemory as the Hermes `memory.provider` (`repo:.planning/phases/05-docs-and-desktop/05-DISCOVERY.md` E4–E6).

- **Hermes, option 1 (MCP):**
  - `~/.hermes/config.yaml` gets `mcp_servers.agentmemory: {command: npx, args: ["-y","@agentmemory/mcp"]}` and `memory.provider: agentmemory` (`am:integrations/hermes/README.md:59-77`).
  - `agentmemory connect hermes` is a **stub** that only prints these lines (`am:src/cli/connect/hermes.ts:23-46`).
- **Hermes, option 2 (memory-provider plugin):**
  - Install by copying `integrations/hermes` to `~/.hermes/plugins/agentmemory` (`README.md:79-100`).
  - Hooks: `prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `system_prompt_block` (`am:integrations/hermes/plugin.yaml:6-12`).
  - Calls (`am:integrations/hermes/__init__.py:212-406`):
    - `initialize` → `/session/start`
    - `system_prompt_block` and `on_pre_compress` → `/context`
    - `prefetch` → `/smart-search` with `limit:5`; `queue_prefetch` uses `limit:3`
    - `sync_turn` → `/observe` as `post_tool_use`, `tool_name:"conversation"`, user text ≤500 chars, assistant text ≤2000
    - `on_session_end` → `/session/end`
    - `on_memory_write` → `/remember`
  - Tools: `memory_recall` → `/search`, `memory_save` → `/remember`, `memory_search` → `/smart-search`.
  - Env: `AGENTMEMORY_URL`, `AGENTMEMORY_SECRET`, `AGENTMEMORY_REQUIRE_HTTPS`.
  - It sends **no `agentId`, and no `project` on search**.
- **Claude Code:**
  - Install: the `/plugin marketplace add rohitg00/agentmemory` plugin, or `agentmemory connect claude-code [--with-hooks]`. The latter writes an `npx @agentmemory/mcp` entry into `~/.claude.json` and merges hooks into `~/.claude/settings.json` (`am:src/cli/connect/claude-code.ts:51-60`, `:122-170`).
  - **12 hooks** (`am:plugin/hooks/hooks.json:3-123`), each a `node scripts/*.mjs` call:

    | Hook | Endpoint |
    |---|---|
    | SessionStart | `/session/start` |
    | UserPromptSubmit | `/observe` |
    | PreToolUse | `/enrich` |
    | PostToolUse | `/observe` |
    | PostToolUseFailure | `/observe` |
    | PreCompact | `/context`, `/claude-bridge/sync` |
    | SubagentStart | `/observe` |
    | SubagentStop | `/observe` |
    | Notification | `/observe` |
    | TaskCompleted | `/observe` |
    | Stop | `/session/end` |
    | SessionEnd | `/observe`, `/session/end`, `/claude-bridge/sync` |

  - Plus the git `post-commit` script → `/session/commit` (grep of `plugin/scripts/*.mjs`).
  - It also installs 17 skills and the stdio MCP shim `@agentmemory/mcp`, which has 54 tools, or 7 when it cannot reach the server (`CHANGELOG.md:20`, `integrations/hermes/README.md:16`).
  - These hooks send raw tool I/O, filtered only by §4's list.

## 6. Dragonfly on Railway

**Pins.** Dragonfly **v2.0.0** is the latest release, published 2026-09-16T10:29:28Z (`gh release list -R dragonflydb/dragonfly -L 3`). Its tag commit is `40553fd842c2850b65787ed4da908d95aeab8834`, committed 2026-09-10. It vendors helio at `ee6ed2cde79b52d4a89cc75a9051f8e07e1e6b7f`, which holds the socket and flag plumbing. Images: `ghcr.io/dragonflydb/dragonfly:v2.0.0` answers 200. `docker.dragonflydb.io` redirects (307) to the same registry [INFERENCE: the redirect target was not followed]. Bun 1.4.0 on this host is tag `bun-v1.4.0`, commit `34cbb9a40b4bd1bd767d134a7065e66c2432a676`. Source paths are `dragonfly@40553fd:…`, `helio@ee6ed2c:…` and `bun@34cbb9a:…`.

**Topology this section assumes.** substrate-mcp runs under systemd on the VPS, outside Railway (`.planning/STATE.md:110-112, 268-275`). It therefore reaches Dragonfly only through the **public TCP proxy**. ROADMAP Phase 8 SC1 bars a plaintext password on that path (`.planning/ROADMAP.md:405-406`). So Dragonfly itself must terminate TLS.

### 6.1 TLS flags

| Flag | Default | Semantics | Source |
|---|---|---|---|
| `--tls` | `false` | Turns on TLS for every TCP listener: the main port, the memcached port and the admin port. The admin port is the exception when `--no_tls_on_admin_port` is set. | `dragonfly@40553fd:src/facade/dragonfly_listener.cc:29,250-299` |
| `--no_tls_on_admin_port` | `false` | "Allow non-tls connections on admin port" | `dragonfly_listener.cc:30,278-290` |
| `--tls_key_file` | `""` | **Required** when `--tls` is set. Without it: "To use TLS, a server certificate must be provided with the --tls_key_file flag!", then `exit(-1)` | `src/facade/tls_helpers.cc:26,83-87`; `dragonfly_listener.cc:161-163` |
| `--tls_cert_file` | `""` | Loaded with `SSL_CTX_use_certificate_chain_file`, so it can hold the full chain. The code does not force it, but a server needs a certificate in practice. | `tls_helpers.cc:25,102-111` |
| `--tls_ca_cert_file` / `--tls_ca_cert_dir` | `""` | Setting either one switches to `SSL_VERIFY_PEER \| SSL_VERIFY_FAIL_IF_NO_PEER_CERT`, which is **mandatory mTLS**. The dir needs `c_rehash`. | `tls_helpers.cc:27-30,113-123,138` |
| `--tls_ciphers` | `"DEFAULT:!MEDIUM"` | TLS 1.2 cipher list | `tls_helpers.cc:31,125-127` |
| `--tls_cipher_suites` | `""` | TLS 1.3 suites | `tls_helpers.cc:32,130-132` |
| `--tls_prefer_server_ciphers` | `false` | Server cipher preference | `tls_helpers.cc:33,142-144` |
| `--tls_session_caching`, `--tls_session_cache_size`, `--tls_session_cache_timeout` | `false`, `20*1024`, `300` | Session tickets and cache | `tls_helpers.cc:35-37` |
| `--tls_replication` | `false` | TLS as a replica client. Not relevant here. | `src/server/protocol_client.cc:42` |

- The minimum protocol is TLS 1.2 (`tls_helpers.cc:134`).
- **Is a CA file required for server TLS? No.** A CA is only for verifying client certificates, and setting one makes client certificates mandatory (`tls_helpers.cc:115-123`). Do **not** set `--tls_ca_cert_file` unless Bun will also present a client cert and key.
- **What if `--tls` is set without `--requirepass`?** An auth method is enforced. `ValidateServerTlsFlags()` needs either a password (`GetPassword()`) or a CA file/dir. Otherwise it logs "TLS configured but no authentication method is used!" and `main` returns 1.
  - Source: `src/server/server_family.cc:1005-1027`, called from `src/server/dfly_main.cc:1135-1138`.
  - This check runs after `ParseFlagsFromEnv()` (`dfly_main.cc:1092`), so a password set through `DFLY_requirepass` satisfies it.
- Docs: <https://www.dragonflydb.io/docs/managing-dragonfly/using-tls>. They show `--tls --tls_key_file --tls_cert_file --requirepass`, mTLS through `--tls_ca_cert_file`, and hot rotation with `CONFIG SET tls true`.
- **A TLS port accepts TLS only.** The listener reads the first 5 bytes. If they are not a TLS handshake header, it writes `-ERR Bad TLS header, double check if you enabled TLS for your client.` and closes the connection (`src/facade/dragonfly_connection.cc:1107-1158`). There is no mixed TLS and plaintext on the same port.

### 6.2 TLS and plaintext on separate ports; bind and IPv6

- **Can TLS and plaintext run at once on separate ports? Yes.** The main port uses TLS while `--admin_port` stays plaintext through `--no_tls_on_admin_port`.
  - Each listener decides for itself: `if (ctx && (!IsPrivilegedInterface() || tls_on_privileged_port)) ctx_ = ctx; else ctx_ = nullptr;` (`dragonfly_listener.cc:276-290`). Every connection gets that listener's `ctx_` (`dragonfly_listener.cc:187-189`).
  - The admin listener is created with `Role::PRIVILEGED` on `--admin_bind:--admin_port` (`dfly_main.cc:424-434`). The main listener binds `bind_addr:port` (`dfly_main.cc:336-340,444-445`).
  - Flags: `--admin_port` (uint16, default 0 = off) and `--admin_bind` (default `""` = all interfaces) (`src/facade/dragonfly_connection.cc:62-68`).
- **Caveat: the admin port is privileged.** Its connections skip ACL checks (`src/server/conn_context.cc:95`). It may run "restricted" (admin-only) commands (`src/server/main_service.cc:1337-1340`) and can kill main-port clients (`server_family.cc:675-689`).
  - **Recommendation: do not open `--admin_port` at all.** Nothing in Phase 8 needs it.
- **HTTP console on the main port.** `--primary_port_http_enabled` defaults to `true` (`dragonfly_connection.cc:59-60`; `dragonfly_listener.cc:169-174`). Even with a password set, `/metrics` and `/healthz` skip auth (`main_service.cc:2993-3002`).
  - Over the public proxy this would expose `/metrics` to anyone who completes a TLS handshake. Recommend `--primary_port_http_enabled=false`.
- **`--bind`:** the default is `""`, meaning "binds on all interfaces" (`dfly_main.cc:93-95`). In practice that means **IPv4 only**:
  - An empty bind passes `nullptr` to `AcceptServer::AddListener` (`dfly_main.cc:352-360`).
  - `AddListener` calls `getaddrinfo(nullptr, port, AF_UNSPEC, AI_PASSIVE)` (`helio@ee6ed2c:util/fibers/accept_server.cc:126-140`).
  - `CreateServerSocket` then tries `family_pref = {AF_INET, AF_INET6}`, "Try ip4 first", and returns on the first successful bind (`accept_server.cc:24-53`). So the default ends up on `0.0.0.0` only.
  - `--bind=::` resolves to AF_INET6 `[::]`. helio never sets `IPV6_V6ONLY` (grep: 0 hits in helio). So `[::]` is dual-stack under Linux's default `net.ipv6.bindv6only=0` [INFERENCE: Railway's sysctl is not observed].
- **Protected mode** binds to 127.0.0.1 only when running under systemd (`INVOCATION_ID` set) with no bind and no password (`dfly_main.cc:344-360`). It does not apply on Railway.
- **Railway private network:**
  - Environments created **after 2025-10-16** resolve `<service>.railway.internal` to IPv4 and IPv6.
  - **Legacy environments resolve IPv6 only.**
  - Source: <https://docs.railway.com/networking/private-networking/how-it-works> ("DNS resolution").
  - Railway's own Dragonfly template starts with `--bind '::'` (<https://railway.com/deploy/dragonfly>, "Start command").
  - **Use `--bind=::`.** It is required for private networking in legacy environments. For the TCP proxy it does no harm, whichever family the proxy uses.

### 6.3 Password, env mapping, `--admin_nopass`

- **`--requirepass`** (string, default `""`) is the password for the `default` user (`server_family.cc:117-119`). Precedence for the default user's password: the `requirepass` flag, then env `DFLY_PASSWORD`, then env `DFLY_requirepass` (`src/server/acl/user_registry.cc:158-168`; `GetPassword()` at `server_family.cc:2004-2013`).
- **`DFLY_<flag>` → flag mapping.** `ParseFlagsFromEnv()` goes through `environ`. For each `DFLY_<name>=<value>` it looks up the flag `<name>` (**case-sensitive**) and parses the value, unless that flag was given on the command line (`dfly_main.cc:1032-1064`). The docs say the same: "export DFLY_port=6379 (note it's case sensitive)" (<https://www.dragonflydb.io/docs/managing-dragonfly/flags>). `DFLY_requirepass` is tested upstream (`tests/dragonfly/generic_test.py:29,177`).
- **Gotcha: any `DFLY_*` env var that is not a flag is fatal.** It hits `LOG(FATAL) << "unknown environment variable DFLY_" << flag_name` (`dfly_main.cc:1059-1060`). Only `DFLY_DEV_ENV` is exempt (`:1043-1045`).
  - So TLS PEM variables must **not** use the `DFLY_` prefix.
  - [INFERENCE, not run] By the same rule, `DFLY_PASSWORD` (no flag is named `PASSWORD`) should also hit the fatal path, even though the docs advertise it. **Use `DFLY_requirepass`.**
- **Why an env var and not `--requirepass=$X` in the start command:** it keeps the secret out of `argv`/`ps` [INFERENCE: good practice].
- **`--admin_nopass`** (default `false`): "enable open admin access to console on the assigned port, without authorization" (`main_service.cc:99-101`).
  - With it, admin-port contexts are created without `req_auth` (`main_service.cc:1883-1905`), and the admin HTTP console skips auth (`main_service.cc:2991-2994`).
  - Without it, the admin port needs the same password (`main_service.cc:1895-1896`). Keep it off, and keep no admin port at all (6.2).

### 6.4 Cache-mode flags and recommended set

| Flag | Default | Semantics | Source |
|---|---|---|---|
| `--cache_mode` | `false` | When `true`, Dragonfly evicts near `maxmemory`: insert-time eviction through `PrimeEvictionPolicy` plus heartbeat eviction. When `false` and over the limit, inserts are **rejected** ("AddOrFind: over limit", `insertion_rejections++`). `INFO` then reports `maxmemory_policy:eviction`. | `src/server/engine_shard_set.cc:21-23`; `src/server/db_slice.cc:821-833,1682`; `db_slice.h:484-487`; `server_family.cc:2800-2803` |
| `--maxmemory` | `0` = auto | Human-readable bytes; the first letter after the number sets the unit, so `512mb`, `1G`, `1GiB` all parse; powers of 1024. With 0, it becomes `0.8 × mem_avail`, read from cgroup `memory.max`/`limit_in_bytes`. **Hard floor: `maxmemory ≥ proactor_threads × 256 MB`, otherwise it exits** ("There are N threads, so X are required. Exiting..."). | `main_service.cc:106-109`; `helio@ee6ed2c:strings/human_readable.cc:137-222`; `dfly_main.cc:612-651,1165-1189,319-324` |
| `--proactor_threads` | `0` = the cgroup CPU limit | An explicit value overrides the cgroup-derived count | `helio@ee6ed2c:util/fibers/proactor_pool.cc:29`; `dfly_main.cc:1151-1159` |
| `--dbfilename` | `"dump-{timestamp}"` | **An empty value disables persistence completely.** No load at start (`LoadPath` returns early when the name is empty), and no save on shutdown (skipped when the name is empty). By default `save_on_shutdown_` is `true`, so the default **saves on shutdown**. An empty name passes validation. | `server_family.cc:114-116,1312-1314,1356`; `src/server/detail/snapshot_storage.cc:311-314`; `server_family.h:395`; `src/server/detail/save_stages_controller.cc:64-67` |
| `--snapshot_cron` | unset | With no cron expression, the scheduler fiber returns at once. `--save_schedule` is deprecated and exits if set. | `server_family.cc:122-124,357-371,1569-1573` |
| `--dir` | `""` | Working directory. The image `WORKDIR` is `/data`. It does not matter once `--dbfilename=` is set. | `server_family.cc:113`; `tools/packaging/Dockerfile.ubuntu-prod:28-29` |
| `--dbnum` | `16` | Number of databases; `SELECT` works (6.6) | `src/server/generic_family.cc:54` |
| `--rss_oom_deny_ratio` | `1.25` | Once RSS exceeds `maxmemory × 1.25`, DENYOOM commands fail and new non-admin connections are refused | `src/server/server_state.cc:35-38` |

**Recommended flag set for a 512 MB–1 GB fail-open cache:**
- `--cache_mode`
- `--maxmemory=512mb --proactor_threads=2`: exactly 2 × 256 MB, the floor. For headroom use `1gb` with `2`.
- `--dbfilename=` (empty: no load, no save; a pure cache)
- `--primary_port_http_enabled=false`
- `--bind=::`, `--port=6379`, plus the TLS flags
- `--logtostderr`, which the image's default `CMD` normally adds (`Dockerfile.ubuntu-prod:43`)

**Why set `--proactor_threads` explicitly:** on Railway the cgroup CPU limit can be the plan's vCPU count. For example, 8 vCPUs give 8 × 256 MB = 2 GB minimum, and a 512 MB `maxmemory` would then exit at start [INFERENCE: Railway's cgroup values are not observed]. Also give the Railway service more RAM than `maxmemory × 1.25` (the default `rss_oom_deny_ratio`).

### 6.5 Railway specifics

- **Templates.** Railway has community templates but no Dragonfly-official one:
  - <https://railway.com/deploy/dragonfly>, by "Brody's Projects": image `ghcr.io/dragonflydb/dragonfly`, start command `/bin/sh -c "exec dragonfly --logtostderr --requirepass=${DRAGONFLY_PASSWORD} --bind '::'"`, a volume and a TCP proxy. It has no TLS.
  - Others exist, for example <https://railway.com/deploy/dragonfly-redis-alternative>; these were not inspected.
  - Recommendation: deploy the image `docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.0`, or the same thing on ghcr, as a plain Docker Image service. Pin the version; do not use `latest`.
- **Start command semantics.** For Docker images, Railway's start command **overrides the image `ENTRYPOINT`** in exec form. Env expansion needs `/bin/sh -c "exec …"` (<https://docs.railway.com/deployments/start-command>). This bypasses the image's `tini` → `entrypoint.sh`, and with it:
  - `ulimit -l 65000` (`tools/docker/entrypoint.sh:1-7`)
  - dropping to user `dfly` via `setpriv` (`entrypoint.sh:17-24`)
  - the automatic `--logtostderr` (`entrypoint.sh:11-15`; `Dockerfile.ubuntu-prod:38,43`)

  The start command below restores all three explicitly.
- **The image has no `openssl` binary.** The runtime layer installs only `netcat-openbsd ca-certificates redis-tools net-tools tini` (`Dockerfile.ubuntu-prod:20-23`). Certificates must therefore be made off-box and injected. Railway variables can be multiline (<https://docs.railway.com/variables>, "Multiline variables").
- **TCP proxy.** You give an internal port; Railway generates `domain:port`, "all traffic sent to `domain:port` will be proxied to the service". The docs also say "expose non-HTTP services … raw TCP" (<https://docs.railway.com/networking/tcp-proxy>).
  - **Is TLS terminated at the proxy? No** [INFERENCE: the docs describe pass-through, not termination]. Railway's own Postgres image does TLS itself so that it works through the proxy (<https://github.com/railwayapp-templates/postgres-ssl> README). Railway's Redis doc exposes a `REDIS_PUBLIC_URL` through the proxy (<https://docs.railway.com/databases/redis>).
  - So TLS must come from Dragonfly (`--tls`).
  - Railway injects `RAILWAY_TCP_PROXY_DOMAIN` (e.g. `roundhouse.proxy.rlwy.net`), `RAILWAY_TCP_PROXY_PORT` and `RAILWAY_TCP_APPLICATION_PORT` (<https://docs.railway.com/variables/reference>). The server certificate's SAN must be `RAILWAY_TCP_PROXY_DOMAIN`, or a custom CNAME to it (tcp-proxy doc, "Using a custom domain").
  - The proxy is billed as network egress (<https://docs.railway.com/databases/redis>).
- **Private networking.** Hostnames are `<service>.railway.internal`, reachable only at runtime and only inside the same project and environment. Traffic is WireGuard-encrypted, and the docs say to use plain `http://` internally (<https://docs.railway.com/networking/private-networking/how-it-works>).
  - **Is TLS needed on the private network? No.** But the VPS cannot use it: `.railway.internal` resolves only inside Railway (`.planning/STATE.md:271-275`).
- **memlock and io_uring.** The dispatcher is chosen at start:
  - `--force_epoll` (default `false`) → epoll.
  - Kernel < 5.10 → epoll.
  - Otherwise it calls `io_uring_queue_init_params(1024)`. On `ENOSYS`, `ENOMEM` ("max locked memory is too limited … try adding '--ulimit memlock=-1'") or `EPERM` (`/proc/sys/kernel/io_uring_disabled`), it **falls back to epoll automatically** with a warning instead of failing (`dfly_main.cc:101-103,518-555,1213-1219`).
  - The comment in the image entrypoint says memlock matters only on kernels < 5.12 (`entrypoint.sh:3-7`).
  - **Is `--memlock` or `--force_epoll` required? No.** Watch the deploy log for "switching to epoll". Add `--force_epoll` only if io_uring misbehaves on Railway.
  - Dragonfly also warns when swap is enabled (`dfly_main.cc:1162-1163`).

### 6.6 Redis-client gotchas (Bun RESP3, TLS)

- **Does Dragonfly support `HELLO 3`? Yes.**
  - `HELLO [2|3] [AUTH user pass] [SETNAME name]` switches the reply builder to RESP3 and returns a RESP3 map (`server_family.cc:3263-3343`, registered at `:4123`).
  - `HELLO` goes through the NOAUTH gate like `AUTH` (`main_service.cc:1388-1391`).
  - Upstream tests run `HELLO 3` in many places (e.g. `src/server/server_family_test.cc:353`).
- **Bun's handshake.** On connect, Bun sends `HELLO 3 AUTH <user|"default"> <password>` if a username or password is set, otherwise bare `HELLO 3`. It sends `SELECT n` only when the URL has a db > 0 (`bun@34cbb9a:src/runtime/valkey_jsc/valkey.rs:1232-1289`).
  - Dragonfly's `default` user carries the `requirepass` password (`user_registry.cc:158-168`), so `rediss://:<pw>@host:port` or `rediss://default:<pw>@…` works.
  - Bun checks for `proto == 3` only on **SimpleString** keys. Dragonfly sends the keys as bulk strings (`server_family.cc:3336-3343`), so the check is skipped and Bun still marks the connection connected (`valkey.rs:1020-1050`). Harmless.
- **`CLIENT SETINFO`:** Dragonfly supports `LIB-NAME` and `LIB-VER` (`server_family.cc:605-627,2215-2216`). Bun 1.4.0 does not send it (no `SETINFO` in `valkey.rs`).
- **`SELECT`:** supported for `0..dbnum-1`. Errors come only in cluster mode (index ≠ 0) or inside `MULTI`/lock-ahead transactions (`generic_family.cc:2592-2618`). Use db 0 (no `SELECT`).
- **Bun TLS:**
  - A `rediss://` URL turns TLS on, but an explicit `tls` option wins (`bun@34cbb9a:src/runtime/valkey_jsc/js_valkey.rs:757-762`).
  - With `rejectUnauthorized` (the default for `tls: true`, and whatever the `tls` object sets), Bun checks the chain and then the **hostname against the SNI servername or the URL host** (`js_valkey.rs:1786-1810`; `valkey.rs:131-137`).
  - A private-CA certificate works if Bun gets `tls: { ca }` and the cert SAN equals `RAILWAY_TCP_PROXY_DOMAIN`. Docs: <https://bun.com/docs/runtime/redis> ("Connection Options", `tls: { rejectUnauthorized, ca, cert, key }`).
- **Idle connections:** `--tcp_keepalive` defaults to 300 s (`dragonfly_listener.cc:42-44`) and `--timeout` to 0, meaning never (`src/server/server_state.cc:31-32`). Bun's `idleTimeout` defaults to 0 and it auto-reconnects (Bun docs).

### Recommended Railway setup

**Service.** New → Docker Image → `docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.0`. Enable a TCP proxy on port **6379**. No volume, no public HTTP domain, RAM ≥ 768 MB for `maxmemory=512mb`.

**Variables (Railway).**
- `DFLY_requirepass`: a 32+ character random value. The same value goes into `/etc/substrate/substrate.env` inside `DRAGONFLY_URL`.
- `TLS_CERT_PEM`, `TLS_KEY_PEM`: multiline PEM. **Not** `DFLY_`-prefixed (6.3).
- Make the certificate off-box on the VPS with `openssl`: a private CA, then a server cert with `SAN=DNS:<RAILWAY_TCP_PROXY_DOMAIN>`. The CA cert stays on the VPS, and Bun pins it.

**Start command** (for Docker images it replaces ENTRYPOINT, so it re-adds tini, the privilege drop and logtostderr):

```sh
/bin/sh -c 'umask 077 && mkdir -p /run/dfly-tls && printf "%s\n" "$TLS_CERT_PEM" > /run/dfly-tls/cert.pem && printf "%s\n" "$TLS_KEY_PEM" > /run/dfly-tls/key.pem && chown -R dfly:dfly /run/dfly-tls && exec /usr/bin/tini -- setpriv --reuid=dfly --regid=dfly --clear-groups -- dragonfly --logtostderr --bind=:: --port=6379 --tls --tls_cert_file=/run/dfly-tls/cert.pem --tls_key_file=/run/dfly-tls/key.pem --primary_port_http_enabled=false --cache_mode --maxmemory=512mb --proactor_threads=2 --dbfilename='
```

- `tini`, `setpriv` and the `dfly` user (uid/gid 999) all exist in the image (`Dockerfile.ubuntu-prod:23,25,38`; `entrypoint.sh:23`) [INFERENCE: `setpriv` comes from util-linux in `ubuntu:22.04`; not run].
- `--dbfilename=` passes an empty string, which disables load and save (6.4).
- There is no `--tls_ca_cert_file` (that would force mTLS) and no `--admin_port`.

**Client (substrate-mcp).**
- `DRAGONFLY_URL=rediss://default:<pw>@<RAILWAY_TCP_PROXY_DOMAIN>:<RAILWAY_TCP_PROXY_PORT>`
- `new RedisClient(url, { tls: { ca: <private CA PEM>, rejectUnauthorized: true }, connectionTimeout: <≤ fail-open budget>, enableOfflineQueue: false, autoReconnect: true })`
- `enableOfflineQueue: false` makes commands reject at once while disconnected, which is the fail-open behaviour (Bun docs, "Reconnection Behavior").

**Fallback if cert management is unwanted.** Use a self-signed cert with `tls: { rejectUnauthorized: false }`. That encrypts against passive sniffing but not against an active MITM, so the password is protected only against passive capture. It is weaker than SC1's intent. Owner decision.

## 7. Bun Redis client

**Version:** the host runs **Bun 1.4.0**, not 1.3.x as the brief assumed. `/root/.local/share/reflex/bun/bin/bun --revision` prints `1.4.0+34cbb9a40`. The full commit is `34cbb9a40b4bd1bd767d134a7065e66c2432a676`, which is tag `bun-v1.4.0`, committed 2026-08-19. All source citations below are `oven-sh/bun@34cbb9a`.

**Rust, not Zig:** in 1.4.0 the client is written in Rust, not Zig. The code is in `src/runtime/valkey_jsc/*.rs` and `src/valkey/valkey_protocol.rs`. Every place the brief says "zig", read the Rust file cited here instead.

**Path abbreviations used below:**
- `V` = `src/runtime/valkey_jsc/valkey.rs`
- `J` = `src/runtime/valkey_jsc/js_valkey.rs`
- `F` = `src/runtime/valkey_jsc/js_valkey_functions.rs`
- `C` = `src/runtime/valkey_jsc/ValkeyCommand.rs`
- `T` = `packages/bun-types/redis.d.ts`
- `D` = `docs/runtime/redis.mdx`, published at https://bun.com/docs/runtime/redis (`/docs/api/redis` redirects there with a 308).
- `CF` = `test/js/valkey/reliability/connection-failures.test.ts`

### 7.1 Capability matrix

| # | Capability | Yes/No | Default | Citation |
|---|---|---|---|---|
| 1 | `rediss://` for `RedisClient` and `Bun.redis` | **YES** | — | `V:97-110` maps `rediss`, `valkeys`, `redis+tls` and `valkey+tls` to `StandaloneTls`. Also `D:444-448` and the tests in `test/js/valkey/valkey-tls-verify.test.ts:84-131`. |
| 1a | `redis+tls://`, `valkeys://`, `valkey+tls://` | **YES** | — | `V:100-101,106`. The experiment (7.3 F) parsed all three. |
| 1b | Unix sockets: `redis+unix://`, `valkey+unix://`, `redis+tls+unix://`, `valkey+tls+unix://` | **YES** | The db index is forced to 0 | `V:102-103,107-108`; `J:632-643,709-711`. TLS over a unix socket skips the hostname check (`J:1793-1797`). The error message at `J:611` leaves out the `valkey+*unix` schemes even though they are accepted (open issue #23790). Any other scheme makes the constructor throw (7.3 F, `http://`). |
| 2 | `tls: true` | **YES** | Unset: the URL scheme decides | `T:40` types it as `tls?: boolean \| Bun.TLSOptions`. Parsed at `J:2011-2017`; the choice between option and scheme is at `J:757-763`. `tls:false` does **not** turn TLS off for a `rediss://` URL, because `None` falls back to the scheme. |
| 2a | `tls: { ca, cert, key, rejectUnauthorized, serverName }` | **YES** | `rejectUnauthorized` comes from `$NODE_TLS_REJECT_UNAUTHORIZED`, or `true` if that is unset | Type: `Bun.TLSOptions` in `packages/bun-types/bun.d.ts:4291-4370` (`serverName` 4305, `rejectUnauthorized` 4318, `ca`/`cert`/`key` 4332/4344/4355; each accepts string, BufferSource, BunFile or an array of those). Parsing: `J:2018-2026` calls `SSLConfig::from_js` in `src/runtime/socket/SSLConfig.rs:137-266`. Lowercase `servername` is accepted as an alias (`src/runtime/socket/SSLConfig.bindv2.ts:34-38`). Default for `rejectUnauthorized`: `SSLConfig.rs:171-174` and `V:130-137`. An empty `tls:{}` throws `ERR_INVALID_ARG_TYPE`: `SSLConfig.rs:264-265` returns `None` and `J:2025` throws (7.3 G). |
| 2b | Chain and hostname/SAN verification | **YES**, when `rejectUnauthorized` is true | — | `J:1785-1844`. A chain error gives the BoringSSL code (e.g. `DEPTH_ZERO_SELF_SIGNED_CERT`); a SAN mismatch gives `ERR_TLS_CERT_ALTNAME_INVALID`. Tests: `valkey-tls-verify.test.ts:84-156`. |
| 2c | Bad CA/cert material | Fails without a useful error | — | Building the TLS context fails. Bun then disables `autoReconnect` and calls `fail()` (`J:1500-1527`). Commands reject with `"Connection has failed"`, which gives no TLS detail (7.3 G). |
| 3 | `connectionTimeout` | **YES** | `10000` ms (u32; `0` disables it) | `T:3-7`; `V:164`; `J:1981-1985`; `V:439-448`. When it expires the error is `ERR_REDIS_CONNECTION_TIMEOUT` (`J:1120-1135`, `src/runtime/valkey_jsc/protocol_jsc.rs:42`). Expiry is **terminal**: it goes through `fail()` → `failed=true`, and `on_close` skips the retry (`V:549-601,671-677`). This applies even to a timeout during a reconnect attempt. |
| 3a | `idleTimeout` | **YES** | `0` (off), in ms | `T:9-16`; `V:163`. The timer counts from the last byte the **server** sent; only server data resets it (`J:1943-1945`). On expiry the error is `ERR_REDIS_IDLE_TIMEOUT` and all in-flight commands are rejected (`J:1106-1118`, `protocol_jsc.rs:43`). It does **not** auto-reconnect (`T:12-13`; test `CF:661-718`). |
| 3b | Per-command timeout or AbortSignal | **NO** | — | The options struct has no such field (`V:148-158`, `T:2-47`). Searching `valkey_jsc/` for `commandTimeout`, `AbortSignal` or `signal` finds nothing. Callers need a `Promise.race` or timer wrapper. The losing command is **not cancelled**: nothing removes an entry from the queues (`C:90-113`, `V:250-254`). |
| 3c | Pending promise rejected when the connection drops | **YES** | — | While reconnecting, in-flight commands are rejected with `ERR_REDIS_CONNECTION_CLOSED "Connection closed"` (`V:706-709`). On a terminal failure, in-flight **and** queued commands are rejected (`V:579-601`). Test: `CF:391-452`. This was fixed by PR #33072 (merged 2026-07-04, before the 1.4.0 tag); the bug report is #34374. |
| 4 | `autoReconnect` | **YES** | `true` | `V:165`; `J:1987-1991`; `T:18-22` |
| 4a | `maxRetries` | **YES** | `20` | `V:166`; `T:24-29`; `J:1993-1997` |
| 4b | Backoff | Fixed exponential, **no jitter, not configurable** | 50, 100, 200, 400, 800, 1600 ms, then capped at 2000 ms | `V:457-480`, used at `V:688-699`; `D:416-425`. The counter resets after a successful HELLO (`V:1010,1049`). |
| 4c | `onconnect` / `onclose` | **YES** | `null` | `T:84-94`. `onconnect` is queued as a microtask after **every** accepted HELLO, including reconnects (`J:1286-1291`). `onclose` fires **only on a terminal close**, not on each retry (`J:1396-1438`, called from `V:672-698`; 7.3 B saw 0 calls during 3 s of retries). **Never assign `null`**: see bug #29145 in 7.4. |
| 5 | `enableOfflineQueue` | **YES** | `true` | `V:64,167`; `J:1999-2003`. The queue is a `VecDeque` with **no size cap** (`C:99-101`, `V:1374-1413`). |
| 5a | Offline queue off → immediate reject | **YES** | — | `V:1475-1495` rejects with `ERR_REDIS_CONNECTION_CLOSED` and the message `"Connection is closed and offline queue is disabled"`. This also applies **during the very first dial**: the first command dials, and the check runs against `Connecting` (`J:1591-1614`, 7.3 A). |
| 6 | `enableAutoPipelining` | **YES** | `true` | `V:168`; `T:42-46`. The env flag `BUN_FEATURE_FLAG_DISABLE_REDIS_AUTO_PIPELINING` flips the default (`J:1967-1973`). Commands that are never pipelined (AUTH, EXEC, INFO, MULTI, SELECT, SUBSCRIBE, …) are listed in `C:135-155`. |
| 6a | Sends `HELLO 3` on every (re)connect | **YES**, always RESP3 | — | `V:1230-1267`. If the reply map has `proto` ≠ 3, the connection fails with `ERR_REDIS_INVALID_RESPONSE "Server does not support RESP3"` (`V:1021-1039`, `protocol_jsc.rs:40`). The check only reads `SimpleString` keys, so a map with bulk-string keys skips it and is accepted (`V:1027-1043`); a plain `+OK` reply is also accepted (`V:1006-1013`). A HELLO error reply gives `ERR_REDIS_AUTHENTICATION_FAILED` (`V:1001-1005`). The docs say servers 7.2 and later are supported (`D:6`). |
| 6b | AUTH with user/password from the URL | **YES** | Username `default` if the URL has only a password | `J:619-623` reads them; `V:1241-1251` sends them. |
| 6c | `SELECT <db>` from the URL path `/N` | **YES** | 0, which sends no SELECT | `J:708-728`; `V:1274-1288`. Commands are held until SELECT returns OK (`V:1320-1322`). |
| 7 | `set(k, v, "EX", 60)`, `"PX"`, `"NX"`, … | **YES** | — | Types at `T:149-241` (EX 158, PX 167, NX 202). `F:529-579` passes any trailing args through, and numbers become strings (`F:65-77`). |
| 7a | `expire`, `pexpire`, `ttl`, `pttl`, `del`, `unlink`, `getex EX/PX`, `mget` | **YES** | — | `T:302,318,326,1261,248,2871,2631-2680,2499`; implementation of `expire` at `F:648-699` |
| 7b | `send(cmd, args)` for any command | **YES** | — | `T:103-127`; `F:444-487`. At runtime args may be strings, buffers or numbers; the types say `string[]`. |
| 7c | Binary values | **Partial** | — | Writing binary works because `KeyLike = string \| ArrayBufferView \| Blob` (`T:50`). Reading bytes works only through `getBuffer`, which returns `Uint8Array` (`T:141`, `F:507-527`). `send()` cannot return bytes (open issue #19576). Pub/sub buffer listeners are not implemented (`T:53-54`). |
| 8 | Cluster, Sentinel | **NO** | — | `D:572-581`; open issues #22947 (cluster) and #38515 (sentinel) |
| 8a | TCP keepalive or socket-timeout option | **NO** [INFERENCE: not in the options struct `V:148-158`] | — | Only `idleTimeout` exists (row 3a). |
| 8b | Default URL for `Bun.redis` | — | `REDIS_URL`, then `VALKEY_URL`, then `valkey://localhost:6379` | Source: `J:528-532`. The type docs at `T:61-62,3986-3994` list `VALKEY_URL` first; the types are wrong and `D:51-55` matches the source. `Bun.redis` cannot take options, so use `new RedisClient(url, opts)`. |

### 7.2 Offline and reconnect semantics (from the code)

**States.** A client moves through `NeverConnected` → `Connecting` → `Connected` → `Disconnected` (`V:75-86`). It becomes `Connected` only after HELLO is accepted, plus SELECT if the URL names a db. A sticky `failed` flag sits on top of the state (`V:40-44`).

**Issuing a command** (`J:1574-1614`, `V:1438-1483`):
1. If the client has never connected, the command starts the first dial.
2. If `failed` is set, the command rejects immediately with `"Connection has failed"`.
3. If the client is not `Connected` and `enableOfflineQueue` is false, it rejects immediately with `"Connection is closed and offline queue is disabled"`.
4. Otherwise the command is serialized into the unbounded `queue`. The queue is drained, auto-pipelined, once HELLO (and SELECT) succeeds (`J:1238-1245`, `V:716-748`, `V:383-436`).

**When a live or dialing socket closes** (TCP close, RST or refused; `V:662-714`):
- If the close was manual or `failed` is set, the close is terminal.
- If `autoReconnect` is false, Bun calls `fail("Connection closed")`, which is terminal.
- Otherwise Bun increments `retry_attempts`. If `retry_attempts > maxRetries`, it calls `fail("Max reconnection attempts reached")`, which is terminal.
- If not over the limit, Bun rejects **in-flight** commands with `"Connection closed"` but **keeps the offline `queue`**. It then arms the reconnect timer with the backoff delay (`J:1386-1393`, `J:1181-1227`).

**Terminal `fail()`** (`V:549-601`):
- Rejects every in-flight and queued promise with the failure error, which is `ERR_REDIS_CONNECTION_CLOSED` for retry exhaustion.
- Sets `failed=true`, closes the socket, and calls `onclose(Error "Connection closed")`.
- The client then **stays dead**: every command rejects immediately until the application calls `connect()`, which clears `failed` and resets the retry budget (`J:991-1027`). A newly opened socket also clears it (`V:1298-1301`; fixed by #29925).
- Terminal triggers:
  - retries exhausted
  - `connectionTimeout` expiring, even during a retry dial
  - `idleTimeout` expiring
  - TLS handshake or verification failure (`J:1846-1873`)
  - a HELLO, AUTH or SELECT error
  - a protocol error
  - failure to build the TLS context
- Calling `connect()` from inside `onclose` is supported (tests `CF:805-818,1048-1073`).

**Worst-case wait with the offline queue on (the default):**
- Against a refusing host, the retry delays add up to 50+100+200+400+800+1600+14×2000 = **31,150 ms**, plus the time for each dial. This is calculated from `V:457-480,691`. The experiment is consistent with it: 7.3 D measured 398 ms for `maxRetries: 3`, which is 350 ms of delay plus overhead.
- Against a black-holed host, a single dial waits `connectionTimeout` (**10,000 ms**) and then fails terminally.

**What `Promise.race` does not handle:**
- **Late writes.** A timed-out command stays in `queue` or `in_flight`. A queued `SET` still runs after the reconnect. This is derived from the code (`C:90-113`); there is no cancellation API.
- **Head-of-line blocking.** Replies come back in order, so one slow reply delays every command pipelined behind it on the same connection [INFERENCE: RESP ordering].
- **Half-open TCP.** If the peer disappears without an RST, in-flight promises stay pending until the kernel gives up, unless `idleTimeout` is set. Bun has no keepalive option [INFERENCE].

**Suggested fail-open configuration** (derived from the above, not tested against a live server):
- Set `enableOfflineQueue: false`, so a disconnected client gives an instant miss.
- Keep `autoReconnect: true`.
- Set `connectionTimeout` to about 1000–2000 ms.
- Boot with `await client.connect().catch(noop)`.
- Wrap each call as `Promise.race([cmd.catch(() => MISS), timer(100ms) → MISS])`, and clear the timer afterwards.
- In `onclose`, call `connect()` again after a delay, because terminal failures stick.
- Never set a handler to `null`; assign a no-op function instead.
- Optionally add a circuit breaker: after N consecutive timeouts, call `close()` then `connect()`. `close()` rejects everything pending (`V:1497-1507`).

### 7.3 Throwaway experiment

**Setup:** scripts are in `/tmp/bunredis-exp/`. Nothing listens on port 1, and every connection was to 127.0.0.1 or a missing unix socket. Command: `bun run exp.ts` with bun 1.4.0+34cbb9a40. Output, verbatim:

```
[A rediss/noQueue/noReconnect get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection is closed and offline queue is disabled" after 0.2ms
[A2 same client, 2nd get after dial settled] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection is closed and offline queue is disabled" after 0.0ms
[A3 connect()] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection closed" after 0.1ms
[A3 get after failed connect] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection has failed" after 0.0ms
[B defaults get (queued?)] STILL PENDING at 3000ms after 3000.3ms
[B] onclose calls during 3s: 0; connected=false
[B] onclose calls after close(): 1
[C queue/noReconnect get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection closed" after 0.9ms
[D maxRetries=3 get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Max reconnection attempts reached" after 398.2ms
[D] onclose calls: 1
[D2 get after retries exhausted] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection has failed" after 0.0ms
[E] race(get,100ms) => TIMEOUT->miss after 100.3ms
[F redis+tls://127.0.0.1:1 get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection closed" after 0.1ms
[F valkeys://127.0.0.1:1 get] rejected ... "Connection closed" after 0.0ms
[F valkey+tls://127.0.0.1:1 get] rejected ... "Connection closed" after 0.0ms
[F redis+unix:///tmp/bunredis-exp/nope.sock get] rejected ... "Connection closed" after 0.0ms
[F redis+tls+unix:///tmp/bunredis-exp/nope.sock get] rejected ... "Connection closed" after 0.0ms
[F http://127.0.0.1:1] ctor threw Error:-:"Expected url protocol to be one of redis, valkey, rediss, valkeys, redis+tls, redis+unix, redis+tls+unix"
[G tls:{}] ctor threw TypeError:ERR_INVALID_ARG_TYPE:"Expected tls to be a object for 'tls'."
[G tls:{rejectUnauthorized:true} get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection closed" after 0.0ms
[G tls:{ca:'garbage',servername:'x'} get] rejected RedisError:ERR_REDIS_CONNECTION_CLOSED:"Connection has failed" after 0.0ms
[G tls:'yes'] ctor threw TypeError:ERR_INVALID_ARG_TYPE:"Expected tls to be a boolean or object for 'tls'."
```

In the F lines, `...` stands for the repeated `RedisError:ERR_REDIS_CONNECTION_CLOSED:` prefix.

**Reproducing #29145 on 1.4.0:**
- `exp5.ts dial-null`: dial, wait 120 ms, set `c.onclose = null`, then call `c.close()`. Result: `TypeError: c.close is not a function. (In 'c.close()', 'c.close' is null)` and exit code 1. The native close path calls the `null` handler, and the error is attributed to the JS call site.
- `exp8.ts`: `maxRetries: 1` with `onclose = null`, letting the client give up on its own. Result: `TypeError: null is not a function` is printed as uncaught, then `get: rejected RedisError: Max reconnection attempts reached`, then exit code 1.
- Controls: `dial-fn` (a no-op function as the handler) and `dial-none` (no handler) both exited 0.

**What the runs show:**
- With the offline queue off, a command rejects in under 1 ms.
- With default settings, a queued command stays pending for more than 3 s and `onclose` does not fire during the retries.
- After a terminal failure, commands keep rejecting until the client reconnects.
- A `Promise.race` with a 100 ms budget returns a miss at 100.3 ms.

### 7.4 Known bugs and limitations affecting 1.4.0

**Open or unfixed in 1.4.0:**
- **#29145** (open): setting `onclose = null` crashes or throws. Reproduced on 1.4.0 (7.3), where it shows up as a TypeError rather than a panic. Workaround: assign a no-op function. [INFERENCE] `onconnect = null` probably has the same bug class, because `J:1287-1290` queues the cached value as a microtask; this was not tested because it needs a live server.
- **#22812** (open): `onclose` is not called once the JS wrapper has been garbage-collected (`J:1404-1406`). Keep a strong reference to the client at module level.
- **#43684**: the mTLS client certificate is sent even to servers that fail verification. It was reproduced on 1.4.3 and closed 2026-09-21, after the 1.4.0 tag; the fix is PR #43694. It only matters if `cert`/`key` are passed.
- **#41417** (open; fix in PR #41418): there are no `url`/`options` getters, so a client cannot be rebuilt from itself. Keep the config yourself.
- **#19576** (open): no binary return from `send()`.
- **#29042** (open): sending `HELLO 2` on a subscriber silently drops messages. Never send `HELLO 2`.
- **#23467** (open): connecting to Redis Labs 7.4 fails with `ERR_REDIS_CONNECTION_CLOSED`. The root cause is unknown.
- **#23790** (open): the error message for an unknown scheme omits `valkey+*unix`.
- **#33103** (closed 2026-09-17, after the tag): `close()` while subscribed keeps the process alive. This affects pub/sub only.
- Unsupported features (`D:572-581`): Cluster (#22947), Sentinel (#38515), and MULTI/EXEC except through raw commands.
- Newer releases exist (1.4.1 is mentioned in #41417 and 1.4.3 in #43684). Their changelogs were not reviewed.

**Fixed before the 1.4.0 tag:**
- #34374: in-flight promises hung forever on auto-reconnect. Fixed by PR #33072 on 2026-07-04; the code is at `V:709`.
- #24240: a self-signed CA passed through `tls.ca` was not honoured. Fixed on main by 2026-07-24.
- #29925: the `failed` flag stuck after reconnecting. Fixed; see the code comments at `J:993-997` and `V:1298-1301`.
- #18895: `connect()` misbehaved on failure. Closed 2026-08-18.
- #19141: `GET` against Dragonfly returned "OK". This was a db-number bug (duplicate of #19041), closed 2025-04-21.

### 7.5 ioredis comparison (only the features Bun lacks)

Reference: `redis/ioredis` at tag `v6.0.0`, commit `8ed2946504a36ae9b1e186b9dccc56afcd046d78`.

| Feature | ioredis v6.0.0 | Bun 1.4.0 |
|---|---|---|
| Per-command timeout | `commandTimeout`, which rejects with "Command timed out" (`lib/redis/RedisOptions.ts:24-28`, `lib/Command.ts:418-425`, applied in `lib/Redis.ts:523-525`) | none; needs a wrapper |
| Flush the queue after N retries | `maxRetriesPerRequest`, default 20; fails with `MaxRetriesPerRequestError` (`RedisOptions.ts:186-196,337`, `lib/redis/event_handler.ts:411-421`, `README.md:893-901`) | the queue is flushed only on a terminal `fail()`, i.e. after `maxRetries` for the whole connection |
| Reconnect policy | `retryStrategy(times)` function; default `min(2^(times-1)*50, 5000) + 0–199ms jitter` (`RedisOptions.ts:17-22,291-296`); also `reconnectOnError` (`:139,332`) | fixed backoff, capped at 2 s, no jitter, not configurable |
| Resend unanswered commands after reconnect | `autoResendUnfulfilledCommands: true` (`:117,329`) | in-flight commands are rejected, never resent |
| Dead-socket detection | `socketTimeout` (`:44-50`) and `keepAlive: 30000` (`:52-57,297`) | only `idleTimeout`, which then does **not** reconnect; no keepalive |
| TLS options | the full Node `tls.ConnectionOptions`, passed straight through (`lib/connectors/StandaloneConnector.ts:10-13,42-43`); `tls:{}` is allowed (`README.md:1031-1037`) | the `Bun.TLSOptions` subset; `tls:{}` throws |
| Offline queue | `enableOfflineQueue: true` (`:213-223,326`); rejects with "Stream isn't writeable…" (`Redis.ts:569-576`) | the same option and default exist |
| Cluster / Sentinel | supported | not supported |

**Conclusion:** Bun's built-in client is **enough for a single-node, fail-open cache with a 50–150 ms budget**, on these conditions:
1. Use `enableOfflineQueue: false`.
2. Put a `Promise.race` timer on every call.
3. Re-arm `connect()` from `onclose`.
4. Never set a handler to `null`.
5. Accept that a timed-out write may still run late. A `SET … EX` is idempotent, so this is acceptable.

ioredis's extra value here is `commandTimeout`, `keepAlive`, jittered `retryStrategy` and `maxRetriesPerRequest`. A wrapper covers all of those except TCP keepalive. The remaining gap, half-open sockets, can be covered by a breaker that calls `close()` + `connect()` after N consecutive timeouts, or by a periodic `PING`.

**Transport, based on peer §6.5-6.6 (`local://phase78-s6-dragonfly.md`):**
- The VPS cannot reach `*.railway.internal`, so the route is `rediss://default:<pw>@<proxy-host>:<port>`. It goes through Railway's TCP proxy to Dragonfly started with `--tls`.
- Bun verifies the certificate against the **URL host** (`J:1811-1815`). The Dragonfly certificate therefore needs a SAN for the proxy hostname, supplied through `tls.ca`. The alternative is `rejectUnauthorized:false`, which is insecure.
- According to the peer, Dragonfly's HELLO reply has bulk-string map keys. Bun's `proto` check only looks at `SimpleString` keys (`V:1026-1043`), so the check is skipped and Bun connects. I confirmed this reading of the Bun side. The Dragonfly side is inferred and still needs a live smoke test.
- Dragonfly reports `redis_version` 7.4.0, which satisfies the docs' 7.2 minimum (`D:6`).
- AUTH as user `default` and `SELECT` 0..15 are both supported.

## 8. Repo facts to reuse (agent-substrate working tree, 2026-09-26)

- **Config loading:**
  - `loadConfig(env = process.env)` builds `SubstrateConfig` from the systemd EnvironmentFile. It trims each value and falls back to a default when a value is missing (`repo:packages/mcp-server/src/config.ts:55-79`).
  - Idioms to copy for `AGENTMEMORY_URL`, `AGENTMEMORY_SECRET` and `DRAGONFLY_URL`:
    - optional block → `null`: `greptime` (`:56-67`)
    - `?.trim() || undefined` (`:68-70`)
    - URL with the trailing slash stripped (`:72`)
    - `positiveMs(raw, fallback)` for timeouts (`:50-53`, `:73`)
  - Bearer tokens map to a surface through `SUBSTRATE_TOKEN_<SURFACE>` (`:35-47`, `:81-86`).
- **Fail-open in the brief:**
  - `swallow(what, fallback)` logs `[substrate] brief: <what> unavailable — <cause>` to stderr and returns the fallback (`repo:packages/mcp-server/src/brief.ts:78-84`).
  - It is used as `.catch(swallow("graph", null))` and similar (`:98`, `:125`, `:137`, `:158`).
  - `composeBrief` "never throws — a partial brief beats a blocked prompt" (`:86-87`).
  - Service-side fire-and-forget is `.catch(() => undefined)` (`repo:packages/mcp-server/src/service.ts:177`, `:321`, `:388`).
- **Healthz:**
  - `GET /healthz` → `sendJson(res, health.index || health.greptime ? 200 : 503, health)` (`repo:packages/mcp-server/src/server.ts:104-107`).
  - Shape `{index: boolean, greptime: boolean}` from `Substrate.health()` (`repo:packages/mcp-server/src/service.ts:578-583`).
  - Phase 8 SC4 extends this with cache counters.
  - It sits *after* the bearer check, which returns 401 when tokens are configured (`server.ts:98-101`).
  - REST body cap: `MAX_BODY_BYTES = 1_000_000`, over which `BodyTooLargeError` → 413 (`server.ts:32-48`, `:193-195`).
- **redact() entry points:**
  - `redact(text: string): string` (`repo:packages/mcp-server/src/redact.ts:53-57`).
  - `redactValue<T>(value)` recurses and blanks sensitive keys (`:66-79`).
  - The write paths already use them: `normalizeEvent` does `summary: redact(input.summary).slice(0, MAX_SUMMARY=2000)` and `payload: redactValue(...)` (`repo:packages/mcp-server/src/event.ts:49`, `:85-86`); memory entries do `redact(entry.text)` (`repo:packages/mcp-server/src/index-store.ts:257`).
- **VM-guest guard:**
  - `proposeAllowed({callerSurface, header, key})` is true for any bearer surface, or for an `x-substrate-propose-key` header equal to the root-only key file (default `/var/lib/substrate/skills/propose.key`, 64 hex, re-read on every call). Otherwise it is false, which covers the anonymous rivet VM guest (`repo:packages/mcp-server/src/skills/propose-auth.ts:12-38`).
  - It is computed per request in `server.ts:94` and passed into `createMcpServer(…, {proposeAllowed})`.
  - Tools refuse with `refusal(...)` as their first statement (`repo:packages/mcp-server/src/mcp.ts:51-59`, `:161-163`, `:188-190`).
- **Open-vs-guarded split (planned in 05-05):**
  - `docs_search` / `POST /docs/search` stay **open** to anonymous callers and VM guests: read-only retrieval.
  - `docs_ingest` / `POST /docs/ingest` are **guarded by the same `proposeAllowed`**: the MCP tool refuses on its first line with `isError`, and REST answers 401 before reading the body. Both have the 1 MB cap → 413.
  - Sources: `repo:.planning/phases/05-docs-and-desktop/05-05-PLAN.md:28-31`, `:39-40`, `:57`, `:93-94`, `:117-120`, `:200-201`, `:209`.
  - Neither tool exists in `mcp.ts` yet (no `docs_search` match in `packages/mcp-server/src`).
  - **Carry-over for Phase 7:** `context_search` (read, open) against the forward/write path (guarded or internal-only).
- **Existing memory tools that `context_search` sits beside:** `memory_brief`, `memory_write`, `memory_search` (Postgres FTS) in `repo:packages/mcp-server/src/mcp.ts:63-114`; `memoryForBrief` in `repo:packages/mcp-server/src/index-store.ts:277`.
- **Phase 7/8 criteria this document feeds:**
  - Phase 7: `repo:.planning/ROADMAP.md:364-389`.
  - Phase 8: `repo:.planning/ROADMAP.md:395-417`.
  - Prior discovery: `repo:.planning/phases/05-docs-and-desktop/05-DISCOVERY.md` §2, lines 83-163.

## Decisions this implies (for smart-discuss / planning)

| # | Decision | Recommendation | Why (sections) |
|---|---|---|---|
| D1 | Version gate | Before the first forward, and on each boot, check that `GET /agentmemory/health` `.version` is **≥ 0.9.29**. Below that, skip forwarding and log it. **Amend ROADMAP Phase 7 SC3** from 0.9.28 to 0.9.29. | On 0.9.28, `/remember` drops `agentId` and memories vanish from scoped search (§1) |
| D2 | Write endpoint | Use **`POST /remember`**, not `/observe`. Body: `content` = redacted summary with a header line `graph:<id> repo:<r> surface:<s>`; `project=<repo>`; `agentId=<surface>`; `concepts=["graph:<id>","repo:<r>","surface:<s>"]`; `type` = `workflow` or `fact`. | `/observe` truncates to 400 chars, cannot take a per-request `agentId` (#1159), and caps sessions at 500 (§2) |
| D3 | agentId model | **Per-surface `agentId`** (ROADMAP SC2), with the substrate as the only writer holding the secret. Server scope `shared` (default) is enough. Optionally `isolated` + `AGENT_ID=substrate` to fail closed; then every read must send an explicit `agentId`. | Surface becomes filterable on the server for free. A single `agentId` would move surface into client-side filtering (§3) |
| D4 | Read endpoint | **`context_search` → `POST /search`** with `format:"full"` (or `narrative` + `token_budget`), `project=<repo>` when scoped, and `agentId:"*"` for cross-surface recall (the Phase 7 proof) or `<surface>`. Filter `graph_id` on the client from `concepts` after over-fetching. Amend SC1's "smart search" wording, or use smart-search plus a second `expandIds` call. | smart-search ignores `project` for results and its compact hits have no content, `agentId` or `concepts`. `/search` has been hybrid-ranked since 0.9.29 (§2, §3) |
| D5 | Outage on read | Fail open with the client's own deadline (`AbortSignal.timeout`, ≤ the brief's budget) → empty result + reason. Treat 5xx, 504, 401, `success:false` and a network error alike. | The server's own timeout is 180 s (§2) |
| D6 | Outage on write: spool or drop | **Drop and log, then reconcile.** No in-process spool. Keep a forwarded-id cursor, and replay missed records from Greptime, the source of truth. Replays are only near-idempotent, through Jaccard > 0.7 supersession in the same project [INFERENCE] (§2). | `/remember` has no idempotency key. A process-local spool is lost on restart, and Greptime already holds everything |
| D7 | Redaction | Extend `redact()` (or run a second pass) with agentmemory's classes the substrate misses: `AKIA`, `AIza`, `xoxb-`, `npm_`, `glpat-`, `dop_v1_`, `sk-proj-`, `pk-/rk-/ak-`, `<private>`, and a case-insensitive `api_key:`. Add a test fixture for them. | `/remember` applies no filter server-side (§4) |
| D8 | Payload cap | Cap each forwarded `content` on the client (e.g. ≤ 8 KB [INFERENCE: sizing]) and the number of `concepts`. | The server has no body cap; an over-frame payload drops the worker (§2) |
| D9 | Dragonfly TLS on Railway | **Feasible.** TLS on the main port: `--tls --tls_cert_file --tls_key_file` from non-`DFLY_` multiline variables, the password in `DFLY_requirepass`, no CA flag (a CA flag would force mTLS), no admin port, `--primary_port_http_enabled=false`, `--bind=::`, plus the cache flags. A private CA is pinned on the client, with SAN = `RAILWAY_TCP_PROXY_DOMAIN` (§6). | The TCP proxy is raw pass-through, and SC1 forbids a plaintext password (§6) |
| D10 | Redis client | **Bun's built-in `RedisClient`** on Bun 1.4.0, **no ioredis**. Options: `enableOfflineQueue:false`, `autoReconnect:true`, `connectionTimeout` about 1–2 s, `tls:{ca}`. Race every call against a 50–150 ms timer. Re-arm `connect()` from `onclose`. Use no-op handlers, never `null` (#29145). Optionally add a PING or breaker for half-open sockets. | `rediss://` + custom CA: yes. Per-command timeout: no, so wrap. Offline queue off → rejects in under 1 ms. Terminal failures stick until `connect()` (§7) |

## Open questions (RESOLVED for Phase 8 planning, 2026-09-27)

Items 1–6 are Phase 7 (agentmemory) questions and are resolved in Phase 7's plans. Items 7–21 are resolved for Phase 8 as marked below; the full plan/task mapping is in `COVERAGE.md` § "CONTEXT specifics, discretion and research open questions".

1. [§1–5 agentmemory] **Agentmemory version on the owner's Railway service:** unknown. A live check is not allowed here. The plan must gate on `GET /agentmemory/health` `.version >= 0.9.29`, not 0.9.28 (§1).
2. [§1–5 agentmemory] **Railway env for agentmemory** (`AGENT_ID`, `AGENTMEMORY_AGENT_SCOPE`, `EMBEDDING_PROVIDER`, LLM keys): unknown. They decide whether `/search` is hybrid or BM25-only, and whether an id-less read throws.
3. [§1–5 agentmemory] **Railway edge limits** (request size, rate limits, idle timeout) in front of `*.up.railway.app`: not documented in the sources read.
4. [§1–5 agentmemory] **Does `/agentmemory/sessions` or the viewer choke on the partial session rows that `session/end` on an unknown id creates (§2)?** The upsert itself is confirmed from source. How it renders was not traced.
5. [§1–5 agentmemory] **Supersession across unrelated records:** two substrate summaries with Jaccard > 0.7 in the same `project` supersede each other (`remember.ts:116-134`). Do near-identical summaries from different graphs collapse? If so, `graph_id` needs to be in `content` or `project` to keep them apart.
6. [§1–5 agentmemory] **Upstream #1159 (observe drops agentId) and #817 are both still OPEN.** Watch for behavior changes on upgrade.
7. **RESOLVED** (n/a — the VPS uses the public TCP proxy; `--bind=::` is in the start command anyway) — [§6 Dragonfly] **Is the owner's Railway environment new (≥ 2025-10-16, dual-stack) or legacy (IPv6-only)?** Only private networking cares, and `--bind=::` covers both. [Only the owner can see this: the Railway project is not visible from this host.]
8. **RESOLVED** (08-03 T1 (owner reports the Kernel/epoll/Max memory/threads log lines); `--proactor_threads=2` pins the floor) — [§6 Dragonfly] **What are Railway's container kernel and cgroup values?** They decide io_uring vs epoll, the auto `proactor_threads` count and the memory limit. Confirm from the first deploy log lines: "Kernel …", "switching to epoll", "Max memory limit is: …".
9. **RESOLVED** (08-07 T2/T3 (redeploy, domain compared); re-issue route in RESTORE.d/08-02.md (08-02 T3)) — [§6 Dragonfly] **Does `RAILWAY_TCP_PROXY_DOMAIN` stay stable across redeploys?** The cert SAN depends on it. If not, use a custom-domain CNAME, then SAN = custom domain; the tcp-proxy docs warn clients may reject a mismatched hostname.
10. **RESOLVED** (08-01 T2 spike (`ca_form_decision`); planning run: PEM text/Buffer/BunFile/[PEM] work, a path string is refused) — [§6 Dragonfly] **Does Bun 1.4.0's `tls.ca` take PEM text, a path or a `BunFile`?** The docs example shows a path string. The `SSLConfigFromJs` parsing was not read. Settle it with a throwaway `bun -e` check at plan time.
11. **RESOLVED** (avoided: only `DFLY_requirepass`; owner confirms no `DFLY_PASSWORD` (08-02 T2, 08-03 T1)) — [§6 Dragonfly] **Does `DFLY_PASSWORD` really abort startup** (`dfly_main.cc:1059-1060`)? This is inferred from source, not run. The plan uses `DFLY_requirepass`, so it matters only if the owner has already set `DFLY_PASSWORD`.
12. **RESOLVED** (08-07 T1 idle probe (`proxy_idle_timeout`)) — [§6 Dragonfly] **Railway TCP proxy idle-connection timeout.** Not documented. If it is shorter than Dragonfly's 300 s keepalive, Bun will reconnect silently. Measure it during the Phase 8 proof.
13. **RESOLVED** (deferred (CONTEXT § Deferred Ideas); no `--tls_ca_cert_file`) — [§6 Dragonfly] **mTLS (`--tls_ca_cert_file`) on top of `requirepass`** for defense in depth? It needs a client cert and key in `substrate.env`. This is an owner decision; the default above is password over server-auth TLS.
14. **RESOLVED** (08-03 T2 live smoke (`tls_ping=PONG` with the pinned CA)) — [§7 Bun] **Partly resolved by the peer.** Dragonfly v2.0.0 supports HELLO 3 and AUTH as `default`, reports 7.4.0, and uses bulk-string map keys that Bun's `proto` check skips (see Transport, above). Still open: a live smoke test of `new RedisClient("rediss://…proxy…", {tls:{ca}})` against the Railway TCP proxy.
15. **RESOLVED** (08-07 T1 (measured); idle closes become bypasses and autoReconnect + re-arm restore the socket (08-04 T2)) — [§7 Bun] Does the Railway TCP proxy close idle connections, and after how long? If it does, idle clients get closed from outside. That goes through the retry path (not terminal), so it works, but the first commands after an idle period may miss. It also makes half-open sockets more likely (question 6).
16. **RESOLVED** (not needed: the certificate names exactly the URL host (SAN = proxy domain, 08-02 T3)) — [§7 Bun] Is `tls.serverName` sent as SNI on Redis client sockets? The code only reads it back through `SSL_get_servername` for verification (`J:1806-1816`), and the dial passes the URL host (`V:207-215`). This matters only if the certificate name differs from the proxy hostname.
17. **RESOLVED** (avoided: 48-hex password, URL-safe (08-02 T3, `env_password_shape_ok`)) — [§7 Bun] Are URL userinfo characters percent-decoded (`J:619-623` uses `URL.username()`/`password()`)? This matters if the Railway password contains reserved characters.
18. **RESOLVED** (stay on 1.4.0; 08-01 records `bun-revision` and the spike must run on the same build) — [§7 Bun] Should we pin 1.4.0, or move to 1.4.1–1.4.3? Their changelogs were not reviewed for Redis fixes.
19. **RESOLVED** (breaker close()+re-dial (08-04 T2), `close_then_connect` observed in 08-01 T2, proven against a black hole in 08-06 T2) — [§7 Bun] Is it acceptable to have no half-open TCP detection, or should we add a periodic `PING` or the `close()`/`connect()` breaker?
20. **RESOLVED** (moot: offline queue off (08-04 T1), so no queued late writes) — [§7 Bun] Should write-through (`SET … EX`) be skipped while `!client.connected`, so that timed-out queued writes don't land late? This only matters if the offline queue stays on.
21. **RESOLVED** (n/a — no Railway-hosted consumer uses `*.railway.internal` in Phase 8) — [§7 Bun] Private DNS: legacy Railway environments are IPv6-only (per the peer). Does Bun resolve AAAA-only names? This was not verified, and it only matters if a Railway-hosted consumer uses `*.railway.internal`.
