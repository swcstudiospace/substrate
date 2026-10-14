# U5-4a — idempotent replay for `POST /events` (server half)

Slice branch `u5/s4`. The wire contract (`U5-4-CONTRACT.md`) is implemented as written, with one additive tightening from review: **a replay-marked request that carries a key MUST also carry the original attempt's `ts`**; without it the server answers 400 `replay_ts_missing` (mode ≠ off only, before any statement, counted `refused`). Without a client `ts` the server stamps its own clock, so the lookup could never match and the replay would append a duplicate that looked like an ordinary miss. Contract line to read as: "a REPLAY-marked request carrying a key MUST carry the original `ts`; otherwise 400 (`replay_ts_missing`), nothing stored." U5-4b already fixes `ts` at the first attempt, so a conforming client is unaffected.

## What changed

| File | Change |
| --- | --- |
| `packages/mcp-server/src/types.ts` | `EventInput.idempotency_key?`; `EVENT_IDEMPOTENCY_MODES` / `EventIdempotencyMode`. |
| `packages/mcp-server/src/event.ts` | `IDEMPOTENCY_KEY_PATTERN` (`^[A-Za-z0-9._:-]{8,128}$`), `IDEMPOTENCY_PAYLOAD_KEY` (`_ik`), `REPLAY_MAX_FUTURE_MS` (24 h), closed `IDEMPOTENCY_RULES` (`idempotency_key_type`, `idempotency_key_format`, `replay_ts_missing`, `replay_ts_future`), `IdempotencyRefusal extends InvalidEventError` (carries `rule`), `checkIdempotencyKey`, `checkReplayTs(ts, now, keyed)` (missing = any falsy `ts`, as `normalizeEvent` reads it; the 24 h bound parses a string OR a JSON number through `new Date(ts)` like `normalizeEvent`, other types left to its `invalid ts`); `normalizeEvent(input, prev, idempotency?)` — with the third argument absent the payload path is the old one byte for byte; with it, a caller `_ik` is stripped first and a valid key is appended as the LAST payload key after redaction and capping. |
| `packages/mcp-server/src/greptime.ts` | `GreptimeClient.findByIdempotencyKey(cell, key)`: one `SELECT "id","hash","payload" … WHERE surface/repo/graph_id/kind prefix AND "ts" = <exact> AND "payload" LIKE '%"_ik":"<key>"}' LIMIT 5` (`IDEMPOTENCY_LOOKUP_LIMIT`); NULL repo/graph_id as `IS NULL`; refuses a malformed key and (until the quoting dialect is probed) a backslash in repo/graph_id, like `insertEvent`; scans the returned rows for the exact suffix (a `LIKE` lookalike that sorts first cannot hide the real row); throws on any ledger error or a returned row without string id/hash. All Greptime SQL stays in this file. |
| `packages/mcp-server/src/service.ts` | `emit(input, { replay? })`; `idempotencyPlan` (mode `off` ⇒ `null`, nothing differs); lookup inside `appendChained`, i.e. inside the per-session turn (`emitChains`); a keyed event with no session takes its turn on the key (`KEY_TURN_PREFIX`) so a replay waits for an in-flight original; hit ⇒ `{ stored: true, deduplicated: true }` with the existing id/hash, no `lastHash`, no insert, no ingest record, no `emitted` sample; lookup error ⇒ `{ stored: false, lookupFailed: true, error }`; `SubstrateObserver.eventReplay`. `IngestNotRecorded ⇒ stored:true` handling untouched. |
| `packages/mcp-server/src/server.ts` | reads `x-substrate-replay === "1"` and passes `{ replay }`; response gains `"deduplicated": true` on a hit; the 400 body gains `"rule"` for an `IdempotencyRefusal`; `/healthz` body gains `"idempotency": <mode>` (static config, so the existing memo cannot make it stale). The future-`ts` rule lives in the service (next to the key rules) rather than `server.ts`: same 400, same rule name, one place. |
| `packages/mcp-server/src/config.ts`, `index.ts` | `eventIdempotency` / `eventIdempotencyRejected`, `eventIdempotencyConfigWarnings` in the one boot-warning loop. Invalid ⇒ `off` + warning, never throws. |
| `packages/observability/src/{instruments,index}.ts`, `packages/mcp-server/src/observe.ts` | counter `substrate.events.replay{result=deduplicated\|appended\|refused\|lookup_failed}` (`EVENT_REPLAY_RESULTS`, closed), `recordEventReplay`, observer hook. |
| `docs/greptime-ledger.md`, `docs/collectors.md`, `docs/observability.md` | § Idempotent replay (modes, lookup, hit/miss/error/refusal, cost, capability, the honest limits, enable order, rollback), config row, shared-emit paragraph, metric row. |
| `packages/mcp-server/src/event-idempotency.test.ts` | new, see below. |
| `.planning/uplift-5/env-notes/S4a.md`, this file | deliverables. |

