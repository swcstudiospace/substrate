---
phase: 02-claims-and-dispatch
plan: 01
subsystem: api
tags: [linear, graphql, mcp, claims, bun, postgres]

requires:
  - phase: 01-lane-b
    provides: substrate-mcp index claim (graph_nodes exclusive claim), event log, service/test seams
provides:
  - LinearClient (raw-key GraphQL, 5 s timeout, additive-only label writes)
  - Mirror seam with a Linear claim transition (In Progress by name, agent:<surface>, dispatch:* removed, one session comment)
  - claimNode mirror wiring with D-02 warning events and a D-04 no-write loser path
  - graph_find MCP tool (Linear issue → registered node, repo, branch)
  - "[substrate] mirror: linear on|off" startup line
  - 02-BASELINE.md (76/0, tsc clean) for the phase's two-sided gates
affects: [02-05 release/complete mirror, 02-06 Notion mirror target, 02-02/02-04 dispatcher (graph_find), 02-08 proof, 02-09 tracer]

actuals:
  tokens: 10540
  tasks: 3
  commits: 9
plan_head_before: 585f06d4d97af1d5f5e934a2feb21d3122f41754

tech-stack:
  added: []
  patterns:
    - "Tracker mirror seam: Mirror.claim returns MirrorFailure[] and never throws; the caller turns each failure into one warning event"
    - "Linear states resolved by name within the issue's team, never by type"
    - "Labels changed only through addedLabelIds/removedLabelIds; the client has no labelIds path"
    - "Keyed live checks run under systemd-run -p EnvironmentFile so the key never leaves the process"

key-files:
  created:
    - packages/mcp-server/src/linear.ts
    - packages/mcp-server/src/mirror.ts
    - packages/mcp-server/src/mirror.test.ts
    - .planning/phases/02-claims-and-dispatch/02-BASELINE.md
    - .planning/phases/02-claims-and-dispatch/02-01-TRACER.md
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/index.ts
    - packages/mcp-server/src/index-store.ts
    - packages/mcp-server/src/mcp.ts
    - /etc/substrate/substrate.env (LINEAR_API_KEY appended, not in repo)

key-decisions:
  - "Claim event is emitted before the mirror runs, so a slow Linear never delays the event; warnings follow it"
  - "Idempotent comment check matches 'session <id>' followed by a space or at end of body, so sess-10 does not mask sess-1"
  - "setNodeState(started) runs right after the winning index claim and before the event; failure is swallowed"
  - "findNodesByLinear returns at most 2 rows (limit 2): enough to tell one match from ambiguous"

patterns-established:
  - "Mirror.describe() feeds a single startup log line per target (02-06 appends notion)"

requirements-completed: []

coverage:
  - id: D1
    description: "Winning graph_claim moves the node's Linear issue to In Progress with agent:<surface>, removes dispatch:*, and posts one session comment"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/mirror.test.ts#Mirror.claim → Linear"
        status: pass
      - kind: e2e
        ref: "02-01 Task 1 verify (linear-ok, index-ok) on SWC-465 / ut-mugb3vwa-c57eb6ac"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mirror failures keep the claim and emit one warning each; the loser causes no Linear write; re-claims do not double-comment"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts#claimNode → mirror"
        status: pass
      - kind: e2e
        ref: "02-01-TRACER.md loser_claimed=false, loser_linear_unchanged=true"
        status: pass
    human_judgment: false
  - id: D3
    description: "graph_find resolves a Linear issue id/identifier to exactly one registered node, or reports ambiguous/unknown"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts#findNode"
        status: pass
      - kind: e2e
        ref: "02-01 Task 3 verify (find-ok)"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 01: Linear claim mirror and graph_find Summary

**A graph_claim sent to the live substrate-mcp now moves the real Linear issue SWC-465 to In Progress. In one issueUpdate it adds `agent:claude-code` and removes any `dispatch:*` label, and it posts one session comment. If the mirror fails, the claim is kept and a warning event records the failure. A losing claimer writes nothing. The new `graph_find` tool maps the issue back to its node.**

## Performance

