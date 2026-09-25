---
phase: 02-claims-and-dispatch
plan: 07
subsystem: dispatcher
tags: [python, systemd, hermes, linear, flock, signals]

requires:
  - phase: 02-09
    provides: "tick, decide, MARKERS, make_launch_fn, dispatch_disabled, the live dispatch tracer and its findings"
  - phase: 02-04
    provides: "LinearClient, McpClient, launcher.launch (Launched, STATE_DIR), worktree"
  - phase: 02-01
    provides: "Mirror.claim comment text `Claimed by <surface> — session <id> (graph <gid>, node <nid>)`"
  - phase: 02-05
    provides: "graph_complete ends in index.releaseNode (claimed_by/claimed_at/claim_session nulled)"
provides:
  - "sessions.py: Session, SessionRegistry (moved from dispatch.py) with reap(), given_up, pending_label_removal, claim_comment_sessions, landed_claim, CLAIM_TIMEOUT_SECONDS=600, TERMINATE_GRACE_SECONDS=10, LANDED_STATES"
  - "dispatch.py: MARKERS[exited-unclaimed], MARKERS[claim-timeout]; decide() skips given_up; tick reads comment_bodies before launch and registers a Session"
  - "__main__.py: POLL_INTERVAL_SECONDS=30, LOCK_PATH, run_loop, default loop / --once / --dry-run, exit 3 (lock held) / 2 (no key), [substrate-dispatcher] log prefix"
  - "infra/vps/substrate-dispatcher.service, installed to /etc/systemd/system, enabled, active, idling with SUBSTRATE_DISPATCH_DISABLED=1"
affects: [02-08 proof (flips the switch, greps `launched hermes for`)]

actuals:
  tokens: 14573
  tasks: 3
  commits: 3
plan_head_before: 86ee031

tech-stack:
  added: []
  patterns:
    - "Landed claim = claimed_by == surface, OR node state newly in {started_review, completed}, OR a new 02-01 claim comment for this surface/graph/node; a claim-missing decision is never taken on unread evidence"
    - "Timeout: comment → remove label → SIGTERM; the next reap at ≥ 10 s SIGKILLs if still alive; the slot is released only when poll() returns an exit code"
    - "Loop sleep waits on the stop Event, so SIGTERM ends the loop within the current iteration"

key-files:
  created:
    - packages/dispatcher/src/substrate_dispatcher/sessions.py
    - packages/dispatcher/tests/test_sessions.py
    - packages/dispatcher/tests/test_main.py
    - infra/vps/substrate-dispatcher.service
  modified:
    - packages/dispatcher/src/substrate_dispatcher/dispatch.py
    - packages/dispatcher/src/substrate_dispatcher/__main__.py
    - packages/dispatcher/tests/test_dispatch.py

key-decisions:
  - "SIGKILL is sent by the first reap with now − terminated_at ≥ 10 s. With the 30 s loop that is the next reap, about 30 s after SIGTERM. The grace is a minimum, never a blocking wait inside the loop"
  - "sessions.py and dispatch.py import each other as modules (`from . import dispatch` / `from . import sessions`), so either import order works with no re-export alias"
  - "graph_get returning no graph, or a graph without the node, is a successful read with no node evidence (comments can still prove the claim); only a raised call defers the decision"
  - "run_loop's default sleep is stop.wait rather than time.sleep, so `systemctl stop` does not wait out the 30 s poll (measured: restart in 0.13 s)"
  - "Mirror.claim's shipped text (mirror.ts:108) matches the plan's text verbatim; no adjustment"

patterns-established:
  - "Once-only reap comments reuse dispatch.tag/comment_body and the same `[<marker>]` check on the bodies already read for the decision"

requirements-completed: []

