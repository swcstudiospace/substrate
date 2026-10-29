# Phase 68: Worktree Fleet - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
Inventory, hygiene, conflict forecasts and disk limits for the git worktrees that many sessions create. It does not take over worktree creation for interactive sessions beyond `provision`, and it never deletes anything it cannot prove is merged, clean and pushed.

## Decisions
- **D68-1 (what exists):** claims are per graph node (`graph_nodes`, lease epoch and expiry, `index-store.ts:377-390,1014-1089`), never per file; the only mapping from a worktree path to a graph is `WORKTREE_ROOT=/var/lib/substrate/worktrees` hard-coded in `packages/collectors/src/worktree-graph.ts:9,20-25`, so this host's 106 directories under `/root/src/worktrees` map to nothing; the dispatcher is the only creator (`packages/dispatcher/src/substrate_dispatcher/worktree.py:106-147`) and its only guard is a 5 GiB floor at creation (`:23,119-129`); drift is per repository and never compares two worktrees (`drift.ts:230`); planning conflicts compare (phase, plan) pairs only (`planning/conflicts.ts`); nothing removes a worktree and the doctor excludes them.
- **D68-2:** discovery uses git, not a path convention: `git worktree list --porcelain` from each repository under the roots finds linked worktrees wherever they are.
- **D68-3:** prune classes are conservative: `safe` (clean, where ignored files that hold work, such as an ignored `.planning/` or local notes, count as not clean because `git worktree remove` deletes them silently and only regenerable directories such as `node_modules` are exempt; head pushed, idle past the threshold, and the current `HEAD` is an ancestor of the default branch or equals the head commit of a merged PR: a branch can gain commits after its PR merged and still be clean and pushed, so the branch name or the PR state alone proves nothing), `review` (everything else with a reason) and `never` (primary checkout, current directory, dirty, unpushed, locked). `--execute` removes `safe` only, with `git worktree remove`, never `--force`.
- **D68-4:** conflict forecast uses `git merge-tree --write-tree` (git 2.38 or newer; this host has 2.43), which predicts a conflict without touching either worktree.
- **D68-5:** the registry is a report the CLI and collectors post; the server does not touch worktrees (ADR 0005 and 0007).
- **D68-6:** the disk floor is one flag read by both the TypeScript provision command and the Python dispatcher.

## Evidence on this host
106 directories under `/root/src/worktrees` (48 `as-*`, 34 `agent-*`, 16 `claude-*`); the root filesystem is 98 percent used.

## Canonical references
`packages/worktree-snapshot` (rollback snapshots), `packages/projector`, `docs/swarm-workspace.md`, `docs/coordination.md`, `scripts/doctor-runtime.ts`
