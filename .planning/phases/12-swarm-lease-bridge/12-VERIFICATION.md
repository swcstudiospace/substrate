---
phase: 12-swarm-lease-bridge
verified: 2026-10-07T22:44:46Z
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
| 5 | Task Store keeps everything; the run completes as before with the substrate unreachable | Outage regression retains fail-open/back-off; final review-fix suite 688 passing (622 at phase start), including local-contention, busy-reclaim and interrupted-gate regressions | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| LEASE-05 | Criterion 1 | satisfied |
| LEASE-06 | Criterion 2 | satisfied |
| LEASE-07 | Criterion 3 | satisfied |
| LEASE-08 | Criterion 4 (the live kill takeover is part of PROOF-02 in Phase 13) | satisfied |
| LEASE-09 | Criterion 5 | satisfied |

## Historical implementation proof
`/tmp/p12-lease-live-proof.sh` against the Phase 11 server (127.0.0.1:7499, real Postgres and GreptimeDB): 24/24 PASS.

Final review fixes verified on commit `5edd55f`: 688 tests pass, changed-file Ruff passes, and the live proof passes 24/24 (`/tmp/p12-proof-1791408292`). Requests waiting for local capacity cannot trigger outage back-off or unleased dispatch. A busy re-claim after real PostgreSQL lease expiry defers without killing the active dispatch, then reclaims when capacity returns. Shutdown marks child groups stopped; signal-terminated gates cannot approve a partial result.

PR [agent-swarm #9](https://github.com/swcstudiospace/agent-swarm/pull/9) merged after Greptile 5/5 on `5edd55f` with zero open threads. Milestone audit rechecked this evidence after the SUMMARY gained its lessons-bank entry; no later lease implementation change is claimed here.

## Formal audit remediation

- Corrected source: agent-swarm `ce13342`, committed after parent verification. Authentication/identity refusals during graph lookup and registration now refuse dispatch; authenticated heartbeat refusals stop the held work rather than becoming outage retries.
- Parent gates: 757 Python tests passed, generator current, TypeScript contract 1/1, changed-file Ruff clean. New cases cover prior negative caches, credential denial, child-group termination/result rejection, refused expiry reclaim, terminal settlement, successor release fencing and full non-dry-run outage completion with unchanged DAG, budgets and records.
- Fresh real Postgres/Greptime proof: 24/24, isolated 7499, 34.04 seconds; `/tmp/p12-proof-1791412421`. Direct stale-mirror `graph_complete` remains a narrow unexecuted branch, not a claimed live check.
- [Nyquist validation](12-VALIDATION.md) is compliant; [ASVS-L1 security](12-SECURITY.md) closes all 12 threats without accepted risks.
- The corrective commit ships with the signed-handoff branch; the earlier PR #9 merge is historical provenance, not approval of this later commit.
