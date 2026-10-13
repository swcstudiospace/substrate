# R4 plan — TimescaleDB connection hygiene, capacity telemetry, retention sweeper, runbooks

## Files touched
- `packages/mcp-server/src/index-store.ts`: `IndexPoolSettings`, `indexPoolSettingsFromEnv`, `indexSqlOptions` (pure Bun `SQL` options: `max`, `connectionTimeout`, `idleTimeout`, `maxLifetime`, `connection.{application_name,statement_timeout,idle_in_transaction_session_timeout}` as startup parameters), `IndexStoreOptions { pool, gate }`, `callPlane` around brief reads / search / ping / lease CAS, bounded `ping(timeoutMs)`, `capacity()`, `sweep({ apply, now })`
- `packages/mcp-server/src/index-store.test.ts`: settings defaults/clamps, composed options, ping timeout, dry-run executes only counts (fake sql)
- new `packages/mcp-server/src/index-sweep.ts` (+ `.test.ts`): `SweepPolicy`, `sweepPolicyFromEnv`, `sweepCutoffs(policy, now)`, `SWEEP_CLASSES` with count/delete SQL builders, `resolveSweepMode`, report formatting
- new `packages/mcp-server/src/index-sweep-run.ts`: host job / CLI target; mode from `SUBSTRATE_INDEX_SWEEP`, one `note` on surface `substrate`
- new `packages/mcp-server/src/index-store.sweep.test.ts`: DB-backed round trip + `capacity()` shape (skips without `SUBSTRATE_TEST_PG_URL`)
- `packages/cli/src/index.ts`: `substrate index sweep [--apply] [--json]` spawns the runner (CLI package has no mcp-server dependency; the runner is the single authority for the two-key rule)
- `infra/vps/substrate-index-sweep.service`, `.timer` (daily, `Persistent=true`), `substrate-index-sweep.service.d/10-environment.conf`; `scripts/doctor-units.test.ts` unit list (+ shape assertions) so the doctor stays green
- `docs/runbooks/lease-stuck.md`, `docs/runbooks/quarantine-spike.md` (new); `docs/data-planes.md` index row; `docs/memory-governance.md` retention section
- `.planning/uplift-2/env-notes/04.md`, `04-SUMMARY.md`

## Config knobs (defaults)
`SUBSTRATE_PG_POOL_MAX` 8 (1..50) · `SUBSTRATE_PG_CONNECT_TIMEOUT_MS` 2000 (200..60000) · `SUBSTRATE_PG_STATEMENT_TIMEOUT_MS` 5000 (0 = unset, ≤ 600000) · `SUBSTRATE_PG_IDLE_TIMEOUT_S` 300 (0 = never, ≤ 86400) · `application_name` fixed `substrate-mcp`
`SUBSTRATE_INDEX_SWEEP` dry-run|apply|off (dry-run) · `SUBSTRATE_SWEEP_BATCH` 500 (1..5000) · per-class days: `SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS` 7, `_EXPLICIT_WRITES_DAYS` 30, `_REVIEWS_DAYS` 30, `_QUARANTINE_DAYS` 30, `_GRAPHS_DAYS` 90, `_SUPERSEDED_DAYS` 90 (each 1..3650)

## Sweep classes
delete: `writes-derived-spent`, `writes-explicit-spent`, `reviews-decided`, `quarantine-released` (content later landed: same `entry_hash` in `memory_entries`), `graphs-terminal` (+ nodes/edges/steps/bindings explicitly), `entries-superseded`.
report only (reads do not filter `ttl`, verified in `searchMemoryPage`/`memoryForBrief`): `entries-ttl-30d`, `entries-ttl-graph`, `quarantine-unresolved` (no decision column exists on `memory_quarantine`).
Dry-run runs COUNT statements only; apply counts then deletes in one transaction, CTE-limited batches.

## Tests (written, not run here)
pure: settings, options, cutoffs/SQL per class for a fixed `now`, mode resolution (two keys), dry-run never reaches a DELETE builder, ping timeout → false. DB-backed (skip without `SUBSTRATE_TEST_PG_URL`): seed per class, dry-run counts, apply deletes exactly those rows, capacity shape. Runner refuses `--apply` without `SUBSTRATE_INDEX_SWEEP=apply` (spawn, no store).

## Rollback
Revert the R4 range; env defaults restore today's client apart from pool size/timeouts. Sweeper is dry-run unless `SUBSTRATE_INDEX_SWEEP=apply`; the timer is staged, not installed.

## Verification (orchestrator)
`bun test packages/mcp-server scripts/doctor-units.test.ts`, `bunx tsc --noEmit`, `bun run verify`; with a scratch DB: `SUBSTRATE_TEST_PG_URL=… bun test index-store.sweep`; `bun packages/mcp-server/src/index-sweep-run.ts --json` against the rehearsal Postgres.
