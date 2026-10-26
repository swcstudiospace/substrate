---
phase: 62-soak-and-close
milestone: v1.6
requirements: [SOTA-18]
discussed: 2026-10-26
status: written; completing and archiving the milestone is an operator decision and was not done
---

# 62-CONTEXT: Soak, runbooks and v1.6 close

## Goal

The milestone is proven for sessions that run for days and is documented for operation. The roadmap block is ROADMAP.md, Phase 62.

## Locked decisions

- **Documents and tests only.** This phase adds no behaviour: a simulated multi-day run on injected clocks, the runbooks and decision records the earlier phases needed, and the milestone audit.
- **Simulation, not a real multi-day run.** Time is an injected clock and Bun's system time, nothing sleeps, no network is touched, and the only randomness is seeded. A real multi-day soak against production is not part of this phase.
- **The milestone is not completed.** `gsd-complete-milestone` is irreversible, archives the open v1.5 phases' directories and is held for the operator (STATE.md, Run 7 and Run 8). The audit says what is done and what is operator-gated; it does not mark anything complete.
- **STATE.md and ROADMAP.md are written by hand.** `gsd-new-milestone` was not run because it would reset STATE.md and archive the open v1.5 phase directories.
- **No sibling repository is edited.** ADR 0007 and `docs/ussr-integration.md` describe how Ultrathink, Swarm, Realm and omp would use v1.6; hooks are proposals in this repository.

## Links

- Soak: `packages/mcp-server/src/soak-multiday.test.ts`, `packages/mcp-server/src/soak.testkit.ts`, `packages/cli/src/session/soak.test.ts`
- Runbooks: `docs/runbooks/{index-migration-rehearsal,lightrag-storage-topology,anchor-chain-outage,devnet-reset-and-reanchor,session-rollback,anchor-signer-rotation,consistency-verify,memory-capsules}.md`
- ADRs: `docs/adr/0004-store-roles.md`, `0005-rollback-semantics.md`, `0006-memo-only-anchoring.md`, `0007-checkpoint-triggers-and-sibling-hooks.md`; `docs/ussr-integration.md`
- Audit: `../../v1.6-MILESTONE-AUDIT.md`
- Discovery: `../55-migration-safety/CONTEXT.md`
