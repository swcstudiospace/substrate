---
phase: 30-desktop-run
plan: "05"
subsystem: api
tags: [desktop-run, rehearsal-harness, cli-flag, bun-test]

# Dependency graph
requires:
  - phase: 30-desktop-run
    provides: desktopSurfaces allowlist and desktopDir config (plan 30-02)
provides:
  - BuildRehearsalEnvInput.desktopSurfaces with subset guard and desktop env keys
  - rehearsal up --desktop-surfaces flag with parsing and TwinState plumbing
affects: [30-07-proof, rehearsal up --desktop-surfaces runs]

# Actuals (#2632)
actuals:
  tokens: 14000
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [flag parser mirroring parseOperator, env keys beside SUBSTRATE_AUDIT_PATH]

key-files:
  modified:
    - packages/mcp-server/src/rehearsal-env.ts
    - packages/mcp-server/src/rehearsal-env.test.ts
    - scripts/rehearsal.ts
    - scripts/rehearsal.test.ts

key-decisions:
  - "assertDesktopSurfacesAllowed mirrors assertOperatorAllowed but without the swarm exclusion: swarm surfaces may drive the desktop when listed (D30-01)"
  - "SUBSTRATE_DESKTOP_DIR always written (runDir join, never operator-settable); SUBSTRATE_DESKTOP_SURFACES only when non-empty so the fail-closed default survives the harness"
  - "No known-surface check in the builder: any name outside --surfaces throws, and unknown names can never be inside validated surfaces"

patterns-established:
  - "Twin key-set tests: exact-set expectation plus a non-empty twin covering the conditional key"
  - "Parent-env leak test extended with the new key to prove the builder never forwards it"

requirements-completed: [DESK-05]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Desktop subset guard refuses with surfaces named; env keys exact; zero warnings for valid and empty allowlists (DESK-05)"
    requirement: "DESK-05"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/rehearsal-env.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flag parses valid subsets and refuses outside-subset, unknown and anonymous cases; up plumbing and usage documented (DESK-05)"
    requirement: "DESK-05"
    verification:
      - kind: unit
        ref: "scripts/rehearsal.test.ts#parseDesktopSurfaces"
        status: pass
    human_judgment: false

# Metrics
duration: 1h05min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 05: Rehearsal harness desktop flag Summary

**`rehearsal up` accepts `--desktop-surfaces a,b` as a validated subset of `--surfaces` and writes both desktop env keys per run — 19 env tests and 78 CLI tests green, tsc clean, phase-close green.**

## Performance

- **Duration:** ~1h05 min
- **Started:** 2026-10-09T16:00Z
- **Completed:** 2026-10-09T17:05Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Task 1: `BuildRehearsalEnvInput.desktopSurfaces` (`readonly Surface[]`, subset-of-surfaces contract), exported `assertDesktopSurfacesAllowed` (throws `RehearsalEnvError` naming the surface only), `buildRehearsalEnv` always sets `SUBSTRATE_DESKTOP_DIR=<runDir>/desktop` beside `SUBSTRATE_AUDIT_PATH` and sets `SUBSTRATE_DESKTOP_SURFACES` only when non-empty, never reading the allowlist from the parent env. Tests: `SUBSTRATE_DESKTOP_DIR` in the exact key set plus a non-empty twin, zero `desktopConfigWarnings` beside the existing zero `configWarnings` pins (valid, empty and anonymous), round trip into `desktopSurfaces` and the runDir join, desktop-dir-in-run-dir case, and subset refusal cases.
- Task 2: `parseDesktopSurfaces` copying `parseOperator` (known-surface and in-`--surfaces` membership, refused with `--anonymous`), plumbed through `UpOptions`/`TwinState` into the `buildRehearsalEnv` call inside the existing try-catch, `--desktop-surfaces` in the `refuseExtraArgs` valued map and the main null-value loop, usage text lists `[--desktop-surfaces a,b]`. Tests: `parseDesktopSurfaces` describe mirroring `parseOperator` (5 tests) plus the `refuseExtraArgs` acceptance case.
- Verification: `rehearsal-env.test.ts` 19 pass, `rehearsal.test.ts` 78 pass, `bunx tsc --noEmit` clean, `bun run check:phase-close` pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add desktopSurfaces to rehearsal-env with the subset guard** - `eaceb6e` (feat)
2. **Task 2: Add --desktop-surfaces to rehearsal up with parsing and plumbing** - `287e736` (feat)

**Plan metadata:** `docs(30-05)` commit below (this SUMMARY)

## Files Created/Modified

- `packages/mcp-server/src/rehearsal-env.ts` - `desktopSurfaces` input, `assertDesktopSurfacesAllowed`, desktop env keys
- `packages/mcp-server/src/rehearsal-env.test.ts` - key-set twins, zero-warning pins, round-trip and refusal cases
- `scripts/rehearsal.ts` - `parseDesktopSurfaces`, options/state plumbing, flag and usage
- `scripts/rehearsal.test.ts` - parser describe, extra-args case, `Surface` type import

## Decisions Made

- No swarm exclusion in the desktop guard: unlike operators, a listed swarm surface is a legitimate desktop caller per D30-01.
- Empty `--desktop-surfaces ""` parses to `[]` (nobody) rather than refusing: the flag default is already empty, so an explicit empty value is consistent, not a typo.
- Builder does not duplicate the known-surface check: `assertKnownSurfaces(input.surfaces)` plus the subset rule already rejects every unknown desktop name.
- Twin key-set test omits `BUN_INSTALL` from its expected set because its parentEnv carries no `BUN_` keys (mirrors the first test's exactness rather than sharing one set).

## Deviations from Plan

None - plan executed exactly as written. (Two self-inflicted edit mistakes — a mangled twin-test body and a dropped `] as const) {` closer — were corrected before commit; final committed content matches the plan.)

## Issues Encountered

- `scripts/rehearsal.test.ts` lacked a `Surface` type import (the `as Surface` precedent lived in the env test file); added `import type { Surface } from "../packages/mcp-server/src/types.ts"`, tsc clean.
- Edit-tool anchor drift from the +33-line parser insert required re-reading interface sites before patching; no content lost.

## Self-Check: PASSED

- All four files exist, committed as `eaceb6e` and `287e736`; no deletions; no stubs; no new dependencies.
- Repo locks respected: error messages name surfaces only, never tokens; no `SUBSTRATE_TOKEN*=16+` literals; phase-close confirms EVENT_KINDS 12 / SURFACES 27.
- Flag refuses `--anonymous` pairing before any parsing, and the builder re-guards the subset inside the existing `RehearsalEnvError`→`RehearsalRefused` conversion.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 30-07 can run `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp`; the twin's server env carries the allowlist and its run dir carries the desktop dir.
- `SUBSTRATE_DESKTOP_DIR` is always the runDir join and dies with the run dir at `rehearsal down` — the smoke's screenshots need no separate cleanup.

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
