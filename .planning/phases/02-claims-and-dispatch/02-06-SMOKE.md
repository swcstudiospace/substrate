# 02-06 live smoke: Agent set on claim and cleared on release on a real Notion Issue row

Everything here was recorded from observed output only.

02-NOTION-SCHEMA.md has `notion_skipped=false`, and `sudo grep -c '^NOTION_API_KEY=' /etc/substrate/substrate.env`
printed `1`, so this is the key branch.

notion_skipped=false

## Restart

- Full-suite gate first, at `0060c22`: `bun test` 154 pass / 0 fail, no failing ids, normalized tsc `tsc-exit=0`.
- `sudo systemctl restart substrate-mcp` at 2026-09-25T04:47:00Z. `ActiveEnterTimestamp` is `Fri 2026-09-25 04:47:00 UTC`.
  `systemctl is-active` printed `active`, and `/healthz` returned `{"index":true,"greptime":true}`.
- Journal since the restart:

```
Sep 25 04:47:03 vps substrate-mcp[1329376]: [substrate] listening on http://127.0.0.1:7410 (index + greptime, anonymous)
Sep 25 04:47:03 vps substrate-mcp[1329376]: [substrate] mirror: linear on, notion on
```

- substrate-dispatcher stayed `active` with its kill switch on, so its ticks made no MCP call during the restart.

## Target

The smoke uses an **existing** index row, as the orchestrator required: node `n1` of the Phase 1 proof graph
`ut-mufsocbe-c7ced745`. It has no Linear reference, so the Linear step warns
`node has no Linear issue reference` as the plan expects. No graph was registered, and no Linear issue was created or touched.

Before (graph_get at 04:46:55Z): graph `status=unstarted`, `surface=grok-bot`, `updated=2026-09-24T17:17:18.092Z`.
n1 had `linear_issue_id=null`, `linear_identifier=null`, `notion_page=null`, `state=unstarted` and was unclaimed.
n2 was claimed by hermes, session `20260924_182534_fe7fa2`. n2 was not touched.

