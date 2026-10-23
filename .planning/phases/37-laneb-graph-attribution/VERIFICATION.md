---
phase: 37-laneb-graph-attribution
verified: 2026-10-21T09:07Z
status: passed
score: 1 of 1 success criteria proven at the collector boundary. Live effect and an end-to-end run on a live server are not proven, and need an operator action
verified_on: gsd/v13x-37-laneb 2bf4cb7 (code, after the third PR #89 review fix), on origin/main e5891e9. This record is committed after 2bf4cb7.
covered_files: ["packages/collectors/src/worktree-graph.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/herdr.test.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr-state.test.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/muse-etag.test.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/server.ts"]
---

# 37-VERIFICATION: LANEB, graph attribution from the worktree path

Verified by the orchestrator on 2026-10-21, after the PR #89 review. Three Greptile findings: two on 2b5f364 (fixed in 84e774d), one on 52986c7 (fixed in 2bf4cb7). Requirement A-D1 (REQUIREMENTS.md:19). The change is collector-side only. The server contract it relies on already exists and was not modified.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Full repository suite passes on a throwaway Postgres 16 (`substrate_test`) | `bun test` with `SUBSTRATE_TEST_PG_URL` set, on 2bf4cb7: 5700 pass, 2 skip, 0 fail, 5702 tests across 208 files, 123 s, exit 0 |
| The two skips are the same environment gates | `packages/mcp-server/src/cache-conformance.test.ts:127` (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset) and `packages/mcp-server/src/redact.test.ts:813` (the rehearsal round trip, one test, `SUBSTRATE_REHEARSAL_NAME` unset). The count stayed at 2 while the suite grew by 3 tests |
| Collectors suite passes | `bun test packages/collectors` on 2bf4cb7: 294 pass, 0 fail, 0 skip, 20 files |
| Types clean | `bunx tsc --noEmit` exit 0 on 2bf4cb7 |
| Steady snapshots run no Git | Regression "a pane that stays put is attributed once, at its start, so Git does not run on steady snapshots": 3 attribution calls on the pre-fix code (red), 1 after the fix (green). Production-path smoke over seven snapshots with the default attribution, on 2bf4cb7: 4 Git calls in total; zero on the two steady snapshots and on the note with no directory |
| A session never spans two graphs | Production-path smoke, on 84e774d and again on 2bf4cb7: start in graph A; move to B; back to A; a status note with no directory keeps A; leaving every graph ends the session. Each session id carries one graph, and each change of graph ends the session with `end_reason: "graph_changed"` |
| Each review finding was reproduced before its fix | Findings 1 and 2: the "one session, one graph" tests failed on the code before 84e774d and pass after it. Finding 3: the steady-snapshot regression failed on the code before 2bf4cb7 (3 calls where 1 is expected) and passes after it. Herdr state suite: 18 pass, 0 fail, after the final fix |
| Earlier checks, on e0a685a (before the review fixes) | Two throwaway mutations (a dropped event `graph_id`; an always-sent brief `graph_id`) each failed their named test, and both product files were restored byte-for-byte. A loopback smoke showed the herdr event and the Muse request carry `graph_id` only inside a graph worktree. These were not re-run on 2bf4cb7 |

## Review on PR #89

- P1, "Revisiting graphs breaks verification" (`herdr-state.ts`, on 2b5f364). Fixed in 84e774d: a graph change is a session boundary (`end_reason: "graph_changed"`), so no session spans two graphs.
- P2, "Existing panes stay untagged" (`herdr-state.ts`, on 2b5f364). Fixed in 84e774d: a session recorded before attribution is closed at the first snapshot that names a graph, so its end and the next session are tagged.
- Also found while reproducing P1: a snapshot with no directory overwrote the graph on a status note. Fixed in 84e774d: such a snapshot keeps the session.
- P2, "Unchanged panes keep running Git" (`herdr-state.ts`, on 52986c7). Fixed in 2bf4cb7: the graph check is pure path work and runs on every snapshot; Git-running attribution runs only at session start, on a status change, and at a graph boundary.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Lane B events reach the graph's brief and evidence without agents passing ids | PASS at the collector boundary. Live effect not run | Herdr events for a pane inside a graph worktree carry `graph_id`, and a session stays inside one graph (the smoke above). Muse's brief request names the graph when the repo root is inside one. The server stores `graph_id` on `/events` (`server.ts:1064-1066, 1273`) and keys `/brief` on it (`server.ts:1017-1018`; `brief.ts:224`). Those paths are unchanged, and the full-suite run passes on this tree |

## Not proven

- **Live effect.** A-D1 says to add it "once dispatcher worktrees exist in production" (REQUIREMENTS.md:379). Making this true on a Lane B host needs the collectors redeployed where the dispatcher creates worktrees. Deploying is a live action and waits for operator approval (STATE.md run rules). Nothing was deployed.
- **`pass()` call site, end to end.** `pass` passes `graphIdForWorktree(repo)` to `fetchBrief`. Its path is the same helper the tests cover, but a real `/var/lib/substrate/worktrees/<graph_id>` directory was not created on this host, so the one-line call is verified by the type check and by reading it, not by a run.
- **`repo` and `branch` for a real worktree.** They are unchanged by this phase. The smoke ran against paths that are not git repositories, so `repo` came back empty there, as it already did before this change.
- **End to end on a live server.** No run in this phase sent a collector-shaped event through a live server and read it back in that graph's evidence, or asked a live server for the brief of a graph named by a Muse request. The server code that stores `graph_id` and keys the brief on it is unchanged, and the full-suite run passes on this tree. The end-to-end check needs a running substrate and a graph with a worktree.
