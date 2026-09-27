# Phase 5 proof — docs and desktop (D-14)

Recorded from observed output only.

Scope: the desktop half of 05-06 (D-14 part 2 and part 4). The owner skipped the docs half at the
05-02 checkpoint (05-02-SPIKE.md spike_result=fail, spike_fail_reason=owner-skip; commits 8b88030,
bb1c4b3; ROADMAP Phase 5 records the skip in c6b86c8). 05-04 and 05-05 did not run, so
`docs_search`, the tracer URL and the redaction fixture do not exist. Every docs step of this plan is
listed under `## Skipped (owner skip)` below and is not recorded as passed.

Commands (root, from /var/lib/substrate/proof, 0700; each session file 0600):

```
sudo tee /var/lib/substrate/phase5-baseline/RESTORE.d/05-06.md      # route, before any live change
install -d -m 0700 /var/lib/substrate/proof
# propose-header.sh (0700): #!/bin/sh; k=$(tr -d '\r\n' < /var/lib/substrate/skills/propose.key); printf '{"x-substrate-propose-key":"%s"}\n' "$k"
# gui-mcp.json (0600): {"mcpServers":{"substrate":{"type":"http","url":"http://127.0.0.1:7410/mcp","headersHelper":"/var/lib/substrate/proof/propose-header.sh"}}}
openssl rand -hex 4                                                   # nonce per run
claude -p [--settings '{"disableAllHooks":true}'] --mcp-config /var/lib/substrate/proof/gui-mcp.json --strict-mcp-config \
  --allowedTools mcp__substrate__desktop_run --output-format stream-json --verbose --max-turns 6 "$(cat gui-prompt.txt)" > gui-session.jsonl
python3 <parse stream-json: init mcp_servers, tool_use name/input, tool_result JSON, result>   # key=value only
file -b <png>; stat -c '%a %U' <png>
systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env … bun events-count.ts <run_id> <proof_t0>   # throwaway, deleted
docker inspect --format '{{.State.StartedAt}}' recruitment-desktop   # read only
```

The prompt (gui-prompt.txt, run 2):

```
Call the desktop_run tool exactly once, with exactly this JSON input and nothing changed (keep every backslash as written):
{"timeout": 120, "actions": [{"type": "key", "keys": "ctrl+alt+t", "settle_ms": 5000}, {"type": "type", "text": "PS1='$ '; unset PROMPT_COMMAND; printf '\\033]0;substrate-smoke-6155f173\\007'"}, {"type": "key", "keys": "Return", "settle_ms": 1000}, {"type": "screenshot"}]}
Then report the run_id it returned and the active_window of the last log entry. Do not call any other tool.
```

## Desktop session (D-14 part 2, SC3)

proof_t0=2026-09-27T05:43:15Z
claude_version=2.1.278 (Claude Code)
restore_route_written=true
gui_mcp_config_mode=600
header_helper_mode=700
mcp_header_route=helper
gui_attempts=2
gui_proof_t0=2026-09-27T05:54:29Z
gui_claude_exit=0
gui_mcp_server_status=connected
gui_session_id=73e06ef7-891a-40e5-bd23-90dbc3e6777a
gui_route=agent
gui_tool_used=desktop_run
gui_tool_calls=1
gui_input_unchanged=true
gui_nonce=6155f173
gui_run_id=dr-20260927T055519Z-002e8a
gui_actions_ok=4
gui_title=Terminal - substrate-smoke-6155f173
gui_reply_has_title=true
gui_screenshot=/var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png
gui_png=1280x800
gui_png_mode=600
gui_png_sha256=fd8f5d3379b408164b326176d760a37f097e20c4d508112ef3a3292a3d12f15b
gui_image_block=true
gui_events=4
gui_event_surface=claude-code
gui_typed_text_in_events=0
tool_call_events_since_t0=0
recruitment_unchanged=true