Run: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-06-notion-smoke.py`.
systemd passed the keys to that one process. The script printed no environment and no headers, and it was deleted afterwards.
MCP calls went to `POST 127.0.0.1:7410/mcp`, and Notion calls went to `api.notion.com` with `Notion-Version: 2025-09-03`.

graph_id=ut-mufsocbe-c7ced745
node_id=n1
session_id=02-06-smoke-20260925T044803Z
page_id=3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8
page_url=https://app.notion.com/p/n1-substrate-02-06-notion-smoke-throwaway-3e6bc1a0c7ae81dc9dabe14a6e992fd8

## 1. Throwaway Issue row (04:48:04Z)

`POST /v1/pages` with `parent {type: data_source_id, data_source_id: be3418f0-d2d8-411b-8677-fa8a95ee63be}`, then
`Item` title `[n1] substrate 02-06 notion smoke — throwaway`, `Level` select `Issue` and `Graph ID` rich_text `ut-mufsocbe-c7ced745`.
The call returned `200`. The parent is `{"type": "data_source_id", "data_source_id": "be3418f0-d2d8-411b-8677-fa8a95ee63be", "database_id": "843bc6ab-56b0-4b27-ae10-e258711edcb0"}`.

GET at 04:48:04.890Z: `{"Agent": "", "Linear State": null, "Status": null, "Completed": null}`.
The PR fields were `{"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}`.

## 2. graph_register — point n1 at the row (04:48:06Z)

`{"graph_id": "ut-mufsocbe-c7ced745", "nodes": [{"node_id": "n1", "notion_page": "3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8"}]}`
returned n1 with that `notion_page`, `state unstarted` and unclaimed. The graph kept `status unstarted` and `surface grok-bot`.

## 3. graph_claim as claude-code (04:48:09Z)

```
{"claimed": true, "node": {"graph_id": "ut-mufsocbe-c7ced745", "node_id": "n1", "linear_issue_id": null, "linear_identifier": null, "notion_page": "3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8", "state": "unstarted", "claimed_by": "claude-code", "claimed_at": "2026-09-25T04:48:06.945Z", "claim_session": "02-06-smoke-20260925T044803Z"}}
```

GET at **2026-09-25T04:48:10.010Z**: `{"Agent": "claude-code", "Linear State": null, "Status": null, "Completed": null}`.
The Linear step failed because this node has no Linear issue, so `Linear State` was correctly left unwritten.

claim_agent=claude-code

## 4. graph_release, same surface and session (04:48:13Z)

```
{"released": true, "node": {"graph_id": "ut-mufsocbe-c7ced745", "node_id": "n1", "linear_issue_id": null, "linear_identifier": null, "notion_page": "3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}}
```

GET at **2026-09-25T04:48:13.898Z**: `{"Agent": "", "Linear State": null, "Status": null, "Completed": null}`. Agent is cleared (D-05).

release_agent=

After the release, the PR fields were `{"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}`, the same as before (D-07).

pr_fields_unchanged=true

## 5. Trash the row (04:48:15Z)

First a GET re-checked that the page was the one created above and that its parent was the task-graph data source.
Then `PATCH /v1/pages/3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8 {"in_trash": true}` returned `200`. A final GET showed `in_trash=True archived=True`.

row_trashed=true

The plan's closing `graph_register {graph_id, status: "Done"}` was **not** sent. The graph is the existing Phase 1 proof graph, not
a graph this plan registered, so its `status unstarted` was left as it was. See the SUMMARY deviations.

## 6. Event log and chain

Greptime `agent_events` for graph `ut-mufsocbe-c7ced745` and session `02-06-smoke-20260925T044803Z`:

```
ts=1790311688081 kind=claim   surface=claude-code summary="claimed node" payload={}
ts=1790311689544 kind=warning surface=claude-code summary="claim mirror to linear failed for n1: node has no Linear issue reference" payload={"target":"linear","action":"claim","reason":"node has no Linear issue reference"}
ts=1790311691255 kind=release surface=claude-code summary="released n1" payload={}
ts=1790311692869 kind=warning surface=claude-code summary="release mirror to linear failed for n1: node has no Linear issue reference" payload={"target":"linear","action":"release","reason":"node has no Linear issue reference"}
```

There were two expected Linear warnings and no Notion warning. `POST /verify {"graph_id":"ut-mufsocbe-c7ced745"}` returned `{"ok":true,"events":7}`:
the Phase 1 events plus these four. After the smoke, `/healthz` returned `{"index":true,"greptime":true}`.

## Rows touched (for 02-08 and a cleanup)

| Store | Row | Before | After |
|---|---|---|---|
| Notion Agent Task Graph | page `3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8` (created by this smoke) | did not exist | in trash (`in_trash=true`). Agent was set to `claude-code`, then cleared. No PR field was written |
| index `graph_nodes` | `ut-mufsocbe-c7ced745` / `n1` | `notion_page=null`, `unstarted`, unclaimed | `notion_page=3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8` (**residual**), `unstarted`, unclaimed |
| index `graph_index` | `ut-mufsocbe-c7ced745` | `status=unstarted`, `surface=grok-bot`, `updated=2026-09-24T17:17:18.092Z` | `status=unstarted`, `surface=grok-bot`, `updated=2026-09-25T04:48:05.188Z` |
| Greptime `agent_events` | 4 rows, session `02-06-smoke-20260925T044803Z` | — | claim, warning(linear), release, warning(linear) |
| Linear | none | — | — |

Residual: `graph_register` upserts with `coalesce`, so it cannot set n1's `notion_page` back to null. A cleanup would run
`update graph_nodes set notion_page = null where graph_id = 'ut-mufsocbe-c7ced745' and node_id = 'n1' and notion_page = '3e6bc1a0-c7ae-81dc-9dab-e14a6e992fd8'`.
Until then, a claim on n1 would reach the trashed row. `[INFERENCE]` Notion rejects property writes to a trashed page, so the result would be only a notion warning.
02-08 registers its own new graph and does not use this graph.
