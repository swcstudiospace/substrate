# 02-NOTION-SCHEMA — 🧩 Agent Task Graph (observed, read-only)

Observed 2026-09-25T04:34Z by plan 02-02 Task 2. Two GET requests were made and nothing was written
to Notion. No PATCH or POST was sent.

notion_skipped=false

## How it was read

- The key came from `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-02-notion-schema.py`.
  systemd passed `NOTION_API_KEY` to that one process. The script printed only names, types, options and
  row values. It did not print headers, the token, or bot/owner fields. The script was deleted afterwards.
- Headers: `Notion-Version: 2025-09-03`, `Authorization: Bearer $NOTION_API_KEY`.
- The credential is a Notion **personal access token (PAT)**, not an internal integration. It acts as the
  owner's user. The owner accepted this on 2026-09-25; see 02-02-SUMMARY.md, T-02-02-02.
- Data source: `be3418f0-d2d8-411b-8677-fa8a95ee63be`. substrate.env sets `NOTION_TASK_GRAPH_DS`, and its
  value is the same as the config.ts default. Title `Agent Task Graph`. Parent database `843bc6ab-56b0-4b27-ae10-e258711edcb0`.
  The data source has 38 properties.
- Sample Issue row: node `n1` (`SPE-119`) of backfilled graph `ut-mucem4mc-ec70360f`. Its
  `notion_page` from MCP `graph_get` on `:7410/mcp` is `https://app.notion.com/3e3bc1a0c7ae814cbd4df349c98fb47e`.
  The page's parent is `data_source_id` `be3418f0-d2d8-411b-8677-fa8a95ee63be`.

data_source_http=200
page_read_http=200

## Properties substrate reads or writes (Issue-row mirror, proof row creation)

Title property: `Item` (type `title`). It is the only title property. Issue rows use `[nN] Title`.

Agent: rich_text
Status: status
  options: Merged, Resolved, Done, Won't Fix, Closed, Failed, Planning, Implementing, In Review, Changes Requested, Blocked, Running, Backlog, Queued, Open, Pending
  groups: To-do = Backlog, Queued, Open, Pending · In progress = Planning, Implementing, In Review, Changes Requested, Blocked, Running · Complete = Merged, Resolved, Done, Won't Fix, Closed, Failed
Linear State: select
  options: Backlog, Todo, In Progress, In Review, Done, Canceled
Completed: date
Level: select
  options: Task, Issue, Sub-Issue
Item: title
Graph ID: rich_text
Issue ID: rich_text
Linear URL: url

Notes for 02-06 and 02-08:

- `Status` is a `status` property, so writes use `{"status": {"name": "..."}}`. The option `Done`
  exists, and so do `Implementing` and `In Review`.
- `Linear State` is a `select`. `Todo`, `In Progress`, `In Review` and `Done` all exist, so writes use `{"select": {"name": "..."}}`.
- `Agent` is `rich_text`, not a select, so any surface string is accepted. Writes use `{"rich_text": [{"text": {"content": "<surface>"}}]}`.
- `Completed` is a `date`. Writes use `{"date": {"start": "<ISO 8601>"}}`.
- For a new Issue row, POST `/v1/pages` with `parent: {"type": "data_source_id", "data_source_id": "be3418f0-d2d8-411b-8677-fa8a95ee63be"}`. Set
  `Level` = select `Issue`, `Item` = title `[n1] …`, `Graph ID` / `Issue ID` = rich_text, and `Linear URL` = url.

How the sample row stores its values now, from `GET /v1/pages/3e3bc1a0c7ae814cbd4df349c98fb47e`:

| Property | Type | Value |
|---|---|---|
| Item | title | `[n1] Understand current pipeline and reproduce the bug` |
| Level | select | `Issue` |
| Graph ID | rich_text | `ut-mucem4mc-ec70360f` |
| Issue ID | rich_text | `SPE-119` |
| Linear URL | url | `https://linear.app/swcstudio/issue/SPE-119/understand-current-pipeline-and-reproduce-the-bug` |
| Linear State | select | null (unset) |
| Status | status | null (unset) |
| Agent | rich_text | empty (no rich_text runs) |
| Completed | date | null (unset) |

`Agent` is empty on this backfilled Issue row. Issue rows have no Agent value until substrate writes one.

## PR-owned properties — ultrathink-sync's (D-07), never written by substrate

They are recorded here only so that later plans can prove substrate never writes them.

PR URL: url
PR #: number
PR State: select
  options: Not opened, Draft, Open, In Review, Approved, Changes Requested, Merged, Closed
Repo: rich_text
Branch: rich_text

These are all unset or empty on the sample row: PR URL null, PR # null, PR State null, Repo empty, Branch empty.

## Other properties on the data source (for reference, not used by substrate)

Additions: number · Checks: select (Pending, Passing, Failing, Blocked) · Claude Session: url ·
Confidence: select (High, Medium, Low) · Created: created_time · Deletions: number · Description: rich_text ·
Duration (s): number · Files Touched: rich_text · Issue Type: select (Bug, Feature, Refactor, Test, Docs, Chore,
Investigation) · Model: select (Opus, Sonnet, Haiku, Other) · Parent Item: relation · Priority: select (P0, P1,
P2, P3) · Result: rich_text · Reviewers: people · Severity: select (Critical, High, Medium, Low) · Spec Path:
rich_text · Started: date · Step: number · Sub-Items: relation · Thought: rich_text · Tokens: number ·
Tool: rich_text · Uplifted Prompt: rich_text
