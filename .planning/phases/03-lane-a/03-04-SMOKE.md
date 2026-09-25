# 03-04 VM policy and tracker route evidence

Recorded from observed output only.

Route values below are copied from 03-01-SPIKE.md (`route_choice`, `tracker_route`, `tests_route`);
everything else is the stdout of the throwaway scripts named in each section, run against the
`substrate-host` unit after `sudo systemctl restart substrate-host` (healthz `{"engine":true,"api":true}`).

route=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn
tracker_route=host
tests_route=sandbox

## Task 1 — seed read-back and VM-side issue_get

```
sudo systemctl restart substrate-host && curl -s 127.0.0.1:7411/healthz     # {"engine":true,"api":true}
python3 /tmp/03-04-open.py          # throwaway: graph_register over MCP (no Linear/Notion refs, node n1 unstarted),
                                    # dispatcher ensure_worktree(repo_checkout(...), <gid>, 'main'), POST /tasks
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-04.mjs <gid>   # throwaway rivet client on 127.0.0.1:6420: readFile the seed,
                                                       # execFile agentos-substrate issue-get --node n1, node -e fetch :7412
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/terminate; curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill
```

Open (POST /tasks 202 at 14:37:11Z, claim session n1); the host reported nine seeded files, each
written with `filesystem.writeFile`, read back and hashed:

```
/home/agentos/SUBSTRATE_BRIEF.md
/home/agentos/.claude/skills/ultrathink-kickoff/SKILL.md
/home/agentos/.claude/skills/ultrathink-plan/SKILL.md
/home/agentos/.claude/skills/ultrathink-ship/SKILL.md
/home/agentos/.claude/skills/ultrathink-sync/SKILL.md
/home/agentos/.claude.json
/home/agentos/.config/ultrathink/config.json
/home/agentos/.substrate/ultrathink-state.json
/home/agentos/.substrate/ultrathink-state.xml
```

smoke_graph_id=ut-muh2ea68-eb8dcf1c
open_status=202
seeded_mcp_servers=linear,notion,substrate
seeded_tracker_urls=loopback
seeded_mcp_headers=none
seeded_substrate_url=http://127.0.0.1:7410/mcp
seeded_state_file=yes
seeded_state_tracking=complete
vm_issue_get=found_false_no_ref
vm_issue_get_channel=hostfn

The probe's `.claude.json` read-back (keys sorted, values as seeded): `linear` →
`http://127.0.0.1:7412/mcp/linear`, `notion` → `http://127.0.0.1:7412/mcp/notion`, `substrate` →
`http://127.0.0.1:7410/mcp`, all `type: http`, no `headers`, no `env`. The state file's
`plan.graphId` equalled the gid and `tracking.status` was `complete`.
`agentos-substrate issue-get --node n1` from inside the VM answered
`{"found":false,"reason":"node has no Linear issue reference"}` (the s:hostfn channel end to end).
The session had reached its first model event before terminate (`state=waiting`, one pending
approval); terminate → exit_code 1, kill → `state=unloaded`, `released=true`, `claimed_by` null.

task1_first_event=approval_pending
task1_exit_after_terminate=1
task1_released_after_kill=true

## Task 2 — tracker MCP proxy (tracker_route host: inert)

```
sudo systemctl restart substrate-host && curl -s 127.0.0.1:7411/healthz     # {"engine":true,"api":true} at 14:44:32Z
journalctl -u substrate-host --since "$(systemctl show -p ActiveEnterTimestamp --value substrate-host)" | grep 'tracker mcp'
ss -ltnH '( sport = :7412 )'                                                # empty
python3 /tmp/03-04-open.py                                                  # second throwaway task (as Task 1)
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-04.mjs <gid>   # in-VM node -e POST http://127.0.0.1:7412/mcp/notion (initialize)
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .proxy-03-04.mjs        # host-side: createTrackerProxy on an ephemeral port with the real
                                                       # ultrathink-mcp children; prints tool counts and refusal codes only
```

