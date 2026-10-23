---
phase: 47-forecast-preload
requirements: [SOTA-03]
status: planned; units U1 and U2 run in parallel, U3 follows
---

# 47-PLAN: Predictive SLO rows and pattern-based cache preload

## Units (disjoint files)

### U1 — forecast rows on /slo

Files: `packages/observability/src/forecast.ts` (new), `packages/observability/src/forecast.test.ts` (new), `packages/mcp-server/src/server.ts` (the `/slo` handler only), and a `packages/mcp-server/src/metrics-history.ts` export only if the handler needs a function that is not yet exported.

- `forecast.ts`: pure functions. `holtForecast(points, horizonSteps, alpha, beta)` returns the level, the trend and the value at the horizon. `forecastRow(id, target, direction, points, horizonSteps)` returns `status` (`predicted-breach` when the horizon value crosses the target in the SLO's direction, `ok` otherwise, `insufficient-data` below 12 points) plus `predicted`, `target`, `samples`. Constants alpha 0.5 and beta 0.3, a 60 minute horizon, a minimum of 12 points.
- `/slo` gains a `forecast` key: one row per catalogue SLO, built from the history reader. When history is off, every row is `history-off` and carries no value. The key is never folded into `breached`.
- Tests in `forecast.test.ts`: a linear series recovers its slope exactly; a rising latency series predicts a breach at the horizon; a flat series predicts ok; fewer than 12 points is insufficient-data; NaN or empty input is insufficient-data, never a number. Add one `/slo` HTTP test that the forecast key exists and that `breached` does not change when a forecast predicts a breach.

Acceptance: the forecast tests pass; `/slo` gains the key and its breached rule is unchanged.

### U2 — pattern-based preload

Files: `packages/mcp-server/src/preload.ts` (new), `packages/mcp-server/src/preload.test.ts` (new), `packages/mcp-server/src/config.ts` (the cache settings section only), `packages/mcp-server/src/flag-registry.ts` (new rows only), `.env.example` (new lines only), `packages/mcp-server/src/service.ts` (one call at the brief path, to record a request) if needed for the hook.

- `preload.ts`: `RepoAccess` (bounded map, cap 256, sliding hour) with `record(repo, now)` and `topRepos(k, now)`; `startPreloader({ settings, access, compose, now, intervalMs })` returns `{ stop }`. The interval timer is unref'd. Each tick takes the top K repos and calls `compose(repo)`, which writes through the existing cache put. A failure increments a counter and is logged once per tick, never thrown.
- Settings: `SUBSTRATE_CACHE_PRELOAD` (on or off, default off), `SUBSTRATE_CACHE_PRELOAD_TOP` (1 to 20, default 3), `SUBSTRATE_CACHE_PRELOAD_S` (10 to 3600, default 300). Parse as the other cache settings are parsed; an out-of-range value is a configuration error naming the variable.
- Tests in `preload.test.ts` with a fake clock and fake compose: top-K order by count within the hour; repos older than an hour drop out; the cap evicts the least recent; the off switch starts no timer; a tick calls compose for exactly the top K; a compose failure is counted and the next tick still runs; stop clears the timer.

Acceptance: the preload tests pass; with the switch off, no timer exists and no compose call is made.

### U3 — documentation and generated reference

Files: `docs/observability.md` (the SLO section: forecast rows), `docs/data-planes.md` (the cache section: preload), `docs/config-reference.md` (regenerated, not hand-edited).

- Document the forecast method and its limits (history-dependent, report-only, 60 minute horizon, 12-point minimum), and the preload switch, top K, interval, and that preload writes through the existing cache only.
- Regenerate the config reference (`bun run config:reference`) and check it (`-- --check`).

Acceptance: the config reference check passes; the docs describe exactly what the tests pin.

## Orchestrator gates (after U1, U2 and U3 land)

- `bunx tsc --noEmit` exit 0.
- Full `bun test` against a phase-47 verification database, plus `bun run check:phase-close`.
- `bun run config:reference -- --check` exit 0.
- Records: CONTEXT, PLAN, SUMMARY, VERIFICATION under `.planning/phases/47-forecast-preload/`.
