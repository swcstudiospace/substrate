# Phase 12: Swarm lease bridge - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted. Decisions come from ADR 0001 S2 criteria 1-5 and 10, REQUIREMENTS LEASE-05..09, `docs/coordination.md` and the Phase 11 server contract.

<domain>
## Phase Boundary

agent-swarm side of S2's lease half (Linear SPE-5053). `scripts/swarm_run.py` claims, heartbeats, completes and releases each task's node on behalf of the agent it dispatches to; `swarm/results.py` `reconcile` is where DONE and CHANGES_REQUESTED happen. Branch `feat/v1.2-p12-lease-bridge` from origin/main `26c5e74`. Handoff packets are Phase 13; per-agent env files and stripping the child's tokens are Phase 14. The server half (session shape, holder-only `lease_id`, `not-holder`, no swarm operator) is Phase 11, built in parallel; this phase codes against its contract.

</domain>

<decisions>
## Implementation Decisions

### Locked (2026-10-07)
- The runner holds each task's lease for the executing agent and calls with that agent's surface token (`SUBSTRATE_TOKEN_<SURFACE>` via `substrate_client._token`). Token lookup sits behind one function so Phase 14 can swap it for the agent's env file.
- A denied claim leaves the task undispatched (PLANNED/RETRY, or IN_PROGRESS for rework) for a later scheduling pass.
- An unreachable substrate dispatches unleased and records that it did.

### Claude's Discretion
- **Module.** New `swarm/substrate_lease.py`. `LeaseBridge(store_path, correlation_id, *, root, emit, env)` per runner process: `acquire(task, agent_id) -> Claim`, `lease_s(tid)`, `watch(tid, stop)`, `beat(tid)`, `start()` / `close()` for the heartbeat thread, `settle(tid)`, `rework(tid)`. `Claim.status` is `held | denied | refused | unleased | off`, and `Claim.dispatch` is true for `held`, `unleased` and `off`. Module-level `settle_mirrored(store, tid, emit)` serves `orch_status --transition`. Every lease call goes through `_call()`, which is the one Phase 14 changes.
- **Telling "no" from "no answer".** `mcp_call` folds `isError` into `None`, the same as a dead host, and that would let a misconfigured token dispatch unleased. A new `substrate_client.mcp_call_outcome` returns `ok | refused | error | unreachable | off`. `refused` covers HTTP 401/403 and an `isError` reply carrying `{"error": …}`, which is how `mcp.ts` `refusal()` answers identity and session refusals. `error` covers any other non-2xx and a thrown server error such as no `SUBSTRATE_PG_URL` or a DB outage. `mcp_call_json` becomes a wrapper with unchanged results. Claim mapping: `refused` → not dispatched, a `lease.refused` warning and the task note; `error` and `unreachable` → unleased (fail-open); `off` → nothing recorded, behaviour byte-for-byte as before.
- **Unregistered nodes.** Gate reruns (`<base>.rN`) are created after `orch_plan` registered the node set, and `claimNode` throws `unknown node`. On that error the bridge registers the node with `graph_register {graph_id, nodes: [{node_id}]}` as `swarm-a01-orch`, which upserts nodes and leaves edges alone without `edges`, then retries the claim once.
- **TTL and heartbeat.** The requested TTL is `SWARM_LEASE_TTL_S`, default 900 (the server default), clamped client-side to [30, 86400] because zod rejects out-of-range values. The granted TTL is `decision.ttl_seconds` when the reply carries it, else the clamped request. Heartbeat interval = TTL/3 of the clamped TTL, so never under 10 s. After an unanswered beat the next try comes after `min(TTL/3, 30 s)`, the client's back-off, so one blip cannot run out the TTL.
- **Heartbeat thread.** One daemon keeper per bridge, started in `run()` and stopped in its `finally`. It beats every held lease when due, not only the leases of running sessions. `run_agent_headless(..., on_session=)` registers the session's stop callback right after spawn and clears it at exit. A refusal that stops a session SIGTERMs its process group and SIGKILLs it 10 s later; `communicate` returns and the runner raises `LeaseStopped`. A loss recorded before the session registered stops it the moment it registers. Before each beat the keeper re-reads the task. A task that has left the holding states, for example CANCELLED by another process, is settled rather than beaten.
- **Refusal → transition (while a session runs).**

  | Refusal | Action | Task |
  |---|---|---|
  | `expired` | re-claim as the same session: `reclaimed` in the trail, new `lease_id`, the session continues | unchanged |
  | `expired`, re-claim denied or refused | stop the session | FAILED `E-TIMEOUT: lease expired and was taken` |
  | `lost` | stop the session | FAILED `E-TIMEOUT: lease lost` |
  | `unheld` | stop the session: the node was released or force-released under it | FAILED `E-TIMEOUT: lease unheld` |
  | `not-holder` | stop the session | FAILED `E-POLICY: lease not-holder` |
  | any other `ok: false` reason | stop the session | FAILED `E-TIMEOUT: lease refused (<reason>)` |
  | no answer or server error | keep working, retry sooner | unchanged |

  FAILED rather than RETRY, because it runs the existing ladder: FAILED → RETRY behind a fresh claim, bounded by `max_attempts`, then ESCALATED. A lease that keeps slipping therefore escalates instead of looping. Between rounds, when no session runs, `expired` and `unheld` re-claim if the task still holds (nothing is at risk), and every other refusal drops the lease with a `lease.lost` warning. The task state stays as it is: A01 owns lifecycle, and the next claim or `graph_complete` meets the new holder.
