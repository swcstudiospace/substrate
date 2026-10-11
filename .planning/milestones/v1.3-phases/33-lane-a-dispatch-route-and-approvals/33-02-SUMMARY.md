# Phase 33 Plan 02: Approval deadline + single-use rehearsal Summary

- phase: 33-lane-a-dispatch-route-and-approvals
- plan: 02
- status: complete
- commits: 49f1bdd
- requirement: LANEA-06

Completed the LANEA-06 approval flow: deadlines + tick sweep + auto-deny fail-closed, proven with injected clocks and fake transports; no live channel touched.

## Changes (`packages/host/src/`)
- `tasks.ts`: `PendingApproval.deadlineMs` (optional; pre-deadline records fail open), `APPROVAL_TIMEOUT_MS = 900_000`, `parseApprovalTimeoutMs` (env seconds, malformed falls back logged), `approvalTimeoutMs` dep, `sweepApprovalTimeouts` on every `heartbeatTick`, claim-first single-answer `respondApproval` (concurrent loser reads not_pending; refused transport restores the claim)
- `main.ts`: `SUBSTRATE_APPROVAL_TIMEOUT_S` plumbed into the service, nothing else changed

## Evidence
- `bun test packages/host/`: 225 pass, 0 fail (211 baseline + 14 new: 10 tasks, 4 telegram)
- `bunx tsc --noEmit`: clean; `bun run check:phase-close`: pass (EVENT_KINDS 12, locks unchanged)
- New tests: parse table, injectable deadline, sweep survival/expiry with no prompt settling, parked turn keeps ticking, timeout-deny releases exactly once, legacy entries never expire, resume stale-first never re-arms, sweep-wins race + double-tap single-answer, refused-transport restore, real broker+service Approve/Deny/double-tap/race, planted-secret ledger-leak sweep (logs, fetch params, substrate args, records clean; `[REDACTED]` flows end to end)

## Deviations
- `respondApproval` gained claim-first semantics (was check-then-call): required for the exactly-one-answer race guarantee; existing tap behavior unchanged when uncontended.
- One existing assertion updated for the new `deadlineMs` field; two harness opts added (`approvalTimeoutMs`, `respondPermission`).
- Fixed self-inflicted edits during execution: restored clobbered harness opts (`logs`, `reclaimRefusedFor`, `completeRefused`) and a destructive `main.ts` service-construction edit; both verified clean by tsc + suite.

## Self-Check: PASSED
