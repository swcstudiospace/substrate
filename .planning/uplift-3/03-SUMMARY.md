# N3 summary — per-surface admission budgets (C8), shadow first

## What changed

- **Bucket** (`packages/mcp-server/src/admission.ts`, new): `BUDGET_SCRIPT` — one Lua `EVAL` on `KEYS[1] = substrate:v1:budget:<identity>:<class>` with `ARGV = rps, burst, now_ms, cost` that refills `elapsed × rps / 1000` (capped at `burst`, a backwards clock refills nothing), checks, debits, `HSET`s `{t, at}` and `PEXPIRE`s to `max(1 s, burst / rps)`, replying `{allowed, floor(tokens_left), retry_after_ms}`. `now_ms` is the process clock (no `redis.call('TIME')`), so the TS reference `bucketStep` and the Lua decide identically and tests are deterministic. A cost above the burst is never admitted (the reply's wait is honest; split the batch). `retryAfterSeconds` = `max(1, ceil(ms / 1000))`.
- **Classes** (`admission.ts`): `ROUTE_CLASSES` (pathname → `read` | `write`), `MONITOR_ROUTES` (`/healthz`, `/metrics`, `/slo`, exempt on GET only), `MCP_ROUTE` (metered per member), `TOOL_CLASSES` (every `mcp.ts` tool; `coordination` = `graph_claim`/`graph_heartbeat`/`graph_release`/`graph_complete`/`coord_reap_leases`); an unknown name is `read`. `admission.test.ts` scans `server.ts` for `url.pathname === "…"` and `mcp.ts` for `registerTool("…")` and fails on any route or tool the tables do not name — and on any stale entry.
- **Decision** (`Admission.admit`): identity = bearer surface or `anonymous` (never a body claim); limit = per-surface override else class default, `anonymous` has its own. `off` → no eval, nothing recorded. Script failure, `ok: false`, or a malformed reply → `bypass` (admit, recorded). `allowed`; refusal → `limited` in `enforce`, `shadow_limited` otherwise. A throwing recorder cannot fail the request. `admitBatch` groups an MCP batch's `tools/call` members by class, steps the classes reads-first, and returns the first `limited` verdict (a batch with no tool calls costs nothing).
- **Cache path** (`cache.ts`): `CacheRedis.eval?`, `bunRedis.eval` via `run("eval", …)` — same plane gate, command deadline, connect cooldown and breaker as every command (whole script sent; no `EVALSHA`/`NOSCRIPT` round trip) — and `ReadThroughCache.script(script, keys, args): Promise<ScriptOutcome>` (`ok: false` with a redacted reason for off / no `EVAL` / failure; a failure degrades the cache like any other failed command). `Substrate.cacheScript` is the one door `server.ts` has to the private cache; `SubstrateObserver.admission` is the hook (`service.ts`, implemented in `observe.ts` → `recordAdmission`).
- **Seams** (`server.ts`): `new Admission(config.admission, { script: substrate.cacheScript, now, record: observer.admission })` per server. REST: after the bearer 401, before `try`/every handler — `routeClass(method, pathname)`; `limited` → `sendBudgetRefusal` (429, `Retry-After: <int s>`, `{"error":"budget","class","retry_after_s"}`). MCP: in `handleMcp` after the body is parsed and before `auditToolCalls` — an over-budget batch is 429 with one JSON-RPC error per member (`-32000`, `data` = the same body) and no member runs; a refusal is counted, never audited. `/events/stream` is metered once at admission. `/slo` gains a sibling `admission` row.
- **Config** (`config.ts`): `admission: AdmissionSettings` from `loadAdmissionSettings` — `SUBSTRATE_BUDGETS` (`off|shadow|enforce`, case-insensitive, default `shadow`), `SUBSTRATE_BUDGET_{READ,WRITE,COORDINATION}_{RPS,BURST}` (`positiveRateOr` keeps fractional rates; bursts via `positiveOr`), `SUBSTRATE_BUDGET_ANONYMOUS_{RPS,BURST}`, `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_{RPS,BURST}` over every `SURFACES` entry in the `SUBSTRATE_TOKEN_*` spelling (a half left unset is the class value). `DEFAULT_BUDGETS` exported.
- **Observability** (`packages/observability`): `ADMISSION_CLASSES`, `ADMISSION_DECISIONS` (the bounded label sets the server imports), counter `substrate.admission.decisions{surface,class,decision}` + `recordAdmission`; `ADMISSION_SLO` / `evaluateAdmissionSlo` — `admission.limited_rate` = `limited / (allowed + limited + shadow_limited)` ≤ 1 %, `insufficient-data` under 100 decisions, bypasses excluded from both sides. Beside the catalogue (sibling `admission` on `/slo`), because the catalogue, `breached`, the evidence bundle and three tests pin SPE-4793's four.
- **Docs**: `docs/data-planes.md` (cache row + budget paragraph), `docs/observability.md` (metric row, SLO section, `/slo` route row, env table), `docs/grok-bot.md` (what the gateway sees: 429 + `Retry-After` + body, MCP shape, shadow default, 401 precedence, bypass).

## Files

Created: `packages/mcp-server/src/admission.ts`, `packages/mcp-server/src/admission.test.ts`, `packages/mcp-server/src/http.admission.test.ts`, `.planning/uplift-3/{03-PLAN,03-SUMMARY}.md`, `.planning/uplift-3/env-notes/03.md`.
Modified: `packages/mcp-server/src/{cache,config,observe,server,service}.ts`, `packages/observability/src/{index,instruments,instruments.test,slo,slo.test}.ts`, `docs/{data-planes,observability,grok-bot}.md`.

## Flags and defaults

| Variable | Default | Effect |
| --- | --- | --- |
| `SUBSTRATE_BUDGETS` | `shadow` | `off` = today (no eval, no sample); `shadow` = decide + count, never refuse; `enforce` = 429 |
| `SUBSTRATE_BUDGET_READ_RPS` / `_BURST` | 20 / 40 | per surface |
| `SUBSTRATE_BUDGET_WRITE_RPS` / `_BURST` | 10 / 20 | per surface |
| `SUBSTRATE_BUDGET_COORDINATION_RPS` / `_BURST` | 30 / 60 | per surface; own bucket so reads never cost a lease |
| `SUBSTRATE_BUDGET_ANONYMOUS_RPS` / `_BURST` | 2 / 4 | every class of the shared `anonymous` bucket |
| `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS` / `_BURST` | — | per-surface override |

## How it is measured

`substrate.admission.decisions{surface,class,decision}` (`/metrics`, OTLP); `/slo.admission` (`admission.limited_rate`); `substrate.plane.duration{plane=cache,op=eval}` for the round trip; `/healthz.cache` degrades on a failed eval like any failed command. In shadow on the VPS: `decision=shadow_limited` by surface and class is the tuning signal before `enforce`.

## Rollback

`SUBSTRATE_BUDGETS=off` restores today's path with no code change (no eval, no sample); `shadow` is the default and refuses nothing. Keys always carry a TTL (≥ 1 s, the burst's refill time), so a flip to `off` leaves nothing behind. Code: revert the N3 range.

