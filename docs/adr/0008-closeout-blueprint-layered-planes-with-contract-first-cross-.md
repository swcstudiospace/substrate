# ADR-0008. Closeout blueprint: layered planes with contract-first cross-repo and reconcile surfaces

- **Status:** accepted
- **Date:** 2026-11-19
- **Deciders:** A03
- **Task:** Tfb6b-arch

## Context and Problem Statement

The closeout must bind A02 NFRs and 20 acceptance criteria to an implementable boundary without inventing APIs; contract-first ordering prevents integration surprise across A05, A06 and A07

## Decision Drivers

NFR-P1 p95 below 1500 ms at 50 rps; NFR-S1 zero plaintext proofs; NFR-C1 schema validation plus redaction with zero persist-on-invalid rows; 15-repo dry-run evidence; DoD-gated tracker flips

## Considered Options

- Bare MCP tool surface without a versioned contract
- single monolith service bypassing planes

## Decision Outcome

Chosen option: "Adopt the documented layered-plane blueprint and the versioned closeout contract as the boundary for phases 71, 74, 78 and gaps 66-68".

### Positive Consequences

- A05, A06 and A07 implement against one versioned contract (1.0.0) with pinned digests; NFR budgets are measurable clauses, not prose.
- Fitness functions (layering, cycles, fan-out budget 6) run in CI and block merges on violation.
- The closeout stays edit-only: no live Railway writes, no deploys, no hook or timer installs.

### Negative Consequences

- The contract is an additional artefact to keep in sync with `server.ts` routes and MCP tools; a change without a contract bump is a violation.
- The gateway fans out to six planes (budget 6), so a single-plane outage must degrade rather than block the prompt path.

## Consequences

Non-breaking additive contract 1.0.0; fitness functions guard layering and coupling; no live writes
