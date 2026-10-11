---
phase: 20-production-identity-and-phase-0-uat
plan: "06"
subsystem: uat
tags: [rehearsal-first, identity-manifest, token-parity, f-02-fix, live-window-deferred]

# Dependency graph
requires:
  - phase: 20-production-identity-and-phase-0-uat
    provides: "plans 20-01..20-05 (tokenConfig, resolver, manifest, UAT script, clone-local registration)"
provides:
  - "Rehearsal-first evidence: 6/6 harness-safe scenarios pass against main HEAD on a fresh twin"
  - "Names-only identity:check PASS (49 clients, no values)"
  - "Per-surface token-serving parity proof on the twin plus read-only production observation"
  - "F-02 fix (token.test.ts host-token isolation) shipped via PR"
  - "Operator-approval list for the remaining live window"
affects: [operator-live-window, phase-23-claim-mirror, later-phase-regression]

# Actuals — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 9000
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [rehearsal-first-live-gated-split, scratch-token-auth-matrix, empty-tempdir-test-isolation]

key-files:
  created: [.planning/phases/20-production-identity-and-phase-0-uat/20-06-SUMMARY.md]
  modified: [packages/cli/src/token.test.ts, .planning/phases/20-production-identity-and-phase-0-uat/20-UAT.md, .planning/milestones/v1.0-phases/00-brief/0-UAT.md]

key-decisions:
  - "Rehearsal-first on a fresh twin, not the persistent :17410 twin (sibling Phase 19 worktree commit, not main)"
  - "All three P20-06 tasks split: every production-mutating step deferred to an explicit operator-approval list, nothing live executed"
  - "F-02 fixed in this phase's scope per ticket contract (test-only, ships via PR)"

requirements-completed: [FOUND-04, UAT-01, UAT-02, UAT-04]

# Coverage metadata — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "Fresh twin evidence: scenarios 1,3,4,6,7,8 pass against main HEAD 1ee0b11"
    requirement: "UAT-01"
    verification:
      - kind: integration
        ref: "/tmp/p20-06-uat-harness.md (+ .json), run uat-p2006fresh, exit 0, 6/6 pass"
        status: pass
    human_judgment: false
  - id: D2
    description: "Names-only identity:check PASS over the 49-client manifest with no values in output"
    requirement: "FOUND-04"
    verification:
      - kind: other
        ref: "bun run identity:check → exit 0 PASS, 28/29 server names, token-shape scan clean"
        status: pass
    human_judgment: false
  - id: D3
    description: "Per-surface token auth matrix on the twin (401/200/200/401) plus read-only production observation"
    requirement: "FOUND-04"
    verification:
      - kind: integration
        ref: "curl matrix against twin :37703; parity:check production read-only (unit owns :7410, NRestarts=0, live 401 with names-only verdict)"
        status: pass
    human_judgment: false
  - id: D4
    description: "F-02 fixed: token.test.ts passes without reading real host state"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "bun test packages/cli/src/token.test.ts (14 pass / 0 fail with /etc/substrate/tokens provisioned)"
        status: pass
    human_judgment: false

# Metrics
duration: single-session
completed: 2026-10-10
status: complete
---

# Phase 20 plan 06: Rehearsal-first path and live-window handoff Summary

**Fresh twin evidence for everything that can run without production mutation (6/6 scenarios, identity manifest, token parity), F-02 fixed, and every remaining live step collected into an explicit operator-approval list — no live command executed**

## Performance

- **Duration:** single agent session
- **Started:** 2026-10-10
- **Completed:** 2026-10-10
- **Tasks:** 3 (all three P20-06 checkpoint tasks executed rehearsal-first; live halves deferred)
- **Files modified:** 1 code/test (PR branch) + 2 UAT records + this summary

## Accomplishments

- Fresh twin `p20` from a clean worktree at main `1ee0b11` (dirty=false) on `http://127.0.0.1:37703`; UAT run `uat-p2006fresh` → exit 0, **6/6 scenarios passing** (1, 3, 4, 6, 7, 8); teardown stopped pid 1675010 and removed 2 containers; production stores untouched by construction
- `bun run identity:check` → exit 0 **PASS**: 49 clients, server env 28/29 names present, token-shape scan over output clean; values mode never invoked
- Twin auth matrix: anonymous → 401, claude-code bearer → 200, cursor token-file bearer → 200, wrong bearer → 401; production read-only: unit active/running NRestarts=0 owning `:7410` at checkout `5f495ad`, live 401 with the names-only verdict
- F-02 fixed: the token-file test pins `SUBSTRATE_TOKENS_DIR` to an empty temp dir; 14/14 pass with the host tokens dir provisioned
- Full gates: `bun test` **2646 pass / 58 skip / 1 fail** (F-01 only, recorded do-not-fix), `bunx tsc --noEmit` clean, phase-20 files **252 pass / 0 fail**, `check:phase-close` pass (EVENT_KINDS 12, SURFACES 27)
- Records: `0-UAT.md` evidence refreshed to the fresh run (6 pass, scenarios 2 + 5 still live-gated); `20-UAT.md` gains rehearsal-first, identity, and parity sections with the live window explicitly marked not-run

