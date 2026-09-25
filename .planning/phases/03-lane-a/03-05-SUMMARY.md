---
phase: 03-lane-a
plan: 05
subsystem: dispatcher
tags: [python, httpx, substrate-host, claude-code, remote-task, d-05, d-06, d-12, d-14, d-15, sc-3]

requires:
  - phase: 03-lane-a
    provides: 03-03 substrate-host unit on 127.0.0.1:7411 and its task API (202/200/400/409/502, GET status with exit_code null|0|1, terminate/kill 202, task state file /var/lib/substrate/agentos/tasks/<gid>--<nid>.json); 03-04 seed/policy (unchanged here)
  - phase: 02-claims-and-dispatch
    provides: dispatch.tick/make_launch_fn/validate_ids, worktree.repo_checkout/ensure_worktree (D-12), sessions.SessionRegistry with the D-14 cap, CLAIM_TIMEOUT_SECONDS=900 and landed_claim, __main__ supervised loop, substrate-dispatcher.service with the D-15 switch
provides:
  - packages/dispatcher/src/substrate_dispatcher/host.py — HostClient (from_env/SUBSTRATE_HOST_URL, open_task, status, terminate, kill, launch, close), RemoteTask (poll/terminate/kill, pid 0), HostRefused (host-refused | host-unreachable), DEFAULT_HOST_URL, TASKS_DIR, UNREACHABLE_LIMIT=3
  - dispatch.py — DISPATCHABLE_SURFACES = {hermes, claude-code}; MARKERS host-refused / host-unreachable; not-dispatchable text names both surfaces; make_launch_fn(open_task=…) branches after ensure_worktree; tick catches HostRefused once-only; log line `launched claude-code for <id> graph <gid> node <nid> task <gid>/<nid> worktree <path>`
  - __main__.py — HostClient.from_env() built with the other clients, open_task=host.launch, closed in the same finally; docstring names both launch routes
  - tests — test_host.py (19, httpx.MockTransport), test_dispatch.py (+6), test_sessions.py (+4, RemoteTask through the registry), test_main.py (+1, client order pins host)
  - 03-05-TRACER.md — observed dispatch tracer (launch path → worktree → POST /tasks → claim as claude-code seen by the registry → VM waiting on its first approval, poll None) and the D-05 restart evidence (dispatcher_restart_task_kept=true, host ActiveEnterTimestamp unchanged), kill, cleanup, re-adoption gap
