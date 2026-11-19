---
phase: 61-session-rollback
verified: 2026-11-18T12:21:28Z
status: human_needed
score: 5/6 must-haves verified in the repository; criterion 3 code complete, activation is an operator step
re_verification:
  previous_status: gaps_found
  previous_score: 5 of 6 (criterion 3 PARTIAL)
  previous_verified: 2026-10-28 (main at 31a9bb36)
  gaps_closed: []
  gaps_remaining: []
  reclassified:
    - "criterion 3: PARTIAL (gaps_found) -> human_needed. The remaining work is installing the printed hook configuration in a host, which ADR 0007 (D55-4) makes an operator step. It is not a repository gap."
  regressions: []
covered_files: [".planning/milestones/v1.6-phases/61-session-rollback/CONTEXT.md", ".planning/milestones/v1.6-phases/61-session-rollback/SUMMARY.md", "docs/adr/0005-rollback-semantics.md", "docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md", "docs/runbooks/session-rollback.md", "packages/cli/src/session/checkpoint-worker.ts", "packages/cli/src/session/checkpoint.ts", "packages/cli/src/session/client.ts", "packages/cli/src/session/command.ts", "packages/cli/src/session/hook-config.ts", "packages/cli/src/session/hook.ts", "packages/cli/src/session/omp-fork.ts", "packages/cli/src/session/pending.ts", "packages/cli/src/session/rollback.ts", "packages/cli/src/session/steering-consumed.ts", "packages/cli/src/session/testkit.ts", "packages/cli/src/session/transcript-port.ts", "packages/cli/src/session/trigger-policy.ts", "packages/collectors/src/transcript-ref.ts", "packages/mcp-server/src/memory-forget-plane.ts", "packages/mcp-server/src/memory-forget.ts", "packages/mcp-server/src/session-events.ts", "packages/mcp-server/src/session-rollback.ts", "packages/worktree-snapshot/src/apply.ts", "packages/worktree-snapshot/src/errors.ts", "packages/worktree-snapshot/src/index.ts", "packages/worktree-snapshot/src/journal.ts", "packages/worktree-snapshot/src/lock.ts", "packages/worktree-snapshot/src/paths.ts", "packages/worktree-snapshot/src/pin.ts", "packages/worktree-snapshot/src/plan.ts", "packages/worktree-snapshot/src/policy.ts", "packages/worktree-snapshot/src/proc-stat.ts", "packages/worktree-snapshot/src/restore.ts", "packages/worktree-snapshot/src/runner.ts", "packages/worktree-snapshot/src/scenario.ts", "packages/worktree-snapshot/src/snapshot.ts", "packages/worktree-snapshot/src/testkit.ts", "packages/worktree-snapshot/src/tree.ts", "packages/worktree-snapshot/src/types.ts"]
covered_digest: "v3:sha256:2aba742a1fb54035119f48e1c163b2e6d4e64744b7fa6bddd9e839a6ec558847"
behavior_unverified: 0
overrides_applied: 0
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the printed hook configuration (`substrate session hook-config claude-code` for turn checkpoints and `substrate session hook-config git-post-commit` for plan-step checkpoints) in a host, run one turn or one plan-step commit, then run `substrate session checkpoints`."
    expected: "A new checkpoint with trigger `turn` or `plan-step` is listed, and its pinned ref appears under `refs/substrate/checkpoints/`."
    why_human: "Installing a host hook is an operator action (ADR 0007, D55-4). This repository installs nothing, and no `.claude/` configuration exists in the worktree. No automatic checkpoint can be observed from code alone."
  - test: "Decide whether the `steering` and `baseline` triggers (`hook-config steering`, `hook-config baseline`) are wired to a host event, and wire them if so."
    expected: "A steering directive or a first checkpoint-aware turn produces a `steering` or `baseline` checkpoint without a manual call."
    why_human: "ADR 0007 maps no host event to these triggers. Choosing and wiring the event is a decision for the operator."
---

# Phase 61: Session rollback to an exact chat moment with file revert — Verification Report

**Phase Goal:** A session can be rolled back to a checkpoint: files are restored exactly, the chat position is recorded, memory written after the checkpoint stops influencing recall, and the rollback is an append-only event. The revert runs as a CLI under the session's own authority; the substrate server stays read-only on worktrees.
**Verified:** 2026-11-18T12:21:28Z
**Status:** human_needed
**Re-verification:** Yes — re-verified against HEAD 357d6b15 (branch `gsd/autonomous-rerun`). The 2026-10-28 record was against main at 31a9bb36.

## Scope and method

- Phase directory: the phase is archived under `.planning/milestones/v1.6-phases/61-session-rollback/`. `.planning/phases/` on this branch has no `61-*` directory, so this record is written in the archived location.
- Criteria are taken from `.planning/ROADMAP.md` Phase 61 (`roadmap.get-phase 61`).
- Evidence is file reads and test-title presence checks at HEAD, plus targeted runs of two existing test files (below). The full suite was not run.
- Targeted runs (exit clean):
  - `bun test packages/worktree-snapshot/src/crash.test.ts`: 7 pass, 0 fail.
  - `bun test packages/cli/src/session/rollback.test.ts`: 37 pass, 0 fail.
