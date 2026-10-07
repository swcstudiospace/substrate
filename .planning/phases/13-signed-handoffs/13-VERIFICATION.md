---
phase: 13-signed-handoffs
verified: 2026-10-07T22:40:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 13 Verification: Signed handoffs

Goal: context that crosses an accountable-agent boundary is written down by its sender and can be replayed from the ledger alone.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | Every accountable-agent boundary writes one packet (`goal`, `files`, `dod` from `acceptance[]`, `blockers`, `graph_id`, `node_id`) with the sender's own token | `test_substrate_handoff.py`: exact caller per packet, relabelled packet verifies `bad-signature`, no own token sends nothing; live: one packet per boundary, each from its sender | passed |
| 2 | A receiving agent's context is rebuilt from `coord_handoff_list` and `events_query` alone, proven by a test | Unit test with the Task Store and swarm dir removed and an audit hook on file and sqlite opens: exactly two calls as A14; live: A14's `a14.py` rebuilds goal, dod, blockers and files with nothing opened locally | passed |
| 3 | With `SUBSTRATE_HANDOFF_KEY` unset, packets are recorded unsigned, say so, and the run completes | Unit: a full `swarm_run.run()` with no key ends DONE ×2, packet unsigned, `handoff.unsigned` once, prompt says UNSIGNED | passed |
| 4 | A killed A05 replica's node is claimed by a second A05 within one TTL, shown as a `warning`, never two holders | Live under CPU load: `stolen` 25.0 s after SIGKILL (TTL 30 s), holder sequence exactly r1 → r2, r2's hold starts no earlier than r1's last expiry, epoch +1, one `warning` | passed |
| 5 | A05 hands a failed gate to A14 with the swarm bus stopped; A14 rebuilds the task from the ledger alone | Live: escalation signed and verified with `k1`, `lease_handover` true and no id, release after the packet; no broker process; A14 reconstructs and claims the node | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| HAND-01 | Criterion 1 | satisfied |
| HAND-02 | Criterion 2 | satisfied |
| HAND-03 | Criterion 3 | satisfied |
| PROOF-02 | Criteria 4 and 5, `/tmp/p13-proof.sh` 49/49 against the merged Phase 11 server | satisfied |

## Proof
`/tmp/p13-proof.sh` (agent-substrate `main` 1791393 on 127.0.0.1:7496, real Postgres and GreptimeDB): 49/49 PASS.
