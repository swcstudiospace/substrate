# 03-03 host tracer evidence

Recorded from observed output only.

## Unit (D-05)

```
sudo cp infra/vps/substrate-host.service /etc/systemd/system/substrate-host.service
sudo systemctl daemon-reload && sudo systemctl enable --now substrate-host
systemctl is-active substrate-host; systemctl is-enabled substrate-host
stat -c %a /var/lib/substrate/agentos /var/lib/substrate/agentos/tasks
ss -ltnpH '( sport = :7411 or sport = :6420 or sport = :6421 or sport = :6430 )'
curl -s 127.0.0.1:7411/healthz
```

Observed at 14:11:28Z (first start): `active`, `enabled`, both directories `700`,
`{"engine":true,"api":true}`. Every listener of the unit: `127.0.0.1:6420`, `127.0.0.1:6421`,
`127.0.0.1:6430` (rivet-engine) and `127.0.0.1:7411` (node MainThread); nothing bound elsewhere.
Journal since the final start (14:17:26Z, after the two fixes in Failed runs): `[substrate-host]
orphan sandboxes removed: 0`, `engine 127.0.0.1:6420`, `api 127.0.0.1:7411`,
`route a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn`, `tests route sandbox; model grok-4.6;
sandbox published_loopback; skills ultrathink-kickoff,ultrathink-plan,ultrathink-ship,ultrathink-sync`,
`telegram approvals off`.

api_bind=127.0.0.1:7411
engine_bind=127.0.0.1:6420

## Tracer (run 3, the committed code)

```
python3 /tmp/03-03-tracer.py     # throwaway: graph_register over MCP, dispatcher ensure_worktree,
                                 # POST /tasks, GET every 5 s (≤ 300 s), POST terminate, POST kill
```

Graph registered with `{graph_id, repo: "swcstudiospace/agent-substrate", branch: "main",
status: "Implementing", nodes: [{node_id: "n1", state: "unstarted"}]}` — no Linear or Notion
reference; identifier `TRC-1` is synthetic. Worktree from
`ensure_worktree(repo_checkout('swcstudiospace/agent-substrate'), '<gid>', 'main')`.

graph_id=ut-muh1p05f-695a18ee
route=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn
t_open=2026-09-25T14:17:32Z
open_status=202
t_claim=2026-09-25T14:17:43Z
claimed_by=claude-code
claim_session=n1

Seeded files as reported by POST /tasks (each written with `filesystem.writeFile`, then read back
with `filesystem.readFile` and hashed by the host; a read-back mismatch would have failed the open):

```
/home/agentos/SUBSTRATE_BRIEF.md                          sha256=dc28ba06f957b0c65a4a256b2d9fb738b6194db1bcff41897d03cc7032a022d8 bytes=759
/home/agentos/.claude/skills/ultrathink-kickoff/SKILL.md   sha256=d67737262636823caa401579fe087afbf8003b87c006635a136027f752a952f7 bytes=11032
/home/agentos/.claude/skills/ultrathink-plan/SKILL.md      sha256=6f231ecfc7652b1cd2d62d3d866e9af2ec09ba7c6dfaf582a73c1b8e8ba05a0c bytes=1389
/home/agentos/.claude/skills/ultrathink-ship/SKILL.md      sha256=558107f5bde1ca3c3e5064eb7f95ff9d7b6f3932c32d19461f2e8ade840b7b92 bytes=6617
/home/agentos/.claude/skills/ultrathink-sync/SKILL.md      sha256=4e80c4e52befdced1842abdd532f27c307057f3e8d6b17f770da794061c20a0d bytes=6427
/home/agentos/.claude.json                                 sha256=1231d75e1cc5a227738444d5e08d28576f86f326754ce3b67803c580a4124225 bytes=114
/home/agentos/.config/ultrathink/config.json               sha256=0db0058e92929380ab61a5786362391f846f3cfdb2e47fc4fdd494b90cf729aa bytes=144
```

seeded_brief=yes
seeded_claude_json=yes
seeded_skills=ultrathink-kickoff,ultrathink-plan,ultrathink-ship,ultrathink-sync
seeded_ultrathink_config=yes