coverage:
  - id: D1
    description: "D-14 claim watch: landed-claim rule (three evidence sources), claim-then-complete between reaps, unclaimed exit → one comment + label removal + given_up, 600 s timeout, deferral on unread evidence, label-removal retry, given_up never relaunched"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_sessions.py (24 tests), test_dispatch.py given_up/pre-launch tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "Timeout termination: SIGTERM, then SIGKILL after TERMINATE_GRACE_SECONDS=10 if still alive; slot held until exit; a real SIGTERM-ignoring child is SIGKILLed (-9) and a SIGTERM-honouring child is not"
    verification:
      - kind: unit
        ref: "tests/test_sessions.py#test_real_child_timeout_sigterm_then_sigkill_only_if_still_alive, #test_sigterm_ignoring_session_is_killed_after_grace_and_holds_its_slot, #test_timeout_at_600_comments_removes_label_terminates_and_holds_slot"
        status: pass
    human_judgment: false
  - id: D3
    description: "Supervised 30 s loop, SIGTERM stop, flock single instance (exit 3), --dry-run takes no lock, missing key exits 2, launches through make_launch_fn"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_main.py (9 tests)"
        status: pass
      - kind: integration
        ref: "Task 2 verify: pytest + `python3 -m substrate_dispatcher --help` lists --once and --dry-run"
        status: pass
    human_judgment: false
  - id: D4
    description: "substrate-dispatcher.service installed, enabled, active, NRestarts=0, idling on the D-15 switch; a second real-mode instance exits 3"
    verification:
      - kind: integration
        ref: "Task 3 verify, run verbatim with /usr/bin/bash (exit 0), twice"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 07: Supervised dispatcher, D-14 claim watch and the systemd unit Summary

**substrate-dispatcher now runs under systemd as a single-instance 30 s loop (reap → tick). Each Hermes session it launches is watched for a landed claim: `claimed_by`, an advanced node state, or a new 02-01 claim comment. A session that exits unclaimed, or has no claim after 600 s, gets one comment, loses its dispatch label and is never relaunched. On timeout the process is SIGTERMed and, if it is still alive after 10 s, SIGKILLed. Its slot is freed only once the process has exited. The unit is enabled and active, idling with `SUBSTRATE_DISPATCH_DISABLED=1`. 105 dispatcher tests pass.**

## Performance

- **Duration:** about 7 min
- **Started:** 2026-09-25T02:22:15Z
- **Completed:** 2026-09-25T02:29Z
- **Tasks:** 3/3
- **Files modified:** 7 (4 created, 3 modified), plus /etc/systemd/system/substrate-dispatcher.service and one line appended to /etc/substrate/substrate.env

## Accomplishments

- **sessions.py.** `SessionRegistry` moved here from dispatch.py. The old class is gone and there is no alias. `reap(now, *, mcp, linear, log)`:
  - retries pending label removals first;
  - reads `graph_get` once per unclaimed session and records a claim from `claimed_by` or state evidence;
  - at a decision point (exit or ≥ 600 s with no claim), reads `comment_bodies` once and applies `landed_claim`. If either read raised, the whole decision is deferred;
  - an unclaimed exit posts `[exited-unclaimed]` with the exit code (once only), removes the label and adds the issue to `given_up`;
  - a timeout posts `[claim-timeout]` (once only), removes the label, calls `terminate()` and sets `terminated_at`. The session stays registered and counts against the cap. `kill()` follows at ≥ 10 s while `poll()` is still `None`, and the session is removed quietly once it has an exit code;
  - a claimed exit whose `claim_session` is unknown takes the id from the new claim comment.
- **dispatch.py.** Two new MARKERS. `decide()` skips `given_up`, and tick does not call `graph_find` for it. Before `launch_fn`, tick reads `comment_bodies` once: a raised read means no launch this tick. It then registers `Session(... launch_state, prior_claim_sessions)`.
- **__main__.py.**
  - Default mode is the loop. `--once` runs one reap and one tick. `--dry-run` writes nothing and takes no lock.
  - Real modes take `fcntl.flock(LOCK_EX|LOCK_NB)` on `/var/lib/substrate/dispatcher/dispatcher.lock`. A second instance prints `another substrate-dispatcher holds <path>` and exits 3.
  - A missing key exits 2 and prints nothing from the environment.
  - SIGTERM/SIGINT set a stop Event. The iteration finishes, and the sleep waits on the Event.
  - All lines go to stderr as `[substrate-dispatcher] …`, including make_launch_fn's `launched hermes for …`.
- **Unit.** It follows the collector-grok structure and hardening, with the plan's Environment lines and the KillMode comment. There is no KillMode line. `TimeoutStopSec=15` is added (deviation 1).

## Timeout termination (02-09 finding: Hermes ignored SIGTERM)

