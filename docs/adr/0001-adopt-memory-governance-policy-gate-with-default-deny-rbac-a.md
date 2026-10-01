# ADR-0001. Adopt memory governance policy gate with default-deny RBAC and quarantine for Phase 0.5

- **Status:** accepted
- **Date:** 2026-10-01
- **Deciders:** A03
- **Task:** T-0.5-governance

## Context and Problem Statement

v0.2 memory.write is open; v0.3 requires enterprise controls before scaling agents and apps. Policy must be enforced at substrate-mcp before any write to shared memory. Quarantine instead of silent drop for auditability. Fail-closed on memory (other agents act on it), fail-open on events.

## Decision Drivers

- Default-deny RBAC (surface x scope x kind)
- Provenance + trust decay
- Exactly-once via idempotency
- No breaking v0.2 planes (additive gate)
- Performance: policy cache in Dragonfly

## Considered Options

- Direct allow in every collector (rejected: violates single-writer redaction)
- Postgres row policies (rejected: not for all agents, no Dragonfly path)
- Policy gate in mcp-server (chosen)

## Decision Outcome

Chosen option: "Implement policy YAML loader + gate in mcp memory_write path; return accepted | conflict | quarantined | denied + remedy. Use Dragonfly for policy cache and brief snapshots.".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

Introduces policy.yaml in substrate config. Affects all memory writers. Requires update to projector and substrate.yaml. Quarantine table/audit in index. Runbooks for red/quarantine/lease. No change to existing v0.2 brief/events APIs.