## Flag and defaults

`SUBSTRATE_EVENT_IDEMPOTENCY=off|accept|enforce`, default `off`, trimmed and case-insensitive; anything else is `off` plus one boot warning. Under `off`: no key validation, no `_ik` stripping (a caller-written payload `_ik` is stored as before), no lookup, no new response field, `/healthz` is the only visible change (`"idempotency":"off"`, additive).

## Tests (`event-idempotency.test.ts`, no network, no ports of its own)

The ledger is an in-memory `agent_events` behind a replaced `fetch`; it evaluates the lookup statement's own predicates including real `LIKE` wildcards, so the tests see the statements the real client sends.

- `off` parity: key, malformed key, marker ⇒ same statement sequence as a keyless event, zero lookups, payload `{}`; caller `_ik` kept; a replay is appended twice.
- `accept`: unmarked keyed ⇒ `_ik` last key, zero lookups, chain verifies (key is hashed); marked hit ⇒ same id/hash/ts, no INSERT, no ingest record, `deduplicated` counted and `emitted` NOT; the lookup text itself (prefix, `IS NULL`, exact `ts`, suffix pattern, `LIMIT 5`); miss ⇒ one lookup + append; marker without key ⇒ no lookup; the core case (INSERT lands, reply lost as 503, replay dedupes, next event chains onto the stored row).
- Turn: two concurrent same-key replays ⇒ one row (second provably has not looked while the first is stalled), same for sessionless events, and a replay waits for an in-flight original.
- `enforce`: keyed requests look up marked or not; keyless never.
- Not-a-dedupe: caller `_ik` stripped and replaced; nested `_ik` does not match; different kind/repo/`ts` is another event; a `LIKE`-wildcard lookalike key is a miss, not a false hit; a lookalike that sorts FIRST with the real row second is still a dedupe hit; an oversize payload (replaced by `_dropped`) still carries the key and its replay dedupes.
- Chain verifies after a dedupe mid-session and after a late (3-days-backdated) replay.
- Failure branches write nothing: lookup error ⇒ `stored:false`, `lookupFailed`, redacted, counted, retry later dedupes; malformed hit row ⇒ error not miss; future-`ts` replay ⇒ `replay_ts_future` before any statement (and 23 h ahead is accepted, unmarked future is accepted); a numeric far-future `ts` is refused the same way, a numeric in-window `ts` is stored as its ISO text; a keyed replay with a missing `ts` (undefined, `null`, `""`, `0`) ⇒ `replay_ts_missing` before any statement under `accept` and `enforce`, while an unmarked keyed request, a keyless marker and mode `off` are not refused; marker without key is still held to the future bound; every invalid-key shape ⇒ its rule under `accept` and `enforce`, none under `off`; boundary lengths and alphabet accepted.
- Config parse and warning; HTTP: `/healthz.idempotency` for off/accept/enforce/typo, 202 `deduplicated` body with the original id, 503 `stored:false` on a lookup error, 400 with `rule` for bad key, missing-`ts` replay and future replay (all counted `refused`), `off` ignores header and key (two rows, body keys exactly `hash,id,stored,ts`, no counter points).

Each of these fails on the old code (no `emit` option, no lookup, no field).

## Locks checked

No new route or MCP tool: `POST /events` keeps its existing audit-policy, admission (`write`), observe-label and event-sources rows, and no event kind or surface was added, so no `policy.ts` / `admission.ts` / `event-sources.ts` / `docs/event-vocabulary.md` change was made. I did not run the lock tests; they are on the orchestrator's `check:phase-close` list. Greptime SQL is only in `greptime.ts`; `package.json` dependencies unchanged.

## Smoke for the orchestrator (scratch GreptimeDB on `127.0.0.1:54000`, db `public`, no auth)

