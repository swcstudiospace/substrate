---
phase: 02-claims-and-dispatch
plan: 06
subsystem: api
tags: [notion, mirror, claims, d-05, d-07, pat-guard, bun]

requires:
  - phase: 02-02
    provides: NOTION_API_KEY in substrate.env (a workspace-wide PAT), observed Issue-row types (Agent rich_text, Status status with Done, Linear State select, Completed date, Level select, Item title)
  - phase: 02-05
    provides: Mirror.release/review/done seams; service.warn turns every MirrorFailure into a warning event with its target
  - phase: 02-09
    provides: live dispatch tracer finished, so the substrate-mcp restart could not cut a Hermes graph_claim
provides:
  - "notion.ts: NotionClient (getPage → name→type, updatePage), notionPageId, buildProperty, NOTION_VERSION 2025-09-03, NOTION_WRITABLE (Agent, Status, Linear State, Completed), NotionError"
  - "Task-graph parent guard: every getPage/updatePage GETs the page and refuses one whose parent.data_source_id is not NOTION_TASK_GRAPH_DS; updatePage always GETs before its PATCH"
  - "Mirror: a Notion step after the Linear step in claim (Agent=surface), release (Agent cleared), review (Linear State In Review), done (Status Done, Linear State Done, Completed today UTC)"
  - "Startup line `[substrate] mirror: linear on|off, notion on|off`"
  - "substrate-mcp live with both mirrors on since 2026-09-25T04:47:00Z"
affects: [02-08 proof (Notion Agent hermes on claim; Status/Linear State/Completed on gated Done), ultrathink-sync (shares Issue rows; PR fields untouched)]

actuals:
  tokens: 11520
  tasks: 3
  commits: 3
plan_head_before: 63676239133df53c51443c11719c3b8044b75ff7

tech-stack:
  added: []
  patterns:
    - "Notion values are shaped by the row's own property types (GET before PATCH), not by a pinned schema"
    - "Linear State on the Notion row is written only when that transition's Linear step ran and succeeded; done writes it unconditionally (the connector already moved Linear)"
    - "PAT containment: a Notion write reaches only rows whose parent is the configured task-graph data source"

key-files:
  created:
    - packages/mcp-server/src/notion.ts
    - packages/mcp-server/src/notion.test.ts
    - .planning/phases/02-claims-and-dispatch/02-06-SMOKE.md
  modified:
    - packages/mcp-server/src/mirror.ts
    - packages/mcp-server/src/mirror.test.ts
    - packages/mcp-server/src/service.test.ts

key-decisions:
  - "NotionClient requires dataSourceId; a client that could skip the parent check cannot be built"
  - "updatePage re-GETs the page even though the mirror just called getPage: one extra GET per transition buys a client-enforced check before every PATCH"
  - "With Linear off (no key), Linear State is not written: substrate set nothing on Linear to mirror"
  - "The live smoke reused the existing index node ut-mufsocbe-c7ced745/n1 (orchestrator rule: existing index rows only); the graph's status was not changed to Done"

patterns-established:
  - "mirror.test.ts fakeNotion: GET answers a row of the observed 02-NOTION-SCHEMA types (PR-owned ones included) under a chosen data source; PATCH bodies are recorded for exact assertions"

requirements-completed: []

coverage:
  - id: D1
    description: "SC-1 / D-01: a winning claim sets Agent = surface on the node's Notion Issue row, shaped for the row's own type, from inside substrate-mcp"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/mirror.test.ts#Mirror → Notion Issue row (claim cases, select-typed Agent)"
        status: pass
      - kind: e2e
        ref: "02-06-SMOKE.md claim_agent=claude-code on page 3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8 at 04:48:10.010Z"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-05: graph_release clears Agent on the Notion Issue row"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/mirror.test.ts#release clears Agent and sets Linear State Todo (D-05)"
        status: pass
      - kind: e2e
        ref: "02-06-SMOKE.md release_agent= (empty) at 04:48:13.898Z"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-07: done writes only Status, Linear State and Completed; no request ever names PR URL, PR #, PR State, Repo or Branch; the writer refuses anything outside NOTION_WRITABLE before sending"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/notion.test.ts#NotionClient.updatePage — D-07 allowlist (5 refusals, zero requests); mirror.test.ts#done writes only Status Done, Linear State Done and Completed; #no request … names a PR-owned property"
        status: pass
      - kind: e2e
        ref: "02-06-SMOKE.md pr_fields_unchanged=true"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-02: Notion trouble (no notion_page, 4xx/5xx, missing property, unsupported type, foreign parent) becomes a notion failure/warning and never affects the index claim or the Linear step"
    verification:
      - kind: unit
        ref: "mirror.test.ts (no notion_page, missing Agent, people-typed Agent, 502, foreign parent); service.test.ts#a notion_page outside the Agent Task Graph is never PATCHed"
        status: pass
    human_judgment: false
  - id: D5
    description: "PAT guard: no PATCH reaches a page whose parent is not the Agent Task Graph data source; the refusal is a warning event with target notion"
    verification:
      - kind: unit
        ref: "notion.test.ts#Agent Task Graph parent check (6 cases); service.test.ts foreign-parent warning"
        status: pass
    human_judgment: false
  - id: D6
    description: "substrate-mcp restarted with NOTION_API_KEY; startup reports both mirrors on"
    verification:
      - kind: integration
        ref: "journal 04:47:03 '[substrate] mirror: linear on, notion on'; /healthz {index:true, greptime:true}; Task 3 verify exit 0"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 06: Notion Issue-row mirror Summary

