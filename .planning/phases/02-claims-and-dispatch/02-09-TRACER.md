# 02-09 dispatch tracer evidence

Recorded from observed output only. One run, and it claimed on the first attempt, so there is no
failed-run entry.

Pre-run facts, taken on the host at 2026-09-25T02:10:46Z, before the tracer created its worktree:
`systemctl is-active substrate-mcp` printed `active`, `systemctl is-active substrate-dispatcher`
printed `inactive`, and `sudo grep -c '^LINEAR_API_KEY=' /etc/substrate/substrate.env` printed `1`.
substrate.env has no `SUBSTRATE_DISPATCH_DISABLED` line (`sudo grep -c` printed `0`), so the
`-E SUBSTRATE_DISPATCH_DISABLED=0` value decided D-15 for this run.

free_disk_gb_before=30
main_branch_before=main

## Run

The harness was run as follows:

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env \
  -p StateDirectory=substrate -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=full \
  -p ProtectHome=false -p ProtectKernelTunables=yes -p ProtectControlGroups=yes \
  -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" -p WorkingDirectory=/root/src/repos/agent-substrate \
  -E HOME=/root -E PYTHONPATH=/root/src/repos/agent-substrate/packages/dispatcher/src \
  -E SUBSTRATE_DISPATCH_DISABLED=0 /usr/bin/python3 - < /tmp/02-09-tracer.py > /tmp/02-09-tracer.out 2>&1
```

It exited 0. Its key=value output follows verbatim. Lines the harness printed with a `#` prefix, and
its two log dumps, are in Findings.

linear_issue_id=d5b9c622-c760-4ee4-89d0-3dbaab0a1ab5
linear_identifier=SWC-466
team_key=SWC
t_issue_created=2026-09-25T02:10:52Z
graph_id=ut-mugbqivi-752f2dad
dispatch_label_source=created
t_label=2026-09-25T02:10:54Z
t_poll=2026-09-25T02:10:55Z
tick: 1 candidate issue(s)
launched hermes for SWC-466 graph ut-mugbqivi-752f2dad node n1 pid 1017379 worktree /var/lib/substrate/worktrees/ut-mugbqivi-752f2dad log /var/lib/substrate/dispatcher/sessions/ut-mugbqivi-752f2dad-n1-20260925T021055Z.log
t_launch=2026-09-25T02:10:55Z
hermes_pid=1017379
worktree=/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad
session_log=/var/lib/substrate/dispatcher/sessions/ut-mugbqivi-752f2dad-n1-20260925T021055Z.log
t_claim=2026-09-25T02:11:43Z
claim_evidence=claimed_by
claim_session=20260925_021057_7310e5
claim_observed=true
hermes_exit=killed
hermes_returncode=-9
t_hermes_exit=2026-09-25T02:13:53Z
final_node_state=started
completion_observed=false
hermes_session_id=none
delta_label_to_claim_s=49
delta_launch_to_claim_s=48
projected_within_60s=false

Recorded after the run:

hardening_errors=none
hermes_export_session_id=20260925_021057_7310e5

- `hermes_session_id=none`: the session log has no `session_id:` line. Under `-Q`, Hermes prints that
  line when the session ends, and the tracer SIGKILLed this session first (see Findings).
- `hermes_export_session_id` comes from
  `hermes sessions export --format jsonl --session-id 20260925_021057_7310e5 /tmp/02-09-session.jsonl`,
  which printed `Exported 1 session`. The export shows `id=20260925_021057_7310e5`,
  `source=substrate-dispatcher`, `model=claude-fable-5-1`, `title=Claim node n1 and work Linear SWC-466`,
  `tool_call_count=19` and `message_count=39`. That id equals the node's `claim_session` and the session
  id in the Linear claim comment.

## Timeline (UTC)

| Time | Event | Source |
|---|---|---|
| 02:10:46 | Preconditions checked. 30 GB free on `/`, and the main checkout is on `main` | shell |
| 02:10:52 | SWC-466 created in Todo; graph `ut-mugbqivi-752f2dad` registered with n1 unstarted | harness |
| 02:10:53.402 | Linear↔GitHub sync comment: swcstudiospace/agent_runtime#326 | Linear comments |
| 02:10:54 | `dispatch:hermes` created as a team label, then applied (`t_label`) | harness |
| 02:10:55 | `dispatch_candidates()` lists SWC-466 on the first poll (`t_poll`) | harness |
| 02:10:55 | One tick: `graph_find` → launch, then worktree created and Hermes started (`t_launch` = `Launched.started_at`) | harness |
| 02:11:00.98 | The first message of the Hermes session (the prompt) | session export |
| 02:11:37.52 | Hermes' first tool call: `terminal` curl `graph_claim` { n1, surface hermes, session 20260925_021057_7310e5 } | session export |
| 02:11:38.223 | Index `claimed_at` | graph_get |
| 02:11:41.014 | Linear comment `Claimed by hermes — session 20260925_021057_7310e5 (graph ut-mugbqivi-752f2dad, node n1)` | Linear comments |
| 02:11:43 | The tracer's 5 s poll sees `claimed_by=hermes` (`t_claim`) | harness |
| 02:13:43 | The 120 s exit wait ends with Hermes still running. The tracer sends SIGTERM | harness |
| 02:13:53 | Hermes is still alive after 10 s, so it gets SIGKILL. Return code -9 | harness |

## Findings

