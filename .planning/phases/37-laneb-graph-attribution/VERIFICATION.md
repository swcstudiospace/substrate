---
phase: 37-laneb-graph-attribution
verified: 2026-10-21T08:54Z
status: passed
score: 1 of 1 success criteria proven at the collector boundary. Live effect and an end-to-end run on a live server are not proven, and need an operator action
verified_on: gsd/v13x-37-laneb 84e774d (code, after the PR #89 review fix), on origin/main e5891e9. This record is committed after 84e774d.
covered_files: ["packages/collectors/src/worktree-graph.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/herdr.test.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr-state.test.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/muse-etag.test.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/server.ts"]
---

# 37-VERIFICATION: LANEB, graph attribution from the worktree path

Verified by the orchestrator on 2026-10-21, after the PR #89 review. Requirement A-D1 (REQUIREMENTS.md:19). The change is collector-side only. The server contract it relies on already exists and was not modified.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Collectors suite passes | `bun test packages/collectors` on 84e774d: 294 pass, 0 fail, 0 skip, 20 files |
| Full repository suite passes on a throwaway Postgres 16 (`substrate_test`) | `bun test` with `SUBSTRATE_TEST_PG_URL` set, on 84e774d: 5700 pass, 2 skip, 0 fail, 5702 tests across 208 files, 127 s, exit 0 |
| The two skips are the same environment gates as before | `packages/mcp-server/src/cache-conformance.test.ts:127` (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset) and `packages/mcp-server/src/redact.test.ts:813` (the rehearsal round trip, one test, `SUBSTRATE_REHEARSAL_NAME` unset). The count stayed at 2 while the suite grew by 3 tests |
| Types clean | `bunx tsc --noEmit` exit 0 on 84e774d |
| A session never spans two graphs | Production attribution (`attributePane`) through `reconcile` over five snapshots, on 84e774d. Start in graph A; move to B; back to A; a status note with no directory keeps A; then a plain repo. Each session id carries one graph. Every change of graph ends the session with `end_reason: "graph_changed"`. The note keeps graph A |
| The review findings were reproduced before the fix | The three "one session, one graph" tests failed on the pre-fix code (`herdr-state.test.ts`: 3 fail) and pass after it (16 pass in that file) |
| Earlier checks, on e0a685a, before the review fix | Two throwaway mutations (a dropped event `graph_id`; an always-sent brief `graph_id`) each failed their named test, and both product files were restored byte-for-byte. A loopback smoke showed the herdr event and the Muse request carry `graph_id` only inside a graph worktree. These checks were not re-run on 84e774d |

## Review on PR #89

- P1, "Revisiting graphs breaks verification" (`herdr-state.ts`). Fixed: a graph change is a session boundary (`end_reason: "graph_changed"`), so no session spans two graphs.
- P2, "Existing panes stay untagged" (`herdr-state.ts`). Fixed: a session recorded before attribution is closed at the first snapshot that names a graph, so its end and the next session are tagged.
- Also found while reproducing P1: a snapshot with no directory overwrote the graph on a status note. Fixed: such a snapshot keeps the session.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Lane B events reach the graph's brief and evidence without agents passing ids | PASS at the collector boundary. Live effect not run | Herdr events for a pane inside a graph worktree carry `graph_id`, and a session stays inside one graph (the smoke above). Muse's brief request names the graph when the repo root is inside one. The server stores `graph_id` on `/events` (`server.ts:1064-1066, 1273`) and keys `/brief` on it (`server.ts:1017-1018`; `brief.ts:224`). Those paths are unchanged, and the full-suite run passes on this tree |

## Not proven

- **Live effect.** A-D1 says to add it "once dispatcher worktrees exist in production" (REQUIREMENTS.md:379). Making this true on a Lane B host needs the collectors redeployed where the dispatcher creates worktrees. Deploying is a live action and waits for operator approval (STATE.md run rules). Nothing was deployed.
- **`pass()` call site, end to end.** `pass` passes `graphIdForWorktree(repo)` to `fetchBrief`. Its path is the same helper the tests cover, but a real `/var/lib/substrate/worktrees/<graph_id>` directory was not created on this host, so the one-line call is verified by the type check and by reading it, not by a run.
- **`repo` and `branch` for a real worktree.** They are unchanged by this phase. The smoke ran against paths that are not git repositories, so `repo` came back empty there, as it already did before this change.
- **End to end on a live server.** No run in this phase sent a collector-shaped event through a live server and read it back in that graph's evidence, or asked a live server for the brief of a graph named by a Muse request. The server code that stores `graph_id` and keys the brief on it is unchanged, and the full-suite run passes on this tree. The end-to-end check needs a running substrate and a graph with a worktree.