First model event (permissionPolicy ask, no approver configured — the request stayed pending until
terminate; nothing answered it):

```
t_first_event=2026-09-25T14:17:48Z   state=waiting latest_sequence=2 history_events=2
pending_approvals=[{"request_id":"dad47a0c-bc30-4f14-9f24-ada7f018e9ed","tool":"Read","at":"2026-09-25T14:17:47.813Z"}]
journal: [substrate-host] approval pending ut-muh1p05f-695a18ee/n1 request dad47a0c-bc30-4f14-9f24-ada7f018e9ed (telegram approvals off)
```

first_event=approval_pending
exit_while_waiting=null
terminate_status=202
t_terminated=2026-09-25T14:17:51Z
exit_after_terminate=1
stop_reason_after_terminate=cancelled
kill_status=202
released_after_kill=true
state_after_kill=unloaded
claimed_by_after_kill=null
t_done=2026-09-25T14:17:56Z

Journal for the run: `vm resolved … sandbox published_loopback` 14:17:36Z, `task opened … (TRC-1)`
14:17:42Z, `approval pending …` 14:17:47Z, `turn ended … stop=cancelled` 14:17:48Z, `task killed …`
14:17:54Z. One container, `127.0.0.1:32778->3000/tcp`, label `substrate.graph_id=<gid>`.

## In-VM probe (throwaway client on 127.0.0.1:6420, same VM, after kill)

```
node .probe-03-03.ts ut-muh1p05f-695a18ee    # process.execFile with output.capture=all; deleted after
```

```
probe_bin: /bin lists agentos, agentos-sandbox, agentos-substrate, claude, claude-sdk-acp, …
probe_hostfn_issue_get      = exit 0 {"ok":true,"result":{"found":false,"reason":"node has no Linear issue reference"}}
probe_hostfn_issue_get_n9   = exit 0 {"ok":true,"result":{"error":"no task for node n9 in this VM"}}    (hostCallTarget refusal)
probe_sandbox_bun           = exit 0 {"ok":true,"result":{"stdout":"1.4.0\n","stderr":"","exitCode":0,"timedOut":false,"durationMs":2}}
probe_egress_example        = E Error: EACCES: permission denied, tcp://example.com:443: blocked by network policy
probe_loopback_mcp          = S 200            (http://127.0.0.1:7410/healthz from the VM)
probe_brief_first_line      = "## Substrate brief: swcstudiospace/agent-substrate — ut-muh1p05f-695a18ee"
probe_skills                = ["ultrathink-kickoff","ultrathink-plan","ultrathink-ship","ultrathink-sync"]
probe_claude_json           = {"mcpServers":{"substrate":{"type":"http","url":"http://127.0.0.1:7410/mcp"}},"firstStartTime":…,"userID":…}
probe_ultrathink_config_keys= ["notion","linear"]
```

hostfn_issue_get=found_false
hostfn_bad_node=refused
sandbox_bun=1.4.0
vm_egress_example_com=denied
vm_loopback_7410=200

