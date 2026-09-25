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

## Task 2 — containment audit (D-08, D-01, D-12, D-04)

`sandbox_net=published_loopback` and `route_choice=a:loopback,…` (03-01-SPIKE.md), so the audit ran
with `--sandbox-net published_loopback` and no `--sanctioned` name.

```
python3 /tmp/03-06-open.py open TRC-7; python3 /tmp/03-06-open.py wait-approval <gid>   # second throwaway task, as Task 1
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-06.mjs audit <gid>   # in the task's VM: agentos-sandbox run-command git --version
                                                            # (starts the container), node -e fetch https://example.com,
                                                            # agentos-sandbox run-command curl -sS -m 10 -o /dev/null https://example.com
docker ps --filter label=substrate.graph_id --format '{{.ID}} {{.Names}} {{.Labels}} {{.Ports}}'
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env \
  -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host -E HOME=/root \
  /usr/bin/node src/audit.ts --sandbox-net published_loopback > /tmp/03-06-audit.out          # while the container ran
docker inspect <id> --format '…PortBindings/Privileged/AutoRemove/Binds/Labels/NetworkMode/Image…'   # token redacted below
docker image inspect asterinas/dev:0.18.1-20260901 --format '{{.Id}}'; docker ps -a --filter name=^bold_rosalind$
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill; python3 /tmp/03-06-open.py graph <gid>
git -C /root/src/repos/agent-substrate worktree remove --force /var/lib/substrate/worktrees/<gid>; git branch -D substrate/<gid>   # both gids
```

audit_graph_id=ut-muh424n5-667ff591
audit_open_status=202
t_audit_first_approval=2026-09-25T15:24:06Z

In-VM probe (throwaway rivet client, `t_probe=2026-09-25T15:24:13Z`), verbatim:

sandbox_git_exit=0
sandbox_git_out={"ok":true,"result":{"stdout":"git version 2.39.5\n","stderr":"","exitCode":0,"timedOut":false,"durationMs":5}}
vm_fetch_exit=7
vm_fetch_out=E EACCES: EACCES: permission denied, tcp://example.com:443: blocked by network.http policy
vm_example_com=denied
container_curl_hostfn_exit=0
container_curl_timed_out=false
container_curl_exit=0
container_example_com=reachable

`docker ps` at `t_audit=2026-09-25T15:24:15Z`, while the audit CLI ran:
`5aa36b601b8d awesome_sutherland substrate.graph_id=ut-muh424n5-667ff591 127.0.0.1:32785->3000/tcp`

sandbox_container_seen=true

Audit CLI output (`/tmp/03-06-audit.out`, exit 0, stderr empty), verbatim — names and counts only:

storage_mode=700
secret_keys=GREPTIME_PASSWORD,LINEAR_API_KEY,NOTION_API_KEY
secret_hits_GREPTIME_PASSWORD=0
secret_hits_LINEAR_API_KEY=0
secret_hits_NOTION_API_KEY=0
secret_hits_total=0
sanctioned_keys=none
config_keys=GREPTIME_URL,INVOCATION_ID,MEMORY_PRESSURE_WRITE,NOTION_TASK_GRAPH_DS,SUBSTRATE_DISPATCH_MODEL,SUBSTRATE_PG_URL
config_hits_GREPTIME_URL=0
config_hits_INVOCATION_ID=0
config_hits_MEMORY_PRESSURE_WRITE=0
config_hits_NOTION_TASK_GRAPH_DS=1548
config_hits_SUBSTRATE_DISPATCH_MODEL=0
config_hits_SUBSTRATE_PG_URL=0
config_hits_total=1548
containers_inspected=1
container_violations=0

The scanned set is every variable of the transient unit's environment with a value of at least 12
characters not starting with `/` (substrate.env through EnvironmentFile plus systemd's own
`INVOCATION_ID`, `MEMORY_PRESSURE_WRITE`); `SUBSTRATE_APPROVAL_*` and `SUBSTRATE_TOKEN_*` are not
in substrate.env yet (D-13 owner checkpoint pending), so they do not appear. `NOTION_TASK_GRAPH_DS`
is the Notion data-source id 03-03 seeds into every VM's `/home/agentos/.config/ultrathink/config.json`
(`notion.dataSourceUrl`); its 1548 matches across every VM's files and history are the seeded
locator, reported by name and never counted in `secret_hits_total`.

Container `5aa36b601b8d` as inspected (token redacted):
`{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]} privileged=false autoremove=true binds=["/var/lib/substrate/worktrees/ut-muh424n5-667ff591:/work","/root/src/repos/agent-substrate/node_modules:/work/node_modules:ro"] label=ut-muh424n5-667ff591 network=bridge image=substrate-sandbox:0.1`
`Cmd=["server","--token","<redacted>","--host","0.0.0.0","--port","3000","--no-telemetry"]`

D-04 after the audit: `asterinas/dev:0.18.1-20260901` →
`sha256:5211b0c1afdf8c51dd42528009da562d2308959b1979f5764ea431db4a64d0f6`; `bold_rosalind` listed,
`Exited (0) 8 days ago`. The boot sweeps of this plan removed only `substrate.graph_id` containers
(one, `interesting_wescoff`, after the Task 1 SIGKILL).

d04_intact=yes

Kill at `t_kill2=2026-09-25T15:24:41Z`: `{"kill":"accepted"}` → `state=unloaded`, `released=true`,
`exit_code=1`; `graph_get` → `claimed_by=None`, `claim_session=None`.

audit_kill_released=true
throwaway_worktrees_removed=2

`git worktree list` after the removal: main (`625f3e8 [main]`) plus Phase 2's
`ut-mugbqivi-752f2dad` and `ut-mughkkc0-73909228`; no `substrate/ut-muh3nlig-*` or
`substrate/ut-muh424n5-*` branch remains; the main checkout stayed on `main`.

## Retained

Graphs `ut-muh3nlig-97d72a43` and `ut-muh424n5-667ff591` stay in the substrate index (no Linear or
Notion reference, no claim: `claimed_by` null on both) and their VM actors stay in
`/var/lib/substrate/agentos` (rivet keeps VM files and session history; kill unloads, never deletes).
The task records under `/var/lib/substrate/agentos/tasks/` are kept (`released=true`). Nothing else
was created: no image, no network, no substrate.env change (the switch's last line is still `=1`).

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
- RocksDB block compression can hide a byte match, so secret_hits_total=0 is a floor; the D-08
  control is sessionEnv's exact-key test (03-04).
- Keys are classified by name segment (secretKey); a credential stored under a name without a
  secret segment would be counted under config_hits, not secret_hits_total — config_keys lists every
  such name for review. On this host that list holds two URLs that could embed a credential,
  `SUBSTRATE_PG_URL` and `GREPTIME_URL` (both 0 hits), and `SUBSTRATE_DISPATCH_MODEL` (0 hits).
- D-12 deviation: sandbox container egress is open on sandbox_net=published_loopback (Docker's
  default bridge; D-12 covers the VM only): `curl -sS -m 10 -o /dev/null https://example.com` inside
  container `5aa36b601b8d` exited 0 (`container_example_com=reachable`) while the same fetch from the
  VM was denied (`blocked by network.http policy`). Every command reaches the container only as a VM
  tool call (`agentos-sandbox run-command`) that waits on an owner tap under D-13, and the container
  holds no credential (no env, no docker socket, the worktree and a read-only node_modules bind, a
  per-container token on a 127.0.0.1-published port). Same finding as 03-01 (`sandbox_egress=open`);
  `sandbox_net=internal` is unusable with the 0.2.21 sidecar (non-https, non-localhost baseUrl).
