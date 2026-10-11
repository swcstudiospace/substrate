---
phase: 29-agent-cards-and-teachable-moments
plan: "01"
subsystem: memory-governance
tags: [teachable, memory-write, events, fixtures]

requires:
  - phase: 28-hourly-anchor-job-and-verify
    provides: hourDigest, verifyGraph hour report, fake-RPC proof pattern
provides:
  - teachable.ts predicate + event builder + TEACHABLE_SUBJECT_PREFIX
  - writeMemory teachable.accepted emit hook
  - teachable fixture corpus (accepted/refused/quarantined/conflict/fold pair)
affects: [29-02 (card builder + reader over the corpus), 29-03 (scratch anchor proof)]

actuals:
  tasks: 3
  commits: 1

key-files:
  modified:
    - packages/mcp-server/src/service.ts
  created:
    - packages/mcp-server/src/teachable.ts
    - packages/mcp-server/src/teachable.fixtures.ts
    - packages/mcp-server/src/teachable.test.ts

key-decisions:
  - "Emit hook awaits with .catch(() => undefined), the auditMemoryWrite precedent: deterministic for tests, never fails the write"
  - "Event subject is the stored entry's full normalised subject; payload keys (not values) match the mapped sample"
  - "New emit tests live in teachable.test.ts over Substrate+FakeStore rather than editing service.test.ts"

requirements-completed: [CARD-02, CARD-03]

coverage:
  - id: 29-01-T1
    description: "Predicate, slug, builder, and fixture corpus with pinned gate outcomes"
    requirement: "CARD-02"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/teachable.test.ts — 108 pass"
        status: pass
    human_judgment: false
  - id: 29-01-T2
    description: "Accepted teachable emits one sample-shaped note; denied/quarantined/conflict/non-teachable emit none; trail failure never fails the write"
    requirement: "CARD-03"
    verification:
      - kind: unit
        ref: "teachable.test.ts writeMemory emit block over Substrate+FakeStore"
        status: pass
    human_judgment: false
  - id: 29-01-T3
    description: "Emitted event deep-matches teachable.accepted sample shape; EVENT_KINDS stays 12, SURFACES unchanged"
    requirement: "CARD-03"
    verification:
      - kind: unit
        ref: "bun run check:phase-close — pass; event-sources + vocabulary-smoke green"
        status: pass
    human_judgment: false
---

# Phase 29 Plan 01: Teachable write path Summary

Teachable write path: the `teachable:` subject convention, the accepted-teachable
event on the existing `note` kind, and the shared fixture corpus. CARD-02's gate
half and CARD-03's emit half — the only new event of the phase.

## Tasks

| # | Name | Commit | Result |
|---|------|--------|--------|
| 1 | Predicate, event builder, fixture corpus | b9ba253 | `isTeachable`/`teachableSlug`/`teachableEvent` + 6-row corpus, all pinned |
| 2 | Emit on accepted writes | b9ba253 | Hook in `writeMemory`, 8 emit cases green |
| 3 | Vocabulary and lock conformance | b9ba253 | Sample-shape test + phase-close green |

## Verification evidence

- `bun test teachable.test.ts`: 108 pass, 0 fail
- `bun test service.test.ts memory-write.test.ts`: 293 pass (no regressions)
- `bun test event-sources.test.ts vocabulary-smoke.test.ts`: green
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27

## Deviations from Plan

None — plan executed exactly as written. (The G3 live proof is a 29-03
operator-gated marker, not work in this plan.)

## OPERATOR-GATED note (marker only, never executed)

The live G3 proof — a production teachable whose hour the timer anchors — is
an operator-approved window documented in plan 29-03.
