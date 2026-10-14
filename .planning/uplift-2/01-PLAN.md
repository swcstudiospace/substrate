# R1 plan — brief fast path and cache effectiveness

## Files touched
- `packages/mcp-server/src/brief.ts`: `composeBrief` starts the four source reads together, awaits them in output order under one shared deadline (`budgetMs`, 0 = none); a read past the deadline is a failed read (`failOpen`, stderr names the source and `deadline`); Greptime read gets `min(budget, remaining)` as its `sql()` timeout and `"ts" >= <now − recentWindowDays>`; `noteReadFailed(source)` per failed source (`BriefSource` = `graph|recent actions|open graphs|memory`); new `BriefOptions` fifth argument.
- `packages/mcp-server/src/cache.ts`: `CacheRedis.mget?` (Bun `RedisClient.mget` exists; fallback `Promise.all` of GETs), generation keys read in one round trip; `commandTimeoutMs`/`connectTimeoutMs` configurable (`SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`, `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS`, default 250, stale tailnet comment fixed); class `brief-snapshot` (`snapshotKey` without generation, `shapeOk` = `{text, at}`), `peek()`/`put()` for generation-free reads/writes through `attempt()`.
- `packages/mcp-server/src/service.ts`: `briefDetailed()` (text/state/failed/etag/snapshotAt), `brief()` = its text; snapshot written only when complete and freshly loaded, read only when degraded; heartbeat bumps only `graphGenerationKey`; private-field block `// uplift-2 R1`.
- `packages/mcp-server/src/server.ts`: `POST /brief` sets `ETag`, `X-Substrate-Brief`, `X-Substrate-Brief-Failed`, `Cache-Control: no-cache`, answers 304 on a weak `If-None-Match` match; `GET /healthz` body memoised for `healthzCacheMs` with `cachedAt`/`stale`.
- `packages/mcp-server/src/config.ts`: append-only `// uplift-2 R1` block (`briefBudgetMs`, `briefRecentWindowDays`, `briefSnapshotTtlS`, `cacheCommandTimeoutMs`, `cacheConnectTimeoutMs`, `healthzCacheMs`).
- `packages/collectors/src/muse.ts`: per-repo `etag` in the state file, `If-None-Match` on fetch, 304 → `unchanged` counter and no rewrite.
- Tests: new `packages/mcp-server/src/brief-fast-path.test.ts`; expectation updates in `brief.test.ts` (per-source `noteReadFailed`), `cache.test.ts` (snapshot SET counted), `muse.test.ts` (state shape) only where necessary.
- Docs: `docs/data-planes.md` (cache row, "The cache covers" paragraph), `docs/observability.md` (brief headers + healthz memo subsection, env table), `docs/collectors.md` (muse 304), `.planning/uplift-2/env-notes/01.md`, `01-SUMMARY.md`.

## Knobs (defaults; 0 switches off)
`SUBSTRATE_BRIEF_BUDGET_MS=1200`, `SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS=30`, `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=3600`, `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS=250`, `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS=250`, `SUBSTRATE_HEALTHZ_CACHE_MS=5000`.

## Tests (written, not run here)
reads start concurrently + output order; slow source → failed, brief returns under budget; budget 0 no deadline; ts bound in SQL; `briefDetailed` complete/degraded/snapshot + `failed`; ETag stable, 304 weak match, 200 otherwise, headers present; snapshot written only when complete, served only when degraded, banner, TTL 0 off; heartbeat bumps only the graph key; MGET one round trip; healthz memo within window / recompute after; muse 304 leaves file, stores tag.

## Rollback
`git revert` the R1 range; or `SUBSTRATE_BRIEF_BUDGET_MS=0`, `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=0`, `SUBSTRATE_HEALTHZ_CACHE_MS=0` without a code change (heartbeat scope and MGET have no switch; both are behaviour-preserving for readers).

## Verification (orchestrator)
`bun test packages/mcp-server packages/collectors`, `bunx tsc --noEmit`, `bun run verify`; post-deploy `/slo` `brief.p95`, `/healthz.cache` hit ratio, `substrate.request.duration{route=/healthz}`.
