# Phase 2 proof — label `dispatch:hermes` on a real issue (02-08)

Recorded 2026-09-25 by plan 02-08. This file records observed output only. Model actions are
quoted from the Hermes session export; operator actions are labelled as operator actions; anything
that did not happen or did not match is listed under Gaps.

## Failed runs

    ### Run 1 — SWC-467 / ut-mughkkc0-73909228, label 04:57:30Z, stopped 05:00:34Z

    Reason: the dispatched Hermes exited with code 1 during start-up (`ModuleNotFoundError: No module named 'prompt_toolkit.document'`) and never claimed n1. `ps` already showed it as an exited zombie with 15 s elapsed, and the dispatcher's reap logged the exit 31 s after launch. It is a session that never claimed, so the run was repeated (see the deviation at the end of this section).

    Setup of run 1 (the same issue, graph, Notion row and label that the final run reuses; see ## Setup):

    graph_id=ut-mughkkc0-73909228
    linear_issue_id=3378743f-efc9-47f2-9962-3894dca6bb80
    linear_identifier=SWC-467
    notion_page=3e6bc1a0-c7ae-8102-8a05-f31661fbc812
    dispatch_label_id=71fc5665-11f1-41b6-934a-6e4532fb0da5
    free_disk_gb_before=29
    main_branch_before=main
    switch_flipped_at=2026-09-25T04:54:52Z

    Watch run: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-watch.py`. The operator stopped it at 05:00:34Z (`sudo systemctl stop run-u16252.service`) once the unclaimed exit was in the journal, so it printed no end-of-run lines. Output, verbatim:

    watch_linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    watch_linear_identifier_from_graph_get=SWC-467
    pre_label_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    t_label=2026-09-25T04:57:30.971Z
    label_response={"success": true, "state": "Todo", "labels": ["dispatch:hermes"]}
    # 2026-09-25T04:57:30.973Z n1 state=unstarted claimed_by=None
    # 2026-09-25T04:57:31.397Z notion {"Agent": "", "Status": null, "Linear State": null, "Completed": null}
    # journal: 2026-09-25T04:57:58.749164+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T04:57:59.459535+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1363134 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T045759Z.log
    t_launch=2026-09-25T04:58:00.988Z
    launch_line=2026-09-25T04:57:59.459535+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1363134 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T045759Z.log
    hermes_pid=1363134
    worktree=/var/lib/substrate/worktrees/ut-mughkkc0-73909228
    session_log=/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T045759Z.log
    # journal: 2026-09-25T04:58:30.289887+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] SWC-467: hermes pid 1363134 exited (code 1) without a claim

    Session log `/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T045759Z.log`, complete (1848 bytes):

    Traceback (most recent call last):
      File "/usr/local/lib/hermes-agent/hermes", line 11, in <module>
        main()
      File "/usr/local/lib/hermes-agent/hermes_cli/main.py", line 3562, in main
        if _try_fast_chat_launch():
           ^^^^^^^^^^^^^^^^^^^^^^^
      File "/usr/local/lib/hermes-agent/hermes_cli/main.py", line 3194, in _try_fast_chat_launch
        cmd_chat(args)
      File "/usr/local/lib/hermes-agent/hermes_cli/main.py", line 1847, in cmd_chat
        from cli import main as cli_main
      File "/usr/local/lib/hermes-agent/cli.py", line 43, in <module>
        from hermes_cli.cli_tui_mixin import CLITuiMixin
      File "/usr/local/lib/hermes-agent/hermes_cli/cli_tui_mixin.py", line 18, in <module>
        from hermes_cli.commands_completion import SlashCommandAutoSuggest, SlashCommandCompleter
      File "/usr/local/lib/hermes-agent/hermes_cli/commands_completion.py", line 16, in <module>
        from prompt_toolkit.auto_suggest import AutoSuggest, Suggestion
      File "/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/__init__.py", line 27, in <module>
        from .application import Application
      File "/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/application/__init__.py", line 3, in <module>
        from .application import Application
      File "/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/application/application.py", line 36, in <module>
        from prompt_toolkit.buffer import Buffer
      File "/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/buffer.py", line 23, in <module>
        from .auto_suggest import AutoSuggest, Suggestion
      File "/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/auto_suggest.py", line 22, in <module>
        from .document import Document
    ModuleNotFoundError: No module named 'prompt_toolkit.document'

    `ps` at about 04:58:15Z showed `1363134 1062615 15 Z hermes` (a zombie child of the dispatcher, already exited).

    Dispatcher journal (every non-`tick: 0` line since the label):

    2026-09-25T04:57:58.749164+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] tick: 1 candidate issue(s)
    2026-09-25T04:57:59.459535+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1363134 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T045759Z.log
    2026-09-25T04:58:30.289887+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] SWC-467: hermes pid 1363134 exited (code 1) without a claim

    Linear after the reap, read at 05:00:46Z with `/tmp/02-08-read.py` under the same systemd-run pattern (D-14 path, as built in 02-07):

    state={"name": "Todo", "type": "unstarted"}
    labels=[]
    comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    comment={"body": "substrate-dispatcher: [exited-unclaimed] hermes session exited (code 1) without claiming the node \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T04:58:30.482Z"}
    history={"createdAt": "2026-09-25T04:57:30.713Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    history={"createdAt": "2026-09-25T04:58:30.804Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}

    graph_get at 05:00:46Z: graph `Implementing`, n1 `unstarted`, `claimed_by null`. The Notion row still had Agent `""` (the watch's only Notion read, at 04:57:31.397Z; no mirror call happened). The worktree `/var/lib/substrate/worktrees/ut-mughkkc0-73909228` was created on `[substrate/ut-mughkkc0-73909228]` at f8133f0, and its porcelain was empty. The main checkout stayed on `main` with the same porcelain as the 04:53:08Z snapshot.

    Failure checks (operator, read-only):
    - `/usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages/prompt_toolkit/document.py` exists (40547 bytes, Jun 24). Its `__pycache__/document.cpython-311.pyc` dates from Jul 28. Nothing under `/usr/local/lib/hermes-agent` was modified on 2026-09-25 except two `hermes_cli/__pycache__` files written at 04:35:06Z–04:35:07Z.
    - In the worktree cwd, `env -i HOME=/root PATH=<systemd default> TERM=dumb /usr/local/lib/hermes-agent/venv/bin/python -c "...; import cli"` printed `cli-import-ok`. The same import under `sudo systemd-run` with the unit's hardening (NoNewPrivileges, PrivateTmp, ProtectSystem=full, ProtectHome=false, ProtectKernelTunables, ProtectControlGroups, RestrictAddressFamilies, StateDirectory) printed `cli-import-ok-hardened`.
    - Other `hermes chat` processes started normally on the host at 04:59:35Z.
    - Root cause: not established. The failure did not reproduce.

    Gaps (run 1): Hermes never claimed, so t_claim, t_linear_in_progress, t_notion_agent and t_brief were never observed, and there is no Hermes session to export. The claim-watch path (D-14 `[exited-unclaimed]`) worked as designed.

    Deviation: the plan says a repeat uses a NEW throwaway issue and graph. The Linear workspace had one free slot (249/250), and the orchestrator allowed exactly one issue for this plan. So the repeat reuses SWC-467, graph ut-mughkkc0-73909228 and the same Notion row. The dispatcher keeps `given_up` in memory. To let it launch for SWC-467 again, the operator restarted substrate-dispatcher (the switch stays at 0) and re-applied `dispatch:hermes`. The run-1 comment and history rows stay on the issue.

    ### Run 2 — SWC-467 / ut-mughkkc0-73909228 again, label 05:02:15Z, D-14 claim timeout 05:12:38Z

    Reason: Hermes session 20260925_050221_4dcd47 started, but its first Anthropic API call returned HTTP 429 at 05:02:55 (`This request would exceed your account's rate limit. Please try again later.`). Hermes then waited 600 s before retrying, so it made no tool call. The dispatcher's D-14 timeout ended the session at 05:12:38Z, before that retry. It never claimed n1.

    Setup: the same as run 1, plus the operator's dispatcher restart at 05:01:48Z. That restart is recorded under ## Setup → "Final run (run 2)", and run 3 reuses it.

    Watch run: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-watch.py` exited 0 when its 600 s deadline ran out. Output, verbatim:

    watch_linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    watch_linear_identifier_from_graph_get=SWC-467
    pre_label_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    t_label=2026-09-25T05:02:15.353Z
    label_response={"success": true, "state": "Todo", "labels": ["dispatch:hermes"]}
    # 2026-09-25T05:02:15.355Z n1 state=unstarted claimed_by=None
    # 2026-09-25T05:02:15.763Z notion {"Agent": "", "Status": null, "Linear State": null, "Completed": null}
    # journal: 2026-09-25T05:02:19.644724+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:02:20.126236+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1374108 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T050220Z.log
    t_launch=2026-09-25T05:02:20.365Z
    launch_line=2026-09-25T05:02:20.126236+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1374108 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T050220Z.log
    hermes_pid=1374108
    worktree=/var/lib/substrate/worktrees/ut-mughkkc0-73909228
    session_log=/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T050220Z.log
    # journal: 2026-09-25T05:02:50.953660+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:03:21.898517+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:03:52.740291+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:04:23.631513+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:04:54.464175+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:05:25.314409+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:05:56.179164+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:06:27.025962+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:06:57.880735+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:07:28.740193+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:07:59.590203+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:08:30.484604+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:09:01.437062+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:09:32.285701+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:10:03.658287+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:10:34.509462+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:11:05.335105+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:11:36.359350+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:12:07.263564+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 1 candidate issue(s)
    watch_deadline_hit=true
    t_claim_missing=true
    t_linear_in_progress_missing=true
    t_notion_agent_missing=true
    t_brief_missing=true
    linear_last_seen={"at": "2026-09-25T05:12:10.380Z", "state": "Todo", "labels": ["dispatch:hermes"]}
    watch_iterations=121
    watch_end=2026-09-25T05:12:15.379Z

    The dispatcher journal after the watch ended (every line that is not `tick: 1 candidate`):

    2026-09-25T05:12:38.126496+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] SWC-467: no claim within 600 s; terminating pid 1374108
    2026-09-25T05:12:39.087499+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 0 candidate issue(s)

    Hermes' own log (`/root/.hermes/logs/agent.log`), every line for this session, cut at 400 characters:

    2026-09-25 05:02:23,787 INFO [20260925_050221_4dcd47] agent.turn_context: conversation turn: session=20260925_050221_4dcd47 model=claude-fable-5-1 provider=anthropic platform=cli history=0 msg='You were dispatched by substrate-dispatcher for Linear issue SWC-467, graph ut-m...'
    2026-09-25 05:02:23,820 WARNING [20260925_050221_4dcd47] agent.prompt_builder: Context file SOUL.md matched injection pattern(s) prompt_injection; loaded anyway because it is the user's own file in HERMES_HOME — review it if you did not write that text
    2026-09-25 05:02:23,821 WARNING [20260925_050221_4dcd47] agent.prompt_builder: ⚠️  Context file SOUL.md TRUNCATED: 274607 chars exceeds limit of 240000 — trim the file, pin a larger context_file_max_chars, or use a larger-context model!
    2026-09-25 05:02:54,468 WARNING [20260925_050221_4dcd47] hermes_cli.plugins: Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping
    2026-09-25 05:02:55,118 WARNING [20260925_050221_4dcd47] agent.conversation_loop: API call failed (attempt 1/3) error_type=RateLimitError thread=MainThread:128215106725696 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 summary=HTTP 429: This request would exceed your account's rate limit. Please try again later.
    2026-09-25 05:02:55,120 WARNING [20260925_050221_4dcd47] agent.conversation_loop: Retrying API call in 600s (attempt 1/3) thread=MainThread:128215106725696 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 policy=default error=Error code: 429 - {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': "This request would exceed your account's rate limit. Please 
    2026-09-25 05:12:38,812 INFO [20260925_050221_4dcd47] run_agent: Interrupt requested (hard): explicit stop requested
    2026-09-25 05:12:40,328 INFO [20260925_050221_4dcd47] run_agent: Interrupt requested (soft): user sent a new message
    2026-09-25 05:12:40,350 INFO hermes_eng_board.hooks: autopilot session=20260925_050221_4dcd47 action=skipped stages=['classify'] task=None linear=None
    2026-09-25 05:12:40,615 INFO [20260925_050221_4dcd47] hermes_eng_board.hooks: autopilot session=20260925_050221_4dcd47 action=skipped stages=['classify'] task=None linear=None
    2026-09-25 05:12:40,866 INFO [20260925_050221_4dcd47] cli: CLI cleanup calling memory shutdown for session 20260925_050221_4dcd47 with 1 message(s)

    This time Hermes honoured the SIGTERM (`Interrupt requested (soft)` at 05:12:40). `ps` at 05:12:50 showed pid 1374108 as an exited zombie with 630 s elapsed, so no SIGKILL was needed.

    The session log `/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T050220Z.log`, complete:

    ⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.

    session_id: 20260925_050221_4dcd47

    `hermes sessions export --format jsonl --redact --session-id 20260925_050221_4dcd47 -` exited 0 and wrote 239022 bytes. Its parsed fields:

    export_lines=1
    id="20260925_050221_4dcd47"
    source="substrate-dispatcher"
    cwd=null
    model="claude-fable-5-1"
    title="You were dispatched by substrate-dispatcher for\u2026"
    started_at=1790312544.462427
    ended_at=1790313160.5888784
    end_reason="cli_close"
    tool_call_count=0
    message_count=1
    git_branch=null
    tool_names={}
    first_message_ts=1790312543.7879574
    last_message_ts=1790312543.7879574
    The launch argv, from `/proc/1374108/cmdline` at 05:03:50: `/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes chat --query-file /var/lib/substrate/dispatcher/prompts/ut-mughkkc0-73909228-n1-20260925T050220Z.md -Q --pass-session-id --source substrate-dispatcher --max-turns 60 --run-budget 3600 -t terminal,file`. There is no `--yolo`.

    Linear after the timeout, read at 05:12:56Z:

    state={"name": "Todo", "type": "unstarted"}
    labels=[]
    comment={"body": "substrate-dispatcher: [claim-timeout] no claim within 10 minutes \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T05:12:38.325Z"}
    history={"createdAt": "2026-09-25T05:02:15.107Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    history={"createdAt": "2026-09-25T05:12:38.654Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}

    Account state, as read afterwards by the operator: `hermes usage --provider anthropic` at 05:13:09Z printed `Current session: 85% remaining (15% used) • resets in 2h 56m` and `Current week: 17% remaining (83% used)`. Neither usage window was exhausted, so the 429 came from a short-window limit. Another host session, 20260925_045937_446569, which substrate did not start, got the same 429 at 04:59:50. Each of these first calls sends about 112k input tokens: agent.log shows `in=112761` for a 04:59:25 call, and prompt_builder warns that SOUL.md, at 274607 characters, is truncated to 240000.

    Gaps (run 2): no claim, so t_claim, t_linear_in_progress, t_notion_agent and t_brief were never observed. The D-14 `[claim-timeout]` path worked as designed.

## Setup

### Preconditions (2026-09-25T04:53:02Z, read-only)

- `grep -c '^notion_skipped=' 02-NOTION-SCHEMA.md` → `1` (the line is `notion_skipped=false`).
- `sudo grep -c '^NOTION_API_KEY=' /etc/substrate/substrate.env` → `1`.
- `systemctl is-active substrate-dispatcher substrate-mcp hermes-linear-api` → `active` ×3.
- `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=1$' /etc/substrate/substrate.env` → `1`
  (`^SUBSTRATE_DISPATCH_DISABLED=` → `1`, so the file had exactly one switch line).
- substrate-dispatcher: `MainPID=1062615`, `NRestarts=0`, `ActiveEnterTimestamp=Fri 2026-09-25 02:27:55 UTC`.
  Its last journal lines were `[substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`
  every 30 s (04:50:55 … 04:52:55).

D-13 snapshot of the main checkout, taken at 04:53:08Z before anything was created
(`git status --porcelain`):

```
 M .planning/config.json
 M .planning/state.json
?? issues/
```

`git worktree list` at the same time:

```
/root/src/repos/agent-substrate                    4a984f2 [main]
/var/lib/substrate/worktrees/ut-mugbqivi-752f2dad  99837b1 [substrate/ut-mugbqivi-752f2dad]
```

D-12: `df -BG --output=avail / | tail -n 1 | tr -dc '0-9'` → `29`.

### Issue, Notion Issue row, graph and label (04:54:12Z – 04:54:16Z)

Command (no key in it; systemd hands `LINEAR_API_KEY`, `NOTION_API_KEY` and `NOTION_TASK_GRAPH_DS`
to that one process; the script printed key=value lines only and was deleted afterwards):

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-setup.py
```

Output, verbatim (exit 0), indented four spaces so only the summary lines below start at column 0:

    pre_flip_dispatch_candidates=[]
    team_source=only_visible_team
    team_id=5371e279-c76c-4e84-b8df-254bf5fbfc27
    team_key=SWC
    visible_teams=1
    todo_state_id=0ec71412-0874-4c48-848f-4992ebb3ccf8
    todo_state_type=unstarted
    graph_id=ut-mughkkc0-73909228
    issue_create_success=True
    issue_id=3378743f-efc9-47f2-9962-3894dca6bb80
    issue_identifier=SWC-467
    issue_url=https://linear.app/spectrumwebco/issue/SWC-467/substrate-02-proof-throwaway-dispatchhermes-proof
    issue_created_at=2026-09-25T04:54:12.159Z
    issue_state=Todo (unstarted)
    notion_ds=be3418f0-d2d8-411b-8677-fa8a95ee63be
    notion_create_http=200
    notion_page_id=3e6bc1a0-c7ae-8102-8a05-f31661fbc812
    notion_page_url=https://app.notion.com/p/n1-substrate-02-proof-throwaway-3e6bc1a0c7ae81028a05f31661fbc812
    notion_parent={"type": "data_source_id", "data_source_id": "be3418f0-d2d8-411b-8677-fa8a95ee63be", "database_id": "843bc6ab-56b0-4b27-ae10-e258711edcb0"}
    notion_get_http=200
    notion_row_before={"Item": "[n1] substrate 02 proof \u2014 throwaway", "Level": "Issue", "Graph ID": "ut-mughkkc0-73909228", "Issue ID": "SWC-467", "Linear URL": "https://linear.app/spectrumwebco/issue/SWC-467/substrate-02-proof-throwaway-dispatchhermes-proof", "Agent": "", "Status": null, "Linear State": null, "Completed": null}
    pr_fields_before={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}
    t_notion_row=2026-09-25T04:54:13.506Z
    graph_register_response={ "graph_id": "ut-mughkkc0-73909228", "notion_task_page": null, "repo": "swcstudiospace/agent-substrate", "branch": "main", "surface": null, "status": "Implementing", "pr_url": null, "created": "2026-09-25T04:54:13.786Z", "updated": "2026-09-25T04:54:13.786Z", "nodes": [ { "graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null } ], "steps": [] }
    graph_get_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    graph_get_status=Implementing
    linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    dispatch_label_id=71fc5665-11f1-41b6-934a-6e4532fb0da5
    dispatch_label_source=reused_team_label
    issue_check={"identifier": "SWC-467", "state": {"name": "Todo", "type": "unstarted"}, "labels": []}
    issue_comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    setup_done_at=2026-09-25T04:54:16.000Z

- The team was resolved at run time as the only visible team (D-16); no identifier prefix was typed.
- `graph_register` was sent as `{graph_id, repo: "swcstudiospace/agent-substrate", branch: "main", status: "Implementing", nodes: [{node_id: "n1", linear_issue_id, linear_identifier, notion_page, state: "unstarted"}]}`.
  Every later Linear check uses `linear_issue_id` from `graph_get`'s `nodes[n1]`.
- The Notion row was created under the Agent Task Graph data source with Item, Level `Issue`, Graph ID,
  Issue ID and Linear URL only.
- `dispatch:hermes` already existed as an SWC team label (created by 02-09) and was reused. It was not applied here.
- The dispatcher's own filter (unstarted + `dispatch:*`) matched no issue before the flip, so turning
  the switch on could not launch anything but the proof issue (T-02-08-02).
- Linear capacity: this is the one issue this plan creates. Its GitHub twin, from the workspace's
  Linear↔GitHub sync comment, is swcstudiospace/agent_runtime#327. Nothing was done on GitHub.

graph_id=ut-mughkkc0-73909228
linear_issue_id=3378743f-efc9-47f2-9962-3894dca6bb80
linear_identifier=SWC-467
notion_page=3e6bc1a0-c7ae-8102-8a05-f31661fbc812
dispatch_label_id=71fc5665-11f1-41b6-934a-6e4532fb0da5
free_disk_gb_before=29
main_branch_before=main
pr_fields_before={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}

### Tracer prediction (consumed before the switch is flipped)

Copied from 02-09-TRACER.md (`projected_within_60s=false`, `delta_launch_to_claim_s=48`):

tracer_projected_within_60s=false
tracer_delta_launch_to_claim_s=48

Prediction: 02-09 measured launch → claim at 48 s, so with the 30 s poll the 60 s proof budget is expected to be missed; the proof runs unchanged (D-10 and the proof wording are locked) and Gaps compares the outcome with this prediction.

### D-15 switch flipped (no restart)

Operator action, appending one line (the file was neither read out nor rewritten):

```
echo 'SUBSTRATE_DISPATCH_DISABLED=0' | sudo tee -a /etc/substrate/substrate.env > /dev/null
```

- Returned at 2026-09-25T04:54:52Z.
- `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=0$'` → `1`; `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED='` → `2`
  (the 02-07 `=1` line at line 18, the appended `=0` line at line 21; the last line wins).
- The unit was not restarted (`MainPID` still 1062615). First journal tick after the flip:

```
2026-09-25T04:54:56+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

switch_flipped_at=2026-09-25T04:54:52Z

### Retry setup (runs 2 and 3) — the same issue, graph and row, after a dispatcher restart

Runs 1 and 2 failed before any claim (see ## Failed runs). Because only one Linear issue was allowed,
each retry reuses every Setup value above. Before run 2: The Task 1 facts were re-checked at 2026-09-25T05:01:48Z:

- `df -BG --output=avail /` → `29`. The main checkout is on `main`, and its porcelain is the
  04:53:08Z snapshot plus this file.
- graph_get at 05:00:46Z: n1 `unstarted`, `claimed_by null`, still linked to SWC-467 and the Notion row.
  Linear: Todo, no labels. Notion Agent `""`.
- `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=0$'` → `1`. The switch was not touched again.
- Operator action: `sudo systemctl restart substrate-dispatcher` at 05:01:48Z, which clears the
  in-memory `given_up` entry run 1 left for SWC-467. The new `MainPID` is 1372997, with `NRestarts=0`.
  `systemctl is-active substrate-dispatcher substrate-mcp hermes-linear-api` → `active` ×3. Journal:

```
2026-09-25T05:01:48.401389+00:00 vps substrate-dispatcher[1062615]: [substrate-dispatcher] stop signal received; exiting after 308 iteration(s)
2026-09-25T05:01:48.465493+00:00 vps systemd[1]: Started substrate-dispatcher.service - Agent Substrate — dispatcher (Linear dispatch:<surface> → Hermes session).
2026-09-25T05:01:49.080605+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

Before run 3 (the final run, attempt 3 of 3), re-checked at 2026-09-25T05:13:38Z:

- `df -BG --output=avail /` → `29`. The main checkout is on `main`, and its porcelain is the 04:53:08Z
  snapshot plus this file.
- Linear at 05:12:56Z: Todo, no labels. graph_get: n1 `unstarted` and unclaimed. The run-2 Hermes
  (pid 1374108) had exited. `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=0$'` → `1`.
- Operator action: `sudo systemctl restart substrate-dispatcher` at 05:13:39Z. The new `MainPID` is 1395019,
  with `NRestarts=0`, and the three units are `active`. Journal:

```
2026-09-25T05:13:39.191258+00:00 vps substrate-dispatcher[1372997]: [substrate-dispatcher] stop signal received; exiting after 23 iteration(s)
2026-09-25T05:13:39.278377+00:00 vps systemd[1]: Started substrate-dispatcher.service - Agent Substrate — dispatcher (Linear dispatch:<surface> → Hermes session).
2026-09-25T05:13:40.126848+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

## Proof run (run 3, the final run): label → dispatch → claim?

Result: **the proof did not complete.** substrate-dispatcher picked up the label and launched a real
Hermes session in the per-graph worktree. That session never made a model turn: its first Anthropic
API call returned HTTP 429 (`This request would exceed your account's rate limit`). Hermes backed off
for 600 s, and D-14's 600 s claim timeout ended the session before the retry. There was no claim, so
the Linear In Progress, Notion Agent, brief and DoD-gated completion checks had nothing to observe.
Every miss is listed under Gaps. This was attempt 3 of 3 (runs 1 and 2 are under ## Failed runs).

### Label and watch

Operator action: `issueUpdate(id: <linear_issue_id from graph_get>, input: { addedLabelIds: [<dispatch_label_id>] })`, from
`sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-watch.py`.
The same script then polled every 5 s for 600 s: the dispatcher journal, graph_get, Linear (state, labels,
comments, history), the Notion row, and POST /brief both scoped to the graph and unscoped. It holds no
key and prints key=value lines only. It exited 0. Output, verbatim and indented:

    watch_linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    watch_linear_identifier_from_graph_get=SWC-467
    pre_label_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    t_label=2026-09-25T05:13:46.871Z
    label_response={"success": true, "state": "Todo", "labels": ["dispatch:hermes"]}
    # 2026-09-25T05:13:46.873Z n1 state=unstarted claimed_by=None
    # 2026-09-25T05:13:47.290Z notion {"Agent": "", "Status": null, "Linear State": null, "Completed": null}
    # journal: 2026-09-25T05:14:10.483596+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:14:10.968645+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1395973 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log
    t_launch=2026-09-25T05:14:11.888Z
    launch_line=2026-09-25T05:14:10.968645+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1395973 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log
    hermes_pid=1395973
    worktree=/var/lib/substrate/worktrees/ut-mughkkc0-73909228
    session_log=/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log
    # journal: 2026-09-25T05:14:41.780848+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:15:12.619160+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:15:43.462042+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:16:14.307428+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:16:45.151666+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:17:15.965650+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:17:46.806040+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:18:17.631545+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:18:48.476623+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:19:19.296670+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:19:50.122677+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:20:20.965271+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:20:51.796457+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:21:22.628225+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:21:53.473042+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:22:24.314511+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:22:55.148559+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    # journal: 2026-09-25T05:23:25.997126+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    watch_deadline_hit=true
    t_claim_missing=true
    t_linear_in_progress_missing=true
    t_notion_agent_missing=true
    t_brief_missing=true
    linear_last_seen={"at": "2026-09-25T05:23:41.910Z", "state": "Todo", "labels": ["dispatch:hermes"]}
    watch_iterations=121
    watch_end=2026-09-25T05:23:46.910Z

### Dispatcher journal (every line that is not `tick: 1 candidate`, 05:14:00Z → 05:25:29Z)

```
2026-09-25T05:14:10.483596+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
2026-09-25T05:14:10.968645+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1395973 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log
2026-09-25T05:24:27.691693+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] SWC-467: no claim within 600 s; terminating pid 1395973
2026-09-25T05:24:28.382295+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 0 candidate issue(s)
2026-09-25T05:24:58.382606+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] SWC-467: terminated session pid 1395973 ended (code 130)
2026-09-25T05:24:59.046557+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

### The Hermes session (proved by export, not asserted)

- Process, observed by the operator at 05:15:49Z:
  - `readlink /proc/1395973/cwd` → `/var/lib/substrate/worktrees/ut-mughkkc0-73909228`
  - its parent is 1395019, the dispatcher's MainPID
  - argv (`/proc/1395973/cmdline`): `/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes chat --query-file /var/lib/substrate/dispatcher/prompts/ut-mughkkc0-73909228-n1-20260925T051410Z.md -Q --pass-session-id --source substrate-dispatcher --max-turns 60 --run-budget 3600 -t terminal,file`
  - No `--yolo`, and no `dispatch_handoff_to_hermes.sh` anywhere in the chain (D-13).
- The prompt file's step 3 reads: `(3) Then read issue SWC-467 with your Linear tool and do the work it describes. …`.
  The session was launched with `-t terminal,file` only.
- Session log `/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log`, complete:

```
⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.

session_id: 20260925_051412_dc133a
```

- `hermes sessions export --format jsonl --redact --session-id 20260925_051412_dc133a -` (stdout) exited 0 and wrote
  239026 bytes. Parsed fields, verbatim:

```
export_lines=1
id="20260925_051412_dc133a"
source="substrate-dispatcher"
cwd=null
model="claude-fable-5-1"
title="You were dispatched by substrate-dispatcher for\u2026 #2"
started_at=1790313255.311085
ended_at=1790313869.8312843
end_reason="cli_close"
tool_call_count=0
message_count=1
git_branch=null
tool_names={}
first_message_ts=1790313254.480677
last_message_ts=1790313254.480677
```

  - The export has `source="substrate-dispatcher"` and `model="claude-fable-5-1"`.
  - It has `tool_call_count=0` and one message (the prompt), so there is **no first tool call to quote**.
  - `cwd` is null in the export. The worktree cwd is proven by `/proc/1395973/cwd` above, not by the export.
- Hermes' own log (`/root/.hermes/logs/agent.log`), every line for this session, cut at 400 characters:

```
2026-09-25 05:14:14,480 INFO [20260925_051412_dc133a] agent.turn_context: conversation turn: session=20260925_051412_dc133a model=claude-fable-5-1 provider=anthropic platform=cli history=0 msg='You were dispatched by substrate-dispatcher for Linear issue SWC-467, graph ut-m...'
2026-09-25 05:14:14,511 WARNING [20260925_051412_dc133a] agent.prompt_builder: Context file SOUL.md matched injection pattern(s) prompt_injection; loaded anyway because it is the user's own file in HERMES_HOME — review it if you did not write that text
2026-09-25 05:14:14,512 WARNING [20260925_051412_dc133a] agent.prompt_builder: ⚠️  Context file SOUL.md TRUNCATED: 274607 chars exceeds limit of 240000 — trim the file, pin a larger context_file_max_chars, or use a larger-context model!
2026-09-25 05:14:45,316 WARNING [20260925_051412_dc133a] hermes_cli.plugins: Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping
2026-09-25 05:14:45,952 WARNING [20260925_051412_dc133a] agent.conversation_loop: API call failed (attempt 1/3) error_type=RateLimitError thread=MainThread:139807654328128 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 summary=HTTP 429: This request would exceed your account's rate limit. Please try again later.
2026-09-25 05:14:45,954 WARNING [20260925_051412_dc133a] agent.conversation_loop: Retrying API call in 600s (attempt 1/3) thread=MainThread:139807654328128 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 policy=default error=Error code: 429 - {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': "This request would exceed your account's rate limit. Please 
2026-09-25 05:24:28,058 INFO [20260925_051412_dc133a] run_agent: Interrupt requested (hard): explicit stop requested
2026-09-25 05:24:29,579 INFO [20260925_051412_dc133a] run_agent: Interrupt requested (soft): user sent a new message
2026-09-25 05:24:29,606 INFO hermes_eng_board.hooks: autopilot session=20260925_051412_dc133a action=skipped stages=['classify'] task=None linear=None
2026-09-25 05:24:29,853 INFO [20260925_051412_dc133a] hermes_eng_board.hooks: autopilot session=20260925_051412_dc133a action=skipped stages=['classify'] task=None linear=None
2026-09-25 05:24:30,083 INFO [20260925_051412_dc133a] cli: CLI cleanup calling memory shutdown for session 20260925_051412_dc133a with 1 message(s)
```

  Hermes honoured the dispatcher's SIGTERM (`Interrupt requested (hard)` at 05:24:28), and the reaper
  logged exit code 130 at 05:24:58. No SIGKILL was needed.

### Claim, Linear, Notion and brief

- **graph_get:** at every 5 s poll from 05:13:46Z to 05:23:46Z, n1 was `unstarted` with `claimed_by null`.
  It was the same at the final read, 05:25:03Z.
- **Linear:** SWC-467 stayed `Todo`. `dispatch:hermes` was present from 05:13:46Z until D-14 removed it at
  05:24:27.886Z. No `agent:hermes` label was added, and no claim comment was posted.
  - The `[claim-timeout]` comment from run 2 was not posted again: once-only markers, 02-09.
- **Notion row:** `Agent ""` at every poll. No mirror call was made. `last_edited_time` is still `2026-09-25T04:54:00.000Z`.
- **POST /brief:** neither brief ever showed a hermes claim. Scoped
  (`{"repo":"swcstudiospace/agent-substrate","surface":"claude-code","graph_id":"ut-mughkkc0-73909228"}`)
  and unscoped (`{"repo":"swcstudiospace/agent-substrate","surface":"claude-code"}`), at 05:15:31Z:

    ## Substrate brief: swcstudiospace/agent-substrate — ut-mughkkc0-73909228
    Implementing · PR none yet
    Nodes: n1 SWC-467 unstarted

    Last 5 agent actions in this repo
    - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
    - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
    - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release
    - 04:48 claude-code  release mirror to linear failed for n1: node has no Linear issue reference (n1)
    - 04:48 claude-code  released n1 (n1)

    Other open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

    -----

    ## Substrate brief: swcstudiospace/agent-substrate

    Last 5 agent actions in this repo
    - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
    - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
    - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release
    - 04:48 claude-code  release mirror to linear failed for n1: node has no Linear issue reference (n1)
    - 04:48 claude-code  released n1 (n1)

    Other open graphs here: ut-mughkkc0-73909228 (Implementing) · ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

  The same two calls at 05:25:51Z, after the session ended:

    ## Substrate brief: swcstudiospace/agent-substrate — ut-mughkkc0-73909228
    Implementing · PR none yet
    Nodes: n1 SWC-467 unstarted

    Last 5 agent actions in this repo
    - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
    - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
    - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release
    - 04:48 claude-code  release mirror to linear failed for n1: node has no Linear issue reference (n1)
    - 04:48 claude-code  released n1 (n1)

    Other open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

    -----

    ## Substrate brief: swcstudiospace/agent-substrate

    Last 5 agent actions in this repo
    - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
    - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
    - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release
    - 04:48 claude-code  release mirror to linear failed for n1: node has no Linear issue reference (n1)
    - 04:48 claude-code  released n1 (n1)

    Other open graphs here: ut-mughkkc0-73909228 (Implementing) · ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

### Completion (SC-2)

The session ended without calling graph_complete (tool_call_count 0), and its pid was gone by
05:24:58Z. As the operator, at 05:25:45.890Z, I called MCP `graph_complete`
`{graph_id: "ut-mughkkc0-73909228", node_id: "n1", surface: "hermes", session_id: "20260925_051412_dc133a", dod: {summary: "02-08 proof: no change needed", tests_pass: true}}`.
This was an operator call, not a model action. Response, verbatim:

```
{"completed": false, "reason": "node is not claimed", "node": {"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}}
```

02-05's ownership check refused the call before any write, so the DoD gate was never reached and SC-2
was not exercised. The graph was **not** marked Done. It stays `Implementing` with n1 `unstarted`, so a
re-run can reuse it.

### Final state (read at 05:25:03Z)

`sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-final.py`, exit 0, verbatim.
Greptime `agent_events` has no row for this graph: the script's event query printed no `event=` line.

    final_read_at=2026-09-25T05:25:03Z
    graph_status=Implementing
    graph_get_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    final_linear_identifier=SWC-467
    final_linear_state=Todo
    final_linear_labels=[]
    linear_comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    linear_comment={"body": "substrate-dispatcher: [exited-unclaimed] hermes session exited (code 1) without claiming the node \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T04:58:30.482Z"}
    linear_comment={"body": "substrate-dispatcher: [claim-timeout] no claim within 10 minutes \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T05:12:38.325Z"}
    linear_history={"createdAt": "2026-09-25T04:57:30.713Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T04:58:30.804Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T05:02:15.107Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T05:12:38.654Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T05:13:46.692Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T05:24:27.886Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    notion_parent_ds=be3418f0-d2d8-411b-8677-fa8a95ee63be
    notion_last_edited_time=2026-09-25T04:54:00.000Z
    notion_final={"Item": "[n1] substrate 02 proof \u2014 throwaway", "Agent": "", "Status": null, "Linear State": null, "Completed": null, "Graph ID": "ut-mughkkc0-73909228", "Issue ID": "SWC-467"}
    pr_fields_after={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}
    pr_fields_equal_before=true

### Worktree and D-13

- `git worktree list`: `/var/lib/substrate/worktrees/ut-mughkkc0-73909228  f8133f0 [substrate/ut-mughkkc0-73909228]`.
  Its porcelain is empty (0 lines).
- `git -C /root/src/repos/agent-substrate branch --show-current` → `main`.
- Main checkout porcelain before (04:53:08Z) and after (05:25:03Z):

     M .planning/config.json
     M .planning/state.json
    ?? issues/

    -----

     M .planning/config.json
     M .planning/phases/02-claims-and-dispatch/02-PROOF.md
     M .planning/state.json
    ?? issues/

  The only difference is this file.
- `df -BG --output=avail /` → `29G` after the runs.

### Timeline (UTC, final run)

| Time | Event | Source |
|---|---|---|
| 05:13:39 | substrate-dispatcher restarted (operator) with the switch at 0 | journal |
| 05:13:46.871 | `dispatch:hermes` applied to SWC-467 (`t_label`) | watch |
| 05:14:10.484 | `tick: 1 candidate issue(s)` | journal |
| 05:14:10.969 | `launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1395973 …` | journal |
| 05:14:11.888 | the watch sees the launch line (`t_launch`) | watch |
| 05:14:14.480 | Hermes conversation turn starts (session 20260925_051412_dc133a) | agent.log |
| 05:14:45.316 | `Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s` | agent.log |
| 05:14:45.952 | first Anthropic call → HTTP 429; `Retrying API call in 600s` | agent.log |
| 05:23:46.910 | the watch's 600 s deadline ends: no claim, no Linear/Notion/brief change | watch |
| 05:24:27.692 | D-14: `no claim within 600 s; terminating pid 1395973` | journal |
| 05:24:27.886 | `dispatch:hermes` removed from SWC-467 | Linear history |
| 05:24:28.058 | Hermes: `Interrupt requested (hard)` | agent.log |
| 05:24:58.383 | `terminated session pid 1395973 ended (code 130)` | journal |
| 05:25:45.890 | operator `graph_complete` → `completed: false, "node is not claimed"` | MCP |

The measured latencies are:

- label → launch line: 24.1 s (05:13:46.871 → 05:14:10.969). Run 2: 4.8 s.
- launch → first model call attempt: 35.0 s. Of that, 30 s was the `pre_llm_call` hook timeout.
- launch → claim: not measured, because there was no claim.

### Result lines (final run; observed values, `none` = never observed)

hermes_session_id=20260925_051412_dc133a
t_label=2026-09-25T05:13:46.871Z
t_launch=2026-09-25T05:14:11.888Z
t_claim=none
t_linear_in_progress=none
t_notion_agent=none
t_brief=none
brief_evidence=none
brief_line=none
delta_label_to_brief_s=none
within_60s=false
completion=operator_refused
final_linear_state=Todo
notion_status_final=unset
notion_linear_state_final=unset
notion_completed_final=unset
pr_fields_unchanged=true
dispatch_switch_final=0

`dispatch_switch_final=0`: the plan leaves dispatch live, so no `SUBSTRATE_DISPATCH_DISABLED=1` line was
appended. The file's switch lines are line 18 `=1` (02-07) and line 21 `=0` (this plan), and the journal
at 05:25:29Z shows `tick: 0 candidate issue(s)`. SWC-467 is in the running dispatcher's in-memory
`given_up`, so the dispatcher will not relaunch it until a restart. D-15 kill switch:
`echo 'SUBSTRATE_DISPATCH_DISABLED=1' | sudo tee -a /etc/substrate/substrate.env > /dev/null` (the last line wins, on the next tick) or
`sudo systemctl stop substrate-dispatcher`.

## Gaps

1. **The ROADMAP Phase 2 proof was not achieved (SC-1, SC-2 and SC-3's claim half).** In three runs on SWC-467,
   no dispatched Hermes session claimed n1.
   - Run 1: Hermes crashed at import (`ModuleNotFoundError: No module named 'prompt_toolkit.document'`).
     It did not reproduce, and the root cause was not established.
   - Runs 2 and 3: the first Anthropic call returned HTTP 429, `This request would exceed your account's rate limit`.
   - So `t_claim`, `t_linear_in_progress`, `t_notion_agent` and `t_brief` were never observed. Linear never
     showed In Progress / `agent:hermes` / a claim comment. The Notion row never showed Agent hermes.
     POST /brief never showed `started by hermes` or a `hermes … claimed SWC-467` line.
   - What *was* observed: SC-3's dispatch half. The label → poll → `graph_find` → worktree → real `hermes chat`
     path ran three times, with cwd in `/var/lib/substrate/worktrees/ut-mughkkc0-73909228` on
     `substrate/ut-mughkkc0-73909228` while the main checkout stayed on `main`. D-14's `[exited-unclaimed]`
     and `[claim-timeout]` handling also ran.
2. **`within_60s=false`.** The brief never showed the claim, so the 60 s budget was missed with no delta to
   compute (`delta_label_to_brief_s=none`).
3. **`tracer_projected_within_60s=false` (02-09 predicted a miss: launch → claim 48 s + 30 s poll).**
   This run neither confirmed nor beat the prediction on latency, because there was no claim to time. It
   missed for a different reason, the rate limit. Latency values that were measured:
   - label → launch: 24.1 s (run 3) and 4.8 s (run 2), inside D-10's 30 s poll.
   - launch → first model call attempt: 35.0 s (run 3). **30 s of that is the Hermes `pre_llm_call` hook timeout**
     (`Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping`).
   - 02-09's tracer session has the same line: turn start 02:11:00.980, hook timeout 02:11:32.480, API call #1 at
     02:11:36.929 with `latency=4.4s`. So about 31.5 s of the tracer's 48 s launch → claim was this hook timeout,
     not the model.
   - [INFERENCE: name match only] The enabled `observability/langfuse` plugin defines a callback named
     `on_pre_llm_call` and is listed under `plugins:` in `/root/.hermes/config.yaml`.
   - Recorded, not fixed.
4. **Anthropic rate limit blocks dispatched sessions, and Hermes' 429 backoff equals D-14's timeout.**
   - The observed 429s came at 04:59:50 (a host session that substrate did not start), 05:02:55 (run 2) and
     05:14:45 (run 3). No Anthropic call succeeded on the host after 04:59:25.
   - `hermes usage --provider anthropic` at 05:13:09 showed session 85% remaining and week 17% remaining, so it
     was not window exhaustion.
   - Each first call sends about 112k input tokens (`in=112761` at 04:59:25). SOUL.md, at 274607 characters, is
     truncated to 240000 in every system prompt.
   - Hermes retries a 429 after 600 s. D-14 terminates at 600 s without a claim, so a single first-call 429
     always ends in `[claim-timeout]`.
   - Recorded, not fixed. The owner decides whether to shrink the context, change the backoff or the claim
     timeout, or re-run when the account is clear.
5. **Issue text cannot be read by the dispatched Hermes.** The prompt's step 3 says
   `read issue SWC-467 with your Linear tool`. The session is launched with `-t terminal,file` (86ee031) and has
   no Linear tool. 02-09 found that Hermes' own `LINEAR_API_KEY` belongs to another workspace (`swcstudio`/SPE).
   In this run the session never got that far, but the gap stands for any successful run. Recorded, not fixed.
6. **Notion (notion_skipped=false) was not exercised.** `t_notion_agent=none`: Agent hermes was never observed
   because nothing claimed. Status, Linear State and Completed stayed unset (`notion_status_final=unset`,
   `notion_linear_state_final=unset`, `notion_completed_final=unset`) because nothing completed. The PR fields
   are unchanged (`pr_fields_unchanged=true`). The row `3e6bc1a0-c7ae-8102-8a05-f31661fbc812` stays in the
   Agent Task Graph and is titled throwaway.
7. **SC-2 / D-06 gated completion not exercised.** The operator's graph_complete was refused with
   `node is not claimed` before any write, and the connector gate was never reached. `final_linear_state=Todo`,
   not Done.
8. **Deviation: one issue reused across three runs.** The plan wants a new throwaway issue per repeat. The
   workspace was at 249/250 and this plan was allowed exactly one issue, so SWC-467 and graph
   `ut-mughkkc0-73909228` were reused. Before each retry the operator restarted substrate-dispatcher to clear
   `given_up`. The issue therefore carries two dispatcher comments and six label history rows from the three
   runs. Its GitHub twin is swcstudiospace/agent_runtime#327; no GitHub action was taken.
9. **Hermes and SIGTERM.** 02-09 saw Hermes ignore SIGTERM. Here both terminated sessions honoured it:
   run 2 with a soft interrupt, and run 3 with a hard interrupt and exit code 130. No SIGKILL was needed,
   so the reaper's SIGKILL fallback went unexercised.
10. **Owner check pending.** No real Claude Code prompt has been checked. There is no claim for it to show.
11. **Task 2 `<verify>` fails. That is the honest outcome.** Run verbatim with `/usr/bin/bash` at 05:27Z, it exited 1.
    Diagnosis, one check at a time:
    - failed: `brief_evidence=none`, because the brief never showed the claim
    - failed: "notion outcome wrong", with `t_notion_agent=none` and `notion_status_final=unset`
    - would fail next: the live Linear check. SWC-467 is `Todo`, with no `agent:hermes`
    - passed: latency gap present, prediction gap present, worktree registered on `[substrate/ut-mughkkc0-73909228]`,
      main checkout on `main`, `hermes sessions export` for 20260925_051412_dc133a non-empty (exit 0)
    - Task 1 `<verify>` still exits 0.
