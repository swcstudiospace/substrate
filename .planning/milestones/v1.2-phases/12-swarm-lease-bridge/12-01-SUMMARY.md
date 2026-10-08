---
phase: 12-swarm-lease-bridge
plan: 01
one-liner: "The swarm runner works every task's node under a substrate lease it holds for the executing agent: claim before dispatch, heartbeat while the agent runs, complete on DONE, release and re-claim on rework, release on failure; two replicas never work one node and a dead replica's node frees itself."
subsystem: agent-swarm runner
tags: [swarm, leases, runner, adr-0001, s2, spe-5053]
requirements-completed: [LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09]
provides:
  - swarm/substrate_lease.py LeaseBridge - acquire, keeper heartbeat thread, settle, rework, plus claim_node/heartbeat/release/complete and settle_mirrored
  - claim before CLAIMED with session <AGENT>@<replica>:<graph_id> as the agent's surface; lease_s from the granted TTL
  - refusal table - expired re-claims; lost, unheld and not-holder stop the session and fail the task through the retry ladder
  - DONE completes fenced on lease_id; CHANGES_REQUESTED releases and re-claims; FAILED, BLOCKED, ESCALATED and CANCELLED release
  - substrate_client.mcp_call_outcome distinguishes ok, refused, busy, error, unreachable and off
key-files:
  created:
    - swarm/substrate_lease.py
    - tests/test_substrate_lease.py
    - docs/substrate-leases.md
  modified:
    - scripts/swarm_run.py
    - scripts/orch_status.py
    - swarm/results.py
    - swarm/substrate_client.py
    - swarm/substrate_tee.py
    - docs/substrate-tee.md
key-decisions:
  - The runner holds the lease for the executing agent, using that agent's per-surface token (SUBSTRATE_TOKEN_<SURFACE>) behind one lookup function; per-agent env files replace the lookup in Phase 14
  - A denied claim leaves the task undispatched without spending an attempt or a slot; a refused claim (no token, wrong identity) is also not dispatched and is recorded, so a misconfigured agent never runs quietly unleased
  - Only an unreachable or failing substrate dispatches unleased (fail-open), with a lease.unleased warning and a task note
  - The keeper beats every TTL/3 and keeps the producer's lease from IN_REVIEW until DONE, so DONE's fenced graph_complete and CHANGES_REQUESTED's release always have a live hold
  - Leases left held when a run stops early lapse within one TTL and the same replica renews them next run; no reaper is on the path
  - The claim reply's ttl_seconds (added in Phase 11) is the granted TTL; the client clamps its request to the server's 30-86400 s range
completed: 2026-10-07
status: complete
---

# Plan 12-01 Summary

## What shipped
- `swarm/substrate_lease.py`: one `LeaseBridge` per runner process. It claims a node before the task moves to `CLAIMED`, as the executing agent's surface with session `<AGENT>@<replica>:<graph_id>` (`SWARM_REPLICA`, default `r0`), and keeps the `lease_id`. The assignment's `lease_s` is the granted TTL.
- A keeper thread heartbeats every TTL/3. `expired` re-claims as the same session; `lost`, `unheld` and `not-holder` stop the agent's process group and fail the task through the existing retry ladder; no answer keeps working.
- `results.reconcile` and `execute_one` settle the lease: DONE completes the node fenced on the lease, CHANGES_REQUESTED releases and re-claims, and FAILED, BLOCKED, ESCALATED and CANCELLED release. A live dispatch is stopped and its process groups are confirmed gone before release; `orch_status --transition` defers settlement while the runner is active.
- The Task Store keeps the DAG, budgets, bids and arbitration records; `notes.lease` is an advisory mirror. New run-log types `lease.denied`, `lease.unleased`, `lease.refused`, `lease.lost` and `lease.unsettled` are teed; no `lease_id` is written to any event.
- `docs/substrate-leases.md` is new; `docs/substrate-tee.md` documents the env and session.
- Resumed review tasks re-claim before reconciliation. Gate scripts stay under the lease watch; shutdown and signal exits reject their results. Local request-slot contention waits within the deadline, then defers dispatch without poisoning outage back-off or the Graph ID cache. A busy re-claim after expiry also defers without stopping the active dispatch.

## Evidence
- agent-swarm `origin/main` at phase start: 622 tests. Final review-fix branch: 688 tests, full suite passing (`python3 -m pytest`), including saturation, real process-group shutdown, interrupted-gate and busy-expired-reclaim regressions. The simulated substrate follows the server's granted TTL, compare-and-swap rules, session shape, holder-only ids and `not-holder`.
- `ruff check swarm scripts`: clean. The two E401 findings in `tests/test_uplift_harness.py` are on `origin/main` already and untouched.
- Live proof `/tmp/p12-lease-live-proof.sh` against the Phase 11 server (127.0.0.1:7499, real Postgres and GreptimeDB), driving the branch's `LeaseBridge`, `swarm_run.select_batch` and `results.reconcile`: 24/24 PASS (`/tmp/p12-proof-1791408292`). Two A05 replicas race for one node and exactly one dispatches; the loser stays PLANNED with no attempt spent and its denied reply shows no `lease_id`; A01's token cannot beat A05's lease; a CHANGES_REQUESTED task shows claim, release and re-claim in `events_query` with epochs n, n, n+1; CANCELLED releases; DONE completes the node, which `graph_get` reads as completed and unheld. A real 30-second lease expires, local slots saturate during re-claim, and recovery obtains a fresh lease without stopping or failing the dispatch.
- Shipped as [agent-swarm #9](https://github.com/swcstudiospace/agent-swarm/pull/9) after four review rounds, final Greptile 5/5, zero open review threads and passing CI.

## Deviations
- The runner reads the agent's token from `SUBSTRATE_TOKEN_<SURFACE>` in its own environment, as decided for this phase; reading it from the agent's env file is Phase 14 (INST-03), which swaps the one lookup function.

## Lessons
- Local transport saturation is neither an outage nor a server refusal. Apply that distinction to both initial claims and expired-lease reclaims.
