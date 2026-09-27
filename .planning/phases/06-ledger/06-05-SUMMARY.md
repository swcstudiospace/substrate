---
phase: 06-ledger
plan: 05
subsystem: ingest-chain
tags: [wave-3, live-cutover, global-ingest-chain, ingested-at, greptime-ddl, restart, d-01, d-02, d-03, d-08, d-09, d-17, t-06-05-01, t-06-05-02, t-06-05-03, t-06-05-04, t-06-05-05]

requires:
  - phase: 06-ledger
    provides: 06-BASELINE.md (19 baseline-ok graphs, phase6-baseline-snapshot with the verbatim SHOW CREATE of agent_events and anchors) and 06-01-SPIKE.md (alter_add_column=ok, multirow_insert_atomic=yes)
  - phase: 06-ledger
    provides: 06-04 global ingest chain code (guarded migrate(), columns(), IngestChain, seedChain, verifyGraph pre/post split) — commits 515d664, 197a55c, 83506fe
provides:
  - live agent_events.ingested_at (FIELD timestamp(3)); live period-keyed anchors (11 columns, 0 TAG, time index period_start, 0 rows — stays empty, D-17)
  - substrate-mcp running c2bafeb (06-04 code) on the global ingest chain since 2026-09-27T13:01:42Z
  - /var/lib/substrate/phase6-baseline/RESTORE.d/06-05.md (code revert, DROP COLUMN, anchors snapshot CREATE)
  - .planning/phases/06-ledger/06-05-CUTOVER.md — cutover_event_id, smoke_graph_id, smoke_hour for 06-07 and 06-09
affects: [06-07, 06-09]

actuals:
  tasks: 2
  commits: 2         # b99c300 (CUTOVER.md) + this SUMMARY
plan_head_before: c2bafeb

key-decisions:
  - "No early cutover: both SHOW CREATE outputs equalled the 06-01 snapshot byte for byte and substrate-mcp had been up since 2026-09-26 19:31:28 UTC (before every 06-04 commit), so the DDL ran through migrate() under the old code"
  - "RESTORE route (1) reverts only the three 06-04 code commits (83506fe 197a55c 515d664); c2bafeb is docs-only"
  - "Throwaway scripts run under the keyed one-shot import the repo modules by absolute path: bun resolves relative imports against the script file in /tmp, not WorkingDirectory"
  - "The cutover event is the first smoke burst event: no other producer emitted between the restart and the smoke"

duration: 21min
completed: 2026-09-27
status: complete
---

# Phase 6 Plan 05: Live cutover onto the global ingest chain — Summary

**The guarded DDL ran live under the old code, substrate-mcp restarted onto the 06-04 global ingest
chain (`[substrate] chain head genesis`, no degraded line), the genesis event
evt_5d1b8c404ad948908a5a7d5c2a748696 is on record, and on production the chain is intact (29 rows,
1 null prev, 0 breaks), hooks stay inside the 1500 ms budget (800 / 903 ms), the client-ts guard
replays and nudges by 1 ms, and all 19 baseline graphs plus the smoke graph verify ok.**

## Performance

- **Started:** 2026-09-27T12:43Z
- **DDL:** 2026-09-27T12:46:12Z
- **Restart:** 2026-09-27T13:01:42Z (waited for minute 01 per the Task 2 precondition)
- **Completed:** 2026-09-27T13:05Z
- **Tasks:** 2/2

## Task 1 — guarded DDL under the old code (D-08, D-09)

Preconditions: 06-04 commits present; `greptime.test.ts` + `chain.test.ts` 29 pass / 0 fail;
06-01-SPIKE alter_add_column=ok, multirow_insert_atomic=yes; substrate-mcp active.

| Key | Value |
|---|---|
| deployed_commit_before | b0390d89a0c00e76274da0bfc6c4641e02a53c7f |
| service_active_since_before | Sat 2026-09-26 19:31:28 UTC |
| unit_sha256 | ccbe64e5…1af3 (unit not edited) |
| schema_matches_snapshot / early_cutover | true / false |
| restore_route_written | true (RESTORE.d/06-05.md, 0600, before the DDL) |
| ddl_run | ok |
| ingested_at_column | FIELD:timestamp(3) |
| anchors | 0 TAG, 11 columns, time index period_start, 0 rows |

