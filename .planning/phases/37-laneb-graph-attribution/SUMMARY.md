# Phase 37 — SUMMARY

## What changed
Lane B collectors attribute events to a graph from the worktree path the dispatcher created (`/var/lib/substrate/worktrees/<graph_id>`). The server already keys brief and evidence on `graph_id`, so no server code changed.

- `packages/collectors/src/worktree-graph.ts` (new): `WORKTREE_ROOT` and `graphIdForWorktree(path, root?)`. Pure string check; no filesystem access.
- `herdr.ts`: `attributePane(pane)` is exported and is the default attribution. It returns `repo`, `branch` and `graph_id` from the pane directory (`cwd`, falling back to `foreground_cwd`).
- `herdr-state.ts`: `HerdrPaneRecord.graph_id` (optional). It is set when a pane starts or its status changes, restored from the state file when it is a string, and copied onto each transition's event.
- `herdr-map.ts`: `HerdrTransition.graph_id`; `transitionToEvent` copies it onto the event when present.
- `muse.ts`: `fetchBrief(slug, branch, etag, graphId)` sends `graph_id` in the `/brief` body only when given. `pass` passes `graphIdForWorktree(repo)`.

## Tests added
- `worktree-graph.test.ts`, 3 tests: the worktree and anything under it name the graph; the root, a sibling, a climb out, and an unrelated repo name none; relative, empty and non-plain segments name none.
- `herdr.test.ts`, "graph attribution from the pane's directory", 2 tests: a pane in a graph worktree names it from `cwd` or from `foreground_cwd`; a pane elsewhere, at the root itself, or with no directory names none.
- `herdr-state.test.ts`, "a graph named at start stays on the pane record…", 1 test: the start event carries the graph; after save and reload, the session end (pane gone, default attribution) still names it.
- `muse-etag.test.ts`, "the graph on the brief request", 1 test: the body names the graph when one is given and has no graph field otherwise.

Collectors suite: 291 pass, 0 fail, 0 skip (20 files, was 284 before this phase).

## GREY_AREA decisions (for review)
1. The graph comes from the path only. An explicit `graph_id` on a transition is never replaced.
2. Muse's only per-repo request is the brief fetch, so inference applies to the brief body, not to events.
3. Herdr events inside a graph worktree now carry `graph_id`, so they appear in that graph's evidence. This is the requirement, A-D1.
4. The worktree root is a constant mirroring `worktree.py`. No environment knob was added.
5. A-D1's trigger text says "once dispatcher worktrees exist in production". The code is merged ahead of that trigger. It has no live effect until a Lane B host runs these collectors. Deploying is a live action and waits for operator approval.
6. The ETag stays per repo. The server computes it over the returned content, so one graph's tag cannot validate another graph's brief.

## Verification run in this phase
See VERIFICATION.md for the full-suite count and the exact commands.
