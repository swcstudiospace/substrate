# R5 summary — GreptimeDB ledger: cheaper writes, bounded reads, honest health, capacity, opt-in TTL

## What changed

- **Chain-tip cache** (`greptime.ts` `ChainTipCache`, `lastHash`, `insertEvent`): each session's tip is kept in a bounded LRU (`SUBSTRATE_LEDGER_CHAIN_CACHE_MAX`, default 10 000) — seeded by one read, moved to the event's hash after a stored row, forgotten on an event-row error (a timed-out INSERT may have landed), kept after an unconfirmed ingest record (the row is stored). A session the ledger has never seen is cached as empty, so a handoff's read and its emit share one lookup. `SUBSTRATE_LEDGER_CHAIN_CACHE=0` restores one read per emit. `chainTipsCached` is a read-only seam.
- **Bounded chain-tip read**: the seeding `lastHash` adds `"ts" >= now − SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` (default 30); when that returns nothing the whole session is read (so an old session continues its chain; an empty session costs that second read once). The row `LIMIT 10000` memory guard stays on both.
- **Per-session serialisation** (`service.ts` `append` → `appendChained`, private `emitChains` block after `completionChains`): same-session emits run one at a time with the `completionChains` promise pattern; other sessions and sessionless events never wait; an invalid event releases its turn. `events_emit` fail-open/fail-closed semantics unchanged; `events_verify` unchanged.
- **Bounded stream reads**: `eventIdsAfter` bounds the anti-join's inner side to `ingested_at >= cursor − INGEST_RETRY_LOOKBACK_MS` (1 h, clamped at the epoch) and selects `event_ts`; `CursorPosition` gains optional `eventTs`; `eventsByIds(ReadonlyArray<string | CursorPosition>)` adds `"ts" BETWEEN min(event_ts) AND max(event_ts)` when every entry carries one, unbounded for bare ids. `readEvents`/`graphIngest` stay unbounded (commented: verify must see everything).
- **Write probe**: `migrate()` creates `substrate_health` (`ts TIMESTAMP TIME INDEX, probe STRING`, `append_mode='true', ttl='1d'`; plain append_mode + warning if the server refuses the ttl option). `GreptimeClient.writeProbe()` inserts one row (op `probe`); `probeWritable(intervalMs)` runs it at most once per interval, shares one in-flight probe, never throws, scrubs the reason with `redact` + `redactKnown(url, host)`. `Substrate.health()` runs it only when the ledger pings, with the client's own write timeout; `eventsWritable = metadata && lastProbeOk !== false`; body gains `ledger: { writable, lastProbeAt, lastProbeOk, lastProbeError }`. A failed probe → 503 by the existing `healthStatus` rule within one interval.
- **Capacity**: `GreptimeClient.capacity()` reads `information_schema.region_statistics ⋈ tables` for the configured db → `{ bytes, rows, tables[≤10 by disk] }` (regions summed); `/healthz` reports it under `capacity.ledger`, raced against `HEALTH_PROBE_MS`, null on timeout/throw/missing.
- **Opt-in TTL**: `SUBSTRATE_LEDGER_TTL` (config `ledger.ttl`) validated at load against Greptime's duration grammar (`isGreptimeDuration`; invalid → `ConfigError`). `migrate()` → `applyTtl`: reads `SHOW CREATE TABLE` for `agent_events` and `event_ingest`, sends `ALTER TABLE "<t>" SET 'ttl'='<v>'` only where the live value differs, warns on failure. `sql()` still refuses every `ALTER`; the guarded path is `alterTtl(table ∈ TTL_TABLES, validated duration)` → private `send()` (the transport split out of `sql()`), op `alter`.
- **Docs** (`docs/greptime-ledger.md`): chain cache + serialisation + bounded reads, the one guarded ALTER, stream bounds, *Health: the write probe*, *Capacity* (incl. operator DROP of `agent_events_pre_append_20260930`), *Retention: opt-in TTL* (effect on `events_verify`, anchors keep roots, export-before-expiry off-box, rollback `ALTER TABLE … UNSET 'ttl'` per Greptime reference page *ALTER* § "Unset table options" — not `SET 'ttl'=''` as the proposal guessed — and `180d` = `docs/data-planes.md`), configuration table.

## Files

Created: `packages/mcp-server/src/ledger-chain.test.ts`, `.planning/uplift-2/05-PLAN.md`, `.planning/uplift-2/05-SUMMARY.md`, `.planning/uplift-2/env-notes/05.md`.
Modified: `packages/mcp-server/src/greptime.ts`, `packages/mcp-server/src/greptime.test.ts`, `packages/mcp-server/src/config.ts`, `packages/mcp-server/src/service.ts`, `packages/mcp-server/src/service.test.ts`, `packages/mcp-server/src/http.test.ts`, `docs/greptime-ledger.md`.

Existing test expectations changed: `greptime.test.ts` ("lastHash reads the whole session…" → bounded-then-unbounded statements; `eventIdsAfter` select list now includes `i."event_ts"`); `service.test.ts` (health `toEqual` gains `ledger`, `capacity` gains `ledger: null` ×4); `http.test.ts` (`capacity` gains `ledger: null` ×2).

## Knobs

| Variable | Default | Range |
| --- | --- | --- |
| `SUBSTRATE_LEDGER_CHAIN_CACHE` | on | `0|false|no` off |
| `SUBSTRATE_LEDGER_CHAIN_CACHE_MAX` | 10000 | 1..1000000 |
| `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` | 30 | 1..3650 |
| `SUBSTRATE_LEDGER_WRITE_PROBE_S` | 60 | 0..86400 (0 = off) |
| `SUBSTRATE_LEDGER_TTL` | unset (no ALTER) | Greptime duration; invalid refuses boot |

