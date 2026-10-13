# R1 summary — brief fast path and cache effectiveness

## What changed

- **Parallel reads under one budget** (`brief.ts`): `composeBrief` starts the four source reads together (index graph, ledger recent actions, index open graphs, index memory) and awaits them in section order, so an uncached brief costs its slowest source rather than the sum. A shared deadline (`BriefOptions.budgetMs`, from `SUBSTRATE_BRIEF_BUDGET_MS`, default 1200, `0` = none) races every read; a read that misses it is a failed read — stderr `brief: <source> unavailable — deadline (<n> ms brief budget)`, section omitted, brief still returned. The Greptime read passes the budget as its `sql(stmt, timeoutMs)` and its statement now carries `AND "ts" >= '<ISO of now − SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS days>'` (`recentActionsSql`, exported for tests; SQL stays in `brief.ts`). `noteReadFailed(source)` is called once per failed source in section order after every read settled (`BriefSource` = `graph | recent actions | open graphs | memory`, `BRIEF_SOURCES`). A source whose call throws synchronously is a failed read too.
- **Degraded header, ETag, 304** (`service.ts`, `server.ts`): `Substrate.briefDetailed(request)` returns `{ text, state: complete|degraded|snapshot, failed, etag, snapshotAt }`; `brief()` returns its `text` (MCP `memory_brief` unchanged). `etag = W/"<first 32 hex of sha256(text)>"` (`briefEtag`). `POST /brief` sets `ETag`, `X-Substrate-Brief`, `X-Substrate-Brief-Failed` (when non-empty), `Cache-Control: no-cache`, and answers **304 with no body** when `If-None-Match` lists the tag by weak comparison (`etagMatches`, `*` honoured). Degraded/snapshot stay 200. `auditedRest` and the audit record are untouched.
- **Last-good snapshot** (`cache.ts`, `service.ts`): new class `brief-snapshot` (`CACHE_TTL` 3600), generation-free key `snapshotKey()` = `substrate:v1:brief-snapshot:<sha256(canonical({surface,args}))>`, `shapeOk` requires `{text: string, at: string}`; `ReadThroughCache.peek()`/`put()` go through `attempt()` and the gated client and never throw. Written only when a brief was composed complete **and** loaded live (a cache hit writes nothing — no SET per hit); read only when the live compose degraded and `briefSnapshotTtlS > 0`; served as `_(substrate brief snapshot from <ISO>; live sources degraded: <names>)_` + snapshot text, state `snapshot`. Degraded text is never stored anywhere.
- **Targeted invalidation** (`service.ts` `heartbeatNode`): a successful heartbeat bumps only `graphGenerationKey(graphId)`; the comment records why (a renewed lease changes no repo-brief text before its `refreshAt`; the shared bump was the 1 % hit ratio). Claims, releases, completions, registrations and the reaper keep `bumpGraph` (both keys).
- **Fewer cache round trips** (`cache.ts`): generation keys are read with one `MGET` (`CacheRedis.mget?` — Bun 1.4 `RedisClient.mget(...keys)` confirmed in `bun-types/redis.d.ts`); a client without it is read with concurrent GETs under the same single `attempt()` budget. `COMMAND_TIMEOUT_MS`/`CONNECT_TIMEOUT_MS` are now 250 (stale tailnet-RTT comment replaced) and overridable via `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS` / `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` (`config.cacheCommandTimeoutMs` / `cacheConnectTimeoutMs`, threaded through `createReadThroughCache` → `bunRedis({ connectTimeoutMs })` / `ReadThroughOptions.commandTimeoutMs`).
- **Cheap `/healthz`** (`server.ts`): the computed body and status are memoised per server for `config.healthzCacheMs` (`SUBSTRATE_HEALTHZ_CACHE_MS`, default 5000, `0` = off) using `options.now`; the body gains `cachedAt` (ISO) and `stale` (true when served from the memo); status comes from the memoised body via the unchanged `healthStatus`. `/metrics` and `/slo` untouched.
- **Muse collector** (`collectors/src/muse.ts`): `RepoRecord.etag` persisted in the state file (bounded to 256 chars on load), sent as `If-None-Match` while `BRIEF.md` still exists; `fetchBrief(slug, branch, etag)` returns the new `FetchedBrief` union (`unchanged: true` on a 304 to a sent tag; a 304 with no tag sent is `http_304`); on 304 `pass` counts the new `unchanged` counter, records `last_success`, and does not touch `BRIEF.md`; on 200 the tag is stored (or dropped if the server sent none). Pointer/exclude handling unchanged.
- **Config** (`config.ts`, append-only `// uplift-2 R1` block): `briefBudgetMs`, `briefRecentWindowDays`, `briefSnapshotTtlS`, `cacheCommandTimeoutMs`, `cacheConnectTimeoutMs`, `healthzCacheMs`; `nonNegativeOr` (0 allowed = off; empty string keeps the default) and `positiveOr` (0 / junk → default).
- **Docs**: `docs/data-planes.md` (cache row, DragonflyDB wiring row, "The cache covers" paragraph: MGET, heartbeat scope, never-store-degraded, snapshot class), `docs/observability.md` (new section "Brief headers and the memoised `/healthz`", routes row, six env rows), `docs/collectors.md` (state-file row, muse ETag paragraph, recorded-gap paragraph).

