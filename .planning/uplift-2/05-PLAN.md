# R5 plan — GreptimeDB ledger: cheaper writes, bounded reads, honest health, capacity, opt-in TTL

## Files
- `packages/mcp-server/src/greptime.ts`: `LedgerSettings` + `loadLedgerSettings(env)`; chain-tip LRU (`lastHash` seeds, `insertEvent` updates/invalidates); bounded `lastHash` with unbounded fallback; `eventIdsAfter` inner-side bound + `event_ts`; `eventsByIds` accepts positions and bounds `ts`; `migrate()` creates `substrate_health` and applies the opt-in TTL; `writeProbe()` / `probeWritable()`; `capacity()`; `send()` split out of `sql()` so the one guarded `ALTER … SET 'ttl'` path bypasses `assertAppendOnly` only for the exact statement shape.
- `packages/mcp-server/src/config.ts`: `SubstrateConfig.ledger` (end), `loadConfig` (end), `ConfigError` on an invalid `SUBSTRATE_LEDGER_TTL`.
- `packages/mcp-server/src/service.ts`: `emitChains` private field block; `append()` serialised per session; `health()` probe + `ledger` + `capacity.ledger`; constructor passes `ledger: config.ledger` to the client (one line).
- Tests: new `ledger-chain.test.ts`; additions to `greptime.test.ts`; expectation updates in `service.test.ts` (health `toEqual`, `capacity`) and `http.test.ts` (`capacity`) and `greptime.test.ts` (`eventIdsAfter` select list).
- Docs: `docs/greptime-ledger.md` (chain cache, bounded reads, write probe, capacity, stale table cleanup, TTL + export + rollback); `.planning/uplift-2/env-notes/05.md`; `05-SUMMARY.md`.

## Knobs (defaults)
| `SUBSTRATE_LEDGER_CHAIN_CACHE` | on; `0|false|no` off |
| `SUBSTRATE_LEDGER_CHAIN_CACHE_MAX` | 10000 (1..1_000_000) |
| `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` | 30 (1..3650) |
| `SUBSTRATE_LEDGER_WRITE_PROBE_S` | 60 (0 = off, ≤86400) |
| `SUBSTRATE_LEDGER_TTL` | unset = no ALTER; Greptime duration grammar (`180d`, `4320h`, `1h30m`) |

## Tests (written, not run)
chain cache hit/miss/invalidate (fake transport counts `lastHash` reads); bounded `lastHash` SQL + fallback; concurrent same-session emits form one chain; SSE statements carry bounds; `substrate_health` created at migrate; probe cadence (fake clock) and `eventsWritable` flip; capacity parse; TTL no-ALTER/ALTER-on-difference/invalid refused; arbitrary ALTER still refused.

## Rollback
`SUBSTRATE_LEDGER_CHAIN_CACHE=0` + `SUBSTRATE_LEDGER_WRITE_PROBE_S=0` restore the previous read-per-emit and metadata-only health; `SUBSTRATE_LEDGER_TTL` unset leaves TTL as is — an applied TTL is reversed by the operator with `ALTER TABLE … UNSET 'ttl'`; or `git revert` the R5 range.

## Verification (orchestrator)
`bunx tsc --noEmit`; `bun test packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/ledger-chain.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/http.test.ts`; `bun run check:phase-close`; rehearsal `smoke:chaos --plane greptime`.