- **Duration:** ~75 min wall-clock, including two blocked waits on the Linear Free-plan cap
- **Started:** 2026-09-25T00:40Z (approx.)
- **Completed:** 2026-09-25T01:55Z
- **Tasks:** 3/3
- **Files modified:** 10 in the repo, plus /etc/substrate/substrate.env

## Accomplishments

- `linear.ts`: `LinearClient` sends the API key raw, with no `Bearer` prefix. Requests use `AbortSignal.timeout(5000)`. Errors are typed as `LinearError` and carry the status and at most 200 characters of the body, never the key. The client provides `issueContext`, `ensureLabel`, `updateIssue` and `createComment`. `ensureLabel` prefers the team's label, then a workspace label, then creates one with the team id and re-queries once if the create fails. `updateIssue` is additive only.
- `mirror.ts`: `Mirror.claim` never throws and reports each failure with its target. `createMirror(config)` builds the Linear target only when the key is set. `describe()` returns `linear on` or `linear off`.
- `service.ts`: a winning claim sets the node state to `started`, then emits the claim event, then runs the mirror. Each failure becomes one `warning` event carrying `payload {target, action:"claim", reason}`. The loser branch does nothing.
- `graph_find`: backed by `IndexStore.findNodesByLinear` and `Substrate.findNode`. It matches on the issue UUID first, then falls back to the identifier.
- Live evidence in `02-01-TRACER.md`:
  - The tracer issue is SWC-465 on graph `ut-mugb3vwa-c57eb6ac`. It shows **In Progress** with label `agent:claude-code` and the comment `Claimed by claude-code — session 02-01-tracer-20260925T015316Z (graph ut-mugb3vwa-c57eb6ac, node n1)`.
  - A loser claim by `omp` returned `claimed:false`, and the issue's `updatedAt` and comment count did not change.
  - `graph_find` returned `found:true` with the tracer graph.
  - The identifier lookup (`issue(id:"SWC-465")`) resolves.

## Task Commits

1. **Task 1: Linear claim mirror + baseline** – `89c30fa` (feat)
2. **Task 2: failure semantics, idempotent comment, startup line** – `37885dc` (feat)
3. **Task 3: graph_find** – `a4ca95b` (feat)
4. Blocker and live evidence: `7f14531`, `b9d0333`, `41bbe69` (docs). `1299b02` is Main's commit, which archived the 28 issues.

`commits: 9` is `git rev-list --count 585f06d..HEAD` measured before this SUMMARY. It includes two commits from 02-03 (`eed43c4`, `dd781b5`) and Main's `1299b02`. 02-01 made six of them, and the SUMMARY commit makes seven.

## Files Created/Modified

- `packages/mcp-server/src/linear.ts`: Linear GraphQL client and `stateIdByName`
- `packages/mcp-server/src/mirror.ts`: Mirror seam and `createMirror`
- `packages/mcp-server/src/mirror.test.ts`: tests against a fake fetch. They cover In Progress chosen over In Review, reuse of a team or workspace label, label create with `teamId`, `dispatch:*` removal, no `labelIds`, no Bearer, the session comment, and a missing state
- `packages/mcp-server/src/service.ts`: mirror wiring, `findNode`, and the `mirror` property with its constructor seam
- `packages/mcp-server/src/service.test.ts`: D-02/D-04 tests and five `findNode` cases
- `packages/mcp-server/src/index-store.ts`: `findNodesByLinear` and the `LinearNodeMatch` type
- `packages/mcp-server/src/mcp.ts`: the `graph_find` tool (readOnlyHint)
- `packages/mcp-server/src/index.ts`: the `[substrate] mirror: …` startup line
- `02-BASELINE.md`, `02-01-TRACER.md`: planning evidence
- `/etc/substrate/substrate.env`: `LINEAR_API_KEY` appended with a sudo grep pipeline that never echoes the value. `sudo grep -c` prints 1, and the file is still mode 600, owned by root

## Baseline (two-sided)

| | Before (585f06d) | After |
|---|---|---|
| bun test | 76 pass / 0 fail | 97 pass / 0 fail |
| failing ids | none | none (identical) |
| tsc normalized set | `tsc-exit=0` | `tsc-exit=0` (identical) |