affects: [03-06, 03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 10696      # chars/4 over the 5fdeb7c..98cf59d diff (8 files, +870/-10)
  tasks: 2
  commits: 2
plan_head_before: 5fdeb7cb3551837faa08f255c9e3876edd8c6c8e

tech-stack:
  added: []
  patterns:
    - "A remote handle serves exactly the Popen subset the registry uses (poll/terminate/kill, pid attribute); the registry, its cap, timeout and landed-claim rule are untouched and the new tests drive a RemoteTask through the unchanged _reap_one"
    - "Host errors are two markers: host-refused (the host answered 400/409/502 — not retried by comment, retried by tick) and host-unreachable (transport or any other status); poll() tolerates UNREACHABLE_LIMIT-1 consecutive failures, then reports exit 2 and logs once"
    - "Tracer under systemd-run without EnvironmentFile when no key is needed; the tracer drives make_launch_fn and SessionRegistry.reap directly with the switch at =1, so dispatch never turns on"

key-files:
  created:
    - packages/dispatcher/src/substrate_dispatcher/host.py
    - packages/dispatcher/tests/test_host.py
    - .planning/phases/03-lane-a/03-05-TRACER.md
  modified:
    - packages/dispatcher/src/substrate_dispatcher/dispatch.py
    - packages/dispatcher/src/substrate_dispatcher/__main__.py
    - packages/dispatcher/tests/test_dispatch.py
    - packages/dispatcher/tests/test_sessions.py
    - packages/dispatcher/tests/test_main.py

key-decisions:
  - "HostClient.launch takes its clock before POST /tasks (as launcher.launch does before Popen), so the 900 s claim timeout counts from the dispatcher's decision, not from the host's reply"
  - "RemoteTask.poll maps a 404 to 2 immediately (the host answered: no such task) but counts transport errors and non-200 statuses towards UNREACHABLE_LIMIT; the once-only log line names the task and the failure count, never the transport's message"
  - "HostRefused messages carry the host's error body capped at 200 characters for the journal; the Linear comment uses only the fixed MARKERS text (no host text reaches Linear)"
  - "prompt_path and log_path of a claude-code Launched are both the host's task state file: the dispatcher writes no prompt for a VM task (the host seeds it, 03-03/03-04)"
  - "The tracer's Linear stub raises on every method: the claimed-then-running path through _reap_one never consulted Linear, which is what the live run proved"

patterns-established:
  - "D-05 evidence pair: host_active_since_before/after must be byte-identical and the task must be listed with the same session id after the dispatcher restart; the re-adoption gap is recorded, not fixed"

requirements-completed: []

coverage:
  - id: D1
    description: "dispatch:claude-code is dispatchable; make_launch_fn runs validate_ids → repo_checkout → ensure_worktree → open_task and returns Launched(pid 0, RemoteTask); host refusals are once-only comments with no session and no give-up; the not-dispatchable text names both surfaces"
    verification:
      - kind: unit
        ref: "cd packages/dispatcher && python3 -m pytest -q tests/test_dispatch.py (34 pass)"
        status: pass
      - kind: integration
        ref: ".planning/phases/03-lane-a/03-05-TRACER.md launch_line=, claim_evidence=claimed_by, claim_session=n1, poll_while_waiting=None; Task 1 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "HostClient/RemoteTask contract: open_task 200/202 JSON, 400/409/502 → host-refused, transport/5xx → host-unreachable, poll mapping null/0/1/404→2, three consecutive failures → 2 logged once with reset on success, terminate/kill POST and never raise"
    verification:
      - kind: unit
        ref: "cd packages/dispatcher && python3 -m pytest -q tests/test_host.py (19 pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-14 unchanged over a RemoteTask: claim recorded from claimed_by claude-code, exit 0/1 after the claim removed quietly, host unreachable ×3 frees the slot with no Linear call, unclaimed 900 s timeout → [claim-timeout] + label removal + terminate POST + kill POST after the grace"
    verification:
      - kind: unit
        ref: "cd packages/dispatcher && python3 -m pytest -q tests/test_sessions.py (28 pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The supervised loop builds HostClient.from_env() once, passes open_task=host.launch, closes it with the other clients; the restarted unit is active, NRestarts 0, journal 'dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)', switch last line =1"
    verification:
      - kind: unit
        ref: "cd packages/dispatcher && python3 -m pytest -q tests/test_main.py (12 pass)"
        status: pass
      - kind: integration
        ref: "Task 2 <automated> verify exit 0 (unit active, NRestarts=0, journal line present, no Traceback, awk switch check exit 0)"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-05 live: restarting substrate-dispatcher left the VM task running — substrate-host kept ActiveEnterTimestamp 'Fri 2026-09-25 14:44:31 UTC' and GET /tasks still listed the task with session_id n1 state waiting; the task was then killed (claimed_by null) and its worktree removed"
    verification:
      - kind: integration
        ref: "03-05-TRACER.md dispatcher_restart_task_kept=true, host_active_since_before == host_active_since_after, tracer_task_killed=true, tracer_worktree_removed=true"
        status: pass
    human_judgment: false
  - id: D6
    description: "Dispatcher suite two-sided green against 03-BASELINE.md; root suite and tsc unchanged"
    verification:
      - kind: other
        ref: "pytest 149 passed (baseline 114, re-measured 119 before the first edit; no FAILED ids either side); bun test 279 pass / 0 fail; tsc-exit=0"
        status: pass
    human_judgment: false

duration: 11min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 05: Dispatch tracer — claude-code through substrate-host Summary

**The Phase 2 dispatcher now routes `dispatch:claude-code` to substrate-host: `make_launch_fn` runs the unchanged validate_ids → repo_checkout → ensure_worktree chain and then `HostClient.launch` (`POST /tasks` on 127.0.0.1:7411), handing `SessionRegistry` a `RemoteTask` that serves the Popen `poll()/terminate()/kill()` subset so the D-14 cap, the 900 s claim timeout and the landed-claim rule apply untouched; live, the dispatcher's own launch path opened a VM task whose claim as `claude-code` (session `n1`) the registry recorded on its first reap 12 s after launch, and restarting `substrate-dispatcher` around that running task left substrate-host and the task exactly as they were (D-05).**

## Performance

- **Duration:** 11 min
- **Started:** 2026-09-25T14:51:28Z
- **Completed:** 2026-09-25T15:02:21Z
- **Tasks:** 2
- **Files modified:** 8 (3 created, 5 modified)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at 5fdeb7c before the first edit | After Task 1 (41e1ed7) | After Task 2 (98cf59d) |
|---|---|---|---|---|
| dispatcher pytest | 114 passed | 119 passed | 145 passed (test_host 19, test_dispatch +6, one test reworded) | 149 passed (+4 sessions, +1 main; one order test updated) |
| agent-substrate bun test | 167 pass, 0 fail | 279 pass, 0 fail | — | 279 pass, 0 fail (no TS touched) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | — | tsc-exit=0 |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- **host.py (D-06):** `HostClient` over httpx with the `McpClient` shape (`url`, `timeout`, injectable `transport`, `from_env` on `SUBSTRATE_HOST_URL`); `open_task` posts the five ids and returns the host's JSON on 202/200, raises `HostRefused("host-refused")` on 400/409/502 with the host's error text (≤ 200 chars) and `HostRefused("host-unreachable")` on a transport error or any other status; `status` returns the JSON or `None` on 404; `terminate`/`kill` POST the host routes; `launch` returns `Launched(pid=0, proc=RemoteTask, prompt_path=log_path=/var/lib/substrate/agentos/tasks/<gid>--<nid>.json, started_at=clock())`. `RemoteTask.poll()` maps `exit_code` null/0/1 → `None`/0/1, 404 → 2, tolerates two consecutive failed reads and reports 2 on the third (logged once, reset on a success); `terminate()`/`kill()` log and never raise.
- **dispatch.py:** `DISPATCHABLE_SURFACES = {hermes, claude-code}`; `not-dispatchable` names both surfaces; `host-refused` and `host-unreachable` markers; `make_launch_fn(open_task=…)` branches on the surface after the worktree exists (a missing client raises `host-unreachable`); `tick` treats `HostRefused` like `WorktreeRefused` — one comment, no session, no give-up, decided again next tick; the journal line is `launched claude-code for <identifier> graph <gid> node <nid> task <gid>/<nid> worktree <path>`.
- **__main__.py:** `HostClient.from_env()` next to `McpClient`, `open_task=host.launch` into `make_launch_fn`, closed in the same `finally`; the unit was restarted on it (active, `NRestarts=0`, journal `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` at 15:00:13Z and every 30 s).
- **Live tracer (dispatch off, graph `ut-muh32wc1-d14818ff`, synthetic `TRC-2`):** `POST /tasks` at 14:56:20Z → `vm resolved` 14:56:25Z → `task opened` 14:56:32Z → the registry's first reap recorded `claim landed for TRC-2 (claimed_by, session n1)` at 14:56:32Z → first model event (`approval pending`, tool Read) 14:56:37Z → host `state=waiting pending_approvals=1 exit_code=null`, `poll_while_waiting=None`, `registry_capacity_left=1`, main checkout on `main`, worktree on `substrate/<gid>`. No Linear write, no key loaded.
- **D-05 live:** dispatcher restarted at 15:00:12Z (MainPID 1586416 → 2681092); substrate-host kept MainPID 2650098 and `ActiveEnterTimestamp=Fri 2026-09-25 14:44:31 UTC`; `GET /tasks` listed the same task (`session_id=n1 state=waiting pending_approvals=1`) 35 s later; container `goofy_wright` still up. Then `POST …/kill` → 202, `turn ended stop=cancelled`, `task killed`, `graph_get` `claimed_by=null`; worktree and branch removed; `/tmp/03-05-tracer.py` deleted.

## Task Commits

1. **Task 1: Dispatch tracer — dispatcher launch path → worktree → substrate-host → claim → VM, watched by SessionRegistry through RemoteTask** — `41e1ed7` (feat)
2. **Task 2: Supervised loop wired to the host; RemoteTask through the registry; D-05 dispatcher restart leaves the VM task running** — `98cf59d` (feat)

**Plan metadata:** this SUMMARY commit (docs).

TDD: test_host.py was written first (RED: `substrate_dispatcher.host` missing) and the six new test_dispatch.py tests plus the reworded omp test failed (7 failed) before dispatch.py changed; GREEN 53 passed with no iteration. Task 2: test_main.py RED (`__main__` has no `HostClient`, 5 errors), GREEN after the wiring; the four test_sessions.py RemoteTask tests passed on first run against the unchanged registry, which is the D-14-unchanged claim they pin.

## Files Created/Modified

- `packages/dispatcher/src/substrate_dispatcher/host.py` — `DEFAULT_HOST_URL`, `TASKS_DIR`, `UNREACHABLE_LIMIT`, `REFUSAL_STATUSES`, `HostRefused`, `HostClient`, `RemoteTask`.
- `packages/dispatcher/src/substrate_dispatcher/dispatch.py` — surfaces, markers, `make_launch_fn(open_task=)`, `HostRefused` handling in `tick`, docstring D-11/D-06 line.
- `packages/dispatcher/src/substrate_dispatcher/__main__.py` — host client construction, `open_task` wiring, close, docstring.
- `packages/dispatcher/tests/test_host.py` — 19 tests over `httpx.MockTransport` (open_task statuses and error cap, from_env, launch shape, poll mapping, unreachable count and reset, 5xx as unreachable, terminate/kill routes and never-raise).
- `packages/dispatcher/tests/test_dispatch.py` — claude-code routing order and log line, hermes never calls open_task, no client → host-unreachable, claude-code launches with capacity, host-refused once-only without session/give-up, host-unreachable retried; omp text pins both surfaces.
- `packages/dispatcher/tests/test_sessions.py` — `FakeHostTask`/`remote_setup`; claimed then exit 0/1 quiet removal, unreachable ×3 frees the slot without Linear, unclaimed 900 s timeout → terminate then kill POSTs.
- `packages/dispatcher/tests/test_main.py` — `FakeHost`, host in the client fixture, wiring test; dry-run client order now `linear, mcp, host`.
- `.planning/phases/03-lane-a/03-05-TRACER.md` — run, keys, timeline, findings, Task 2 restart, kill, cleanup, Retained, Gaps.

## Decisions Made

See key-decisions. None changes a D-05..D-16 contract; the registry, cap, timeout and landed-claim rule are byte-unchanged (sessions.py not modified).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] test_main.py's client-order assertion pinned the two-client construction**
- **Found during:** Task 2 (`test_dry_run_takes_no_lock` asserted `client_calls == ["linear", "mcp"]`)
- **Issue:** `main()` now builds a third client; the fixture also had to patch `HostClient.from_env` so no test constructs a real httpx client.
- **Fix:** the `client_calls` fixture patches `cli.HostClient.from_env` to a `FakeHost` and the dry-run test expects `["linear", "mcp", "host"]`.
- **Files modified:** packages/dispatcher/tests/test_main.py
- **Verification:** test_main.py 12 pass
- **Committed in:** 98cf59d

