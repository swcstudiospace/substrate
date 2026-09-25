# 02-01 live tracer evidence

Recorded from observed output only.

## Attempt 1 — 2026-09-25 (UTC), blocked before any graph or claim

- substrate-mcp restarted after the Task 1 code landed: `systemctl is-active` → `active`,
  `/healthz` → `{"index":true,"greptime":true}`.
- Journal after the Task 2 restart: `[substrate] mirror: linear on`.
- Tracer setup (`sudo systemd-run ... -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-01-tracer-setup.py`)
  stopped at `issueCreate`. Linear answered, verbatim:

```
linear errors: [{"message": "usage limit exceeded", "path": ["issueCreate"], ... "extensions": {"type": "usage limit exceeded", "code": "USAGE_LIMIT_EXCEEDED", "statusCode": 400, "userError": true, "userPresentableMessage": "You've exceeded the free issue limit for this workspace. Please upgrade or contact sales@linear.app for a free trial.", "meta": {"usageMetric": "activeIssueCount"}}}]
```

- Read-only probe: organization `spectrumwebco`, one team `SWC` with `issueCount` 275.
- No issue was created, no graph was registered, and no claim was made, so there is no
  `graph_id=` / `linear_issue_id=` line yet.

Live checks that did run (no Linear write):

- `graph_find {"linear_identifier":"SWC-999999"}` → `{"found": false, "reason": "no registered node for SWC-999999"}`
- `graph_find {}` → `{"found": false, "reason": "provide linear_issue_id or linear_identifier"}`

## Attempt 2 — 2026-09-25T01:33Z, archive route evaluated, still blocked

The owner allowed archiving old completed and canceled issues, with a cap of 10. Observed usage: 275
non-archived issues. Linear's Free-plan limit is 250 (from the docs, not exposed by the API), so
26 archives are needed. Only 3 issues are eligible under the archive rules. No archive was made
and no issueCreate was retried, because the arithmetic shows it would fail. Full evidence:
02-LINEAR-ARCHIVED.md.

## Attempt 3 — 2026-09-25T01:53Z, tracer run (after the owner archived 28 issues, commit 1299b02)

Ran once: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-01-tracer-setup.py`.
It created exactly one issue, titled `[substrate-tracer] 02-01 claim mirror`, in the Todo state.

graph_id=ut-mugb3vwa-c57eb6ac
linear_issue_id=6dff6e82-7b59-44c6-ab7f-50e53fedd96c
linear_identifier=SWC-465
session_id=02-01-tracer-20260925T015316Z
identifier_lookup=resolves

- created_at=2026-09-25T01:53:15Z, team_key=SWC. `graph_register` returned the graph (`register_ok=true`).
- `identifier_lookup=resolves`: Linear's `issue(id: "SWC-465")` returned the same UUID. This confirms
  research's [ASSUMED] identifier fallback.
- `graph_claim` { n1, surface claude-code } at 2026-09-25T01:53:20Z. Response, verbatim:

```
{"claimed":true,"node":{"graph_id":"ut-mugb3vwa-c57eb6ac","node_id":"n1","linear_issue_id":"6dff6e82-7b59-44c6-ab7f-50e53fedd96c","linear_identifier":"SWC-465","notion_page":null,"state":"unstarted","claimed_by":"claude-code","claimed_at":"2026-09-25T01:53:17.600Z","claim_session":"02-01-tracer-20260925T015316Z"}}
```

  (`state` in the response is the pre-claim value returned by the index `update … returning *`.
  The `started` write comes after it. The loser response and graph_find below both show `started`.)

Observed on Linear at 2026-09-25T01:53:20Z:

observed_state=In Progress (started)
observed_labels=agent:claude-code

- Comments:
  - `2026-09-25T01:53:16.796Z This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/325). All replies are displayed in both locations.`
    This comes from the workspace's Linear↔GitHub issue sync, not from substrate. Every new SWC issue
    gets mirrored to `swcstudiospace/agent_runtime`.
  - `2026-09-25T01:53:20.431Z Claimed by claude-code — session 02-01-tracer-20260925T015316Z (graph ut-mugb3vwa-c57eb6ac, node n1)`

## Task 2 live loser check — 2026-09-25T01:53Z

`/tmp/02-01-loser.py` ran under the same systemd-run pattern. It called `graph_claim` { n1, surface omp,
session 02-01-loser }:

```
before_updatedAt=2026-09-25T01:53:20.091Z
before_comments=2
loser_response={"claimed":false,"node":{"graph_id":"ut-mugb3vwa-c57eb6ac","node_id":"n1","linear_issue_id":"6dff6e82-7b59-44c6-ab7f-50e53fedd96c","linear_identifier":"SWC-465","notion_page":null,"state":"started","claimed_by":"claude-code","claimed_at":"2026-09-25T01:53:17.600Z","claim_session":"02-01-tracer-20260925T015316Z"}}
after_updatedAt=2026-09-25T01:53:20.091Z
after_comments=2
```

loser_claimed=false
loser_claimed_by=claude-code
loser_linear_unchanged=true

Journal after the restart (`journalctl -u substrate-mcp`):

```
Sep 25 01:53:42 vps substrate-mcp[971248]: [substrate] listening on http://127.0.0.1:7410 (index + greptime, anonymous)
Sep 25 01:53:42 vps substrate-mcp[971248]: [substrate] mirror: linear on
```

`/healthz` after the restart: `{"index":true,"greptime":true}`, and the unit is `active`.

## Task 3 live graph_find — 2026-09-25T01:53Z

`graph_find {"linear_issue_id":"6dff6e82-7b59-44c6-ab7f-50e53fedd96c"}` (node trimmed to four fields):

```
{"found":true,"graph_id":"ut-mugb3vwa-c57eb6ac","node_id":"n1","repo":"swcstudiospace/agent-substrate","branch":"main","graph_status":"Implementing","node":{"node_id":"n1","state":"started","claimed_by":"claude-code","claim_session":"02-01-tracer-20260925T015316Z"}}
```

`graph_find {"linear_identifier":"SWC-465"}` → `found: True`, graph `ut-mugb3vwa-c57eb6ac`.

find_found=true

## Linear capacity after the tracer

Read-only count at 2026-09-25T01:53:53Z: `active_issues=248`, against the documented Free-plan limit of 250.
That leaves 2 slots for 02-09 and 02-08.