## Tests added (written, not run)

`ledger-chain.test.ts`: one lookup per session (in-memory ledger behind `fetch` counting chain-tip reads), steady state = INSERT + INSERT, bounded seed SQL, fallback path, invalidate on row error, keep on unconfirmed ingest, cache off, LRU eviction, empty-session cache; concurrent same-session emits → one chain (`verifyChain` ok), serialisation with cache off, cross-session concurrency, invalid event releases, sessionless; health: probe ok/failed (→ `healthStatus` 503)/not-run/off/missing/throws/unreachable/metadata-refuses, `capacity.ledger` answered/slow/throws/missing, end-to-end through the real client.
`greptime.test.ts`: stream bounds (lookback, epoch clamp, `eventTs`, BETWEEN, bare ids, verify reads unbounded); `substrate_health` DDL + ttl fallback; `writeProbe` SQL/op; cadence with fake clock; interval 0; failure redacted + host scrubbed; SQL error does not charge breaker; in-flight sharing; capacity parse/top-10/null cells/throws; `ttlOf`; no ALTER when unset; ALTER only on difference; failed ALTER warns; unreadable table not altered; `sql()` refuses ALTER, `alterTtl` refuses other tables/values; config TTL validation + knob clamps.

## Rollback

Env only: `SUBSTRATE_LEDGER_CHAIN_CACHE=0` and `SUBSTRATE_LEDGER_WRITE_PROBE_S=0` restore the previous read-per-emit and metadata-only writability (serialisation and stream bounds have no knob; they change no answer). TTL: unset the variable and run `ALTER TABLE "agent_events" UNSET 'ttl'; ALTER TABLE "event_ingest" UNSET 'ttl';` as operator. Or `git revert` the R5 range.

## Deviations and why

- `server.ts` untouched per assignment: the SSE call site still passes ids, so the `eventsByIds` bound is inert until the orchestrator changes L1368 to `greptime.eventsByIds(positions)` (Main acknowledged it will).
- Probe cadence state lives in `GreptimeClient.probeWritable` (fake-clock testable via the client's injected `clock`) rather than in `Substrate`; `health()` passes the interval from config. The probe keeps the client's 5 s write timeout, not `HEALTH_PROBE_MS`, so a slow day does not read as a full disk (same reasoning as R2's ping).
- `eventsWritable` is `metadata && lastProbeOk !== false` (a probe that has not run or is off neither proves nor disproves), not a strict `&& lastProbeOk`, so `SUBSTRATE_LEDGER_WRITE_PROBE_S=0` and fakes without the probe keep today's behaviour.
- Rollback syntax is `UNSET 'ttl'` (Greptime reference *ALTER*), not the proposal's `SET 'ttl'=''`.
- A session empty in the ledger costs two statements on its first lookup (bounded read + unbounded fallback), by the fallback rule; still once per session per process.
- One-line constructor edit in `service.ts` (passes `ledger: config.ledger` to `GreptimeClient`) outside the three named regions; config comment on `allowDeduplicatingLedger` updated to say the client refuses every `ALTER` but the guarded TTL one.
- `.env.example` block delivered as `env-notes/05.md`; `docs/data-planes.md` not edited (R1 owns it) — note included there.

## Before / after (BASELINES.md rows)

| Row | Baseline | After |
| --- | --- | --- |
| Greptime calls per emit | 3–4 (lastHash scan + INSERT + ingest INSERT [+ append-mode probe]) | 2 steady state (unit: `ledger-chain.test.ts` "steady-state emit is two ledger calls"); post-deploy measurement pending via `substrate.plane.duration{plane=greptime,op=select}` rate vs `substrate.emit.total` |
| same-session chain forks | detected, not prevented | prevented in-process (unit: concurrent emits → one chain); post-deploy: `events_verify` on busy sessions |
| SSE poll | `WHERE id IN (...)` unbounded, anti-join over all history | time-bounded once server.ts passes positions; post-deploy measurement pending (`op=select` duration from stream polls) |
| `/healthz` with a store refusing writes | 200 (metadata-derived) | 503 within `SUBSTRATE_LEDGER_WRITE_PROBE_S` (unit); post-deploy: `smoke:chaos --plane greptime` on the rehearsal twin |
| ledger bytes | 1.28 MB `agent_events`, 1.29 MB stale table (one-off query) | `capacity.ledger` on every `/healthz`; post-deploy measurement pending |
| TTL | none | unchanged until `SUBSTRATE_LEDGER_TTL=180d` is set after the export step; post-deploy `SHOW CREATE TABLE` confirms |

## Gates

Final head of `ultrathink/uplift-2` (all seven items merged): `bunx tsc --noEmit` clean · `bun test` **3525 pass / 65 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (`scripts/rehearsal.test.ts` `--port 7410`), failing identically on `main`, recorded not fixed · `bun run check:phase-close` pass (4 lock files green; EVENT_KINDS 12; SURFACES 27) · `bun run test:py` 298 passed. Live smoke on the scratch rehearsal twin (`bun run rehearsal up --name uplift2`, scratch Postgres 16 + GreptimeDB v0.14.4 on loopback, commit `1fe624a`): `bun run rehearsal smoke` 4/4 (brief, emit, register, claim). 

R5 on the twin: `/healthz.ledger` = `{ writable: true, lastProbeOk: true }` with the `substrate_health` probe row visible under `capacity.ledger.tables` (region statistics parsed from the v0.14.4 twin); ledger paused → `eventsWritable: false`, emit refused fast once the breaker opened; after recovery `lastProbeOk: true` again. TTL not set on the twin (`SUBSTRATE_LEDGER_TTL` unset → no ALTER, as designed). Steady-state emit call count: covered by `ledger-chain.test.ts`; production verification pending deploy.
