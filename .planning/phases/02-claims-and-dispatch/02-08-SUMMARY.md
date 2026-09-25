---
phase: 02-claims-and-dispatch
plan: 08
subsystem: dispatcher
tags: [proof, linear, notion, hermes, dispatch, dod-gate, live]

requires:
  - phase: 02-06
    provides: "Notion Issue-row mirror: Agent on claim; Status, Linear State and Completed on a gated Done; parent check before PATCH"
  - phase: 02-07
    provides: "substrate-dispatcher unit (30 s loop, D-14 claim watch, D-15 switch)"
  - phase: 02-09
    provides: "Tracer prediction projected_within_60s=false (launch → claim 48 s)"
provides:
  - "02-PROOF.md: an observed, timestamped Phase 2 proof on SWC-467 / ut-mughkkc0-73909228 (run 5), with failed runs 1–4 kept under ## Failed runs"
  - "Owner verification: owner_verified=approved 2026-09-25"
affects: [phase 2 verification, phase 3 dispatch:claude-code, Hermes launch prompt, Hermes pre_llm_call hook latency]

actuals:
  tokens: 34000
  tasks: 3
  commits: 7
plan_head_before: 4a984f2f1d9c33dc036071043e19074f57b014bf

tech-stack:
  added: []
  patterns:
    - "Keyed live checks run in one systemd-run process with EnvironmentFile. The scripts print key=value lines only and are deleted afterwards"
    - "Repeated runs are kept, indented, under ## Failed runs, so each verify key appears exactly once at column 0"

key-files:
  created:
    - .planning/phases/02-claims-and-dispatch/02-PROOF.md
    - .planning/phases/02-claims-and-dispatch/02-08-SUMMARY.md
  modified: []

key-decisions:
  - "Owner: CLAIM_TIMEOUT_SECONDS raised to 900, longer than Hermes' 600 s 429 backoff (a6e9604, D-14 amended)"
  - "Owner: dispatch uses SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5 (be5e34d, D-13 amended). claude-fable-5-1 was rate-limited per model"
  - "Owner: re-runs reuse SWC-467 and graph ut-mughkkc0-73909228, because the Linear free plan is capped (D-16 amended)"
  - "Owner: dispatch stays off except during the proof, so dispatch_switch_final=1 (the plan said 0)"
  - "Operator completion: the model could not read the issue text, so the operator called graph_complete with surface hermes, the claim session and DoD evidence, as the plan allows"

patterns-established:
  - "Each proof observation records a UTC first-seen time from a 5 s poll across the journal, graph_get, Linear, Notion and both scoped and unscoped POST /brief"

requirements-completed: []

coverage:
  - id: D1
    description: "SC-3: a dispatch:hermes label on a real issue started a real Hermes session in /var/lib/substrate/worktrees/<gid> on substrate/<gid> while the main checkout stayed on main"
    verification:
      - kind: e2e
        ref: "02-PROOF.md run 5: journal 'launched hermes for SWC-467 …', /proc cwd and argv, hermes sessions export 20260925_065059_f7cea2"
        status: pass
    human_judgment: false
  - id: D2
    description: "SC-1: the Hermes session claimed n1. Linear showed In Progress, agent:hermes, no dispatch:hermes, and a session comment. Notion showed Agent hermes. POST /brief showed 'started by hermes'"
    verification:
      - kind: e2e
        ref: "02-PROOF.md t_claim, t_linear_in_progress, t_notion_agent, t_brief; Task 2 verify exit 0 (proof-linear-ok)"
        status: pass
    human_judgment: false
  - id: D3
    description: "SC-2: gated Done through hermes-linear-connector. Linear moved In Review → Done; Notion got Status Done, Linear State Done and Completed 2026-09-25; the PR fields did not change"
    verification:
      - kind: e2e
        ref: "02-PROOF.md completion=operator, final_linear_state=Done, notion_*_final, pr_fields_unchanged=true"
        status: pass
    human_judgment: false
  - id: D4
    description: "Owner confirmation in a real Claude Code prompt, in Linear and in Notion"
    verification: []
    human_judgment: true
    rationale: "The plan requires the owner to confirm the brief in a real Claude Code prompt. The owner answered 'approved'."

