# 03 Lane A proof evidence

Recorded from observed output only.

## Setup

Recorded by plan 03-09 on 2026-09-25 (22:55–22:57Z). Nothing is labelled and substrate-host was not
called; 03-10 applies `dispatch:claude-code` and runs the proof.

### Owner decision (03-09 Task 1)

Owner answer, verbatim: `i` — open the PR on swcstudiospace/agent-substrate; the owner merges later.
"The PR lands" therefore means: PR opened from `substrate/<gid>` plus a Greptile review. The merge is
not part of the proof.

pr_lands_decision=i

### Approvals are off (03-08 closed partial)

03-08 was closed PARTIAL: the owner answered `skip` to the approval-bot checkpoint.
`sudo grep -c '^SUBSTRATE_APPROVAL_' /etc/substrate/substrate.env` returns 0, so no approval bot
exists and substrate-host runs with `telegram approvals off`. For 03-10 this means a VM permission
request stays pending and nothing answers it; the Approve/Deny round-trip cannot be exercised.
This is not a blocker for 03-09's setup.

approvals=off

### Preconditions

```
sudo grep -c '^LINEAR_API_KEY=' /etc/substrate/substrate.env    → 1
sudo grep -c '^NOTION_API_KEY=' /etc/substrate/substrate.env    → 1
systemctl is-active substrate-mcp substrate-dispatcher          → active, active
df --output=avail -B1 /                                          → 20637184000
git -C /root/src/repos/agent-substrate branch --show-current    → main
```

free_disk_before=20637184000
main_branch_before=main

### Commands (keys elided)

Every keyed call ran as
`sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/03-09-<name>.py`
(`count`, `archive`, `create`, plus a read-only `new` listing of the newest issues). The scripts held
no key, printed key=value lines only, and were deleted afterwards (`ls /tmp/03-09-*` → no such file).
Linear: `https://api.linear.app/graphql`. Notion: `https://api.notion.com/v1/pages`,
`Notion-Version: 2025-09-03`. MCP: `http://127.0.0.1:7410/mcp`.

### D-14 archives

Count at 2026-09-25T22:55:11Z: `issues(includeArchived: false)` paged → 262 (a second, id-only count
agreed). Research on the same day had seen 251. The difference is 12 `Untitled eng work` Backlog issues
(SWC-468..SWC-479) created 2026-09-25 06:52–13:52Z by another workflow; the proof issue SWC-467 is
Done, not archived, and still counts. Arithmetic: a create needs ≤ 249, so max(0, 262 − 249) = 13.

The owner-decision-2 pool (02-LINEAR-ARCHIVED.md) had 16 eligible issues (all 16 rule matches passed
`graph_find` found:false for id and identifier). The 13 oldest by `updatedAt` were archived, each
re-read and re-checked against the whole rule immediately before `issueArchive`; none was skipped.
Rows and archive log are in `../02-claims-and-dispatch/02-LINEAR-ARCHIVED.md` § Phase 3.

active_before=262
archives_needed=13
archived_count=13
active_after=249

After the create the count is 250, which is the Free-plan limit: one more `issueCreate` in the
workspace fails until something is archived.

### Proof issue, Notion rows, graph

```
team_id=5371e279-c76c-4e84-b8df-254bf5fbfc27 team_key=SWC todo_state_id=0ec71412-0874-4c48-848f-4992ebb3ccf8
active_pre_create=249
issue_created_at=2026-09-25T22:56:51+00:00 success=True
linear_url=https://linear.app/spectrumwebco/issue/SWC-480/substrate-03-proof-throwaway-dispatchclaude-code-proof
linear_state=Todo (unstarted)
notion_task_http=200
notion_issue_http=200
notion_task_id=3e6bc1a0-c7ae-810b-ae3e-fd30bd081730
notion_issue_id=3e6bc1a0-c7ae-81e4-89bf-cedb264de470
issue_row_readback={"Item": "[n1] substrate 03 proof — throwaway", "Level": "Issue", "Graph ID": "ut-muhk8v3p-47ae5f1a", "Issue ID": "SWC-480", "Linear URL": "https://linear.app/spectrumwebco/issue/SWC-480/substrate-03-proof-throwaway-dispatchclaude-code-proof"}
graph_register → graph_id ut-muhk8v3p-47ae5f1a, notion_task_page <Task row URL>, repo swcstudiospace/agent-substrate, branch main, status Implementing
graph_get → notion_task_page=<Task row URL>, n1 linear_issue_id=805e6153-81ff-4049-87eb-6b2307f15fff, linear_identifier=SWC-480, notion_page=<Issue row URL>, claimed_by=None, state=unstarted
dispatch_label_source=created (team)
issue_labels_now=(none) state_now=Todo
active_after_create=250
```

Issue title: `[substrate 03 proof] throwaway — dispatch:claude-code proof`. Description, as sent:
"Throwaway task for the Phase 3 Lane A proof (graph ut-muhk8v3p-47ae5f1a). Append this line to the end
of README.md: `Lane A proof: written by a dispatched Claude Code session in an agentOS VM (graph
ut-muhk8v3p-47ae5f1a).` Run `bun test packages/mcp-server/src/redact.test.ts` and say whether it
passed. Commit, push and open a pull request titled `Lane A proof ut-muhk8v3p-47ae5f1a`. Make no other
change."

The graph stores both Notion rows as their page URLs (the Task row URL is the kickoff state file's
`taskUrl`); the dashed page ids are listed above. `linear_issue_id` below was read back from
`graph_get` nodes[n1] — later checks read it from there.

issue_source=created
graph_id=ut-muhk8v3p-47ae5f1a
linear_issue_id=805e6153-81ff-4049-87eb-6b2307f15fff
linear_identifier=SWC-480
notion_task_page=https://app.notion.com/p/substrate-03-proof-throwaway-3e6bc1a0c7ae810bae3efd30bd081730
notion_issue_page=https://app.notion.com/p/n1-substrate-03-proof-throwaway-3e6bc1a0c7ae81e489bfcedb264de470
pr_fields_before={"PR URL":null,"PR #":null,"PR State":null,"Repo":"","Branch":""}
proof_repo=swcstudiospace/agent-substrate
dispatch_label_id=3dee3876-a40c-457a-9db4-6dccee01b9a1

### D-10 kickoff

03-01-SPIKE.md records `tracker_route=host`, so this plan created the Task row with Status
Implementing on the session's behalf (the recorded D-10 deviation). The read-back after creation:

tracker_route=host
kickoff_by=host
notion_task_status_before=Implementing

## Gaps
