# Phase 24 Plan 05: Resident loop and isolated dry-run — Summary

**Date:** 2026-10-09. **Requirements:** DISP-01, DISP-08. **Status:** complete.

## One-liner

The dispatcher process now loops every 30 s under one flock, sleeps while the kill switch is on, and `--once --dry-run` prints classifications without a comment, a label change, git, a spawn, or a socket.

## What was built

**Resident loop** (`packages/dispatcher/src/index.ts`). Default mode takes the process-lifetime flock once, then re-reads `SUBSTRATE_DISPATCH_DISABLED` on every pass. A disabled pass sleeps `DISPATCHER_INTERVAL_MS` (30_000) and does not build deps or tick, so it never comments and never exits. A thrown tick exits 1, which is the only `Restart=on-failure` path. A busy lock still exits 0 and releases.

**`--once`.** One tick, exit 0 on success and 1 when the tick throws. Disabled still returns before the lock, matching the plan 24-04 entry tests.

**`--once --dry-run`.** Classifies an injected in-memory queue with `collectCandidates` and prints `<identifier> not-dispatchable` or `<identifier> dispatch:<surface>`. The recording fakes for comments, label removal, git, spawn, and sockets are constructed and then not called. A bare `--dry-run`, a repeated flag, or any other flag exits 1 with usage. Dry-run does not take the lock and does not read Linear.

## Tests

`packages/dispatcher/src/index.test.ts` covers the mixed queue (canary id absent from stdout, every write counter still zero), the disabled pass that sleeps and re-reads before the next enabled tick, the busy lock, `--once` exit codes, and usage failures. The plan 24-04 `runDispatcherOnce` cases stay.

## Deviations from plan

None. `--dry-run` classifies instead of calling `runTick`, because the tick posts markers and that would be a write.

## Threat flags

None beyond the plan's register: T-24-05a (dry-run fakes, zero-write assertion), T-24-05b (sleep while disabled, no exit), T-24-05c (exact flags).

## Not done / left for later

Plan 24-06 is the operator live window. ROADMAP and REQUIREMENTS untouched. No push in this summary's commit until the suite is green.
