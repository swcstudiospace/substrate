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

    ### Run 3 — SWC-467 / ut-mughkkc0-73909228, label 05:13:46Z, D-14 claim timeout 05:24:27Z

    Reason: HTTP 429 from Anthropic on the first model call (05:14:45). Hermes backed off for 600 s, and the then-600 s D-14 claim timeout fired first (05:24:27). The owner then raised CLAIM_TIMEOUT_SECONDS to 900 (a6e9604, D-14 amended) and authorized run 4 on the same issue (D-16 amended).


    Result: **the proof did not complete.** substrate-dispatcher picked up the label and launched a real
    Hermes session in the per-graph worktree. That session never made a model turn: its first Anthropic
    API call returned HTTP 429 (`This request would exceed your account's rate limit`). Hermes backed off
    for 600 s, and D-14's 600 s claim timeout ended the session before the retry. There was no claim, so
    the Linear In Progress, Notion Agent, brief and DoD-gated completion checks had nothing to observe.
    Every miss is listed under Gaps. This was attempt 3 of 3 (runs 1 and 2 are under ## Failed runs).

    #### Label and watch

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

    #### Dispatcher journal (every line that is not `tick: 1 candidate`, 05:14:00Z → 05:25:29Z)

    ```
    2026-09-25T05:14:10.483596+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 1 candidate issue(s)
    2026-09-25T05:14:10.968645+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1395973 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T051410Z.log
    2026-09-25T05:24:27.691693+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] SWC-467: no claim within 600 s; terminating pid 1395973
    2026-09-25T05:24:28.382295+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 0 candidate issue(s)
    2026-09-25T05:24:58.382606+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] SWC-467: terminated session pid 1395973 ended (code 130)
    2026-09-25T05:24:59.046557+00:00 vps substrate-dispatcher[1395019]: [substrate-dispatcher] tick: 0 candidate issue(s)
    ```

    #### The Hermes session (proved by export, not asserted)

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

    #### Claim, Linear, Notion and brief

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

    #### Completion (SC-2)

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

    #### Final state (read at 05:25:03Z)

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

    #### Worktree and D-13

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

    #### Timeline (UTC, final run)

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

    #### Result lines (final run; observed values, `none` = never observed)

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

    #### Gaps (run 3)

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

    ### Run 4 — SWC-467 / ut-mughkkc0-73909228, label 05:38:32Z, D-14 claim timeout (900 s) 05:54:20Z

    Reason: HTTP 429 from Anthropic on claude-fable-5-1, at 05:39:29 and again on the in-session retry at 05:49:30. The 900 s D-14 timeout fired at 05:54:20 with no claim. The owner then chose to dispatch with another model: be5e34d added SUBSTRATE_DISPATCH_MODEL, substrate.env was set to `SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5`, and D-13 was amended. Run 5 was authorized on the same issue.

    Result: **the proof did not complete.** substrate-dispatcher picked up the label and launched a real
    Hermes session in the per-graph worktree. That session never made a model turn: its first Anthropic
    call returned HTTP 429 at 05:39:29, and its in-session retry at 05:49:30 returned HTTP 429 again. The
    900 s D-14 timeout ended it at 05:54:20. Hermes' credential pool logged
    `claude_code unavailable for model claude-fable-5-1; other models stay available`, so the limit is
    per model. There was no claim, so the Linear, Notion, brief and DoD-gate checks had nothing to observe.
    As the orchestrator instructed, there is no run 5.

    #### Label and watch

    Operator action: `issueUpdate(id: <linear_issue_id from graph_get>, input: { addedLabelIds: [<dispatch_label_id>] })`, from
    `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-watch.py`.

    - The script was recreated for this run with a 960 s window.
    - It polls every 5 s: the dispatcher journal, graph_get, Linear, the Notion row, and POST /brief both
      scoped and unscoped.
    - It stops early when the dispatcher logs that it gave up.
    - It holds no key and prints key=value lines only. It exited 0.

    Output, verbatim and indented:

        watch_linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
        watch_linear_identifier_from_graph_get=SWC-467
        pre_label_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
        t_label=2026-09-25T05:38:32.159Z
        label_response={"success": true, "state": "Todo", "labels": ["dispatch:hermes"]}
        # 2026-09-25T05:38:32.162Z linear state=Todo labels=['dispatch:hermes']
        # 2026-09-25T05:38:32.161Z n1 state=unstarted claimed_by=None
        # 2026-09-25T05:38:32.692Z notion {"Agent": "", "Status": null, "Linear State": null, "Completed": null}
        # journal: 2026-09-25T05:38:54.218204+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1455441 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T053854Z.log
        t_launch=2026-09-25T05:38:57.172Z
        launch_line=2026-09-25T05:38:54.218204+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1455441 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T053854Z.log
        hermes_pid=1455441
        worktree=/var/lib/substrate/worktrees/ut-mughkkc0-73909228
        session_log=/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T053854Z.log
        # journal: 2026-09-25T05:54:20.653102+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] SWC-467: no claim within 900 s; terminating pid 1455441
        # 2026-09-25T05:54:22.187Z linear state=Todo labels=[]
        dispatcher_gave_up=true
        t_claim_missing=true
        t_linear_in_progress_missing=true
        t_notion_agent_missing=true
        t_brief_missing=true
        linear_last_seen={"at": "2026-09-25T05:54:22.187Z", "state": "Todo", "labels": []}
        watch_iterations=191
        watch_end=2026-09-25T05:54:23.517Z

    #### Dispatcher journal (every line that is not `tick: 1 candidate`, from 05:38:00Z; plus the pickup tick)

    ```
    2026-09-25T05:38:23.411661+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] tick: 0 candidate issue(s)
    2026-09-25T05:38:53.719908+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] tick: 1 candidate issue(s)
    2026-09-25T05:38:54.218204+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1455441 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T053854Z.log
    2026-09-25T05:54:20.653102+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] SWC-467: no claim within 900 s; terminating pid 1455441
    2026-09-25T05:54:21.250274+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] tick: 0 candidate issue(s)
    2026-09-25T05:54:51.250738+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] SWC-467: terminated session pid 1455441 ended (code 130)
    2026-09-25T05:54:51.251324+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)
    ```

    #### The Hermes session (proved by export, not asserted)

    - Operator observation at 05:39:02Z: `readlink /proc/1455441/cwd` → `/var/lib/substrate/worktrees/ut-mughkkc0-73909228`,
      and the parent is 1436069, the dispatcher's MainPID.
    - Its argv was not captured in this run. a6e9604 did not touch launcher.py, and run 3's argv (under ## Failed runs)
      is `… hermes chat --query-file … -Q --pass-session-id --source substrate-dispatcher --max-turns 60 --run-budget 3600 -t terminal,file`,
      with no `--yolo`.
    - The session log `/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T053854Z.log`, complete:

    ```
    ⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.

    session_id: 20260925_053855_6e606f
    ```

    - `hermes sessions export --format jsonl --redact --session-id 20260925_053855_6e606f -` (stdout) exited 0 and wrote
      239026 bytes. Parsed fields, verbatim:

    ```
    export_lines=1
    id="20260925_053855_6e606f"
    source="substrate-dispatcher"
    cwd=null
    model="claude-fable-5-1"
    title="You were dispatched by substrate-dispatcher for\u2026 #3"
    started_at=1790314738.654022
    ended_at=1790315662.7320504
    end_reason="cli_close"
    tool_call_count=0
    message_count=1
    git_branch=null
    tool_names={}
    first_message_ts=1790314737.8472466
    last_message_ts=1790314737.8472466
    ```

      The export has `source="substrate-dispatcher"`, `model="claude-fable-5-1"`, `tool_call_count=0` and one message
      (the prompt), so there is **no first tool call to quote**. `cwd` is null in the export; the worktree cwd is
      proven by `/proc` above.
    - Hermes' own log (`/root/.hermes/logs/agent.log`), every line tagged with this session, cut at 400 characters:

    ```
    2026-09-25 05:38:57,847 INFO [20260925_053855_6e606f] agent.turn_context: conversation turn: session=20260925_053855_6e606f model=claude-fable-5-1 provider=anthropic platform=cli history=0 msg='You were dispatched by substrate-dispatcher for Linear issue SWC-467, graph ut-m...'
    2026-09-25 05:38:57,875 WARNING [20260925_053855_6e606f] agent.prompt_builder: Context file SOUL.md matched injection pattern(s) prompt_injection; loaded anyway because it is the user's own file in HERMES_HOME — review it if you did not write that text
    2026-09-25 05:38:57,875 WARNING [20260925_053855_6e606f] agent.prompt_builder: ⚠️  Context file SOUL.md TRUNCATED: 274607 chars exceeds limit of 240000 — trim the file, pin a larger context_file_max_chars, or use a larger-context model!
    2026-09-25 05:39:28,662 WARNING [20260925_053855_6e606f] hermes_cli.plugins: Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping
    2026-09-25 05:39:29,373 WARNING [20260925_053855_6e606f] agent.conversation_loop: API call failed (attempt 1/3) error_type=RateLimitError thread=MainThread:128576454711104 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 summary=HTTP 429: This request would exceed your account's rate limit. Please try again later.
    2026-09-25 05:39:29,375 WARNING [20260925_053855_6e606f] agent.conversation_loop: Retrying API call in 600s (attempt 1/3) thread=MainThread:128576454711104 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 policy=default error=Error code: 429 - {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': "This request would exceed your account's rate limit. Please 
    2026-09-25 05:49:30,211 INFO [20260925_053855_6e606f] agent.credential_pool: credential pool: claude_code unavailable for model claude-fable-5-1; other models stay available
    2026-09-25 05:49:30,211 INFO [20260925_053855_6e606f] agent.credential_pool: credential pool: no available entries (all exhausted or empty)
    2026-09-25 05:49:30,213 WARNING [20260925_053855_6e606f] agent.conversation_loop: API call failed (attempt 2/3) error_type=RateLimitError thread=MainThread:128576454711104 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 summary=HTTP 429: This request would exceed your account's rate limit. Please try again later.
    2026-09-25 05:49:30,214 WARNING [20260925_053855_6e606f] agent.conversation_loop: Retrying API call in 600s (attempt 2/3) thread=MainThread:128576454711104 provider=anthropic base_url=https://api.anthropic.com model=claude-fable-5-1 policy=default error=Error code: 429 - {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': "This request would exceed your account's rate limit. Please 
    2026-09-25 05:54:20,969 INFO [20260925_053855_6e606f] run_agent: Interrupt requested (hard): explicit stop requested
    2026-09-25 05:54:22,488 INFO [20260925_053855_6e606f] run_agent: Interrupt requested (soft): user sent a new message
    2026-09-25 05:54:22,513 INFO hermes_eng_board.hooks: autopilot session=20260925_053855_6e606f action=skipped stages=['classify'] task=None linear=None
    2026-09-25 05:54:22,756 INFO [20260925_053855_6e606f] hermes_eng_board.hooks: autopilot session=20260925_053855_6e606f action=skipped stages=['classify'] task=None linear=None
    2026-09-25 05:54:23,819 INFO [20260925_053855_6e606f] cli: CLI cleanup calling memory shutdown for session 20260925_053855_6e606f with 1 message(s)
    ```

    - Untagged lines from the same process:
      - `2026-09-25 05:39:30,002 INFO agent.credential_pool: credential pool: marking claude_code exhausted (status=429), rotating`
      - `05:49:30,193 ERROR agent.chat_completion_helpers: Streaming failed before delivery: Error code: 429 - {… 'rate_limit_error', 'message': "This request would exceed your account's rate limit. Please try again later."}, 'request_id': 'req_011CfPdgQ73BRkhGwwgzyB5o'}`
      - The 05:49:30 retry therefore reached the API and was refused. It was not a local pool short-circuit.
    - `/usr/local/lib/hermes-agent/agent/credential_pool.py:2243-2248` treats this as `A generic Anthropic 429 (per-model rate limit)`.
    - Hermes honoured SIGTERM, and the reaper logged exit code 130. No SIGKILL was needed.

    #### Claim, Linear, Notion and brief

    - **graph_get:** at every 5 s poll from 05:38:32Z to 05:54:23Z, n1 was `unstarted` with `claimed_by null`.
      It was the same at the final read, 05:55:00Z.
    - **Linear:** SWC-467 stayed `Todo`. `dispatch:hermes` was present from 05:38:31.968Z until D-14 removed it at
      05:54:20.822Z. No `agent:hermes` label was added, and no claim comment was posted.
      - The `[claim-timeout]` marker comment was not posted again (once-only). The run-2 comment's text still says 10 minutes.
    - **Notion row:** `Agent ""` at every poll, with no mirror call. `last_edited_time` is still `2026-09-25T04:54:00.000Z`.
    - **POST /brief:** neither brief ever showed `started by hermes` or a `hermes … claimed SWC-467` line.
      Scoped and unscoped, at 05:55:13Z:

        ## Substrate brief: swcstudiospace/agent-substrate — ut-mughkkc0-73909228
        Implementing · PR none yet
        Nodes: n1 SWC-467 unstarted

        Last 5 agent actions in this repo
        - 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)
        - 05:27 cursor       commit 14ce954 docs(02-08): proof run — dispatch launched Hermes 3 times, no claim (import crash, then Anthropic 429 ×2)
        - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
        - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
        - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release

        Other open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

        -----

        ## Substrate brief: swcstudiospace/agent-substrate

        Last 5 agent actions in this repo
        - 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)
        - 05:27 cursor       commit 14ce954 docs(02-08): proof run — dispatch launched Hermes 3 times, no claim (import crash, then Anthropic 429 ×2)
        - 04:55 cursor       commit f8133f0 docs(02-08): proof setup — SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on
        - 04:51 cursor       commit 4a984f2 docs(02-06): complete Notion Issue-row mirror plan summary
        - 04:49 cursor       commit 963be21 docs(02-06): live Notion smoke — Agent set on claim and cleared on release

        Other open graphs here: ut-mughkkc0-73909228 (Implementing) · ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

    #### Completion (SC-2)

    The session made no graph_complete call (tool_call_count 0), and its pid had ended by 05:54:51Z. As the
    operator, at 05:55:13.314Z, I called MCP `graph_complete`
    `{graph_id: "ut-mughkkc0-73909228", node_id: "n1", surface: "hermes", session_id: "20260925_053855_6e606f", dod: {summary: "02-08 proof: no change needed", tests_pass: true}}`.
    This was an operator call, not a model action. Response, verbatim:

    ```
    {"completed": false, "reason": "node is not claimed", "node": {"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}}
    ```

    The ownership check refused the call before any write, so the DoD gate was never reached. The graph was
    **not** marked Done. It stays `Implementing` with n1 `unstarted`, so a later re-run can reuse it.

    #### Final state (read at 05:55:00Z)

    `sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-final.py`, exit 0, verbatim.
    `event_rows=0`: Greptime `agent_events` has no row for this graph.

        final_read_at=2026-09-25T05:55:00Z
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
        linear_history={"createdAt": "2026-09-25T05:38:31.968Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
        linear_history={"createdAt": "2026-09-25T05:54:20.822Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
        notion_parent_ds=be3418f0-d2d8-411b-8677-fa8a95ee63be
        notion_last_edited_time=2026-09-25T04:54:00.000Z
        notion_final={"Item": "[n1] substrate 02 proof \u2014 throwaway", "Agent": "", "Status": null, "Linear State": null, "Completed": null, "Graph ID": "ut-mughkkc0-73909228", "Issue ID": "SWC-467"}
        pr_fields_after={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}
        pr_fields_equal_before=true
        greptime_output_len=1
        event_rows=0

    #### Worktree and D-13

    - `git worktree list`: `/var/lib/substrate/worktrees/ut-mughkkc0-73909228  f8133f0 [substrate/ut-mughkkc0-73909228]`.
      Its porcelain is empty (0 lines).
    - `git -C /root/src/repos/agent-substrate branch --show-current` → `main`.
    - Main checkout porcelain before run 4 (05:38:05Z) and after (05:55:13Z):

         M .planning/config.json
         M .planning/phases/02-claims-and-dispatch/02-PROOF.md
         M .planning/state.json
        ?? issues/

        -----

         M .planning/config.json
         M .planning/phases/02-claims-and-dispatch/02-PROOF.md
         M .planning/state.json
        ?? issues/

      They are identical. The only change against the 04:53:08Z snapshot is this file.
    - `df -BG --output=avail /` → `29G`.

    #### Dispatch switch after the run (owner-directed)

    Operator action at 2026-09-25T05:54:38Z: `echo 'SUBSTRATE_DISPATCH_DISABLED=1' | sudo tee -a /etc/substrate/substrate.env > /dev/null`.

    - The switch lines are now 18 `=1`, 21 `=0`, 22 `=1`, 23 `=0` and 24 `=1`. The last line wins.
    - There was no restart (`MainPID` 1436069). Journal:
      `2026-09-25T05:54:51.251324+00:00 … [substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`.
    - The plan says `dispatch_switch_final=0`. The owner directed "keep dispatch off except during the proof",
      so this deviation is recorded as `dispatch_switch_final=1`.

    #### Timeline (UTC, final run)

    | Time | Event | Source |
    |---|---|---|
    | 05:30:52 | substrate-dispatcher restarted by the orchestrator with a6e9604 (claim timeout 900 s), switch at 1 | journal |
    | 05:38:06 | `SUBSTRATE_DISPATCH_DISABLED=0` appended (operator) | shell |
    | 05:38:23.412 | `tick: 0 candidate issue(s)`: the switch was taken without a restart | journal |
    | 05:38:32.159 | `dispatch:hermes` applied to SWC-467 (`t_label`) | watch |
    | 05:38:53.720 | `tick: 1 candidate issue(s)` | journal |
    | 05:38:54.218 | `launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1455441 …` | journal |
    | 05:38:57.172 | the watch sees the launch line (`t_launch`) | watch |
    | 05:38:57.847 | Hermes conversation turn starts (session 20260925_053855_6e606f) | agent.log |
    | 05:39:28.662 | `Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s` | agent.log |
    | 05:39:29.373 | first Anthropic call → HTTP 429; `Retrying API call in 600s (attempt 1/3)` | agent.log |
    | 05:49:30.193 | retry → HTTP 429 (`req_011CfPdgQ73BRkhGwwgzyB5o`); `claude_code unavailable for model claude-fable-5-1` | agent.log |
    | 05:49:30.214 | `Retrying API call in 600s (attempt 2/3)`, due 05:59:30, after the 900 s timeout | agent.log |
    | 05:54:20.653 | D-14: `no claim within 900 s; terminating pid 1455441` | journal |
    | 05:54:20.822 | `dispatch:hermes` removed from SWC-467 | Linear history |
    | 05:54:38 | `SUBSTRATE_DISPATCH_DISABLED=1` appended (operator, owner-directed) | shell |
    | 05:54:51.251 | `terminated session pid 1455441 ended (code 130)`; `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` | journal |
    | 05:55:13.314 | operator `graph_complete` → `completed: false, "node is not claimed"` | MCP |

    Latencies measured in this run:

    - label → pickup tick: 21.6 s.
    - label → launch line: 22.1 s.
    - launch → Hermes turn start: 3.6 s.
    - launch → first model call attempt: 35.2 s. Of that, 30.8 s went from turn start to the `pre_llm_call` hook timeout.
    - launch → claim: not measured, because there was no claim.

    #### Result lines (final run; observed values, `none` = never observed)

    hermes_session_id=20260925_053855_6e606f
    t_label=2026-09-25T05:38:32.159Z
    t_launch=2026-09-25T05:38:57.172Z
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
    dispatch_switch_final=1

    #### Gaps (run 4)

    1. **The ROADMAP Phase 2 proof was not achieved (SC-1, SC-2 and SC-3's claim half).** In four runs on SWC-467,
       no dispatched Hermes session claimed n1.
       - Run 1: import crash.
       - Runs 2, 3 and 4: Anthropic HTTP 429 on every model call.
       - So `t_claim`, `t_linear_in_progress`, `t_notion_agent` and `t_brief` were never observed. Linear never showed
         In Progress / `agent:hermes` / a claim comment. The Notion row never showed Agent hermes. POST /brief never
         showed `started by hermes` or a `hermes … claimed SWC-467` line.
       - What *was* observed, four times: SC-3's dispatch half. The label → poll → `graph_find` → worktree →
         real `hermes chat` path ran, with cwd `/var/lib/substrate/worktrees/ut-mughkkc0-73909228` on
         `substrate/ut-mughkkc0-73909228` while the main checkout stayed on `main`.
       - Also observed: D-14's `[exited-unclaimed]` and `[claim-timeout]` handling, and the D-15 switch taken live
         in both directions (`=0` → `tick:`, `=1` → `dispatch disabled`).
    2. **`within_60s=false`.** The brief never showed a claim, so the 60 s budget was missed with no delta to
       compute (`delta_label_to_brief_s=none`).
    3. **Latency: `tracer_projected_within_60s=false` (02-09: launch → claim 48 s, plus the 30 s poll = 78 s).**
       This run neither confirmed nor beat the prediction on latency, because there was no claim to time. It
       missed on the rate limit. Measured values:
       - label → launch: 22.1 s (run 4), 24.1 s (run 3) and 4.8 s (run 2). All are inside D-10's 30 s poll.
       - launch → first model call attempt: 35.2 s (run 4) and 35.0 s (run 3).
       - Recorded, not fixed. The poll interval and the proof wording are locked.
    4. **The 30 s Hermes `pre_llm_call` hook timeout dominates start-up.** Every dispatched session logs
       `Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping` about 30.8 s after its turn starts.
       - 02-09's tracer has the same line: turn 02:11:00.980, hook timeout 02:11:32.480, API call #1 at 02:11:36.929
         with `latency=4.4s`. About 31.5 s of its 48 s launch → claim was this hook, not the model.
       - Without it, the projection would be about 17 s + ≤ 30 s poll = ≤ 47 s [INFERENCE: arithmetic on the tracer's
         timings, not measured].
       - [INFERENCE: name match only] The enabled `observability/langfuse` plugin defines `on_pre_llm_call` and is
         listed under `plugins:` in `/root/.hermes/config.yaml`.
       - Recorded, not fixed.
    5. **Anthropic per-model rate limit on `claude-fable-5-1` blocks every dispatched session.**
       - The 429s: 04:59:50 (a host session substrate did not start), 05:02:55 (run 2), 05:14:45 (run 3), and
         05:39:29 and 05:49:30 (run 4). No Anthropic call succeeded on the host after 04:59:25.
       - The API message is `This request would exceed your account's rate limit`.
       - Hermes' credential pool classifies it as `A generic Anthropic 429 (per-model rate limit)` and logs
         `claude_code unavailable for model claude-fable-5-1; other models stay available`.
       - `hermes usage` windows were not exhausted: session 22% used, week 84% used at 05:37:50.
       - Each first call carries about 112k input tokens (SOUL.md, at 274607 characters, is truncated to 240000).
       - The 900 s claim timeout (a6e9604) did let run 4 make its one in-session retry, but that retry also got 429.
       - Recorded, not fixed. The owner decides: wait out the per-model limit, dispatch with another model, or
         shrink the context.
    6. **Issue text cannot be read by the dispatched Hermes.** The prompt's step 3 says
       `read issue SWC-467 with your Linear tool`, but sessions launch with `-t terminal,file` (86ee031) and have no
       Linear tool. 02-09 found that Hermes' own `LINEAR_API_KEY` belongs to another workspace (`swcstudio`/SPE).
       No run got that far, but the gap stands for any successful run. Recorded, not fixed.
    7. **The run-1 `prompt_toolkit` import crash is unexplained.** Hermes exited with code 1:
       `ModuleNotFoundError: No module named 'prompt_toolkit.document'`. `document.py` is present. The same import
       passed afterwards, both plain and under the unit's hardening, and runs 2–4 started normally. The root cause
       was not established.
    8. **Notion (notion_skipped=false) was not exercised.** `t_notion_agent=none`: Agent hermes was never observed.
       Status, Linear State and Completed stayed unset (`notion_status_final=unset`, `notion_linear_state_final=unset`,
       `notion_completed_final=unset`). The PR fields are unchanged (`pr_fields_unchanged=true`). Row
       `3e6bc1a0-c7ae-8102-8a05-f31661fbc812` stays in the Agent Task Graph, titled throwaway.
    9. **SC-2 / D-06 gated completion was not exercised.** The operator's graph_complete was refused with `node is not claimed`
       before any write, and the connector gate was never reached. `final_linear_state=Todo`, not Done.
    10. **Deviation: one issue reused across four runs.** The workspace was at 249/250.
        - Runs 2 and 3: the operator restarted substrate-dispatcher first to clear `given_up`.
        - Run 4: the owner authorized it (D-16 amended), after the orchestrator's restart for a6e9604.
        - The issue carries two dispatcher comments and eight label history rows. Its GitHub twin is
          swcstudiospace/agent_runtime#327; no GitHub action was taken.
    11. **Deviation: `dispatch_switch_final=1`.** The plan leaves dispatch live (`0`). The owner directed "keep dispatch
        off except during the proof", so `SUBSTRATE_DISPATCH_DISABLED=1` was appended at 05:54:38Z and the
        journal confirmed `dispatch disabled` at 05:54:51Z.
    12. **No cheap probe exposes the short-window limit.** `hermes usage` reports only the session and week windows.
        Three small `hermes -z … --ignore-user-config --ignore-rules` probes hung without making an API call
        (`api_calls: null`), so run 4 went ahead on the usage check alone.
    13. **Hermes and SIGTERM.** 02-09 saw Hermes ignore SIGTERM. Here all three terminated sessions (runs 2–4)
        honoured it, the last two with exit code 130. The reaper's SIGKILL fallback went unexercised.
    14. **Owner check pending.** No real Claude Code prompt has been checked. There is no claim for it to show.
    15. **Verify results.**
        - Task 2 `<verify>`, run verbatim with `/usr/bin/bash` at about 05:57Z, exits **1**. That is the honest outcome.
          - Every key appears once at column 0, and there is one `## Gaps` heading.
          - It first fails on `brief_evidence=none`, then on "notion outcome wrong" (`t_notion_agent=none`).
            The live Linear check would fail next: SWC-467 is `Todo`, with no `agent:hermes`.
          - Checks that pass: the latency gap, the prediction gap, the worktree on
            `[substrate/ut-mughkkc0-73909228]`, the main checkout on `main`, and `hermes sessions export` for
            20260925_053855_6e606f (exit 0, non-empty).
        - Task 1 `<verify>` now exits **1**, only on its last clause: the latest tick line is `dispatch disabled`,
          because of the owner-directed switch-off (item 11). With that journal clause removed, it exits 0.

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

The first flip, for runs 1–3, happened at 2026-09-25T04:54:52Z. The `switch_flipped_at=` line below is the run-4 flip.

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

### Run 4 setup (the final run, owner-authorized re-run on SWC-467)

Owner decisions, relayed by the orchestrator after run 3:

- `CLAIM_TIMEOUT_SECONDS` is raised to 900, so the claim timeout now outlasts Hermes' 600 s 429 backoff
  (commit a6e9604, D-14 amended in 02-CONTEXT.md).
- Re-runs reuse SWC-467 and graph `ut-mughkkc0-73909228` (D-16 amended).
- Dispatch stays off except during the proof. The orchestrator appended `SUBSTRATE_DISPATCH_DISABLED=1`
  (line 22) and restarted substrate-dispatcher at 05:30:52Z. The new `MainPID` is 1436069, and the journal
  shows `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` at 05:30:53.

Rate-window check, before the switch was flipped:

- `hermes usage --provider anthropic`:
  - 05:31:23Z: session 20% used, week 84% used.
  - 05:37:50Z: session 22% used (`78% remaining`), week 84% used.
  - Neither window was exhausted. The 429s in runs 2 and 3 came from a short-window limit that this check
    does not report.
- `/root/.hermes/logs/agent.log` has no Anthropic call, successful or 429, after 05:14:45 (run 3's 429).
- The operator tried three small `hermes -z "Reply with the single word OK." --ignore-user-config --ignore-rules --provider anthropic -m claude-fable-5-1 -t file`
  probes from /tmp, to avoid a 112k-token call:
  - 05:32:12, killed at 120 s
  - 05:34:43, SIGINT at 75 s
  - 05:36:16, stdin `/dev/null`, SIGINT at 60 s
  - None produced output. Each `--usage-file` report had `api_calls: null`, `session_id: null`,
    `failure: KeyboardInterrupt()`. They were inconclusive and were not repeated.
- Decision: proceed. The one available cheap check showed capacity, 23 minutes had passed since the last
  429, and the 900 s timeout lets a single first-call 429 retry inside the claim window.

Re-checked at 05:38:05Z:

- The main checkout is on `main`. Its porcelain is the 04:53:08Z snapshot plus this file.
- The worktree porcelain is empty, and `df` shows `29`.
- The three units are `active`.

Operator action: `echo 'SUBSTRATE_DISPATCH_DISABLED=0' | sudo tee -a /etc/substrate/substrate.env > /dev/null`.

- It returned at 2026-09-25T05:38:06Z.
- The switch lines are now 18 `=1`, 21 `=0`, 22 `=1` and 23 `=0`.
- There was no restart (`MainPID` 1436069). The first tick after the flip:

```
2026-09-25T05:38:23.411661+00:00 vps substrate-dispatcher[1436069]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

The run-4 flip happened at 2026-09-25T05:38:06Z. The `switch_flipped_at=` line below is the run-5 flip.

### Run 5 setup (the final run, owner-authorized re-run with another model)

Owner decision, relayed by the orchestrator after run 4: dispatch with another model.

- Commit be5e34d adds `SUBSTRATE_DISPATCH_MODEL` to `launcher.build_argv`, which appends `-m <model>`.
- substrate.env has `SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5` (`sudo grep -c` → `1`), and D-13 is amended in 02-CONTEXT.md.
- The orchestrator restarted substrate-dispatcher at 06:48:56Z. The new `MainPID` is 1586416, and its
  `/proc/<pid>/environ` holds the model line (`grep -c` → `1`). The switch was at 1: the journal showed
  `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` at 06:48:56.
- `hermes usage --provider anthropic` at 06:49Z: session 27% used, week 86% used.

Re-checked at 06:50:20Z:

- The main checkout is on `main`, and its porcelain is identical to the 04:53:08Z snapshot.
- The worktree porcelain is empty, `df` shows `30`, and the three units are `active`.

Operator action: `echo 'SUBSTRATE_DISPATCH_DISABLED=0' | sudo tee -a /etc/substrate/substrate.env > /dev/null`.

- It returned at 2026-09-25T06:50:20Z. The switch is now line 26 `=0`; line 25 is the model line.
- There was no restart. The first tick after the flip:

```
2026-09-25T06:50:26.831541+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] tick: 0 candidate issue(s)
```

switch_flipped_at=2026-09-25T06:50:20Z

## Proof run (run 5, the final run): label → dispatch → claim → Linear, Notion, brief → DoD-gated Done

Result: **the chain ran end to end.**

- substrate-dispatcher launched a real Hermes session with `-m claude-opus-5.5` in the per-graph worktree.
- That session claimed n1 as hermes. The claim reached Linear (In Progress, `agent:hermes`, `dispatch:hermes`
  removed, a session comment), the Notion Issue row (Agent `hermes`) and POST /brief (`started by hermes`).
- The model did **not** complete the node. It could not read the issue text (Gap: issue text) and stopped
  after the claim.
- As the operator, I completed n1 through graph_complete with the claim session and DoD evidence. The
  connector's gate moved Linear In Review → Done, and the Notion row got Status Done, Linear State Done and
  Completed 2026-09-25.
- Label → brief took 65 s, so `within_60s=false`.

### Label and watch

Operator action: `issueUpdate(id: <linear_issue_id from graph_get>, input: { addedLabelIds: [<dispatch_label_id>] })`, from
`sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-watch.py`.

- It polls every 5 s: the journal, graph_get, Linear, Notion, and POST /brief both scoped and unscoped.
- It holds no key and prints key=value lines only.
- It exited 0 once every observation had been made.

Output, verbatim and indented. The two `brief_*_text` lines are the full brief bodies, JSON-escaped:

    watch_linear_issue_id_from_graph_get=3378743f-efc9-47f2-9962-3894dca6bb80
    watch_linear_identifier_from_graph_get=SWC-467
    pre_label_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}
    t_label=2026-09-25T06:50:33.150Z
    label_response={"success": true, "state": "Todo", "labels": ["dispatch:hermes"]}
    # 2026-09-25T06:50:33.153Z linear state=Todo labels=['dispatch:hermes']
    # 2026-09-25T06:50:33.152Z n1 state=unstarted claimed_by=None claim_session=None
    # 2026-09-25T06:50:33.650Z notion {"Agent": "", "Status": null, "Linear State": null, "Completed": null}
    # journal: 2026-09-25T06:50:57.618235+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1591232 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T065057Z.log
    t_launch=2026-09-25T06:50:58.162Z
    launch_line=2026-09-25T06:50:57.618235+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1591232 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T065057Z.log
    hermes_pid=1591232
    worktree=/var/lib/substrate/worktrees/ut-mughkkc0-73909228
    session_log=/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T065057Z.log
    t_claim=2026-09-25T06:51:38.153Z
    claim_evidence=claimed_by
    claimed_at=2026-09-25T06:51:37.753Z
    claim_session=20260925_065059_f7cea2
    graph_get_n1_at_claim={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "started", "claimed_by": "hermes", "claimed_at": "2026-09-25T06:51:37.753Z", "claim_session": "20260925_065059_f7cea2"}
    # 2026-09-25T06:51:38.153Z n1 state=started claimed_by=hermes claim_session=20260925_065059_f7cea2
    brief_node_line_first_seen=2026-09-25T06:51:38.154Z
    brief_node_line_line=Nodes: n1 SWC-467 started by hermes just now
    brief_node_line_text="## Substrate brief: swcstudiospace/agent-substrate \u2014 ut-mughkkc0-73909228\nImplementing \u00b7 PR none yet\nNodes: n1 SWC-467 started by hermes just now\n\nLast 5 agent actions in this repo\n- 06:48 cursor       commit be5e34d feat(02-04): SUBSTRATE_DISPATCH_MODEL selects the dispatched Hermes model\n- 05:56 cursor       commit 34a5681 docs(02-08): proof run 4 \u2014 Anthropic per-model 429 on claude-fable-5-1, no claim; dispatch off\n- 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)\n- 05:27 cursor       commit 14ce954 docs(02-08): proof run \u2014 dispatch launched Hermes 3 times, no claim (import crash, then Anthropic 429 \u00d72)\n- 04:55 cursor       commit f8133f0 docs(02-08): proof setup \u2014 SWC-467, Notion row, graph ut-mughkkc0-73909228, dispatch switch on\n\nOther open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)"
    t_brief=2026-09-25T06:51:38.154Z
    brief_evidence=node_line
    brief_line=Nodes: n1 SWC-467 started by hermes just now
    delta_label_to_brief_s=65
    within_60s=false
    # 2026-09-25T06:51:43.153Z linear state=In Progress labels=['agent:hermes']
    claim_comment_session=20260925_065059_f7cea2
    claim_comment_created_at=2026-09-25T06:51:40.859Z
    claim_comment_body="Claimed by hermes \u2014 session 20260925_065059_f7cea2 (graph ut-mughkkc0-73909228, node n1)"
    t_linear_in_progress=2026-09-25T06:51:43.153Z
    linear_in_progress_evidence=state
    linear_observed={"state": {"name": "In Progress", "type": "started"}, "labels": ["agent:hermes"]}
    linear_history_row={"createdAt": "2026-09-25T06:51:40.452Z", "fromState": {"name": "Todo"}, "toState": {"name": "In Progress"}}
    linear_comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    linear_comment={"body": "substrate-dispatcher: [exited-unclaimed] hermes session exited (code 1) without claiming the node \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T04:58:30.482Z"}
    linear_comment={"body": "substrate-dispatcher: [claim-timeout] no claim within 10 minutes \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T05:12:38.325Z"}
    linear_comment={"body": "Claimed by hermes \u2014 session 20260925_065059_f7cea2 (graph ut-mughkkc0-73909228, node n1)", "createdAt": "2026-09-25T06:51:40.859Z"}
    # 2026-09-25T06:51:43.586Z notion {"Agent": "hermes", "Status": null, "Linear State": "In Progress", "Completed": null}
    t_notion_agent=2026-09-25T06:51:43.586Z
    notion_at_agent={"Agent": "hermes", "Status": null, "Linear State": "In Progress", "Completed": null}
    brief_recent_actions_first_seen=2026-09-25T06:51:43.154Z
    brief_recent_actions_line=- 06:51 hermes       claimed SWC-467 (n1)
    brief_recent_actions_text="## Substrate brief: swcstudiospace/agent-substrate\n\nLast 5 agent actions in this repo\n- 06:51 hermes       claimed SWC-467 (n1)\n- 06:48 cursor       commit be5e34d feat(02-04): SUBSTRATE_DISPATCH_MODEL selects the dispatched Hermes model\n- 05:56 cursor       commit 34a5681 docs(02-08): proof run 4 \u2014 Anthropic per-model 429 on claude-fable-5-1, no claim; dispatch off\n- 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)\n- 05:27 cursor       commit 14ce954 docs(02-08): proof run \u2014 dispatch launched Hermes 3 times, no claim (import crash, then Anthropic 429 \u00d72)\n\nOther open graphs here: ut-mughkkc0-73909228 (Implementing, 1 node started) \u00b7 ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)"
    linear_last_seen={"at": "2026-09-25T06:51:43.153Z", "state": "In Progress", "labels": ["agent:hermes"]}
    watch_iterations=15
    watch_end=2026-09-25T06:51:44.461Z

### Dispatcher journal (every line that is not a tick line, plus the pickup tick)

```
2026-09-25T06:50:26.831541+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] tick: 0 candidate issue(s)
2026-09-25T06:50:57.147009+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] tick: 1 candidate issue(s)
2026-09-25T06:50:57.618235+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 pid 1591232 worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228 log /var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T065057Z.log
2026-09-25T06:51:58.972120+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] claim landed for SWC-467 (claimed_by, session 20260925_065059_f7cea2)
2026-09-25T06:52:59.738341+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] SWC-467: hermes pid 1591232 exited (code 0) after its claim (session 20260925_065059_f7cea2)
2026-09-25T06:54:30.770235+00:00 vps substrate-dispatcher[1586416]: [substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)
```

### The Hermes session (proved by export, not asserted)

- Process, observed by the operator at 06:51:15Z:
  - `readlink /proc/1591232/cwd` → `/var/lib/substrate/worktrees/ut-mughkkc0-73909228`
  - the parent is 1586416, the dispatcher
  - argv (`/proc/1591232/cmdline`), verbatim:

```
/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes chat --query-file /var/lib/substrate/dispatcher/prompts/ut-mughkkc0-73909228-n1-20260925T065057Z.md -Q --pass-session-id --source substrate-dispatcher --max-turns 60 --run-budget 3600 -t terminal,file -m claude-opus-5.5
```

  The argv contains `-m claude-opus-5.5`. It has no `--yolo` and no `dispatch_handoff_to_hermes.sh` (D-13).
- `hermes sessions export --format jsonl --redact --session-id 20260925_065059_f7cea2 -` (stdout) exited 0 and wrote
  270271 bytes. Parsed fields, verbatim:

```
export_lines=1
id="20260925_065059_f7cea2"
source="substrate-dispatcher"
cwd=null
model="claude-opus-5-5"
title="Claim node n1 and work SWC-467"
started_at=1790319062.266648
ended_at=1790319148.1132977
end_reason="cli_close"
tool_call_count=7
message_count=16
git_branch=null
tool_names={"terminal": 6, "tool_search": 1}
first_tool_call_ts=1790319097.1426475
first_tool_call={"id": "toolu_01HBcoho2Q4bFrKSis2zMpZK", "call_id": "toolu_01HBcoho2Q4bFrKSis2zMpZK", "response_item_id": "fc_toolu_01HBcoho2Q4bFrKSis2zMpZK", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\": \"curl -sS -X POST http://127.0.0.1:7410/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"method\\\":\\\"tools/call\\\",\\\"params\\\":{\\\"name\\\":\\\"graph_claim\\\",\\\"arguments\\\":{\\\"graph_id\\\":\\\"ut-mughkkc0-73909228\\\",\\\"node_id\\\":\\\"n1\\\",\\\"surface\\\":\\\"hermes\\\",\\\"session_id\\\":\\\"20260925_065059_f7cea2\\\"}}}'\"}"}}
first_message_ts=1790319061.4009976
last_message_ts=1790319138.347262
```

  The model reported by the export is **`claude-opus-5-5`**. Hermes logged
  `Normalized model 'claude-opus-5.5' to 'claude-opus-5-5' for anthropic.` The source is `substrate-dispatcher`,
  and `cwd` is null in the export; the worktree cwd is proven by `/proc` above.
- Every tool call and result in the export, in order: UTC time, name, and the first 300 characters of the
  arguments or output. The Authorization values are redacted by `--redact`:

```
06:51:37.142 call terminal {"command": "curl -sS -X POST http://127.0.0.1:7410/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"graph_claim\",\"arguments\":{\"graph_id\":\"ut-mughkkc0-73909228\",\"node_id
06:51:42.838 result {"output": "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"claimed\\\": true,\\n  \\\"node\\\": {\\n    \\\"graph_id\\\": \\\"ut-mughkkc0-73909228\\\",\\n    \\\"node_id\\\": \\\"n1\\\",\\n    \\\"linear_issue_id\\\": \\\"3378743f-efc9-47f2-9962-3894dca6bb80\
06:51:45.024 call tool_search {"queries": ["linear issue get"]}
06:51:45.465 result {"queries": ["linear issue get"], "total_available": 1, "results": [{"query": "linear issue get", "matches": [], "available_sources": [{"name": "terminal", "tool_count": 1}], "hint": "This query returned no lexical matches, but the sources above are connected and their tools remain available. Retry 
06:51:49.426 call terminal {"command": "curl -sS -X POST http://127.0.0.1:7410/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\",\"params\":{}}' | grep -o '\"name\":\"[^\"]*\"'; ls /var/lib/substrate/worktrees/ut-mughkkc0-739092
06:51:50.041 result {"output": "\"name\":\"memory_brief\"\n\"name\":\"memory_write\"\n\"name\":\"memory_search\"\n\"name\":\"events_emit\"\n\"name\":\"graph_get\"\n\"name\":\"graph_find\"\n\"name\":\"graph_register\"\n\"name\":\"graph_claim\"\n\"name\":\"graph_release\"\n\"name\":\"graph_complete\"\nAGENTS.md\nREADME.m
06:51:54.164 call terminal {"command": "curl -sS -X POST http://127.0.0.1:7410/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"graph_get\",\"arguments\":{\"graph_id\":\"ut-mughkkc0-73909228\"}}}'; echo; 
06:51:55.291 result {"output": "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"graph_id\\\": \\\"ut-mughkkc0-73909228\\\",\\n  \\\"notion_task_page\\\": null,\\n  \\\"repo\\\": \\\"swcstudiospace/agent-substrate\\\",\\n  \\\"branch\\\": \\\"main\\\",\\n  \\\"surface\\\": null,\\
06:51:59.055 call terminal {"command": "curl -sS https://api.linear.app/graphql -H \"Authorization: ***" -H 'Content-Type: application/json' -d '{\"query\":\"{ issue(id:\\\"SWC-467\\\"){ identifier title description state{name} labels{nodes{name}} comments{nodes{body}} } }\"}'"}
06:52:01.341 result {"output": "{\"errors\":[{\"message\":\"Entity not found: Issue\",\"path\":[\"issue\"],\"locations\":[{\"line\":1,\"column\":3}],\"extensions\":{\"type\":\"invalid input\",\"code\":\"INPUT_ERROR\",\"statusCode\":400,\"userError\":true,\"userPresentableMessage\":\"Could not find referenced Issue.\"}}
06:52:04.209 call terminal {"command": "curl -sS https://api.linear.app/graphql -H \"Authorization: ***" -H 'Content-Type: application/json' -d '{\"query\":\"{ issue(id:\\\"3378743f-efc9-47f2-9962-3894dca6bb80\\\"){ identifier title description state{name} comments{nodes{body}} } viewer{ organization{urlKey} } }\"}'"}
06:52:05.147 result {"output": "{\"errors\":[{\"message\":\"Entity not found: Issue\",\"path\":[\"issue\"],\"locations\":[{\"line\":1,\"column\":3}],\"extensions\":{\"type\":\"invalid input\",\"code\":\"INPUT_ERROR\",\"statusCode\":400,\"userError\":true,\"userPresentableMessage\":\"Could not find referenced Issue.\"}}
06:52:08.350 call terminal {"command": "curl -sS https://api.linear.app/graphql -H \"Authorization: ***" -H 'Content-Type: application/json' -d '{\"query\":\"{ viewer{ name organization{urlKey name} } teams{nodes{key name}} issues(filter:{number:{eq:467}}){nodes{identifier title}} }\"}'"}
06:52:09.494 result {"output": "{\"data\":{\"viewer\":{\"name\":\"Ove Govender\",\"organization\":{\"urlKey\":\"swcstudio\",\"name\":\"Spectrum Web Co\"}},\"teams\":{\"nodes\":[{\"key\":\"SPE\",\"name\":\"Spectrum Web Co\"}]},\"issues\":{\"nodes\":[]}}}", "exit_code": 0, "error": null}
```

  The first tool call is the `graph_claim` curl with `"surface":"hermes"` and `"session_id":"20260925_065059_f7cea2"`.
  After the claim, the model looked for a Linear tool (`tool_search` found only `terminal`) and listed the MCP
  tools. It then called the Linear API with Hermes' own `LINEAR_API_KEY`, which returned
  `Entity not found: Issue`; `viewer.organization.urlKey` is `swcstudio` and the team is `SPE`. It made no
  worktree edit and did not call graph_complete.
- Hermes' `agent.log` for this session (turn, hook, API calls; cut at 300 characters):

```
2026-09-25 06:51:01,400 INFO [20260925_065059_f7cea2] agent.turn_context: conversation turn: session=20260925_065059_f7cea2 model=claude-opus-5-5 provider=anthropic platform=cli history=0 msg='You were dispatched by substrate-dispatcher for Linear issue SWC-467, graph ut-m...'
2026-09-25 06:51:32,279 WARNING [20260925_065059_f7cea2] hermes_cli.plugins: Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping
2026-09-25 06:51:36,545 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #1: model=claude-opus-5-5 provider=anthropic in=81666 out=247 total=81913 latency=4.2s write=81662 id=msg_011CfPiQquiNkQ5uptWvNNeV
2026-09-25 06:51:45,018 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #2: model=claude-opus-5-5 provider=anthropic in=82373 out=84 total=82457 latency=2.1s cache=81662/82373 (99%) write=709 id=msg_011CfPiRchzUcAM2cJRvojJu
2026-09-25 06:51:49,421 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #3: model=claude-opus-5-5 provider=anthropic in=82573 out=326 total=82899 latency=3.9s cache=81662/82573 (99%) write=909 id=msg_011CfPiRoZMVHFQCCuaLyyxH
2026-09-25 06:51:54,161 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #4: model=claude-opus-5-5 provider=anthropic in=83125 out=271 total=83396 latency=4.1s cache=82571/83125 (99%) write=552 id=msg_011CfPiS976Hkfo8X3DpdpjZ
2026-09-25 06:51:59,051 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #5: model=claude-opus-5-5 provider=anthropic in=84050 out=288 total=84338 latency=3.7s cache=82571/84050 (98%) write=1477 id=msg_011CfPiSXXUce7AiAgpoJTbg
2026-09-25 06:52:04,204 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #6: model=claude-opus-5-5 provider=anthropic in=84455 out=185 total=84640 latency=2.8s cache=83042/84455 (98%) write=1411 id=msg_011CfPiSygajfmtFeLZB27rX
2026-09-25 06:52:08,346 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #7: model=claude-opus-5-5 provider=anthropic in=84754 out=201 total=84955 latency=3.2s cache=83983/84754 (99%) write=769 id=msg_011CfPiTFjEYSn4HiAADwwsZ
2026-09-25 06:52:18,342 INFO [20260925_065059_f7cea2] agent.conversation_loop: API call #8: model=claude-opus-5-5 provider=anthropic in=85122 out=675 total=85797 latency=8.8s cache=84752/85122 (100%) write=368 id=msg_011CfPiTaBjcjQdGEV8SLXP1
2026-09-25 06:52:18,368 INFO [20260925_065059_f7cea2] agent.conversation_loop: Turn ended: reason=text_response(finish_reason=stop) model=claude-opus-5-5 api_calls=8/60 budget=8/60 tool_turns=7 last_msg_role=assistant response_len=1061 session=20260925_065059_f7cea2
```

- Session log `/var/lib/substrate/dispatcher/sessions/ut-mughkkc0-73909228-n1-20260925T065057Z.log`, complete. It
  ends with the model's final answer, verbatim:

    ⚠️  Normalized model 'claude-opus-5.5' to 'claude-opus-5-5' for anthropic.

    session_id: 20260925_065059_f7cea2
    I've claimed node n1, but I haven't done any of the work yet: I couldn't read issue SWC-467, so I don't know what it asks for.

    - **The claim:** it succeeded, so node n1 is now held by hermes under session `20260925_065059_f7cea2`, in state "started".
    - **Why I couldn't read the issue:** this session has no Linear tool, and the substrate MCP only offers graph, memory and event tools. As a fallback I called the Linear API directly with the `LINEAR_API_KEY` in the environment, but that key belongs to a different workspace. It can only see the "SPE" team, so looking up both "SWC-467" and the issue's ID returned "Entity not found".
    - **What I left alone:** I made no edits in the worktree and didn't call `graph_complete`, since there's nothing to report as done.
    - **The claim is still held:** other agents can't pick up n1 until it's released.

    To unblock this, either connect a Linear tool or give me a key for the workspace that has the SWC team, or paste the issue text here. If you'd rather hand the node off, I can call `graph_release` on n1 instead.

### Claim → Linear → Notion → brief

- **Claim:** graph_get first showed `claimed_by=hermes` at 06:51:38.153Z (`claimed_at` 06:51:37.753Z,
  `claim_session` 20260925_065059_f7cea2, state `started`).
- **Linear (read by linear_issue_id from graph_get):**
  - 06:51:43.153Z: state `In Progress`, labels `["agent:hermes"]`.
  - History row `06:51:40.452Z Todo → In Progress, added agent:hermes, removed dispatch:hermes`.
  - Comment `Claimed by hermes — session 20260925_065059_f7cea2 (graph ut-mughkkc0-73909228, node n1)` at 06:51:40.859Z.
  - History also shows `dispatch:hermes` added again at 06:51:42.643Z and removed at 06:51:43.215Z. Neither the
    watch (one label write, at 06:50:33) nor the claim comment explains these two rows, so their source was
    not identified. The label was absent from every later read.
- **Notion:** 06:51:43.586Z: `{"Agent": "hermes", "Status": null, "Linear State": "In Progress", "Completed": null}`.
- **Brief:**
  - Scoped, at 06:51:38.154Z: the node line `Nodes: n1 SWC-467 started by hermes just now` (`brief_evidence=node_line`).
  - Unscoped, at 06:51:43.154Z: the recent-actions line `- 06:51 hermes       claimed SWC-467 (n1)`.
- The greptime `claim` event: `ts 2026-09-25T06:51:38.722Z kind claim surface hermes session 20260925_065059_f7cea2 summary "claimed SWC-467"`.

### Completion (SC-2) — operator, through the DoD gate

The session ended by itself: `Turn ended: reason=text_response` at 06:52:18, pid gone at 06:52:41, and the
reaper logged exit code 0 after its claim. It did not call graph_complete. The session's final answer says
why: `I didn't call graph_complete, since there's nothing to report as done.`

Nothing was running, so nothing had to be terminated. As the operator, at 06:53:38.552Z, I called MCP
`graph_complete`
`{graph_id: "ut-mughkkc0-73909228", node_id: "n1", surface: "hermes", session_id: "20260925_065059_f7cea2", dod: {summary: "02-08 proof: no change needed", tests_pass: true}}`.
This was an operator call, not a model action. Response, verbatim (returned by 06:53:44.408Z):

```
{"completed": true, "reason": null, "node": {"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "completed", "claimed_by": null, "claimed_at": null, "claim_session": null}}
```

- Linear history: `06:53:39.619Z In Progress → In Review` (substrate's Mirror.review), then `06:53:41.378Z In Review → Done`
  (hermes-linear-connector's gate). Substrate sends no Done id (02-05).
- The greptime `complete` event: `ts 2026-09-25T06:53:43.683Z surface hermes summary "completed SWC-467" payload {"completed":true,"reason":null}`.
- Then, at 06:54:07Z, `graph_register {graph_id: "ut-mughkkc0-73909228", status: "Done"}` returned `status=Done`.

### Final state (read at 06:53:54Z)

`sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < /tmp/02-08-final.py`, exit 0, verbatim:

    final_read_at=2026-09-25T06:53:54Z
    graph_status=Implementing
    graph_get_n1={"graph_id": "ut-mughkkc0-73909228", "node_id": "n1", "linear_issue_id": "3378743f-efc9-47f2-9962-3894dca6bb80", "linear_identifier": "SWC-467", "notion_page": "3e6bc1a0-c7ae-8102-8a05-f31661fbc812", "state": "completed", "claimed_by": null, "claimed_at": null, "claim_session": null}
    final_linear_identifier=SWC-467
    final_linear_state_observed=Done
    final_linear_labels=["agent:hermes"]
    linear_comment={"body": "This comment thread is synced to a corresponding [GitHub issue](https://github.com/swcstudiospace/agent_runtime/issues/327). All replies are displayed in both locations.", "createdAt": "2026-09-25T04:54:13.216Z"}
    linear_comment={"body": "substrate-dispatcher: [exited-unclaimed] hermes session exited (code 1) without claiming the node \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T04:58:30.482Z"}
    linear_comment={"body": "substrate-dispatcher: [claim-timeout] no claim within 10 minutes \u2014 removed the dispatch label; not retrying", "createdAt": "2026-09-25T05:12:38.325Z"}
    linear_comment={"body": "Claimed by hermes \u2014 session 20260925_065059_f7cea2 (graph ut-mughkkc0-73909228, node n1)", "createdAt": "2026-09-25T06:51:40.859Z"}
    linear_history={"createdAt": "2026-09-25T04:57:30.713Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T04:58:30.804Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T05:02:15.107Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T05:12:38.654Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T05:13:46.692Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T05:24:27.886Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T05:38:31.968Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T05:54:20.822Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T06:50:32.988Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T06:51:40.452Z", "from": "Todo", "to": "In Progress", "added": ["agent:hermes"], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T06:51:42.643Z", "from": null, "to": null, "added": ["dispatch:hermes"], "removed": []}
    linear_history={"createdAt": "2026-09-25T06:51:43.215Z", "from": null, "to": null, "added": [], "removed": ["dispatch:hermes"]}
    linear_history={"createdAt": "2026-09-25T06:53:39.619Z", "from": "In Progress", "to": "In Review", "added": [], "removed": []}
    linear_history={"createdAt": "2026-09-25T06:53:41.378Z", "from": "In Review", "to": "Done", "added": [], "removed": []}
    notion_parent_ds=be3418f0-d2d8-411b-8677-fa8a95ee63be
    notion_last_edited_time=2026-09-25T06:53:00.000Z
    notion_final={"Item": "[n1] substrate 02 proof \u2014 throwaway", "Agent": "hermes", "Status": "Done", "Linear State": "Done", "Completed": "2026-09-25", "Graph ID": "ut-mughkkc0-73909228", "Issue ID": "SWC-467"}
    pr_fields_after={"PR URL": null, "PR #": null, "PR State": null, "Repo": "", "Branch": ""}
    pr_fields_equal_before=true
    event_rows=2
    event={"ts": "2026-09-25T06:51:38.722Z", "kind": "claim", "surface": "hermes", "session_id": "20260925_065059_f7cea2", "node_id": "n1", "summary": "claimed SWC-467", "payload": "{}"}
    event={"ts": "2026-09-25T06:53:43.683Z", "kind": "complete", "surface": "hermes", "session_id": "20260925_065059_f7cea2", "node_id": "n1", "summary": "completed SWC-467", "payload": "{\"completed\":true,\"reason\":null}"}

POST /brief at 06:53:55Z, after completion. As 02-RESEARCH finding 5 predicts, the scoped node line now reads
`done` with no surface, and the claim event remains in recent actions. Scoped, then unscoped:

    ## Substrate brief: swcstudiospace/agent-substrate — ut-mughkkc0-73909228
    Implementing · PR none yet
    Nodes: n1 SWC-467 done

    Last 5 agent actions in this repo
    - 06:53 hermes       completed SWC-467 (n1)
    - 06:51 hermes       claimed SWC-467 (n1)
    - 06:48 cursor       commit be5e34d feat(02-04): SUBSTRATE_DISPATCH_MODEL selects the dispatched Hermes model
    - 05:56 cursor       commit 34a5681 docs(02-08): proof run 4 — Anthropic per-model 429 on claude-fable-5-1, no claim; dispatch off
    - 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)

    Other open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

    -----

    ## Substrate brief: swcstudiospace/agent-substrate

    Last 5 agent actions in this repo
    - 06:53 hermes       completed SWC-467 (n1)
    - 06:51 hermes       claimed SWC-467 (n1)
    - 06:48 cursor       commit be5e34d feat(02-04): SUBSTRATE_DISPATCH_MODEL selects the dispatched Hermes model
    - 05:56 cursor       commit 34a5681 docs(02-08): proof run 4 — Anthropic per-model 429 on claude-fable-5-1, no claim; dispatch off
    - 05:30 cursor       commit a6e9604 fix(02-07): claim timeout 900 s outlasts Hermes 429 backoff (D-14 amended)

    Other open graphs here: ut-mughkkc0-73909228 (Implementing) · ut-mufsocbe-c7ced745 (grok-bot, unstarted, 1 node started)

### Worktree and D-13

- `git worktree list`: `/var/lib/substrate/worktrees/ut-mughkkc0-73909228  f8133f0 [substrate/ut-mughkkc0-73909228]`.
  Its porcelain is empty (0 lines).
- `git -C /root/src/repos/agent-substrate branch --show-current` → `main`.
- Main checkout porcelain before run 5 (06:50:20Z) and after (06:54:08Z):

     M .planning/config.json
     M .planning/state.json
    ?? issues/

    -----

     M .planning/config.json
     M .planning/state.json
    ?? issues/

  They are identical, and identical to the 04:53:08Z snapshot.
- `df -BG --output=avail /` → `30G`.

### Dispatch switch after the run (owner-directed)

Operator action at 2026-09-25T06:54:08Z: `echo 'SUBSTRATE_DISPATCH_DISABLED=1' | sudo tee -a /etc/substrate/substrate.env > /dev/null`.

- The last switch line is now line 27, `=1`.
- There was no restart (`MainPID` 1586416). Journal:
  `2026-09-25T06:54:30.770235+00:00 … [substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`.
- The plan says `0`. The owner directed "keep dispatch off except during the proof", so this is recorded as
  `dispatch_switch_final=1`.

### Timeline (UTC, final run)

| Time | Event | Source |
|---|---|---|
| 06:48:56 | dispatcher restarted by the orchestrator with `SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5`, switch at 1 | journal |
| 06:50:20 | `SUBSTRATE_DISPATCH_DISABLED=0` appended (operator) | shell |
| 06:50:26.832 | `tick: 0 candidate issue(s)` | journal |
| 06:50:33.150 | `dispatch:hermes` applied to SWC-467 (`t_label`) | watch |
| 06:50:57.147 | `tick: 1 candidate issue(s)` | journal |
| 06:50:57.618 | `launched hermes for SWC-467 … pid 1591232 …` | journal |
| 06:50:58.162 | the watch sees the launch line (`t_launch`) | watch |
| 06:51:01.400 | Hermes turn starts (model claude-opus-5-5) | agent.log |
| 06:51:32.279 | `pre_llm_call` hook timed out after 30 s | agent.log |
| 06:51:36.545 | API call #1 succeeds (`latency=4.2s`) | agent.log |
| 06:51:37.142 | model's first tool call: `graph_claim` curl | session export |
| 06:51:37.753 | index `claimed_at` | graph_get |
| 06:51:38.153 | graph_get shows `claimed_by=hermes` (`t_claim`) | watch |
| 06:51:38.154 | scoped brief `n1 SWC-467 started by hermes just now` (`t_brief`) | watch |
| 06:51:40.452 | Linear Todo → In Progress, `agent:hermes` added, `dispatch:hermes` removed | Linear history |
| 06:51:40.859 | Linear claim comment with the session id | Linear comments |
| 06:51:43.153 | watch sees In Progress + `agent:hermes` + comment (`t_linear_in_progress`) | watch |
| 06:51:43.586 | Notion Agent `hermes` (`t_notion_agent`) | watch |
| 06:52:18.368 | Hermes turn ends (text response; no graph_complete) | agent.log |
| 06:52:41 | Hermes pid exited (code 0) | /proc, journal |
| 06:53:38.552 | operator `graph_complete` with DoD (session 20260925_065059_f7cea2) | MCP |
| 06:53:39.619 | Linear In Progress → In Review | Linear history |
| 06:53:41.378 | Linear In Review → Done (connector gate) | Linear history |
| 06:53:54 | Notion Status Done, Linear State Done, Completed 2026-09-25; PR fields unchanged | final read |
| 06:54:07 | graph_register status Done | MCP |
| 06:54:08 | `SUBSTRATE_DISPATCH_DISABLED=1` appended (owner-directed); journal `dispatch disabled` 06:54:30 | shell, journal |

Latencies measured in this run:

| Segment | Duration |
|---|---|
| label → pickup tick | 24.0 s |
| label → launch line | 24.5 s |
| launch → Hermes turn start | 3.8 s |
| turn start → pre_llm_call hook timeout | 30.9 s |
| hook timeout → API call #1 done | 4.3 s |
| launch → index `claimed_at` | 40.1 s |
| label → `claimed_at` | 64.6 s |
| label → brief observed | 65.0 s → `delta_label_to_brief_s=65` |

Compared with 02-09: launch → claim was about 43 s there (index `claimed_at`) and 40.1 s here. In both runs
about 31 s of that is the `pre_llm_call` hook timeout.

### Result lines (final run; observed values)

hermes_session_id=20260925_065059_f7cea2
t_label=2026-09-25T06:50:33.150Z
t_launch=2026-09-25T06:50:58.162Z
t_claim=2026-09-25T06:51:38.153Z
t_linear_in_progress=2026-09-25T06:51:43.153Z
t_notion_agent=2026-09-25T06:51:43.586Z
t_brief=2026-09-25T06:51:38.154Z
brief_evidence=node_line
brief_line=Nodes: n1 SWC-467 started by hermes just now
delta_label_to_brief_s=65
within_60s=false
completion=operator
final_linear_state=Done
notion_status_final=Done
notion_linear_state_final=Done
notion_completed_final=2026-09-25
pr_fields_unchanged=true
dispatch_switch_final=1

## Gaps

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

## Task 3 — owner verification (checkpoint:human-verify)

The owner's resume signal, relayed by the orchestrator on 2026-09-25: **"approved"**. The owner accepts run 5 as
the Phase 2 proof.

owner_verified=approved 2026-09-25

The owner accepted these shortfalls:
- `within_60s=false`: label → brief took 65 s (Gaps 1–2).
- `completion=operator`: the dispatched model could not read the issue text, so the operator completed n1
  through the DoD gate with the claim session (Gap 3).

The owner accepted these deviations:
- Model switch to `claude-opus-5.5` (be5e34d, D-13 amended; Gap 4).
- SWC-467 and graph `ut-mughkkc0-73909228` reused across runs (D-16 amended; Gap 5).
- `dispatch_switch_final=1`, so dispatch is left off (Gap 6).
- Claim timeout raised to 900 s (a6e9604, D-14 amended).

The owner reported no difference, so no Gaps entry was added.
