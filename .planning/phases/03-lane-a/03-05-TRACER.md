# 03-05 dispatch tracer evidence

Recorded from observed output only. One run; the claim landed on the first attempt, so there is no
failed-run entry.

Pre-run facts, taken on the host at 2026-09-25T14:51:00Z (Task 1 precondition): `systemctl
is-active substrate-host` printed `active`, `curl 127.0.0.1:7411/healthz` printed `200`,
`df --output=avail -B1 /` printed `28554977280` (≥ 5 GiB), the awk switch check exited 0 (last
`SUBSTRATE_DISPATCH_DISABLED` line is `=1`; nothing printed), `systemctl is-active
substrate-dispatcher` printed `active` with `NRestarts=0`. Dispatch stayed off for the whole run:
the tracer calls `dispatch.make_launch_fn` directly and never ticks.

## Run

```
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate \
  -E HOME=/root -E PYTHONPATH=/root/src/repos/agent-substrate/packages/dispatcher/src \
  -E SUBSTRATE_DISPATCH_DISABLED=1 /usr/bin/python3 - < /tmp/03-05-tracer.py > /tmp/03-05-tracer.out 2>&1
```

No `EnvironmentFile`: the tracer needs no key, so none was loaded into it. It exited 0 in 24 s.
The harness registered a throwaway graph over MCP (`graph_register {graph_id, repo:
"swcstudiospace/agent-substrate", branch: "main", status: "Implementing", nodes: [{node_id: "n1",
state: "unstarted"}]}` — no Linear or Notion reference), built `found` from `graph_get` in
graph_find's shape (repo and branch came from the graph_get reply), built a synthetic
`Candidate(issue_id="tracer-<gid>", identifier="TRC-2", surface="claude-code",
dispatch_label="dispatch:claude-code", …)`, called
`make_launch_fn(log=…, open_task=HostClient().launch)(candidate, found)` — the dispatcher's own
validate_ids → repo_checkout → ensure_worktree → open_task path — added the Session to a
`SessionRegistry()` with the fields tick uses, and reaped every 10 s with `McpClient()` and a Linear
stub whose every method raises `RuntimeError("no Linear in the tracer")`. Its column-0 key=value
lines follow verbatim; its `#` lines are in Findings.

graph_id=ut-muh32wc1-d14818ff
identifier=TRC-2
worktree=/var/lib/substrate/worktrees/ut-muh32wc1-d14818ff
launch_line=launched claude-code for TRC-2 graph ut-muh32wc1-d14818ff node n1 task ut-muh32wc1-d14818ff/n1 worktree /var/lib/substrate/worktrees/ut-muh32wc1-d14818ff
t_launch=2026-09-25T14:56:20Z
registry_capacity_left=1
t_claim_landed=2026-09-25T14:56:32Z
claim_evidence=claimed_by
claim_session=n1
poll_while_waiting=None
main_branch=main
worktree_branch=substrate/ut-muh32wc1-d14818ff

`identifier=TRC-2` is synthetic (no Linear issue exists for it; the SWC team is at its free-plan
cap and the label → poll leg is Phase 2-proven). `t_launch` is `Launched.started_at`
(`HostClient.launch` takes its clock before `POST /tasks`). `t_claim_landed` is the reap `now` at
which `SessionRegistry._reap_one` recorded the claim from `graph_get` (`claimed_by == "claude-code"`
→ `("claimed_by", "n1")`) — the registry's own landed-claim rule, unchanged. `poll_while_waiting`
is `RemoteTask.poll()` at the moment the host first reported `pending_approvals=1`: the host's
`exit_code` was `null`, so `None`.

## Timeline (UTC)