**substrate-mcp now writes the Notion half of every transition. A claim sets `Agent`, a release clears it, review mirrors `Linear State`, and a gated Done writes only `Status`, `Linear State` and `Completed`. Each value is shaped for the row's own property types, and anything outside those four properties is refused before a request is sent. Because the key is a workspace-wide PAT, every PATCH is preceded by a GET that must show the page is a row of the Agent Task Graph data source. On a real row, a live claim set `Agent=claude-code` and the release cleared it.**

## Performance

- **Duration:** about 13 min
- **Started:** 2026-09-25T04:37:37Z
- **Completed:** 2026-09-25T04:50Z
- **Tasks:** 3/3
- **Files:** 3 created, 3 modified

## Accomplishments

- `notion.ts`:
  - `notionPageId` takes the last 32 hex characters of the final hex run in the path. The query and fragment are ignored, so a slug like `Add-feed-<id>` or a `#block` anchor cannot shift the id.
  - `buildProperty` shapes values for rich_text, title, select, status, multi_select and date. It returns null for people, relation, url and the rest, and for clearing a status.
  - `NotionClient`:
    - It sends `Authorization: Bearer …` and `Notion-Version: 2025-09-03`, with a 5 s timeout.
    - `NotionError` carries the status and at most 200 characters of the body, never headers.
    - Anything that is not a page id is refused before any request.
    - The parent check runs on every read and write.
- `mirror.ts`:
  - `run(ctx, linearStep, notionWants)` runs the Linear step first, then one Notion PATCH.
  - A missing or unwritable property becomes its own failure, and the remaining properties are still sent.
  - A node with no `notion_page` produces the failure `node has no notion_page` and makes no request.
  - A transition with nothing to write, such as review after a Linear failure, makes no Notion request.
  - `createMirror` builds the client from `NOTION_API_KEY` and `NOTION_TASK_GRAPH_DS`.
  - `describe()` now returns `linear on|off, notion on|off`.
- `service.ts` is unchanged. As the plan said, its `warn` already turns every `{target: "notion"}` failure into a warning event.

## Test counts (two-sided gate)

| | Before (6367623, measured before the first edit) | After (0060c22 / 963be21) |
|---|---|---|
| `bun test` | 115 pass / 0 fail, 9 files | 154 pass / 0 fail, 10 files |
| failing ids | none | none (identical to 02-BASELINE.md) |
| tsc normalized set | `tsc-exit=0` | `tsc-exit=0` (identical) |

New tests: 22 in notion.test.ts, 16 in mirror.test.ts and 1 in service.test.ts. 154 > `agent-substrate-pass=76`.

TDD: RED ran against a stub with the right exports. Task 1 gave 20 fail / 2 pass. Task 2 gave 17 fail / 42 pass across mirror.test.ts and service.test.ts, all assertion failures. GREEN then passed. Each task was committed once, per the orchestrator rule.

## Task Commits

1. **Task 1: NotionClient, page id parsing, type-shaped values, D-07 allowlist and parent check**: `0b31e41` (feat)
2. **Task 2: Notion step in every Mirror transition**: `0060c22` (feat)
3. **Task 3: restart and live smoke**: `963be21` (docs, 02-06-SMOKE.md)

## Service status

- `substrate-mcp` was restarted once, at 2026-09-25T04:47:00Z, after the full-suite gate. It is `active`, and `/healthz` returned `{"index":true,"greptime":true}` before and after the smoke.
- The journal line is `Sep 25 04:47:03 … [substrate] mirror: linear on, notion on`.
- `substrate-dispatcher` is `active` and was not touched. Its `SUBSTRATE_DISPATCH_DISABLED=1` was left alone.

## Live smoke (02-06-SMOKE.md)

