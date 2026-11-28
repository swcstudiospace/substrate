# Phase 86: E5 observability loop plus E8 session replay and audit - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

E5 observability loop (correlation IDs across Timescale/Greptime/Dragonfly; dashboards + burn alerts) + E8 session replay/audit (append-only steering/action audit; replay to checkpoint; summary → Notion/Linear read-only post-hoc). Final Wave-8 phase — closes the milestone.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Correlation propagation**: `correlationId` (graph/request id) threaded through `service` plane calls into Timescale/Greptime/Dragonfly reads; emitted on `healthz`/logs (redacted, no PII/secrets).
- **Burn alerts**: SLO burn detector over Greptime `agent_events` error/timeout histograms (existing `evaluatePlanes` + observability instruments); alert when burn > threshold — pure function, testable with fakes.
- **E8 replay**: replay reads append-only ledger events (hash chain verify via existing `carriedEvent`/`verify` path) and re-applies steering actions up to a checkpoint; replay is read-only and never mutates the ledger.
- **Post-hoc summary**: replay summary is emitted as a ledger note and mirrors to Linear/Notion via existing reporters (read-only, never source of truth).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `observability` instruments (`evaluatePlanes`, histogram gauge), `carriedEvent`/`verifyAnchor` hash-chain path, `anchor-run.ts`, ledger query surfaces, Phases 80-85 outputs (gate verdicts feed burn inputs)

### Established Patterns
- Pure builders over facts (fabric), hash-chain integrity, redaction on every write; strict TS; fake-only tests

### Integration Points
- `healthz` burn field (body-only), replay CLI `substrate session replay`, summary mirror via existing handoff reporters
- Consumes Phase 81 gate verdict + Phase 83 registry for replay checkpoints

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/enhancement-design.md` E5/E8 rows, `.planning/execution-plan.md` Lane F (correlation IDs, dashboards/alerts; append-only audit with replay-to-checkpoint).

</specifics>

<deferred>
## Deferred Ideas

None — this is the milestone-closing phase.

</deferred>