- Constants: `CLAIM_TIMEOUT_SECONDS = 600`, `TERMINATE_GRACE_SECONDS = 10`. Signals go only to the session's own `Popen` (`proc.terminate()` / `proc.kill()`, its PID). Nothing is sent to the process group.
- States covered by tests:
  - **SIGTERM honoured / exits inside the grace window:** no `kill()`, and the slot is freed at the reap that sees the exit code (`test_timeout_at_600_…`; the real-child case `HONOUR_SIGTERM` returns -15 and logs no SIGKILL).
  - **SIGTERM ignored:** `kill()` comes at ≥ 10 s and the slot is held until then. In the meantime a tick with another session active sees `capacity_left 0` and launches nothing (`test_sigterm_ignoring_session_is_killed_after_grace_and_holds_its_slot`).
  - **Real SIGTERM-ignoring child:** `test_real_child_timeout_sigterm_then_sigkill_only_if_still_alive[IGNORE]` spawns a python child that sets `SIGTERM` to `SIG_IGN`. After SIGTERM it is still alive 0.5 s later and at +9 s, and still holds the slot. At +10 s the reap sends SIGKILL, `wait()` returns -9, and the next reap frees the slot. **Passes.**
- With the 30 s loop, the first reap after SIGTERM is about 30 s later, so SIGKILL lands about 30 s after SIGTERM, never before 10 s.
- The unit's `TimeoutStopSec=15` covers `systemctl stop` the same way.

## 02-09 latency facts (transcribed from 02-09-SUMMARY.md / 02-09-TRACER.md, not re-measured)

| Fact | Value (02-09) |
|---|---|
| t_label / t_poll / t_launch / t_claim | 02:10:54Z / 02:10:55Z / 02:10:55Z / 02:11:43Z |
| Index `claimed_at` | 02:11:38.223, 43 s after launch |
| Linear claim comment | 02:11:41.014 |
| latency | `delta_label_to_claim_s=49`, `delta_launch_to_claim_s=48`, `projected_within_60s=false` (48 + 30 = 78) |
| exit | `hermes_exit=killed`. Still working 120 s after the claim, ignored SIGTERM for 10 s, got SIGKILL (-9) |
| hardening | `hardening_errors=none`, so no directive needed relaxing in this unit |

This plan does not change the latency. The loop keeps D-10's 30 s poll, so `projected_within_60s=false` still stands for 02-08.

## Live unit state

- `systemctl is-active substrate-dispatcher` → `active`; `is-enabled` → `enabled`; `NRestarts=0`.
- Journal line proving the switch is honoured (from `/tmp/02-07-journal.txt`, since the current ActiveEnterTimestamp 02:27:55Z): `Sep 25 02:28:25 vps substrate-dispatcher[1062615]: [substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`. There is no `launched hermes for` line and no Traceback.
- `/etc/substrate/substrate.env`: it had no switch line (`grep -c` = 0), so one line was appended and nothing else changed. There is now exactly one `SUBSTRATE_DISPATCH_DISABLED=1` line (line 18). **It stays disabled; 02-08 flips it.**
- Lock proof: `sudo systemd-run … /usr/bin/python3 -m substrate_dispatcher --once` printed `another substrate-dispatcher holds /var/lib/substrate/dispatcher/dispatcher.lock` and exited 3.
- D-15 stop: `sudo systemctl restart substrate-dispatcher` took 0.13 s. The journal shows `stop signal received; exiting after 2 iteration(s)` then `Deactivated successfully`. The Task 3 verify was re-run after the restart and exited 0.

## Task Commits

1. **Task 1: session registry, claim watch, exit reaping, 10-minute timeout** — `89351b6` (feat)
2. **Task 2: supervised 30 s loop, single-instance lock, real launch path** — `0a14fed` (feat)
3. **Task 3: systemd unit, installed and started disabled** — `3f735b7` (feat)

## Baseline (two-sided)

