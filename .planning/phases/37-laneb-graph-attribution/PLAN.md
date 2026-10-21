# Phase 37 — PLAN

One plan, four tasks. Source files are in `packages/collectors/src/`.

1. **Helper** — `worktree-graph.ts` (new). `WORKTREE_ROOT` and `graphIdForWorktree(path, root?)`.
   Acceptance: `worktree-graph.test.ts`, 3 tests. The worktree and anything under it name the graph. The root, a sibling of the root, a climb out of the root, and an unrelated repo name none. A relative path, an empty value, and a non-plain segment name none.

2. **Herdr** — `herdr-map.ts` (`HerdrTransition.graph_id`, copied by `transitionToEvent`; `end_reason` gains `graph_changed`); `herdr-state.ts` (`HerdrPaneRecord.graph_id`, the `attribute` option type, restore, `recordFor`, `startOf`, `endOf`); `herdr.ts` (`attributePane` exported and used as the default attribution). Reconcile starts a new session whenever a snapshot's directory names a different graph or none. A status note keeps the session's graph.
   Acceptance: `herdr.test.ts` "graph attribution from the pane's directory" (2 tests). `herdr-state.test.ts` "a graph named at start stays on the pane record…" (1 test). `herdr-state.test.ts` "one session, one graph" (3 tests): a move to another graph and back starts a new session at each move; a session begun before attribution is closed and retagged at the first snapshot that names a graph; a snapshot with no directory keeps the session and its graph.

3. **Muse** — `muse.ts` (`fetchBrief(..., graphId)` sends `graph_id` only when one is given; `pass` infers it from the repo root).
   Acceptance: `muse-etag.test.ts` "the graph on the brief request" (1 test).

4. **Records** — `.planning/phases/37-laneb-graph-attribution/{CONTEXT,PLAN,SUMMARY,VERIFICATION}.md`; STATE frontmatter to milestone `v1.3.x`; ROADMAP checkbox, plan line and progress row; REQUIREMENTS A-D1 checked and traced.

## Verification gate
- `bun test packages/collectors`: 0 fail, 0 skip.
- `bun test` on the full repository against the throwaway Postgres 16: 0 fail, skip count recorded.
- `bunx tsc --noEmit`: exit 0.
- Red-then-green for each review finding: the three "one session, one graph" tests fail on the pre-fix code and pass after.
- Mutation check, throwaway copies only: a dropped event `graph_id` and an always-sent brief `graph_id`. Each must fail its named test.
- Loopback smoke of the changed paths: a herdr pane inside a graph worktree gets `graph_id` on `session.start`; a pane outside gets none; `fetchBrief` sends the body with and without `graph_id` to a real HTTP server.