Raw output (run 2, parsed from gui-session.jsonl; nothing else printed):

    init mcp_servers=[{'name': 'substrate', 'status': 'connected', 'source': 'dynamic'}] model=claude-opus-5[1m]
    hook events in transcript: 0
    tool_use mcp__substrate__desktop_run {"actions": [{"type": "key", "keys": "ctrl+alt+t", "settle_ms": 5000}, {"type": "type", "text": "PS1='$ '; unset PROMPT_COMMAND; printf '\\033]0;substrate-smoke-6155f173\\007'"}, {"type": "key", "keys": "Return", "settle_ms": 1000}, {"type": "screenshot"}], "timeout": 120}
    tool_result is_error=None  blocks=text,image(image/png)
    run_id=dr-20260927T055519Z-002e8a
    {'i': 0, 'type': 'key', 'ok': True, 'ms': 12295, 'active_window': 'Terminal - @1917e37f4d54:~'}
    {'i': 1, 'type': 'type', 'ok': True, 'ms': 18115, 'active_window': 'Terminal - @1917e37f4d54:~'}
    {'i': 2, 'type': 'key', 'ok': True, 'ms': 6203, 'active_window': 'Terminal - substrate-smoke-6155f173'}
    {'i': 3, 'type': 'screenshot', 'ok': True, 'ms': 12001, 'active_window': 'Terminal - substrate-smoke-6155f173'}
    RESULT: subtype=success is_error=False num_turns=2 session_id=73e06ef7-891a-40e5-bd23-90dbc3e6777a
    $ file -b /var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png
    PNG image data, 1280 x 800, 8-bit/color RGB, non-interlaced
    $ stat -c '%a %U' <png>
    600 root
    events-count.ts dr-20260927T055519Z-002e8a 2026-09-27T05:43:15Z:
    gui_events=4  gui_typed_text_in_events=0  gui_events_prompt_command=0
    gui_event_summaries=desktop key ok|desktop type ok|desktop key ok|desktop screenshot ok
    gui_event_surfaces=claude-code
    desktop_action_events_since_t0=9   (4 run 1 + 4 run 2 + 1 diagnostic screenshot, see Gaps 2)
    tool_call_events_since_t0=0
    recruitment-desktop StartedAt 2026-09-26T15:03:13.690881811Z (= 05-BASELINE recruitment-desktop-started-at)

