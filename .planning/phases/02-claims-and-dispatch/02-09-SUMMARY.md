---
phase: 02-claims-and-dispatch
plan: 09
subsystem: dispatcher
tags: [python, linear, mcp, hermes, git-worktree, systemd, tracer]

requires:
  - phase: 02-01
    provides: "graph_find, the Mirror.claim Linear transition and its claim comment"
  - phase: 02-04
    provides: "LinearClient, McpClient, repo_checkout, ensure_worktree, WorktreeRefused, launch"
provides:
  - "dispatch.py: DISPATCHABLE_SURFACES, COMMENT_PREFIX, MARKERS, Decision, SessionRegistry (cap 2, one per issue), dispatch_disabled, decide, tick, make_launch_fn"
  - "python3 -m substrate_dispatcher --once --dry-run (SUBSTRATE_ENV_FILE, default /etc/substrate/substrate.env)"
  - "Log contract: `tick: <n> candidate issue(s)`, `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`, `launched hermes for <identifier> graph <g> node <n> pid <pid> worktree <path> log <path>`, and in dry-run `<identifier> dispatch:<surface> → <action>: <reason>`"
  - "02-09-TRACER.md: a measured label → claim run on SWC-466 / ut-mugbqivi-752f2dad"
affects: [02-07 supervised loop, D-14 watch and unit, 02-08 proof, 02-04 DEFAULT_TOOLSETS]

actuals:
  tokens: 8638
  tasks: 2
  commits: 2
plan_head_before: 99837b1

tech-stack:
  added: []
  patterns:
    - "Once-only dispatcher comments: body `substrate-dispatcher: [<marker>] <text>`. tick posts it only when no comment among the issue's last 50 contains `[<marker>]`"
    - "D-15 switch: the last SUBSTRATE_DISPATCH_DISABLED= line of the env file wins, and the process env applies only when the file lacks the key"
    - "The live tracer runs a harness under systemd-run with EnvironmentFile and the collector-grok hardening, so the key never leaves the process"

key-files:
  created:
    - packages/dispatcher/src/substrate_dispatcher/dispatch.py
    - packages/dispatcher/src/substrate_dispatcher/__main__.py
    - packages/dispatcher/tests/test_dispatch.py
    - .planning/phases/02-claims-and-dispatch/02-09-TRACER.md
  modified: []

key-decisions:
  - "t_launch is Launched.started_at, the launcher's clock just before popen, not the time the tick returned"
  - "A WorktreeRefused marker without a MARKERS entry cannot occur: all five 02-04 markers, including git-failed, have a text"
  - "hermes_session_id stays `none` as the harness printed it (the log has no `session_id:` line). The export-confirmed id is on its own line, `hermes_export_session_id`"

patterns-established:
  - "Decision rows: launch | comment (with marker) | skip; a dry run logs them and writes nothing"

requirements-completed: []

coverage:
  - id: D1
    description: "SC-3 dispatch tracer: a labelled throwaway issue went through poll → one tick → graph_find → worktree → real Hermes session, and that session claimed n1 as hermes (observed via graph_get claimed_by and the Linear claim comment)"
    verification:
      - kind: e2e
        ref: "02-09 Task 1 verify (tracer-linear-ok) on SWC-466 / ut-mugbqivi-752f2dad"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-10/D-11/D-14 cap/D-15 decision table, once-only comments, WorktreeRefused → marker comment, dry run with no writes"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_dispatch.py (23 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "--once --dry-run CLI against live Linear and substrate-mcp under the production env file; graph_find resolves the 02-01 tracer issue"
    verification:
      - kind: integration
        ref: "02-09 Task 2 verify (tick line in /tmp/02-09-dry.txt, find-ok)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 09: Dispatch tick, decision table and the live dispatch tracer Summary

**A throwaway issue, SWC-466, was labelled `dispatch:hermes`. The dispatcher's own poll saw it within 1 s. One `tick` resolved it through `graph_find`, created `/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad` and started a real Hermes session under the unit's hardening. That session claimed n1 as hermes 48 s after launch. Linear now shows In Progress with `agent:hermes`, and the dispatch label is gone. With the real 30 s poll the projection is 78 s, so `projected_within_60s=false`. The full decision table and the `--once --dry-run` CLI are implemented, and 71 dispatcher tests pass.**

## Performance

- **Duration:** about 15 min, ending at 02:17Z. The live tracer took 3 min 1 s of it (02:10:52Z → 02:13:53Z).
- **Tasks:** 2/2
- **Files created:** 4

## Accomplishments

- `dispatch.py`:
  - `dispatch_disabled` implements the D-15 last-line-wins rule. An unreadable file falls back to the process env, and nothing else in the file is logged.
  - `decide` checks in this order: non-dispatchable → comment, active → skip, no node → comment, claimed → comment naming the holder, capacity → skip, else launch.
  - `tick` makes no client call while disabled. It calls `graph_find` only for hermes candidates without a session. An error in one candidate is logged and does not stop the next. Comments are once-only. A `WorktreeRefused` becomes its marker's comment. A dry run logs each decision and writes nothing.
  - `SessionRegistry` holds at most 2 sessions, one per issue.
  - `make_launch_fn` runs `repo_checkout → ensure_worktree → launch` and logs the `launched hermes for …` line.
