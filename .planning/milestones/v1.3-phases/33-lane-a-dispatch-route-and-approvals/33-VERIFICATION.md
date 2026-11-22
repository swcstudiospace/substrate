---
phase: 33-lane-a-dispatch-route-and-approvals
verified: 2026-11-12T08:31:56Z
status: gaps_found
score: 2/3 roadmap success criteria verified (SC3 fake half red; live G1-G5 not run, operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-01-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-01-SUMMARY.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-02-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-02-SUMMARY.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-03-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-03-SUMMARY.md", "docs/dispatcher.md", "docs/runbooks/dispatch-proof.md", "docs/runbooks/lane-a-host.md", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/src/substrate_dispatcher/sessions.py", "packages/dispatcher/tests/test_claude_code_route.py", "packages/host/src/hostfns.ts", "packages/host/src/main.ts", "packages/host/src/tasks.test.ts", "packages/host/src/tasks.ts", "packages/host/src/telegram.test.ts", "packages/host/src/telegram.ts", "scripts/dispatcher-driver.py", "scripts/dispatcher-smoke.ts", "scripts/lane-a-e2e.ts"]
covered_digest: "v3:sha256:cec33a5db59aaeed3d8e0c1a6421845ea54ca02fc7f24d4c1eb53942d49aeefe"
gaps:
  - truth: "The fully-faked label-to-Done chain passes end to end, including host-side commit and push (33-03 truth 1; ROADMAP SC3 fake half)"
    status: failed
    reason: "scripts/lane-a-e2e.ts reports 27/29. Host-side commit and push both fail with 'worktree .git is missing'. The host git boundary (commit a2ce9c83, after the phase tip ed696ef) requires a real worktree at worktreeFor(graphId), and the chain never creates one. The 29/29 claim predates that commit."
    artifacts:
      - path: "scripts/lane-a-e2e.ts"
        issue: "commit/gitPush at lines 458-463 run against a worktree that does not exist; checks 'host-side commit' and 'push to the fixed branch' fail"
      - path: "packages/host/src/hostfns.ts"
        issue: "resolveGitSite returns 'worktree .git is missing' (line 207) for the chain's canonical worktree"
    missing:
      - "Make the fake chain create a real linked worktree (or inject a worktree root) so commit/push exercise the hardened path, then re-run scripts/lane-a-e2e.ts to 29/29"
  - truth: "The dispatcher-driver claude-code matrix (plan 01: landed = success, no give-up on a landed claim; refusal and outage paths) is green at HEAD"
    status: failed
    reason: "scripts/dispatcher-driver.py S11 'landed exit is success not give-up' and S12 'no session no give-up' fail. The driver expectations no longer match the sessions/host path, which changed after the phase tip (972d32db, 92035c33, phase 43 H-D3). pytest test_claude_code_route.py (14) still passes, so the drift is in the driver-level matrix, not the unit tests."
    artifacts:
      - path: "scripts/dispatcher-driver.py"
        issue: "line 473 (s11 landed exit) and line 493 (s12 no give-up) assertions fail at HEAD"
      - path: "packages/dispatcher/src/substrate_dispatcher/sessions.py"
        issue: "post-phase change to the pending-record/give-up path not reconciled with the driver matrix"
    missing:
      - "Reconcile dispatcher-driver.py S11/S12 with the post-H-D3 sessions behavior (or fix the behavior if the expectation is correct), then re-run to 0 failures"
deferred: []
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: gaps_found
---

# Phase 33: Lane A dispatch route and approvals — Verification