- Commits since 31a9bb36 that touch the phase surface (`f64ebdd7` hook-config, `ffe32957` steering hints, `ac313051` steering credentials, `dbf25466` forget dedupe, `ca482e8e` strict types) left every cited file and test title in place. None of the criterion 1, 2, 4, 5 or 6 evidence was removed.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Snapshot, mutate and restore yields tree-hash equality including added, deleted, renamed, mode-changed, symlinked and untracked files; a failed or interrupted restore ends at the pre-rollback or target state after recovery, never partial, and a retry succeeds | MET | `packages/worktree-snapshot/src/restore.test.ts` `describe("restore: round trip")` (`"restores tracked, modified, deleted, renamed, chmod, symlink and untracked files byte for byte"`, `"the safety snapshot restores the pre-restore state exactly"`), `describe("restore: failure handling")`, `describe("restore: path safety")`, `"files deleted under a directory that the target holds as one file restore exactly"`; `packages/worktree-snapshot/src/crash.test.ts` `describe("crash at every operation index")` and `describe("recoverRestore")`; `packages/worktree-snapshot/src/property.test.ts` (`${ITERATIONS} seeded random trees restore to exactly their snapshot`); `snapshot.test.ts`, `pinned.test.ts`, `policy.test.ts`. Run: `crash.test.ts` 7/7 pass. |
| 2 | A dry-run lists the exact changes; drift outside the session is detected and refused without an explicit force; a safety snapshot is always taken first | MET | `packages/cli/src/session/rollback.test.ts` `describe("dry run")` (`"lists the exact changes and counts and changes nothing, locally or on the server"`, `"says a real run would refuse for drift, and still writes nothing to the ledger"`), `describe("drift")` (`"is refused (and reported), then goes through with force and the drifted state is kept in the pre-restore checkpoint"`, `"a refusal report that cannot be delivered does not change the refusal (fail-open)"`), `"the pre-restore checkpoint makes the rollback itself undoable, with no drift right after it"`, `describe("a restore that goes wrong")`. Run: `rollback.test.ts` 37/37 pass. |
| 3 | Checkpoints are created at defined boundaries (turn, plan step, steering event, manual) and carry an opaque transcript reference, the git tree, the manifest digest and the ledger chain head | MET in code; activation human_needed | The carried fields and triggers exist: `CHECKPOINT_TRIGGERS = ["turn", "plan-step", "steering", "manual", "pre-restore", "baseline"]` (`packages/mcp-server/src/session-events.ts:35`); `packages/mcp-server/src/session-events.test.ts` `describe("CheckpointPayload")` and `describe("TranscriptRef")`; `packages/cli/src/session/checkpoint.ts` (pins, numbers and chains a checkpoint); `packages/cli/src/session/checkpoint.test.ts` `describe("sequence allocation across callers sharing one git directory")` (`"two processes making checkpoints at once never pin the same seq"`); `packages/mcp-server/src/session-rollback.test.ts` `describe("session_checkpoint")`; transcript references `packages/collectors/src/transcript-ref.ts`. Boundary entry points: `packages/cli/src/session/hook.ts` (`substrate session hook <turn\|plan-step\|steering\|baseline\|context>`, fail-open, always exits 0). Rate and skip policy: `packages/cli/src/session/trigger-policy.ts` (`TURN_MIN_INTERVAL_MS = 60_000`, `PLAN_STEP_MIN_INTERVAL_MS = 10_000`, one steering checkpoint per directive id, skip when the tree is unchanged); `trigger-policy.test.ts`, `hook.test.ts`. Printed host configuration: `packages/cli/src/session/hook-config.ts` (`claude-code`, `git-post-commit`, `steering`, `baseline`, `context`; `hook-config.test.ts`). The CLI itself takes `manual` and `pre-restore`. Nothing in this repository fires `hook` by itself: `hook-config.ts` states it "writes no file, edits no settings and installs nothing", ADR 0007 states "No hook is installed by this repository", and the worktree has no `.claude/` configuration. The turn, plan-step and steering boundaries therefore produce checkpoints only after an operator installs the printed configuration in a host (ADR 0007, D55-4). That is an operator action, so it is recorded as human_needed, not as a repository gap. |
| 4 | A rollback appends `session.rollback`; entries and Hindsight documents written after the checkpoint are superseded or forgotten, recall after the rollback excludes them, and the rolled-back history stays retrievable for audit | MET | `packages/mcp-server/src/session-rollback.test.ts` `describe("session_rollback_commit: committed")` (`"forgets what the caller wrote after the checkpoint, keeps the rest, deletes the plane documents and records the totals once"`, plus repeat, replay, `until_ms` and late-recorded cases, and plane-pending retry); `packages/mcp-server/src/session-rollback.ts` (`FORGET_BATCH_ACTION = "session.rollback.forget_batch"`, `session.rollback` note); `memory-forget.ts`, `memory-forget-plane.ts`, `memory-forget.test.ts`; `packages/mcp-server/src/session-rollback-e2e.test.ts` (real CLI flow against the in-process server). |
| 5 | Transcripts are handled per surface: omp moves its session leaf; other surfaces get a marker event; no transcript is rewritten | MET | `packages/cli/src/session/transcript-port.test.ts` `describe("omp: fork written once, original untouched")`, `describe("omp: stale, not found, unsupported")`, `"the default port reports unsupported and never claims to have moved anything"` (in `rollback.test.ts` `describe("the transcript step")`); `packages/cli/src/session/omp-fork.ts` and `omp-fork.test.ts` (`"immutability, determinism, round trip"`). The omp original is never edited; a new forked file is written. |
| 6 | With the chain unreachable, a rollback still works from local checkpoints and reports them as unanchored | MET | `packages/cli/src/session/rollback.test.ts` `describe("the server is not there")`: `"unreachable at plan time: the rollback works from the local refs, says unanchored, queues the commit, and sync delivers it once"`, `"--offline never contacts the server and says so"`, `"a ledger that says it is down is treated like an unreachable server"`; `packages/cli/src/session/pending.ts`, `pending.test.ts`. Exit code 4 (files restored, ledger commit pending) per `command.ts`. Run: `rollback.test.ts` 37/37 pass. |

