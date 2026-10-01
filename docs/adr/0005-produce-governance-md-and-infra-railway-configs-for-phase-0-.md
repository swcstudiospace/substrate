# ADR-0005. Produce governance.md and infra/railway configs for Phase 0.5 (additive)

- **Status:** accepted
- **Date:** 2026-10-01
- **Deciders:** A03
- **Task:** T-0.5-governance

## Context and Problem Statement

No current docs/governance.md. infra/railway/ empty. Need canonical place for policy YAML example, apps wiring matrix, runbooks pointers, C4 context for governance plane. Must be additive to v0.2 (greptime-ledger.md etc). Use MADR ADRs + governance.md as single writer artifacts.

## Decision Drivers

- 3-5 ADRs as required
- Clear policy YAML example in docs
- Apps list + integration points
- Update .planning/PROJECT.md if dups
- infra/railway/ as proposal (not live env change per A11)
- Boring production: YAML, simple RBAC, ioredis, existing MCP

## Considered Options

- Only in Notion (rejected: repo must be self-describing)
- Inline in README (rejected: too long, needs dedicated)
- docs/governance.md + ADRs + minimal railway yamls (chosen)

## Decision Outcome

Chosen option: "Write docs/governance.md with policy example, architecture diagram (mermaid), apps matrix. Scaffold 5 ADRs. Clean any PROJECT dups. Create infra/railway/substrate-governance.yaml and dragonfly-client.example as templates (no secrets, propose via A11 for actual).".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

New file docs/governance.md (consumed by A15). ADR set under docs/adr. infra/railway/ gets templates only. .planning/PROJECT.md updated for v0.3 governance refs if needed. Contract checks pass (no new API contracts yet). L2 decision.
