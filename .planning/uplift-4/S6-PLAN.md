# S6 plan — GreptimeDB: durable, queryable metrics history with a TTL

## Target
`packages/mcp-server/src/greptime.ts` (+ test), `observe.ts` (hook only), NEW `metrics-history.ts` (+ test), `config.ts`, `server.ts` (the `GET /slo/history` route and its registration only), `docs/observability.md`. Wiring that the item needs outside that list: `index.ts` (start/stop/flush the sampler), `admission.ts` (one `ROUTE_CLASSES` row so the route-table test stays exhaustive).

## Change
1. `metric_samples` (`ts` TIME INDEX, `series`, `labels`, `kind`, `value` DOUBLE, `count` BIGINT; `append_mode`, `ttl` in the `CREATE`), created on first use, idempotent. TTL from `SUBSTRATE_METRICS_HISTORY_TTL` (default 14d, 1d..90d, strict pattern before it is in SQL). `create` is already an allowed verb, so `assertAppendOnly` is unchanged.
2. `recordMetricSamples(rows)`: one multi-row INSERT per interval (cap 200), literals through the dialect-aware `q`, through the plane gate with the deadline inside, fail-open: the batch is dropped and counted `substrate.metrics.history.dropped{reason}` (closed reasons).
3. Sampler (`metrics-history.ts`): `SUBSTRATE_METRICS_HISTORY=off|on` (default off), `..._INTERVAL_S` (60, min 15); fixed allow-list of 11 series; counters as deltas with reset detection, histograms as p50/p95/count; single-flight, unref'd timer cleared on shutdown, final flush awaits the in-flight write.
4. `readMetricHistory({series, fromMs, toMs, stepS})`: allow-listed series, window capped at the TTL, at most 2000 points (`date_bin`, ORDER BY, LIMIT), gated. `GET /slo/history?series=&window=&step=`: 404 `{enabled:false}` when off, 400 for a bad series/window/step, JSON points otherwise, labels only from the closed set.
5. `docs/observability.md`: why this sink, the table and TTL, rate/size estimates, the 500 MB vs 5 GB volume conflict as an operator note, rollback.

## Acceptance
DDL idempotent and TTL validated (hostile strings rejected); hostile label/series text cannot break out of a literal; breaker open or Greptime down drops the batch with a counted reason and never throws; a counter reset yields a non-negative delta; the sampler never overlaps itself, the final flush awaits the in-flight write, timers are cleared; `/slo/history` disabled, bad series, bad window and a valid read with the point cap; flag-off parity (no table creation, no timer, no route payload).
