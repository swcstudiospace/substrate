# R4 summary — TimescaleDB connection hygiene, capacity telemetry, retention sweeper, runbooks

## What changed

**Index client** (`packages/mcp-server/src/index-store.ts`)
- `IndexStore(connectionString, options?)` composes Bun `SQL` options from `IndexPoolSettings`: `max`, `connectionTimeout` (s), `idleTimeout` (s), `maxLifetime` (fixed 3600 s), and `connection: { application_name: "substrate-mcp", statement_timeout, idle_in_transaction_session_timeout }` sent as **startup parameters** (Bun 1.4 `connection` option; verified against `bun-types@1.4.2` and a local `new SQL(...)` options dump — no `set` round-trip, the first statement is already bounded). `indexPoolSettingsFromEnv`, `indexSqlOptions`, `DEFAULT_INDEX_POOL_SETTINGS`, `INDEX_APPLICATION_NAME`, `INDEX_MAX_LIFETIME_S`, `INDEX_PING_TIMEOUT_MS` exported.
- `ping(timeoutMs = 1000)` races `select 1` against a `TimeoutError`; timeout → `false`.
- `capacity()` → `{ databaseBytes, tables[≤10]{ name, totalBytes, liveRows, deadRows } }` from `pg_database_size` + `pg_stat_user_tables` × `pg_total_relation_size`, Timescale internal schemas excluded.
- Plane gate (`options.gate`, R2 contract `callPlane`/`PlaneGate`): `graph.get`, `graph.open`, `lease.claim|heartbeat|review|release|reap`, `memory.search`, `memory.brief`, `ping`, `capacity`. `UnknownNode` (was a bare `Error`, same message) is excluded via `isFailure` so "no such node" never trips the breaker. No gate → behaviour unchanged.
- `sweep({ apply, now, policy })` executes `index-sweep.ts`; dry-run runs counts on the pool, apply runs counts + batched deletes in one `begin` transaction.
- `close(options?)` passes Bun's `{ timeout }` through (tests force-close a hung probe).
- `TERMINAL_STATUSES` now comes from `TERMINAL_GRAPH_STATUSES` in `index-sweep.ts` (same seven values) so `openGraphs` and the sweeper cannot disagree.

**Sweeper** (`index-sweep.ts`, pure): `SweepPolicy` + env, `sweepModeFromEnv`/`resolveSweepMode` (two-key rule), `SWEEP_CLASSES` (count + CTE-limited `for update skip locked` delete builders), `planSweep`, `executeSweep` (runner-injected), `formatSweepReport`, `sweepCounts`. Terminal statuses travel as one `|`-joined parameter split server-side (Bun array-parameter quirk noted in `memoryForBrief`).

**Host job** (`index-sweep-run.ts`): `loadConfig()`, mode from `SUBSTRATE_INDEX_SWEEP`, `--apply|--dry-run|--json`, one `note` on surface `substrate` (`payload.runtime: "index-sweep"`, `action: "index.sweep"`, `mode`, `batch`, `classes` counts only) via `Substrate.emit`; a failed sweep emits one `warning` instead and exits 1; `off` exits 0 without opening a store.

**CLI** (`packages/cli/src/index.ts`): `substrate index sweep [--apply] [--json]` spawns the runner with `--dry-run` unless `--apply`; the runner enforces the two-key rule (exit 2 with reason).

**Units** (`infra/vps/substrate-index-sweep.{service,timer}`, `.service.d/10-environment.conf`): anchor shape, oneshot, `OnCalendar=*-*-* 03:17:00 UTC`, `Persistent=true`, `Environment=SUBSTRATE_INDEX_SWEEP=dry-run` on the drop-in (not in `substrate.env`). Staged, not installed.

**Docs**: `docs/runbooks/lease-stuck.md`, `docs/runbooks/quarantine-spike.md` (new; both end with Rollback and Evidence); `docs/data-planes.md` index row rewritten to what exists (plain tables, no hypertables/aggregates, desk tables not in this repo, retention classes, sweeper, pool); `docs/memory-governance.md` "Retention: what the sweeper removes" + the exactly-once bullet now says 30 days.

