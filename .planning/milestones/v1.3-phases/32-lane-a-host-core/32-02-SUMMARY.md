# Phase 32 Plan 02: Restart Survival Summary

---
phase: 32-lane-a-host-core
plan: "02"
subsystem: lane-a-host-core-restart
tags: [restart, resume, heartbeat-or-reclaim, unit-staged, OPERATOR-GATED]
requires: [32-01-lease-lifecycle]
provides: [resume-lease-check, kill-restart-proof, staged-unit-restart]
affects: [phase-33-lanea0406]
tech-stack:
  added: []
  patterns: [shared-heartbeat-helper, kill-restart-rehearsal, staged-not-installed]
key-files:
  created:
    - scripts/host-restart.test.ts
  modified:
    - packages/host/src/tasks.ts
    - packages/host/src/tasks.test.ts
    - infra/vps/substrate-host.service
    - docs/runbooks/lane-a-host.md
decisions:
  - "Resume reuses the 32-01 heartbeatOrReclaim helper, not a duplicate"
  - "Resume lease failure releases too (fail closed); no prompt, no resume bump, loop continues"
  - "Missing lease at resume re-claims to recover the id (same session renews per server docs)"
  - "No unit behavior change: StateDirectory + SIGTERM grace already correct; comments only"
metrics:
  duration: "~90 min"
  completed: "2026-10-11"
  tasks: 3
  commits: 3
  plan_head_before: 05746c3
status: complete
---

## One-liner

Kill-and-restart over on-disk stores yields exactly one resume-keyed continuation per interrupted task with heartbeat-or-reclaim first; double boot replays nothing; the unit restart is staged and gated.

## What was built

- **Heartbeat-or-reclaim in resume (Task 1):** `resumeInterrupted` re-establishes the route, then runs the shared `heartbeatOrReclaim` before each continuation. Refused re-claim marks that task failed solo (`lease lost`, exit 1, single release, resumes unbumped) and continues the loop. Four new tests: live lease (no-op, no calls), lapsed lease (one re-claim, route→heartbeat→prompt order), refused re-claim (mixed two-task: one fails alone, the other resumes), plus the `reclaimRefusedFor` fake seam.
- **Kill-and-restart rehearsal (Task 2):** `scripts/host-restart.test.ts` — open over temp-dir `TaskStore` + sibling `LeaseStore`, record an approval, `beginShutdown` + reject the unsettlable first prompt (record stays in flight, tick disarmed), reboot over the same dirs → exactly one `resume:1` continuation with route→heartbeat→prompt order, stale approval counted off, lease file still 0600. Continuation settles; third boot sends zero prompts. Second test: route failure fails one task while the other resumes.
- **Staged unit restart (Task 3):** comment-only unit changes (tasks/leases layout under `StateDirectory`, SIGTERM→`beginShutdown` grace via `TimeoutStopSec=15`); doctor gate 18/18. Runbook L2 gains post-restart verification lines; the restart is OPERATOR-GATED and never run.

## Deviations from Plan

None — plan executed exactly as written.

## Verification (all exercised)

- `bun test scripts/host-restart.test.ts` — 2/2 green.
- `bun test packages/host/src/tasks.test.ts` — 54/54 (50 + 4 new).
- `bun test scripts/doctor-units.test.ts` — 18/18 green.
- `bunx tsc --noEmit` — clean.

## Commits

- 1e6d717: feat(32-02): heartbeat-or-reclaim in the resume path
- 1972bb2: feat(32-02): kill-and-restart rehearsal over on-disk stores
- 8439839: docs(32-02): stage unit restart semantics, gate the live restart

## Self-Check: PASSED

## Known Stubs

None.

## Threat Flags

None — T-32-02a/b/c mitigations are the resume counter keying + third-boot test, the per-task solo-failure loop, and 0600 on every lease write including re-claims.
