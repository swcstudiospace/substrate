# Phase 37 — LANEB: Lane B events reach the graph without ids

## Gap
A-D1 (REQUIREMENTS.md:19, FEATURES.md:197): a Lane B event for a worktree should reach that graph's brief and evidence without the agent passing a graph id. Depends on C-T3, the per-Graph-ID worktree (`packages/dispatcher/src/substrate_dispatcher/worktree.py`: `/var/lib/substrate/worktrees/<graph_id>` on branch `substrate/<graph_id>`).

## Current behaviour (read, with citations)
- Herdr. The default `attribute` in `herdr.ts` gives each pane `repo` and `branch` from `pane.cwd ?? pane.foreground_cwd`, and nothing else. `recordFor`, `startOf`, `endOf` and the status-change path in `herdr-state.ts` carry `repo` and `branch` into each transition. `transitionToEvent` (`herdr-map.ts`) copies them onto the event. No event carries a `graph_id`.
- Muse. `pass` (`muse.ts`) fetches `/brief` per repo root with `{repo, branch, surface: "muse"}`. No graph is named.
- Server. `/brief` already takes `graph_id` (`mcp-server/src/brief.ts:24-25, 224`; `server.ts:1017-1018`), and `/events` already takes it (`server.ts:1064-1066, 1273`). Brief and evidence are keyed on it. The gap is collector-side.

## Decisions
1. The graph id comes from the path, and only from it. The first segment under the worktree root is the id. It must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. The root itself, a path outside it, a path that climbs out of it, a relative path, and a segment that is not a plain id name no graph (`worktree-graph.ts`).
2. The helper is pure string work. It never stats the path, so it never follows a symlink.
3. An explicit `graph_id` on a transition is copied as given and is never replaced by inference.
4. Herdr. The default attribution is `attributePane`, exported from `herdr.ts`. It adds `graph_id` from the pane directory. The id rides the pane record (`HerdrPaneRecord.graph_id`, optional, restored when it is a string; the field is additive, so the state version stays 2). It is copied onto `session.start`, `note` and `session.end` events. A session that ends after a restart still names its graph.
5. Muse. `pass` passes `graphIdForWorktree(repo)` to `fetchBrief`. The request body gains `graph_id` only when one is inferred; otherwise the body is unchanged. The ETag stays per repo. The server computes the tag over the content it returns, so one graph's tag cannot validate another graph's brief.
6. No server change, no new environment variable, no new endpoint. The root constant mirrors `worktree.py` and is named in one place (`WORKTREE_ROOT`).

## Grey areas (auto-accepted under the STATE.md run rules: grey areas auto-accept unless they change a user-visible contract)
- G1. Muse emits no events. Its only per-repo request is the brief fetch, so inference applies there.
- G2. Herdr events for panes inside a graph worktree gain `graph_id`, so they appear in that graph's evidence. This is the requirement itself (A-D1), so it is accepted and not escalated.
- G3. A-D1's trigger is "Add once dispatcher worktrees exist in production" (REQUIREMENTS.md:379). The change lands in code now. It has no effect until a Lane B host runs these collectors where worktrees exist. Deploying to a host is a live action and waits for operator approval (STATE.md run rules). Nothing is deployed in this phase.

## Out of scope
A-D2 (herdr-hosted sessions), A-D3 (Orca tee), the server brief and evidence code, Linear and Notion writes, and any live host change.
