# N3 plan — per-surface admission budgets (C8), shadow first

## What

One token bucket per authenticated surface × class (`read`, `write`, `coordination`) in the cache plane, stepped by one atomic Lua `EVAL`; `429` + integer `Retry-After` + bounded JSON only in `enforce`; `shadow` (default) decides and counts; `off` is today. Identity is the bearer's surface, never a body claim; untokened bridge callers share `anonymous`. MCP batches cost one token per `tools/call` member and are refused whole before any member runs and before the audit. Cache off / breaker open / cooldown / timeout / malformed reply → admit and count `bypass`.

## Where

- `packages/mcp-server/src/admission.ts` (new): `BUDGET_SCRIPT` (Lua, `now_ms` from the process), `bucketStep` (TS reference), key `substrate:v1:budget:<identity>:<class>`, `ROUTE_CLASSES` / `MONITOR_ROUTES` / `MCP_ROUTE` / `TOOL_CLASSES`, `Admission.admit`, `admitBatch`, `budgetBody`, `budgetRefusal`.
- `cache.ts`: `CacheRedis.eval?`, `bunRedis.eval` through `run("eval", …)` (gate, timeout, cooldown), `ReadThroughCache.script` (`ScriptOutcome`); `service.ts`: `SubstrateObserver.admission`, `Substrate.cacheScript` (the one door to the private cache).
- `server.ts`: `Admission` built per server; REST seam after the 401, before `try`/handlers; `handleMcp` seam after body parse, before `auditToolCalls`; `/slo.admission`.
- `config.ts`: `admission: AdmissionSettings` via `loadAdmissionSettings` (`DEFAULT_BUDGETS`, `positiveRateOr`).
- `packages/observability`: `ADMISSION_CLASSES`, `ADMISSION_DECISIONS`, `substrate.admission.decisions{surface,class,decision}`, `recordAdmission`; `ADMISSION_SLO` + `evaluateAdmissionSlo` beside the catalogue (the four stay pinned).
- Docs: `docs/data-planes.md`, `docs/observability.md`, `docs/grok-bot.md`; env block in `env-notes/03.md`.

## Flags

`SUBSTRATE_BUDGETS=off|shadow|enforce` (default `shadow`); `SUBSTRATE_BUDGET_{READ,WRITE,COORDINATION}_{RPS,BURST}` (20/40, 10/20, 30/60); `SUBSTRATE_BUDGET_ANONYMOUS_{RPS,BURST}` (2/4); `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_{RPS,BURST}` overrides.

## Tests

- `admission.test.ts`: bucket math (start full, refill, cap, refusal wait, clock backwards, cost > burst, TTL, Retry-After rounding); Lua key/arg/reply contract; `Admission` modes, bypass on every failure shape, recorder isolation, anonymous sharing, coordination isolation, overrides; `admitBatch` costing/order/empty/shadow; refusal bodies; class tables exhaustive over `server.ts` routes and `mcp.ts` tools (source scan) and bounded by the metric label sets; `loadAdmissionSettings`.
- `http.admission.test.ts` (real socket, fake budget redis under a `ReadThroughCache`, injected clock): 401 before 429; enforce 429/`Retry-After`/body with no event stored and admission after the wait; TTL; anonymous sharing; per-surface override; shadow never refuses + `/slo` row; `off` runs no script; MCP batch cost and whole-batch 429 with no member run and no audit; dead cache → bypass; no cache → bypass; monitor GETs never metered.
- `instruments.test.ts`, `slo.test.ts`: counter labels; `admission.limited_rate` floor, bypass exclusion, ok/breached.
