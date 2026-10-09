# Phase 22 Plan 05: Isolated skills-plane smoke — Summary

**One-liner:** Isolated whole-plane proof — three staged queues become three fixture PRs, fresh records are kept, and an owner merge projects into scratch roots, all behind the harness guards.

**Status:** complete

## What was built

- `scripts/skills-plane-smoke.ts` (`smoke:skills-plane` in `package.json`): drives the bridge's
  `run_once`/`drain_queue` (the same two functions the `bridge --once` CLI calls) through a
  driver written to scratch at run time, with every path pointed at throwaway dirs, then drives
  `runSync`/`project` in-process through their context seams. Guards: `refuseSmokeUrl` before any
  request, plus a `preflight` that also requires the skills-fixture keys and the four surface
  tokens (`hermes`, `omp`, `grok-build`, `substrate`).
- `scripts/skills-plane-smoke.test.ts`: pins `preflight` refusals (production port, non-loopback
  host, missing fixture, missing token), the dry-run line parser, and a source scan that fails if
  the script ever names a live path or the production port.
- `scripts/rehearsal.ts`: unchanged — the tokens-dir seam (`SUBSTRATE_REHEARSAL_TOKENS_DIR` in
  `consumer.env`) already exists, so no seam was needed.

## Smoke evidence (green run, 26/26 checks)

Twin: `rehearsal up --name p22 --skills-fixture --surfaces hermes,omp,grok-build,substrate`
(port 17422; 17410 was held by a sibling twin).

- **Step (a):** three aged (>120 s) records staged; `dry-run` answered `dry_run` × 3
  (`hermes:new`, `omp:queued`, `grok-build:queued`) with zero deletes, moves, holds, branches or
  gh calls; the live tick proposed 3/3 and removed all three records.
- **Three fixture PR branches:**
  - `skill/hermes/plane-hermes-d67db6-20261009T234820143Z-f276`
  - `skill/omp/plane-omp-d67db6-20261009T234820293Z-eaa3`
  - `skill/grok-build/plane-grok-d67db6-20261009T234820472Z-dd3b`
  - Recorded as fixture PRs #4–#6 under `rehearsal/agent-skills` (#1–#3 are the same proof's
    first attempt, whose step (c) caught two real script bugs — see deviations).
- **Step (b) kept-fresh verdict:** `fresh-kept=yes` — a record younger than the quiet window stayed
  (`waiting=1 queue_kept=1`), the quiet tick proposed nothing and touched no branch.
- **Step (c):** scratch library cloned, first tick `current`; fixture `main` fast-forwarded to the
  hermes branch via `update-ref`; second tick `ff`, exit 0, silent (no warnings).
- **Projected scratch links** (all read back byte-identical to the merged skill):
  - `.claude/skills/plane-hermes-d67db6`
  - `.grok/skills/plane-hermes-d67db6`
  - `.agents/skills/plane-hermes-d67db6`
  - `.config/muse/skills/plane-hermes-d67db6`
- **Event read-back:** 6 proposal events, 6 `opened` notes, 0 `skills.sync` warnings.

## Verification

- `bun test scripts/skills-plane-smoke.test.ts`: 10/10 pass.
- `bunx tsc --noEmit`: clean.
- `bun run smoke:skills-plane`: 26/26 checks pass.
- D22-28 baseline: 22-01 recorded no baseline counts (its ticket forbade running them), so there
  is nothing to compare against; no pre-existing failure was touched. The full suite
  (`check:phase-close`, `test:py`) was intentionally not run — this run's ticket limits execution
  to the plan's own smoke and guard tests.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Scratch roots must pre-exist for the projector to link into them**
- **Found during:** Task 2, first smoke run (step (c): sync `current`, 2 actions, no links).
- **Issue:** `plan()` skips roots that do not exist unless the root sets `create` (only `muse`
  does). The scratch home started empty, so only the `muse` root was projected.
- **Fix:** the smoke pre-creates the `claude`, `grok` and `agents` skill dirs in the scratch home,
  mirroring a real host where the agent homes exist.
- **Files modified:** `scripts/skills-plane-smoke.ts`.

**2. [Rule 1 — Bug] A fresh clone can never observe the fast-forward**
- **Found during:** Task 2, first smoke run (sync reported `current`, not `ff`).
- **Issue:** the smoke cloned the fixture after the owner merge, so the clone was already current.
- **Fix:** step (c) now clones first (tick reports `current`), then fast-forwards the fixture's
  `main` via `update-ref` (the owner's merge), then re-runs the tick and asserts `ff`.
- **Files modified:** `scripts/skills-plane-smoke.ts`.

No rehearsal.ts seam was needed; no production path, host, or port is named outside a refused
guard test. No auth gates, no stubs, no new event sources.
