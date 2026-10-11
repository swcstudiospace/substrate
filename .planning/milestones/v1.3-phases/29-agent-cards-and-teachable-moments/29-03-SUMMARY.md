---
phase: 29-agent-cards-and-teachable-moments
plan: "03"
subsystem: agent-cards
tags: [anchor-coverage, card-e2e, docs, g1-g2-g3]

requires:
  - phase: 29-agent-cards-and-teachable-moments
    provides: teachable emit + corpus (29-01), card builder + route (29-02)
provides:
  - scratch-ledger + fake-RPC anchor coverage proof
  - session → card end-to-end assertion
  - docs/agent-cards.md with G1/G2/G3 live map
affects: [phase-close evidence, 29-VERIFICATION.md operator gates]

actuals:
  tasks: 3
  commits: 1

key-files:
  modified:
    - packages/mcp-server/src/agent-card.test.ts
  created:
    - packages/mcp-server/src/teachable-anchor.test.ts
    - docs/agent-cards.md

key-decisions:
  - "Fake pubkey wired through the config object, never a SOLANA_* env name: no keypair, no RPC override, injected read-back, no CLI, no network"
  - "Tamper case mutates a decoy event from another graph in the same hour and re-hashes it: whole-hour coverage breaks while the teachable chain stays intact"
  - "Card e2e extends agent-card.test.ts on the same scratch shape; no new fixtures beyond the 29-01/29-02 corpus"

requirements-completed: [CARD-03, CARD-04]

coverage:
  - id: 29-03-T1
    description: "Scratch proof: teachable event inside a verify-reported anchored hour; tamper fails naming the hour"
    requirement: "CARD-03"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/teachable-anchor.test.ts — 2 cases, scratch ledger + fake RPC"
        status: pass
    human_judgment: false
  - id: 29-03-T2
    description: "Session teachable appears in its surface's card only, validator-clean"
    requirement: "CARD-04"
    verification:
      - kind: integration
        ref: "agent-card.test.ts card end-to-end block over scratch Substrate"
        status: pass
    human_judgment: false
  - id: 29-03-T3
    description: "Docs record convention, route, coverage argument, and the unexecuted G1/G2/G3 live map"
    requirement: "CARD-04"
    verification:
      - kind: static
        ref: "docs/agent-cards.md; bunx tsc + check:phase-close green"
        status: pass
    human_judgment: false
---

# Phase 29 Plan 03: Anchor proof, card e2e, docs Summary

Anchor coverage proof (isolated) and docs: every teachable covered by the
hourly anchor, CARD-04's in-repo half closed without touching devnet, the
spec, or loopback-external publication.

## Tasks

| # | Name | Commit | Result |
|---|------|--------|--------|
| 1 | Teachable anchor-coverage proof test | 7d4324e | Anchored hour + tamper-mismatch, both green |
| 2 | Card end-to-end assertion | 7d4324e | Session → card leg green on scratch |
| 3 | Docs and OPERATOR-GATED live map | 7d4324e | `docs/agent-cards.md` with G1/G2/G3 + rollbacks |

## Verification evidence

- `bun test teachable.test.ts teachable-anchor.test.ts agent-card.test.ts server.test.ts service.test.ts memory-write.test.ts event-sources.test.ts`: 438 pass, 0 fail
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27

## Deviations from Plan

None — plan executed exactly as written. Two execution notes (not scope
changes): the fake pubkey is wired through the config object rather than a
`SOLANA_*` env name (same precedent as the Phase 28 hour-report tests, zero
chain interaction), and the tamper case re-hashes the altered decoy so the
whole-hour digest — which covers leaf hashes — actually sees the alteration.

## OPERATOR-GATED live map (recorded verbatim — never executed)

- G1: real spec validation against the published A2A spec.
- G2: any real card publication endpoint beyond loopback.
- G3: live teachable-anchor coverage proof on devnet-backed hours.
