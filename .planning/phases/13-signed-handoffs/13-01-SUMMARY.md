---
phase: 13-signed-handoffs
plan: 01
one-liner: "Context that crosses an accountable-agent boundary is written down by its sender as a signed coord_handoff packet and can be rebuilt from the ledger alone; a killed replica's node is taken over within one TTL with no two holders, and a failed gate handed to A14 is reconstructed with no bus or Task Store read."
subsystem: agent-swarm runner
tags: [swarm, handoffs, leases, adr-0001, s2, spe-5053]
provides:
  - swarm/substrate_handoff.py HandoffBridge - dependency, failing-gate and escalation packets, each sent with the sender's own token
  - reconstruct(graph_id, node_id) - a node's context from coord_handoff_list and events_query only, trusting the server's verdict per packet
  - rework-cap escalation hands the producer's lease over with release_lease, released only once the packet is stored
  - one packet per boundary (keys in notes, deduped per sender), retried within the run when the substrate is unreachable
  - unsigned packets when SUBSTRATE_HANDOFF_KEY is unset, labelled UNSIGNED, with the run completing
key-files:
  created:
    - swarm/substrate_handoff.py
    - tests/test_substrate_handoff.py
    - docs/substrate-handoffs.md
  modified:
    - scripts/swarm_run.py
    - swarm/results.py
    - swarm/substrate_lease.py
    - swarm/substrate_client.py
    - swarm/substrate_tee.py
    - docs/substrate-leases.md
    - docs/substrate-tee.md
key-decisions:
  - Boundaries are a dependency owned by another agent, a failing gate (gate agent to producer) and an escalation (to A14 when the work came from A14, else A01); same-agent edges, APPROVED to DONE, stalls and BLOCKED are not boundaries
  - A sender without its own token sends nothing (handoff.refused); the A01 fallback token would sign as A01
  - The receiving node is node_id, so reconstruct(graph, node) reads exactly that node's packets
  - The runner adds the reconstructed context to the assignment as a Handoffs section; agents outside the runner call reconstruct or the two MCP tools
  - Escalation routing to A14 is derived from the work's upstream; routing every security failure to A14 would be a lifecycle change and is not made
completed: 2026-10-07
status: complete
---

# Plan 13-01 Summary

## What shipped
- `swarm/substrate_handoff.py`: `HandoffBridge` writes one `coord_handoff` packet per boundary with the sender's own surface token:
  - a dependency owned by another agent, written when the dependent task is dispatched;
  - a failing gate, from the gate's agent to the producer on rework;
  - an escalation, to A14 when the work came from A14, else to A01.

  Each packet carries `goal`, `files`, `dod` (the receiving node's `acceptance[]`), `blockers` (the failing findings) and the sessions.
- The rework-cap escalation hands the producer's lease over with `release_lease`, so the server releases it only once the packet is stored. The packet records `lease_handover`, never the id.
- `reconstruct(graph_id, node_id)` makes exactly two reads, `coord_handoff_list` and `events_query`, and trusts the server's verdict per packet. The assignment carries the result as a "Handoffs (from the substrate ledger)" section.
- Idempotency comes from per-sender keys in the packet notes. An unreachable substrate gives a warning, and the packet is retried within the run. With no handoff key, packets are recorded unsigned, labelled UNSIGNED, and the run completes.
- `docs/substrate-handoffs.md` is new; the lease and tee docs are updated.

## Evidence
- agent-swarm Phase 13 branch (on Phase 12): 683 tests, full suite passing; `tests/test_substrate_handoff.py` has 18 cases. HAND-02's test reconstructs with the Task Store renamed away, the swarm dir emptied, `TaskStore.__init__` failing and an audit hook on `open`/`sqlite3.connect`. `ruff check` is clean on the changed files; `bun test tests/ts` passes.
- PROOF-02, `/tmp/p13-proof.sh` against the merged Phase 11 server (agent-substrate `main` 1791393, real Postgres and GreptimeDB, `SUBSTRATE_HANDOFF_KEY` set): 49/49 PASS.
  - (a) A05 replica r1 runs as its own process under CPU load (one busy loop per CPU). r2 is denied while r1's keeper beats. After r1 is SIGKILLed, r2 takes the node `stolen` 25.0 s after the kill, within the 30 s TTL. The holder changes exactly once (r1 to r2), r2's hold starts no earlier than r1's last expiry, the epoch moves by one, and the trail shows the takeover as a `warning`.
  - (b) A real `select_batch`/`execute_one`/`reconcile` run with a stubbed agent CLI produces A14 to A05 dispatch, A08 to A05 twice (rework), and A05 to A14 escalation with the lease handed over. A14 then reconstructs the task from `coord_handoff_list` and `events_query` alone: no NATS or broker, and no Task Store, run log or swarm state opened on the receiving side. The packet is signed and verifies with key `k1`, and A14 claims the node it was handed.

## Deviations
- None from the plan. A first proof run hit an older server because the substrate worktree had been moved off Phase 11 by a ship cleanup; the run above is against the merged Phase 11 code.
