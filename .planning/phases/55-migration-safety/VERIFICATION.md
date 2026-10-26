---
phase: 55-migration-safety
verified: 2026-10-26
status: passed
score: 5 of 5 success criteria MET in the repository; none needs a live system
verified_on: gsd/v16-int at 979b5e2 (phase commits f71cc1b, e8dbe52)
---

# 55-VERIFICATION: Migration safety, session event vocabulary and the v1.6 baseline

## Gates

Not run by the author of this record. The orchestrator's gate numbers, run against a throwaway Postgres 16 so the live-database tests ran: `gsd/v16-int` at 979b5e2 had 7480 pass, 2 skip, 0 fail; the audit gate 0 unlisted; `bun run check:phase-close` pass; the config-reference check pass. The two skips are existing tests unrelated to this milestone. Evidence below was read from the files and test names; nothing was re-run.

## Success criteria

| # | Criterion (ROADMAP, Phase 55) | Status | Evidence |
|---|---|---|---|
| 1 | An offline contract test fails any step that is not idempotent, that drops, renames or retypes an object, or whose text changed after it was applied (frozen digests) | MET | `packages/mcp-server/src/index-store.migrate-contract.test.ts`: `describe("rule (a): idempotence")`, `describe("rule (b): no destructive statement")`, `describe("digest rule")` with `"an edited applied step fails"`, `"a removed step still has a digest in the fixture and fails"`; the real steps are checked in `describe("the real MIGRATION_STEPS satisfy the contract")`; fixture `index-store.migrations.digests.json` (32 steps) made by `scripts/migration-digests.ts`. Commit e8dbe52. |
| 2 | A fake-connection harness proves lock before DDL, one transaction per step, rollback with no ledger row, zero DDL on a re-run, and resume from a partial ledger | MET | `index-store.migrate-harness.test.ts`: `"the lock is taken before any DDL and released after the last statement"`, `"each step is its own transaction: ledger insert between its DDL and its COMMIT, never across steps"`, `"a failing step rolls back, inserts no ledger row, rethrows, and still releases the lock"`, `"a second run over a fully ledgered state issues no DDL, transaction or ledger write"`, `"a partially ledgered state (1..k) applies exactly k+1..N, in order"`. |
| 3 | A rollback-compat test fails when a step added after the reference release is not additive or not listed in the runbook | MET | `rollback-compat.test.ts`, `describe("index (Postgres) migration steps added since the 9231f43 reference release")`: `"every step added since is additive..."`, `"every step added since is named in docs/runbooks/rollback-compat.md"`, and the fail-before tests `"the additive rule fires..."` and `"the runbook rule fires..."`. The runbook row was corrected (it was wrong; see SUMMARY). |
| 4 | `session.checkpoint`, `session.rollback`, `session.rollback.refused` exist as `note` and `warning` events with validated builders; `bun run check:phase-close` passes with EVENT_KINDS 12 and SURFACES 42 | MET | `packages/mcp-server/src/session-events.ts` and `session-events.test.ts` (`describe("CheckpointPayload")`, `"RollbackPayload"`, `"RefusedPayload"`, `"the 16000-byte ledger cap"`, `"idempotency keys"`, `"the EVENT_SOURCES rows for these events"`); rows in `event-sources.ts` and `docs/event-vocabulary.md`, which `event-sources.test.ts` compares. `check:phase-close` pass is the orchestrator's gate result. No kind and no surface was added. |
| 5 | An operator rehearsal runbook exists and every production step in it is marked operator-run | MET | `docs/runbooks/index-migration-rehearsal.md` (header: every step against production is HARD_STOP, nothing runs it automatically). |

## Residual risks

- The rehearsal itself was never run against a production-shaped database; the runbook is untested against the live Timescale image (it says the index uses no Timescale features). Operator-run.
- Production has no migration ledger before the first `migrate()`; the first run replays every idempotent step. The playbook exists; the run does not.
- The `down` convention is enforced only through synthetic lists until a step at or above the first reversible version exists (none is on `gsd/v16-int`).
- Step 33 is reserved by an unmerged draft; phase 58 adds step 34 on its own branch. Merge order across those branches decides the final numbering and is an operator decision.

## Operator-gated

Production index migrations and the rehearsal run.
