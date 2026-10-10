---
phase: 29-agent-cards-and-teachable-moments
plan: "02"
subsystem: agent-cards
tags: [a2a, agent-card, http-route, skills]

requires:
  - phase: 29-agent-cards-and-teachable-moments
    provides: teachable corpus + accepted-event emit (29-01)
provides:
  - agent-card.ts builder + UNVERIFIED-marked validator
  - fixture cards (valid + per-violation + stub-shape rejection)
  - Substrate.teachablesForSurface reader
  - GET /.well-known/agent-card.json loopback route
affects: [29-03 (card e2e + docs over this route and builder)]

actuals:
  tasks: 3
  commits: 1

key-files:
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/server.ts
  created:
    - packages/mcp-server/src/agent-card.ts
    - packages/mcp-server/src/agent-card.fixtures.ts
    - packages/mcp-server/src/agent-card.test.ts

key-decisions:
  - "Card url is the relative loopback path (builder is pure: no config); tests pin relative shape, not host"
  - "capabilities { streaming: false, pushNotifications: false }, interfaces ['http'], modes ['text'] — honest loopback values, UNVERIFIED-in-code until G1"
  - "Route tests live in agent-card.test.ts over a real listener (server.test.ts untouched); reader tested against a prefix-honouring stub"

requirements-completed: [CARD-01, CARD-02]

coverage:
  - id: 29-02-T1
    description: "Builder emits validator-clean cards; validator catches every CARD-01 field absence including the stub shape; fold collisions suffixed"
    requirement: "CARD-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/agent-card.test.ts — builder + validator blocks"
        status: pass
    human_judgment: false
  - id: 29-02-T2
    description: "Reader returns exactly the surface's live teachable facts, newest first; superseded/warning/plain/other-surface excluded"
    requirement: "CARD-02"
    verification:
      - kind: unit
        ref: "agent-card.test.ts teachablesForSurface block over prefix-honouring stub"
        status: pass
    human_judgment: false
  - id: 29-02-T3
    description: "200 validator-clean card (taught + untaught), 400s on missing/unknown surface, anonymous 200"
    requirement: "CARD-01"
    verification:
      - kind: integration
        ref: "agent-card.test.ts route block over real HTTP listener; server/http suites green"
        status: pass
    human_judgment: false
---

# Phase 29 Plan 02: Agent Card builder plus loopback route Summary

Per-surface A2A v1.0 cards (repo-documented field set) whose `skills[]` list
accepted teachables, with a fake spec validator, fixture cards, the
`teachablesForSurface` reader, and the GET route. CARD-01 in full and CARD-02's
card half.

## Tasks

| # | Name | Commit | Result |
|---|------|--------|--------|
| 1 | Card builder, fake validator, fixture cards | 3eacfae | Builder + 17-row corpus, stub shape pinned rejection |
| 2 | Teachables reader on Substrate | 3eacfae | Prefix search, live facts only, newest-first |
| 3 | GET /.well-known/agent-card.json route | 3eacfae | 200/400s + anonymous discovery, 5 route cases green |

## Verification evidence

- `bun test agent-card.test.ts`: 18 pass, 0 fail (card e2e lands under 29-03)
- `bun test server.test.ts http.test.ts service.test.ts`: 316 pass (no regressions)
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — locks unchanged

## Deviations from Plan

None — plan executed exactly as written. The `/agents/<surface>/` alias route
was not added (executor-discretion nice-to-have; single canonical route kept).
Validator is marked UNVERIFIED-in-code pending OPERATOR-GATED G1; the executor
did not fetch the spec.

## OPERATOR-GATED note (marker only, never executed)

Real spec validation (G1) and any card publication beyond loopback (G2) are
operator windows documented in plan 29-03.