**Phase Goal:** A `dispatch:claude-code` label takes a Linear issue all the way to a gated Done through a Lane A VM, with a human approving each permission request.
**Verified:** 2026-11-12T08:31:56Z
**Status:** gaps_found
**Re-verification:** Yes. The prior report (2026-10-11, tip `ed696ef`, `passed`, 29/29) no longer holds at HEAD.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ROADMAP SC1: `dispatch:claude-code` routes to `POST /tasks`; a refusal becomes a once-only comment | ✓ VERIFIED | `dispatch.py:562-575` claude-code branch calls `open_task`; `host.py:117-147` POST `/tasks` and `HostRefused` mapping; `pytest packages/dispatcher/tests/test_claude_code_route.py` 14 passed; driver s12 host-refused once-only comment PASS |
| 2 | ROADMAP SC2: single-use Approve/Deny on Telegram; an unanswered request times out | ✓ VERIFIED | `telegram.ts:289-321` handleUpdate answers once, `expired` on replay; `tasks.ts:1061` `respondApproval` claim-first; `tasks.ts:1111` `sweepApprovalTimeouts` auto-denies; named tests pass: `tasks.test.ts` "tap-vs-timeout race…", "two concurrent taps…", "an expired deadline auto-denies…"; `telegram.test.ts` "an authorised Approve answers once…", "an authorised Deny…"; `bun test packages/host/` 314 pass / 0 fail |
| 3 | ROADMAP SC3: VM claims/heartbeats, restart resumes, real push/PR, PR sync, gated Done | ✗ FAILED (fake half); ⚠️ live half not run | `scripts/lane-a-e2e.ts` 27/29: "host-side commit" and "push to the fixed branch" FAIL (see gaps). Earlier checks pass: claim/heartbeat, approve, timeout auto-deny, restart resume-once, PR created, tracker sync, single release. Live G1–G5 is OPERATOR-GATED (see Human Verification). |
| 4 | 33-02: deadline auto-deny, single-use, closed vocabulary, fail-closed single release | ✓ VERIFIED | `tasks.ts:40-50,712,1037,1098,1111-1121`; named tests above; `lane-a-e2e.ts` "untapped approval auto-denies at the deadline", "timeout deny counted"; `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 42, locks green) |
| 5 | 33-01: landed claim = success; host outage silent; give-up paths remove label once | ✓ VERIFIED (unit) / ✗ driver | pytest route tests green; driver S11 landed-exit and S12 no-give-up checks FAIL (`scripts/dispatcher-driver.py:473,493`) |

**Score:** 2/3 roadmap success criteria verified; SC3 failed on the fake half; 0 behavior-unverified truths.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/dispatcher/src/substrate_dispatcher/dispatch.py` | claude-code branch → `open_task` | ✓ VERIFIED | `dispatch.py:562-575` |
| `packages/dispatcher/src/substrate_dispatcher/host.py` | POST `/tasks`, `HostRefused`, `RemoteTask` | ✓ VERIFIED | `host.py:117-147, 209-` |
| `packages/dispatcher/src/substrate_dispatcher/sessions.py` | give-up and given_up.json | ✗ DRIFTED | `sessions.py:34,191-293,531-545`; driver S11/S12 no longer match |
| `packages/host/src/tasks.ts` | deadlines, sweep, respondApproval | ✓ VERIFIED | `tasks.ts:38-50, 712, 1037-1121` |
| `packages/host/src/telegram.ts` | single-use broker | ✓ VERIFIED | `telegram.ts:208-321` |
| `packages/host/src/main.ts` | SUBSTRATE_APPROVAL_TIMEOUT_S | ✓ VERIFIED | `main.ts:64` |
| `packages/host/src/hostfns.ts` | git boundary (worktree back-pointer) | ⚠️ NOT EXERCISED by chain | `hostfns.ts:200-207` refuses the chain's worktree |
| `scripts/lane-a-e2e.ts` | 29-check chain | ✗ FAILED | 27/29 at HEAD, `lane-a-e2e.ts:462-463` |
| `scripts/dispatcher-driver.py` | S11–S16 matrix | ✗ FAILED | 2 failures at HEAD |
| `docs/runbooks/dispatch-proof.md` | G1–G5 gates, 13 OPERATOR-GATED markers | ✓ VERIFIED | `grep -v '^#' … \| grep -c OPERATOR-GATED` → 13 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `dispatch.py` claude-code branch | `HostClient.open_task` → `RemoteTask` → registry reap | `open_task(**ids)` | ✓ WIRED | `dispatch.py:564-566`; route tests green |
| `vm.ts` approval event | `recordApproval` + broker post → `handleUpdate` → `respondApproval` | deadline stamped | ✓ WIRED | `tasks.ts:1037-1040`, `telegram.ts:289` |
| heartbeat tick | `sweepApprovalTimeouts` | auto-deny | ✓ WIRED | `tasks.ts:712` |
| `lane-a-e2e.ts` commit/push | `hostfns` git site | `commit`/`gitPush` | ✗ NOT_WIRED at HEAD | worktree missing → checks fail |

