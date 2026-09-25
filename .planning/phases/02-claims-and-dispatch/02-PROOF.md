# Phase 2 proof — label `dispatch:hermes` on a real issue (02-08)

Recorded 2026-09-25 by plan 02-08. This file records observed output only. Model actions are
quoted from the Hermes session export; operator actions are labelled as operator actions; anything
that did not happen or did not match is listed under Gaps.

## Setup

### Preconditions (2026-09-25T04:53:02Z, read-only)

- `grep -c '^notion_skipped=' 02-NOTION-SCHEMA.md` → `1` (the line is `notion_skipped=false`).
- `sudo grep -c '^NOTION_API_KEY=' /etc/substrate/substrate.env` → `1`.
- `systemctl is-active substrate-dispatcher substrate-mcp hermes-linear-api` → `active` ×3.
- `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=1$' /etc/substrate/substrate.env` → `1`
  (`^SUBSTRATE_DISPATCH_DISABLED=` → `1`, so the file had exactly one switch line).
- substrate-dispatcher: `MainPID=1062615`, `NRestarts=0`, `ActiveEnterTimestamp=Fri 2026-09-25 02:27:55 UTC`.
  Its last journal lines were `[substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`
  every 30 s (04:50:55 … 04:52:55).

D-13 snapshot of the main checkout, taken at 04:53:08Z before anything was created
(`git status --porcelain`):

```
 M .planning/config.json
 M .planning/state.json
?? issues/
```

`git worktree list` at the same time:

```
/root/src/repos/agent-substrate                    4a984f2 [main]
/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad  99837b1 [substrate/ut-mugbqivi-752f2dad]
```

D-12: `df -BG --output=avail / | tail -n 1 | tr -dc '0-9'` → `29`.

### Issue, Notion Issue row, graph and label (04:54:12Z – 04:54:16Z)

Command (no key in it; systemd hands `LINEAR_API_KEY`, `NOTION_API_KEY` and `NOTION_TASK_GRAPH_DS`
to that one process; the script printed key=value lines only and was deleted afterwards):

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-setup.py
```

Output, verbatim (exit 0), indented four spaces so only the summary lines below start at column 0:

    pre_flip_dispatch_candidates=[]
    team_source=only_visible_team
    team_id=5371e279-c76c-4e84-b8df-254bf5fbfc27
    team_key=SWC
    visible_teams=1
    todo_state_id=0ec71412-0874-4c48-848f-4992ebb3ccf8
    todo_state_type=unstarted
    graph_id=ut-mughkkc0-73909228
    issue_create_success=True
    issue_id=3378743f-efc9-47f2-9962-3894dca6bb80
    issue_identifier=SWC-467
    issue_url=https://linear.app/spectrumwebco/issue/SWC-467/substrate-02-proof-throwaway-dispatchhermes-proof
    issue_created_at=2026-09-25T04:54:12.159Z
    issue_state=Todo (unstarted)
    notion_ds=be3418f0-d2d8-411b-8677-fa8a95ee63be
    notion_create_http=200
    notion_page_id=3e6bc1a0-c7ae-8102-8a05-f31661fbc812
    notion_page_url=https://app.notion.com/p/n1-substrate-02-proof-throwaway-3e6bc1a0c7ae81028a05f31661fbc812
    notion_parent={"type": "data_source_id", "data_source_id": "be3418f0-d2d8-411b-8677-fa8a95ee63be", "database_id": "843bc6ab-56b0-4b27-ae10-e258711edcb0"}
    notion_get_http=200
    notion_row_before={"Item": "[n1] substrate 02 proof \u2014 throwaway", "Level": "Issue", "Graph ID": "ut-mughkkc0-73909228", "Issue ID": "SWC-467", "Linear URL": "https://linear.app/spectrumwebco/issue/SWC-467/substrate-02-proof-throwaway-dispatchhermes-proof", "Agent": "", "Status": null, "Linear State": null, "Completed": null}
    pr_fields_before={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}
    t_notion_row=2026-09-25T04:54:13.506Z
    graph_register_response={ "graph_id": "ut-mughkkc0-73909228", "notion_task_page": null, "repo": "swcstudiospace/agent-substrate", "branch": "main", "surface": null, "status": "Implementing", "pr_url": null, "created": "2026-09-25T04:54:13.786Z", "updated": "2026-09-25T04:54:13.786Z", "nodes": [ { "graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null } ], "steps": [] }
    graph_get_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    graph_get_status=Implementing
    linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    dispatch_label_id=71fc5665-11f1-41b6-934a-6e4532fb0da5
    dispatch_label_source=reused_team_label
    issue_check={"identifier": "SWC-467", "state": {"name": "Todo", "type": "unstarted"}, "labels": []}
    issue_comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    setup_done_at=2026-09-25T04:54:16.000Z

- The team was resolved at run time as the only visible team (D-16); no identifier prefix was typed.
- `graph_register` was sent as `{graph_id, repo: "swcstudiospace/agent-substrate", branch: "main", status: "Implementing", nodes: [{node_id: "n1", linear_issue_id, linear_identifier, notion_page, state: "unstarted"}]}`.
  Every later Linear check uses `linear_issue_id` from `graph_get`'s `nodes[n1]`.
- The Notion row was created under the Agent Task Graph data source with Item, Level `Issue`, Graph ID,
  Issue ID and Linear URL only.
- `dispatch:hermes` already existed as an SWC team label (created by 02-09) and was reused. It was not applied here.
- The dispatcher's own filter (unstarted + `dispatch:*`) matched no issue before the flip, so turning
  the switch on could not launch anything but the proof issue (T-02-08-02).
- Linear capacity: this is the one issue this plan creates. Its GitHub twin, from the workspace's
  Linear↔GitHub sync comment, is swcstudiospace/agent_runtime#327. Nothing was done on GitHub.

graph_id=ut-mughkkc0-73909228
linear_issue_id=3378743f-efc9-47f2-9962-3894dca6bb80
linear_identifier=SWC-467
notion_page=3e6bc1a0-c7ae-8102-8a05-f31661fbc812
dispatch_label_id=71fc5665-11f1-41b6-934a-6e4532fb0da5
free_disk_gb_before=29
main_branch_before=main
pr_fields_before={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}

### Tracer prediction (consumed before the switch is flipped)

Copied from 02-09-TRACER.md (`projected_within_60s=false`, `delta_launch_to_claim_s=48`):

tracer_projected_within_60s=false
tracer_delta_launch_to_claim_s=48

Prediction: 02-09 measured launch → claim at 48 s, so with the 30 s poll the 60 s proof budget is expected to be missed; the proof runs unchanged (D-10 and the proof wording are locked) and Gaps compares the outcome with this prediction.

### D-15 switch flipped (no restart)

Operator action, appending one line (the file was neither read out nor rewritten):

```
echo 'SUBSTRATE_DISPATCH_DISABLED=0' | sudo tee -a /etc/substrate/substrate.env > /dev/null
```

- Returned at 2026-09-25T04:54:52Z.
- `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=0$'` → `1`; `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED='` → `2`
  (the 02-07 `=1` line at line 18, the appended `=0` line at line 21; the last line wins).
- The unit was not restarted (`MainPID` still 1062615). First journal tick after the flip:

```
2026-09-25T04:54:56+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

switch_flipped_at=2026-09-25T04:54:52Z