**Score:** 5/6 criteria MET in the repository. Criterion 3 is MET in code and its activation is human_needed.

## Required artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/worktree-snapshot/src/{snapshot,restore,apply,plan,pin,lock,journal,policy}.ts` | Snapshot, journaled atomic restore, pinning, policy | VERIFIED | Present; exercised by `restore.test.ts`, `crash.test.ts`, `property.test.ts`. |
| `packages/cli/src/session/{rollback,checkpoint,hook,trigger-policy,hook-config,pending,omp-fork,transcript-port,command}.ts` | CLI command surface and policies | VERIFIED | Present; tests present and the rollback suite passes. |
| `packages/mcp-server/src/session-rollback.ts`, `session-events.ts`, `memory-forget*.ts` | Server tools and event types | VERIFIED | Present; tests present. |
| `packages/collectors/src/transcript-ref.ts` | Transcript reference | VERIFIED | Present; `transcript-ref.test.ts` present. |
| `docs/runbooks/session-rollback.md`, `docs/adr/0005-rollback-semantics.md`, `docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md` | Runbook and ADRs | VERIFIED | Present. |

## Key link verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `command.ts` `rollback` | `rollback.ts` | command dispatch | WIRED | `command.ts` imports and dispatches the rollback path (exit codes 0 to 4). |
| `rollback.ts` | `session-rollback.ts` (server) | MCP tools `session_rollback_plan` / `session_rollback_commit` | WIRED | Covered by `session-rollback.test.ts` and `session-rollback-e2e.test.ts`. |
| `hook.ts` | `checkpoint.ts` | `createCheckpoint` under the checkpoint lock | WIRED | Trigger policy is re-run inside `admit`. |
| `hook-config.ts` | host (Claude Code, git post-commit) | printed text only | NOT_INSTALLED (operator) | Intentional: no host hook is installed by this repository (ADR 0007). |

## Anti-patterns

No stub, placeholder or debt-marker finding was recorded in this verification. The previously recorded residual items are carried forward, not gaps:
- The two-process `seq` race was closed by PR #146 (lock under `<git dir>/substrate-checkpoint.lock`).
- Resuming an omp forked session file is unverified for the installed omp.
- The rollback has never been rehearsed against the live server or ledger. This is not a success criterion.
- `refs/substrate/*` can hold untracked or ignored `.planning/` content and must not be pushed (runbook).
- A rollback is crash-recoverable, not atomic across files (`substrate session recover`).

## Human Verification Required

### 1. Host hook activation for turn and plan-step checkpoints

**Test:** Install the output of `substrate session hook-config claude-code` (turn) and `substrate session hook-config git-post-commit` (plan-step) in a host. Run one turn, or make one commit, then run `substrate session checkpoints`.
**Expected:** A new checkpoint with trigger `turn` or `plan-step` is listed, and its pinned ref is under `refs/substrate/checkpoints/`.
**Why human:** Installing a host hook is an operator action (ADR 0007, D55-4). No hook is installed in this repository.

### 2. Steering and baseline trigger wiring

**Test:** Choose the host event for `hook-config steering` and `hook-config baseline`, wire it, and trigger it.
**Expected:** A `steering` or `baseline` checkpoint is created without a manual call.
**Why human:** ADR 0007 maps no host event to these triggers. The choice is an operator decision.

## Gaps Summary

No repository gaps. Criteria 1, 2, 4, 5 and 6 are met, with targeted test runs green for criteria 1, 2 and 6. Criterion 3 is complete in code; checkpoints at the turn, plan-step and steering boundaries appear only after an operator installs the printed host configuration. That is recorded as human_needed.

---

_Verified: 2026-11-18T12:21:28Z_
_Verifier: Claude (gsd-verifier)_