substrate-mcp stayed active and unrestarted through the DDL. Plan verify 1: exit 0.

## Task 2 — restart, cutover record, live smoke (D-01, D-02, D-03; requirements 3, 4)

| Key | Value |
|---|---|
| restarted_at / healthz_after | 2026-09-27T13:01:42Z / 200 (5th poll) |
| journal_chain_head_line / journal_degraded_greptime | genesis / 0 |
| deployed_commit | c2bafeb8e614a7b5515b28cca3cb356c05210564 (contains 515d664, 197a55c, 83506fe) |
| cutover_event_id | evt_5d1b8c404ad948908a5a7d5c2a748696 |
| cutover_hash | ae2db71f…d4567 |
| cutover_ingested_at / cutover_prev / cutover_surface | 2026-09-27T13:02:16.494Z / null / claude-code |
| historical_rows_at_cutover | 6043 (baseline 5619; lower bound holds) |
| smoke_graph_id / smoke_hour | ut-ledger-smoke-20260927T130216Z / 2026-09-27T13:00:00.000Z (= cutover hour) |
| burst_http_202 / emit_latency_max_ms / burst7_latency_max_ms | 20/20 / 800 / 903 |
| replay_same_id / replay_key_rows / collision_nudged_ms | true / 1 / 1 |
| post_cutover_rows / prev_null / hash_null / chain_breaks | 29 / 1 / 0 / 0 |
| ingested_at_strictly_increasing / smoke_ts_equals_ingested_at | true / true (24 server-timed rows) |
| pre_cutover_graphs_verified / smoke_graph_verify_ok | 19/19 / true |

Smoke graph /verify: `{"ok":true,"events":29,"chain":{"pre":{"ok":true,"events":0},"post":{"ok":true,"events":29}},"hours":[{"period_start":"2026-09-27T13:00:00.000Z","hour_events":29,"graph_events":29,"chain":"ok"}]}`.
The 19 baseline graphs also answered ok immediately before the restart (19/19), so the gate is
two-sided: nothing that verified before stopped verifying.

## Gates

| Gate | Result |
|---|---|
| Task 1 `<automated>` (verbatim from the plan) | exit 0 (after Task 1, and again after the commit) |
| Task 2 `<automated>` (verbatim, after commit b99c300) | exit 0 — incl. live read post_prev_null=1, cutover row prev null, 19/19 baseline graphs ok, smoke graph ok, no token shape, Refs SPE-3576 |

## Deviations from Plan

None - plan executed exactly as written. Throwaway scripts import repo modules by absolute path (see
key-decisions); every one was deleted after use.

## Issues Encountered

- The first guard run failed with `Cannot find module './packages/mcp-server/src/config.ts'` (bun
  resolves relative imports against /tmp); nothing had been read or written. Re-run with absolute
  imports succeeded.
- The Task 1 DDL finished at minute 46, so Task 2 waited ~15 min for the 01–45 window.

## Anchoring skipped (D-17)

The period-keyed anchors table exists live at 0 rows and nothing writes it; the smoke hour is
protected by the global chain only. RESTORE.d/06-05.md route (2) (DROP COLUMN) is closed now that
rows carry ingested_at; route (1) would leave post-cutover rows verifying only in their own terms.

## Known Stubs

None.

## Threat Flags

None beyond the register: T-06-05-01 (SHOW CREATE guard vs snapshot), T-06-05-02 (migrate guards;
RESTORE routes gated on count 0), T-06-05-03 (restart after verified DDL; healthz + journal within
30 s), T-06-05-04 (genesis recorded; exactly one null prev live), T-06-05-05 (throwaway smoke graph).

## User Setup Required

None. Next: 06-07 reads smoke_graph_id / smoke_hour from 06-05-CUTOVER.md.

## Self-Check: PASSED

06-05-CUTOVER.md committed at b99c300 with Refs SPE-3576 and Refs SPE-3970; RESTORE.d/06-05.md
exists; substrate-mcp active, /healthz 200; both plan verifies exit 0; no token shape in this file.
