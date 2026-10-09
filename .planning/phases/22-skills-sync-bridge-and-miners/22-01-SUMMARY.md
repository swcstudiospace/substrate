# 22-01 SUMMARY — Base gate verdict: NOT-READY (Phase 20 absent from base)

## Verdict

**NOT-READY. Execution stops here per the plan's STOP condition. No source file was modified; no wave-1..5 work was started.**

The base (`origin/main` at `ac0de03`, plus this branch's two docs-only commits
`f221b56`/`419eae7`) does **not** hold Phases 19, 20 and 21. It holds 19 and 21
but **Phase 20 was never planned, implemented, or merged**: there is no
`.planning/phases/20-*` directory, no phase-20 commit on `origin/main`
(merged PRs are #26 phase 18, #29 phase 27, #28 phase 21, #30 phase 19),
and neither of the two Phase-20 touchpoints exists anywhere in the tree.

## Touchpoint evidence (Task 1)

| # | Touchpoint | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `packages/cli/src/token.ts` exporting `resolveBearer` (Phase 20) | **MISSING** | `packages/cli/src/` holds only `args.ts, index.ts, lessons.ts, lessons.test.ts, skills.ts, skills.test.ts`; repo-wide grep for `resolveBearer` matches nothing outside the 22-PLAN/CONTEXT docs themselves |
| 2 | `infra/identity/clients.json` (Phase 20 manifest) | **MISSING** | `infra/` holds only `vps/`; no `infra/identity/` directory |
| 3 | `packages/mcp-server/src/skills/propose.ts` exporting `SKILL_NAME_RE` (Phase 21) | PRESENT | `export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;` at `propose.ts:51` |
| 4 | `packages/collectors/src/cursor-stop.ts` (Phase 19 hook) | PRESENT | file exists |
| 5 | `docs/skills-propose.md` (Phase 21 doc) | PRESENT | file exists |
| 6 | `scripts/rehearsal.ts` accepting `--skills-fixture` (Phase 21) | PRESENT | `--skills-fixture` in bare-flags map (`rehearsal.ts:1523`), parsed at `:1571`, typed `skillsFixture` at `:590` |

The base's live identity model is per-surface `SUBSTRATE_TOKEN_*` env vars
(`packages/mcp-server/src/config.ts`: `tokenEnvName`, `SUBSTRATE_TOKEN_SUBSTRATE`)
plus a rehearsal tokens dir — there is no `resolveBearer("substrate", env)`
resolver for D22-04/D22-09/D22-15 to call, and no `clients.json` rows for
D22-22 to move dormant-to-live. Inventing a Phase-20 substitute would violate
the plan's STOP condition, so nothing was invented.

## D22-28 baseline (recorded, not fixed)

- `bun test` (full): **1604 pass, 49 skip, 11 fail, 11 errors** across 77 files
  (exit 1). All 11 fail + 11 errors share one root cause: `Cannot find module
  '@substrate/ledger'` from `packages/mcp-server/src/{service,service.test,
  graph-bind.test,brief.test,gretime,server.test,authority.test,...}`
  (unbuilt workspace package; pre-existing, unrelated to phase 22).
- `bunx tsc --noEmit`: **exit 2, 3 errors**, all the same `@substrate/ledger`
  module resolution failure (`greptime.ts`, `service.ts`, `service.test.ts`).
- `bun run check:phase-close`: **exit 0, pass** — 112 pass / 0 fail; 4 lock
  files green; EVENT_KINDS unchanged at 12; SURFACES baseline plus substrate at 27.
- `python3 -m pytest packages/miner`: **not collectable — `packages/miner`
  does not exist yet** (expected pre-port). System python3 is 3.12.3 with
  httpx 0.28.1 and pytest 9.1.1, matching the CONTEXT host facts.
- September ref `acc30a8` is present (`git cat-file -t` → `commit`), so the
  `git show acc30a8:...` read-only sources the later waves need are available.
- `git diff origin/main -- packages/projector/package.json`: untouched (no
  September manifest merge; nothing modified at all — clean tree apart from
  this SUMMARY file).

## What this blocks

Waves 2–5 (plans 22-02…22-05) all build on 22-01 artifacts and on Phase-20
symbols: `resolveBearer` (D22-04 sync bearer, D22-09 bridge per-surface tokens
mirroring "Phase 20's order", D22-15 Omp copied resolver), `clients.json`
(D22-22 identity rows), `scripts/identity-check.ts`. Plan 22-06 is human-only
by design. None can start until Phase 20 lands on main and this gate re-runs
green.

## Branch state

Branch `gsd/v1.3-p22-skills-sync` was reset to `origin/main` (`ac0de03`) with
only the two phase-22 docs commits replayed (`f221b56`, `419eae7`) and
force-pushed with `--force-with-lease` (rebase-equivalent: already-merged
phase-18 hunks dropped, phase logic kept). No PR opened: there is no
implementation to review, only plan docs plus this blocked verdict.
