---
phase: 06-ledger
plan: 07
subsystem: cli
tags: [wave-4, cli, verify, per-hour-chain, verify-timeout, d-11, d-17, sc3, t-06-07-01, t-06-07-02, t-06-07-03]

requires:
  - phase: 06-ledger
    provides: 06-04 verifyGraph reply (ok, events, brokenAt, reason, chain, hours[{period_start, hour_events, graph_events, chain}])
  - phase: 06-ledger
    provides: 06-05-CUTOVER.md (smoke_graph_id, smoke_hour, smoke_graph_verify_ok=true, post_cutover_chain_breaks=0)
provides:
  - "`substrate verify <graph_id>` with its own SUBSTRATE_VERIFY_TIMEOUT_MS (DEFAULT_VERIFY_TIMEOUT_MS = 60000) and one `hour <period_start> chain <ok|broken> (<graph_events> of <hour_events> events)` line per hours entry"
  - "`post(path, body, timeoutMs = timeout())` — brief and emit keep SUBSTRATE_TIMEOUT_MS / 1500"
  - .planning/phases/06-ledger/06-07-SMOKE.md — canned cli_* keys, live smoke_* keys, pre_cutover_graphs_verified, verify_max_ms (read by 06-09)
affects: [06-09]

actuals:
  tasks: 2
  commits: 3         # 282698d (CLI) + da46bd7 (SMOKE.md) + this SUMMARY
plan_head_before: e798985

key-decisions:
  - "Hour lines go to stdout on both paths, after the intact (stdout) or BROKEN (stderr) line; exit stays 0/1 from body.ok"
  - "cli_brief_timeout_unchanged is read from the canned server's abort log (/brief aborted 1500 ms after arrival), not the 2 s wall-clock bound, which bun start-up plus two git subprocesses exceed on this loaded host"

duration: 12min
completed: 2026-09-27
status: complete
---

# Phase 6 Plan 07: Chain-only `substrate verify` — Summary

**`substrate verify` now waits up to 60 s (SUBSTRATE_VERIFY_TIMEOUT_MS) for the server's whole-hour
chain recomputation and prints one chain verdict per ingest hour. On production the 06-05 smoke graph
reads `hour 2026-09-27T13:00:00.000Z chain ok (29 of 42 events)` and all 19 baseline graphs pass with
exit 0 (slowest 2397 ms). By owner decision D-17 there is no anchor check.**

## Performance

- **Started:** 2026-09-27T13:05Z
- **CLI commit:** 2026-09-27T13:11:18Z (282698d)
- **Evidence commit:** 2026-09-27T13:14:27Z (da46bd7)
- **Completed:** 2026-09-27T13:16Z
- **Tasks:** 2/2

## Task 1: CLI verify timeout and per-hour chain lines (D-11 chain half, D-17)

packages/cli/src/index.ts:
- `DEFAULT_VERIFY_TIMEOUT_MS = 60000` and `verifyTimeout()`, which parses its variable the same way
  `timeout()` does (a non-positive or non-numeric value falls back to 60000).
- `post()` takes an optional `timeoutMs`.
- `cmdVerify` makes a single `post("/verify", { graph_id }, verifyTimeout())` call, widens its body
  type with `hours?`, and prints the hour lines.
- The header comment and usage line mention the new variable.
- No imports were added. The mcp-server package is untouched, and so are brief, emit, run and
  `skills propose`.

Canned-server check (throwaway, deleted):

| Key | Value |
|---|---|
| cli_ok_exit / cli_ok_hour_lines | 0 / 2 |
| cli_pre_hour_lines | 0 |
| cli_broken_exit / cli_broken_hour_chain | 1 / broken |
| cli_timeout_env_honoured | true (1000 → unreachable, exit 1, server abort at 1003 ms; unset → exit 0 after 3 s; `abc` → default) |
| cli_default_timeout_ms | 60000 |
| cli_brief_timeout_unchanged | true (/brief aborted 1500 ms after arrival with SUBSTRATE_VERIFY_TIMEOUT_MS=60000) |
| cli_usage_exit | 2 |

## Task 2: Live chain-only verify (SC3 chain clause)

| Key | Value |
|---|---|
| smoke_graph_id | ut-ledger-smoke-20260927T130216Z (= 06-05) |
| smoke_verify_exit / smoke_hour_chain / smoke_hour_lines | 0 / ok / 1 |
| smoke_verify_ms | 1697 |
| pre_cutover_graphs_verified | 19/19 (no hour lines: pre-cutover rows only) |
| verify_max_ms | 2397 (ut-muh1trcj-90066f6e; above 1500, below 60000) |

substrate-mcp was active and /healthz returned 200 throughout. The service was not edited or
restarted.

## Gates

| Gate | Result |
|---|---|
| tsc (normalized) | `tsc-exit=0` = baseline set |
| root suite | 634 pass / 0 fail, 36 files (> agent-substrate-pass 534); no failing ids, same as baseline |
| dispatcher pytest | 149 passed (= dispatcher-pass), no FAILED ids |
| Task 1 `<automated>` (verbatim, after 282698d) | exit 0 |
| Task 2 `<automated>` (verbatim, after da46bd7) | exit 0: live smoke intact line and hour line, 19/19 baseline, no anchor/devnet/pending/unverified, no token shape |

## Deviations from Plan

1. **[Measurement] cli_brief_timeout_unchanged evidence.** The plan's wall-clock bound ("returns
   within 2 s") measured 2000–2899 ms over four runs. Bun start-up and the two git subprocesses
   `brief` spawns take 400–900 ms on this host under concurrent load, so the bound does not measure
   the budget. The canned server was changed to log how long after arrival the client aborted each
   request. /brief was aborted at 1500 ms, which proves brief keeps its 1.5 s budget with
   SUBSTRATE_VERIFY_TIMEOUT_MS=60000 set. Both numbers are recorded in SMOKE.md.
2. **[Plan-check I7(a)] Recorded as a Gap in SMOKE.md.** The canned `cli_*` keys cannot be observed
   again. The ok path is re-checked live, and 06-09 checks the broken path.

The other plan-check info items (I1–I6, I7(b)/(c)) concern the text of 06-04, 06-CONTEXT and 06-09.
They are outside this plan's files and were not changed.

## Issues Encountered

- The live timings were taken while the Task 1 verify's root suite was running, so verify_max_ms is
  an upper bound on this host (noted under Gaps in SMOKE.md).

## Anchoring skipped (D-17)

There is no anchor status, signer check, memo read, pending or unverified state, config.ledger or
SOLANA_* anywhere in the CLI change. SC3's signature clause is skipped by the owner. A consistent
rewrite of every row from a given row to the head, followed by a restart, would still pass the chain
check; this is accepted as T-06-07-03.

## Known Stubs

None.

## Threat Flags

No new threats beyond the register:
- T-06-07-01: verify has its own 60 s timeout; the canned server showed that brief keeps 1.5 s.
- T-06-07-02: the CLI makes one POST and imports nothing from the ledger or greptime modules
  (Task 1 diff check).
- T-06-07-03: accepted under D-17.

## User Setup Required

None. Next: 06-09 reads smoke_hour_chain / verify_max_ms from 06-07-SMOKE.md.

## Self-Check: PASSED

- 282698d touches only packages/cli/src/index.ts. da46bd7 touches only 06-07-SMOKE.md. Both carry
  Refs SPE-3576 and Refs SPE-3970.
- /tmp/06-07-canned.ts and the other throwaway files are deleted.
- Both plan verifies exited 0. SMOKE.md contains no token-shaped strings.