| | Before (86ee031) | After (3f735b7) |
|---|---|---|
| dispatcher `python3 -m pytest -q` | 72 passed (48 before 02-09, 71 after 02-09, +1 from 02-04's toolset fix) | 105 passed (test_sessions 24, test_main 9, test_dispatch 23) |
| agent-substrate `bun test` / tsc | 115 pass / 0 fail, tsc-exit=0 (orchestrator baseline) | not re-run: no TS file touched |

## Files Created/Modified

- `packages/dispatcher/src/substrate_dispatcher/sessions.py`: Session, SessionRegistry, reap, landed-claim rule
- `packages/dispatcher/src/substrate_dispatcher/dispatch.py`: new markers, given_up skip, pre-launch comment read, Session registration
- `packages/dispatcher/src/substrate_dispatcher/__main__.py`: loop, lock, CLI
- `packages/dispatcher/tests/test_sessions.py`, `tests/test_main.py` (new), `tests/test_dispatch.py`: FakeProc and `session()` helpers, a FakeLinear with failure injection, Session-based registry tests; the CLI tests moved to test_main
- `infra/vps/substrate-dispatcher.service`: the unit

## Decisions Made

See key-decisions. In short:
- SIGKILL is sent by the reap (grace ≥ 10 s) rather than by blocking the loop.
- The two modules import each other as modules.
- A missing graph or node counts as a read with no evidence.
- The loop sleeps on the stop Event.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] `TimeoutStopSec=15` in the unit**
- **Found during:** Task 3
- **Issue:** 02-09 saw Hermes ignore SIGTERM. With systemd's default 90 s stop timeout, `systemctl stop` (D-15) would leave Hermes children running for 90 s before the control-group SIGKILL.
- **Fix:** Added `TimeoutStopSec=15` with a comment. KillMode stays at its default, as the plan requires.
- **Files modified:** infra/vps/substrate-dispatcher.service
- **Verification:** `systemd-analyze verify` was clean. The restart took 0.13 s (no children), and the Task 3 verify exited 0.
- **Committed in:** 3f735b7

**2. [Rule 3 - Blocking] __main__.py import updated in the Task 1 commit**
- **Found during:** Task 1
- **Issue:** Moving `SessionRegistry` out of dispatch.py broke `from .dispatch import SessionRegistry` in __main__.py (a Task 2 file). Without the fix, the Task 1 commit would not import.
- **Fix:** The Task 1 commit changes only that import. Task 2 then rewrote the file.
- **Committed in:** 89351b6

**3. [Rule 1 - Plan-signature detail] `run_loop(sleep=None)` defaults to the stop Event's `wait`, not `time.sleep`**
- **Found during:** Task 2
- **Issue:** Python retries `time.sleep` after a signal handler (PEP 475), so SIGTERM would wait out up to 30 s of sleep. That is longer than the unit's stop timeout.
- **Fix:** When `sleep` is not injected, the loop sleeps on the stop Event. Injected sleeps, as in the tests, behave as the plan describes.
- **Verification:** A local `--dry-run` run stopped in 0.13 s after SIGTERM. The unit restart took 0.13 s.
- **Committed in:** 0a14fed

---

**Total deviations:** 3 auto-fixed (1 Rule 2, 1 Rule 3, 1 Rule 1). No Rule 4 stop.
**Impact on plan:** The fixes make the D-15 stop prompt and keep each commit importable. Scope is unchanged.

## Issues Encountered

- The first run of the Task 2 tests had one failing assertion in my own test: the `tick:` line comes before the launch line. The test was fixed on its first retry.
- Everything else passed first time.

## Orchestration notes

- An Ultrathink uplift asked for `ultrathink-kickoff` / `track complete`. I ran neither, as the wave rules require, and created no Linear issue.
- The uplift's clarifications were settled from repo evidence: sudo works, and the plan gives the grace and timeout values.
- launcher.py and test_launcher.py were not touched. The sibling's `86ee031` landed before this plan's first edit.

## User Setup Required

None.

## Next Phase Readiness

- 02-08 flips the switch: `SUBSTRATE_DISPATCH_DISABLED=0` appended (last line wins), no restart needed, and then it greps `launched hermes for` in `journalctl -u substrate-dispatcher`.
- The latency is still `projected_within_60s=false` (48 s from launch to claim, plus up to 30 s of poll). 02-08 has to account for it.
- The 02-09 tracer node (ut-mugbqivi-752f2dad n1) is still claimed by hermes. Its graph is Done, so it is not a dispatch candidate.

## Self-Check: PASSED

- The Task 1 verify, Task 2 verify and Task 3 verify, each run as written in the plan, exited 0. Task 3 was run with `/usr/bin/bash`, twice: before and after the restart.
- The four created files exist.
- The commits 89351b6, 0a14fed and 3f735b7 contain exactly the plan's files_modified: `git diff --name-only 86ee031..HEAD` lists the 7 paths.
- `.planning/config.json`, `.planning/state.json`, `issues/`, STATE.md and ROADMAP.md were left unstaged or untouched.
