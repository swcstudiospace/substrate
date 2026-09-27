---
phase: 06-ledger
plan: 04
subsystem: ingest-chain
tags: [wave-2, global-ingest-chain, ingested-at, greptime-ddl, batching, client-ts-guard, verify-split, d-01, d-02, d-03, d-08, d-09, t-06-04-01, t-06-04-02, t-06-04-03, t-06-04-04, t-06-04-05, t-06-04-06, t-06-04-07]

requires:
  - phase: 06-ledger
    provides: 06-BASELINE.md (534/0/29, tsc clean, pytest 149) and the 95-row pre-cutover fixture from 06-01; 06-01-SPIKE.md (ADD COLUMN FIELD timestamp(3), half-open hours, multirow_insert_atomic=yes)
  - phase: 06-ledger
    provides: packages/ledger/src/period.ts HOUR_MS, hourStart, hourIso (06-02)
  - phase: 06-ledger
    provides: 06-03 closed at its funding checkpoint by the owner ("Skip Phase 6 anchoring", D-17) — nothing in 06-04 needed the devnet key
provides:
  - packages/mcp-server/src/types.ts — SubstrateEvent.ingested_at?: string (hashed; absent, never null, on pre-cutover rows); prev doc reworded
  - packages/mcp-server/src/event.ts — normalizeEvent(input, prev, ingestedAt?), rowToEvent (moved, absent-not-null), ChainResult, verifySessions, verifyGlobalChain (reset/fork named)
  - packages/mcp-server/src/greptime.ts — EVENT_COLUMNS (17), ColumnInfo/ChainHead/EventKey, columns(), guarded migrate(), insertEvents, chainHead, eventsAtKeys, hourEvents, lastEventBefore; insertEvent and lastHash deleted
  - packages/mcp-server/src/chain.ts — ChainStore, ChainState, IngestChain (append, seed, state; one INSERT per drain turn; client-ts guard)
  - packages/mcp-server/src/service.ts — Substrate.chain, emit through IngestChain, seedChain(), verifyGraph pre/post split (GraphVerification, ChainSide, HourCheck)
  - packages/mcp-server/src/index.ts — seedChain() after migrate; `[substrate] chain head <state>` (or `[substrate] degraded — chain head unknown: …`)
affects: [06-05, 06-07, 06-09]

actuals:
  tokens: 21117      # chars/4 over `git diff f7cabc3..HEAD -- packages/mcp-server/src` (84467 chars)
  tasks: 3
  commits: 6         # git rev-list --count f7cabc3..HEAD after the SUMMARY commit: 515d664, 197a55c, 83506fe + this SUMMARY; 3507b79 and 3f9b069 are the orchestrator's D-17 docs commits landing in between
plan_head_before: f7cabc3

tech-stack:
  added: []
  patterns:
    - "In-process serializer: a promise-chained critical section; each drain turn takes queue.splice(0) and writes the batch in one multi-row INSERT"
    - "Ambiguous write → head 'unknown' → re-seed from the store before the next batch (never guess what landed)"
    - "Absent-not-null for fields added to a hashed record: canonicalJson drops undefined, so old digests are unchanged"
    - "Deterministic latency test: a virtual clock drives the store's round trips instead of wall-clock sleeps"

key-files:
  created:
    - packages/mcp-server/src/chain.ts
    - packages/mcp-server/src/chain.test.ts
    - packages/mcp-server/src/greptime.test.ts
  modified:
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/event.ts
    - packages/mcp-server/src/event.test.ts
    - packages/mcp-server/src/greptime.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/index.ts

key-decisions:
  - "Anchors DDL implemented per plan (orchestrator confirmed): migrate() drops the empty root-keyed anchors and creates the 11-column period-keyed table; it stays at 0 rows because anchoring is skipped (D-17) — nothing in this code writes it"
  - "IngestChain.seed() runs inside the same critical section as drain turns, so a boot/external seed can never install a stale head over a batch that just committed"
  - "An eventsAtKeys failure rejects the whole batch and leaves the head as it was (nothing was written); only an insert failure makes the head unknown"
  - "A server-timed event whose ingested_at would land on a storage key a client-ts event of the same batch took steps its ingested_at forward (in-batch collisions include server-timed events)"
  - "chainHead() throws GreptimeError on a row without hash/ingested_at instead of returning null — null means genesis, which would reset the chain"
  - "columns() filters information_schema.columns by table_schema = the configured db and orders by ordinal_position (fields checked against the Greptime docs)"
  - "Nudge exhaustion rejects with a plain Error (HTTP 500, producers fail open), not InvalidEventError (400)"
  - "verifyGraph reads every hour's rows and boundary concurrently (Promise.all) and evaluates them in ascending order; hours entries carry exactly period_start, hour_events, graph_events, chain"
  - "seedChain() with no Greptime answers 'unknown: greptime not configured'; index.ts writes unknown heads as a degraded line on stderr"