duration: 2h12m
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 08: Live dispatch:hermes proof Summary

**On SWC-467, a `dispatch:hermes` label led substrate-dispatcher to launch a real Hermes session (claude-opus-5.5) in the per-graph worktree. The session claimed n1 as hermes. The claim reached Linear (In Progress, `agent:hermes`, session comment), the Notion Issue row (Agent hermes) and Claude Code's brief (`n1 SWC-467 started by hermes`). The node then closed through the connector's DoD gate, which moved Linear to Done and set Notion Status, Linear State and Completed. It took five runs. Label → brief took 65 s (`within_60s=false`). Completion was done by the operator, because the dispatched model could not read the issue text. The owner approved the proof with both shortfalls.**

## Performance

- **Duration:** about 2 h 12 min (04:53Z → 07:05Z), including the owner decisions between runs
- **Tasks:** 3/3 (Task 3: owner "approved")
- **Files:** 2 planning files. No source change by this plan.

## Runs

| Run | Label (UTC) | Hermes session | Outcome |
|---|---|---|---|
| 1 | 04:57:30 | none (pid 1363134) | Exited with code 1 at import: `ModuleNotFoundError: No module named 'prompt_toolkit.document'`. D-14 `[exited-unclaimed]` |
| 2 | 05:02:15 | 20260925_050221_4dcd47 | Anthropic 429 on the first call. The 600 s backoff equalled the 600 s claim timeout, so D-14 `[claim-timeout]` fired first |
| 3 | 05:13:46 | 20260925_051412_dc133a | The same 429. D-14 timeout at 05:24:27 |
| 4 | 05:38:32 | 20260925_053855_6e606f | With the 900 s timeout: 429 at 05:39:29 and again on the retry at 05:49:30 (`claude_code unavailable for model claude-fable-5-1`). D-14 timeout at 05:54:20 |
| **5 (proof)** | **06:50:33** | **20260925_065059_f7cea2** | **`-m claude-opus-5.5`. Claim at 06:51:37.753; Linear, Notion and the brief all mirrored it; operator graph_complete → Done** |

## Run 5 key values (02-PROOF.md)

| Key | Value |
|---|---|
| t_label / t_launch / t_claim | 06:50:33.150Z / 06:50:58.162Z / 06:51:38.153Z (`claimed_at` 06:51:37.753Z) |
| t_linear_in_progress / t_notion_agent / t_brief | 06:51:43.153Z / 06:51:43.586Z / 06:51:38.154Z |
| brief_evidence / brief_line | `node_line` / `Nodes: n1 SWC-467 started by hermes just now`; the unscoped brief showed `- 06:51 hermes       claimed SWC-467 (n1)` |
| delta_label_to_brief_s / within_60s | 65 / false |
| Latency breakdown | label → launch 24.5 s; launch → turn start 3.8 s; `pre_llm_call` hook timeout 30.9 s; API call #1 4.2 s; launch → `claimed_at` 40.1 s |
| completion | `operator`: graph_complete with surface hermes, session 20260925_065059_f7cea2 and DoD evidence at 06:53:38.552Z → `completed: true` |
| Linear | In Progress → In Review 06:53:39.619 → Done 06:53:41.378 (connector). Final labels `["agent:hermes"]` |
| Notion | Agent hermes, Status Done, Linear State Done, Completed 2026-09-25, `pr_fields_unchanged=true` |
| Export | source `substrate-dispatcher`, model `claude-opus-5-5`, 7 tool calls. The first is the `graph_claim` curl |
| dispatch_switch_final | 1 (owner-directed). The journal shows `dispatch disabled` |

Compared with the 02-09 tracer: launch → claim was about 43 s there (`claimed_at`) and 40.1 s here. In both, about 31 s is the `pre_llm_call` hook timeout. The tracer's `projected_within_60s=false` was confirmed at 65 s.

## Owner decisions

