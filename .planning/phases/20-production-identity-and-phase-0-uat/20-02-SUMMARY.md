---
phase: 20-production-identity-and-phase-0-uat
plan: "02"
subsystem: auth
tags: [bearer-resolver, per-surface-tokens, parity-check, bun-test]

# Dependency graph
requires:
  - phase: 19-lane-b-collectors
    provides: "emit.ts postEvent contract with url/token options and call-time env"
  - phase: 16-production-parity-and-rehearsal-harness
    provides: "parity-check.ts probe plus 401 verdict, rehearsal guard imports"
provides:
  - "Client-side bearer resolver (`resolveBearer` + `firstLine`) shared by CLI, collectors, parity probe and UAT runner"
  - "Surface-threaded CLI bearer (`headers(surface)`, `post(path, body, surface)`)"
  - "Event-surface default token in emit.ts (herdr per-event tokens, D20-05)"
  - "Resolver-backed parity probe with auth-on-token-missing 401 verdict (D20-08)"
affects: [20-03-identity-check, 20-04-uat-phase0, production-identity-runbook]

# Actuals — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 6500
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [injectable-reader-bearer-resolver, spawn-CLI-against-recording-stub, explicit-token-or-resolver-default]

key-files:
  created: [packages/cli/src/token.ts, packages/cli/src/token.test.ts, packages/cli/src/cli-auth.test.ts]
  modified: [packages/cli/src/index.ts, packages/collectors/src/emit.ts, packages/collectors/src/emit.test.ts, scripts/parity-check.ts, scripts/parity-check.test.ts]

key-decisions:
  - "Resolver order env value, token-file variable, tokens-dir per-surface file; fail-open null, never logged"
  - "Surface validated against lower-alnum-dash before any path join; reads capped at 4 KiB"
  - "Phase-21 skills-propose token line left untouched (out of slice, merged main code)"

requirements-completed: [FOUND-04]

# Coverage metadata — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "resolveBearer plus firstLine in token.ts with env/file/dir order, caps and fail-open"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "packages/cli/src/token.test.ts (14 pass / 0 fail)"
        status: pass
    human_judgment: false
  - id: D2
    description: "CLI sends the per-surface bearer with env precedence; absent means no header"
    requirement: "FOUND-04"
    verification:
      - kind: integration
        ref: "packages/cli/src/cli-auth.test.ts (3 pass / 0 fail, real CLI spawn against recording stub)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Collector defaults to the event-surface file; explicit and env tokens win"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "packages/collectors/src/emit.test.ts (12 pass / 0 fail)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Parity probe authenticates as claude-code; 401 reads as auth-on-token-missing"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "scripts/parity-check.test.ts (42 pass / 0 fail)"
        status: pass
    human_judgment: false

# Metrics
duration: single-session plus rebase recovery
completed: 2026-10-09
status: complete
---

# Phase 20 plan 02: Client-side bearer resolution Summary

**One resolver serves CLI, collectors and parity-check: `resolveBearer` order env/token-file/tokens-dir, surface-threaded CLI headers, per-event collector tokens, and a 401 verdict that names the fix**

## Performance

- **Duration:** single agent session plus rebase recovery
- **Started:** 2026-10-09
- **Completed:** 2026-10-09
- **Tasks:** 3
- **Files modified:** 8 (3 created, 5 extended) plus this summary

## Accomplishments

- `packages/cli/src/token.ts`: `resolveBearer(surface, env, read)` plus exported `firstLine` — env `SUBSTRATE_TOKEN` first, then the file named by `SUBSTRATE_TOKEN_FILE`, then `<tokens-dir>/<surface>` (`SUBSTRATE_TOKENS_DIR` or `/etc/substrate/tokens`); surface regex before any join, 4 KiB cap, fail-open null, never logged
- `packages/cli/src/index.ts`: `headers(surface)` and `post(path, body, surface = "claude-code")`; `cmdBrief`/`cmdEmit`/`cmdHandoff` pass their already-computed surface; lessons token is the resolver result for `claude-code`; header doc carries the resolver order
- `packages/collectors/src/emit.ts`: default token is explicit-option-or-`resolveBearer(event.surface, process.env)` with env read at call time, so herdr sends each event under its own surface token with no herdr change
- `scripts/parity-check.ts`: `probeHealthz` resolves `claude-code`; the 401 verdict reads "auth on, token missing" and names the three variables to set

