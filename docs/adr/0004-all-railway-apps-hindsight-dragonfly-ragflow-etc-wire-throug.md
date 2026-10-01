# ADR-0004. All Railway apps (hindsight dragonfly ragflow etc) wire through substrate governance no silos

- **Status:** accepted
- **Date:** 2026-10-01
- **Deciders:** A03
- **Task:** T-0.5-governance

## Context and Problem Statement

Current apps (hindsight, ragflow, dragonfly, timescale) are direct consumers on Railway. v0.3 SOTA requires unified brief, governed memory, chained events, A2A cards for all. No direct raw access from seats or app workers. Substrate becomes the only door for memory/events/skills/ledger.

## Decision Drivers

- Unified brief across human + bot + app surfaces
- Governance and redaction enforced for app writes too
- Dragonfly shared for snapshots across apps
- A2A Agent Cards for teachable sharing
- No breaking existing app deploys (additive proxies/connectors)

## Considered Options

- Per-app direct substrate client (chosen for boring)
- Sidecar proxy (rejected: extra hop, more failure modes)
- Full re-architecture of each app (rejected: too much change, violates no-silo but overkill now)

## Decision Outcome

Chosen option: "Define substrate integration points per app: hindsight (evidence, llm traces via events), dragonfly (already substrate client for cache), ragflow (docs.search via mcp), timescale/greptimedb (backing only). All use bearer or mcp connector. Add to substrate.yaml and infra/railway. Policy applies to app surfaces (e.g. surface=hindsight-api).".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

New section in docs/governance.md and infra/railway configs. Apps get SUBSTRATE_URL + token. Proxies for some (e.g. ragflow). Evidence in Hindsight from substrate events. Enables cross-app teachables on Solana. No v0.2 plane changes.
