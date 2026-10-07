---
phase: 10-swarm-orchestrate
plan: 01
one-liner: "The swarm's run log reaches the substrate ledger under one Graph ID per run, attributed to the emitting agent, deduped and fail-open; orch_plan mints, binds and registers the graph."
subsystem: agent-swarm substrate tee
tags: [s1, event-tee, graph-id, agent-swarm, fail-open]
provides:
  - runlog.emit tee to POST /events with additive msg_id
  - exhaustive 13-type swarm-type -> EVENT_KINDS table with AST emit-site scan
  - per-agent surfaces swarm-aNN-xxx and session <AGENT>@<replica>:<graph_id>
  - (surface,msg_id) 24 h dedupe and correlation -> Graph ID cache
  - Graph ID minting ut-<ts36>-<8hex>, graph_bind (server winner adopted), graph_register in orch_plan
key-files:
  created: []
  modified:
    - swarm/runlog.py
    - scripts/orch_plan.py
key-decisions:
  - Tee hangs on runlog.emit, the single choke point; runs after the local write
  - swarm_type rides in the payload; EVENT_KINDS not widened
  - Graph ID order --graph-id > SUBSTRATE_GRAPH_ID > brief > mint; always adopt the server's binding
  - Stdlib client, 1.5 s timeout, outage back-off, fail-open
  - No POST /graph, no single agent-swarm surface, no new event kinds (ADR 0001); earlier draft with them discarded
completed: 2026-10-07
status: complete
---

# 10-01 Summary

PR agent-swarm #5, branch `feat/s1-substrate-tee`, commit `2efce2f` plus review fixes. Pairs with agent-substrate #11 (Phase 7). Merged 2026-10-07 as bd5494b after four Greptile rounds.

## Delivered
- `runlog.emit` mints `msg_id` (additive JSONL field) and tees each record after the local write.
- Table maps 13 types: `plan.updated`, `task.transition`, `task.result.raw` -> note; `task.claimed` -> claim; `gate.verdict.unrecorded`, `gate.findings.coerced`, `gate.findings.synthesized`, `gate.findings.unattributed`, `task.result.rejected`, `escalation.request`, `security.dev_key` -> warning; `script.<name>`, `script.<name>.error` -> tool.call. AST scan of every emit site.
- A01..A15 -> `swarm-aNN-xxx`; `session_id` `<AGENT>@<replica>:<graph_id>`; dedupe `(surface,msg_id)` 24 h; correlation -> Graph ID cache; repo slug from origin remote.
- `orch_plan` resolves/mints, binds via `graph_bind` adopting the winner, registers the node set; re-plans reuse.

## Evidence
- Full pytest passes; `build_agents`/`build_trae_agents --check` up to date; `bun test tests/ts` passes; ruff: only the two pre-existing E401 in `tests/test_uplift_harness.py` (also on origin/main).
- Live `/tmp/s1-live-smoke.sh`: 24/24 checks. orch_plan on a scratch repo (origin `https://github.com/acme/scratch.git`) bound a Graph ID (e.g. `ut-muy71rn1-ff2a90b4`), registered 13 nodes under `acme/scratch`, surface `swarm-a01-orch`, status planned; 3 events in the ledger as `swarm-a01-orch`, session `A01@r0:<graph>`, payload `swarm_type` and `msg_id`, working prev chain; `events_verify` `{ok:true, events:3}`; re-plan reused, one binding row; substrate stopped -> orch_plan exit 0 in under 1 s; no token leaked into swarm output.

## Review hardening (merged)
- 85fb713: the bearer is never sent across a redirect; per-surface token override for gate children; whole-request time bound; dry runs never tee; binding cache keyed by server; pending/sent dedupe so a killed send can retry; indexed, rate-limited prune.
- 5e794e0 and e93a29e: one transport seam with a caller-side deadline over DNS, connect, headers and body; sockets shut down at the deadline; at most 4 lingering workers; redirects not followed; HTTP_PROXY / HTTPS_PROXY / NO_PROXY honoured.
- 341917c: a failing or oversized error body backs off like a network failure.

## Deviations
None from the plan.
