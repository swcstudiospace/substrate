---
phase: 03-lane-a
plan: 08
subsystem: infra
tags: [substrate-host, telegram, approvals, d-13]

requires:
  - phase: 03-lane-a
    provides: 03-03 TaskRecord.pending_approvals and the onSessionEvent approval-pending log; 03-07 host functions
provides:
  - telegram.ts: encodeCallback, decodeCallback, newApprovalKey, isAuthorised, renderApprovalMessage, TelegramClient, TelegramError, ApprovalBroker, createApprovals (Task 1, `ed8cc94`)
  - tasks.ts TaskService.respondApproval as the only respondPermission path; vm.ts broker.post wiring
affects: [03-09, 03-10]

status: partial — Task 2 skipped by owner, Task 3 not run
---

# 03-08 Summary: Telegram approval broker

## Outcome

- **Task 1: done.** Commits `bc4431a` (failing test) and `ed8cc94` (implementation). Deployed with the keys absent. The journal shows `[substrate-host] telegram approvals off`. Post-wave gate at `ed8cc94`: bun test 338 pass / 0 fail, tsc exit 0, dispatcher pytest 149 passed.
- **Task 2 (owner checkpoint): SKIPPED.** Owner answer, verbatim: `skip` (2026-09-25). `sudo grep -c '^SUBSTRATE_APPROVAL_' /etc/substrate/substrate.env` returns 0, so no approval bot exists.
- **Task 3: not run.** Its precondition (three presence counts of 1) is unmet, so `03-08-SMOKE.md` was not produced.

## Consequences

- substrate-host runs with approvals **off**. VM permission requests stay pending, the same behaviour as 03-03, and nothing answers them. No code path auto-approves.
- 03-10's live Approve/Deny round-trip cannot run. The plan's resume signal says so directly: "the proof then cannot run its approval round-trip". ROADMAP SC-3's approval half stays open until the owner adds the three keys and re-runs Tasks 2 and 3 of this plan.

## Deviations

- None in code. The plan is closed partial by owner decision.