## Files
- modified: `packages/mcp-server/src/index-store.ts`, `packages/mcp-server/src/index-store.test.ts`, `packages/cli/src/index.ts`, `scripts/doctor-units.test.ts`, `docs/data-planes.md`, `docs/memory-governance.md`
- new: `packages/mcp-server/src/index-sweep.ts`, `packages/mcp-server/src/index-sweep.test.ts`, `packages/mcp-server/src/index-sweep-run.ts`, `packages/mcp-server/src/index-store.sweep.test.ts`, `infra/vps/substrate-index-sweep.service`, `infra/vps/substrate-index-sweep.timer`, `infra/vps/substrate-index-sweep.service.d/10-environment.conf`, `docs/runbooks/lease-stuck.md`, `docs/runbooks/quarantine-spike.md`, `.planning/uplift-2/04-PLAN.md`, `.planning/uplift-2/04-SUMMARY.md`, `.planning/uplift-2/env-notes/04.md`

## Knobs and defaults
| Env | Default | Bounds |
|---|---|---|
| `SUBSTRATE_PG_POOL_MAX` | 8 | 1..50 (clamp) |
| `SUBSTRATE_PG_CONNECT_TIMEOUT_MS` | 2000 | 200..60000 (clamp) |
| `SUBSTRATE_PG_STATEMENT_TIMEOUT_MS` | 5000 | 0 (unset)..600000 (clamp) |
| `SUBSTRATE_PG_IDLE_TIMEOUT_S` | 300 | 0 (never)..86400 (clamp) |
| `SUBSTRATE_INDEX_SWEEP` | `dry-run` | `dry-run|apply|off`; anything else → dry-run |
| `SUBSTRATE_SWEEP_{DERIVED_WRITES,EXPLICIT_WRITES,REVIEWS,QUARANTINE,GRAPHS,SUPERSEDED}_DAYS` | 7 / 30 / 30 / 30 / 90 / 90 | 1..3650 (fallback on bad value) |
| `SUBSTRATE_SWEEP_BATCH` | 500 | 1..5000 (fallback) |
Constants: `application_name=substrate-mcp`, `maxLifetime` 3600 s, ping bound 1000 ms, `ttl=30d` class fixed at 30 d.

## Tests added (not run here)
- `index-store.test.ts`: env defaults/clamps/bad values; composed `SQL` options incl. zero statement timeout and fixed app name; `ping(50)` → false against a silent loopback socket with the gate sampling `["index","ping","timeout"]`; refused connection → false; pool override precedence.
- `index-sweep.test.ts`: policy env; mode resolution (two keys; `--dry-run` beats `off`); `planSweep` cutoffs for fixed `now` incl. the fixed 30 d class; per-class mode/predicate/cascade assertions; counts are read-only; `executeSweep` dry-run issues only counts, apply batches until a short batch, report-only/empty classes never delete, loop bounded by the count; report/counts shape; the runner (spawned) refuses `--apply` without the env, `off` exits 0, unknown flag exits 2.
- `index-store.sweep.test.ts` (skips without `SUBSTRATE_TEST_PG_URL`): seeds every class with a spent row and a live twin; dry-run counts ≥ 1 and moves nothing; apply removes exactly the spent rows, the terminal graph with nodes/edges/steps/bindings, keeps pending/young/in-flight/open rows and both ttl classes; second apply idempotent; `capacity()` shape; live `ping()` true.
- `scripts/doctor-units.test.ts`: unit list + shape of the sweep unit.

## Rollback
Revert the R4 range. Env defaults restore today's client except for the pool size/timeouts (which are the fix). The sweeper is dry-run unless `SUBSTRATE_INDEX_SWEEP=apply`; the timer is staged only; an applied sweep is undone only by the pre-apply volume snapshot (runbook step).

## Deviations from the proposal / brief, and why
1. **`memory_quarantine` has no state column**, so "resolved/released" is defined as *content later landed* (`entry_hash` present in `memory_entries` — the reviewer re-submission path). Rows whose content never landed are `quarantine-unresolved`, counted and never deleted.
2. **`ttl=30d` and `ttl=graph` entries are report-only.** `searchMemoryPage` and `memoryForBrief` filter on `superseded_by` only, never on `ttl`; deleting would change answers the reads still give. Reported as `entries-ttl-30d` / `entries-ttl-graph` (the latter: old, scoped to a graph that is terminal or no longer indexed).
3. **In-flight `memory_writes` are never deleted** at any age: one may carry a reservation a retry recovers; the gate's own takeover handles them.
4. **CLI spawns the runner** instead of importing: `@substrate/cli` does not depend on `@substrate/mcp-server` and `packages/cli/package.json` is outside R4's files. The runner is the single authority for the two-key rule.
5. **`scripts/doctor-units.test.ts` edited** (not in the owned list) because it enumerates `infra/vps/*.service` by directory and would otherwise go red; assignment said to keep it green.
6. **`maxLifetime` 3600 s constant** — in the contract's option list but not in `IndexPoolSettings`; a bounded lifetime turns proxy-dropped idle sockets into planned reconnects.
7. **`SweepReport` is a superset** of the contract (`at`, `batch`, per-class `mode`, `days`, `cutoff`, `children`); `IndexStore.sweep` also accepts `policy`.
8. **`.env.example` / `infra/vps/README.md` not edited** per rules; blocks in `env-notes/04.md`.
9. R2 wires `capacity()` into `/healthz` (`service.health()`); R4 only provides it.

