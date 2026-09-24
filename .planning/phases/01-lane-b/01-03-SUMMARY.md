---
phase: 01-lane-b
plan: 03
subsystem: infra
tags: [substrate, hermes, eng-board, events_emit, httpx, redaction]
checkpoint: approved-by-owner

# Dependency graph
requires:
  - phase: 01-lane-b (01-01)
    provides: rollback safety baseline, hermes-engineering-board initial commit b60d581
  - phase: 01-lane-b (01-02)
    provides: the fail-open SubstrateClient / vendored redactor / additive-hook shape proven for hermes-plugin
provides:
  - "hermes-eng-board surface additively forwarding session.start, tool.call and session.end events to substrate-mcp"
  - "SubstrateClient (httpx-backed, injectable transport) matching the repo's own ConnectorClient convention"
  - "redactor.py vendored byte-for-byte from mcp/src/grok_hermes_connector/redactor.py"
affects: [01-09]

# Actuals (#2632)
actuals:
  tokens: 9000
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive forwarding at existing hook call sites, not a handler rewrite (same pattern as 01-02)"
    - "Fail-open guard lives at the call site (try/except around emit_event), not inside the client"
    - "SUBSTRATE_DISABLED=1 test isolation for any test that does not explicitly inject a transport"

key-files:
  created:
    - /root/src/repos/hermes-engineering-board/src/hermes_eng_board/redactor.py
    - /root/src/repos/hermes-engineering-board/src/hermes_eng_board/substrate_client.py
  modified:
    - /root/src/repos/hermes-engineering-board/src/hermes_eng_board/hooks_session.py
    - /root/src/repos/hermes-engineering-board/tests/unit/test_hooks_session.py

key-decisions:
  - "Kept work_unit_store writes and hermes-linear-connector entirely untouched, per D-01's explicit deferral of Kanban retirement"
  - "Three pre-existing hook tests patched with SUBSTRATE_DISABLED=1 (Rule 3 auto-fix) rather than left to construct a default SubstrateClient against the live, healthy 127.0.0.1:7410 on every test run"

patterns-established:
  - "Pattern: SUBSTRATE_DISABLED=1 monkeypatch for any pre-existing test that doesn't inject a transport but now exercises code with an added substrate call site — same defect class 01-02 found for hermes-plugin"

requirements-completed: [SC-2]

coverage:
  - id: D1
    description: "hermes-eng-board substrate client (SubstrateClient) built on the repo's own ConnectorClient convention, with redactor.py vendored byte-for-byte"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hermes-engineering-board test suite (82 passed, 0 failed)"
        status: pass
      - kind: other
        ref: "diff -q src/hermes_eng_board/redactor.py mcp/src/grok_hermes_connector/redactor.py"
        status: pass
    human_judgment: false
  - id: D2
    description: "handle_session_start, handle_tool_call and handle_finalize each additively forward to the substrate (session.start, tool.call, session.end) while work_unit_store and hermes-linear-connector stay untouched"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "tests/unit/test_hooks_session.py (6 new tests: emit-on-start, emit-on-tool-call+append_tool ordering, emit-on-finalize, fail-open under raising transport, no-leak-on-raise, redaction of tskey- token)"
        status: pass
      - kind: unit
        ref: "hermes-linear-connector suite (49 passed, 2 skipped) — byte-identical to 01-BASELINE.md row"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live Hermes session confirms eng-board still produces its usual work item, substrate shows session.start/tool.call/session.end attributed to hermes-eng-board, and connector behaviour is unchanged"
    requirement: "SC-2"
    verification:
      - kind: manual_procedural
        ref: "checkpoint:human-verify Task 3, resume-signal 'approved'"
        status: pass
    human_judgment: true
    rationale: "Task 3 is gate=\"blocking-human\" by design — a live, running ingest path into a production Hermes install cannot be self-certified by the executor; the owner performed the live verification and replied approved."

# Metrics
duration: ~14min
completed: 2026-09-24
status: complete
---

# Phase 01-lane-b Plan 03: Eng-board substrate forwarding Summary

**Hermes engineering-board session start, tool calls and finalize now additively emit `session.start` / `tool.call` / `session.end` events to substrate-mcp via a new httpx-backed `SubstrateClient`, with the local Kanban/Linear pipeline and the Linear connector both provably untouched, owner-approved live.**

## Performance