## Files

Created: `packages/mcp-server/src/brief-fast-path.test.ts`, `packages/collectors/src/muse-etag.test.ts`, `.planning/uplift-2/01-PLAN.md`, `.planning/uplift-2/01-SUMMARY.md`, `.planning/uplift-2/env-notes/01.md`.
Modified: `packages/mcp-server/src/brief.ts`, `cache.ts`, `config.ts`, `server.ts`, `service.ts`, `brief.test.ts`, `cache.test.ts`, `packages/collectors/src/muse.ts`, `docs/data-planes.md`, `docs/observability.md`, `docs/collectors.md`.

## Existing test expectations changed (each necessarily broken by this item)

- `brief.test.ts` "never throws when a store fails": `noteReadFailed` now fires once per failed source → asserts `["graph", "open graphs", "memory"]` instead of a count of 1.
- `cache.test.ts` "brief matches": `on.sets` 1 → 2 (brief entry + snapshot). "a brief built while a source read fails is not cached": final `redis.sets` 1 → 2 (recovered brief + snapshot; the degraded pass still writes 0). "a brief's TTL stops at the next lease expiry": `ttls` length 1 → 2, `ttls[1]` = `CACHE_TTL["brief-snapshot"]`. "the budgets are pinned to 800 ms" → 250 ms. The fake RESP server (`takeCommands`) learned `MGET`, since the real client now issues it for generation keys.
- `http.test.ts`: no expectation changed (healthz tests use `toMatchObject`; brief tests read status/text only).

## Knobs

| Variable | Default | `0` |
| --- | --- | --- |
| `SUBSTRATE_BRIEF_BUDGET_MS` | 1200 | no deadline (client default timeouts apply) |
| `SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS` | 30 | falls back to 30 (must be > 0) |
| `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` | 3600 | no snapshot written or read |
| `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS` | 250 | falls back to 250 (must be > 0) |
| `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` | 250 | falls back to 250 (must be > 0) |
| `SUBSTRATE_HEALTHZ_CACHE_MS` | 5000 | recompute per call |

## Tests added (written, not run here)

