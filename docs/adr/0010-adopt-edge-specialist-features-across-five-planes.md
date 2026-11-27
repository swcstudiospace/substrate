# ADR-0010. Adopt edge specialist features across five planes

- **Status:** accepted
- **Date:** 2026-11-25
- **Deciders:** A03
- **Task:** T413b-arch

## Context and Problem Statement

Spec US-12..US-18 selects 7 edge features (F1 Timescale hypertables, F2 continuous rollups, F3 Greptime compression/downsampling, F4 ledger analytics pushdown, F5 Dragonfly ordered event log, F6 Hindsight causal recall, F7 LightRAG+TEI hybrid) bound to AC-23..AC-29 and phases 71/77/78, 66/78, 46/66/76, 76/78, 66/67/75, 61/66, 46/63-66/70. Existing store roles (docs/data-planes.md) forbid queues/locks in Dragonfly and require plain tables today; hypertables/compression/continuous aggregates are new capabilities behind flags, not topology changes.

## Decision Drivers

NFR-P2 docs_search p95 <2000ms + 0.2doc/s; NFR-S2 0 persist-on-invalid; AC-23..AC-29 numeric budgets (30d, 60s, 1%, 20%, 80%, 50/50, 0.6)

## Considered Options

- Plain tables + full scans for all history
- client-side analytics for burn
- naive-only retrieval

## Decision Outcome

Chosen option: "Adopt F1-F7 edge specialist features mapped per store with hand-in-hand phase bindings".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

Timescale hypertables scoped to time-ordered graph history only; Greptime downsampling keeps 30d raw fidelity; Dragonfly remains cache/read-through with wake-up hints, never authoritative; TEI model pinned BAAI/bge-small-en-v1.5; flags default off until A08 measures
