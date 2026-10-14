# S4 Cache: single-flight, stale-while-revalidate and per-class metrics (plan, trimmed)

Worktree `/root/src/repos/.wt/u4-s4`, branch `u4/s4`. Evidence: `recon-3-C-cache.md`; spec S4 in `uplift-4-PROPOSAL.md`.

## Target
`packages/mcp-server/src/cache.ts` (+ test), `service.ts` (call-site options, stale branch only), `server.ts` (one header line), `config.ts` (env), `packages/observability/src/instruments.ts` (+ test), `scripts/cache-stats.ts` + test (new), `docs/data-planes.md`, `infra/vps/README.md`.

## Change
1. Single-flight in `getOrLoad` by final key; reject or degraded never poisons the map; cap 256; count `coalesced`.
2. `SUBSTRATE_CACHE_SWR=off|shadow|enforce` (default shadow), `SUBSTRATE_CACHE_SWR_WINDOW_S` (30, max 300). Generation-bump miss + last-good younger than window: enforce serves it and refreshes once in the background (max 16), shadow counts `would_serve_stale` and serves live, off does nothing. The brief reuses `brief-snapshot`; memory-search, docs-search, graph-view stay single-flight only. Advertise with `x-substrate-brief-age`; `complete|degraded|snapshot` unchanged.
3. `substrate.cache.operations{class,result,mode}`, class from the closed `CACHE_CLASSES`, result in hit|miss|coalesced|stale|refresh|would_serve_stale|bypass|error.
4. `bun scripts/cache-stats.ts`: bounded read-only census (SCAN/TYPE/STRLEN/INFO), `classOf(key)`, recommended maxmemory, loopback-only unless `--allow-remote`.
5. Docs: idle Railway Dragonfly = operator decision; `volatile-lru` not expressible on Dragonfly, VPS cache stays redis.

## Acceptance
N concurrent misses load once; a rejecting loader does not poison; in-flight cap holds; shadow counts without serving stale; enforce serves stale in the window, refreshes once, never stores degraded as last-good, loads fresh after the window; off/shadow parity with no-SWR; cache errors fail open; cache-stats respects budgets with a fake client and never reads values.
