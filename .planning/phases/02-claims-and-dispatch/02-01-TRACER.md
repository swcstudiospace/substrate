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
