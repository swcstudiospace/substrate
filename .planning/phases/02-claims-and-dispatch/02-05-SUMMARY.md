---
phase: 02-claims-and-dispatch
plan: 05
subsystem: api
tags: [linear, mcp, claims, dod-gate, hermes-linear-connector, events, bun]

requires:
  - phase: 02-01
    provides: Mirror seam, LinearClient, claim_session ownership, tracer SWC-465 on ut-mugb3vwa-c57eb6ac
  - phase: 02-03
    provides: POST /v1/complete-issue on hermes-linear-api 127.0.0.1:8792
provides:
  - EVENT_KINDS "release" and "complete" (appended, D-08)
  - Mirror.release (Todo, agent:<surface> removed), Mirror.review (In Review), Mirror.done (no Linear call; 02-06 adds Notion)
  - DodGate client for POST /v1/complete-issue (never throws)
  - SubstrateConfig.hermesLinearUrl (HERMES_LINEAR_URL, default http://127.0.0.1:8792)
  - Substrate.releaseNode(graph, node, surface, session) and completeNode(graph, node, surface, session, dod?) with the ownership check
  - graph_release / graph_complete MCP tools that require session_id; graph_complete accepts dod; both return JSON
affects: [02-04 dispatcher Hermes prompt (graph_complete shape), 02-06 Notion mirror (Mirror.release/review/done), 02-08 proof, 02-09 tracer]

actuals:
  tokens: 60000
  tasks: 3
  commits: 4
plan_head_before: 94887f0

tech-stack:
  added: []
  patterns:
    - "Ownership gate: surface == claimed_by and session_id == claim_session, else a reason and zero writes (no index, tracker, gate or event)"
    - "Done is decided and written only by hermes-linear-connector; substrate resolves Todo / In Progress / In Review by name and never a Done id"
    - "Gate client fails closed: unreachable, non-2xx and malformed 200 answers are refusals with a reason"
    - "Mirror.run(step) wraps every Linear transition in one never-throw failure list; Substrate.warn turns failures into warning events"

key-files:
  created:
    - packages/mcp-server/src/dod-gate.ts
    - .planning/phases/02-claims-and-dispatch/02-05-SMOKE.md
  modified:
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/mirror.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/mcp.ts

key-decisions:
  - "The release event is emitted before the Linear mirror runs, as the claim event is (02-01), so a slow Linear never delays the log; warnings follow it"
  - "Every completion attempt that passes the ownership check emits one complete event, including a refusal and a node with no Linear issue (T-02-05-05)"
  - "A 200 answer from the gate without a boolean `completed` is a refusal (`dod gate returned a malformed answer: …`), not a completion"
  - "Index state writes (unstarted, started_review, completed) are best effort like the claim's `started`; index releaseNode failures propagate"

patterns-established:
  - "service.test.ts holderStores/trackerLinear/recordingGate harness: a stateful stub index plus fake fetches for Linear and the gate that record variables and call order"

requirements-completed: []

coverage:
  - id: D1
    description: "D-05: holder release → Linear Todo, agent:<surface> removed, claim cleared, unstarted, one release event with graph_id/node_id/repo; non-holder → refused with zero requests"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts#releaseNode (7 cases)"
        status: pass
      - kind: e2e
        ref: "02-05-SMOKE.md ownership_refused=true, release_state=Todo"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-06: graph_complete → In Review, then the connector's gate decides; refusal keeps In Review and the claim; approval → Done (by the connector), completed, released; substrate never sends a Done id"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts#completeNode → DoD gate (D-06) (10 cases)"
        status: pass
      - kind: e2e
        ref: "02-05-SMOKE.md refused_state=In Review, done_state=Done; Task 3 verify done-ok"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-08: release and complete kinds accepted by normalizeEvent; the hash chain verifies with them"
    verification:
      - kind: unit
        ref: "service.test.ts release/complete events reach the stub greptime through normalizeEvent"
        status: pass
      - kind: e2e
        ref: "POST /verify ut-mugb3vwa-c57eb6ac → {ok:true, events:5} (chain-ok)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-02: Linear failure during release or In Review → warning (target linear, action release|review), index change and gate call still happen"
    verification:
      - kind: unit
        ref: "service.test.ts 'Linear answering 500 still releases…', 'Linear failing on In Review warns…'"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 05: Release/complete mirror and the DoD-gated Done Summary

**`graph_release` and `graph_complete` now move the real Linear issue. Only the session that holds the claim can call them. Release returns the issue to Todo. Complete moves it to In Review and asks hermes-linear-connector's `/v1/complete-issue` gate for Done. The live tracer SWC-465 went Todo → In Progress → In Review (refused without DoD) → Done (through the gate), and the hash chain verified.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-25T01:58Z (approx.)
- **Completed:** 2026-09-25T02:10Z
- **Tasks:** 3/3
- **Files modified:** 8 (6 source, 1 new source, 1 planning evidence)

## Accomplishments

- `types.ts`: `EVENT_KINDS` gains `release` and `complete` at the end. Existing kinds keep their order, so existing hashes are unchanged.
- `mirror.ts`: `release` (Todo, `agent:<surface>` removed only when the issue carries it, one `issueUpdate`), `review` (In Review by name, never In Progress, never Done) and `done` (no Linear call). All three share one never-throw `run` wrapper with `claim`.
- `dod-gate.ts`: `DodGate.completeIssue` posts `{linear_issue_id, summary, tests_pass, review_pass}` with a 5 s timeout. It returns `{completed, reason}` and never throws.
- `service.ts`:
  - a `holder` lookup and an `ownershipRefusal` check shared by both tools
  - `releaseNode` and `completeNode` with index state, mirror, gate, `release`/`complete` events carrying `graph_id`, `node_id`, `repo`, `branch`, `session_id` and `linear_identifier`, and warnings for mirror failures
  - the `dodGate` constructor seam
- `config.ts`: `hermesLinearUrl`.
- `mcp.ts`: `graph_release` and `graph_complete` require `session_id`, and `graph_complete` accepts `dod`. Both return JSON results.
- Only one path leads to Done. A grep of `packages/mcp-server/src` shows `stateIdByName` is called only with "In Progress", "Todo" and "In Review". Unit tests assert that every substrate Linear write during complete carries only `st-review`.

## Task Commits

1. **Task 1: event kinds, ownership check, graph_release**: `3036c23` (feat)
2. **Task 2: graph_complete through the DoD gate, config, tool schemas**: `c1816ec` (feat)
3. **Task 3: live smoke on SWC-465**: `e339412` (docs, 02-05-SMOKE.md)

## Live evidence (02-05-SMOKE.md)

| Step | Response | Linear |
|---|---|---|
| omp / `02-05-intruder` release | `released:false`, holder named | unchanged (`updatedAt` 01:53:20.091Z) |
| holder release | `released:true`, unclaimed, `unstarted` | **Todo**, labels `[]` |
| re-claim `02-05-smoke-20260925T020326Z` | `claimed:true` | In Progress, `agent:claude-code`, new session comment |
| complete, no dod | `completed:false`, `dod not passed: tests_pass true and a non-empty summary are required` | **In Review**, claim kept, `started_review` |
| complete with dod | `completed:true` | **Done** (moved by the connector), node `completed`, unclaimed |
| `/verify` | `{ok:true, events:5}` | — |
| `graph_register status Done` | `status: "Done"` | — |

**GitHub twin:** SWC-465 is mirrored to swcstudiospace/agent_runtime#325. A read-only `gh api` call at 02:04:14Z showed it `closed` with `state_reason: completed` at 02:03:40Z, closed by `SomeRandmGuyy` through the workspace's Linear↔GitHub sync. That was one second after Linear's Done. This plan made no GitHub call.

## Baseline (two-sided)

| | Before (94887f0, measured before the first edit) | After (e339412) |
|---|---|---|
| bun test | 97 pass / 0 fail | 115 pass / 0 fail |
| failing ids | none | none (identical to 02-BASELINE.md) |
| tsc normalized set | `tsc-exit=0` | `tsc-exit=0` (identical) |

## Decisions Made

See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Fail closed] Malformed gate answers are refusals**
- **Found during:** Task 2
- **Issue:** The plan said "200 → the body's completed and reason". A 200 with a non-JSON body or no boolean `completed`, such as a proxy page, had no defined result.
- **Fix:** It returns `completed:false` with reason `dod gate returned a malformed answer: <≤200 chars>`. A unit test covers it.
- **Files modified:** dod-gate.ts, service.test.ts
- **Commit:** c1816ec

