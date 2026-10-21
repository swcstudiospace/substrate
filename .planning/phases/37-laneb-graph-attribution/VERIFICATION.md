---
phase: 37-laneb-graph-attribution
verified: 2026-10-21T07:54Z
status: passed
score: 1 of 1 success criteria proven at the collector boundary. Live effect not proven: it needs a Lane B host with dispatcher worktrees, which is an operator action
verified_on: gsd/v13x-37-laneb e0a685a (on origin/main e5891e9; the diff against main is the collectors change plus the planning records)
covered_files: ["packages/collectors/src/worktree-graph.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/herdr.test.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr-state.test.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/muse-etag.test.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/server.ts"]
---

# 37-VERIFICATION: LANEB, graph attribution from the worktree path

Verified by the orchestrator on 2026-10-21. Requirement A-D1 (REQUIREMENTS.md:19). The change is collector-side only. The server contract it relies on already exists and was not modified.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Collectors suite passes | `bun test packages/collectors` on e0a685a: 291 pass, 0 fail, 0 skip, 20 files |
| Full repository suite passes on a throwaway Postgres 16 (`substrate_test`) | `bun test` with `SUBSTRATE_TEST_PG_URL` set, on e0a685a: 5697 pass, 2 skip, 0 fail, 5699 tests across 208 files, 144 s, exit 0 |
| The two skips are environment gates, not failures | `packages/mcp-server/src/cache-conformance.test.ts:127`: `test.skip` when `SUBSTRATE_CONFORMANCE_REDIS_URL` is unset. `packages/mcp-server/src/redact.test.ts:813`: the rehearsal round-trip describe, one test, skipped when `SUBSTRATE_REHEARSAL_NAME` is unset. Both gates pre-exist, and AGENTS.md names the rehearsal twin as skipped in this loop. This phase touches neither file's gate |
| Every `describeLive` suite ran, not skipped | `SUBSTRATE_TEST_PG_URL` was set for the full run, so the live index suites ran. None of the 2 skips comes from them |
| Types clean | `bunx tsc --noEmit` exit 0 on e0a685a |
| The new tests can fail | Two throwaway mutations in the collector sources. A dropped event `graph_id` fails "a graph named at start stays on the pane record, so the session end after a restart still names it" (`herdr-state.test.ts`). An always-sent brief `graph_id` fails "names the graph when one is given, and sends no graph field otherwise" (`muse-etag.test.ts`). Both product files were restored byte-for-byte, confirmed with `cmp` |
| Loopback smoke, changed paths | herdr: a pane in `/var/lib/substrate/worktrees/<graph_id>/packages/collectors` emits `session.start` with `graph_id`; a pane at `/home/ops/src/agent-substrate` emits `graph_id: null`. Muse: `fetchBrief` posted `{repo, branch, surface, graph_id}` with an id and `{repo, branch, surface}` without, to a real HTTP server on loopback, and both calls returned ok |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Lane B events reach the graph's brief and evidence without agents passing ids | PASS at the collector boundary. Live effect not run | Herdr events for a pane inside a graph worktree carry `graph_id` (`herdr.ts` `attributePane`, `herdr-state.ts`, `herdr-map.ts`). Muse's brief request names the graph when the repo root is inside one (`muse.ts` `fetchBrief`, `pass`). The server already stores `graph_id` on `/events` (`server.ts:1064-1066, 1273`) and keys `/brief` on it (`server.ts:1017-1018`; `brief.ts:224`). Those paths are unchanged, and the full-suite run above passes on this tree |

## Not proven

- **Live effect.** A-D1 says to add it "once dispatcher worktrees exist in production" (REQUIREMENTS.md:379). Making this true on a Lane B host needs the collectors redeployed where the dispatcher creates worktrees. Deploying is a live action and waits for operator approval (STATE.md run rules). Nothing was deployed.
- **`pass()` call site, end to end.** `pass` passes `graphIdForWorktree(repo)` to `fetchBrief`. Its path is the same helper the tests cover, but a real `/var/lib/substrate/worktrees/<graph_id>` directory was not created on this host, so the one-line call is verified by the type check and by reading it, not by a run.
- **`repo` and `branch` for a real worktree.** They are unchanged by this phase. The smoke ran against paths that are not git repositories, so `repo` came back empty there, as it already did before this change.
- **End to end on a live server.** No run in this phase sent a collector-shaped event through a live server and read it back in that graph's evidence, or asked a live server for the brief of a graph named by a Muse request. The server code that stores `graph_id` and keys the brief on it is unchanged, and the full-suite run passes on this tree. The end-to-end check needs a running substrate and a graph with a worktree.