patterns-established:
  - "ChainStore is the slice of GreptimeClient the serializer needs; tests pass an in-memory store, production passes GreptimeClient"

requirements-completed: []

duration: 48min
completed: 2026-09-27
status: complete
---

# Phase 6 Plan 04: Global ingest chain code — Summary

**Every emit now goes through one in-process IngestChain: hashed on ingest over canonical JSON with a
global `prev` and a strictly increasing, hashed `ingested_at`, batched into one multi-row INSERT per
turn; verify checks pre-cutover rows per session and post-cutover rows as whole ingest hours — and
all 95 real pre-cutover rows still recompute to their stored hashes.** No live change: substrate-mcp
was not restarted, no DDL ran against Greptime (06-05 applies it and restarts).

## Performance

- **Started:** 2026-09-27T11:57:15Z
- **Completed:** 2026-09-27T12:45:00Z
- **Tasks:** 3/3
- **Files:** 3 created, 7 modified (all under packages/mcp-server/src)

## Task 1 — ingested_at, rowToEvent, the two chain checks (commit 515d664)

- `SubstrateEvent.ingested_at?: string`; `prev` doc now says per session before the cutover, the
  previous ingested event across all surfaces after it; null for a session's first pre-cutover
  event and for the genesis. SURFACES/EVENT_KINDS untouched (gate diff empty).
- `normalizeEvent(input, prev, ingestedAt?)`: ts defaults to ingestedAt, then now; `ingested_at` is
  added to the hashed object only when given; the stored object is still built field by field.
- `rowToEvent` moved from service.ts (private) to event.ts (exported); `ingested_at` set only for a
  non-null column (epoch ms → ISO).
- `verifySessions` = the old verifyGraph grouping; `verifyGlobalChain(events, boundaryPrev)` with the
  four reason strings from the interfaces block (null prev ≠ expected → "chain reset: …"; prev naming
  an earlier event of the stretch → "fork: …").
- Tests (+19): the fixture read with `readFileSync(new URL(...))` — 95 rows, 19 graphs, every graph
  ok through verifySessions, every stored hash recomputes; a NULL column still recomputes; an explicit
  `ingested_at: null` changes all 95 hashes and fails every graph. Forged id/hash/prev/ingested_at in
  the input are ignored. Global chain: genesis and boundary pass, boundary mismatch, reset, fork, stale
  hash, and a consistent rewrite passing.
- Mutation check: making rowToEvent always set ingested_at fails 5 of those tests.

## Task 2 — Greptime contract and IngestChain (commit 197a55c)

