# ADR-0003. Lease model and signed handoff foundations for graph coordination (Phase 0.5 base for Phase 2)

- **Status:** accepted
- **Date:** 2026-10-01
- **Deciders:** A03
- **Task:** T-0.5-governance

## Context and Problem Statement

Current graph_claim is simple index write; v0.3/Phase 2 needs single-holder semantics to prevent double work. Leases provide CAS + TTL + heartbeat. Signed handoff packets (not free text) carry goal, files, DoD, blockers, prev_event_hash for replayability and drift detection. Foundations in 0.5 so Phase 2 can implement without re-architecture.

## Decision Drivers

- Prevent double-claim on same node
- Auto-release on steal or expiry
- Replayable handoffs for audit
- Dragonfly or index for lease state (low latency)
- No change to existing claim/release APIs (add fields)

## Considered Options

- Full distributed lock (rejected: overkill for single VPS)
- Pure Postgres advisory (rejected: not shared with Dragonfly path)
- Lease record in index + Dragonfly TTL mirror (chosen)

## Decision Outcome

Chosen option: "Add lease table/Dragonfly key (graph_id:node_id -> holder, expires_at, heartbeat). CAS on claim. On steal emit lease_stolen event. Handoff payload is signed envelope (or at least canonical + hash). Drift scan in later phase.".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

Extends graph model in index (add leases). substrate-mcp graph_claim now returns lease info. Affects dispatcher in Phase 2. Runbooks for lease steal. Compatible with v0.2 (old claims have no lease, treated as eternal until release).
