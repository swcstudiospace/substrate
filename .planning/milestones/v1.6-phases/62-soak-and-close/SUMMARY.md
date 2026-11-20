---
phase: 62-soak-and-close
milestone: v1.6
requirements: [SOTA-18]
status: written on gsd/v16-int (soak tests 8752578; ADRs 0004 to 0007 and docs/ussr-integration.md a8346f7); milestone not completed
---

# 62-SUMMARY: Soak, runbooks and v1.6 close

## What was built

- **Server-side multi-day soak** `packages/mcp-server/src/soak-multiday.test.ts` with `soak.testkit.ts` (`CAPS`, a `SoakClock`, a handle tracker, fakes for the ledger, index, Hindsight plane, cache and Solana). Its header describes a simulated 72-hour session: 618 `session_checkpoint` calls, several thousand memory entries, hourly anchors from a fake ledger and RPC, periodic `checkpoint_verify` and `memory_verify`, three rollbacks (the last to a 44-hour-old checkpoint, forgetting thousands of entries in batches), 42 real checkpoints of a real temporary git repository; structures under explicit caps after every simulated hour with a two-hour tripwire; six rebuilds of the service and the CLI over the same stores ("restarts"); a ledger outage of 182 minutes; failures of the Hindsight plane, the index and Solana; a final consistency check that finds no drift and finds a planted one. Separate `describe` blocks soak the retain outbox and the RAG state machine for 72 hours. Fail-before checks make the soak assert it would notice a queue that never drains, a cap one too low, a leaked timer and a server that ignored `taken_at_ms`.
- **CLI-side soak** `packages/cli/src/session/soak.test.ts`: 44 real checkpoints over 73 simulated hours on a real temporary git repository, a three-hour-and-twenty-minute server outage (journalled, bounded, delivered exactly once), three process restarts, real rollbacks with tree equality, and restores killed mid-way and completed on the next run.
- **Runbooks** (earlier phases wrote them; this phase checked the set): `index-migration-rehearsal`, `lightrag-storage-topology`, `anchor-chain-outage`, `devnet-reset-and-reanchor`, `session-rollback`, `anchor-signer-rotation`, plus `consistency-verify` and `memory-capsules`.
- **Decision records:** ADR 0004 (store roles), 0005 (rollback semantics), 0006 (memo-only anchoring), 0007 (checkpoint triggers and sibling hook proposals), with `docs/adr/README.md` updated; `docs/ussr-integration.md` for the four sibling components.
- **GSD artifacts:** ROADMAP.md (phases 55 to 62), REQUIREMENTS.md (SOTA-11 to SOTA-18), STATE.md (Run 8), and per-phase CONTEXT, SUMMARY and VERIFICATION for phases 55 to 62, and `v1.6-MILESTONE-AUDIT.md`.
- **Documents corrected:** `docs/event-vocabulary.md` (the wiring prose and the action list), `docs/runbooks/session-rollback.md` (`--omp-session`), `docs/data-planes.md` (LightRAG not deployed, RAGFlow (retired, superseded by LightRAG) historical) and `.planning/PROJECT.md` (no hypertables).

## Key decisions

- The soak is a simulation on injected clocks; it proves bounded structures and clean resume in-process, not production behaviour.
- A store "failover" is modelled as the store going down mid-operation and coming back: the Hindsight plane, the index, the ledger and Solana each fail and recover; no replica switch is simulated.

## Deviations from the plan

- The two soak tests take about 65 seconds together (the orchestrator's measurement) and raise the default timeout inside their files.
- ROADMAP Phase 62 criterion 1 says "a clean resume after a restart and after a store failover"; the soak covers restarts and store outages, not a switch to a second instance of a store.

## Findings

- Fixed in 901c58f: the retain-drain interval was never cleared, leaking one timer per in-process restart (`service.ts`, `stopRetainDrain`). That the soak is what exposed it is not recorded here (UNVERIFIED); the soak's handle tracker is the test that would catch a leaked timer again (`"a queue that never drains, a cap that is one too low and a leaked timer are all reported"`).
- Process disclosures are in the audit section 7.

## What remains

- A real multi-day run against production is not done; milestone completion, archive and cleanup are operator decisions.
