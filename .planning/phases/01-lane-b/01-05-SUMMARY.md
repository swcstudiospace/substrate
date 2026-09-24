---
phase: 01-lane-b
plan: 05
subsystem: infra
tags: [mcp, grok-hermes-connector, substrate-mcp, memory_brief, memory_write, events_emit, graph_get, handoff_to_hermes, streamable-http]

# Dependency graph
requires:
  - phase: 01-lane-b
    provides: "01-01's substrate-mcp service (REST /brief, /events, and the MCP-only memory_write/graph_get tools over /mcp) and 01-02's kind:\"prompt\" EVENT_KINDS precedent, reused here for the handoff event"
provides:
  - "grok_hermes_connector/substrate_ext.py — fail-open forwarding helpers (brief, write, emit, graph_get) on this repo's own _ext.py convention, redacting every string before it leaves the process"
  - "grok_hermes_connector/server.py — four new @mcp.tool registrations (memory_brief, memory_write, events_emit, graph_get) delegating purely to substrate_ext, plus an optional graph_id parameter on handoff_to_hermes that is stored in handoff meta and carried onto one substrate_ext.emit(kind=\"handoff\") call"
  - "pyproject.toml declared version corrected to 0.4.0, matching __version__ and the runtime log line (closes a pre-existing drift, not introduced by this plan)"
  - "Live proof (Task 3, this session): the restarted v0.4.0 service lists all four new tools, and a live memory_brief call for swcstudiospace/agent-substrate returns real cross-surface brief text"
affects: [phase-1-success-criterion-5, grok-hermes-connector-mcp-surface, any-future-plan-touching-substrate_ext-or-handoff_to_hermes]

# Actuals (#2632)
actuals:
  tokens: 7100
  tasks: 3
  commits: 2
plan_head_before: 2a89f98c8c0e97e2b56e0d7226c9b28d0e1e7bfe

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The repo's own _ext.py forwarding convention (github_ext.py, greptile_ext.py, supabase_ext.py, vercel_ext.py, linear_ext.py, agent_bus_ext.py) extended to a 7th service, substrate_ext.py: httpx-based, transport-injectable, redact-before-send, never raises."
    - "Two forwarding shapes in one module: brief/emit speak the substrate's plain REST routes (POST /brief, POST /events); write/graph_get have no REST route and speak MCP streamable-HTTP JSON-RPC directly over POST /mcp (stateless — no initialize handshake needed, response comes back as one `event: message` SSE frame)."
    - "MCP SDK structured_content wrapping: a tool whose return type annotation is a Union (memory_brief_tool: dict[str, Any] | str) has its structured_content wrapped as {\"result\": value}; a tool annotated as a plain dict[str, Any] (memory_write_tool, events_emit_tool, graph_get_tool) does not get wrapped. Discovered via a failing test assertion, not documented anywhere in the MCP SDK's own docs at the time of writing."
    - "Settings(...)-direct-construction test-safety convention (hermes_bin=\"/bin/true\", dispatch_script=\"/bin/true\", notify_telegram=False), already used by test_tasks_skills.py/test_oauth.py/test_dev_flow_tools.py/test_services_tools.py, extended to the new handoff_to_hermes+graph_id tests. dispatch_script, not hermes_bin, is the load-bearing override: submit_hermes_background() prefers the dispatch-script path whenever Path(dispatch_script).is_file() is true, and /bin/true is a file, so bash /bin/true <args> is the actual (safe, inert) invocation."
    - "Partial-hunk staging in a shared, concurrently-dirty checkout: content-only diff comparison (stripping the diff --git/index/@@-line-number metadata lines, keeping only the +/- body) is the correct technique for proving another session's hunks survived a commit — git rewrites @@ line offsets and the index blob hash whenever anything else in the file changes, which produces false positives in a naive whole-diff comparison."

