# S7 summary: docs freshness SLI, trigger lag, live canary

## What changed
- `docs-datasets.ts`: accepted-trigger store (`recordTrigger`, `triggersToJson`, `triggersFromJson`; retention 20, read scan capped at 80 rows from the tail, `Object.hasOwn` against the trigger table, field length 200, unparseable timestamps skipped, never throws).
- `docs-freshness.ts` (new): pure `evaluateFreshness`, gauge samples, the lag markers (`lag` member), `planLagTransitions` and `applyLagActions` (marker persisted before the emit, `warned` set only after the emit succeeded, recovery note emitted before the marker is dropped, every failure caught).
- `docs-ingest.ts`: the v2 state file gains optional `triggers` and `lag` members; `loadIngestRecords` returns `freshness`; `saveIngestRecords` takes it as an optional 4th argument and writes the members only when non-empty (flag-off parity).
- `service.ts`: `startDocsRefresh` records the accepted trigger first (never throws); `evaluateDocsFreshness(now)` is a pure read for `/slo` and `/metrics` (no hydrate wait, no emit, no write); `settleDocsLag()` hydrates, evaluates and starts the single-flight `LagSettler` pass. `docs-lag-timer.ts` + `index.ts` run it on an unref'd timer (`SUBSTRATE_DOCS_LAG_CHECK_S`, default 60, 15..3600), stopped and awaited at shutdown.
- `server.ts`: `/metrics` adds a `gauges` member only when data exists; `/slo` adds the `docs.freshness` row to `docs` (not folded into `breached`).
- `slo.ts` + `index.ts`: `evaluateDocsFreshnessSlo`, `DOCS_FRESHNESS_ID`.
- `config.ts`: `docsFreshness` settings.
- `event-sources.ts` + `docs/event-vocabulary.md`: rows `docs.freshness`, `docs.freshness.recovered`, `docs.canary` (kinds `warning`/`note`; no new kind or surface).
- `scripts/docs-golden.ts`: `--live --emit` canary. Units: `infra/vps/substrate-docs-canary.{service,timer}` and `.service.d/10-environment.conf` (staged); `infra/vps/README.md` row; `scripts/doctor-units.test.ts` knows the new unit.
- `docs/docs-search-ingest.md`: freshness/lag and canary sections.

## Flags and defaults
`SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H=168`, `SUBSTRATE_DOCS_TRIGGER_LAG_MIN=15` (see env-notes/S7.md). Canary off until `SUBSTRATE_DOCS_CANARY=1` and `SUBSTRATE_DOCS_CANARY_MANIFEST`. Everything is report-only; nothing is deleted or refused.

## Failure behaviour
A failed trigger save or emit is logged to stderr and never fails the trigger or the `/slo` read. Lag transitions run as ONE background pass (`LagSettler`) started by the lag timer (`SUBSTRATE_DOCS_LAG_CHECK_S`), never by a `/slo` or `/metrics` read, which only read the in-memory verdicts; each emit has a 5 s deadline (a timeout is a failure) and a failed delivery is retried no sooner than 60 s later. The dedupe is best effort (no state file, swallowed persist errors, a crash between emit and the second persist or a late emit can repeat one warning). `docs.freshness` is `insufficient-data` without a recorded ingest and `unconfigured` with both knobs 0. Canary exits: 0 pass, 1 regression, 2 not configured / non-loopback / no bearer, 3 could not run (including a degraded answer; nothing posted), 4 the dedupe record could not be cleared. The record is written tmp + rename.

## Rollback
`SUBSTRATE_DOCS_TRIGGER_LAG_MIN=0` + restart stops trigger recording and lag judging. Freshness has no off switch (with both knobs 0 the row is `unconfigured` and the gauges remain); removing it means reverting the code. Canary: disable the timer, remove the two drop-in lines, delete the unit files.

## Verify (orchestrator)
`bunx tsc --noEmit`; `bun test packages/mcp-server/src/docs-freshness.test.ts packages/mcp-server/src/docs-datasets.test.ts packages/mcp-server/src/docs-plane-hardening.test.ts packages/mcp-server/src/docs-ingest.test.ts packages/mcp-server/src/event-sources.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/store-lock.test.ts packages/observability/src/slo.test.ts scripts/docs-golden.test.ts scripts/doctor-units.test.ts`; `bun run check:phase-close`.

## Residual risks
- Not run: nothing was executed (edit-only); type or test failures are possible, notably the spy typing of `Substrate.emit` in the new tests.
- The two labelled docs gauges are served on `/metrics` `gauges` only and are not in OTLP; the registry's unlabelled gauges (S2 archive age) are in both.
- Lag is detected on the timer, so a warning fires within `SUBSTRATE_DOCS_LAG_CHECK_S` of the breach even when nobody reads `/slo`. The first `/slo` or `/metrics` read after a boot can show no datasets until the timer's first pass (run at start) has loaded the state file.
- A trigger rejected as idempotent (200) or a noop is not recorded; only accepted jobs are.
- The `docs.freshness` row is `breached` on lag even when SLO notify is on; the slo-notifier does not read the `docs` array, so no duplicate event.
- The canary refuses a manifest whose sha256 differs from the corpus on disk; a fixture edit requires re-attesting.
