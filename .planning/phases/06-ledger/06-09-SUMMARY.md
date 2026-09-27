---
phase: 06-ledger
plan: 09
subsystem: ledger-proof
tags: [wave-5, proof, tamper, global-chain, d-12, d-17, sc1, sc3, t-06-09-01, t-06-09-02, t-06-09-04, t-06-09-06]

requires:
  - phase: 06-ledger
    provides: 06-04 whole-hour global chain verify (verifyGlobalChain, hourEvents, lastEventBefore)
  - phase: 06-ledger
    provides: 06-05 live cutover (global ingest chain on production)
  - phase: 06-ledger
    provides: 06-07 `substrate verify` per-hour chain lines, 60 s verify timeout; 06-07-SMOKE.md smoke_verify_exit=0, smoke_hour_chain=ok
provides:
  - .planning/phases/06-ledger/06-PROOF.md — Setup, Tamper (a), Tamper (b), Final, Tamper script, Gaps; proof_result=pass
  - /var/lib/substrate/phase6-baseline/06-09/20260927T131911Z/originals.json (0600 root) and RESTORE.d/06-09.md
affects: [ROADMAP Phase 6 proof, SC1, SC3 chain clause]

actuals:
  tasks: 3
  commits: 2         # 86d5b81 (06-PROOF.md) + this SUMMARY
plan_head_before: ca72dd3

key-decisions:
  - "The middle event's global successor was event 3 itself (no other producer ingested between the emits), located before any write: successor_rows=1, in the proof hour"
  - "The plan's single proof commit at the end of Task 3 was kept (Tasks 1–2 say 'do not commit yet'); live writes were all done before the doc sections were appended, keeping each tamper window under 8 s"

duration: 20min
completed: 2026-09-27
status: complete
---

# Phase 6 Plan 09: Chain-only tamper proof — Summary

**Altering one event row makes `substrate verify` flag the graph through the global ingest chain
alone, whether or not the attacker fixes the row's own hash. (a) A stale hash breaks at the row with
"hash does not match contents"; (b) a recomputed hash breaks at the recorded global successor with
"prev does not match the preceding event". Both tampers were restored byte-equal and hour
2026-09-27T13:00:00.000Z verifies `chain ok` again. Nothing anchored (D-17): anchors 0 rows.**

## Performance

- **Started:** 2026-09-27T13:17Z
- **Emits:** 13:19:13–13:19:17Z; tamper (a) 13:20:36.989Z → restore 13:20:44.387Z; tamper (b) 13:21:02.287Z → restore 13:21:09.987Z
- **Proof commit:** 86d5b81
- **Tasks:** 3/3

## Proof keys

| Key | Value |
|---|---|
| proof_graph_id / session | ut-ledger-proof-20260927T131911Z / …-s1, 3 events, all in hour 2026-09-27T13:00:00.000Z |
| verify_before | exit 0, `hour 2026-09-27T13:00:00.000Z chain ok (3 of 52 events)` |
| originals | 0600 root, sha256 1c6893ef…2b7d, 3 rows (captured before any write; RESTORE.d/06-09.md written before tamper) |
| middle_successor | evt_e4816d83… (= event 3), rows 1, in proof hour, not after event 3 |
| b_detectable_by_chain | true |
| (a) | read-back summary changed, stale hash, key 1 row, graph 3 rows; verify exit 1, `hash does not match contents` at evt_7975e0d7… (event 2), hour chain broken; window 7.398 s |
| (a) restore | byte-equal; verify exit 0, hour chain ok |
| (b) | read-back hash recomputed, key 1 row, graph 3 rows; verify exit 1, `prev does not match the preceding event` at evt_e4816d83… (= b_expected_successor = middle_successor), hour chain broken; window 7.700 s |
| b_caught_by | chain-prev-linkage |
| (b) restore | byte-equal; verify exit 0, hour chain ok |
| final_rows_equal_originals | true (rows_equal=3/3) |
| final_verify_exit / final_hour_chain | 0 / ok |
| final_pre_cutover_graphs_verified | 19/19 |
| phase6_producer_changes / phase6_dependency_changes | 0 / 0 |
| solana_config_rpc_final | http://127.0.0.1:8899 |
| anchors_rows_final | 0 |
| sc1_rescope / sc2_status / sc3_signature_clause | D-01 / skipped-owner-D-17 / skipped-owner-D-17 |
| proof_result | pass |

## Gates

| Gate | Result |
|---|---|
| tsc (normalized) | `tsc-exit=0` = baseline set |
| root suite | 634 pass / 0 fail, 36 files (> agent-substrate-pass 534); no failing ids, same as baseline |
| dispatcher pytest | 149 passed (= dispatcher-pass), no FAILED ids |
| Task 1 `<automated>` (verbatim) | exit 0 |
| Task 2 `<automated>` (verbatim) | exit 0 |
| Task 3 `<automated>` (verbatim, after 86d5b81) | exit 0: live rows_equal=3/3, anchors_rows=0, hour chain ok, 19/19 baseline, no producer/manifest paths, Solana RPC localhost, substrate-mcp active, tamper script gone, no token shape, tsc/suite/pytest two-sided vs 06-BASELINE.md |

## Deviations from Plan

1. **[Script] `final` mode added** to /tmp/06-09-tamper.ts (rows_equal over the capture plus the
   anchors count), alongside the plan's modes; the plan's Task 2/3 verifies ran their own inline
   one-shot for the same check. `capture` also prints each row's prev and summary. The script's source
   is quoted in 06-PROOF.md.
2. **[Script] Greptime client timeout 30 s** in the throwaway script (the service default is 5 s) so
   a slow round trip could not leave a tamper half-observed; no write timed out.

## Anchoring skipped (D-17)

No devnet call, no timer, no anchor row. The residual risk — a consistent rewrite of the middle row
and every later row through the head, followed by a substrate-mcp restart — passes the chain and is
stated under Gaps in 06-PROOF.md (T-06-09-06, accepted); it was not attempted.

## Known Stubs

None.

## Threat Flags

- T-06-09-01 / -02: originals captured 0600 before any write; every write read back (key rows 1,
  graph rows 3, byte-equal after restore); final live comparison rows_equal=3/3.
- T-06-09-03: windows 7.4 s and 7.7 s, recorded.
- T-06-09-04: every value from CLI output or read-back; successor located before the tamper.
- T-06-09-05: evidence scanned for token shapes (0); script reads GREPTIME_* only from its environment.
- T-06-09-06: accepted under D-17.

## User Setup Required

None. Orchestrator: annotate ROADMAP SC1 in place per sc1_rescope=D-01.

## Self-Check: PASSED

- 86d5b81 touches only 06-PROOF.md and carries Refs SPE-3576 and Refs SPE-3970.
- /tmp/06-09-tamper.ts and /tmp/06-09-scratch.json deleted.
- Task 1, 2 and 3 `<automated>` verifies exited 0 (Task 3 includes the two-sided gates).