## Post-deploy measurement pending (BASELINES.md rows)
| Row | Baseline | Target | How |
|---|---|---|---|
| TimescaleDB connections from this service | 19 idle + 1 active, `application_name` empty | ≤ 8, all `substrate-mcp` | `pg_stat_activity` after deploy |
| TimescaleDB `statement_timeout` | 0 (server) | 5000 ms per `substrate-mcp` connection | `pg_stat_activity` → `pg_settings` in a session, or `show statement_timeout` via the client |
| `graph_nodes` 50 dead / 45 live tuples | never autovacuumed | dead tuples reported by `capacity()`; sweeper removes terminal graphs so autovacuum has less to carry | `/healthz.capacity.index` (R2) / `capacity()` |
| sweeper dry-run report present daily | none | one `index.sweep` note per day on surface `substrate` | `events_query` `surface=substrate`, `payload.action=index.sweep` |
| TimescaleDB `select 1` cold 1,057 ms / `/healthz` mean 598 ms | unbounded ping | `ping` bounded at 1000 ms; pool keeps ≤ 8 warm connections 300 s | `/metrics` `substrate.request.duration` after deploy |

## Greptile round 1 (PR #59)

**[P1] "Sweep deletes live leases"** — the terminal-graph class judged a graph on `graph_index.status`/`updated` only; claims and heartbeats write `graph_nodes` and do not refuse a terminal graph, so an old finished graph with a fresh lease was a candidate. Fixed at the root in `index-sweep.ts`:
- the count **and** the pick exclude any graph with a live lease — `not exists (… n.claimed_by is not null and coalesce(n.lease_expires_at, n.claimed_at + make_interval(secs => DEFAULT_LEASE_TTL_SECONDS)) > now())`, the lease expression `claimNode`/`heartbeatNode`/`reapExpiredLeases` use (`DEFAULT_LEASE_TTL_SECONDS` imported from `lease.ts`);
- the graph delete is two-phase inside the apply transaction (`SweepBatch { pick, then, skippedAs }`): pick with `for update skip locked` on `graph_index`; delete the picked graphs' `graph_nodes` **only where the lease is not live**, re-evaluated per row at execution (a concurrent claim's row UPDATE and this DELETE serialise; READ COMMITTED re-checks the predicate against the new row version); then delete `graph_index` only where no node row remains, and edges/steps/bindings only for graphs whose index row went;
- a picked graph that survived is reported as `children.skipped_live_lease` (so `candidates − deleted` is explained); a round whose delete fell short of its pick stops the loop;
- tests: `index-sweep.test.ts` (predicate shape, two-phase statements, skipped accounting, loop stop, empty pick); `index-store.sweep.test.ts` (terminal graph with a live lease kept, with an expired lease deleted; a claim landing on a second connection between pick and node delete keeps the graph, no orphan edges/steps/bindings; the raced graph leaves the candidate set);
- docs: `docs/data-planes.md` index row ("never while any node holds a live lease"), `docs/runbooks/lease-stuck.md` ("The sweeper does not release anything").

## Gates

Final head of `ultrathink/uplift-2` (all seven items merged): `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (`scripts/rehearsal.test.ts` `--port 7410`), failing identically on `main`, recorded not fixed · `bun run check:phase-close` pass (4 lock files green; EVENT_KINDS 12; SURFACES 27) · `bun run test:py` 298 passed. Live smoke on the scratch rehearsal twin (`bun run rehearsal up --name uplift2`, scratch Postgres 16 + GreptimeDB v0.14.4 on loopback, commit `1fe624a`): `bun run rehearsal smoke` 4/4 (brief, emit, register, claim). 

R4 on the twin: `/healthz.capacity.index` = `databaseBytes 8100887` + 9 relations with live/dead rows; `SUBSTRATE_INDEX_SWEEP=dry-run bun packages/mcp-server/src/index-sweep-run.ts --json` against the scratch index → report with every class at `candidates 0, deleted 0`, `apply: false` (nothing deleted). `scripts/doctor-units.ts --dry-run` → no findings with the sweep unit present. Production pool/connection counts: post-deploy measurement pending.