- **Launch path.** The live path ran `dispatch.tick → make_launch_fn → worktree.repo_checkout →
  worktree.ensure_worktree → launcher.launch` exactly once, through the OnlyTracer wrapper. The tick
  logged `tick: 1 candidate issue(s)` and the decision `SWC-466 launch: graph ut-mugbqivi-752f2dad node n1`.
  No other labelled issue in the team was touched.
- **Claim mirror.** Linear after the run: state `In Progress` and labels `agent:hermes` only. The
  `dispatch:hermes` label was removed by 02-01's Mirror.claim. The comments are the GitHub sync comment
  and the claim comment.
- **Latency against the 60 s budget.** The tracer measured `delta_launch_to_claim_s=48` and
  `delta_label_to_claim_s=49`. The index `claimed_at` was 43 s after launch. About 6 s went to Hermes
  start-up and about 36 s to the model's first turn. With the real loop polling every 30 s, the
  projection is 48 + 30 = 78 s, so `projected_within_60s=false`. The label → claim path cannot be
  guaranteed inside 60 s with a 30 s poll. 02-07 and 02-08 have to budget for that, either with a
  shorter poll or a budget measured from the poll.
- **Toolsets.** The first line of the session log is `Warning: Unknown toolsets: mcp-linear`. Hermes
  v0.21.4 rejected `mcp-linear` at start-up, so 02-04's `DEFAULT_TOOLSETS = terminal,file,mcp-linear`
  gives this session no Linear tool. Tools used, as recorded in the export: `terminal` (14), `read_file` (4)
  and `tool_search` (1). `tool_search` found only `terminal` as a connected source. The claim needs
  only `terminal`, so the claim was not affected. The work step, "read issue with your Linear tool",
  could not be done this way. 02-07 has to fix the toolset name or drop the Linear step.
- **Approval prompts in the headless session.** No `--yolo` was passed, and Hermes blocked two
  commands itself:
  - `BLOCKED: Security scan — [MEDIUM] Lookalike TLD detected: Domain uses '.app' TLD which can be confused with file extensions; [HIGH] Pipe to interpreter: curl | python3: ...`
  - `BLOCKED: Command flagged as dangerous (script execution via heredoc) but single-query mode (-q) runs without a user present to approve it. Find an alternative approach that avoids this command. To allow dangerous commands in single-query mode, set approvals. ...`

  Neither block stopped the claim. The session worked around both.
- **Hermes' own Linear credential.** The child environment is 02-04's allowlist, so the substrate
  `LINEAR_API_KEY` did not reach it. Hermes still found a `LINEAR_API_KEY` of its own
  (`env | grep -i linear` printed `LINEAR_API_KEY=***`), loaded by Hermes itself. It belongs to a
  different Linear workspace: `viewer.organization.urlKey` was `swcstudio`, with team `SPE`. The
  substrate key belongs to `spectrumwebco` / `SWC`. With that key, `issue(id: <SWC-466 uuid>)` answered
  `Entity not found: Issue`. One request answered `Rate limit exceeded. Only 2500 requests are allowed
  per 1 hour`, and a header check showed `x-ratelimit-requests-remaining: 5`. The session never read
  the SWC issue text. It was still looking for it when the tracer ended it.
- **Hermes did not stop on SIGTERM.** It kept running 10 s after `terminate()`, so it was SIGKILLed
  (`hermes_exit=killed`, `hermes_returncode=-9`). 02-07's reaper needs the SIGKILL fallback.
- **No completion.** Hermes was killed before step 4. `final_node_state=started` and
  `completion_observed=false`. n1 is still claimed by hermes, with session 20260925_021057_7310e5.
- **D-13 / edits.** Tool calls used the worktree as `workdir`. `git -C /var/lib/substrate/worktrees/ut-mugbqivi-752f2dad status --porcelain`
  is empty after the run. The main checkout's `git status --porcelain` differs from the pre-run
  snapshot only by this plan's own `__main__.py`, written by the executor during the run. The session
  wrote scratch files under its own `/root/.hermes/cache/scratch/` (`swc466*.json`, `hdr.txt`). That is
  Hermes' TMPDIR, outside any repository. No repository outside the worktree was edited, so nothing
  had to be killed for a D-13 breach.
- **Hardening.** systemd accepted every property, and the run raised no denial:
  `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome=false`, `ProtectKernelTunables`,
  `ProtectControlGroups`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` and `StateDirectory=substrate`.
  `git worktree add` wrote under `/root/src/repos/agent-substrate/.git` and
  `/var/lib/substrate/worktrees`, and Hermes ran and wrote to `/root/.hermes`.
- **Harness `#` lines, verbatim:**
    # decisions: SWC-466 launch: graph ut-mugbqivi-752f2dad node n1
    # linear_state_after=In Progress
    # linear_labels_after=agent:hermes
- **Session log, complete, as dumped by the harness at (h) and at the end:**
    Warning: Unknown toolsets: mcp-linear
    ⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.

## Cleanup

- `graph_register { graph_id: "ut-mugbqivi-752f2dad", status: "Done" }` returned `status: Done`. Before
  that, graph_get showed status `Implementing` and n1 `started`, `claimed_by hermes`, `claimed_at 2026-09-25T02:11:38.223Z`,
  `claim_session 20260925_021057_7310e5`.
- The worktree stays registered for D-12 reuse: `/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad  99837b1 [substrate/ut-mugbqivi-752f2dad]`.
- SWC-466 stays In Progress with `agent:hermes`, titled throwaway. Its GitHub twin is
  swcstudiospace/agent_runtime#326. Nothing was done on GitHub.
- `/tmp/02-09-tracer.py` was deleted after the run.