- `__main__.py`: `main(argv)` accepts only `--once --dry-run`. Any other combination exits 2 with argparse's `only --once --dry-run is supported`. A missing key prints `substrate_dispatcher: LINEAR_API_KEY not set` to stderr and exits 2. Both clients are closed in `finally`.
- `test_dispatch.py`: 23 tests, one per behaviour bullet of both tasks. They use fake Linear and MCP clients that record calls, and a temp env file.

## Live tracer (02-09-TRACER.md)

| Key | Value |
|---|---|
| tracer issue | SWC-466 `d5b9c622-c760-4ee4-89d0-3dbaab0a1ab5`. GitHub twin swcstudiospace/agent_runtime#326 (observed in the sync comment; nothing was done on GitHub) |
| graph | `ut-mugbqivi-752f2dad` (now `Done`) |
| t_label / t_poll / t_launch / t_claim | 02:10:54Z / 02:10:55Z / 02:10:55Z / 02:11:43Z |
| claim_evidence | `claimed_by` (graph_get n1 `claimed_by=hermes`). The Linear comment `Claimed by hermes — session 20260925_021057_7310e5 (graph ut-mugbqivi-752f2dad, node n1)` is timestamped 02:11:41.014Z |
| claim_session | `20260925_021057_7310e5` |
| Hermes session | `hermes sessions export --format jsonl --session-id 20260925_021057_7310e5` printed `Exported 1 session`: source `substrate-dispatcher`, model `claude-fable-5-1`, title `Claim node n1 and work Linear SWC-466`, 19 tool calls, 39 messages. The first tool call is the `graph_claim` curl with `surface hermes` and this session id. `hermes_session_id=none`, because the log has no `session_id:` line: the tracer killed the session before `-Q` could print it |
| latency | `delta_label_to_claim_s=49`, `delta_launch_to_claim_s=48` (index `claimed_at` 43 s after launch), `projected_within_60s=false` (48 + 30 = 78) |
| exit | `hermes_exit=killed`. The session was still working 120 s after the claim, ignored SIGTERM for 10 s, and got SIGKILL (-9). `completion_observed=false` |
| worktree | `/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad  99837b1 [substrate/ut-mugbqivi-752f2dad]`, clean porcelain, kept for D-12 reuse |
| hardening | `hardening_errors=none` |
| D-12 | `free_disk_gb_before=30`, `main_branch_before=main`, and the main checkout is still on `main` |

## Decision table results

| Rule | Unit evidence | Live evidence |
|---|---|---|
| D-10: poll dispatch:* unstarted, then `graph_find` before deciding | `test_valid_unclaimed_hermes_candidate_launches_once`, `test_graph_find_error_is_logged_and_next_candidate_still_processed` | Tracer: `dispatch_candidates()` listed SWC-466, and the tick's `graph_find` led to `launch`. The dry run printed `tick: 0 candidate issue(s)`. `graph_find` on the 02-01 issue returned `{"found": true, "graph_id": "ut-mugb3vwa-c57eb6ac", ... "graph_status": "Done", "node": {"state": "completed", "claimed_by": null}}`, then `find-ok` |
| D-11: only hermes launches; other surfaces get one comment, label kept | `test_non_hermes_surface_comments_once_and_leaves_label` (a second tick posts nothing; no `remove_label`) | not exercised live (no non-hermes label was created) |
| Refusals: no node / already claimed → once-only comment, no launch; `WorktreeRefused` → `[<marker>]` comment | `test_unregistered_issue_gets_one_no_node_comment`, `test_claimed_node_gets_one_already_claimed_comment_naming_holder`, `test_worktree_refused_becomes_one_once_only_marker_comment` | — |
| D-14 cap: at most 2 sessions, one per issue; at capacity → skip, decided again next tick | `test_registry_cap_and_one_per_issue`, `test_at_capacity_skips_and_decides_again_next_tick`, `test_issue_with_running_session_is_skipped_without_graph_find` | The tracer bounded its session at 600 s for the claim plus 120 s for the exit, and ran exactly one tick |
| D-15: the last line of the env file wins, and the process env applies when the key is absent | `test_disabled_env_file_makes_no_client_call`, `test_env_file_value_wins_over_process_env`, `test_process_env_decides_when_file_lacks_key`, `test_last_line_wins` (both orders), `test_unreadable_env_file_falls_back_to_process_env` | The tracer and the dry run both ran with `-E SUBSTRATE_DISPATCH_DISABLED=0` and no key in the file, so both ticks ran |
| Dry run writes nothing | `test_dry_run_never_launches`, `test_dry_run_logs_every_decision_and_writes_nothing` | the live `--once --dry-run` exited 0 |
| CLI | `test_cli_rejects_anything_but_once_dry_run` (×3), `test_cli_without_linear_key_exits_2_and_prints_no_environment` | the systemd-run dry run exited 0 |

## Task Commits

