---
phase: 03-lane-a
plan: 02
subsystem: api
tags: [mcp, linear, issue_get, redact, hermes-prompt, wr-05, in-01, d-15, d-16]

requires:
  - phase: 03-lane-a
    provides: 03-BASELINE.md two-sided gate (03-01); 03-01-SPIKE.md finished so the substrate-mcp restart could not land mid-probe
  - phase: 02-claims-and-dispatch
    provides: LinearClient/Mirror/Substrate seams, server.ts /verify route shape, launcher.py ids-only PROMPT_TEMPLATE, 02-REVIEW.md WR-05 and IN-01
provides:
  - LinearClient.issueText(ref) — IssueText GraphQL query (identifier, title, description)
  - Mirror.issueText(node) — never throws; "linear mirror off" / "node has no Linear issue reference" / "linear read failed: <message>"
  - Substrate.getIssue(graphId, nodeId), ISSUE_TEXT_NOTICE, ISSUE_DESCRIPTION_CAP (20 000), ISSUE_TITLE_CAP (500) — redact() then cap, read-only, {found:false, reason} union
  - issue_get MCP tool (readOnlyHint) and POST /issue HTTP route on substrate-mcp, live since the 13:42:14Z restart
  - Hermes PROMPT_TEMPLATE step (3) issue_get fetch framed UNTRUSTED, step (5) graph_release-and-stop
  - D-16 root-trust comment above CHILD_ENV_ALLOW
  - 03-02-SMOKE.md live evidence
