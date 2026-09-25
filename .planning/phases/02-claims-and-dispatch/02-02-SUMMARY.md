---
phase: 02-claims-and-dispatch
plan: 02
subsystem: infra
tags: [notion, credentials, schema, agent-task-graph, systemd-run]

requires:
  - phase: 02-01
    provides: LINEAR_API_KEY appended to /etc/substrate/substrate.env (its line must survive the owner's append)
  - phase: 02-05
    provides: substrate-mcp restart finished before the owner's append; graph_get on :7410/mcp
provides:
  - NOTION_API_KEY in /etc/substrate/substrate.env (owner-added, exactly one line, file 600 root). The key is a PAT; see Deviations
  - "02-NOTION-SCHEMA.md: notion_skipped=false, data_source_http=200, page_read_http=200, and the observed types and options of the Issue-row properties"
affects: [02-06 Notion mirror (property shapes, Status option Done), 02-08 proof (Issue row POST body), D-07 PR-owned property guard]

actuals:
  tokens: 3700
  tasks: 2
  commits: 2
plan_head_before: 141d6815ca2531cc1d77d189856af72b104f0143

tech-stack:
  added: []
  patterns:
    - "Keyed read-only Notion calls run as sudo systemd-run --pipe -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/script. The script prints names, types and options only, and is deleted afterwards"

key-files:
  created:
    - .planning/phases/02-claims-and-dispatch/02-NOTION-SCHEMA.md
    - .planning/phases/02-claims-and-dispatch/02-02-SUMMARY.md
  modified: []

key-decisions:
  - "The owner supplied a Notion personal access token (PAT), not an internal integration. The owner accepted this on 2026-09-25 against T-02-02-02"
  - "The sample Issue row is n1 (SPE-119) of the backfilled graph ut-mucem4mc-ec70360f. Its notion_page came from MCP graph_get"
  - "Status is a Notion `status` type and has the option `Done`. Agent is rich_text, not a select"

patterns-established:
  - "02-NOTION-SCHEMA.md `notion_skipped=` is the single gap marker 02-06 Task 3 and 02-08 read"

requirements-completed: []

coverage:
  - id: D1
    description: "NOTION_API_KEY is present exactly once in substrate.env. LINEAR_API_KEY still appears exactly once, and the file is still 600 root"
    verification:
      - kind: other
        ref: "sudo grep -c '^NOTION_API_KEY=' → 1; sudo grep -c '^LINEAR_API_KEY=' → 1; sudo stat -c '%a %U' → 600 root"
        status: pass
    human_judgment: false
  - id: D2
    description: "The credential can read the Agent Task Graph data source and one Issue row, and the observed property types are pinned in 02-NOTION-SCHEMA.md"
    verification:
      - kind: integration
        ref: "02-02 Task 2 <automated> verify (exit 0): data_source_http=200, page_read_http=200, seven Name: type lines"
        status: pass
    human_judgment: false
  - id: D3
    description: "T-02-02-02 scope: the key is a PAT with the owner's full workspace reach. The owner accepted it; the plan had asked for an integration shared only on the Agent Task Graph"
    verification: []
    human_judgment: true
    rationale: "This is an owner risk acceptance. Only the owner can confirm that the PAT scope is acceptable"

duration: 3min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 02: Notion credential and Agent Task Graph schema Summary

**The owner's Notion PAT is in substrate.env. Read-only GETs, with `Notion-Version: 2025-09-03`, returned 200 for data source `be3418f0-…` and for Issue row SPE-119. The observed types are: Status is `status` and includes `Done`, Agent is `rich_text`, Linear State and Level are `select`, Completed is `date`, and Item is the title.**

## Performance

- **Duration:** about 3 min (resume at 04:33:28Z → 04:36Z)
- **Started:** 2026-09-25T04:33:28Z (Task 1 resume, after the owner answered "notion key added")
- **Completed:** 2026-09-25T04:36Z
- **Tasks:** 2/2
- **Files created:** 2

## Accomplishments

- **Task 1 close-out.** The owner answered "notion key added". Verification:
  - `test "$(sudo grep -c '^NOTION_API_KEY=' /etc/substrate/substrate.env)" = "1"` passed.
  - `sudo grep -c '^LINEAR_API_KEY='` printed `1`, so 02-01's line survived the owner's append.
  - `sudo stat -c '%a %U'` printed `600 root`.
- **Task 2.** Made two GET requests through the systemd-run EnvironmentFile pattern. Nothing was PATCHed or POSTed to Notion.
  - `GET /v1/data_sources/be3418f0-d2d8-411b-8677-fa8a95ee63be` → **200**. The data source is titled `Agent Task Graph` and has 38 properties. Its parent database is `843bc6ab-56b0-4b27-ae10-e258711edcb0`. substrate.env sets `NOTION_TASK_GRAPH_DS`, and its value equals the config.ts default.
  - `GET /v1/pages/3e3bc1a0c7ae814cbd4df349c98fb47e` → **200**. This is the Issue row n1/SPE-119 of the backfilled graph `ut-mucem4mc-ec70360f`, found through MCP `graph_get`. Its parent is `data_source_id` be3418f0-….
  - `/tmp/02-02-notion-schema.py` was deleted after the run.

Observed types (all from the API response):

| Property | Type | Options |
|---|---|---|
| Agent | rich_text | — (empty on the sample row) |
| Status | status | Merged, Resolved, Done, Won't Fix, Closed, Failed, Planning, Implementing, In Review, Changes Requested, Blocked, Running, Backlog, Queued, Open, Pending (groups: To-do / In progress / Complete) |
| Linear State | select | Backlog, Todo, In Progress, In Review, Done, Canceled |
| Completed | date | — |
| Level | select | Task, Issue, Sub-Issue |
| Item | title | — (the only title property) |
| Graph ID | rich_text | — |
| Issue ID | rich_text | — |
| Linear URL | url | — |
| PR URL (D-07) | url | — |
| PR # (D-07) | number | — |
| PR State (D-07) | select | Not opened, Draft, Open, In Review, Approved, Changes Requested, Merged, Closed |
| Repo (D-07) | rich_text | — |
| Branch (D-07) | rich_text | — |

## Task Commits

1. **Task 1: Owner adds NOTION_API_KEY.** This was a checkpoint with no repo change. The owner's action happened outside git, and the verification is recorded above.
2. **Task 2: Read the Agent Task Graph schema.** Commit `a118e43` (docs).

**Plan metadata:** the commit of this SUMMARY (docs(02-02)).

## Files Created/Modified

- `.planning/phases/02-claims-and-dispatch/02-NOTION-SCHEMA.md`: the `notion_skipped=false` gap marker, the HTTP codes, and the `Name: type` lines with their options. It also records the title property, the values on the sample row, the D-07 PR-owned section, and write-shape notes for 02-06 and 02-08.
- `/etc/substrate/substrate.env`: the owner appended one `NOTION_API_KEY` line. This file is outside the repo, and no agent edited it.

## Decisions Made

- The sample Issue row was taken from the index rather than from a Notion query. MCP `graph_get ut-mucem4mc-ec70360f` returned 8 nodes with a `notion_page` each, and n1 was used. This keeps Task 2 to exactly two GETs.
- `Agent` is empty on the backfilled Issue row. Issue rows do not carry an Agent value until substrate's mirror writes one.

## Deviations from Plan

**1. [Owner-accepted — T-02-02-02 Integration scope] Notion personal access token instead of an internal integration**
- **Found during:** Task 1 (checkpoint resume, 2026-09-25)
- **What the plan asked for:** A new internal integration named `agent-substrate` with the Read, Update and Insert content capabilities, shared only on the 🧩 Agent Task Graph database. That was T-02-02-02's `mitigate` plan.
- **What happened:** The owner supplied a Notion **personal access token (PAT)**.
  - A PAT acts as the owner's own user and has the owner's full workspace reach, not just the one database.
  - No database sharing or Connections step was needed. That is why the data source and page reads returned 200 with no share step.
  - Every row edit substrate-mcp makes (02-06 mirror, 02-08 proof) will be attributed to the owner in Notion's history, not to an `agent-substrate` bot.
- **Disposition:** The owner accepted this on **2026-09-25**. T-02-02-02 changes from `mitigate` to **accepted by the owner**. The remaining limit on substrate's reach is its code: it writes only Agent, Status, Linear State and Completed on Issue rows, never the D-07 PR-owned properties, and creates only the proof's Issue row.
- **T-02-02-01 and T-02-02-03 still hold.**
  - The key was only counted with `sudo grep -c`. The keyed process got it through systemd's EnvironmentFile, and it was never printed.
  - Only GET requests were sent.
- **Files modified:** none. The owner's action happened outside the repo.

**Total deviations:** 1, owner-accepted (credential type and scope).
**Impact on plan:** Every acceptance criterion holds. Only T-02-02-02's scope mitigation is replaced by an owner risk acceptance.

## Issues Encountered

None.

## User Setup Required

None beyond the owner's completed Task 1. substrate-mcp was **not** restarted. 02-06 restarts it after its code lands, and that restart is when the service loads `NOTION_API_KEY`.

## Next Phase Readiness

- 02-06 can build Notion writes from the observed shapes:
  - Status: `{"status":{"name":"Done"}}`. The option `Done` exists.
  - Linear State: `{"select":{"name":"In Review"}}`.
  - Agent: `{"rich_text":[{"text":{"content":"<surface>"}}]}`.
  - Completed: `{"date":{"start":"<ISO>"}}`.
- 02-08 can POST an Issue row with `parent: {type: data_source_id, data_source_id: be3418f0-d2d8-411b-8677-fa8a95ee63be}`, `Level` select `Issue`, `Item` title `[n1] …`, and `Graph ID` rich_text.
- Concern: because the key is a PAT, a bug in 02-06's page-id handling could edit any page the owner can reach. 02-06 should only PATCH pages whose parent is this data source. `[INFERENCE]` The page read confirms that Issue rows have `parent.data_source_id` = be3418f0-….

---
*Phase: 02-claims-and-dispatch*
*Completed: 2026-09-25*

## Self-Check: PASSED

- FOUND: `.planning/phases/02-claims-and-dispatch/02-NOTION-SCHEMA.md` and `.planning/phases/02-claims-and-dispatch/02-02-SUMMARY.md`.
- FOUND: commit `a118e43` on `main`. It touches only 02-NOTION-SCHEMA.md.
- The Task 1 verification passed: NOTION count 1, LINEAR count 1, `600 root`.
- The Task 2 `<automated>` verify, run verbatim with `/usr/bin/bash`, exited 0. All 14 recorded properties have a column-0 `Name: type` line.
- Token absence: a systemd-run EnvironmentFile process counted occurrences of the key's value in both files and found `token_hits=0` in each. The value was compared, never printed.
- `/tmp/02-02-notion-schema.py` and `/tmp/02-02-token-check.py` were deleted. No Notion PATCH or POST was sent, and substrate-mcp was not restarted.
- `.planning/config.json`, `.planning/state.json`, `issues/`, STATE.md and ROADMAP.md were not touched.
