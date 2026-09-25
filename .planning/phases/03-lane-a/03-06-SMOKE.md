# 03-06 durability and containment evidence

Recorded from observed output only. Column-0 `key=value` lines are the plan's closed set; raw
status dumps and failed paths are indented four spaces so every key keeps exactly one column-0 line.

## Task 1 — restart survival (D-07)

Route of the unit: `a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn` (03-01-SPIKE.md
`route_choice`), so no in-VM model relay exists and `model_route_after_restart` is `not_needed`.

```
sudo systemctl restart substrate-host && curl -s 127.0.0.1:7411/healthz       # redeploy at 15:12:06Z → {"engine":true,"api":true}
python3 /tmp/03-06-open.py open TRC-6            # throwaway (deleted): graph_register over MCP (no Linear/Notion refs, node n1
                                                 # unstarted), dispatcher ensure_worktree(repo_checkout(...), <gid>, 'main'), POST /tasks
python3 /tmp/03-06-open.py wait-approval <gid>   # GET /tasks/<gid>/n1 every 5 s until pending_approvals ≥ 1 and turn_in_flight
sudo systemctl restart substrate-host; until curl -sf 127.0.0.1:7411/healthz; do sleep 1; done
journalctl -u substrate-host --since "$(systemctl show -p ActiveEnterTimestamp --value substrate-host)" -o cat | grep resumed
python3 /tmp/03-06-open.py wait-event <gid> <request_id before the restart>   # ≤ 300 s for a new approval or a turn end
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-06.mjs brief <gid>   # throwaway rivet client on 127.0.0.1:6420: readFile the brief, sha256
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill; python3 /tmp/03-06-open.py graph <gid>   # graph_get → claimed_by
```

Journal of the boot that carried the new code (before the task was opened), showing the resume
pass runs with nothing to do: `[substrate-host] interrupted turns resumed: 0`.

Open: POST /tasks 202 at `t_open=2026-09-25T15:12:26Z`, nine seed files, `graph_registered=yes`.
The first model event arrived at 15:12:47Z (`permission_request`, tool Read); status read before
the restart at `t_status=2026-09-25T15:12:51Z`:

    session_id=n1
    state=waiting
    latest_sequence=2
    history_events=2
    turn_in_flight=true
    prompt_count=1
    resumes=0
    stale_approvals=0
    exit_code=None
    pending_approvals=[{"request_id": "a5bc431d-f37c-47cf-9d43-250e7ae2cbbc", "tool": "Read", "at": "2026-09-25T15:12:47.382Z"}]
    brief_sha=08d5926752b3c196dcaddbd92c78b6a4c800e262fc53da3053a922a95d33b844

restart_graph_id=ut-muh3nlig-97d72a43
t_restart=2026-09-25T15:12:57Z
t_healthz_after=2026-09-25T15:13:15Z
session_before=n1
session_after=n1
seq_before=2
seq_after=4
history_events_before=2
history_events_after=4
brief_sha_before=08d5926752b3c196dcaddbd92c78b6a4c800e262fc53da3053a922a95d33b844
brief_sha_after=08d5926752b3c196dcaddbd92c78b6a4c800e262fc53da3053a922a95d33b844
vm_brief_sha256_live=08d5926752b3c196dcaddbd92c78b6a4c800e262fc53da3053a922a95d33b844
resumed_line=2026-09-25T15:13:14+00:00 vps substrate-host[2707853]: [substrate-host] resumed ut-muh3nlig-97d72a43/n1 key ut-muh3nlig-97d72a43:n1:resume:1
post_restart_event=approval_pending
t_post_restart_event=2026-09-25T15:13:24Z
stale_approvals=1
model_route_after_restart=not_needed
restart_survived=true