## Task Commits

1. **Task 1: token.ts resolver plus unit tests** — commit `6ff5695 feat(20-02)` (with Task 2)
2. **Task 2: CLI wiring plus spawn coverage** — same commit (wiring re-applied in `4ae5665` after the rebase, see Deviations)
3. **Task 3: Collector emit default and parity-check bearer** — commit `19d8450 feat(20-02)`

## Files Created/Modified

- `packages/cli/src/token.ts`, `packages/cli/src/token.test.ts` (new, 14 pass)
- `packages/cli/src/cli-auth.test.ts` (new, 3 pass — real CLI spawn against a recording stub on an allowlisted env)
- `packages/cli/src/index.ts` — surface-threaded bearer
- `packages/collectors/src/emit.ts`, `packages/collectors/src/emit.test.ts` — event-surface default plus 4 D20-05 tests (12 pass)
- `scripts/parity-check.ts`, `scripts/parity-check.test.ts` — resolver probe plus reworded 401 verdict (42 pass)

## Decisions Made

- The Phase 21 `skills propose` token line (`process.env.SUBSTRATE_TOKEN` passed straight to `runSkills`) was left untouched: it is merged main code outside this slice, with no surface to thread
- The absent-bearer emit test uses an empty temp tokens dir, so it stays hermetic against a provisioned `/etc/substrate/tokens`

## Deviations from Plan

### Auto-fixed Issues
**1. [Rebase conflict] Re-applied the index.ts wiring dropped by a main-wins resolution**
- **Found during:** rebase onto `origin/main` `ac0de03` (round 15: `packages/cli/src/index.ts`)
- **Issue:** the conflict resolver took main's version, dropping the `headers(surface)` / `post(path, body, surface)` / lessons-token hunks
- **Fix:** re-applied the hunks verbatim onto the current file; the only drift was Phase 21's skills import and header sentence, both kept. Two edit slips (a replaced comment line and import) were caught in `git diff` review and restored before verification
- **Files modified:** packages/cli/src/index.ts
- **Verification:** `cli-auth.test.ts` 3 pass, `bunx tsc --noEmit` clean
- **Committed in:** `4ae5665 fix(20-01,20-02)`

---
**Total deviations:** 1 auto-fixed (rebase recovery, no scope change)
**Impact on plan:** PLAN remains the authority and is fully executed.

## Issues Encountered

- Task 3 was blocked pre-rebase (`emit.ts` absent on the branch); the rebase onto a main holding Phases 16–19 supplied the precondition, verified present before editing
- The worktree `node_modules` predated Phase 27's `@substrate/ledger` link; `bun install` (no dependency changes) re-linked it

## Evidence

- `bun test packages/cli/src/token.test.ts` → **14 pass, 0 fail**
- `bun test packages/cli/src/cli-auth.test.ts` → **3 pass, 0 fail**
- `bun test packages/collectors/src/emit.test.ts scripts/parity-check.test.ts` → **54 pass, 0 fail**
- `bunx tsc --noEmit` → clean
- `git grep SUBSTRATE_TOKEN` in `packages/cli/src/index.ts` → only the Phase 21 skills line remains direct; every hook-path bearer goes through the resolver

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Client side of FOUND-04 is done: the UAT runner (20-04) and `identity:check --values` share the same resolver module
- Operator live steps (token provisioning, restart, evidence) stay operator-approved and untouched — no production switch-on was run

---
*Phase: 20-production-identity-and-phase-0-uat, plan 02*
*Completed: 2026-10-09*