### Data-Flow Trace (Level 4)

Not applicable: the phase's surfaces are control flow (route, approvals, git boundary), not rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Dispatcher unit suite | `python3 -m pytest packages/dispatcher/tests -q` | 289 passed | ✓ PASS |
| Claude-code route tests | `python3 -m pytest packages/dispatcher/tests/test_claude_code_route.py -q` | 14 passed | ✓ PASS |
| Host suite (approvals, tasks, telegram) | `bun test packages/host/` | 314 pass, 0 fail | ✓ PASS |
| Fake label-to-Done chain | `bun scripts/lane-a-e2e.ts` | 27/29; commit and push FAIL | ✗ FAIL |
| Dispatcher driver matrix | `PYTHONPATH=packages/dispatcher/src python3 scripts/dispatcher-driver.py --run-dir <scratch>` | 2 failures (s11 landed exit, s12 no give-up) | ✗ FAIL |
| Phase-close lock check | `bun run check:phase-close` | pass (EVENT_KINDS 12, SURFACES 42) | ✓ PASS |
| Gate marker pin | `grep -v '^#' docs/runbooks/dispatch-proof.md \| grep -c OPERATOR-GATED` | 13 | ✓ PASS |
| Debt markers in phase-touched source | `grep -n "TBD\|FIXME\|XXX"` on dispatch.py, tasks.ts, telegram.ts, main.ts, lane-a-e2e.ts | none | ✓ PASS |

Not run: `bun run verify` (full gate), full `bun test` (the earlier report recorded one unrelated pre-existing phase-16 failure), `scripts/dispatcher-smoke.ts`.

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes declared or present for this phase. Skipped.

### Anti-Patterns Found

None blocking. No TBD/FIXME/XXX in phase-touched source. The failing chain and driver checks are regressions, not stubs.

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| LANEA-04 (route + once-only refusal comment) | ✓ SATISFIED (fake) | Route tests green; driver s12 comment checks pass |
| LANEA-06 (single-use buttons + timeout) | ✓ SATISFIED (fake) | Host tests green; deadline auto-deny covered |
| LANEA-08 (live label-to-Done) | ? NEEDS HUMAN | Fake chain red at HEAD; live G1–G5 operator-gated |

## Human Verification Required

Live G1–G5 (`docs/runbooks/dispatch-proof.md`) are operator-gated and were not executed. These stay open regardless of the gaps above:

1. **G1 label wiring live**: `dispatch:claude-code` reaches the dispatcher against live Linear.
2. **G2 real VM dispatch**: a fresh issue opens a VM that claims and heartbeats.
3. **G3 real approvals**: a live Telegram tap answers once; an untapped request times out.
4. **G4 real push, PR, sync, gated Done**: real push and PR land; fields sync; gated Done.
5. **G5 production unit activations and manifest flips**.

## Gaps Summary

Two regressions at HEAD, both blocking:

1. **Fake chain red (SC3 fake half, plan 03 truth 1).** `scripts/lane-a-e2e.ts` 27/29. The host git boundary (`hostfns.ts`, a2ce9c83) requires a real worktree the chain does not create.
2. **Driver matrix red (plan 01).** `scripts/dispatcher-driver.py` S11 and S12 fail. These match post-phase `sessions.py` changes (972d32db, 92035c33, phase 43). Unit tests still pass, so either the driver expectations or the behavior need reconciling.

The prior `passed` verdict (2026-10-11, tip `ed696ef`) is superseded. Its 29/29 and driver-0-failures claims do not hold at HEAD. Plan 02 (approvals) is green. Live G1–G5 remain operator-gated.
