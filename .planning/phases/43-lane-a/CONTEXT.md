---
phase: 43-lane-a
requirements: [H-D1, H-D3]
status: decided and executed in-repo 2026-10-21. The live egress proof and a live restart on the host are operator-gated
---

# 43-CONTEXT: LANE-A

## Scope (ROADMAP)

1. An enforced egress allowlist for the sandbox container (September N3 found it could reach example.com).
2. Running tasks are re-adopted after a dispatcher restart, so no orphaned VMs remain (N4).

## State on origin/main 3e9a106 (verified before the phase)

- Criterion 1 is implemented on the host: `SUBSTRATE_SANDBOX_EGRESS` parses an allowlist, the default is deny-all, and `egressRules` composes DOCKER-USER accepts for resolved destinations and a final source DROP (packages/host/src/sandbox-options.ts, sandbox-provider.ts). Tests cover parsing and composition.
- Host restarts are covered: `reconcileSandboxes` (packages/host/src/tasks.ts) re-attaches labelled sandboxes that map to a claimed task, removes other labelled sandboxes as orphans, and leaves unlabelled containers alone. It runs at host boot (packages/host/src/main.ts).
- The dispatcher kept dispatched sessions only in memory. Only `given_up.json` was persisted.
- The dispatcher's systemd unit uses `KillMode=control-group` on purpose: a dispatcher stop or restart ends every Hermes session it launched (infra/vps/substrate-dispatcher.service).
- VM tasks (dispatch:claude-code) run on substrate-host outside that cgroup. A dispatcher restart therefore left them running with no watcher. That is the orphan case criterion 2 is about.

## Decisions

- D43-a. Hermes sessions are not persisted and not re-adopted. They end with the unit by design. Re-adopting them would contradict the kill switch.
- D43-b. VM-task records persist in `<STATE_DIR>/vm_tasks.json` (0600, atomic replace, 0700 directory), one per graph and node: issue_id, identifier, graph_id, node_id, surface, dispatch_label_id, started_at, repo, prior_claim_sessions, and, once a claim lands, claimed_at and claim_session. No prompt, token, or issue prose is stored.
- D43-c. Re-adoption runs at each tick until resolved. A host 404 drops the record. A running task is re-adopted with a RemoteTask watcher and counts toward max_sessions. A finished task is re-adopted so reap sees it. An unreachable host keeps the record, and 60 consecutive failed attempts drop it with a log line.
- D43-d. A pending record counts as an active issue and an active graph. Otherwise a tick could open a second VM task on a graph that still has one running, which breaks the one-writer rule.
- D43-e. A give-up removes the record immediately, so a restart in the terminating window does not re-adopt it and emit a second `dispatch.failed`.
- D43-f. prior_claim_sessions is persisted. Without it a claim comment left by an earlier session on the same node would count as the re-adopted task's own claim (found in review and fixed in the same phase).
- D43-g. launch_state is not persisted. A re-adopted session starts with launch_state None, as the code already documents.
- D43-h. Dry runs never write or adopt.
- D43-i. A VM task's record is written before its launch call, with the same fields and a provisional started_at that add() replaces with the launch's start time. The record is removed only when the launch fails with a HostRefused whose may_be_open is False: a connection that never opened (connect failure or connect timeout) or a 4xx refusal, both of which prove no task was opened. Every other failure keeps the record, because the host may already have opened the task: a lost reply, a 5xx, or a 2xx whose body cannot be read. readopt() resolves a kept record through the same status path as every other record: a 404 drops it, a running or finished task is re-adopted.
- D43-j. Pending VM records hold slots toward max_sessions. capacity_left() counts live sessions plus pending records, so a tick cannot launch a Hermes session past the cap. readopt() counts only live sessions when it decides how many records it may adopt, so the cap never stops a pending record from being resolved.
- D43-k. Landed-claim evidence (claimed_at, claim_session) is written to the VM-task record when the claim lands and restored by readopt(). After a restart, a claim that landed cannot become an exited-unclaimed failure because its claim comment never posted.

## Out of scope

- A live restart of the dispatcher and a live egress proof on the host. Both are operator-gated.
- Changing Hermes launch behaviour or the restart kill switch.
