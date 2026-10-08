---
phase: 13-signed-handoffs
plan: 01
one-liner: "Context that crosses an accountable-agent boundary is written down by its sender as a signed coord_handoff packet and can be rebuilt from the ledger alone; a killed replica's node is taken over within one TTL with no two holders, and a failed gate handed to A14 is reconstructed with no bus or Task Store read."
subsystem: agent-swarm runner
tags: [swarm, handoffs, leases, adr-0001, s2, spe-5053]
requirements-completed: [HAND-01, HAND-02, HAND-03, PROOF-02]
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
- Final agent-swarm Phase 13 branch, including all Phase 12 review fixes: 705 tests, full suite passing. `tests/test_substrate_handoff.py` has 18 cases. HAND-02's test reconstructs with the Task Store renamed away, the swarm dir emptied, `TaskStore.__init__` failing and an audit hook on `open`/`sqlite3.connect`. Changed-file Ruff and `bun test tests/ts` passed in the earlier phase verification.
- PROOF-02, `/tmp/p13-proof.sh` against the merged Phase 11 server (agent-substrate `main` 1791393, real Postgres and GreptimeDB, `SUBSTRATE_HANDOFF_KEY` set): 49/49 PASS after the final lease fixes (`/tmp/p13-proof-1791408817`; 34 driver checks plus 15 receiving-agent checks).
  - (a) A05 replica r1 runs as its own process under CPU load (one busy loop per CPU). r2 is denied while r1's keeper beats. After r1 is SIGKILLed, r2 takes the node `stolen` 25.3 s after the kill, within the 30 s TTL. The holder changes exactly once (r1 to r2), r2's hold starts no earlier than r1's last expiry, the epoch moves by one, and the trail shows the takeover as a `warning`.
  - (b) A real `select_batch`/`execute_one`/`reconcile` run with a stubbed agent CLI produces A14 to A05 dispatch, A08 to A05 twice (rework), and A05 to A14 escalation with the lease handed over. A14 then reconstructs the task from `coord_handoff_list` and `events_query` alone: no NATS or broker, and no Task Store, run log or swarm state opened on the receiving side. The packet is signed and verifies with key `k1`, and A14 claims the node it was handed.

## Deviations
- None from the plan. A first proof run hit an older server because the substrate worktree had been moved off Phase 11 by a ship cleanup; the run above is against the merged Phase 11 code.

## Lessons
- Prove ledger-only handoff recovery in a separate process with local state unavailable; replay must retain the sender's signature verdict and the receiving task's acceptance criteria.

## Exact-head review correction — 2026-10-08

- At the correction checkpoint, published client source was `f2686c7d8995c6e500417031c99d9d4418455238`, agent-swarm PR[10](https://github.com/swcstudiospace/agent-swarm/pull/10), with review run30258836 pending. The later terminal receipt below supersedes that delivery state; historical705/757-test and49-check receipts remain their original executions.
- Three actual review findings were corrected in `swarm/substrate_handoff.py`, its behavioral tests and `docs/substrate-handoffs.md`: late queued or regenerated dependency packets cannot erase newer rework; committed-but-lost replies refresh dedupe keys; malformed receiving objects cannot hide valid packets. No lease-authority or signature-protocol cutover was made.
- A protected signed logical-time header anchors initial task context to immutable `created_at` and later gate/escalation context to `updated_at`. Arrival/storage order stays visible in the audit trail but does not choose current instructions. The existing Task Store provides the anchor; no new storage or distributed causal clock was added.
- Refreshing after uncertain writes retains local confirmations and in-flight reservations and rejects a snapshot crossed by another uncertain write. Fourteen plausible consumer regression cases include signed/unsigned, one/two reworks, flush/redispatch, actual stored-but-lost response semantics, a controlled concurrent refresh and malformed sender/receiver/list fields. Failing-before controls: `artifact://112`, `artifact://114`, `artifact://129`, `artifact://131`.
- Parent final gate: **771 Python tests passed in94.10s**, changed-file Ruff clean. Subsequent source change during the run was docstring wording only; product documentation then updated. Source was committed and pushed without later semantic changes.
- Current changed-path runtime: **4/4**, real native client and signed server on isolated`:7512`, real Postgres`:55432` and GreptimeDB`:54000`; controlled outage before write, reply loss after actual persistence, regenerated redispatch and malformed receiving response. Graph`ut-muyyxewt-3f8b2d21`; rework packet`hof_845466c4f0e24e11a9587f2fc413b72e`; lost-reply packet`hof_80c45d04fed5489fadfadfb2d3bafda4`; `/tmp/p13-review-real-m9092cl5`.
- Retained current-run S2 proof: **49/49 in67.05s**, `/tmp/p13-proof-1791428380`, `artifact://119`, server at substrate`a9d699e9e70ee7f112a4fe793572852054eff572` on`:7511`. Eight CPU loops, keeper beyond35s, takeover24.9s within30s TTL,231 samples/one holder transition/epoch+1; handoff`03:00:47.236Z` before release`03:00:47.250Z`; separate A14 ledger-only recovery and claim/release. This ran on the intermediate review-fix tree **before** the final cache-generation and immutable-creation-anchor refinements, not as a new49-case run at final`f2686c7`. Their changed paths have current771/four-scenario proof.
- Scope limits: controlled malformed upstream response, not corruption of the real ledger; no new vulnerability scan or full LLM swarm run. Independent current goal/security reassessments, exact-head review/merge, both workspace deliveries and milestone audit/archive are separate gates.

## Terminal delivery receipt — 2026-10-08

PR[10](https://github.com/swcstudiospace/agent-swarm/pull/10) merged at `2026-10-08T03:38:42Z`, squash `3e513c9539d31611ef2f7a3c12247330a84aa0c5`, exact source `f2686c7d8995c6e500417031c99d9d4418455238`. Configured Greptile round2 passed **5/5, zero comments**; both GitHub `ci/test` runs and Greptile Review were SUCCESS. One earlier failed review round produced the three genuine corrections above.

Current independent goal gate passed5/5 criteria,4/4 requirements and9/9 tasks StateA. Current ASVS-L1 gate is **SECURED,8/8 threats closed,zero opens/accepted risks**, with qualified retained proof rather than a fabricated full final-head rerun. The configured squash merge deleted the remote source branch; local `main` synchronization refused because `/root/src/worktrees/agent-swarm-p12` already owns main. That checkout was preserved, not reset.

Notion Task and existing Linear SPE-7579 receipt were synchronized before projector PR18 assessment. Both workspace deliveries and fresh milestone audit/archive/approved cleanup remain; this receipt does not declare the whole milestone complete.
