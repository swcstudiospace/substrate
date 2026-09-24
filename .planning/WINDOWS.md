---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 0
total_count: 2
last_updated: 2026-09-24T11:06:19.220Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | unrun-verify | packages/collectors/src/herdr.ts |  | herdr-server-restart reconnect behavior not exercised live: herdr's server runs as a bare process (not a systemd unit), shared with live human terminal sessions on this VPS, so it was not restarted to force a reconnect test. Collector's own restart was verified clean instead. | open |  | 2026-09-24T11:06:19.041Z |  |
| 2 | 01 | unrun-verify | packages/collectors/src/herdr-map.ts |  | Plan's <human-check> (drive a real herdr pane, confirm an agent-status event reaches the substrate within a minute) not exercised: no agent was present in the one live pane (session.snapshot returned agents: []). Verified instead with a manually-issued, wire-real POST /events carrying the pane's real repo/pane_id. | open |  | 2026-09-24T11:06:19.220Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "01",
    "file": "packages/collectors/src/herdr.ts",
    "line": null,
    "description": "herdr-server-restart reconnect behavior not exercised live: herdr's server runs as a bare process (not a systemd unit), shared with live human terminal sessions on this VPS, so it was not restarted to force a reconnect test. Collector's own restart was verified clean instead.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-24T11:06:19.041Z",
    "resolved_at": null,
    "milestone": "v1.0"
  },
  {
    "id": 2,
    "kind": "unrun-verify",
    "phase": "01",
    "file": "packages/collectors/src/herdr-map.ts",
    "line": null,
    "description": "Plan's <human-check> (drive a real herdr pane, confirm an agent-status event reaches the substrate within a minute) not exercised: no agent was present in the one live pane (session.snapshot returned agents: []). Verified instead with a manually-issued, wire-real POST /events carrying the pane's real repo/pane_id.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-24T11:06:19.220Z",
    "resolved_at": null,
    "milestone": "v1.0"
  }
]
````
