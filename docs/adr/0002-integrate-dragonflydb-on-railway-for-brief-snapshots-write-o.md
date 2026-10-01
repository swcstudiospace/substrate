# ADR-0002. Integrate DragonflyDB on Railway for brief snapshots, write outbox and circuit breakers

- **Status:** accepted
- **Date:** 2026-10-01
- **Deciders:** A03
- **Task:** T-0.5-governance

## Context and Problem Statement

Phase 0 uses direct Greptime for events and Postgres for index. v0.3 needs degraded mode when stores are slow or down (fail-open for agents). Dragonfly provides fast in-memory snapshot for briefs, outbox for queued writes, and simple circuit breaker state. Must be private/Tailscale only like other Railway backing stores.

## Decision Drivers

- Brief p95 <800ms even on store latency
- Degraded mode without losing events
- Outbox for exactly-once memory writes
- Low complexity (ioredis compatible)
- Existing Railway account pattern

## Considered Options

- Redis on VPS (rejected: disk at 90%, no HA)
- In-process cache only (rejected: no shared degraded across agents)
- Dragonfly on Railway (chosen)

## Decision Outcome

Chosen option: "Add DRAGONFLY_URL to substrate.env; client in mcp-server for snapshot (graph_id -> brief json with ttl), outbox (queue writes when primary down), breaker state. Snapshot served from Dragonfly on brief path with fallback to recompute. Update smoke tests.".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

New dep on ioredis or dragonfly client (boring, already common). Config in projector/substrate.yaml. New env var documented. Runbook for Dragonfly outage. No change to Greptime schema or v0.2 event paths. Enables Phase 1 scale.