| Time | Event | Source |
|---|---|---|
| 14:56:20 | `validate_ids` → `repo_checkout` → `ensure_worktree` (branch `substrate/<gid>` from main) → `HostClient.launch` → `POST /tasks` (`t_launch`) | harness |
| 14:56:25 | `vm resolved ut-muh32wc1-d14818ff worktree /var/lib/substrate/worktrees/ut-muh32wc1-d14818ff sandbox published_loopback` | host journal |
| 14:56:32 | `task opened ut-muh32wc1-d14818ff/n1 (TRC-2)` — POST /tasks answered 202; `Launched(pid=0, proc=RemoteTask)` returned; `launched claude-code for …` logged; Session registered (capacity 2 → 1) | host journal, harness |
| 14:56:32 | First reap: `RemoteTask.poll()` → GET status → `exit_code null` → `None`; `graph_get` shows n1 `claimed_by=claude-code claim_session=n1` → `claim landed for TRC-2 (claimed_by, session n1)` (`t_claim_landed`) | harness |
| 14:56:33 | Host status `state=running exit_code=None pending_approvals=0 turn_in_flight=True session_id=n1` | harness (GET /tasks/<gid>/n1) |
| 14:56:37 | `approval pending ut-muh32wc1-d14818ff/n1 request 922500f6-… (telegram approvals off)` — the first model event, a permission request | host journal |
| 14:56:43 | Second reap (claimed, poll `None` → return); host status `state=waiting exit_code=None pending_approvals=1`; `poll_while_waiting=None`; harness exits with the task left running | harness |

## Findings

- **Launch path (D-06).** The live path ran `dispatch.make_launch_fn` → `validate_ids` →
  `worktree.repo_checkout` → `worktree.ensure_worktree` → `HostClient.launch` (`POST /tasks`) exactly
  once, with the real `HostClient` on 127.0.0.1:7411. The worktree was created by the dispatcher
  (D-12 unchanged) before the host was called; the host pinned it (`worktree must be …` would have been
  a 400). No Hermes launch and no Linear write happened.
- **Handle.** `Launched.pid=0`, `proc=RemoteTask`, `prompt_path=log_path=/var/lib/substrate/agentos/tasks/ut-muh32wc1-d14818ff--n1.json`
  (the host's task state file). The registry's `_reap_one` used only `poll()` on it.
- **Claim (landed-claim rule unchanged).** The host claimed the node as `claude-code` with session id
  `n1` (03-03's contract: session id = node id) before its first prompt; the registry saw it through
  `graph_get` on its first reap, 12 s after launch, as evidence `claimed_by` — no comment or state
  evidence was needed and no Linear call was made (the Linear stub was never reached: a claimed
  session with `code None` returns before any `comment_bodies`).
- **Poll while waiting.** With the session blocked on its first `Read` permission request under
  `permissionPolicy: "ask"` (no approver until 03-08), the host reports `state=waiting`,
  `turn_in_flight=true`, `exit_code=null`, so `poll()` is `None` and the claimed session stays
  registered without a timeout path (`claimed_at` set → the 900 s claim timeout no longer applies).
- **Harness `#` lines, verbatim:**
    # graph_register status=Implementing
    # found_repo_source=graph_get node_claimed_by=None
    # launched pid=0 proc=RemoteTask log_path=/var/lib/substrate/agentos/tasks/ut-muh32wc1-d14818ff--n1.json
    # log 2026-09-25T14:56:33Z claim landed for TRC-2 (claimed_by, session n1)
    # host 2026-09-25T14:56:33Z state=running exit_code=None pending_approvals=0 turn_in_flight=True session_id=n1
    # host 2026-09-25T14:56:43Z state=waiting exit_code=None pending_approvals=1 turn_in_flight=True session_id=n1
    # registry_active=['tracer-ut-muh32wc1-d14818ff'] given_up=[]
    # t_done=2026-09-25T14:56:43Z
- **After the harness exited** (14:57Z): `GET /tasks` lists `(ut-muh32wc1-d14818ff, session n1,
  waiting, exit_code null, 1 pending approval)`; `git worktree list` has the worktree; one sandbox
  container labelled `substrate.graph_id=ut-muh32wc1-d14818ff` (`127.0.0.1:32782->3000/tcp`). The
  task is left running for Task 2's D-05 restart.

## Gaps

- The label → poll leg for `dispatch:claude-code` (Linear `dispatch_candidates` → `graph_find`
  → `tick`) was not exercised here: the candidate and `found` were synthetic, and no Linear issue
  exists for TRC-2 (SWC free-plan cap). The proof (03-10) exercises it with the D-14 issue; the
  tick path itself is covered by test_dispatch.py (`claude-code` launches with capacity, host
  refusals comment once).
- The model's first turn stopped at its first tool call (permission request, no approver): the
  prompt's issue_get / work / complete steps were not run by the model, so `poll()` returning the
  host's 0 or 1 was observed only in test_host.py, not live.
- `RemoteTask.terminate()` / `kill()` were not invoked by the registry in this run (no timeout
  reached); Task 2 kills the task through the same host route directly.
