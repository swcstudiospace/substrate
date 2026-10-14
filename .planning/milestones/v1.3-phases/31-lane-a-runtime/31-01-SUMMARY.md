# Phase 31 Plan 01: Gated spike runner Summary

---
phase: 31-lane-a-runtime
plan: "01"
subsystem: lane-a-spike
tags: [spike, rehearsal-first, operator-gated, host]
requires: []
provides: [host-spike-runner, step-0-asserts, spike-verdict-tables]
affects: [31-02-packaging, 31-03-wiring]
tech-stack:
  added: []
  patterns: [gated-runner-exit-3, read-only-step-0, injected-deps-tests]
key-files:
  created:
    - scripts/host-spike.ts
    - scripts/host-spike.test.ts
    - .planning/phases/31-lane-a-runtime/31-SPIKE.md
  modified: []
decisions:
  - "6420 state is a recorded fact with drift-fail, not a guess: refused means G2 fallback, never agent bypass"
  - "Loopback guard uses a Record table per repo lint rules"
metrics:
  duration: "~25 min"
  completed: "2026-10-10"
  tasks: 3
  tests_added: 16
status: complete
---

One-liner: gated spike runner with read-only step-0 asserts, G1/G2/G3 banners exiting 3, and verdict tables defaulting to UNVERIFIED.

## Tasks completed

1. Read-only host asserts plus spike-runner skeleton — `scripts/host-spike.ts` (step 0, guards, G1/G2/G3 descriptors, cleanup contract, `--check`), `scripts/host-spike.test.ts` (16 tests, injected fakes).
2. G1/G2/G3 runbooks with exact commands and record schema — exact operator commands plus the 31-SPIKE.md record schema each run fills; preconditions re-checked per step.
3. Spike cleanup contract plus phase-close — cleanup command list (dispose, unload, rm scratch, re-verify engine + 7411 free); `--check` is the CI-safe entry.

## Verification (all exercised)

- `bun test scripts/host-spike.test.ts`: 16 pass / 0 fail.
- `bunx tsc --noEmit`: clean.
- `bun scripts/host-spike.ts --check`: exit 0, all seven facts match the RESEARCH baseline (6420 served, 7411 free, 128308633600 avail, image absent, store 332755597 bytes).
- `bun scripts/host-spike.ts` (no flag): prints the G1 OPERATOR-GATED banner and exits 3 — the designed stop.
- `bun run check:phase-close`: pass (4 lock files green, EVENT_KINDS 12, SURFACES 27).

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. G1/G2/G3 verdicts are UNRECORDED by design (operator-gated tail), not stubs.

## Operator-gated markers

- G1 npm ci ~2.2 GB in a scratch copy (precondition: step-0 clean, 10 GiB floor).
- G2 engine session on the shared 6420 engine, fallback second loopback engine (precondition: G1 green).
- G3 VM boot proving no-KVM (precondition: G2 green; failure is a gap, never a pass).

## Self-Check: PASSED