**2. [Ordering] Release event before the Linear mirror**
- The plan's action lists `mirror.release` then the emit. I followed 02-01's claim convention instead: the event goes first, then the mirror, then the warnings. A slow Linear therefore never delays the log. The behaviour list does not constrain the order, and the tests assert `["release", "warning"]`.

**3. [Environment] Verifies re-run under /usr/bin/bash**
- The agent harness's shell has a builtin `grep` whose `-o` with an anchored pattern prints nothing but exits 0. Task 3's pass-count comparison therefore failed spuriously when run in that shell. I ran all three `<automated>` commands verbatim from the plan with `/usr/bin/bash` on extracted script files. Each exited 0, and Task 3 printed `chain-ok` and `done-ok`. I reported the builtin to the harness.

**4. [Scope] Ultrathink uplift conflicts resolved toward the plan**
- An Ultrathink uplift arrived after Task 1. I did not run its `ultrathink-kickoff track complete` step, because that creates Linear rows and this wave forbids creating any Linear issue. No Linear issue was created.
- Its suggested throwing `DodGateError` and its "no complete event on gate failure" rule contradict the plan's never-throw contract and T-02-05-05. I followed the plan.
- Its clarification q1 (on emit failure, report success) matches the plan's `.catch(() => undefined)`. Q2 (run the live check) is required by Task 3.