- **a6e9604:** `CLAIM_TIMEOUT_SECONDS` raised to 900. D-14 amended.
- **be5e34d:** `SUBSTRATE_DISPATCH_MODEL` added, with `claude-opus-5.5` in substrate.env. D-13 amended.
- **D-16 amended:** re-runs reuse SWC-467 and its graph.
- **Dispatch left off** after the proof, with `SUBSTRATE_DISPATCH_DISABLED=1` as the last line.
- **Task 3 resume signal:** "approved". The owner accepts `within_60s=false` (65 s) and `completion=operator`.

## Accepted shortfalls

1. `within_60s=false`: label → brief took 65 s.
2. `completion=operator`: the dispatched model could not read the issue text and stopped after the claim.

## Gaps (verbatim from 02-PROOF.md ## Gaps)

1. **`within_60s=false`: label → brief took 65 s** (`delta_label_to_brief_s=65`).
   - The segments: label → launch 24.5 s (poll phase), then launch → `claimed_at` 40.1 s.
   - This run confirms `tracer_projected_within_60s=false`. 02-09 predicted a miss: 48 s launch → claim + ≤ 30 s
     poll = 78 s. This run's real value, with a 24 s poll wait, is 65 s.
   - Recorded, not fixed. D-10's 30 s poll and the proof wording are locked.
2. **The 30 s Hermes `pre_llm_call` hook timeout is the dominant latency.** In every dispatched session it fires
   about 31 s after the turn starts: here turn 06:51:01.400 → hook timeout 06:51:32.279, then API call #1 at
   06:51:36.545 (`latency=4.2s`).
   - Without the hook, launch → claim would be about 9 s, and label → brief would have been about 34 s
     [INFERENCE: arithmetic on this run's timings, not measured].
   - [INFERENCE: name match only] The enabled `observability/langfuse` plugin defines `on_pre_llm_call`.
   - Recorded, not fixed.
3. **Issue text: the dispatched Hermes cannot read the issue, so the model did not finish the node.**
   - Prompt step 3 says `read issue SWC-467 with your Linear tool`, but the session runs with
     `-t terminal,file` and has no Linear tool.
   - Its own `LINEAR_API_KEY` belongs to workspace `swcstudio`/team `SPE`, so both lookups returned
     `Entity not found: Issue` (quoted from the export above).
   - The model stopped after the claim and asked for a Linear tool or the issue text. It did not call graph_complete.
   - So `completion=operator`: SC-2's gated Done was exercised by an operator call carrying the claim session,
     not by the model.
   - Recorded, not fixed.
4. **Deviation: model switch.** Runs 2–4 failed on an Anthropic per-model 429 on `claude-fable-5-1`. On the
   owner's decision, run 5 dispatched with `-m claude-opus-5.5` (be5e34d, `SUBSTRATE_DISPATCH_MODEL` in
   substrate.env, D-13 amended). The export reports `claude-opus-5-5`.
5. **Deviation: one issue reused across five runs.** This follows the one-issue cap (249/250) and D-16 as
   amended. SWC-467 carries the run-1/run-2 dispatcher comments and the label history of all five runs.
   Its GitHub twin, swcstudiospace/agent_runtime#327, was not touched by this plan.
6. **Deviation: `dispatch_switch_final=1`.** This was owner-directed. The plan says `0`.
7. **Run-1 `prompt_toolkit` import crash, unexplained.** Hermes exited with code 1:
   `ModuleNotFoundError: No module named 'prompt_toolkit.document'`. It did not reproduce, and the root cause
   was not established.
8. **Unexplained Linear label rows.** `dispatch:hermes` was added at 06:51:42.643Z and removed at 06:51:43.215Z,
   after the claim mirror had already removed it. Their source was not identified, and the final labels are
   `["agent:hermes"]`.
9. **Hermes and SIGTERM.** This run needed no termination: Hermes exited by itself with code 0. In runs 2–4
   Hermes honoured SIGTERM, so the reaper's SIGKILL fallback went unexercised in 02-08.
