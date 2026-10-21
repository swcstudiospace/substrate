---
phase: 47-forecast-preload
requirements: [SOTA-03]
status: in review (draft PR). In-repo gates green. The live forecast accuracy and the live Dragonfly warm-up are not exercised
---

# 47-SUMMARY: Predictive SLO rows and pattern-based cache preload

## Built

- **Forecast rows on /slo (U1).** `/slo` gains a `forecast` key with one row per objective (`brief.p95`, `emit.success`, `lease.steal_rate`, `quarantine.rate`). The model is Holt's double exponential smoothing (alpha 0.5, beta 0.3), a 60-minute horizon, a 2h window at a 300-second step, and a minimum of 12 finite points. Statuses are `predicted-breach`, `ok`, `insufficient-data` and `history-off`. The history comes from the same reader `/slo/history` uses, so no second series is read. With history off, every row says `history-off` and carries no value.
- **Report-only.** The forecast never enters `breached`. A test pins that the breached list is identical with history off and with a predicted breach.
- **Cache preload (U2).** `SUBSTRATE_CACHE_PRELOAD` (default off), `SUBSTRATE_CACHE_PRELOAD_TOP` (1 to 20, default 3), and `SUBSTRATE_CACHE_PRELOAD_S` (10 to 3600, default 300). The access map counts brief requests per repo over a sliding hour (256-repo cap, least recently seen evicted) and remembers the last surface per repo. Each interval it composes the brief for the top K repos through `briefUncounted`, which writes through the existing brief cache and never counts itself.
- **Wiring.** `startPreload` runs from `startRecall`, which the entry point calls at listen, and `stopPreload` runs at shutdown. A tick is skipped while the previous tick is still running. A failed warm-up is counted and logged once per tick and never thrown.
- **Docs.** `docs/observability.md` gains "Predictive SLO rows"; `docs/data-planes.md` gains "Cache preload"; the config reference is regenerated and checked.

## Decisions

- D47-a to D47-g in CONTEXT.md. Forecasts read durable history, and with history off they show nothing invented. Preload composes through the existing brief path.

## Deviations (from the plan, with reasons)

- **Observability export.** `packages/observability/src/index.ts` gains one export block for `forecast.ts`. This was requested by the unit and approved by the orchestrator, since the package has explicit exports.
- **Test file outside the list.** The forecast `/slo` test lives in `slo-history.test.ts`, the existing `/slo` HTTP test file, as the plan's own fallback allowed.
- **Compose refactor.** The brief compose moved into `briefUncounted`, unchanged apart from the observation gates. `briefDetailed` records once and then calls it. This keeps the warm-up from counting itself.
- **Start point.** The preloader starts through `startRecall`, not from the entry point directly. The entry point already calls `startRecall` unconditionally, so this holds. The coupling is recorded here, and `startPreload` is idempotent in case a second caller is added later.
- **Boot refusal.** A switch value other than on or off refuses boot through the existing `ConfigError` path (exit 78). The plan asked for a configuration error on out-of-range values only.
- **Extra bounds.** Each repo keeps at most 4096 request times, and a tick is skipped while the previous one runs. Both are the unit's additions and are documented.

## Review points

- **Surface as its own bearer.** The warm-up composes with the surface last named for the repo, as that surface's own bearer, so the warmed keys are the keys a real request reads. The consequence: the warm-up performs that surface's recall reads for its own bank, at most K per interval. Any authenticated caller can name a surface, so this is a bounded amplification of traffic the caller could already send. It is documented in data-planes.md.
- **Holt with gaps.** Missing buckets are not filled, and Holt treats the values as evenly spaced, so a gap distorts the trend. This is documented, not fixed.
- **Two objectives have no series.** `lease.steal_rate` and `quarantine.rate` have no history series, so they are always `insufficient-data`.

## Verified in-repo

- Typecheck: `bunx tsc --noEmit` exit 0.
- Targeted: `forecast.test.ts`, `preload.test.ts`, `slo-history.test.ts` (11 pass), and `brief-recall.test.ts` pass.
- Full suite: `bun test` 5916 pass, 2 skip (pre-existing), 0 fail, over 5918 tests in 221 files, on the review-fixed tree.
- Repo locks: `bun run check:phase-close` green. Config reference: up to date.

## Review round (PR 100)

- **Request shape.** The warm-up composes with the last brief request per repo, its branch and graph_id included, so the warmed key is the key a matching real request reads.
- **Refresh, not hit.** A warm-up always composes and stores, through a `refresh` option on `getOrLoad` that skips the fresh-hit read. This also skips stale-while-revalidate for that call, since otherwise a fresh entry in that window would still be served without a compose. The option is the only change to `cache.ts`, and it is tested.
- **Cache required.** `SUBSTRATE_CACHE_PRELOAD=on` with no cache is a `ConfigError` at boot.
- **Basis.** Each forecast row says `service` or `worst-surface`. `brief.p95` is the worst surface per bucket, and the row says so.
- **Failed warm-ups count.** A warm-up that composes degraded is counted and logged as a failure.
- **Doc links.** The three preload flag rows point at `docs/data-planes.md`.

## Not proven

- The forecast accuracy on real history. The tests prove the arithmetic and the statuses on fixed series.
- The live warm-up effect on Dragonfly. The tests use a fake compose and fake timers.

## Cleanup

- The worktree `/root/pr-fix/v147-forecast` stays until close-out, with the other phase worktrees, after the user approves cleanup.
