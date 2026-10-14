# Phase 32 Plan 01: Lease Lifecycle Wiring Summary

---
phase: 32-lane-a-host-core
plan: "01"
subsystem: lane-a-host-core-lease
tags: [lease, heartbeat, claimAndPersist, release-once, graphComplete]
requires: []
provides: [lease-lifecycle-wiring, heartbeat-tick, single-release, fenced-completion]
affects: [32-02-resume, 32-03-rehearsal]
tech-stack:
  added: []
  patterns: [persist-then-verify, heartbeat-or-reclaim, release-once-flag, presence-only-logging]
key-files:
  created: []
  modified:
    - packages/host/src/tasks.ts
    - packages/host/src/substrate.ts
    - packages/host/src/vm.ts
    - packages/host/src/main.ts
    - packages/host/src/tasks.test.ts
    - packages/host/src/sync.test.ts
    - scripts/host-smoke.ts
decisions:
  - "Settle releases the claim (success included): complete must precede the settle, matching the prompt's designed order"
  - "Heartbeat transport errors treated as refusals (one re-claim, then fail-closed), not skipped"
  - "Failed-open release kept verbatim per D32-03 (no record exists pre-save; the released-flag guard is vacuous there)"
  - "terminate releases immediately; the later settle finds the flag and re-releases nothing"
metrics:
  duration: "~90 min"
  completed: "2026-10-11"
  tasks: 3
  commits: 1
  plan_head_before: f4498a7
status: complete
---

## One-liner

`openTask` claims with `lease_id` persistence, heartbeats while turns run with one re-claim on refusal, and every terminal path releases exactly once — all against fakes, no live system touched.

## What was built

- **Claim through `claimAndPersist` (Task 1):** `openTask` switched from bare `graphClaim` to `claimAndPersist` against a `LeaseStoreLike` dep rooted in a sibling dir of the `TaskStore` dir (`main.ts`: `<storage>/tasks` + `<storage>/leases` — a follow-up fix moved leases out of the tasks dir because `TaskStore.list()` reads every `*.json` it finds and a `*.lease.json` file would parse as a garbage record). Persist-then-verify: a grant without a readable lease file releases once and answers 502. Logs report presence only (`lease persisted …: yes`), never the value. The 409 refusal and foreign-claim paths are untouched.
- **Heartbeat tick (Task 2):** `startPrompt` arms a half-TTL (`HEARTBEAT_INTERVAL_MS`) tick, cleared on every settle path plus `kill`, `terminate`, and `beginShutdown` (unref'd, so tests and the smoke runner exit cleanly). One tick = `heartbeatOrReclaim`: skip when not due, `heartbeat` fenced on the persisted id when due, exactly one re-claim on refusal (or on a missing lease file), fail-closed (failed turn + single release) when the re-claim refuses. Tests drive `heartbeatTick()` directly — no wall-clock sleeps.
- **Single release + completion (Task 3):** `releaseOnce()` guarded by the record's `released` flag funnels settle (resolve and non-shutdown reject), failure, `kill`, `terminate`, and lease-loss. New `TaskService.complete()` validates a real DoD (summary non-empty, capped at `DOD_SUMMARY_MAX` 2000, `tests_pass`, optional `review_pass`) and calls `graphComplete` with the persisted `lease_id`; the server drops the lease, so the record is marked released with no second release. `SubstrateClient.graphComplete` now sends `{graph_id, node_id, lease_id, dod}` (dead surface/session args removed); the guest `complete` host-fn in `vm.ts` loads the lease from the new `HostVmConfig.leases` dep.

## Deviations from Plan

None — plan executed exactly as written, with the two judgment calls documented under Decisions (both sourced from locked decisions D32-02/D32-03).

## Verification (all exercised)

- `bun test packages/host/` — 203 pass, 0 fail (+14 new).
- `bun run smoke:host` — 23/23 green.
- `bunx tsc --noEmit` — clean.

## Commits

- b3d10b0: feat(32-01): wire LANEA-02 lease lifecycle — claimAndPersist, heartbeat tick, single release + completion

## Self-Check: PASSED

- All modified files exist; commit b3d10b0 verified in log.

## Known Stubs

None.

## Threat Flags

None — no new surface beyond the plan's threat model (T-32-01a/b/c mitigations are the tick ownership, presence-only logging + high-entropy scan test, and the exactly-one-re-claim rule).