10. **The owner's Claude Code check is pending (Task 3).** POST /brief was run and observed, as recorded above.
    Whether a real Claude Code prompt shows it is for the owner to confirm.
11. **Verify results.**
    - Task 2 `<verify>`, run verbatim with `/usr/bin/bash` after run 5, exits **0** and prints `proof-linear-ok`.
      Its live Linear check found SWC-467 `Done`, carrying `agent:hermes` and not `dispatch:hermes`.
    - Task 1 `<verify>` exits 1 only on its final journal clause: the latest tick line is `dispatch disabled`,
      because of the owner-directed switch-off (item 6). With that clause removed, it exits 0.

(Gap 10 was resolved afterwards: the owner answered "approved". See 02-PROOF.md "Task 3 — owner verification".)

## Rows touched

| Store | Row | Final state |
|---|---|---|
| Linear | SWC-467 `3378743f-efc9-47f2-9962-3894dca6bb80`, the one issue this plan created | Done, `agent:hermes`. It carries 4 substrate comments ([exited-unclaimed], [claim-timeout], the hermes claim comment) plus the GitHub sync comment |
| GitHub (auto-sync) | swcstudiospace/agent_runtime#327 | No action taken by this plan |
| Notion | `3e6bc1a0-c7ae-8102-8a05-f31661fbc812` (Agent Task Graph), titled throwaway | Agent hermes, Status Done, Linear State Done, Completed 2026-09-25, PR fields empty |
| Index | graph `ut-mughkkc0-73909228` | status Done, n1 completed and unclaimed |
| Greptime | events for the graph | `claim` 06:51:38.722Z and `complete` 06:53:43.683Z (surface hermes) |
| Worktree | `/var/lib/substrate/worktrees/ut-mughkkc0-73909228` on `substrate/ut-mughkkc0-73909228` | Kept for D-12 reuse. Its porcelain is empty |
| substrate.env | appended switch lines (`=0` at 04:54, 05:38, 06:50; `=1` at 05:54 and 06:54) | Last line is `SUBSTRATE_DISPATCH_DISABLED=1` |

## Task Commits

1. **Task 1: setup and switch on**: `f8133f0`
2. **Task 2: runs 1–3**: `14ce954`; **run 4**: `34a5681`; **run 5 (proof)**: `1299397`
3. **Task 3: owner approval recorded, and this SUMMARY**: the close-out commit

`commits: 7` is `git rev-list --count 4a984f2..HEAD` after the close-out commit. It includes the owner's `a6e9604` and `be5e34d`. 02-08 made 5 of them.

## Deviations from Plan

1. **Repeated runs on one issue** (Linear cap). The repeats after run 1 reused SWC-467 rather than a new issue. The operator restarted the dispatcher to clear `given_up` before runs 2 and 3. The owner authorized runs 4 and 5 (D-16 amended).
2. **Fix-attempt limit reached at run 3.** After that, only owner-directed changes followed: a6e9604 and be5e34d, made by Main.
3. **Model switch** to claude-opus-5.5 (D-13 amended).
4. **`dispatch_switch_final=1`** instead of 0 (owner-directed).
5. **Operator completion** (`completion=operator`), which the plan allows when the model does not complete.

## Self-Check

- `02-PROOF.md` and `02-08-SUMMARY.md` exist. Commits f8133f0, 14ce954, 34a5681 and 1299397 are on `main`.
- Verifies re-run verbatim with `/usr/bin/bash` at 07:04Z:
  - **Task 2 verify: exit 0**, `proof-linear-ok`.
  - **Task 1 verify: exit 1.** It fails only on its final journal clause: the latest tick line is `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` because the owner disabled dispatch. The same command without that clause exits 0.
- The secret scan of 02-PROOF.md (systemd-run with EnvironmentFile, values compared in-process) found 0 hits.
- `.planning/config.json`, `.planning/state.json`, `issues/`, STATE.md and ROADMAP.md were not staged.

## Self-Check: PASSED (Task 2 verify exit 0; Task 1 verify exit 1 only on the owner-disabled switch clause)
