---
phase: 12-swarm-lease-bridge
verified: 2026-10-07T20:30:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 12 Verification: Swarm lease bridge

Goal: every swarm task is worked under a substrate lease the runner holds for the executing agent, so two replicas never work one node and a dead replica's node frees itself.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | Claim before `CLAIMED` as the agent's surface with session `<AGENT>@<replica>:<graph_id>`; `lease_s` from the granted TTL; denied → undispatched; unreachable → unleased and recorded | `test_substrate_lease.py` (grant with `lease_s`, denied, refused, unreachable and error cases); live: one grant, one denial, loser still PLANNED with no attempt spent. The token comes from `SUBSTRATE_TOKEN_<SURFACE>`; the env-file source is Phase 14 (INST-03) | passed |
| 2 | Heartbeat well inside the TTL; `lost` / `expired` / `unheld` mapped from a tested table; `expired` re-claims | `test_substrate_lease.py` refusal-table cases on a simulated clock; live: the winner's heartbeat extends its lease, and A01's token beating A05's lease is refused `not-holder` | passed |
| 3 | DONE via fenced `graph_complete`; CHANGES_REQUESTED shows release then re-claim; FAILED / CANCELLED release | Unit cases for each transition; live: `events_query` shows claim, released, claim with epochs n, n, n+1; CANCELLED releases; DONE completes and `graph_get` reads completed and unheld | passed |
| 4 | Racing replicas get exactly one grant; a killed replica's node is free within one TTL with no reaper | Unit: two replicas → one dispatch; a stopped keeper lets a second replica claim after expiry on the simulated clock. Live: the race gives one grant. The kill-under-load takeover runs live in Phase 13 (PROOF-02) | passed |
| 5 | Task Store keeps everything; the run completes as before with the substrate unreachable | Unit: unreachable → dispatched unleased with a warning; full suite 666 passing (622 on `origin/main`), existing runner and gate tests unchanged | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| LEASE-05 | Criterion 1 | satisfied |
| LEASE-06 | Criterion 2 | satisfied |
| LEASE-07 | Criterion 3 | satisfied |
| LEASE-08 | Criterion 4 (the live kill takeover is part of PROOF-02 in Phase 13) | satisfied |
| LEASE-09 | Criterion 5 | satisfied |

## Proof
`/tmp/p12-lease-live-proof.sh` against the Phase 11 server (127.0.0.1:7499, real Postgres and GreptimeDB): 21/21 PASS.