What the restart looked like on the journal (verbatim host lines; rivet's own lines summarised):

    15:12:58 systemd: Stopping substrate-host.service
    15:12:58 [substrate-host] SIGTERM: stopping
    15:12:58 rivet: level=error msg="agent-os prompt action failed" sessionId=n1 error=SidecarProcessExited …
             level=error message="websocket not available for sending"          ← the rejection never reached the host process
    15:13:13 rivet: level=warn message="stopping all actors due to envoy lost threshold"
    15:13:13 systemd: State 'stop-sigterm' timed out. Killing. … Main process exited, code=killed, status=9/KILL … Failed with result 'timeout'
    15:13:13 systemd: Started substrate-host.service
    15:13:14 [substrate-host] removed orphan sandbox 5efaf37c2690 /interesting_wescoff
    15:13:14 [substrate-host] orphan sandboxes removed: 1
    15:13:14 [substrate-host] engine 127.0.0.1:6420
    15:13:14 [substrate-host] resumed ut-muh3nlig-97d72a43/n1 key ut-muh3nlig-97d72a43:n1:resume:1
    15:13:14 [substrate-host] interrupted turns resumed: 1
    15:13:14 [substrate-host] api 127.0.0.1:7411
    15:13:15 [substrate-host] vm resolved ut-muh3nlig-97d72a43 worktree /var/lib/substrate/worktrees/ut-muh3nlig-97d72a43 sandbox published_loopback
    15:13:16 rivet: "ext request received" kind=prompt; agentos-v8-runtime: restored session isolate from_snapshot=true
    15:13:21 [substrate-host] approval pending ut-muh3nlig-97d72a43/n1 request a5186b9c-a64a-45da-b655-252109027ee6 (telegram approvals off)

Status after the restart, read at `t_status=2026-09-25T15:13:24Z` (9 s after the API came up):

    session_id=n1
    state=waiting
    latest_sequence=4
    history_events=4
    turn_in_flight=true
    prompt_count=2
    resumes=1
    stale_approvals=1
    exit_code=None
    pending_approvals=[{"request_id": "a5186b9c-a64a-45da-b655-252109027ee6", "tool": "Read", "at": "2026-09-25T15:13:21.729Z"}]
    brief_sha=08d5926752b3c196dcaddbd92c78b6a4c800e262fc53da3053a922a95d33b844

The pre-restart request `a5bc431d…` is gone from `pending_approvals` (counted in `stale_approvals`);
the new request `a5186b9c…` is a different id, raised by the continuation turn. The brief was read
back from the VM itself after the restart (`vm_brief_sha256_live`, 842 bytes; `/home/agentos/work`
listed 12 entries) and hashes to the same value the record stored at open.

Kill at `t_kill=2026-09-25T15:16:04Z`: `{"kill":"accepted"}`; then `state=unloaded`,
`released=true`, `exit_code=1`, `last_stop_reason=killed`; `graph_get` → `claimed_by=None`,
`claim_session=None`. The continuation prompt settled during the kill's cancel/unload with
`prompt failed …: AgentOS prompt failed: session_storage_error: actor SQLite UDS failed: actor
SQLite UDS transaction lease is invalid: leaseKey is unknown on this connection` (the kill path
had already cancelled and unloaded the session; the record was then marked released). 45 s later:
`vm disposed ut-muh3nlig-97d72a43 reason=sleep sandboxes=1`, 0 labelled containers.

restart_kill_released=true

## Gaps

- What the model did inside the interrupted turn is not observable from the host: the pre-restart
  turn was waiting on its first `Read` approval (never answered), and the continuation turn raised a
  new `Read` approval 5 s after the prompt; whether the model re-read the brief or continued from
  restored history is not in `readHistory`'s event count (2 → 4: the resume prompt and the new request).
- The clean stop did not complete: `registry.shutdown()` under an in-flight turn hung until systemd's
  `TimeoutStopSec=15` SIGKILLed the unit (`Failed with result 'timeout'`), and the sandbox container
  outlived the process until the boot sweep removed it by label (`orphan sandboxes removed: 1`, D-04
  filter). The restart therefore took 16 s instead of ~2 s. Not changed here (the unit is 03-03's).
- The old process never saw its prompt rejection (`websocket not available for sending`), which is
  why the record was still in flight at boot. Had the rejection arrived first, `startPrompt`'s catch
  would have marked the task failed and no continuation would follow; this plan adds
  `TaskService.beginShutdown()` (called from the SIGTERM handler) so rejections during shutdown leave
  the record in flight. That code path ran on this restart only in the sense that the handler set
  the flag before the hang; it was not exercised by a delivered rejection.
- The continuation prompt's own settlement was observed only through the kill (`session_storage_error`
  lease failure while the session was being unloaded), not as an `end_turn`, because no approver
  answered the new `Read` request (03-08).