## Deviations / notes

- `/slo` row is a sibling `admission` object, not a catalogue entry: the catalogue is pinned to four by `slo.test.ts`, `http.test.ts`, `observe.test.ts` and `burn.ts`'s stated rule; the shape is the same `SloResult`.
- `anonymous` is per class (`budget:anonymous:<class>`) with the anonymous limit for every class, so the coordination isolation holds for the bridge too; the proposal's "one bounded bucket" is read as one identity.
- A mixed-class batch refused by a later class keeps the earlier class's debit (reads are stepped first so a coordination token is never spent on a batch that will not run); documented in `admitBatch`. A batch larger than the class burst can never be admitted.
- `tools/list` / `initialize` cost nothing (no `tools/call` member), matching the audit's view that they are not actions.
- A bare local run with no tokens and `allowAnonymous` is identity `anonymous` (2/4) — visible as `shadow_limited` in shadow, which is the intended signal; `off` or the anonymous knobs change it.
- Dragonfly compatibility of `HSET` multi-field + `PEXPIRE` inside `EVAL` is not attested here; the orchestrator's smoke runs the script against loopback redis (`env-notes/03.md` has the command).

## Gates

At the branch head after both waves merged (orchestrator-run, 2026-10-13): `bunx tsc --noEmit` clean · `bun test` with `SUBSTRATE_TEST_PG_URL` (scratch Postgres 16) **3845 pass / 1 skip / 1 fail** — the one failure is the recorded F-01 (`scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2", identical on `main`) · `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27, 4 lock files) · `bun run test:py` 298 pass. Lua bucket smoke on the loopback redis (`EVAL` of `BUDGET_SCRIPT`, rps 10 / burst 20): twenty debits in one millisecond then `[0, 0, 100]`, one token back after 150 ms, `PTTL` 1,894 ms, `at` stored exactly.