The two events that contain "substrate-smoke-" carry it only as the post-action `active_window`
title (actions 2 and 3); none carries the typed command (`PS1=` 0, `PROMPT_COMMAND` 0).
`desktop_run` records `desktop.action` events (one per action, surface `claude-code` from the
session's client); substrate-mcp does not emit `tool.call` for it (`tool.call` for `docs_search`
was 05-05's, which did not run).

## Agent answer

```
Done — single `desktop_run` call with the input unchanged.

- **run_id:** `dr-20260927T055519Z-002e8a`
- **active_window of the last log entry** (i=3, the screenshot): `Terminal - substrate-smoke-6155f173`

One thing worth flagging: the screenshot image doesn't match the log. The visible terminals show titles `substrate-smoke-11a6…` and a command line ending `substrate-smoke-6142ed08\007` — neither is the `6155f173` token I sent, and the typed line shown lacks the `unset PROMPT_COMMAND` portion. So the returned PNG appears to be from a different run than the one whose log I got back, even though the log's `active_window` does report the expected title.
```

The agent's flag is correct about the pixels; see Gaps 2 for what was checked.

## Failed runs

    1. Session 510e357e-3ced-461d-a5b7-259044a714b7 (nonce d37135d7, t0 05:43:15Z, prompt as run 2 but
       timeout 60 and ctrl+alt+t settle_ms 2500 — the plan's input plus 05-03's `unset PROMPT_COMMAND; `),
       claude_exit=124. The owner's global UserPromptSubmit hooks ran first (init at 05:50:11Z; the
       transcript's notice: "Prompt Uplift · UPLIFTED_PROMPT · llm · claude:sonnet · Graph of Thought ·
       5 nodes · Substrate · brief 2 lines · Knowledge · none · Tracking · 5 issues · 31 sub-issues
       linked · 339.7s"). The agent then called desktop_run once with the input unchanged:
       run dr-20260927T055018Z-f58602, 4/4 ok, 4 desktop.action events (surface claude-code, 0 carry
       the typed text), PNG 1280x800 mode 600; the tool result arrived at 05:51:22Z and the outer
       `timeout 480` ended the session at 05:51:22Z before its final answer. Log titles:
       [0 key 9901 ms "Terminal - substrate-smoke-031fd710"], [1 type 25602 ms same],
       [2 key 7803 ms "Terminal"], [3 screenshot 10903 ms "Terminal - @1917e37f4d54:~"] — the new
       terminal (process started ~05:50:32Z, its bash 9 s later) had not taken focus when typing
       began, so the text went to the previously focused 05-03 terminal and the title check failed.
       Run 2 raised settle_ms to 5000 (the vocabulary's max) and timeout to 120, and passed
       `--settings '{"disableAllHooks":true}'` so the session was not held by the hooks.

## Skipped (owner skip)

Not run and not passed. Reason for each: 05-02 closed spike_result=fail (owner-skip), so 05-04 and
05-05 were not executed and `docs_search`, the tracer URL and the fixture do not exist.

- Task 1 (D-14 part 1, SC1): the docs `claude -p` session (docs-mcp.json, docs_search), and its keys
  docs_question, docs_expected_url, docs_mcp_config_mode, claude_exit, mcp_server_status,
  claude_tool_used, docs_tool_result_has_url, claude_reply_has_url, claude_session_id,
  tool_call_events, tool_call_event_has_url. No docs-mcp.json was written.
- Task 2, fixture re-check (D-14 part 3): the anonymous docs_search for the 05-05 fixture and its keys
  fixture_recheck_found, fixture_recheck_redacted_count, fixture_recheck_value_leaks. No fixture
  document or values file exists.
- Task 3: sc1_evidence (claude_reply_has_url) and sc2_evidence (05-05 fixture_raw_value_leaks);
  removal of the fixture values file (none was created); the RAGFlow-key scan of the transcripts
  (substrate.env has no RAGFLOW_API_KEY line: count 0).
- Evidence files that do not exist for the same reason: 05-04-TRACER.md, 05-05-SMOKE.md.

## Final gate and cleanup (D-14 part 4)

Commands: the three § Commands of 05-BASELINE.md with the Task 3 `<verify>` normalization, compared
two-sided against the gate-* keys (gate-pass=503, gate-fail=0, gate-tsc-set tsc-exit=0,
gate-dispatcher-pass=149, no gate-failing-id or gate-dispatcher-failing-id lines). Run at HEAD
63d5397eca0773d80084a7717df5bbba99164bec (the four commits after c6b86c8 are planning docs only);
working tree: `.planning/config.json`, `.planning/state.json` modified, `issues/` and
`packages/miner/uv.lock` untracked (none from this plan).

final_gate_head=63d5397eca0773d80084a7717df5bbba99164bec
final_gate_bun_pass=534
final_gate_bun_fail=0
final_gate_bun_files=29
final_gate_bun_failing_id_diff=0
final_gate_tsc_diff=0
final_gate_dispatcher_pass=149
final_gate_dispatcher_failing_id_diff=0
proof_configs_removed=true
header_helper_removed=true
transcripts_key_free=true
claude_project_store_key_free=true
restore_index_unchanged=true
sc3_evidence=gui_events
sc1_evidence=skipped-owner
sc2_evidence=skipped-owner
proof_scope=desktop-half
proof_result=partial

Raw output:

    bun test:  534 pass / 0 fail / 6987 expect() calls / Ran 534 tests across 29 files. [49.80s]  (gate 503; > gate-pass)
    tsc (normalized): tsc-exit=0   diff against gate-tsc-set: 0 lines
    pytest (packages/dispatcher): 149 passed in 24.90s   (gate 149; ≥ gate-dispatcher-pass)
    failing ids: bun 0 / dispatcher 0 on both sides; diffs empty
    $ rm -f gui-mcp.json propose-header.sh events-count.ts; test -e docs-mcp.json gui-mcp-file.json → absent (never written)
    $ ls /var/lib/substrate/proof | grep -c '\.values$'  → 0
    $ grep -rlF -f /var/lib/substrate/skills/propose.key /var/lib/substrate/proof/ | wc -l  → 0
    $ grep -rlF -f /var/lib/substrate/skills/propose.key /root/.claude/projects/ | wc -l  → 0
    $ grep -c '^RAGFLOW_API_KEY=' /etc/substrate/substrate.env  → 0 (no RAGFlow key exists to scan for)
    RESTORE.md sha256 bf326959c649833b… (unchanged); RESTORE.d/05-06.md 600 root
    kept for audit (0600, dir 0700): gui-session.jsonl, gui-session-run1.jsonl (+ empty .stderr), gui-prompt.txt,
      gui-prompt-run1.txt, run.env, run1.env, diag-call.json, diag-reply.sse

proof_result is `partial`, not `pass`: the desktop half (SC3, the GUI-smoke clause of the Proof) and
the final gate hold; the docs half is skipped by the owner and is not claimed.

## Gaps

1. ROADMAP SC1 and SC3 wording is updated by the orchestrator per D-03 and D-16; plans did not edit
   ROADMAP.md. After the owner skip, ROADMAP Phase 5 lands on the desktop half only (c6b86c8).
2. The returned screenshot does not show the new terminal's pixels. After run 2 the X server lists
   window 46138072 "Terminal - substrate-smoke-6155f173" active, topmost in _NET_CLIENT_LIST_STACKING,
   at 462,75 818x485; the PNG shows that rectangle with an older window's contents and frame title
   (05-03 failed run 3's `…substrate-smoke-6142ed08…` line). A diagnostic keyed screenshot one
   minute later (JSON-RPC `desktop_run [{type:screenshot}]`, run dr-20260927T055741Z-a93dcf, 1 event,
   request/reply kept 0600 as diag-call.json/diag-reply.sse) showed the same pixels while its log
   title was again "Terminal - substrate-smoke-6155f173"; the panel clock did repaint. So the title
   (read by xdotool from the X server) is the evidence that the typed command ran in the new
   terminal; the xwd image of this display currently lags window content [INFERENCE: xfwm4/terminal
   repaint starvation under the host's 67-76% CPU steal; not investigated further]. 05-03's smoke also
   passed on the title, not on pixels. The agent reported the mismatch itself (§ Agent answer).
3. The input differs from the plan's: `unset PROMPT_COMMAND; ` in the typed text (05-03 Gaps 1),
   and in run 2 settle_ms 5000 on ctrl+alt+t (plan 2500) and timeout 120 (plan 60), after run 1 typed
   into the previously focused terminal (§ Failed runs).
4. Run 2 passed `--settings '{"disableAllHooks":true}'` (session-scoped, no settings file edited).
   Run 1 showed the owner's global SessionStart/UserPromptSubmit hooks holding the session ~6.8 min
   and reporting "Tracking · 5 issues · 31 sub-issues linked" for the proof prompt; that tracking
   side effect belongs to the owner's hook, was not inspected, and is outside this plan.
5. `tool.call` evidence exists only for docs_search (skipped); `desktop_run`'s record is its
   `desktop.action` events.
6. The desktop keeps two more terminal windows (runs 1 and 2) inside substrate-desktop (7 in total);
   the RESTORE.d/05-06.md route names how to close them. Nothing outside the container changed.

## Evidence index

- 05-01-INVENTORY.md — inventory (tracer_url unused: docs half skipped)
- 05-02-SPIKE.md — spike_result=fail, spike_fail_reason=owner-skip
- 05-03-SMOKE.md — substrate-desktop container, desktop_run, first GUI smoke
- 05-04-TRACER.md — not produced (05-04 skipped by the owner)
- 05-05-SMOKE.md — not produced (05-05 skipped by the owner)
- 05-BASELINE.md — gate-* keys
- /var/lib/substrate/proof/ (0700 root) — session transcripts and diagnostic reply, 0600
- /var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png (run 2), dr-20260927T055018Z-f58602/1.png (run 1), dr-20260927T055741Z-a93dcf/1.png (diagnostic)
