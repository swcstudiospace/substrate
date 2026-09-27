---
phase: 06-ledger
plan: 01
subsystem: planning-evidence
tags: [wave-0, baseline, two-sided-gate, rollback, fixture, greptime-spike, a3, a4, d-03, d-08, d-09, t-06-01-01, t-06-01-02, t-06-01-03]

requires:
  - phase: 04-skills
    provides: 04-VERIFICATION.md status passed; "skill.propose" in types.ts; `skills propose` in the CLI
  - phase: 05-docs-and-desktop
    provides: desktop half only (docs half owner-skipped, gaps accepted); "docs.ingest" event kind in types.ts
provides:
  - 06-BASELINE.md — measured two-sided baseline (bun 534/0/29, tsc clean, dispatcher 149/0), live Greptime/Solana inventory, 19 baseline-ok-graph lines
  - packages/mcp-server/src/fixtures/pre-cutover-rows.json — 95 rows of the 19 ok graphs, 16 columns, sha256 e73e05f2…d303
  - /var/lib/substrate/phase6-baseline/ (host, 0700 root) — RESTORE.md index, RESTORE.d/06-01.md, 06-01/20260927T063414Z/greptime/{agent_events,anchors}.show-create.txt + MANIFEST.sha256
  - 06-01-SPIKE.md — Greptime 1.1.4 ALTER / last_row / primary-key-less facts for 06-04 and 06-05
affects: [06-02, 06-03, 06-04, 06-05, 06-06, 06-07, 06-08, 06-09]

actuals:
  tasks: 2
  commits: 4         # 84c3d25, 9f2f5eb, 1be1079 + this SUMMARY
plan_head_before: c31f820

tech-stack:
  added: []
  patterns:
    - "Keyed live probes run from /tmp script files under systemd-run with EnvironmentFile, never inline bun -e with `$`"
    - "Scratch-table DDL goes through a guard that refuses any statement not naming the stamped p6_scratch_ table"

key-files:
  created:
    - .planning/phases/06-ledger/06-BASELINE.md
    - .planning/phases/06-ledger/06-01-SPIKE.md
    - packages/mcp-server/src/fixtures/pre-cutover-rows.json
    - /var/lib/substrate/phase6-baseline/RESTORE.md (host, 0600)
    - /var/lib/substrate/phase6-baseline/RESTORE.d/06-01.md (host, 0600)
  modified: []

key-decisions:
  - "phase5-verification=accepted with the orchestrator's owner-skip acceptance quoted verbatim (05-VERIFICATION.md status: gaps_found)"
  - "RESTORE.md names 06-06 as owning no RESTORE.d file (its plan defines none); anchors rows fall under 06-05's anchors-table route"

requirements-completed: []
---

# Phase 6 Plan 01: Baseline, rollback area, pre-cutover fixture and Greptime spike — Summary

Every later Phase 6 gate now has a measured two-sided reference, the 19 existing graphs' historical
hashes are pinned by 95 real rows, the schema Phase 6 alters has a verbatim restore copy, and the
DDL plan for 06-04/06-05 rests on observed Greptime 1.1.4 behaviour.

## Task 1 — baseline, inventory, rollback area, fixture (commits 84c3d25, 9f2f5eb)

- Phase-order gate: phase4-verification=passed; phase5-verification=accepted with
  phase5-accepted-note quoted verbatim; phase45-symbols=present.
- HEAD c31f820; bun 534 pass / 0 fail / 29 files; tsc clean (`tsc-exit=0`); dispatcher 149 passed.
- Greptime: 5619 rows, 95 graph rows, 19 graphs, 5122 prev-null, max ts 2026-09-27T06:32:40.387Z,
  0 future-ts, RTT 196–204 ms (max 204), anchors 0 rows with root a TAG, no ingested_at.
- /verify: 19/19 ok (graph count grew from 18 at planning time; re-measured, not copied).
- Fixture: 95 rows, 19 graphs, 16 keys each, no ingested_at, no redact() change (no exclusions),
  token-shape scan 0.
- Solana: 0 SOLANA_ env lines, 0 ledger timers, solana-cli 4.2.2, config RPC http://127.0.0.1:8899,
  id.json stat `1789532431 235`, no ledger key file. Disk 196306694144 bytes free.

## Task 2 — Greptime scratch spike (commit 1be1079)

STAMP 20260927063830. All acceptance keys observed as required: ALTER ADD COLUMN ok (FIELD,
timestamp(3), old rows NULL); epoch and ISO literals ok; half-open boundary ok; same-key second
write leaves 1 row with the omitted field NULL (row replaced, not merged); 20-row INSERT in 200 ms;
a type-rejected 5-row INSERT landed none (atomic=yes); DROP COLUMN ok; old root TAG detectable and
kept by CREATE IF NOT EXISTS; primary-key-less 11-column anchors created and dedups on period_start;
scratch dropped; agent_events byte-identical to the snapshot.

## Verification

Both plan `<automated>` verifies printed nothing and exited 0 (Task 1 re-run after the last commit).
Live: no p6_scratch_ table, agent_events has no ingested_at; substrate-mcp active since
2026-09-26 19:31:28 UTC (not restarted); no env edit; no DDL on agent_events or anchors.

## Deviations from Plan

1. [Rule 1 - Bug] The first 06-BASELINE.md quoted the 06-PATTERNS token-shape regex in its Commands
   block; its `github_pat_` literal matched the verify's own token scan (count 1). Replaced with a
   reference by name; commit 9f2f5eb.
2. [Precondition] `git status --porcelain -- packages infra` was not empty: an untracked
   `packages/miner/uv.lock` (created 2026-09-27 05:39 UTC, before this plan, not Phase 6's) was
   present. It affects none of the measured suites; left untouched, not staged.
3. RESTORE.md's owner list says 06-06 has no RESTORE.d file of its own (06-06-PLAN.md defines none);
   its anchors rows fall under 06-05's anchors-table route.

## Gaps

- Multi-row INSERT atomicity was observed only for a type-check rejection, not for a failure after
  writing starts (recorded in 06-01-SPIKE.md § Gaps).
