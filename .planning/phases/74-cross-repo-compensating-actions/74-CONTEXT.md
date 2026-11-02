# Phase 74 context: cross-repo compensating actions

Goal (ROADMAP): a multi-repo operation that fails partway undoes its completed steps, and a failed undo is recorded, not dropped.

Success criteria (ROADMAP, verbatim):
1. Owner decides whether a cross-repo write path is built first; no compensation is built against a path that does not exist.
2. The install-git-hook robustness gap is fixed or tracked separately; it is not a compensation case.

## Finding

The ROADMAP records that no multi-repo, multi-step write exists on main. The paths checked and rejected are: corpus ingest, skills propose, host commit and push, worktree provision and prune, snapshot restore, session rollback, steer, and the git hook installer. The phase 72 `repo-executor` (`scopedGit`) is a decision point for future multi-repo git calls, but it has no multi-step write caller. Phase 74 therefore has no path to compensate.

## Decisions

- D74-1 (criterion 1, owner-delegated decision, 2026-11-02): no cross-repo write path is built in v1.8. Compensation is not built against a path that does not exist. Rationale: a compensation built ahead of its path would be speculative, would be designed against assumptions the path does not yet make, and would enlarge the surface that must be kept correct. When a multi-repo write path is introduced, its own phase designs its compensation against the real steps. The owner may reverse this decision; if reversed, the reversal opens a new phase.
- D74-2 (criterion 2): the install-git-hook gap is fixed in this phase. One failing repository no longer aborts the loop; each repository is counted once; the failure is named with a redacted one-line reason; the CLI exit code is unchanged on the no-failure path.

## Scope of this phase

- Code: `packages/collectors/src/install-git-hook.ts` (the `installRepos` loop) and its tests.
- No compensation code, no new write path.

## Dependency

ROADMAP says "Depends on: none". The branch is nevertheless stacked on the phase 72 result so that the repo-executor is available if a multi-repo path is later introduced. Phase 74 itself does not call it.