affects: [03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 7124      # chars/4 over the 0bc4219..dda3758 diff (11 files, +468/-6)
  tasks: 3
  commits: 3
plan_head_before: 0bc4219cab9987ea521e3e8bb5baea753110bb61

tech-stack:
  added: []
  patterns:
    - "Read-only issue text path: index → graph.nodes → Mirror.issueText → redact() → cap → ISSUE_TEXT_NOTICE; no event, no write"
    - "HTTP route tests build createHttpServer(stub as never, loadConfig({})) on port 0 at 127.0.0.1 and close in afterAll"
    - "Prompt tests parse the curl line's tools/call arguments as JSON instead of pinning prose"

key-files:
  created:
    - packages/mcp-server/src/server.test.ts
    - .planning/phases/03-lane-a/03-02-SMOKE.md
  modified:
    - packages/mcp-server/src/linear.ts
    - packages/mcp-server/src/mirror.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/mcp.test.ts
    - packages/mcp-server/src/server.ts
    - packages/dispatcher/src/substrate_dispatcher/launcher.py
    - packages/dispatcher/tests/test_launcher.py

key-decisions:
  - "Mirror.issueText checks the Linear target before the node reference, so a keyless deployment reports 'linear mirror off' regardless of the node"
  - "getIssue leaves index read errors to the transport's existing 500 path (same as getGraph); only the enumerated found:false cases are absorbed"
  - "The graph_release curl in step (5) uses JSON-RPC id 4 (issue_get is 3) so the four prompt calls stay distinguishable in a transcript"
  - "The unknown-graph POST /issue answers 200 {found:false} — the route succeeded; only a malformed request is a 400"

patterns-established:
  - "Evidence files record only booleans, identifiers and lengths for untrusted issue text — never the title or description"

requirements-completed: []

coverage:
  - id: D1
    description: "Substrate.getIssue resolves a node's Linear issue text redacted, capped and framed untrusted, or explains why not, without throwing or writing"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts#getIssue (WR-05, D-15) — 8 tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "issue_get MCP tool (readOnlyHint) and POST /issue route behind the existing auth gate, 400 on missing ids or non-JSON body, 404 on GET"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/mcp.test.ts#issue_get (WR-05, D-15); packages/mcp-server/src/server.test.ts#POST /issue (WR-05, D-15)"
        status: pass
      - kind: integration
        ref: ".planning/phases/03-lane-a/03-02-SMOKE.md (healthz=200, issue_get_found=true, http_issue_found=true, unknown_graph_found=false, missing_node_status=400)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Dispatched Hermes prompt fetches its issue with issue_get for its own ids, frames it as untrusted task text, and can release-and-stop with surface hermes and the claim session id"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_launcher.py#test_render_prompt_step3_fetches_the_issue_with_issue_get_for_its_own_ids, …_orders_claim_then_issue_get_then_complete, …_step5_releases_as_hermes_with_the_claim_session_and_stops, …_step3_frames_issue_text_as_a_task_description_without_an_own_linear_tool, …_takes_ids_only_and_no_issue_text"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-16 root-trust note sits directly above CHILD_ENV_ALLOW (root, /etc/substrate/substrate.env, dispatch:hermes, dispatch:claude-code)"
    verification:
      - kind: other
        ref: "Task 3 <automated> verify: awk '/^CHILD_ENV_ALLOW/{exit}' … | tail -n 12 | grep substrate.env / dispatch:claude-code (exit 0)"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 02: issue_get and the Hermes release-and-stop step Summary

**substrate-mcp now serves a node's Linear issue text — redacted, capped and marked UNTRUSTED — through a read-only `issue_get` tool and `POST /issue`, live after a restart; the dispatched Hermes prompt fetches its issue that way and releases the node when it cannot do the work; the IN-01 root-trust assumption is written beside `CHILD_ENV_ALLOW`.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-09-25T13:39:03Z
- **Completed:** 2026-09-25T13:45:30Z
- **Tasks:** 3
- **Files modified:** 11 (9 modified, 2 created)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at 0bc4219 before the first edit | After (dda3758) |
|---|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 186 pass, 0 fail | 200 pass, 0 fail (+8 service, +2 mcp, +4 server) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 114 passed | 119 passed (+5 launcher) |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- `LinearClient.issueText`, `Mirror.issueText`, `Substrate.getIssue` with `ISSUE_TEXT_NOTICE`, `ISSUE_DESCRIPTION_CAP`, `ISSUE_TITLE_CAP`: index guard → graph → node → mirror → `redact()` → cap; every failure mode is a `{found:false, reason}` and no event or index write happens.
- `issue_get` MCP tool (readOnlyHint) and `POST /issue` (same auth gate, 400 on missing ids / non-JSON, GET 404), listed in the server.ts header.
- substrate-mcp restarted at 13:42:14Z: `active`, `/healthz` 200 `{"index":true,"greptime":true}`, journal `[substrate] mirror: linear on, notion on`. Live `issue_get` on `ut-mughkkc0-73909228/n1` (SWC-467) returned found:true with the exact untrusted notice; the HTTP reply was byte-equal to the MCP reply; `ut-none-00000000` returned found:false; a body without node_id returned 400.
- Hermes prompt: step (3) is one `issue_get` curl for the prompt's own graph_id/node_id framed as UNTRUSTED task text; step (5) is `graph_release` with `"surface":"hermes"` and the claim session id, then stop. `render_prompt` still takes ids only.
- D-16 comment above `CHILD_ENV_ALLOW`.

## Task Commits

1. **Task 1: issue_get service path** — `7926c0b` (feat)
2. **Task 2: issue_get MCP tool and POST /issue route, deployed by a substrate-mcp restart** — `71f06ef` (feat)
3. **Task 3: Hermes prompt issue_get + release-and-stop; D-16 note** — `dda3758` (feat)

**Plan metadata:** this SUMMARY commit (docs).

Each task ran RED (new tests failing: Task 1 load error on the missing exports, Task 2 5 failures, Task 3 5 failures) then GREEN before its single commit.

## Files Created/Modified

- `packages/mcp-server/src/linear.ts` — `issueText(ref)` with the `IssueText` query.
- `packages/mcp-server/src/mirror.ts` — `issueText(node)` union, never throws, message-only reasons.
- `packages/mcp-server/src/service.ts` — constants, `capped()`, `getIssue()`; imports `redact`.
- `packages/mcp-server/src/service.test.ts` — `getIssue (WR-05, D-15)` describe, 8 tests.
- `packages/mcp-server/src/mcp.ts` — `issue_get` registered next to `graph_get`.
- `packages/mcp-server/src/mcp.test.ts` — stub `getIssue`, `issue_get` reply and annotation tests.
- `packages/mcp-server/src/server.ts` — `POST /issue`, header docblock lists `/verify` and `/issue`.
- `packages/mcp-server/src/server.test.ts` — new: ephemeral-port route tests.
- `packages/dispatcher/src/substrate_dispatcher/launcher.py` — D-16 comment, steps (3) and (5).
- `packages/dispatcher/tests/test_launcher.py` — step-4 slice bounded by "(5)", `_tool_arguments` helper, 5 new tests.
- `.planning/phases/03-lane-a/03-02-SMOKE.md` — live evidence.

## Decisions Made

See key-decisions. Nothing departed from D-15 / D-16 or the plan's stated contract; the `/verify` header line was added while inserting `/issue` because the docblock had never listed it.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first hashline edit of `PROMPT_TEMPLATE` replaced one line short, leaving the old step (3) opener above the new one; caught by reading the region back before running anything and removed before the RED/GREEN run.
- Out of scope, not touched: Pyright reports a pre-existing type mismatch in `tests/test_launcher.py` (a `str` passed for `launch(clock=…)` in the untouched launch test); pytest is unaffected.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 03-03 (host side, `seed.ts`): the claude-code prompt can call the same `issue_get` — via loopback per 03-01's `route_choice=a:loopback`, or `POST /issue` from a host-function proxy — and copy steps (3) and (5) from the Hermes template. The reply contract is `{found, graph_id, node_id, identifier, title, description, untrusted}`.
- Dispatch stayed off throughout (`SUBSTRATE_DISPATCH_DISABLED=1` last-line count 4 before and after).

## Self-Check: PASSED

- FOUND: packages/mcp-server/src/server.test.ts, .planning/phases/03-lane-a/03-02-SMOKE.md
- FOUND: commits 7926c0b, 71f06ef, dda3758 (`git log --grep 03-02`)
- Task 1, 2 and 3 `<automated>` verify commands: exit 0 each
- Plan `<verification>`: issue_get and POST /issue unit-tested and live (healthz 200, POST /issue without node_id → 400 at 13:45:11Z); Hermes prompt carries issue_get and graph_release; D-16 note adjacent to CHILD_ENV_ALLOW; both suites two-sided green (200/0, tsc-exit=0, 119 passed)
