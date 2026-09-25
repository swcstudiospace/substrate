---
phase: 02-claims-and-dispatch
plan: 03
subsystem: api
tags: [hermes-linear-connector, fastapi, linear, definition-of-done, sync-engine]

requires: []
provides:
  - "SyncEngine._done_allowed(dod_pass, meta): shared require_dod_for_done predicate, used by apply_kanban_status and complete_issue"
  - "SyncEngine.complete_issue(linear_issue_id, summary, tests_pass, review_pass) -> CompleteIssueResult(completed, reason)"
  - "POST /v1/complete-issue on hermes-linear-api 127.0.0.1:8792: {linear_issue_id, summary, tests_pass, review_pass} -> {completed, reason, linear_issue_id}; 502 on engine error, 422 on missing linear_issue_id"
affects: [02-05 DodGate, substrate-mcp completion, D-06]

actuals:
  tokens: 2793
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "One Done predicate (_done_allowed) shared by the Kanban projection and the substrate completion route; the gate stays in the connector"
    - "Refused completion makes no Linear call (no breadcrumb comment); the caller records the reason"

key-files:
  created:
    - /root/src/repos/hermes-linear-connector/tests/unit/test_webhook_app.py
    - .planning/phases/02-claims-and-dispatch/02-03-BASELINE.md
  modified:
    - /root/src/repos/hermes-linear-connector/src/hermes_linear_connector/sync_engine.py
    - /root/src/repos/hermes-linear-connector/src/hermes_linear_connector/webhook_app.py
    - /root/src/repos/hermes-linear-connector/tests/unit/test_sync_engine.py

key-decisions:
  - "Refusal reason is a module constant DOD_REFUSED_REASON so route and engine return the same string"
  - "Route maps any engine exception to 502 (plan-specified); existing routes untouched"

patterns-established:
  - "Route tests: monkeypatch webhook_app.build_engine to a fake-backed SyncEngine and drive create_app() with TestClient inside `with` so the lifespan runs"

requirements-completed: []

coverage:
  - id: D1
    description: "SyncEngine.complete_issue moves a Linear issue to Done only via _done_allowed under require_dod_for_done; refusals make no Linear write or comment and never touch Kanban"
    verification:
      - kind: unit
        ref: "tests/unit/test_sync_engine.py#test_complete_issue_* (7 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "apply_kanban_status behaviour unchanged after extracting _done_allowed"
    verification:
      - kind: unit
        ref: "tests/unit/test_sync_engine.py#test_apply_kanban_done_updates_linear, test_apply_kanban_done_refused_without_dod, test_mark_dod_then_done"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST /v1/complete-issue route (refuse 200/completed false, allow 200/completed true + one update, 502 on Linear error, 422 on missing id)"
    verification:
      - kind: unit
        ref: "tests/unit/test_webhook_app.py (4 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live hermes-linear-api serves the route and refuses without evidence"
    verification:
      - kind: integration
        ref: "curl -X POST 127.0.0.1:8792/v1/complete-issue {linear_issue_id: 00000000-0000-0000-0000-000000000000, summary: '', tests_pass: false} -> gate-ok"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 03: Connector complete-issue route Summary

**`POST /v1/complete-issue` on hermes-linear-api moves a substrate-completed Linear issue to Done only through the connector's own `_done_allowed` predicate, the same one `apply_kanban_status` now calls.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-09-25T01:10:46Z
- **Completed:** 2026-09-25T01:12:55Z
- **Tasks:** 2
- **Files modified:** 5 (4 connector, 1 planning)

## Accomplishments
- Extracted the gate decision into `SyncEngine._done_allowed(dod_pass, meta)`; `apply_kanban_status` calls it and nothing else changed there. The breadcrumb comment is still in place.
- Added `SyncEngine.complete_issue` and `CompleteIssueResult`. Evidence follows the poller's convention: `tests_pass` must be true and `summary.strip()` must be non-empty. A linked Kanban task whose metadata has `dod_pass` also allows completion. A refusal returns `completed=False` with reason `dod not passed: ...` and makes no Linear call. Kanban, `ensure_task` and `mark_dod_pass` are never called.
- Added `CompleteIssueBody` and `POST /v1/complete-issue`. The route returns `{completed, reason, linear_issue_id}`, maps an engine exception to 502, and a missing `linear_issue_id` gives 422.
- Restarted hermes-linear-api at **2026-09-25T01:12:21Z**. It came back `active` and `/health` returned `{"ok":true}`. hermes-linear-poller was not restarted.
- Live non-mutating smoke response: `{'completed': False, 'reason': 'dod not passed: tests_pass true and a non-empty summary are required', 'linear_issue_id': '00000000-0000-0000-0000-000000000000'}` then `gate-ok`.

## Baseline (two-sided, 02-03-BASELINE.md)

| | Before (dc2d74d, master) | After (6e532fe, master) |
|---|---|---|
| passed | 49 | 60 |
| failed | 0 | 0 |
| skipped | 2 | 2 |
| failing-id set | empty | empty (diff clean) |

## Task Commits

1. **Task 1: SyncEngine.complete_issue reusing the require_dod_for_done predicate**
   - hermes-linear-connector `2459925` (feat)
   - agent-substrate `eed43c4` (docs: 02-03-BASELINE.md)
2. **Task 2: POST /v1/complete-issue route, restart, live smoke**
   - hermes-linear-connector `6e532fe` (feat)

## Files Created/Modified
- `hermes-linear-connector/src/hermes_linear_connector/sync_engine.py`: adds `CompleteIssueResult`, `DOD_REFUSED_REASON`, `_done_allowed` and `complete_issue`.
- `hermes-linear-connector/src/hermes_linear_connector/webhook_app.py`: adds `CompleteIssueBody` and the `/v1/complete-issue` route, and updates the module docstring.
- `hermes-linear-connector/tests/unit/test_sync_engine.py`: adds 7 `complete_issue` behaviour cases.
- `hermes-linear-connector/tests/unit/test_webhook_app.py`: 4 route cases using TestClient and a monkeypatched `build_engine`.
- `.planning/phases/02-claims-and-dispatch/02-03-BASELINE.md`: the connector baseline, measured before the first edit.

## Decisions Made
- The refusal string lives in one constant, `DOD_REFUSED_REASON`, so the engine and the route cannot drift apart.
- Otherwise the plan was followed as specified.

## Deviations from Plan

None. The plan was executed exactly as written.

## Issues Encountered
None. The connector repo's unrelated untracked files (`.substrate/`, `AGENTS.md`, `docs/PHASE1_PROGRESS.md`) were left unstaged.

## User Setup Required
None. No external service configuration is required.

## Next Phase Readiness
- The 02-05 DodGate can call `POST http://127.0.0.1:8792/v1/complete-issue`, and the contract is live.
- The route is unauthenticated and loopback-only, which is the same exposure as `/v1/mark-dod` (T-02-03-02, accepted).

---
*Phase: 02-claims-and-dispatch*
*Completed: 2026-09-25*

## Self-Check: PASSED
- Task 1 verify was re-run: BASELINE has `connector-pass=`, both methods exist, and `test_sync_engine.py` gives 13 passed. The 3 original `apply_kanban_status` tests pass.
- Task 2 verify was re-run: the failing-id diff is clean, the suite has 60 passed (more than 49), `test_webhook_app.py` gives 4 passed, `systemctl is-active` prints `active`, and the smoke printed `gate-ok`.
