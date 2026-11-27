# ADR-0011. Extend closeout contract to 1.1.0 for F1-F7 interoperability

- **Status:** accepted
- **Date:** 2026-11-25
- **Deciders:** A03
- **Task:** T413b-arch

## Context and Problem Statement

v2 spec adds US-11..US-19 and AC-21..AC-31 (10 Linear-issue proposals, 20+ sub-issues, 0 creates before approval; 7 NFRs). Contract must expose F1-F7 boundaries before A05/A06/A07 claim tasks, with measurable NFR clauses and digest pinning.

## Decision Drivers

NFR-P2, NFR-S2, NFR-A1, NFR-I1 newly allocatable; AC-21/AC-22 gated tracker proposals; arch_semver_bump minor compliant

## Considered Options

- Breaking major bump
- separate F1-F7 contract file

## Decision Outcome

Chosen option: "Extend contracts/substrate-closeout-1.0.0.json to 1.1.0 with 7 additive F1-F7 operations, no change to the 6 existing operations".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

Additive minor; breaking check clean vs 1.0.0 base; N-1 window honours 1.0.0 until 1.2.0 lands; consumers A05/A06/A08 pin to new digest