## Task Commits

1. **Task 1 (rehearsal-first): manifest + parity evidence, no provisioning/restart/soak** — recorded in 20-UAT.md (docs commit below)
2. **Task 2 (rehearsal-first): no push/PR/merge/refresh/install** — nothing executed; commands collected for the operator (see report)
3. **Task 3 (rehearsal-first): fresh twin scenario evidence + records** — recorded in 0-UAT.md and 20-UAT.md (docs commit below)
4. **F-02 fix** — commit `96da80e fix(20-06)` on branch `fix/phase-20-token-test-isolation`, PR #45

## Files Created/Modified

- `packages/cli/src/token.test.ts` — one test isolates `SUBSTRATE_TOKENS_DIR` (PR #45, test-only)
- `.planning/phases/20-production-identity-and-phase-0-uat/20-UAT.md` — rehearsal-first, identity, parity sections; live window marked not-run
- `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` — six evidence lines refreshed to run uat-p2006fresh @1ee0b11; status still partial (2 live-gated)
- `20-06-SUMMARY.md` (this file)

## Decisions Made

- The persistent `:17410` twin was deliberately NOT used: `rehearsal status --name p19` shows it serves sibling Phase 19 worktree commit `57eba76`, not main. Fresh-evidence-against-main requires a fresh twin; the sibling twin was left untouched
- The harness refuses cwd `/root/src/repos/agent-substrate` (production checkout guard), so the twin ran from a clean detached worktree at `1ee0b11`; the worktree is removed after teardown
- `parity:check` targets production by design, so pointing twin credentials at it yields the expected live-401 verdict — recorded as a read-only production observation, not a failure
- UAT-03 (scenario 5 registration path) is satisfied in code by plan 20-05's clone-local work; its production proof (real kickoff, entry writer, plugin refresh) stays in the operator window

## Deviations from Plan

None material. The plan's three tasks are all `checkpoint:human-action` live-window tasks; per the operator rules (LIVE mutations need explicit approval) and the ticket contract, each was executed rehearsal-first with the live halves collected into the operator-approval list instead of executed. No production file, unit, repo hook, or tracker row was touched.

## Issues Encountered

- `rehearsal up` refused the production checkout path → clean detached worktree at `1ee0b11` (precedent: phases 16–19 ran from worktrees)
- Fresh worktree missed the `@substrate/ledger` link → `bun install` (no dependency changes) re-linked it (precedent: 20-02 summary)
- `identity:check` now exits 0 PASS where plan 20-03 recorded exit 1 with 5 stranded live clients: client token files have since been provisioned on the host. Names-only presence only — values-mode match, restart and soak are still ungated-operator work, so the live window stands

## Evidence

- `bun run uat:phase0 --tag p2006fresh --scenarios 1,3,4,6,7,8 --report /tmp/p20-06-uat-harness.md` → exit 0, **6/6 pass**; `/tmp/p20-06-uat-harness.md` + `.json`
- `bun run identity:check` → exit 0, PASS, 49 clients, 28/29 server names, no token-shaped strings in output
- Twin auth matrix → 401/200/200/401; no values printed
- `bun test` → **2646 pass / 58 skip / 1 fail** (F-01 `rehearsal.test.ts --port 7410`, recorded, not fixed)
- `bunx tsc --noEmit` → clean; `bun run check:phase-close` → pass
- Phase-20 unit files → **252 pass / 0 fail** across 10 files

## User Setup Required

- The 20-06 live window (Tasks 1–3 live halves: provisioning, values mode, restart, soak, cross-repo PR, plugin refresh, entry writer, hook installs, production scenarios 1/2/3/5/6) — human-gated, collected verbatim in the close-out report's OPERATOR APPROVAL NEEDED section, NOT done here

## Next Phase Readiness

- Phase 23 (claim mirror) can rely on per-surface production identity: resolver, manifest, and token enforcement all proven; only the operator window stands between here and attributed live claims
- Later phases reuse `docs/uat.md`'s loop; the fresh-twin pattern (clean worktree, `--port 0`, unique `--name`, teardown) is the template while the `:17410` slot is sibling-held

---
*Phase: 20-production-identity-and-phase-0-uat, plan 06*
*Completed: 2026-10-10*
