# S6 summary — durable, queryable metrics history

## What changed
A flag-gated sampler writes deltas of an 11-series allow-list into `metric_samples` (GreptimeDB, `append_mode`, TTL in the `CREATE`), and `GET /slo/history` reads it back aggregated. Default off: no timer, no table, no drop counter, `/slo/history` answers `404 {"enabled":false}`.

Series: `brief.p50`, `brief.p95` (per surface, closed list, else `other`), `emit.success`, `emit.p95`, `plane.availability`, `plane.p95` (per plane), `cache.hit_ratio`, `admission.decisions` (per decision), `docs.search` (per outcome), `docs.p95`, `capacity.runway_days`.

## Files
- `packages/mcp-server/src/metrics-history.ts` (new): allow-list (`METRIC_SERIES`), `canonicalLabels`/`readLabels`, `counterDelta`/`bucketDeltas`, `SampleCollector`, `MetricsHistorySampler`, `registerMetricsHistoryMetrics`, window/step parsers, `metricHistoryAnswer`.
- `greptime.ts`: `GreptimeBreakerOpen` (subclass of `GreptimeUnavailable`, thrown for an open breaker), `recordMetricSamples`, `readMetricHistory`, lazy single-flight `ensureMetricSamples`, `METRIC_SAMPLES_TABLE`, result/query types. `assertAppendOnly` and `APPEND_ONLY_VERBS` unchanged (`create` already allowed).
- `config.ts`: `metricsHistory` settings, `parseMetricsHistoryTtl`, `loadMetricsHistorySettings`.
- `observe.ts`: `/slo/history` in `KNOWN_ROUTES`; registers the drop counter before the registry is seeded, only when the flag is on.
- `server.ts`: the route and its `ANONYMOUS_ROUTES` entry. `admission.ts`: one `ROUTE_CLASSES` row (`read`), because `admission.test.ts` requires every served route to be classified. `index.ts`: builds, starts, stops and flushes the sampler beside the notifier (outside the stated Target; the sampler needs the ledger client, which `observe.ts` does not hold).
- `docs/observability.md`; tests `greptime.test.ts`, `metrics-history.test.ts`.

## Flags and defaults
`SUBSTRATE_METRICS_HISTORY` off; `SUBSTRATE_METRICS_HISTORY_INTERVAL_S` 60 (15..3600); `SUBSTRATE_METRICS_HISTORY_TTL` 14d (`1d`..`90d`, strict `^[1-9][0-9]{0,2}d$` then range check; invalid falls back to 14d with a boot warning). See `env-notes/S6.md`.

## Failure behaviour
Per-interval multi-row INSERT (cap 200), through the plane gate; the 3 s deadline is the `AbortSignal` inside the gated call, so a timeout counts as a breaker failure and an open breaker costs no network. Any failure drops the whole batch and counts `substrate.metrics.history.dropped{reason}` (rows): `breaker_open|unavailable|rejected|ddl|schema|invalid|capped|internal` (`schema`: an existing table without append_mode is refused after a live SHOW CREATE TABLE check and named once; only an operator drops it). A CREATE that fails is not remembered, so the next tick retries it. A tick during a slow write joins it (the deltas accumulate), so only a failed batch loses data. `recordMetricSamples` and the sampler never throw; the route maps store failures to `503` with a fixed message. Only the sampler's write creates the table; a read is one SELECT with its own 2.5 s deadline.

## Rollback
Flag off and restart. The table stays and expires on its TTL; `DROP` stays an operator action (the client refuses it). Turning the flag off after it was on logs one "metric(s) this release does not record" boot line for the drop counter the checkpoint still carries.

## Verify (orchestrator)
```
bunx tsc --noEmit
bun test packages/mcp-server/src/metrics-history.test.ts packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/observe.test.ts packages/mcp-server/src/config.test.ts packages/mcp-server/src/http.test.ts
bun run check:phase-close
```
Nothing was run by this lane (edit-only assignment).

## Residual risks
- The SQL (`date_bin(INTERVAL '<n> seconds', "ts")`, `GROUP BY "bucket"` by alias, `PRIMARY KEY ("series")` with `append_mode`, `TTL` in CREATE on a table with a primary key) is written from Greptime's documented dialect and the shapes the ledger already uses; it was not run against a live server. A live `SUBSTRATE_METRICS_HISTORY=on` smoke is the first thing to do: expect a `ddl` or `rejected` drop count if a clause is not accepted.
- A table created earlier with a different TTL keeps it; the TTL env only applies at creation.
- The first sample after a start is a baseline, so up to one interval of activity before it is not in the history; a failed batch's deltas are lost by design.
- The drop counter is registered at construction only with the flag on; enabling then disabling the flag leaves a one-line boot note.
- A read never runs DDL: a missing table (recognised by Greptime's "Table not found" / code 4001 wording, which no existing code matched and which was not verified against a live server) is an empty history. If the wording differs, the route answers `503` until the sampler's first write creates the table.
- `/slo/history` is public and each miss scans the TTL window through the ledger breaker. Mitigations: 15 s memo with one in-flight read per validated key (64 keys max) and a 2.5 s read deadline; a timeout still counts as a ledger failure.
- The step is raised so `(buckets + 1) x label values <= 2000` (28 for `brief.*`): a day is ~20-minute buckets and 14 days ~5 h. `stepS` and `retentionDays` in the answer are the effective step and the configured TTL; an existing table keeps its own TTL.
- The effective flag is `SUBSTRATE_METRICS_HISTORY=on` AND a ledger (`config.metricsHistory.enabled`, one field for sampler, route and drop counter); `on` without a ledger is a boot warning.
- Ratios fold as sample-weighted averages and p95 as the interval max over a step bucket; both are documented, neither is an exact quantile over the step.