- greptime.ts: `EVENT_COLUMNS` (16 + ingested_at); `columns(table)`; `migrate()` = agent_events
  CREATE (now with "ingested_at" TIMESTAMP) → information_schema check → `ALTER TABLE "agent_events"
  ADD COLUMN "ingested_at" TIMESTAMP` only when absent → anchors guard (root TAG and count 0 →
  `DROP TABLE "anchors"`; root TAG with rows → GreptimeError "anchors has the old root-keyed schema and
  <n> rows; refusing to drop anchors", nothing dropped or created) → 11-column period-keyed anchors
  CREATE (period_start TIME INDEX, no PRIMARY KEY). `insertEvents` (one INSERT, 17 columns, NULL
  ingested_at when absent), `chainHead`, NULL-safe `eventsAtKeys` (`"repo" IS NULL`, never `= NULL`),
  `hourEvents` (`>= start AND < end ORDER BY "ingested_at", "id"`), `lastEventBefore`.
- chain.ts: `IngestChain` per the research critical section — queue of waiters, `queue.splice(0)`
  per turn, re-seed when unknown, client-ts guard (one eventsAtKeys per round, replay → stored event
  and no insert, different content → +1 ms, at most 5 moves then that input alone rejects),
  ingested_at = max(now, head + 1 ms), prev = head hash in arrival order, one insertEvents, commit
  head or reject all and go unknown. Single-writer rule in the class doc comment.
- Tests (+29): greptime.test.ts (recording `sql()` subclass, 15) and chain.test.ts (in-memory store,
  14) incl. the two named tests "batches queued emits into one insert" (50 appends → 1 insert,
  strictly increasing ingested_at, prev chain from the seeded head) and "stays under the hook budget"
  (first append in flight, then 6 more: 2 inserts, all resolved at 200 ms of a 100 ms-per-insert
  clock, bound < 350 ms). Mutation checks: one input per turn → both named tests fail (700 ms);
  no head reset after a failed insert → the re-seed test fails.

## Task 3 — emit through the chain, seedChain, verify split, old path removed (commit 83506fe)

- service.ts: `this.chain = this.greptime ? new IngestChain(this.greptime) : null`; `emit` returns
  `this.chain ? this.chain.append(input) : normalizeEvent(input, null)`; `seedChain()`;
  `verifyGraph` selects EVENT_COLUMNS for the graph (`ORDER BY "ts"` as before), verifySessions on
  rows without ingested_at, and per ingest hour of the graph's post rows `hourEvents(start, start +
  HOUR_MS)` + `lastEventBefore(start)` into verifyGlobalChain; reply `{ ok, events, brokenAt?,
  reason?, chain: { pre, post }, hours: [{ period_start, hour_events, graph_events, chain }] }`
  (the not-configured reply is unchanged).
- index.ts: after migrate, `[substrate] chain head <seeded|genesis>` on stdout, or
  `[substrate] degraded — chain head unknown: <reason>` on stderr.
- greptime.ts: insertEvent and lastHash deleted. service.test.ts: both stubs →
  `chainHead / insertEvents (push ...events) / eventsAtKeys`; the proposeSkill fail-open test
  ("an event write that throws does not change the result") now throws from `insertEvents` and still
  passes for the same reason (proposeSkill's `.catch`).
- Tests (+7) incl. "post-cutover interleaved sessions verify as one global hour" (two sessions of G
  interleaved with graph X in one hour → ok, one hours entry `{ period_start: 2026-09-27T13:00:00.000Z,
  hour_events: 5, graph_events: 3, chain: "ok" }`, hourEvents and lastEventBefore called for that
  hour); stale hash, boundary break and second null prev → brokenAt at that id, hour "broken", post
  side failed; pre and post both reported. Mutation: verifying hours per session fails 2 of them.
- `grep -rlwE 'lastHash|insertEvent' packages/*/src --include=*.ts` → nothing. server.ts and mcp.ts
  unchanged since c31f820.

## Gates (two-sided vs 06-BASELINE.md)

| Gate | Result |
|---|---|
| Task 1 verify (at its commit) | exit 0 — root suite 598 pass / 0 fail / 34 files, tsc-exit=0, fixture unmodified (sha256 e73e05f2…d303), no SURFACES/EVENT_KINDS entry removed |
| Task 2 verify (at its commit) | exit 0 — 627 pass / 0 fail / 36 files, tsc-exit=0 |
| Task 3 verify (pre-commit, then at 83506fe) | exit 0 — 634 pass / 0 fail / 36 files, tsc-exit=0, dispatcher pytest 149 passed (FAILED set empty = baseline), no `lastHash`/`insertEvent` word under packages/*/src, server.ts and mcp.ts unchanged since c31f820, last service.ts commit carries `Refs SPE-3576` |
| All three plan verifies re-run at final HEAD 83506fe | t1 exit 0, t2 exit 0, t3 exit 0 — 634 pass / 0 fail each run, tsc-exit=0, pytest 149 passed |

Pass count 634 > agent-substrate-pass 534 (+55 over 06-02's 579: event 19, greptime 15, chain 14,
service 7). Failing-id set and normalized tsc set identical to the baseline (both empty /
`tsc-exit=0`); dispatcher 149 ≥ dispatcher-pass 149 with no FAILED ids.

## Smoke (throwaway /tmp/06-04-smoke.ts, deleted)

Real `packages/mcp-server/src/index.ts` on 127.0.0.1:17490 with GREPTIME_URL pointing at a fake
Greptime HTTP endpoint on 127.0.0.1:17491 (answers information_schema with agent_events lacking
ingested_at and a root-TAG anchors table with 0 rows; INSERT sleeps 100 ms). No production env,
no live Greptime, substrate-mcp untouched.