Journal line after the restart (the unit's route is `tracker_route=host`, so main.ts starts nothing):
`[substrate-host] tracker mcp proxy off (tracker route host)`; `ss -ltnH '( sport = :7412 )'`
printed nothing. From the second task's VM, `node -e fetch("http://127.0.0.1:7412/mcp/notion", …)`
answered `E EACCES: permission denied, tcp://127.0.0.1:7412: blocked by network.http policy` —
the port is neither exempted (loopbackExemptPorts) nor allowed (networkPermissions) nor served.

proxy_line=off
host_proxy_notion_tools=skipped
host_proxy_linear_tools=skipped
proxy_state_refused=skipped
proxy_status_refused=skipped
vm_tracker_mcp=inert
vm_proxy_fetch=denied
task2_graph_id=ut-muh2o0rz-5fdd249a
task2_seeded_mcp_servers=linear,notion,substrate
task2_vm_issue_get=found_false_no_ref

The proxy code itself was exercised on this host outside the unit (not the plan's vm_mcp live
check — that route was not selected — but the same module with the real children, run under
systemd-run with HOME=/root on an ephemeral 127.0.0.1 port; the unit never served :7412):
`ultrathink-mcp serve notion` answered initialize (200, result) and listed 45 tools;
`ultrathink-mcp serve linear` answered initialize (200, result) and listed 59 tools;
`notifications/initialized` → 202; a 1 000 001-byte body → 413; the Linear `save_issue` call with
`{"id":"SWC-0","state":"Done"}` and the Notion `notion-update-page` call with `Status: Done` were
both answered with JSON-RPC error -32001 and the journal-shaped log lines
`tracker mcp refused linear state change save_issue` / `tracker mcp refused notion status change
notion-update-page`; `server.close()` killed both children (`tracker mcp <tracker> child exited`).
No reply body or credential was printed (tool counts and status codes only).

    host_side_proxy_notion_tools=45
    host_side_proxy_linear_tools=59
    host_side_proxy_oversize_status=413
    host_side_proxy_state_refused=true
    host_side_proxy_status_refused=true

## Cleanup

```
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/terminate; curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill   # both tasks
git -C /root/src/repos/agent-substrate worktree remove --force /var/lib/substrate/worktrees/<gid>          # both gids
git -C /root/src/repos/agent-substrate branch -D substrate/<gid>                                            # both gids
```

Both tasks: terminate → exit_code 1, kill → `state=unloaded`, `released=true`; graph_get showed
`claimed_by` null for `ut-muh2ea68-eb8dcf1c` and `ut-muh2o0rz-5fdd249a`. `git worktree list`
afterwards: main plus Phase 2's two graphs only; the main checkout stayed on `main`.

throwaway_worktrees_removed=2

## Retained

The two throwaway graphs (`ut-muh2ea68-eb8dcf1c`, `ut-muh2o0rz-5fdd249a`) stay in the substrate
index (no Linear or Notion reference, no claim) and their VM actors stay in
/var/lib/substrate/agentos. The second graph's sandbox container was disposed when its VM slept
(journal 14:45:53Z `vm disposed ut-muh2o0rz-5fdd249a reason=sleep sandboxes=1`); 0 labelled
containers remained.

## Gaps

- tracker_route is `host` (03-01: b_hooks=none, s:hostfn), so the notion/linear entries in
  `/home/agentos/.claude.json` are seeded but inert by design: the VM cannot reach 127.0.0.1:7412
  (shown denied above) and nothing serves it. Kickoff's Implementing write and sync's PR-field
  writes are therefore performed by the host — the D-10 deviation that 03-10 records together with
  the evidence that selected it. The vm_mcp keys (`host_proxy_*_tools`, `proxy_*_refused`,
  `vm_tracker_mcp=live`) are `skipped` here; the proxy's behaviour on the real children was
  observed only host-side (indented block above), never through a VM.
- Whether Claude Code honours the seeded entries at session start (it rewrites `.claude.json` on
  first start, 03-03) was not observed: the sessions were terminated at their first permission
  request.
- The b:hooks settings.json shim and the oneshot `run-tests` host function are pinned by tests
  only; the spike's route has neither (`b:prompt_hostfn`, `tests_route=sandbox`), so neither was
  exercised live.
