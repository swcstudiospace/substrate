# R2 summary — plane circuit breakers, per-plane SLOs, dependency-aware /healthz

## What changed

- **Breaker contract** (`packages/observability/src/breaker.ts`, new): `PLANES`, `CircuitBreaker` (closed → open → half-open, exactly one half-open probe), `BreakerOpenError`, `callPlane` (ok/error/timeout/open samples, `isFailure` opt-out, errors rethrown unchanged), `PlaneRegistry` (null breakers when disabled), `loadBreakerSettings` (`SUBSTRATE_BREAKER`, `_FAILURES` 1..100, `_OPEN_MS` 1000..600000, bad values → defaults). Plus one HTTP adapter beyond the contract: `gatedFetch(gate, fetch, opOf)` — a `PlaneFetch` whose every call runs through `callPlane`; 5xx answers charge the breaker and are still returned, 4xx are not failures.
- **Instruments**: `substrate.plane.duration{plane,op,outcome}` histogram and `substrate.plane.errors{plane,reason}` counter; `SubstrateInstruments.recordPlane`; `classifyPlaneReason` maps a sample to the closed set `timeout|network|server|open|other`.
- **SLOs**: `evaluatePlaneSlos` + `PlaneWindow` (rolling 1 h over cumulative per-plane counts, same discipline as `BurnLedger`); `plane.<name>.availability` with `SUBSTRATE_SLO_PLANE_AVAILABILITY` (default 0.99) and the shared `minSamples`; `unconfigured` for planes without config. Catalogue unchanged (still the four).
- **Wiring**: `SubstrateConfig.breaker`; `SubstrateObserver.plane` → `instruments.recordPlane`; `Substrate.planes = new PlaneRegistry(config.breaker, …)`; `GreptimeClient(config, { gate, timeoutMs, clock })` wraps `sql()` in `callPlane` with the SQL verb as `op` (`ping` labelled `ping`), new `GreptimeUnavailable` for transport/5xx/open; `IndexStore(url, { gate })` (R4 implements); `createReadThroughCache(config, { record, gate, now })` gates connect/get/set/incr and adds a 5 s connect cooldown (`CACHE_CONNECT_COOLDOWN_MS`, `cache.cooldownUntil` in health); Hindsight and RAGFlow calls go through `gatedFetch` with the bounded route tables `hindsightOp` / `ragflowOp`; an open breaker reads as `hindsight <op>: circuit open` (kind `network`) and `ragflow circuit open`.
- **/healthz**: `planes.{greptime,index,cache,hindsight,ragflow} = {ok, breaker, lastErrorAt}` (Hindsight/RAGFlow probed once each, 1 s bound, only when configured; index `ping(1000)`; cache never pinged) and `capacity.index` (`index.capacity()` raced against 1 s, null on timeout/error/missing). `index` stays a top-level boolean; `healthStatus` untouched.
- **/slo**: sibling `planes[]` array; `breached` still catalogue-only.
- **Chaos smoke**: `--plane greptime|index|hindsight|ragflow|cache` (default unchanged); non-ledger planes assert over HTTP that `/healthz` showed the plane `ok:false`/breaker `open` at least once (required — fails otherwise), every `POST /brief` answered 200 within 1500 ms, the plane's read (`/memory/recall`, `/docs/search`) answered `degraded:true`, the breaker opened, `/slo` lists the objective. Script restructured as `main(argv)` behind `import.meta.main` with exported pure helpers.
- **Docs**: `docs/observability.md` (series, breaker section, healthz planes/capacity, rolling plane SLOs, `--plane`, env table); new `docs/runbooks/substrate-red.md`.

## Files

Created: `packages/observability/src/breaker.ts`, `packages/observability/src/breaker.test.ts`, `scripts/chaos-smoke.test.ts`, `docs/runbooks/substrate-red.md`, `.planning/uplift-2/02-PLAN.md`, `.planning/uplift-2/02-SUMMARY.md`, `.planning/uplift-2/env-notes/02.md`.
Modified: `packages/observability/src/{index,instruments,instruments.test,slo,slo.test,config}.ts`, `packages/mcp-server/src/{config,observe,service,service.test,server,greptime,greptime.test,cache,cache.test,http.test}.ts`, `packages/mcp-server/src/planes/{hindsight,hindsight.test,ragflow,ragflow.test}.ts`, `scripts/chaos-smoke.ts`, `docs/observability.md`.

## Knobs

| Variable | Default | Range |
| --- | --- | --- |
| `SUBSTRATE_BREAKER` | on | `0|false|no` off |
| `SUBSTRATE_BREAKER_FAILURES` | 5 | 1..100 |
| `SUBSTRATE_BREAKER_OPEN_MS` | 30000 | 1000..600000 |
| `SUBSTRATE_SLO_PLANE_AVAILABILITY` | 0.99 | ratio |
| `CACHE_CONNECT_COOLDOWN_MS` (constant) | 5000 | — |