## Decisions Made

See `key-decisions` in the frontmatter. Everything else followed the plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Idempotent-comment check matched on a prefix**
- **Found during:** Task 2
- **Issue:** A plain `includes("session sess-1")` also matches an earlier `session sess-10` comment, which would suppress a real session's comment.
- **Fix:** The check now matches `session <id>` followed by a space or at the end of the body. A regression test covers it.
- **Files modified:** mirror.ts, service.test.ts
- **Commit:** 37885dc

**2. [Rule 3 - Blocking] Linear Free-plan issue cap blocked the live tracer**
- **Found during:** Task 1, Step 3
- **Issue:** `issueCreate` returned `USAGE_LIMIT_EXCEEDED` (`activeIssueCount`). The workspace had 275 non-archived issues against the documented limit of 250.
- **Resolution:** The first checkpoint went to Main. Under the first archive rules, only 3 issues were eligible and 26 archives were needed, so I archived nothing (evidence in `b9d0333`). The owner then chose option 2, and Main archived 28 duplicate Backlog issues (`1299b02`). The full list and the `issueUnarchive` method are in **02-LINEAR-ARCHIVED.md**. The tracer then ran once and created exactly one issue, SWC-465.
- **Capacity after the tracer:** a read-only count shows 248 active issues against the limit of 250, so **2 free slots remain**, one each for 02-09 and 02-08. Any further issue needs another archive or an upgrade.

**3. [Process] Task 1 committed through the index**
- The Task 2 edits to `mirror.ts` were already in the working tree when Task 1 was committed. To keep one commit per task, the Task 1 version of the file was staged with `git hash-object` and `update-index`. No other session's paths were staged.

**4. [Ordering] Live verifies ran after all three code commits**
- The live steps for Tasks 1–3 ran together once the cap was lifted. Before running the Task 2 verify's 30-minute journal check, I restarted substrate-mcp again. Afterwards the unit was `active`, `/healthz` returned `{"index":true,"greptime":true}`, and the journal showed `mirror: linear on`.

**Total deviations:** 1 auto-fixed bug, 1 external blocker resolved by the owner, 2 process notes. **Impact:** none on scope.

## Issues Encountered

- New SWC issues sync automatically to GitHub `swcstudiospace/agent_runtime`. SWC-465 created https://github.com/swcstudiospace/agent_runtime/issues/325 and a sync comment on the issue. This is a workspace integration, not substrate behaviour. The throwaway tracer therefore also has a GitHub twin, which 02-05 should expect when it closes the tracer.
- The `claim_response.node.state` value is the pre-claim `unstarted`, because the index `update … returning *` runs before `setNodeState`. Later reads show `started`.

## Threat Flags

None. Everything that crosses a trust boundary is already in the plan's threat model: the Linear writes, the key copy, and the read-only `graph_find` served on the existing loopback MCP endpoint.

## User Setup Required

None. The Linear capacity note above is the only operational follow-up.

## Next Phase Readiness

- 02-05 can build release/complete on `Mirror` and on the `claim_session` ownership.
- 02-06 adds a `notion` target to `Mirror` and extends `describe()`.
- The dispatcher plans can call `graph_find`.
- Tracer issue SWC-465 on graph `ut-mugb3vwa-c57eb6ac` stays open (In Progress, claimed by claude-code) for 02-05 to close through the DoD gate.

## Self-Check: PASSED

Re-ran every task's `<automated>` verify verbatim from the plan at 2026-09-25T01:54Z:
- Task 1: exit 0. Printed `linear-ok` and `index-ok`, targeted tests 24 pass / 0 fail, tsc set identical to baseline.
- Task 2: exit 0. Targeted tests 24/0, tsc identical, `loser_claimed=false` and `loser_linear_unchanged=true` present, journal `mirror: linear on` within 30 minutes.
- Task 3: exit 0. `find-ok`, full suite 97 pass / 0 fail with the same empty failing set, pass count 97 > 76.
- The created files exist, and commits 89c30fa, 37885dc, a4ca95b, 7f14531, b9d0333 and 41bbe69 are present on `main`.