```sh
# server env: the Greptime URL variable set to the scratch endpoint on loopback port 54000, the Greptime db variable to `public`
SUBSTRATE_PORT=7499 SUBSTRATE_ALLOW_ANONYMOUS=1 SUBSTRATE_EVENT_IDEMPOTENCY=accept \
  bun run mcp &        # never 7410/7411/6420
curl -s 127.0.0.1:7499/healthz | grep -o '"idempotency":"[a-z]*"'      # "idempotency":"accept"
BODY='{"surface":"omp","kind":"note","summary":"u5-4a smoke","session_id":"u5-4a-smoke","repo":"u5/smoke","ts":"2026-10-13T10:00:00.000Z","idempotency_key":"u5-4a-smoke-0001"}'
curl -s -XPOST 127.0.0.1:7499/events -d "$BODY"                                         # 202 {"id":"evt_…","stored":true}
curl -s -XPOST 127.0.0.1:7499/events -H 'x-substrate-replay: 1' -d "$BODY"              # 202, same id, "deduplicated":true
curl -s -XPOST 127.0.0.1:7499/events -H 'x-substrate-replay: 1' -d "${BODY/0001/x}"    # 400 {"rule":"idempotency_key_format",…}
curl -s 127.0.0.1:54000/v1/sql?db=public --data-urlencode "sql=SELECT count(*) FROM agent_events WHERE repo = 'u5/smoke'"   # one row counted
curl -s 127.0.0.1:7499/metrics | grep -o 'substrate.events.replay'                     # present
```

Expected: exactly one `u5/smoke` row after the two valid posts; the replay returns the first id. Repeat with `SUBSTRATE_EVENT_IDEMPOTENCY` unset: the replay is a plain 202 without `deduplicated` and the count becomes 2 (the documented `off` limit). Whether the server starts without `GREPTIME_USER`/`GREPTIME_PASSWORD` was not checked; add them if `loadConfig` insists.

## Operator steps (not done here)

1. Set `SUBSTRATE_EVENT_IDEMPOTENCY=accept` in the env file, restart `substrate-mcp`, confirm `/healthz` reports `"idempotency":"accept"`. Only then enable a client spool (U5-4b).
2. Before `enforce`: run `EXPLAIN` of the lookup statement (shape above, with a real cell) against the production ledger and look at the scan; the exact-`ts` + primary-key-prefix predicate is expected to be cheap but is **unmeasured**.
3. Rollback: `off` and restart. Stored `_ik` is ordinary payload data.

## Known limits and unknowns

- Dedupe is per (`surface`, `repo`, `graph_id`, `kind`, `ts`) cell and per replay-marked request (or any keyed one in `enforce`); `_ik` is reserved; each replay costs one read; under `off` replays duplicate. The docs say exactly this.
- `LIKE` reads `_` as a wildcard, so lookalike keys in one cell and one millisecond can match the pattern. The lookup reads up to 5 rows and takes the first whose payload ends with the exact suffix, so a lookalike sorting first does not hide the real row. If the read is SATURATED (5 rows) and none ends with the exact suffix, the real row may sit past the limit, so the lookup fails closed like a lookup error: 503 `stored:false`, nothing written, counted `lookup_failed` (a short read with no exact match is a genuine miss and appends). So an unusual key shape (many other keys in the same cell and ms that match its pattern through `_`, e.g. `event___` beside `event001`…`event005`) can answer 503; it can no longer write a duplicate. Escaping `_` with `ESCAPE` was not done because the repo's dialect probe does not establish `LIKE ... ESCAPE` support.
- `_ik` is added after the 16 000-byte payload cap, so a capped payload can exceed it by about 140 bytes.
- A deduplicated result's `event.prev` is not the stored event's (nothing reads it; the HTTP body carries `id`, `ts`, `hash`, `stored`, `deduplicated` only).
- A scalar or array payload sent with a key is stored as `{"_payload": <value>, "_ik": …}` instead of being spread; such a payload is already outside the wire contract.
- The MCP `events_emit` tool does not carry the key or marker; only `POST /events` does (the contract names only that route).
- `/healthz.idempotency` reports the configured mode even when no ledger is configured; replays then answer 503 `stored:false` as every append does.
- Run in the corrective round by the orchestrator (targeted tests and tsc); the smoke above ran green in the first round.