| Step | UTC | Observed |
|---|---|---|
| Create throwaway Issue row | 04:48:04 | `POST /v1/pages` → 200. Page `3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8`, parent data source `be3418f0-…`. Level Issue, Item `[n1] substrate 02-06 notion smoke — throwaway`, Graph ID `ut-mufsocbe-c7ced745` |
| Row before | 04:48:04.890 | Agent `""`, Linear State null, Status null, Completed null. PR URL null, PR # null, PR State null, Repo `""`, Branch `""` |
| graph_register n1 → page | 04:48:06 | The existing node `ut-mufsocbe-c7ced745/n1` now has that `notion_page`. The graph status `unstarted` and surface `grok-bot` are unchanged |
| graph_claim claude-code, session `02-06-smoke-20260925T044803Z` | 04:48:09 | `claimed:true` |
| Row after claim | 04:48:10.010 | **Agent `claude-code`**. Linear State null: the node has no Linear issue, so that step warned and Linear State was correctly skipped |
| graph_release, same session | 04:48:13 | `released:true`, n1 `unstarted`, unclaimed |
| Row after release | 04:48:13.898 | **Agent `""`**. The PR fields are identical to before (`pr_fields_unchanged=true`) |
| Trash | 04:48:15 | `PATCH {in_trash:true}` → 200. The final GET shows `in_trash=True`, so `row_trashed=true` |
| Events | — | claim, warning (linear, claim), release, warning (linear, release). There was no notion warning. `/verify` returned `{ok:true, events:7}` |

A process under systemd-run's EnvironmentFile compared the key values with the smoke output and with 02-06-SMOKE.md. It found 0 hits for NOTION_API_KEY, LINEAR_API_KEY and GREPTIME_PASSWORD, and printed no value. All scripts in /tmp were deleted.

### Rows touched (for 02-08 and a cleanup)

- **Notion:** page `3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8` was created by the smoke and is now in the trash. No other Notion row was read or written.
- **Index `graph_nodes`:** `ut-mufsocbe-c7ced745/n1` went from `notion_page=null` to `3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8`. This is a **residual**: `graph_register` upserts with `coalesce` and cannot null it. The cleanup SQL is in 02-06-SMOKE.md. Its state and claim ended as they began: `unstarted` and unclaimed.
- **Index `graph_index`:** `ut-mufsocbe-c7ced745` has only `updated` changed, now `2026-09-25T04:48:05.188Z`.
- **Greptime:** 4 events with session `02-06-smoke-20260925T044803Z`.
- **Linear:** nothing. No issue was created or read, and SWC capacity is unchanged, so the one free slot is still reserved for 02-08.

## Decisions Made

See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security, orchestrator requirement] Parent check against the task-graph data source before any PATCH**
- **Found during:** Task 1
- **Issue:** The key is a PAT that can reach the whole workspace. Any MCP caller can `graph_register` a node with any `notion_page`, and the endpoint is anonymous because no `SUBSTRATE_TOKEN_*` is configured. So the D-07 allowlist alone would still let substrate write `Agent` on any page with a property of that name.
- **Fix:**
  - `NotionClient` takes a required `dataSourceId`. The plan's signature had `opts?` without it.
  - `getPage` and `updatePage` both GET the page and throw `NotionError("page … is not a row of the Agent Task Graph …")` unless `parent.data_source_id` matches the configured id, ignoring dashes and case.
  - `updatePage` always GETs before its PATCH, so a mirror transition costs GET, GET, PATCH.
  - Strings that are not page ids are refused before any request, so no path can be injected into `/pages/{id}`.
  - The refusal reaches the event log as a warning with `target: "notion"`.
- **Tests:**
  - notion.test.ts covers a foreign data source and a `page_id` parent, for both getPage and updatePage, with only a GET and never a PATCH. It also covers the undashed configured id.
  - mirror.test.ts has the foreign-parent case.
  - service.test.ts checks that the claim stands, exactly one GET is made, and one warning has target notion and action claim.
- **Files:** notion.ts, notion.test.ts, mirror.test.ts, service.test.ts
- **Commits:** 0b31e41, 0060c22

**2. [Rule 3 - Blocking] service.test.ts updated although it is outside Task 2's `<files>`**
- The plan's `describe()` change broke the existing assertion `mirror.describe() === "linear off"`. It now expects `"linear off, notion off"`.
- The file also carries the D5 warning-event test from deviation 1. service.test.ts is in Task 2's verify command.
- **Commit:** 0060c22

**3. [Orchestrator rule: existing index rows only] The live smoke used `ut-mufsocbe-c7ced745/n1` instead of a freshly registered graph**
- **What changed from the plan:**
  - The plan asked for a new `ut-…` graph. The orchestrator ruled that only existing index rows may be used.
  - n1 is the unused, Linear-free node of the Phase 1 proof graph. Using it produced the same expected `node has no Linear issue reference` warning the plan anticipated.
  - The throwaway row's `Graph ID` is `ut-mufsocbe-c7ced745` rather than a freshly minted id, so the row and the index agree.