## Failed runs

    Run 1 — graph ut-muh1i8pv-161a7fea, host as first started 14:11:28Z. The tracer keys themselves
    read as expected (open 202 at 14:12:17Z, claimed_by=claude-code claim_session=n1 at 14:12:29Z,
    seven seeded files, first_event=approval_pending at 14:12:57Z with tool Read, exit_after_terminate=1,
    released_after_kill=true, claimed_by_after_kill=null), but the journal showed
    `sandbox-agent at http://127.0.0.1:32774 is not healthy after 30531ms; still waiting (Token Invalid)`:
    vm.ts passed `{ token: randomUUID() }` to sandboxAgentProvider while sandbox-provider.ts (03-01) hands
    the container's token through getToken(), so the two never matched. The terminate settled through
    `last_error` ("AgentOS prompt failed: session_storage_error: actor SQLite UDS request timed out after
    30000ms") rather than a `cancelled` stop reason. Fix: the token option was removed (Rule 1). Its
    worktree and branch were removed at the end of Task 1; `vm disposed … reason=sleep sandboxes=1` and
    0 labelled containers after the unit restart show the dispose hooks working.

    Run 2 — graph ut-muh1lap4-507edc27, 14:14:39Z–14:15:03Z. Every tracer key as in run 3
    (first_event=approval_pending at 14:14:55Z, exit_after_terminate=1 with stop reason cancelled,
    released_after_kill=true, claimed_by_after_kill=null), sandbox healthy. The in-VM probe then showed
    `blocked by hostFunction.invoke policy for substrate:issue-get` and `… for sandbox:run-command`: the
    sidecar names the resource `<collection>:<command>`, so `hostFunctionPermissions` now allows
    `substrate:*` and `<sandbox collection>:*` instead of the bare collection names (Rule 1). Its worktree
    and branch were removed at the end of Task 1.

    failed_run_worktrees_removed=2

## Gaps

- The model route was reached (the session's first action was a Read tool call under `ask`), but no
  model text was observed: with no approver the turn cannot go past its first tool call, so the
  prompt's steps (issue_get, tests, complete) were not exercised by the model. The host-function path
  the prompt names was exercised from the VM by the probe instead.
- `/home/agentos/.claude.json` is rewritten by Claude Code itself on first start (it adds
  firstStartTime, userID and migration flags); the `substrate` MCP entry survives, but a later sha256
  read-back of that file will not match the seeded hash.
- The hostFunction permission pattern grammar (`<collection>:<command>`) was learned live, not from
  docs; `operations: ["invoke"]` is confirmed by the sidecar's own refusal message.
- Route a:hostfn_proxy (in-VM relay, `model-fetch` host function) is implemented but untested: the
  selected route is a:loopback. Same for a:anthropic_key.
- The host functions `release` and `complete` were not invoked live (they would release or complete
  a claim); `issue-get` and the hostCallTarget refusal were.
- The three task records of runs 1–3 stay in /var/lib/substrate/agentos/tasks (released, exit 1);
  the two failed-run VM actors stay in rivet storage (no delete path in scope).

## Task 2 — openTask contract, live (after `sudo systemctl restart substrate-host`, healthz 200 at 14:21:09Z)

```
python3 /tmp/03-03-contract.py    # throwaway: graph_register, ensure_worktree, POST /tasks ×2, POST /tasks worktree=/tmp/x,
                                  # GET /tasks, graph_get, POST terminate, GET until exit_code, POST kill, graph_get
```

contract_graph_id=ut-muh1trcj-90066f6e
t_contract_open=2026-09-25T14:21:14Z
idempotent_first_status=202
idempotent_second_status=200
idempotent_prompt_count=1
bad_worktree_status=400
bad_worktree_error="worktree must be /var/lib/substrate/worktrees/ut-muh1trcj-90066f6e"
list_has_gid=true
contract_claim_session=n1
contract_exit_after_terminate=1
contract_released_after_kill=true
contract_claimed_by_after_kill=null
t_contract_done=2026-09-25T14:21:33Z

Unit tests for the same contract: `SUBSTRATE_DISABLED=1 bun test packages/host/src/tasks.test.ts
packages/host/src/api.test.ts` → ` 36 pass`, ` 0 fail` (neither file imports @rivet-dev).

## Cleanup

```
git -C /root/src/repos/agent-substrate worktree remove --force /var/lib/substrate/worktrees/<gid>
git -C /root/src/repos/agent-substrate branch -D substrate/<gid>       # for graph_id and contract_graph_id only
git -C /root/src/repos/agent-substrate worktree list                   # → main + ut-mugbqivi-752f2dad + ut-mughkkc0-73909228 (Phase 2's)
```

throwaway_worktrees_removed=2

## Retained

The four throwaway graphs (runs 1–3 and the contract graph) stay in the substrate index and their
VM actors stay in /var/lib/substrate/agentos: there is no delete path in scope and COVERAGE.md opts
out of sessions.delete. They hold no Linear or Notion reference and no claim (claimed_by null after
each kill). Their task records in /var/lib/substrate/agentos/tasks read released=true, exit_code=1.