## Tests added

breaker state machine (threshold, reset, half-open boundary, single probe, re-open, truncation); `callPlane` outcomes and observer samples, `isFailure`, disabled registry; `gatedFetch` 5xx/4xx/transport/open/method derivation; `recordPlane` bounded attrs + `classifyPlaneReason`; plane SLO ids, unconfigured, one-reading, breached counting `open`, operator threshold, rolling window + restart, same-second coalesce; Greptime `GreptimeUnavailable` vs SQL error, `sqlOp`, opens after 5 and fails < 5 ms, 5xx charges / SQL error does not, `SUBSTRATE_BREAKER` off path; cache connect cooldown (socket test + bare `bunRedis`), breaker refusal starts no cooldown; Hindsight/RAGFlow op tables, `circuit open` reasons with no request sent, 4xx not charged; `Substrate.health()` exact shape, capacity null on timeout/missing, configured-plane probes, `SUBSTRATE_BREAKER=0`, `planesConfigured`, docs search / recall degrade reasons; HTTP `/healthz` planes + capacity, `/slo` planes + tuned target; chaos-smoke `parseArgs`/`parseBody`/`planeOutageIn`/`degradedIn`/`degradedReadFor`.

## Rollback

`git revert` the R2 range; or `SUBSTRATE_BREAKER=0` without a code change (breakers null; every call reaches its plane as before; series still recorded).

## Deviations from the proposal / assignment

- **Gate threading**: instead of a new `gate` parameter on every Hindsight/RAGFlow function and on `RecallDeps`/`RetainDeps`/`SearchDeps`/`IngestDeps`, the gate is applied once as a gated `fetchImpl` (`gatedFetch`) built in `Substrate` and passed through the existing injection seams. Every outbound call still passes `callPlane`; `op` is the bounded route table. `memory-recall.ts`, `memory-retain.ts`, `docs-search.ts`, `docs-ingest.ts`, `docs-datasets.ts` needed no edit.
- **`/healthz` index shape**: `index` stays a boolean (the status rule and R7's deploy gate read it); capacity is `capacity.index`, not `index.{ok,capacity}`.
- **Ledger ping bound**: `greptime.ping()` keeps its 5 s default in `/healthz` so the 503 rule is not made stricter; `ping(timeoutMs)` exists for callers that want a bound.
- **`GreptimeClient` constructor**: the positional `(config, timeoutMs, clock)` became `(config, { timeoutMs, clock, gate })` (one test caller updated).
- `breaker.ts` exports `gatedFetch`/`PlaneFetch` in addition to the shared contract.

## Post-deploy measurement pending (BASELINES.md rows)

| Row | Baseline | After (pending) |
| --- | --- | --- |
| time-to-degraded answer during an outage | 4–5 s | expected < 50 ms once open; read `/healthz.planes.<name>.breaker` + `/metrics substrate.plane.duration{outcome=open}` after a `smoke:chaos --plane` run on the rehearsal twin |
| per-plane error rate | not measured (Hindsight/RAGFlow "unknown") | `/slo.planes[]` and `substrate.plane.errors` after deploy |
| `/healthz` duration | 598 ms mean | re-read `substrate.request.duration{route=/healthz}` (adds ≤ 1 bounded probe per configured plane, run in parallel) |

## Gates

Final head of `ultrathink/uplift-2` (all seven items merged): `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (`scripts/rehearsal.test.ts` `--port 7410`), failing identically on `main`, recorded not fixed · `bun run check:phase-close` pass (4 lock files green; EVENT_KINDS 12; SURFACES 27) · `bun run test:py` 298 passed. Live smoke on the scratch rehearsal twin (`bun run rehearsal up --name uplift2`, scratch Postgres 16 + GreptimeDB v0.14.4 on loopback, commit `1fe624a`): `bun run rehearsal smoke` 4/4 (brief, emit, register, claim). 

R2 on the twin: `/healthz` carries `planes` for all five (greptime/index `ok: true`, cache/hindsight/ragflow `ok: null` = unconfigured) and `capacity.index`; `/slo` lists `plane.*.availability` (unconfigured planes report `unconfigured`). Ledger container paused: after 5 timed-out calls `planes.greptime.breaker.state = open`, `failures 5`, `lastError 'The operation timed out.'`; `POST /events` failed closed in **5 ms** with `greptime circuit open; retry in 30 s` (503) instead of the 5 s timeout; `/healthz` → **503** with `eventsWritable: false`. After unpause + the 30 s window: breaker `closed`, `/healthz` 200, `plane.greptime.availability` reported **breached at 63 % over 30 samples** in the rolling window.