- **Deliberate omissions:**
  - The plan's closing `graph_register {status: "Done"}` was **not** sent. It would have closed a Phase 1 graph this plan did not create.
  - The call also omitted `surface`, so the coalesce upsert kept `grok-bot`.
- **Residual:** n1's `notion_page` now points at the trashed row. See Rows touched.
- **Allowed by the plan:** creating the Notion row, which the plan explicitly requires.

**4. [Interpretation] Linear State is also skipped when the Linear target is off**
- The plan's action says to include it "only when that call's Linear step produced no failure". The must-have says it is "written only when that transition's Linear step succeeded".
- With no Linear key, no step ran and substrate set nothing on Linear, so Linear State is not written.
- A test pins this, and done still writes it unconditionally.

**5. [Process] One commit per task**
- The orchestrator's one-commit-per-task rule replaced tdd.md's separate `test(…)` then `feat(…)` commits.
- The RED evidence is recorded in the test counts section above.
- Two cast-free `instanceof` guards in notion.test.ts landed with Task 2's commit.

**6. [Environment] Verifies run with `/usr/bin/bash`**
- As in 02-05, all three `<automated>` commands were run verbatim from the plan with `/usr/bin/bash`.
- Tasks 1 and 2 used scripts written from the plan text. Task 3's command was extracted from the PLAN file. Each exited 0.

**Total deviations:** 2 auto-fixed (1 security addition, 1 blocking contract-test update), 1 orchestrator-rule change to the smoke target, 1 interpretation, 2 process/environment notes. **Impact:** every acceptance criterion holds. The parent check makes each transition one GET more expensive.

## Issues Encountered

- As noted in 02-01 and 02-05, the `graph_claim` response shows the node's pre-claim `state` (`unstarted`). `graph_get` shows the stored state.
- mcp.ts' `graph_release` description still names only the Linear effects. mcp.ts is outside this plan's files, so it was left as it is.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: authz | packages/mcp-server/src/mirror.ts | `/etc/substrate/substrate.env` has no `SUBSTRATE_TOKEN_*`, so `:7410/mcp` runs anonymous (journal: `(index + greptime, anonymous)`). Any local caller can `graph_register` a node against any Agent Task Graph row and claim it, which makes substrate write Agent and Linear State there. Before this plan, a claim wrote only to Linear. The parent check limits writes to task-graph rows, and the allowlist limits them to four properties. Only bearer tokens would limit who can trigger the writes. |

T-02-06-01 through T-02-06-05 are mitigated as registered. T-02-06-05 is covered because the row is trashed and `row_trashed=true`. The graph was not marked Done, because it is the existing Phase 1 graph; see deviation 3.

## User Setup Required

None.

## Next Phase Readiness

- 02-08's claim by hermes will set `Agent=hermes`. When the Linear step succeeds, it will also set `Linear State=In Progress`.
- 02-08's gated completion will write `Status=Done`, `Linear State=Done` and `Completed=<UTC date>` and leave the PR fields alone.
- 02-08's proof row must be created under data source `be3418f0-…`, which its planned POST parent already does. A row anywhere else is refused with a notion warning.
- Cleanup candidates are n1's residual `notion_page` on `ut-mufsocbe-c7ced745` and the trashed page `3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8`.

---
*Phase: 02-claims-and-dispatch*
*Completed: 2026-09-25*

## Self-Check: PASSED

- FOUND: `packages/mcp-server/src/notion.ts`, `notion.test.ts`, `mirror.ts`, `mirror.test.ts` and `.planning/phases/02-claims-and-dispatch/02-06-SMOKE.md`.
- FOUND commits on `main`:
  - `0b31e41` touches notion.ts and notion.test.ts.
  - `0060c22` touches mirror.ts, mirror.test.ts, notion.test.ts and service.test.ts.
  - `963be21` touches 02-06-SMOKE.md.
  - `git rev-list --count 6367623..HEAD` = 3 before this SUMMARY.
- Artifact patterns: notion.ts contains `2025-09-03`; mirror.ts contains `updatePage` and `notionApiKey`; 02-06-SMOKE.md contains `notion_skipped=`.
- Verify runs, each exit 0:
  - Task 1: 22 pass, tsc diff empty.
  - Task 2: 81 pass, tsc diff empty.
  - Task 3: 154 pass, 0 failing ids, 154 > 76, journal `mirror: linear on, notion on`, NOTION_API_KEY count 1, `notion_skipped=false`, `claim_agent=claude-code`, `release_agent=`.
- `.planning/config.json`, `.planning/state.json`, `issues/`, STATE.md and ROADMAP.md were not touched or staged. No Linear issue was created.