1. **Task 1: tick, launch path and the live dispatch tracer**: `06b15d6` (feat). Contains dispatch.py, test_dispatch.py and 02-09-TRACER.md.
2. **Task 2: decision table, once-only comments and the `--once --dry-run` CLI**: `d3b0096` (feat)

## Baseline (two-sided)

| | Before (orchestrator, HEAD after wave 2) | After (d3b0096) |
|---|---|---|
| agent-substrate `bun test` | 115 pass / 0 fail | 115 pass / 0 fail (no TS touched) |
| tsc normalized set | `tsc-exit=0` | `tsc-exit=0` |
| dispatcher `python3 -m pytest -q` | 48 passed | 71 passed |
| hermes-linear-connector pytest | 60 passed / 2 skipped | 60 passed / 2 skipped (untouched) |

## Deviations from Plan

**1. [Observation, not fixed: outside files_modified] `mcp-linear` is not a valid Hermes toolset at start-up**
- The session log's first line is `Warning: Unknown toolsets: mcp-linear`. 02-04's DEFAULT_TOOLSETS evidence came from reading the code, and this run contradicts it: the session had no Linear tool.
- The claim uses only `terminal`, so it was unaffected. Prompt step 3, "read the issue with your Linear tool", cannot work as launched.
- The fix belongs in launcher.py (02-04), which is not this plan's file. 02-07 has to settle the toolset name before 02-08.

**2. [Observation] Hermes loads its own Linear key from a different workspace**
- The substrate key did not reach Hermes. Hermes found its own `LINEAR_API_KEY`, which belongs to workspace `swcstudio`, team `SPE`, not `spectrumwebco` / `SWC`. With it, the SWC issue lookup answered `Entity not found: Issue`, and one request hit that key's rate limit (`2500 requests per 1 hour`).
- The session never read SWC-466's text.

**3. [Observation] SIGTERM did not end Hermes within 10 s.** The session was SIGKILLed. 02-07's reaper needs the kill fallback.

**4. [Observation] Headless approval blocks were hit.** Hermes itself blocked a `curl | python3` pipe and a heredoc (text verbatim in TRACER Findings). `--yolo` stays off, as D-13 requires.

**5. [Record] `hermes_session_id=none` at column 0**
- The plan reads the id only from the session log, and the log has none because the tracer killed the session before `-Q` printed it.
- The real id, 20260925_021057_7310e5, is proven by `hermes sessions export` and by the claim. It is recorded as `hermes_export_session_id`, and no id was guessed.

**Total deviations:** none to code or scope. There are 4 live findings for 02-07 and 02-08, and 1 recording note.

### Orchestration notes

- An Ultrathink uplift arrived mid-plan. It asked for `ultrathink-kickoff` / `track complete`, which create Linear rows. I ran neither, as the wave rules require. It also treated `--dry-run` as the tracer's mode, which contradicts the plan: the tracer's tick runs with `dry_run=False`, and the CLI is dry-run only. I followed the plan.
- The uplift's graph lists SPE-401…SPE-452 in the `swcstudio` workspace. Those rows came from the Ultrathink planning pass, not from this executor. They may explain the rate limit Hermes hit on that workspace's key [INFERENCE].
- This plan created exactly one Linear issue, SWC-466. SWC capacity is now 249/250 [INFERENCE: 248 before + 1; not re-counted], which leaves one slot for 02-08.

## Issues Encountered

- The tracer node n1 is still claimed by hermes, with session 20260925_021057_7310e5 and state `started`, because the session was killed before `graph_complete`. The graph is marked `Done`, so it drops out of briefs. The plan leaves the issue as it is.

## Threat Flags

None beyond the register:
- T-02-09-02: the OnlyTracer wrapper and one tick held.
- T-02-09-04: the key was only in the systemd-run process. The harness printed no environment, and `sudo grep -c` was the only probe of substrate.env.
- T-02-09-05: the worktree is clean, and main's porcelain is unchanged except for this plan's own file.

## Next Phase Readiness

- 02-07 can move `SessionRegistry` to sessions.py and wrap `tick` in the 30 s loop.
- Before 02-08, 02-07 has to resolve the latency (48 s from launch to claim, plus up to 30 s of poll) and the `mcp-linear` toolset.
- The claim-watch rule in the tracer (claimed_by → started_review/completed → claim comment) is the one 02-07's watch copies.

## Self-Check: PASSED

- The Task 1 verify, extracted verbatim from the plan and run with `/usr/bin/bash`, exited 0: 12 passed and `tracer-linear-ok`. Every key appears exactly once at column 0, `claim_evidence=claimed_by`, `claim_observed=true`, `main_branch_before=main`, free disk 30 ≥ 5, and the worktree is on `[substrate/ut-mugbqivi-752f2dad]`.
- The Task 2 verify, run the same way, exited 0: 71 passed, `tick: 0 candidate issue(s)` and `find-ok`.
- The four created files exist. Commits `06b15d6` and `d3b0096` are on `main` and touch only the plan's files_modified. `.planning/config.json`, `.planning/state.json`, `issues/`, STATE.md and ROADMAP.md were left alone.