key-files:
  created:
    - /root/src/repos/mcp/src/grok_hermes_connector/substrate_ext.py
    - /root/src/repos/mcp/tests/test_substrate_ext.py
  modified:
    - /root/src/repos/mcp/src/grok_hermes_connector/server.py
    - /root/src/repos/mcp/pyproject.toml
    - /root/src/repos/mcp/tests/test_handoff_pack.py

key-decisions:
  - "graph_id threaded through server.py's own store.save(meta={...}) call rather than through hermes_backend.py's submit_hermes_background/store.update_meta route the plan's read_first pointed at for the hermesPid/dispatchPid precedent. hermes_backend.py was not in this plan's files_modified list and carried its own uncommitted changes from another session at plan start; server.py already owns the full meta dict at the point graph_id is known (before dispatch), so no cross-file call was needed to achieve the same stored-meta outcome the plan's acceptance criteria require."
  - "The substrate_ext.emit(kind=\"handoff\", ...) call is made after record_tool_call(...) succeeds and wrapped in try/except so any outcome, including the fail-open error dict or a raised exception from a monkeypatched failure, never turns a successful handoff into a failure — proven by test_handoff_to_hermes_completes_when_substrate_emit_fails."
  - "memory_brief_tool's structured_content assertion in test_new_substrate_tools_return_helper_dicts_unchanged is {\"result\": error_dict}, not error_dict directly — the MCP SDK wraps Union-return-type tool outputs; the other three tools (plain dict[str, Any] return type) are asserted unwrapped. See tech-stack patterns."
  - "Task 3's live handoff_to_hermes+graph_id dispatch (the plan's own <human-check>, explicitly scoped as \"From a Grok Bot session\") was deliberately NOT triggered a second time by this executor. An earlier ad hoc verification probe in this same session (before this plan's tests existed) forgot to override HERMES_BIN/HERMES_DISPATCH_SCRIPT and accidentally spawned a real `hermes chat --yolo` process against the live production service, sending at least one real Telegram notification. That process was killed (SIGTERM then SIGKILL, confirmed via ps/pgrep no PIDs remained) and no result.json was ever written (log showed only a benign model-normalization warning), so impact was contained, but a second live, side-effecting dispatch was judged too consequential to re-attempt autonomously in the same session. See coverage D4 and Issues Encountered."

patterns-established:
  - "Pattern: when a plan's <human-check> explicitly names a live external agent/session (\"from a Grok Bot session\") rather than a direct API call, treat that as an intentional human-verification boundary, not something to be quietly substituted with a raw curl call to the same endpoint — especially when the action being verified is real-world consequential (spawns an autonomous process, sends a live notification) rather than a passive read."
  - "Pattern: after any unintended live side effect in a session (wrong env var, wrong flag), do not attempt the same class of side-effecting action again autonomously later in that session, even for legitimate verification purposes — surface it as a human-judgment coverage item instead."

requirements-completed: [SC-5]

