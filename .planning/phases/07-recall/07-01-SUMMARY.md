---
phase: 07-recall
plan: 01
subsystem: planning-evidence
tags: [wave-0, baseline, two-sided-gate, rollback, t0-snapshot, inventory, d-01, d-04, d-10, d-11, t-07-01-01, t-07-01-02, t-07-01-03, t-07-01-04]

requires:
  - phase: 06-ledger
    provides: accepted (06-VERIFICATION.md status gaps_found, owner skip D-17); ingested_at on SubstrateEvent, IngestChain, EVENT_COLUMNS; cutover_ingested_at=2026-09-27T13:02:16.494Z
provides:
  - 07-BASELINE.md — two-sided baseline (bun 634/0/36, tsc clean, dispatcher 149/0), phase-order record, live presence keys
  - 07-01-INVENTORY.md — backfill_expected=10 (8 events + 2 memory), post-cutover ingested_at nulls 0, max summary 98 chars / max body 90 B, shape_hits_14d=0, 11/11 D-04 classes unchanged by today's redact()
  - /var/lib/substrate/phase7-baseline/ (host, 0700 root) — RESTORE.md index, RESTORE.d/07-01.md, t0-20260927T165601Z/{claude.json, claude-settings.json, hermes-config.yaml, hindsight-mcp.json, hindsight-hooks.json, substrate-env.presence, units.sha256, MANIFEST.sha256}
affects: [07-02, 07-03, 07-04, 07-05, 07-06, 07-07, 07-08]

actuals:
  tasks: 2
  commits: 2
plan_head_before: 4fa90f2ff9eabbe4d25ed2a6632f7a77f509ae24

key-files:
  created:
    - .planning/phases/07-recall/07-BASELINE.md
    - .planning/phases/07-recall/07-01-INVENTORY.md
    - /var/lib/substrate/phase7-baseline/RESTORE.md (host, 0600)
    - /var/lib/substrate/phase7-baseline/RESTORE.d/07-01.md (host, 0600)
  modified: []

key-decisions:
  - "phase6-verification=accepted with the orchestrator's note quoted verbatim (06-VERIFICATION.md status: gaps_found)"
  - "Baseline bun figures are the re-run (634/0); the first run's single WR-02 5000 ms timeout was load-induced (load avg ~30 on 8 cores) and did not reproduce in isolation or in the full re-run"
---

# Phase 7 Plan 01: Phase 7 gate, baseline, rollback area and inventory Summary

Phase 7 starts from an accepted Phase 6 with its three contract symbols present and a live cutover
recorded; the two-sided baseline, the t0 agent-config snapshot and the backfill/redaction inventory
are measured and committed. No live change: no restart, env, config or Agentmemory call.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 — phase order, disk, baseline, rollback area, t0 | 11ba60f | .planning/phases/07-recall/07-BASELINE.md (+ host files under /var/lib/substrate/phase7-baseline) |
| 2 — backfill volume, cap sizing, redact() gap | 84b27f6 | .planning/phases/07-recall/07-01-INVENTORY.md |

## Key results

- phase6-verification=accepted (note verbatim), phase6-symbols=present, phase6-cutover-ingested-at=2026-09-27T13:02:16.494Z, phase5-docs-search=absent, substrate-mcp active.
- disk-avail-before=193814814720 (≥ 10 GiB).
- agent-substrate-head=4fa90f2…ae24; bun 634 pass / 0 fail / 36 files; tsc-exit=0; dispatcher 149 passed / 0 failed; no failing ids.
- Live presence: AGENTMEMORY_URL/SECRET lines 0/0, SUBSTRATE_TOKEN_ lines 0; Claude hindsight MCP present with 3 hook groups (= t0 extract length); substrate MCP absent in Claude Code and Hermes; Hermes memory.provider=supermemory; agentmemory-native=absent; hindsight-procs=0; hindsight-data-files=63.
- Inventory: backfill_expected=10; events_post_cutover_ingested_at_null=0; memory_over_cap=0; shape_hits_14d=0; redact_gap_unchanged=11 of 11.

## Verification

- Task 1 `<verify>`: exit 0, including the live re-run branch (code outside .planning equalled
  agent-substrate-head): fresh tsc set, bun failing ids and pass count (634) and dispatcher failing ids
  and pass count (149) matched the baseline exactly.
- Task 2 `<verify>`: exit 0.

## Deviations from Plan

1. **Untracked `packages/miner/uv.lock` at step 3.** `git status --porcelain -- packages infra` printed
   `?? packages/miner/uv.lock` (mode 0600, created 2026-09-27 05:39 by an earlier `uv` run in
   another session; not tracked, not gitignored). The step's intent — tracked code equals HEAD — held
   (`--untracked-files=no` printed nothing), and a Python lockfile in packages/miner feeds none of the
   three measured commands, so measurement proceeded; the file was left untouched (not ours). The
   Task 1 verify's re-run gate uses `git diff --name-only $H`, which ignores untracked files.
2. **Load-induced timeout on the first bun run.** Recorded in 07-BASELINE.md's verbatim section; the
   baseline carries the re-run (634/0), so no flaky id is pinned as a baseline failure.
3. **Probe run twice.** The read-only probe first ran before the Task 1 commit (while the suites ran);
   it was re-run after the commit to honour Task 2's precondition, and the inventory records the second
   run only. Both runs printed identical counts.
4. **STATE.md / ROADMAP.md not updated** — orchestrator constraint for this shared checkout.

## Threat Flags

None: the t0 copies are 0600 under a 0700 root directory and never printed; substrate.env was only
`grep -c`'d; the inventory holds counts and class names only (verify token-shape scan passes).

## Self-Check: PASSED

- FOUND: .planning/phases/07-recall/07-BASELINE.md, .planning/phases/07-recall/07-01-INVENTORY.md
- FOUND: /var/lib/substrate/phase7-baseline/{RESTORE.md, RESTORE.d/07-01.md, t0-20260927T165601Z/MANIFEST.sha256} (verified by Task 1 verify)
- FOUND commits: 11ba60f, 84b27f6
