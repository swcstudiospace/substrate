---
phase: 03-lane-a
plan: 09
subsystem: infra
tags: [proof-setup, linear, notion, d-14, d-10, graph]

requires:
  - phase: 03-lane-a
    provides: 03-01 tracker_route=host; 03-07 claude-code route, sync and PR host functions; 03-08 (closed partial — approvals off)
  - phase: 02-claims-and-dispatch
    provides: 02-LINEAR-ARCHIVED.md owner-decision-2 rule and unarchive method; 02-NOTION-SCHEMA.md property types; 02-08 team resolution / issueCreate / graph_register pattern
provides:
  - Linear SWC-480 (805e6153-81ff-4049-87eb-6b2307f15fff) in Todo, no labels
  - Notion Task row 3e6bc1a0-c7ae-810b-ae3e-fd30bd081730 (Level Task, Status Implementing) and Issue row 3e6bc1a0-c7ae-81e4-89bf-cedb264de470 (Level Issue)
  - graph ut-muhk8v3p-47ae5f1a (repo swcstudiospace/agent-substrate, notion_task_page = Task row URL, n1 unclaimed)
  - dispatch:claude-code team label 3dee3876-a40c-457a-9db4-6dccee01b9a1 (created, not applied)
  - 03-PROOF.md ## Setup; 02-LINEAR-ARCHIVED.md ## Phase 3
affects: [03-10]

actuals:
  tasks: 2
  commits: 2
plan_head_before: ed5371dab218ff73a421ed2cf8f473f00ec7c8a5

key-files:
  created:
    - .planning/phases/03-lane-a/03-PROOF.md
  modified:
    - .planning/phases/02-claims-and-dispatch/02-LINEAR-ARCHIVED.md

key-decisions:
  - "pr_lands_decision=i — owner answer, verbatim: `i`"
  - "13 archives, not the 2 research predicted: the live count was 262 (12 'Untitled eng work' issues SWC-468..479 appeared that day); D-14's max(0, n − 249) was applied to the re-count"
  - "tracker_route=host → Task row created with Status Implementing on the session's behalf (kickoff_by=host, the D-10 deviation)"
  - "Graph stores both Notion rows as page URLs (Task URL = kickoff state taskUrl); notionPageId parses either form"

duration: ~10min
completed: 2026-09-25
---

# 03-09 Summary: proof setup (decision, archives, issue, rows, graph, label)

## Task 1 — owner decision

Owner answer, verbatim: `i`

Open the PR on swcstudiospace/agent-substrate from `substrate/<gid>` plus a Greptile review; the owner
merges later. Recorded as `pr_lands_decision=i` in 03-PROOF.md, so `proof_repo=swcstudiospace/agent-substrate`.

## Task 2 — live setup

- **D-14 archives.** Re-count at 22:55:11Z: 262 non-archived issues, so max(0, 262 − 249) = 13.
  The owner-decision-2 pool held 16 eligible issues. The 13 oldest by updatedAt were archived, each one
  re-read with the full rule and `graph_find` re-run just before its `issueArchive`. None was skipped
  and none failed. The count went 262 → 249, then 250 after the create. Archived: SWC-210, SWC-211,
  SWC-275, SWC-278, SWC-287, SWC-289, SWC-296, SWC-298, SWC-300, SWC-302, SWC-304, SWC-314, SWC-317.
  The rows, archive log and `issueUnarchive` method are in 02-LINEAR-ARCHIVED.md § Phase 3.
- **Issue.** SWC-480 `[substrate 03 proof] throwaway — dispatch:claude-code proof` was created in Todo
  (unstarted) with `issue_source=created`. The team was resolved at run time as the only visible team.
- **Notion.** The Task row is `3e6bc1a0-c7ae-810b-ae3e-fd30bd081730` (Level Task, Graph ID, Status
  Implementing). Its PR fields read back empty:
  `{"PR URL":null,"PR #":null,"PR State":null,"Repo":"","Branch":""}`. The Issue row is
  `3e6bc1a0-c7ae-81e4-89bf-cedb264de470` (Level Issue, Issue ID SWC-480, Linear URL).
- **Graph.** `ut-muhk8v3p-47ae5f1a` is registered with repo `swcstudiospace/agent-substrate`, branch
  main, status Implementing and `notion_task_page` set to the Task row URL. `graph_get` n1 returns
  `linear_issue_id=805e6153-…`, identifier SWC-480, notion_page set to the Issue row URL, and it is
  unclaimed.
- **Label.** `dispatch:claude-code` did not exist, so it was created as a team label
  (`3dee3876-a40c-457a-9db4-6dccee01b9a1`). It is **not applied**: the issue has no labels.
  substrate-host was not called.
- **Credentials.** Every keyed call ran under `sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env`.
  The scripts printed key=value lines only and were deleted afterwards.

Plan automated verify: passes (`graph-ok`, exit 0).

## Deviations

- **Archive count (live state, rule applied as written).** Research expected 2 archives. The live
  re-count required 13 because 12 `Untitled eng work` Backlog issues had been created that day by
  another workflow. D-14 defines the number as max(0, count − 249) from the execution-time count, so
  13 were archived. 3 eligible pool issues remain (SWC-319, SWC-323, SWC-330).
- **Workspace at the limit.** After the create, 250 issues are active. Any further `issueCreate`,
  including one by that other workflow, fails with USAGE_LIMIT_EXCEEDED until an issue is archived.

## Notes for 03-10

- Approvals are **off** because 03-08 closed partial (owner `skip`, no `SUBSTRATE_APPROVAL_*` keys). A
  VM permission request stays pending and nothing answers it, so the Approve/Deny round-trip cannot
  run. This is recorded in 03-PROOF.md Setup.
- Apply label `3dee3876-a40c-457a-9db4-6dccee01b9a1` to the `linear_issue_id` read from `graph_get`
  nodes[n1] only after the claude-code route is deployed.

## Self-Check: PASSED

- 03-PROOF.md and 02-LINEAR-ARCHIVED.md were committed in `8dcc7d2`.
- Live `graph_get ut-muhk8v3p-47ae5f1a` returned n1 with the recorded linear_issue_id, a notion_page and
  no claim, plus a graph-level notion_task_page.
