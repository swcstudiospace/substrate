# Phase 10: Swarm orchestrate integration - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted (gsd-autonomous). Decisions come from ADR 0001 S1 criteria 3-6 and 8.

<domain>
## Phase Boundary

agent-swarm side of S1. `swarm/runlog.py` `emit()` is the local stand-in for the NATS bus and the single choke point every script emits through, so the tee hangs there. `scripts/orch_plan.py` resolves or mints the Graph ID, binds it and registers the node set. Branch `feat/s1-substrate-tee` from `origin/main`; the scripts it edits are byte-identical on `origin/main` and on PR #4's branch.

</domain>

<decisions>
## Implementation Decisions

- Surface per agent (A01..A15 to `swarm-aNN-xxx`), `session_id = <AGENT>@<replica>:<graph_id>` so a replica working two graphs holds two sessions and the per-session hash chain never interleaves.
- Explicit swarm-type to `EVENT_KINDS` table; unmapped type is a test failure; `swarm_type` rides in the payload; the enum is not widened.
- Dedupe on `(surface, msg_id)` in a 24 h window in a sqlite file under the swarm dir; `runlog.emit` mints `msg_id` into the JSONL record (additive).
- Graph ID order: `--graph-id` > `SUBSTRATE_GRAPH_ID` > Graph ID found in the brief text > minted. Always adopt the binding the server returns.
- Nothing time-varying goes into the hashed brief, so idempotent re-plans still reuse.
- MCP is reached by stateless JSON-RPC over `POST /mcp`; REST `POST /events` carries the tee.

</decisions>

<code_context>
## Existing Code Insights

- The swarm has no substrate client, no `graph_id` and no memory module; `04-integration-plan.md` is design only. An earlier draft of this phase (surface `agent-swarm`, new kinds, `/graph`) was discarded against the ADR.

</code_context>

<deferred>
## Deferred Ideas

Lease bridge (S2), projector (S4), gate verdicts (S5), headless `swarm_run.py` wave summary event.
</deferred>
