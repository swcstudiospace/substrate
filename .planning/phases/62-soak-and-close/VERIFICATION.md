---
phase: 62-soak-and-close
verified: 2026-10-26
status: passed
score: 3 of 3 success criteria MET as written; the soak is a simulation, and the milestone is not completed (operator decision)
verified_on: gsd/v16-int at 8752578 (soak tests 8752578; ADRs 0004 to 0007 and docs/ussr-integration.md a8346f7)
---

# 62-VERIFICATION: Soak, runbooks and v1.6 close

## Gates

Not run by the author of this record. The orchestrator's gate count for `gsd/v16-int` at 8752578 (7505 pass, 2 skip, 0 fail; audit gate 0 unlisted high or critical; `check:phase-close` pass; config-reference check pass) includes the soak tests, which are committed in 8752578. The orchestrator measured the two soak files at about 65 seconds together.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A simulated multi-day run with injected clocks shows bounded memory and handle counts and a clean resume after a restart and after a store failover | MET (simulation) | Ran in the orchestrator's final gate at 8752578: 7505 pass, 0 fail, the two soak files passing (14 tests, about 65 seconds together). The first run failed one test (the retain outbox outage never reached its bound, so the queue-full drop path went unexercised); the fixture was corrected to a bound of 100 so both drop paths run, and typing errors in the soak files were fixed before that. `packages/mcp-server/src/soak-multiday.test.ts` (`describe("a 72 hour session on injected clocks")`: caps checked after every simulated hour, a two-hour tripwire, six service and CLI rebuilds over the same stores, a 182-minute ledger outage; `describe("the Hindsight plane down during a rollback")`, `describe("the memory index down during a rollback")`, `describe("a checkpoint recorded late")`, `describe("the retain outbox over 72 hours")`, `describe("the RAG state machine over 72 hours")`, `describe("the soak notices what it is built to notice")`); `packages/cli/src/session/soak.test.ts` (44 real checkpoints over 73 simulated hours, a three-hour-and-twenty-minute outage, three process restarts, restores killed mid-way and completed on the next run). The soak found one production defect (the retain-drain interval never cleared, fixed in 901c58f). "Store failover" is modelled as a store going down and returning, not a switch to a second instance; a simulation does not prove behaviour over real days against real stores. |
| 2 | Runbooks exist for migration rehearsal, LightRAG hosting, a chain outage and a devnet reset, rollback, and signer key rotation; decision records exist for store roles, rollback semantics and memo-only anchoring | MET | Runbooks: `docs/runbooks/index-migration-rehearsal.md`, `lightrag-storage-topology.md`, `anchor-chain-outage.md`, `devnet-reset-and-reanchor.md`, `session-rollback.md`, `anchor-signer-rotation.md` (also `consistency-verify.md`, `memory-capsules.md`). Decision records: `docs/adr/0004-store-roles.md`, `0005-rollback-semantics.md`, `0006-memo-only-anchoring.md` (and `0007-checkpoint-triggers-and-sibling-hooks.md`), listed in `docs/adr/README.md`. ADRs 0004 to 0007 were committed in a8346f7. |
| 3 | `STATE.md` and `ROADMAP.md` reflect every phase, and the milestone audit is written | MET | `.planning/ROADMAP.md` (phases 55 to 62: Status, Plans and progress rows), `.planning/STATE.md` (Run 8 outcome), `.planning/REQUIREMENTS.md` (SOTA-11 to SOTA-18), `phases/55-migration-safety` to `phases/62-soak-and-close` (CONTEXT, SUMMARY, VERIFICATION), `.planning/v1.6-MILESTONE-AUDIT.md`. Written by the same unit that is verifying it; the documents tests (event-sources, vocabulary-lock, config-reference, docs golden) are the orchestrator's check that the edited docs still pass. |

## Residual risks

- The soak simulates days on injected clocks and fakes; it proves bounded structures and clean resume in-process. It does not prove production behaviour under real clocks, real stores or real load.
- The soak tests are long (about 65 seconds together) and raise the default timeout in their files; a slow CI host could time them out.
- The soak covers the stores going down and returning. A failover between two instances of a store was not simulated.
- ADRs 0004 to 0007 and `docs/ussr-integration.md` describe sibling repositories from reading them; no sibling was edited and nothing there was run.
- ROADMAP statuses are the author's reading of the evidence at the time; the milestone audit lists the operator-gated items that remain.

## Operator-gated

Completing and archiving the milestone (irreversible); merging any branch; every live step listed in `.planning/v1.6-MILESTONE-AUDIT.md`.
