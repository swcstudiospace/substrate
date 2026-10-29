---
phase: 62-soak-and-close
verified: 2026-10-28
status: passed
score: 3 of 3 success criteria MET in the repository (criterion 1 with fakes; the soak is a simulation, and the milestone is not completed by operator decision)
verified_on: main at 31a9bb36 (files read; nothing was run)
---

# 62-VERIFICATION: Soak, runbooks and v1.6 close

## Gates

Not run by the author of this record. The full gate (frozen install, tsc with the strict flags, blocking Biome lint, the full bun test suite against a scratch Postgres, the Python suites, the repo locks) runs in CI on main, and the orchestrator records the run in `.planning/STATE.md`. This record's evidence is file paths and test titles read on main at 31a9bb36; nothing was executed. No test counts or CI numbers are invented here.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A simulated multi-day run with injected clocks shows bounded memory and handle counts and a clean resume after a restart and after a store failover | MET (with fakes) | Server soak `packages/mcp-server/src/soak-multiday.test.ts` over `packages/mcp-server/src/soak.testkit.ts` (`CAPS`, `SoakClock`, `SoakLedger` over `FakeLedger`, `SoakIndex` over `FakeIndex`, `SoakRedis`, `SoakRpc`/`SoakChain`): `describe("a 72 hour session on injected clocks")` > `test("stays bounded, leaves no handle, and resumes cleanly after restarts and a ledger failover", ...)` (caps checked after every simulated hour, six rebuilds over the same stores, a ledger outage), plus `describe("the retain outbox over 72 hours")` > `test("a plane outage fills it only to its bound, every parked retain is accounted for, and recovery empties it", ...)` and `describe("the soak notices what it is built to notice")` > `test("a queue that never drains, a cap that is one too low and a leaked timer are all reported", ...)` (the leak tripwire). CLI soak `packages/cli/src/session/soak.test.ts`: `describe("a multi-day session on a real git worktree")` > `test("keeps its journal bounded, delivers exactly once after an outage, and resumes cleanly after restarts and crashes", ...)`. Last touched by 8752578/f8c319cc; no later commit changed them. "Failover" is modelled as each store going down mid-operation and coming back (ledger, Hindsight plane, index, Solana), not a switch to a second instance. |
| 2 | Runbooks exist for migration rehearsal, LightRAG hosting, a chain outage and a devnet reset, rollback, and signer key rotation, and decision records exist for store roles, rollback semantics and memo-only anchoring | MET | Runbooks, each substantive (9-29 KB, real procedures read): `docs/runbooks/index-migration-rehearsal.md`, `lightrag-storage-topology.md`, `anchor-chain-outage.md`, `devnet-reset-and-reanchor.md`, `session-rollback.md`, `anchor-signer-rotation.md` (plus `consistency-verify.md`, `memory-capsules.md`). Decision records: `docs/adr/0004-store-roles.md`, `0005-rollback-semantics.md`, `0006-memo-only-anchoring.md`, `0007-checkpoint-triggers-and-sibling-hooks.md`, all listed in `docs/adr/README.md`, plus `docs/ussr-integration.md`. ADR 0007 re-read on this tree: it was extended after phase 62 by PR #147 (23ced3cb: the steering checkpoint hint, `checkpoint_hint` only when the session state actually moved, one state model with `docs_steering_session`) and PR #148 (47bdcd35, in this tree's history: the trigger policy, `substrate session hook` entry points for `turn`/`plan-step`/`steering`/`baseline` with rate limits, and printed `hook-config`); sibling hooks remain proposals, no sibling repository changed. |
| 3 | `STATE.md` and `ROADMAP.md` reflect every phase, and the milestone audit is written | MET | `.planning/ROADMAP.md`: Phase 62 section (goal, status, dependencies, SOTA-18, the three success criteria, merged as PR #130 on 2026-10-28) and the progress-table row; v1.6 phases 55-62 rows present. `.planning/STATE.md`: v1.6 definition and outcome recorded (Run 8: built on `gsd/v16-int`, shipped as PRs #127-#130 and #137; per-phase outcomes; open operator decisions), and the merged-stack record (PRs #127-#130, #132-#137 merged; #109-#111, #131 closed with pointers). `.planning/v1.6-MILESTONE-AUDIT.md` exists (104 lines: verdict, per-requirement table with SOTA-18 satisfied as written, gates, operator-gated live steps). |

## Residual risks

- The soak simulates days on injected clocks and fakes; it proves bounded structures and clean resume in-process. It does not prove production behaviour under real clocks, real stores or real load.
- The soak tests are long (about 65 seconds together at the time they were written) and raise the default timeout in their files; a slow CI host could time them out.
- The soak covers the stores going down and returning. A failover between two instances of a store was not simulated.
- ADRs 0004 to 0007 and `docs/ussr-integration.md` describe sibling repositories from reading them; no sibling was edited and nothing there was run. ADR 0007's post-phase extensions (#147, #148) belong to phases 58 and 61 respectively; they strengthen the record phase 62 cites but do not change what phase 62 itself delivered.
- The milestone audit's header still describes the v1.6 work as five unmerged draft PRs; the merge to main (PRs #127-#130, #137) is recorded in ROADMAP.md and STATE.md but the audit text was not refreshed. Read the audit for its per-requirement evidence, not its merge status.
- ROADMAP and STATE statuses are the authors' reading of the evidence at the time; gap closure for the v1.6 partial criteria of phases 58, 59 and 61 is in progress elsewhere and does not affect this phase's criteria.

## Operator-gated

Completing and archiving the milestone (irreversible); merging any branch; every live step listed in `.planning/v1.6-MILESTONE-AUDIT.md` (a LightRAG deploy, anchor funding and the anchor timer, any devnet send, production migrations). None is required by this phase's goal: the phase deliberately ships a simulation, documents, and an audit, and leaves completion to the operator.
