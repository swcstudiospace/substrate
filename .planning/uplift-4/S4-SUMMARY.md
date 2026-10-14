# S4 Cache: single-flight, stale-while-revalidate, per-class metrics (summary)

Edited only; nothing was run. Branch `u4/s4`, worktree `/root/src/repos/.wt/u4-s4`.

## What changed
- `packages/mcp-server/src/cache.ts`
  - **Single-flight** inside `getOrLoad`: `Map<finalKey, flight>`; the flight (`loadStore`: load, `store` check, SET) is registered synchronously after a miss and deleted in a `finally` when its promise settles (resolved, degraded or rejected). Cap `MAX_INFLIGHT` 256 (beyond it a request loads independently); a flight older than `FLIGHT_MAX_AGE_MS` (15 s) is not joined and is replaced, so a hung loader cannot capture later callers. Waiters get a `structuredClone`. A waiter on a flight whose owner's `store` refused the value (a degraded brief) loads for itself (the `failed` list belongs to the owner's closure). A rejected load rejects every waiter and leaves nothing registered. Cache off, generation-read failure, GET failure, and the stale-generation bypass do not coalesce (no key, or already bypassing).
  - **SWR**: `ReadThroughOptions.swr {mode, windowS}`; per-call `request.swr` = `StaleServing<T>` (`lastGood`, `refresh`, `served`). On a non-malformed miss: `lastGood()` (via new `peekQuiet`, which does not count hit/miss) must be younger than the window, not in the future and not past its `untilMs`. `enforce`: count `stale`, call `served`, start one background refresh (`startRefresh`: skipped if a live flight exists, in-flight cap or `MAX_REFRESHES` 16 reached; raced against a `flightMaxAgeMs` deadline with an unref'd timer cleared in `finally`; errors swallowed and counted), return the stale value. `shadow`: count `would_serve_stale`, serve live. `off`, or no `swr` on the request: nothing. A refresh's `store` refusing the value means neither the key nor `stored` (the last-good write) happens.
  - `CacheResult` gains `coalesced|stale|refresh|would_serve_stale`; `CacheSample.cacheClass`; `CACHE_CLASSES`, `CacheKeyClass`, exported `classOf(key)`; `CacheHealth` gains optional `coalesced|stale|wouldServeStale|refreshes`; every `count`/`fail` takes a class (`bump` failures are `gen`, `script` failures `budget`).
- `service.ts`: `briefDetailed` composes through a local `compose(noted, failed)` used by the foreground load and by each refresh (a refresh has its own `failed`/`noted`, so it never touches the caller's state); `swr` option only when `briefSnapshotTtlS > 0`; snapshot payload gains `until` (epoch ms of the lease/reverify deadline, from `noted`); the foreground snapshot write is unchanged except it calls the shared `keep`. `BriefDetail.ageS?` (present only when served stale; `state` stays `complete`).
- `server.ts` + `mcp.ts`: `x-substrate-brief-age` on `POST /brief` (200 and 304) and `age_s` in the MCP `memory_brief` `structuredContent` (fresh and `not_modified`, outputSchema and description updated), both only when `ageS` is set.
- `config.ts`: `cacheSwr`, `cacheSwrWindowS` (append-only block `// uplift-4 S4`).
- `packages/observability/src/instruments.ts`: `recordCache` adds label `class` (closed `CACHE_METRIC_CLASSES`, else `unknown`); `CACHE_METRIC_RESULTS`. Existing consumers select by `result`/`mode` only (no SLO or dashboard reads this counter; grep), so nothing needed to change.
- `scripts/cache-stats.ts` (new) + `scripts/cache-stats.test.ts`.
- Docs: `docs/data-planes.md` (DragonflyDB rows 14 and 74, the single-flight/SWR paragraph), `infra/vps/README.md` (sizing paragraph), `docs/observability.md` (metric row, `X-Substrate-Brief-Age`, the two env rows, one cache-stats sentence).

## Flags and defaults
`SUBSTRATE_CACHE_SWR=shadow` (default), `SUBSTRATE_CACHE_SWR_WINDOW_S=30` (max 300). Single-flight is always on. See `env-notes/S4.md`.

## Decisions from evidence
- Last-good only for the **brief** (`brief-snapshot`, already written on every live complete compose). memory-search, memory-recall, graph-view and docs-search are single-flight only: no generation-free store exists, and serving a pre-write memory or docs answer breaks read-your-writes for tools whose whole point is the write.
- "Miss caused by a bump" is detected as "miss with a last-good younger than the window" (the generation is not in the snapshot). A TTL-expiry miss cannot have one unless the window approaches the 300 s brief TTL.
- `would_serve_stale` is an eighth result value (the spec listed seven) so the shadow numbers are readable from the same counter.

## Failure behaviour
Cache errors stay fail-open (bypass, load from source). A failing/throwing `lastGood` probe, `served` hook or `stored` hook never fails the call. In `enforce` a stale brief can hide a source outage for up to the window (the refresh's degraded result is discarded); in `off`/`shadow` read-your-writes is unchanged. Shadow costs one extra GET per brief miss.

## Rollback
`SUBSTRATE_CACHE_SWR=off` (restart). Single-flight has no flag; reverting `getOrLoad` is a code revert.

## Verify (main agent)
```
bunx tsc --noEmit
bun test packages/mcp-server/src/cache.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/memory-expiry-cache.test.ts packages/mcp-server/src/docs-plane-hardening.test.ts packages/mcp-server/src/http.admission.test.ts
bun test packages/observability scripts/cache-stats.test.ts
bun test
```
Tests added: `cache.test.ts` (single-flight x6, stale-while-revalidate x10 incl. off/shadow parity and refresh deadline, classOf), `instruments.test.ts` (recordCache labels), `cache-stats.test.ts`.

## Residual risks
- Nothing was executed; type and test errors are possible (notably the generic inference of `swr` in `briefDetailed`, and any existing test that fires concurrent identical loads expecting separate loads).
- A degraded flight is not shared: during a source outage duplicate loads continue exactly as before.
- Waiters share the owner's rejection.
- The refresh closure of the first caller is not reused; each refresh builds fresh state from `swr.refresh()`.
- Process-local only (single `substrate-mcp` process assumed).
- I briefly edited `/root/src/repos/agent-substrate/packages/mcp-server/src/cache.ts` with a relative path, then restored it byte-for-byte from `git show 76c3f39:...` (only that file; other modified files in the shared checkout are not mine).