- **Duration:** ~14 min
- **Tasks:** 3 (2 auto + 1 blocking-human checkpoint)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `SubstrateClient` built to match `hermes-engineering-board`'s own `ConnectorClient` convention (injectable `transport`, 1.5s timeout, `close()`), POSTing to `/events` with `surface="hermes-eng-board"` using the same field names `prompt_uplift/substrate.py` already emits
- `redactor.py` vendored byte-for-byte from `mcp/src/grok_hermes_connector/redactor.py` (`diff` clean)
- `handle_session_start`, `handle_tool_call` and `handle_finalize` each additively forward to the substrate after their existing `work_unit_store` write, fail-open on `httpx.HTTPError`/`RuntimeError`, and thread the new client through the existing `finally: client.close()` path
- Owner performed live verification against the running Hermes install and replied "approved": eng-board work item still produced, all three substrate event kinds visible for the session, connector dispatch/mirroring/DoD gate unchanged

## Task Commits

Each task was committed atomically in `hermes-engineering-board` (branch `master`):

1. **Task 1: Build the eng-board substrate client on the repo's own client convention** - `cdb0c72` (feat)
2. **Task 2: Forward session start, tool calls and finalize to the substrate** - `19dd375` (feat, includes the Rule 3 test-isolation fix below)

**Task 3 (checkpoint:human-verify, gate="blocking-human"):** no file changes — the owner verified the live install and replied "approved".

**Plan metadata:** recorded in this commit (docs: complete plan)

## Files Created/Modified
- `hermes-engineering-board/src/hermes_eng_board/redactor.py` - vendored verbatim from `mcp/src/grok_hermes_connector/redactor.py`
- `hermes-engineering-board/src/hermes_eng_board/substrate_client.py` - `SubstrateClient` (`emit_event`, `close`), matching `ConnectorClient`'s shape
- `hermes-engineering-board/src/hermes_eng_board/hooks_session.py` - three additive forwarding call sites, fail-open, threaded into the existing `finally` close path
- `hermes-engineering-board/tests/unit/test_hooks_session.py` - six new tests plus a `SUBSTRATE_DISABLED=1` fix on three pre-existing tests (see Deviations)

## Decisions Made
- Kept `work_unit_store` and `hermes-linear-connector` entirely untouched — D-01 scopes Lane B to brief + events and explicitly defers Kanban retirement; the connector already does what the phase wants kept.
- Fail-open guard placed at the call site in `hooks_session.py` (try/except around `emit_event`), not inside `SubstrateClient` — keeps the client itself honest/testable per the plan's stated convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Isolated three pre-existing hook tests from the live substrate endpoint**
- **Found during:** Task 2 (Forward session start, tool calls and finalize to the substrate)
- **Issue:** `test_session_start_and_tool_tracking`, `test_finalize_runs_pipeline_when_enabled` and `test_finalize_noop_when_disabled` did not inject a `substrate_client`. After Task 2's additive wiring, running these tests unmodified would have constructed a default `SubstrateClient()` and made real HTTP calls against the live, healthy `127.0.0.1:7410` substrate-mcp on every test run — writing real test events into production. Same defect class plan 01-02 found and fixed for `hermes-plugin`.
- **Fix:** Added `monkeypatch.setenv("SUBSTRATE_DISABLED", "1")` to those three tests, inside the plan's already-declared `tests/unit/test_hooks_session.py`.
- **Files modified:** `hermes-engineering-board/tests/unit/test_hooks_session.py`
- **Verification:** Full suite green at 82 passed / 0 failed (baseline 76 + 6 new); no live substrate calls observed from those three tests.
- **Committed in:** `19dd375` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking, in-scope test-isolation fix)
**Impact on plan:** Necessary to keep the test suite from writing real production events on every run. No scope creep — fix is confined to the plan's own declared test file.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness

Verified facts for downstream context:
- `hermes-engineering-board` suite: 82 passed, 0 failed (baseline 76 + 6 new).
- `hermes-linear-connector` suite: 49 passed, 2 skipped — byte-identical to its `01-BASELINE.md` row, confirming D-01's "Linear side untouched".
- `hermes-engineering-board` tracked working tree: 0 modified files post-commit; only untracked files from sibling plan 01-06 and another session remain, none touched by this plan.
- `substrate-mcp` confirmed healthy at checkpoint time: `{"index":true,"greptime":true}`.

Ready for Wave 4 (01-09, cross-surface proof) — `hermes-eng-board` now joins `hermes-plugin` as a substrate event producer with the connector's Kanban/Linear pipeline provably unaffected.

No blockers carried forward from this plan.

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*

## Self-Check: PASSED

- FOUND: /root/src/repos/hermes-engineering-board/src/hermes_eng_board/redactor.py
- FOUND: /root/src/repos/hermes-engineering-board/src/hermes_eng_board/substrate_client.py
- FOUND: /root/src/repos/agent-substrate/.planning/phases/01-lane-b/01-03-SUMMARY.md
- FOUND commit cdb0c72 (hermes-engineering-board)
- FOUND commit 19dd375 (hermes-engineering-board)
