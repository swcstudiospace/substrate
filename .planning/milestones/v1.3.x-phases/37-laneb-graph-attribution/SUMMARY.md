# Phase 37 — SUMMARY

## What changed
Lane B collectors attribute events to a graph from the worktree path the dispatcher created (`/var/lib/substrate/worktrees/<graph_id>`). The server already keys brief and evidence on `graph_id`, so no server code changed.

- `packages/collectors/src/worktree-graph.ts` (new): `WORKTREE_ROOT` and `graphIdForWorktree(path, root?)`. Pure string check; no filesystem access.
- `herdr-state.ts`: `graphOfPane(pane)`, the pure graph check, exported. The reconciler takes `graphOf` (defaulting to `graphOfPane`) and checks it on every snapshot. `HerdrPaneRecord.graph_id` (optional) is set when a session starts, restored from the state file when it is a string, and copied onto each transition's event. A graph change is a session boundary: a snapshot whose directory names another graph, or none, ends the session (`end_reason: "graph_changed"`) and starts a new one. A snapshot with no directory keeps the session as it is. A status note keeps the session's graph.
- `herdr-state.ts` and `herdr.ts`: `attribute` (repo and branch, which run Git) is called only where a transition needs it: session start, status change, and a new session. `attributePane` returns `repo` and `branch` and is the default attribution.
- `herdr-map.ts`: `HerdrTransition.graph_id`; `transitionToEvent` copies it onto the event when present. `end_reason` gains `graph_changed`.
- `muse.ts`: `fetchBrief(slug, branch, etag, graphId)` sends `graph_id` in the `/brief` body only when given. `pass` passes `graphIdForWorktree(repo)`.

## Review fixes on PR #89
Greptile raised three findings in total. The first two were on `2b5f364`, and the third on `52986c7`.
- P1, "Revisiting graphs breaks verification": a pane that moved from worktree A to B and back kept one session id, and its status notes replaced the graph. The server then verified graph A against an event that graph A could not see. Fixed by the session boundary above. Reproduced first: "a pane that moves to another graph and back starts a new session at each move" failed on the old code.
- P2, "Existing panes stay untagged": a version-2 record loaded without a graph, and an unchanged live pane never got one, so its end event was untagged. Fixed by the boundary: the first snapshot that names a graph closes the old session and starts a tagged one. Reproduced first: "a session that began before graph attribution is closed at the first snapshot that names a graph" failed on the old code.
- Also found while reproducing P1: a snapshot with no directory overwrote the graph on a status note. Fixed: such a snapshot keeps the session. Reproduced first: "a snapshot that reports no directory keeps the session and its graph" failed on the old code.
- P2, "Unchanged panes keep running Git" (third finding): the boundary check called `attributePane` for every pane with a directory on every snapshot, and `attributePane` runs an uncached, synchronous Git process. Fixed by splitting the pure graph check (`graphOfPane`, on every snapshot) from the Git attribution (only on transitions). Reproduced first: "a pane that stays put is attributed once, at its start, so Git does not run on steady snapshots" failed on the old code with 3 attribution calls where 1 is expected.

## Tests
- `worktree-graph.test.ts`, 3 tests: the worktree and anything under it name the graph; the root, a sibling, a climb out, and an unrelated repo name none; relative, empty and non-plain segments name none.
- `herdr-state.test.ts`, "a graph named at start stays on the pane record…", 1 test: the start event carries the graph; after save and reload, the session end still names it.
- `herdr-state.test.ts`, "one session, one graph", 4 tests: the move and return; the upgrade path; the no-directory snapshot; the steady pane attributed once.
- `herdr-state.test.ts`, "the graph a pane's directory names", 1 test: `graphOfPane` reads the directory, falls back to the foreground process, and names none elsewhere.
- `muse-etag.test.ts`, "the graph on the brief request", 1 test: the body names the graph when one is given and has no graph field otherwise.
- The earlier herdr attribution-graph describe in `herdr.test.ts` (2 tests) moved to `graphOfPane`.

Herdr state suite after the final fix: 18 pass, 0 fail. Collectors suite after the final fix: 294 pass, 0 fail, 0 skip (20 files).

## GREY_AREA decisions (for review)
1. The graph comes from the path only. An explicit `graph_id` on a transition is never replaced.
2. Muse's only per-repo request is the brief fetch, so inference applies to the brief body, not to events.
3. Herdr events inside a graph worktree now carry `graph_id`, so they appear in that graph's evidence. This is the requirement, A-D1.
4. The worktree root is a constant mirroring `worktree.py`. No environment knob was added.
5. A-D1's trigger text says "once dispatcher worktrees exist in production". The code is merged ahead of that trigger. It has no live effect until a Lane B host runs these collectors. Deploying is a live action and waits for operator approval.
6. The ETag stays per repo. The server computes it over the returned content, so one graph's tag cannot validate another graph's brief.
7. A graph change ends the session and starts a new one (`end_reason: "graph_changed"`). The alternative, retagging a live session, would leave its earlier events outside the new graph's chain. `end_reason` is a payload value; the server does not validate it.
8. The graph check runs on every snapshot because it is pure string work. Git runs only at session start, on a status change, and at a graph boundary. A steady pane runs no Git.

## Verification run in this phase
See VERIFICATION.md for the full-suite count and the exact commands.
