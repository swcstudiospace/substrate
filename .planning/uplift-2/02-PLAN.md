# R2 plan — plane circuit breakers, per-plane SLOs, dependency-aware /healthz

## Files touched
- new `packages/observability/src/breaker.ts` + `breaker.test.ts` (shared contract, plus `gatedFetch` HTTP adapter)
- `packages/observability/src/index.ts`, `instruments.ts` (plane histogram/counter, `recordPlane`), `slo.ts` + `slo.test.ts` (rolling-window plane availability, `PlaneWindow`), `config.ts` (`SUBSTRATE_SLO_PLANE_AVAILABILITY`)
- `packages/mcp-server/src/config.ts` (`breaker: BreakerSettings`), `observe.ts` (`plane` observer, `evaluatePlanes`), `service.ts` (`PlaneRegistry`, gated clients, `health()` planes + capacity, `planesConfigured()`), `server.ts` (`/healthz` body, `/slo` `planes`), `greptime.ts` (options object, `callPlane` around `sql`/`ping`, `GreptimeUnavailable`), `cache.ts` (gate on connect/commands, connect cooldown, `cooldownUntil`), `planes/hindsight.ts` + `planes/ragflow (retired).ts` (bounded op tables, `circuit open` reasons)
- tests: `breaker.test.ts`, `slo.test.ts`, `instruments.test.ts`, `service.test.ts`, `http.test.ts`, `cache.test.ts`, `greptime.test.ts`, `planes/hindsight.test.ts`, `planes/ragflow (retired).test.ts`, `scripts/chaos-smoke.test.ts`
- `scripts/chaos-smoke.ts` (`--plane`, `main()` behind `import.meta.main`, pure helpers)
- `docs/observability.md`, new `docs/runbooks/substrate-red.md`, `.planning/uplift-2/env-notes/02.md`, `02-SUMMARY.md`

## Gate threading
The plane clients already take an injectable `fetchImpl`; the gate is applied as a gated `FetchLike`
(`gatedFetch(gate, fetch, opOf)`) built once in `Substrate` and passed through the existing seams, so
`memory-recall.ts`, `memory-retain.ts`, `docs-*.ts` need no signature change. `op` comes from a fixed
route table per plane (`hindsightOp`, `ragflow (retired)Op`); unknown routes are `other`. Greptime derives `op`
from the SQL verb (`select|insert|show|create|other`). 5xx answers count as failures; 4xx do not.

## Config knobs (defaults)
`SUBSTRATE_BREAKER` (on; `0|false|no` off), `SUBSTRATE_BREAKER_FAILURES` (5, 1..100),
`SUBSTRATE_BREAKER_OPEN_MS` (30000, 1000..600000), `SUBSTRATE_SLO_PLANE_AVAILABILITY` (0.99),
`CACHE_CONNECT_COOLDOWN_MS` constant 5000.

## /healthz additions
`planes.{greptime,index,cache,hindsight,ragflow (retired)}` = `{ok, breaker, lastErrorAt}`; `capacity.index`
(1000 ms bounded, null on timeout). `index` stays a boolean (status rule + R7 gate unchanged).

## /slo additions
`planes[]` sibling array (`plane.<name>.availability`), rolling 1 h window over
`substrate.plane.duration`, `unconfigured` for planes without config; `breached` unchanged.

## Rollback
`git revert` the R2 range, or `SUBSTRATE_BREAKER=0` (breakers null, calls run unwrapped apart from metrics).

## Verification (orchestrator)
`bun test packages/observability packages/mcp-server scripts/chaos-smoke.test.ts`, `bunx tsc --noEmit`, `bun run verify`.