`brief-fast-path.test.ts`: all four reads start before any finishes (gated fakes, released in reverse order) and section order holds; a source slower than the budget is reported failed, stderr names it and `deadline`, the brief returns inside the budget; budget 0 disables the deadline; recent-actions SQL carries the `ts` bound and the budget as timeout (undefined with budget 0); `briefDetailed` complete/degraded/snapshot with `failed` names, stable etag, banner first line, no SET per cache hit, degraded never stored; TTL 0 writes/reads no snapshot; cache down never fails the brief; heartbeat bumps only the graph key (spy on `cache.bump`) and a refused heartbeat bumps nothing; one `MGET` per `getOrLoad` and concurrent GETs without it (parked-until-all-three fake); `etagMatches` weak/list/`*`; over HTTP: headers, 304 on weak match (and on the strong form), 200 otherwise, degraded 200 with `X-Substrate-Brief-Failed: graph,memory`; `/healthz` memo within the window (`stale: true`, same `cachedAt`, one ping), recompute after, `0` recomputes per call, `/metrics`/`/slo` still served; config defaults/0/junk.
`muse-etag.test.ts`: tag stored from a 200, sent back, 304 leaves `BRIEF.md` mtime and bytes untouched and counts `unchanged`; a new 200 replaces file and tag; a deleted `BRIEF.md` is fetched without the tag; a server without ETags behaves as before; `fetchBrief` 304-without-tag is `http_304`; state file round-trips the tag and drops an over-long one.

## Rollback

`git revert` the R1 range; or without a code change `SUBSTRATE_BRIEF_BUDGET_MS=0` (no deadline), `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=0` (no snapshots), `SUBSTRATE_HEALTHZ_CACHE_MS=0` (fresh health per call), `SUBSTRATE_CACHE_*_TIMEOUT_MS=800` (old budgets). The heartbeat scope, MGET and the headers have no switch: each is behaviour-preserving for existing readers (a 304 is only sent to a caller that offered a tag).

## Deviations and why

- **`ts` bound literal**: the assignment asked for an epoch-ms literal; the statement uses the quoted ISO form (`"ts" >= '2026-…Z'`) because that is the comparison `queryEvents`/`eventsByIds` already run against the live ledger and the only form attested against GreptimeDB's TIMESTAMP column here. Cannot be verified against a store from this worktree; the ISO form is the lower-risk choice.
- **`noteReadFailed` arity**: called once *per failed source* (not once per brief) so `failed` can be reported; the callback type `(source: BriefSource) => void` still accepts the old no-arg callbacks, but the one existing test that counted calls was updated (listed above).
- **Snapshot write placement**: written by `briefDetailed` after `getOrLoad` (awaited, bounded by the cache command timeout) rather than inside `getOrLoad`, and only on a live load, so a cache hit costs no extra round trip.
- **`peek()` with the cache off** does not count a bypass (the brief's own `getOrLoad` already counted one), so the hit-ratio metric is not skewed by degraded briefs.
- **Cache fake in tests**: `CacheRedis.mget` is optional so the existing `FakeRedis` fakes keep working through the concurrent-GET fallback.
- **`.env.example` / `README.md`** untouched per the rules; the block is in `env-notes/01.md`.

## Before / after (BASELINES.md rows)

| Row | Baseline | After |
| --- | --- | --- |
| `GET /slo` → `brief.p95` | 3,116 ms vs 800 (4.08 % in target) | post-deploy measurement pending; by construction an uncached brief ≈ max(source latency) and ≤ `SUBSTRATE_BRIEF_BUDGET_MS` + cache time (unit: a hung source with budget 60 ms returns in < 600 ms) |
| cache hits / misses | 8 / 793 (≈1 %) | post-deploy measurement pending; heartbeats no longer bump `gen:graphs`, muse 304s skip the body (unit: hit path writes nothing, heartbeat bumps one key) |
| muse mean brief | 2,280 ms | post-deploy measurement pending; expected a cache hit or 304 on most passes |
| `/healthz` muse 739 calls · mean 598 ms | one Greptime + one Postgres round trip per call | post-deploy measurement pending; memoised for 5 s per process (unit: one index ping per window) |
| cache command / connect timeout | 800 ms | 250 ms (code constant + env) |

## Gates

(filled by orchestrator)