coverage:
  - id: D1
    description: "substrate_ext.py provides four fail-open forwarding helpers (brief, write, emit, graph_get) on the repo's own _ext.py convention, redacting every string before it leaves the process, proven offline through injected httpx transports"
    requirement: "SC-5"
    verification:
      - kind: unit
        ref: "tests/test_substrate_ext.py — 8 tests: REST brief/emit success, upstream_unreachable, upstream_error+status, summary redaction before the request body, SUBSTRATE_DISABLED short-circuit, MCP graph_get over /mcp SSE, MCP write tool-level error mapping"
        status: pass
    human_judgment: false
  - id: D2
    description: "server.py registers memory_brief, memory_write, events_emit and graph_get as @mcp.tool functions delegating to substrate_ext, and handoff_to_hermes accepts an optional graph_id that is stored in handoff meta and emitted as one substrate handoff event without ever blocking or failing the handoff itself"
    requirement: "SC-5"
    verification:
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_stores_graph_id_in_meta"
        status: pass
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_emits_one_handoff_event_with_graph_id"
        status: pass
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_without_graph_id_behaves_as_before"
        status: pass
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_completes_when_substrate_emit_fails"
        status: pass
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_new_substrate_tools_return_helper_dicts_unchanged"
        status: pass
      - kind: integration
        ref: "cd /root/src/repos/mcp && .venv/bin/python -m pytest -q — full suite: 112 passed, 2 failed (baseline's 99 passed/2 failed plus this plan's 13 new tests; same two pre-existing failing node ids as 01-BASELINE.md: tests/test_dedupe_waiter.py::test_wait_for_hermes_job_tracks_status_file and tests/test_tasks_skills.py::test_health_lists_new_capabilities — neither repaired, per D-03's no-repair rule)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The live grok-hermes-connector.service, restarted to pick up Task 2's code, comes back healthy on v0.4.0 with no traceback, and its real tool surface answers: tools/list includes all four new names, and a live memory_brief call for a repo with substrate activity returns real, non-empty cross-surface text"
    requirement: "SC-5"
    verification:
      - kind: automated_ui
        ref: "sudo systemctl restart grok-hermes-connector && systemctl is-active grok-hermes-connector && journalctl since-restart grep v0.4.0 / no Traceback (plan's own <automated> verify script) — re-confirmed live at SUMMARY time: ActiveEnterTimestamp=2026-09-24T14:17:23Z, journal line 'starting grok-hermes-connector v0.4.0 on 127.0.0.1:8788', no Traceback in the since-restart journal"
        status: pass
      - kind: integration
        ref: "Live POST /mcp tools/list at 2026-09-24T14:2x: response includes name:\"memory_brief\", name:\"memory_write\", name:\"events_emit\", name:\"graph_get\" alongside the pre-existing handoff_to_hermes and other forwarded-service tools"
        status: pass
      - kind: integration
        ref: "Live POST /mcp tools/call memory_brief {repo:\"swcstudiospace/agent-substrate\"} at 2026-09-24T14:2x: returned non-empty markdown text naming another surface's work (\"12:50 cursor commit 9286a60 docs(01-07)...\", \"12:45 omp Omp autonomous discovery for swcstudiospace/agent-substrate\")"
        status: pass
      - kind: integration
        ref: "Live POST /mcp tools/call graph_get {graph_id:\"nonexistent-graph-xyz\"} at 2026-09-24T14:2x: returned a clean {status_code:200, body:\"No graph ... in the index.\"} response, not an error or crash — fail-open behavior confirmed for an unknown graph"
        status: pass
    human_judgment: false
  - id: D4
    description: "Literal plan-designed human-check: from a Grok Bot session, hand off to Hermes with a graph_id and confirm the resulting substrate `handoff` event carries that same graph_id"
    verification: []
    human_judgment: true
    rationale: "The plan's own <human-check> text scopes this specific step to a real Grok Bot session (\"From a Grok Bot session, call memory_brief ... then hand off to Hermes with a Graph ID...\"), not a direct API call by the executor — unlike the rest of Task 3's acceptance criteria, which are read-only and were safely exercised live above. Separately and more importantly: earlier in this same session, an ad hoc verification probe (predating this plan's tests) forgot to override HERMES_BIN/HERMES_DISPATCH_SCRIPT and accidentally triggered a real handoff_to_hermes dispatch against the live production service — spawning a real, autonomous `hermes chat --yolo` process and sending at least one real Telegram notification to the human operator before it was caught and killed (SIGTERM then SIGKILL; confirmed via ps/pgrep that no target PIDs remained; the job's log held only a benign model-normalization warning and no result.json was ever written, so no further autonomous work appears to have executed). Given that incident, re-triggering the same class of real, side-effecting, notification-sending action a second time in this session — even for legitimate verification — was judged to require explicit human go-ahead rather than another autonomous attempt. `handoff_to_hermes`'s own unit coverage (D2, monkeypatched substrate_ext.emit) already proves the graph_id -> emit(kind=\"handoff\", graph_id=...) wiring is correct in isolation; what remains unverified is only the live, production, end-to-end path."