---

**Total deviations:** 1 auto-fixed (Rule 1). Everything else executed as written: one tracer run, one restart, no failed runs.
**Impact on plan:** none on the contracts; the test change is the consumer-visible consequence of the plan's own wiring.

## Issues Encountered

None. The tracer claimed on its first run (12 s launch → claim, 17 s launch → first approval request), and the D-05 restart needed no retry.

## Threat Flags

None beyond the plan's register: no new endpoint, auth path or schema; the dispatcher gained an outbound loopback HTTP client to :7411 (T-03-05-05, accepted). No host error text reaches Linear (fixed MARKERS text only); the journal gets at most 200 characters of it.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 03-08 (approvals) can answer the pending `permission_request` the tracer left unanswered; nothing in the dispatcher needs to change when approvals flow.
- 03-10 (proof) exercises the label → poll leg: with the switch at `=0` the running unit will call `graph_find`, `make_launch_fn` (now with `open_task=host.launch`) and register a `RemoteTask` session; the journal line to grep is `launched claude-code for <identifier> graph <gid> node n1 task <gid>/n1 worktree …`.
- Re-adoption of running VM tasks after a dispatcher restart is an open gap (T-03-05-04, accepted): the host lists them on `GET /tasks`; a later plan may rebuild registry entries from that list.
- Dispatch stayed off throughout: the last `SUBSTRATE_DISPATCH_DISABLED` line is `=1`, the restarted unit logs `dispatch disabled`, and no substrate.env value was read or printed.

## Self-Check: PASSED

- FOUND: packages/dispatcher/src/substrate_dispatcher/host.py, dispatch.py, __main__.py, tests/test_host.py, test_dispatch.py, test_sessions.py, test_main.py, .planning/phases/03-lane-a/03-05-TRACER.md
- FOUND: commits 41e1ed7, 98cf59d (`git log --grep 03-05`)
- `substrate-dispatcher` active, NRestarts 0, 8 `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` lines since its restart; `substrate-host` active since `Fri 2026-09-25 14:44:31 UTC` (unchanged across the dispatcher restart); the switch's last line is `=1` (four `=1` lines, three `=0` lines — unchanged by this plan, which never flipped it)
- Task 1 and Task 2 `<automated>` verify commands: exit 0 each; dispatcher 149 passed, root suite 279 pass / 0 fail, tsc-exit=0
- Tracer worktree `/var/lib/substrate/worktrees/ut-muh32wc1-d14818ff` and branch gone; `/tmp/03-05-tracer.py` deleted; `.planning/config.json`, `.planning/state.json` and `issues/` left unstaged; STATE.md and ROADMAP.md untouched