- **IN_REVIEW → DONE.** The runner keeps heartbeating the producer's lease across the gate rounds and does not release at IN_REVIEW. LEASE-07 says `DONE` goes through `graph_complete` fenced on `lease_id`, and the ADR says `CHANGES_REQUESTED` *releases* and re-claims. Both presuppose a lease still held at the end of review. Holding it also keeps the node reading as A05's while A05 is the only agent that may touch the artifact next. `reconcile` calls `settle(tid)` after APPROVED → DONE, which completes the node. If this process no longer holds the lease (for example after a restart), it claims as the producer (`renewed` if its old lease is live) and completes. A refused claim is recorded as `lease.unsettled`, and DONE stands.
- **CHANGES_REQUESTED.** `reconcile` calls `rework(tid)` after CHANGES_REQUESTED → IN_PROGRESS. That is a fenced `graph_release`, then a fresh `graph_claim` (`granted`, new `lease_id`), so the trail shows `note released` followed by `claim`. The rework dispatch reuses that lease. A denied re-claim leaves the rework IN_PROGRESS with no session, and dispatch retries the claim. CHANGES_REQUESTED → ESCALATED (rework cap) releases.
- **FAILED, CANCELLED, BLOCKED, ESCALATED.** `execute_one` settles in a `finally` from the task's final state: DONE completes, CLAIMED/IN_PROGRESS/IN_REVIEW/APPROVED keep the lease, and anything else releases. The release is fenced on the held `lease_id`. A `stale-lease` or `noop` answer means the lease is no longer ours and is recorded, not warned. CANCELLED and other manual transitions go through `orch_status --transition` → `settle_mirrored`, which releases or completes with the `lease_id` mirrored in the task note. A live runner's keeper does the same on its next beat.
- **Replica.** `substrate_tee.replica_id()`: `SWARM_REPLICA`, default `r0`, must match `[A-Za-z0-9._-]{1,64}`. `swarm_run` refuses a bad value with `E-INPUT` at start when leasing is on. The tee and the lease build `session_id = <AGENT>@<replica>:<graph_id>` through one `session_id()`. A runner restarted under the same replica is the same holder, so its claim on a still-live lease is `renewed`.
- **`lease_s`.** `assignment_prompt(..., lease_s=)` takes the granted TTL. Unleased or off, it falls back to `budget.max_wall_s` as before.
- **Recording.** The Task Store keeps an advisory mirror in `notes.lease`: `state` (`held | denied | refused | unleased | released | completed | lost | unsettled`), plus `lease_id`, `agent`, `surface`, `session_id`, `graph_id`, `ttl_s`, `action`, `reason`, `holder` and `at` as they apply. It is A01's note, which the ADR calls "an advisory mirror of `lease_id`, not a second authority". Run-log types, all emitted by the runner (A01), each one row in `TYPE_KINDS`: `lease.unleased` → `warning`, `lease.denied` → `note`, `lease.refused` → `warning`, `lease.lost` → `warning`, `lease.unsettled` → `warning`. Grants, re-claims, releases and completions are not re-emitted, because the server writes `claim` / `warning` / `note` for them itself. No `lease_id` goes into any event payload.
- **Scheduling.** Claims happen in `run()` while the batch is built (`select_batch`). A task whose claim is denied or refused does not take a parallel slot. When a round has candidates but every one is waiting on a lease, the run stops with `waiting on leases: […]` rather than spinning through `--max-rounds`. With leasing off, `select_batch` slices exactly as before.
- **Off paths.** No bridge on `--dry-run` (dry runs never touch the substrate) or with the integration off. The `orch_status --ingest` / in-session Agent-tool path stays unleased in this phase.
- **Live proof.** `/tmp/p12-lease-live-proof.sh` calls `substrate_client` / `substrate_lease` directly against a smoke server on :7499 built from the Phase 11 worktree, rather than a full `swarm_run`. The race and the release/re-claim trail are lease-level facts, and a full run would add agent CLIs without adding evidence.

</decisions>

<code_context>
## Existing Code Insights

- `execute_one` already marks `CLAIMED → IN_PROGRESS` with reason "lease started", and comments speak of the gate task "still leased", but nothing leases. `assignment_prompt` hard-codes `lease_s = budget.max_wall_s`.
- `reconcile` moves CHANGES_REQUESTED straight on to IN_PROGRESS ("rework loop"), and `dispatchable` re-dispatches IN_PROGRESS tasks with no running session. So the re-claim belongs right after that transition.
- Server reply shapes (`service.ts` on the Phase 11 base): claim `{claimed, node, lease{lease_id, holder, epoch, state, expires_at, expires_in_seconds}, action, evicted, decision, reason}`, with `decision` a verdict string on main and an object `{action, ttl_seconds, …}` in the Phase 11 contract. The parser reads both. Heartbeat `{ok, lease, reason?, ttl_seconds}`. Release `{released, action, reason?, holder?, lease}`. Complete `{completed, …release}`.

</code_context>

<deferred>
## Deferred Ideas

Signed `coord_handoff` packets (Phase 13), per-agent env files and child token stripping (Phase 14), leasing on the in-session `orch_status --ingest` path, REST lease routes (no non-MCP executor in scope).
</deferred>