# Metrics
duration: ~29min (measured from Task 1's commit timestamp, 13:58:14Z, to this SUMMARY, 14:27Z, in this resumed/continued session; earlier planning work preceding that window is not separately timestamped)
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 05: grok-hermes-connector v0.4 substrate bridge Summary

**grok-hermes-connector now forwards to substrate-mcp through a new substrate_ext.py module and four live MCP tools (memory_brief, memory_write, events_emit, graph_get), and handoff_to_hermes carries an optional graph_id onto one fail-open substrate handoff event — proven live against the restarted v0.4.0 production service (real tool listing, real cross-surface memory_brief text), with the single live graph_id-carrying handoff dispatch deliberately deferred to a human given an earlier accidental live-dispatch incident this session.**

## Performance

- **Duration:** ~29 min (see Metrics note above)
- **Started:** 2026-09-24T13:58:14Z (Task 1 commit)
- **Completed:** 2026-09-24T14:27Z
- **Tasks:** 3/3 (Task 3's automated + safe-live-read portions complete; one plan-designed human-check step deliberately deferred — see coverage D4)
- **Files modified:** 5 (2 created, 3 modified) in `/root/src/repos/mcp`

## Accomplishments
- `substrate_ext.py` built on the repo's own `_ext.py` convention: four fail-open helpers (`brief`, `write`, `emit`, `graph_get`), redacting every outbound string, never raising, proven offline through 8 injected-transport tests.
- `server.py` exposes `memory_brief`, `memory_write`, `events_emit` and `graph_get` as thin `@mcp.tool` wrappers around `substrate_ext`, and `handoff_to_hermes` now accepts an optional `graph_id`, stored in handoff meta and emitted as one `kind="handoff"` substrate event that can never turn a successful handoff into a failure.
- `pyproject.toml`'s declared version drift (`0.3.3` vs the runtime's actual `0.4.0`) fixed.
- The live `grok-hermes-connector.service` was restarted, confirmed healthy on v0.4.0, and its new tool surface was exercised for real: all four tool names present, `memory_brief` returned genuine cross-surface brief text for `swcstudiospace/agent-substrate`, `graph_get` degraded cleanly for an unknown graph.
- The `mcp` test suite ended at 112 passed / 2 failed — the same two pre-existing failing node ids recorded in `01-BASELINE.md`, plus this plan's 13 new passing tests (8 Task 1 + 5 Task 2), holding the two-sided gate exactly.
- Another session's nine files of uncommitted, in-progress work in this shared `mcp` checkout (including the two files this plan also touches, `server.py` and `tests/test_handoff_pack.py`) survived untouched — verified byte-identical (content-only diff, ignoring git's own line-number/blob-hash metadata shifts) both before and after every commit in this plan.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build substrate_ext.py on the repo's own _ext.py convention** - `e1aa4fd` (feat)
2. **Task 2: Expose four substrate tools and put a Graph ID on handoff_to_hermes** - `e837814` (feat, tdd)
3. **Task 3: Restart the live connector and prove the tools answer** - no new commit (service restart + live verification only, no file written by this task; Task 1 + Task 2's commits are what the restart picks up)

**Plan metadata:** (this commit, agent-substrate repo — see final commit below)

_Note: Task 2 carried `tdd="true"`; its RED/GREEN work (writing the 5 new `test_handoff_pack.py` behaviors alongside the `server.py` implementation) landed in a single commit rather than separate test/feat commits, consistent with how prior Lane B plans in this session handled `tdd="true"` tasks implemented and tested together before the first commit._

## Files Created/Modified
- `/root/src/repos/mcp/src/grok_hermes_connector/substrate_ext.py` - fail-open forwarding helpers (`brief`, `write`, `emit`, `graph_get`) — created
- `/root/src/repos/mcp/tests/test_substrate_ext.py` - 8 tests for the helpers above — created
- `/root/src/repos/mcp/src/grok_hermes_connector/server.py` - four new `@mcp.tool` registrations, `graph_id` param + span + meta storage + fail-open `emit(kind="handoff", ...)` call on `handoff_to_hermes` (partial-hunk staged: only these hunks are mine, another session's separate uncommitted hunks in this same file are untouched)
- `/root/src/repos/mcp/pyproject.toml` - `version = "0.3.3"` -> `"0.4.0"`
- `/root/src/repos/mcp/tests/test_handoff_pack.py` - 5 new async tests for the `graph_id`/tool-wiring behaviors above (partial-hunk staged: only the appended test block is mine, another session's separate uncommitted 2-line hunk mid-file is untouched)

## Decisions Made
See `key-decisions` in frontmatter for full rationale. Summary: `graph_id` threaded through `server.py`'s own existing `store.save(meta={...})` call rather than reaching into the out-of-scope, already-dirty `hermes_backend.py`; the substrate `emit` call is try/except-wrapped so a substrate outage never fails a handoff; the MCP SDK's Union-return-type `structured_content` wrapping quirk was discovered and asserted explicitly; and the plan's own `<human-check>` for the live `graph_id`-carrying handoff dispatch was deliberately left for a human given an earlier accidental live-dispatch incident this session (see Issues Encountered and coverage D4).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test suite globally disabling SUBSTRATE_DISABLED broke 7 of Task 1's own tests**
- **Found during:** Task 2 (first full-suite verification pass)
- **Issue:** Setting `SUBSTRATE_DISABLED=1` at the shell level for the whole `pytest` invocation (intended as a blanket safety net) broke 7 of the 8 pre-existing `test_substrate_ext.py` tests, which need the variable unset to exercise mocked-transport behavior — only one of those 8 tests sets it itself via `monkeypatch`.
- **Fix:** Reran without the global override; kept only `HERMES_BIN=/bin/true HERMES_DISPATCH_SCRIPT=/bin/true` at the shell level (harmless globally, since every existing test constructs `Settings` directly rather than relying on env-var defaults). The new Task 2 tests already scope `SUBSTRATE_DISABLED` per-test via `monkeypatch.setenv`, making a global override both unnecessary and harmful.
- **Files modified:** none (test-run configuration only, no source change)
- **Verification:** Full suite: 112 passed, 2 failed, correct two-sided gate.
- **Committed in:** n/a (verification-only correction, not a code change)

**2. [Rule 1 - Bug] memory_brief structured_content assertion initially wrong due to an undocumented MCP SDK wrapping behavior**
- **Found during:** Task 2 (writing `test_new_substrate_tools_return_helper_dicts_unchanged`)
- **Issue:** `assert r1.structured_content == error_dict` failed with `{'result': {...}} == {'error': ...}` for the `memory_brief` tool call.
- **Fix:** Discovered that `memory_brief_tool`'s `dict[str, Any] | str` Union return-type annotation causes the MCP SDK to wrap non-object-schema `structured_content` in `{"result": ...}`, unlike the other three tools' plain `dict[str, Any]` annotation. Changed the assertion to `{"result": error_dict}` with an explanatory comment; the other three tools' assertions stayed unwrapped.
- **Files modified:** `tests/test_handoff_pack.py`
- **Verification:** Test passes; documented as a `tech-stack.patterns` entry for future tool authors in this file.
- **Committed in:** `e837814` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1/bug, both discovered and resolved during Task 2's own test-writing and verification — no scope creep, no source-level surprises beyond the plan's own `files_modified` list).
**Impact on plan:** Neither deviation touched production code paths beyond what the plan already specified; both were test-authoring/test-running corrections.

## Issues Encountered

- **Accidental live Hermes dispatch (contained this session, not caused by this plan's committed code).** Earlier in this session, before this plan's safety-scoped tests existed, an ad hoc verification probe of the Task 2 wiring omitted `HERMES_BIN`/`HERMES_DISPATCH_SCRIPT` overrides and triggered a real `handoff_to_hermes` dispatch against the live production `grok-hermes-connector.service`. This spawned a real, autonomous `hermes chat --yolo` agent process (goal: "test goal") and — per the code path in `/root/agent-scripts/dispatch_handoff_to_hermes.sh` — sent at least one real Telegram "ACK — starting handoff job" notification (and very likely a second "DONE" notification, since the job's status file read `"completed"`) to the human operator's real Telegram channel. **Containment:** the process (PID 3970856) and its children were terminated (`SIGTERM` then `SIGKILL`); `ps -ef`/`pgrep -af hermes` confirmed no target PIDs remained and no other unexpected hermes-related processes existed; the job's log held only one benign model-normalization warning (no evidence of further autonomous work) and no `result.json` was ever written. Neither the Telegram message nor the job's real artifacts were "undone" (not possible / not attempted); scratch probe directories have since been cleaned up (none found remaining under `/tmp` at SUMMARY time). **Consequence for this plan:** the plan's own Task 3 `<human-check>` — a second, deliberate live `handoff_to_hermes` + `graph_id` dispatch — was NOT re-attempted autonomously; it is recorded as coverage `D4` (`human_judgment: true`) and logged to `WINDOWS.md` below, consistent with the pattern already established by sibling plan 01-07's `D4`.
- **Hunk-merging in `tests/test_handoff_pack.py` during partial-hunk staging.** Unlike `server.py`, where my Task 2 edits landed far enough from the other session's edits that `git diff` kept them in separate hunks, my appended test block (end of file) and the other session's 2-line insertion (mid-function) were close enough that `git diff` merged them into one hunk (`@@ -39,7 +41,223 @@`), defeating naive hunk-subset staging. Resolved by hand-reconstructing a standalone hunk using only HEAD-identical lines (via `git show HEAD:tests/test_handoff_pack.py`) as old-side context plus my own new lines as additions, applied via `git apply --cached`, then verified via a content-only diff (see key-decisions/patterns-established) showing the other session's original 2-line hunk fully intact, unstaged, after my commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `grok-hermes-connector` v0.4.0 is live, serving all four new substrate tools plus the `graph_id`-aware `handoff_to_hermes`, matching the substrate-bridge pattern already established for `hermes-plugin` (01-02) and `omp-ultrathink` (01-07).
- One deliberate gap remains before Phase 1's success criterion for this plan can be called fully proven end-to-end: a human (or a future session with explicit go-ahead) needs to perform the live `graph_id`-carrying `handoff_to_hermes` dispatch from a real Grok Bot session and confirm the resulting substrate `handoff` event, per coverage `D4` / `WINDOWS.md` below. `handoff_to_hermes`'s `graph_id` -> `emit` wiring is already proven correct in isolation (coverage D2); what remains is only the live, production, end-to-end confirmation.
- No blockers for the rest of Phase 1's plans; another session's nine files of unrelated, uncommitted work in this same `mcp` checkout remain exactly as they were, untouched by this plan.

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*

## Self-Check: PASSED

- FOUND: /root/src/repos/mcp/src/grok_hermes_connector/substrate_ext.py
- FOUND: /root/src/repos/mcp/tests/test_substrate_ext.py
- FOUND: /root/src/repos/mcp/src/grok_hermes_connector/server.py
- FOUND: /root/src/repos/mcp/pyproject.toml
- FOUND: /root/src/repos/mcp/tests/test_handoff_pack.py
- FOUND commit: e1aa4fd (Task 1)
- FOUND commit: e837814 (Task 2)
- FOUND: .planning/phases/01-lane-b/01-05-SUMMARY.md (this file)