**Total deviations:** 1 fail-closed addition, 1 ordering choice, 1 environment workaround, 1 scope note. **Impact:** none on scope.

## Issues Encountered

- After the gated Done, the issue still carries `agent:claude-code`. The plan's complete transition removes no label: the connector moves the state, and `Mirror.done` makes no Linear call. If Done issues should drop the agent label, the change belongs in `Mirror.done` or the connector, and would be a follow-up decision.
- The `graph_claim` response still shows the pre-claim `state` (`unstarted`), as noted in 02-01. `graph_get` shows `started`.

## Threat Flags

None beyond the plan's register. T-02-05-01 is proven live at step 1. For T-02-05-03, substrate sends no Done id, which the tests assert and the smoke confirms. T-02-05-04 holds: `/verify` returned ok with the new kinds.

## User Setup Required

None. `HERMES_LINEAR_URL` defaults to the live connector at `http://127.0.0.1:8792`.

## Next Phase Readiness

- 02-04's Hermes prompt calls `graph_complete {graph_id, node_id, surface:"hermes", session_id, dod:{summary, tests_pass}}`. Exec0204 confirmed this, and it matches the new schema.
- 02-06 adds Notion writes inside `Mirror.release`, `Mirror.review` and `Mirror.done`. `done` is already called only after the gate approves.
- The tracer graph `ut-mugb3vwa-c57eb6ac` is `Done` and SWC-465 is Done, so the tracer is closed. Linear capacity is unchanged by this plan: 248/250, no issue created.

## Self-Check: PASSED

- Task 1 verify (verbatim, `/usr/bin/bash`): exit 0. Targeted tests 56 pass / 0 fail, and the tsc set is identical to baseline.
- Task 2 verify: exit 0. Targeted tests 42 pass / 0 fail, and tsc is identical.
- Task 3 verify: exit 0. Full suite 115 pass / 0 fail with the same empty failing set, 115 > 76, all five smoke lines present, and it printed `chain-ok` and `done-ok`.
- `packages/mcp-server/src/dod-gate.ts` and `02-05-SMOKE.md` exist. Commits 3036c23, c1816ec and e339412 are on `main`. `packages/dispatcher` was not touched by this plan.