```
boot_chain_head_line=[substrate] chain head genesis
migrate_alter=["ALTER TABLE \"agent_events\" ADD COLUMN \"ingested_at\" TIMESTAMP"]
migrate_drop_then_create=[true,true]
seed_query=SELECT "hash", "ingested_at" FROM "agent_events" WHERE "ingested_at" IS NOT NULL ORDER BY "ingested_at" DESC LIMIT 1
burst_statuses=[202,202,202,202,202,202,202]
burst_insert_statements=2
burst_rows=7
genesis_prev_null=true
prev_chain_ok=true
ingested_at_strictly_increasing=true
reply_hashes_match_rows=true
server_ts_equals_ingested_at=true
forged_fields_ignored=true
client_ts_status=202
client_ts_key_query_null_safe=true
client_ts_chained_on_burst=true
verify_reply={"ok":true,"events":0,"chain":{"pre":{"ok":true,"events":0},"post":{"ok":true,"events":0}},"hours":[]}
```

Burst wall time against the fake: 597–599 ms cold (first insert reached the fake 297–301 ms after
the first POST — first-request warm-up in the fresh process), 301 ms warm (inserts started at 2 and
200 ms); both bursts took exactly 2 INSERTs. The fake's own round trip measured ~200 ms (100 ms sleep
plus transport), so these are transport numbers, not chain overhead; 06-05 measures live latency.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Flaky test] "stays under the hook budget" moved from wall-clock to a virtual clock**
- **Found during:** Task 2 (full-suite gate run)
- **Issue:** the first version slept 100 ms per insert in real time and failed once at 400 ms under
  host load (load average ≈ 9; the same test passed alone and in the next full run) — a gate that
  flakes with other agents' load.
- **Fix:** the in-memory store's insert awaits a `VirtualClock.sleep(100)` the test runs; the test
  asserts all 7 resolve before 350 (and exactly at 200) virtual ms with inserts `[1, 6]`.
- **Verification:** passes in every run; the one-input-per-turn mutant reads 700 ms and fails.
- **Commit:** 197a55c

**2. [Rule 2 - Robustness] IngestChain fails a batch closed on an unexpected error**
- **Found during:** Task 2 review
- **Issue:** a throw escaping a drain turn would have left that batch's waiters pending forever and
  surfaced as an unhandled rejection.
- **Fix:** the drain wraps each turn; an unexpected error rejects every waiter of the batch (settled
  ones ignore it) and sets the head to unknown.
- **Commit:** 197a55c

### Additions within the plan's intent (not in the behavior list)

- seed() serialized with drain turns; eventsAtKeys failure rejects the batch without touching the
  head; in-batch server-timed/client-ts key collision steps ingested_at; chainHead() throws on a
  malformed head row; columns() scoped to the configured db (see key-decisions).

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 2). **Impact:** test reliability and failure
containment only; no contract name or reply shape differs from the plan's interfaces block.

## Issues Encountered

- My first wrapper for the plan's Task 2 `<automated>` block added `set -o pipefail`, which makes the
  empty `grep -E '^\(fail\)'` stage fail (VERIFY-EXIT=1 with 627 pass / 0 fail / tsc 0). The plan's
  commands were re-run verbatim without it; every gate below is the plan's own command.
- The orchestrator committed 3507b79 and 3f9b069 (D-17 docs re-scope) between Task 1 and Task 2; no
  file overlap.

## Anchoring skipped (D-17)

The period-keyed `anchors` table is part of this plan's guarded migrate() (D-08, confirmed by the
orchestrator) and 06-05 creates it live, but it stays at 0 rows: the owner skipped Phase 6 anchoring
("Skip Phase 6 anchoring", 06-03), so no ledger job or verify path writes or reads it. Integrity of
post-cutover hours rests on the global chain alone; a consistent rewrite of a whole stretch passes
verifyGlobalChain (pinned by a test) — only an anchor could catch that.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: T-06-04-01 (forged fields ignored — tested and smoked),
T-06-04-02 (ts := ingested_at, NULL-safe client-ts guard), T-06-04-03 (one INSERT per turn),
T-06-04-04 (unknown head re-seed; fork named), T-06-04-05 (fixture + inverse), T-06-04-06 (DROP only
empty root-TAG anchors; refusal tested), T-06-04-07 (single-writer rule documented in chain.ts).

## User Setup Required

None. Next: 06-05 runs the guarded migrate live and restarts substrate-mcp.

## Self-Check: PASSED

chain.ts, chain.test.ts, greptime.test.ts and this file exist; commits 515d664, 197a55c and 83506fe
exist; no token shape in this file.
