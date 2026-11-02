# Phase 74 context: cross-repo compensating actions

Goal (origin/main ROADMAP, phase 74 entry at b1b42f92): a multi-repo operation that fails partway undoes its completed steps, and a failed undo is recorded, not dropped.

Success criteria (origin/main ROADMAP, verbatim):
1. Owner decides whether a cross-repo write path is built first; no compensation is built against a path that does not exist.
2. The install-git-hook robustness gap is fixed or tracked separately; it is not a compensation case.

## Finding (corrected after verification)

The ROADMAP records that no multi-repo, multi-step write path needs compensation. Verification found that this premise is only partly right:
- Worktree prune (packages/cli/src/worktree/command.ts, about lines 321 to 395) removes worktrees across repositories in one command, and it writes a ledger note. It is multi-repo and multi-step.
- The git hook installer (packages/collectors/src/install-git-hook.ts, about lines 186 to 286) writes the post-commit hook and the corpus hooks in each repository. It is multi-repo and multi-step.
- Ingest (packages/cli/src/corpus/ingest.ts, about lines 98 to 204) is multi-step but writes to one remote target.
- Neither prune nor the installer keeps durable per-repository step state. Both are idempotent: a partial failure is repaired by running the same command again. The installer re-run was observed to install in the second run after a thrown error. Prune re-inventories from git on re-run; a dropped ledger note is not re-emitted when the spool is off.

## Decisions

- D74-1 (criterion 1, decided by the orchestrator on the owner's delegation, 2026-11-02; reversible by the owner): no compensation is built in v1.8. Compensation exists to undo completed steps that cannot be repeated safely. The multi-repo paths above are idempotent: undoing a completed hook install or a completed prune would be the wrong repair, and re-running is the correct one. Ingest writes to one target and needs no cross-repo compensation. The owner may reverse this; a reversal opens a new phase against the path it chooses.
- D74-2 (criterion 2): the install-git-hook gap is fixed in this phase. One failing repository no longer aborts the loop; each repository is counted once; the failure is named with a redacted one-line reason; the CLI exit code is unchanged on the no-failure path.
- D74-3 (the reason for D74-1, recorded so the owner can judge it): where a multi-repo write can fail partway, the repair is an idempotent re-run that the operator starts, and the CLI reports the failed repository by name. Durable step state and compensation are not added for idempotent steps.

## Scope of this phase

- Code: `packages/collectors/src/install-git-hook.ts` (the `installRepos` loop) and its tests.
- No compensation code and no new write path.

## Dependency

The ROADMAP says "Depends on: none". The branch is stacked on the phase 72 result so the repo-executor is available if a non-idempotent multi-repo path is introduced later. Phase 74 itself does not call it.
