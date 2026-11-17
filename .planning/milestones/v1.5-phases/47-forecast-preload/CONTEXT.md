---
phase: 47-forecast-preload
requirements: [SOTA-03]
status: designed on origin/main f2138e1; not yet implemented
---

# 47-CONTEXT: Predictive SLO rows and pattern-based cache preload

## Scope (ROADMAP and 7-SOTA plan, item 3)

Goal: time-series forecasting predicts SLO burn, and the Dragonfly cache pre-warms from observed patterns.
Acceptance: `/slo` has predictive rows; the cache preloads based on patterns.

## State on origin/main f2138e1 (scouted)

- `/slo` (`server.ts`, handler near lines 899 to 974) returns `results` (catalogue rows, `SloResult` in `observability/src/slo.ts`), `planes`, `burn`, `admission`, `docs`, `surfaces`, `capacity`, `served`, `indexArchive`, `railwayCost`, `history`. `breached` is folded from `results`, `planes` and `burn` only. Capacity, admission, docs, surfaces, served, indexArchive and railwayCost are report-only.
- Durable history: the opt-in metrics sampler (`SUBSTRATE_METRICS_HISTORY=on`, needs the ledger) writes `metric_samples` (Greptime, append mode). `GET /slo/history?series=...&window=...&step=...` answers from it (`metrics-history.ts`, `metricHistoryAnswer`). With history off, `/slo/history` answers 404 `{enabled: false}`.
- In-process rings (`CapacityRing`, `PlaneWindow`, `BurnLedger`) hold recent samples only, and are checkpointed to a file (`SUBSTRATE_SLO_CHECKPOINT`).
- Cache (`cache.ts`): `ReadThroughCache` with `getOrLoad`, `peek`, `put`, `bump`; keys `substrate:v1:<class>:<hash>`; classes and TTLs in `CACHE_TTL` (brief 300, memory-search 600, graph-view 60, brief-snapshot 3600, docs-search 300). No warm-up exists for brief, search or graph caches. The only proactive writer is the recall prefetcher (`recall-snapshot.ts`), default off.
- Constraints: `cache-conformance.test.ts` forbids `evalsha`, `publish`, `subscribe` and `blpop` in `cache.ts`. The cache-class list is closed (`cache-conformance.test.ts:14`). Every env read needs a flag row and a `.env.example` line (`flag-registry.test.ts`). No new event kind (`vocabulary-lock.test.ts`, EVENT_KINDS closed at 12).

## Decisions

- D47-a. Forecasts read the durable history, through the same reader `/slo/history` uses. They do not invent a time series from process memory. With history off the forecast rows say `history-off`, and no value is shown.
- D47-b. The model is Holt's double exponential smoothing (level and trend), with named constants alpha 0.5 and beta 0.3, a horizon of 60 minutes, and a minimum of 12 points (one hour at the 5-minute step). Fewer points is `insufficient-data`.
- D47-c. Predictive rows are report-only. They never enter `breached`, the same rule as capacity and railwayCost. A forecast row has `status` of `predicted-breach`, `ok`, `insufficient-data` or `history-off`, the predicted value at the horizon, the target, and the sample count.
- D47-d. Pattern-based preload: an in-process map counts brief requests per repo over a sliding hour, capped at 256 repos. A preloader, behind `SUBSTRATE_CACHE_PRELOAD=on` (default off), composes the brief for the top K repos (`SUBSTRATE_CACHE_PRELOAD_TOP`, default 3) every `SUBSTRATE_CACHE_PRELOAD_S` seconds (default 300), and writes through the existing cache put. No new cache class and no new key scheme.
- D47-e. The preloader owns at most one interval timer, unref'd, cleared on stop. A failed preload is logged by count and never affects a request.
- D47-f. No new event kind, no new tool, no change to `breached`.
- D47-g. Out of scope: Dragonfly pub/sub (phase 50), changing the SLO thresholds, and any live Dragonfly or Greptime proof (operator-gated).

## Acceptance mapping

- `/slo` has predictive rows: a `forecast` key with one row per catalogue SLO, computed from history by Holt smoothing; tests cover the trend math, a predicted breach, insufficient data, and `history-off`.
- The cache preloads based on patterns: tests cover the top-K selection, the off switch, a preload that writes through the cache put, and a failed preload that is counted and ignored.
