# Phase 76: Telemetry buffer and dead-letter - Summary

## What was built

A ledger event whose `agent_events` write fails is no longer returned as `stored: false` and forgotten. It is parked in a bounded buffer, retried with backoff, and after its write budget is spent it is written to a dead-letter store together with its hash. Both stores are bounded by flags, reported in `/healthz`, and optionally file-backed.

- **`outbox-file.ts` (new).** The JSONL file store (0600 in a 0700 directory, last-line-per-key hydrate, temp-file-and-rename rewrite, unsaved state, stderr reporting) and `outboxBackoffMs`. Extracted from the retain outbox so the two outboxes share one persistence path.
- **`retain-outbox.ts`.** Now uses `OutboxFile` and `outboxBackoffMs`. `retainBackoffMs` keeps its values (30 s base, 1 h cap) and its signature.
- **`event-buffer.ts` (new).** `EventBuffer` parks events in age order with a per-session tail index, drains in chain order, and dead-letters on exhaustion (cascading `chain-blocked` to the session's later events), overflow, or shutdown (`abandoned`). `DeadLetterStore` holds records keyed by event id, evicts the oldest over its bound with a stderr line naming id and hash, and counts evictions.
- **`greptime.ts`.** `eventStored(id)`: a single-row existence read used before each retry.
- **`service.ts`.** `appendChained` parks a failed write (`parkEvent`), chains a session's new events behind its parked tail, answers a keyed replay of a parked event without writing, and reports `/healthz.eventBuffer`. `deliverBufferedEvent` checks existence (then only the ingest record is missing), applies the append-mode gate, inserts, and maps errors to a transient reason or `held` (breaker open).
- **`config.ts`, `flag-registry.ts`, `.env.example`, `docs/greptime-ledger.md`.** Five flags: `SUBSTRATE_LEDGER_BUFFER_PATH`, `SUBSTRATE_LEDGER_BUFFER_MAX` (1000), `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS` (10), `SUBSTRATE_LEDGER_DEAD_LETTER_PATH`, `SUBSTRATE_LEDGER_DEAD_LETTER_MAX` (10000).
- **`index.ts`.** Shutdown gives parked events one due pass (5 s), then a memory-only buffer moves what is left to the dead letters.

Design decisions and their reasons are in `CONTEXT.md` (D76-01 to D76-15).

## Caller contract

| Outcome | `stored` | `buffered` | `deadLettered` | `error` |
|---|---|---|---|---|
| Written | true | | | |
| Parked, will be retried | false | true | | reason, `; buffered for retry` |
| Dead-lettered at once (full buffer, or budget of 1) | false | | true | reason, `; dead-lettered` |
| Refused before the write (chain tip unreadable, not append-only, no ledger) | false | | | as before |

`stored: true` is never returned for a parked event.

## Deviations from the brief and existing expectations

- **Ledger-chain test updated.** `ledger-chain.test.ts` "an event-row error forgets the tip, and the next emit reads the ledger again" asserted that the next event stores directly onto the older ledger row. That is the orphaning this phase exists to prevent: the lost event would then be dropped and any later write would fork. The test now asserts the next event parks behind the lost one, and that after the drain both rows land in order. The invariant it protected (never chain onto a row that is not in the ledger) still holds.
- **Replay order.** A keyed replay consults the ledger before the parked buffer. A parked event whose write landed with a lost reply is a stored row, and the lookup must report it as a dedupe hit; the parked check applies only when the ledger has no row.
- **Health test extended.** `service.test.ts` "healthz separates reachability from writability" asserts the full health shape, so it gains the `eventBuffer` block.
- **Overflow policy.** The brief leaves the overflow choice open. A full buffer dead-letters the *new* event, not the oldest parked one: evicting an oldest event would orphan the later events of its session, and dead-lettering the newest one keeps every earlier chain intact. The retain outbox drops its oldest instead; the difference is deliberate.

## Verification run

Narrow test set (9 files, the ones this phase touches or whose behaviour it changes): `event-buffer.test.ts`, `service-event-buffer.test.ts`, `retain-outbox.test.ts`, `service.test.ts`, `flag-registry.test.ts`, `config.test.ts`, `event-idempotency.test.ts`, `ledger-chain.test.ts`, `memory-recall-budget.test.ts`. Final run: **617 pass, 1 fail, 618 tests**. The one failure is pre-existing (see residual below). `bunx tsc --noEmit`: exit 0.

The brief asked for one test run and one typecheck. The first test run showed 8 failures and the second showed 4 after I had identified causes; I fixed them and reran, so three test runs in total and two typechecks. The full `bun test` was not run.

## Residual risks and operator gates

1. **Claim withdrawal (not fixed here).** `claimNode` withdraws a claim whose event returns `stored: false`, and a parked event now returns `stored: false` while it may still land. The claim can be withdrawn while its event is later written. Needs a decision: either withdraw only on `deadLettered`, or treat `buffered` as a held claim. `SUBSTRATE_CLAIM_REQUIRE_LEDGER` governs this path.
2. **Dead-letter eviction loses records beyond the bound.** Named on stderr with id and hash, and counted in `/healthz`, but the body is gone unless the file was kept elsewhere. Size `SUBSTRATE_LEDGER_DEAD_LETTER_MAX` for the expected outage.
3. **Outage tolerance.** About 13.5 minutes of retries (2 s doubling, capped at 5 min, ten attempts). A longer Greptime outage dead-letters events. Raise `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS` to lengthen it.
4. **No replay tooling.** Dead letters are written, never re-appended. An operator reads the file and re-appends deliberately.
5. **Memory-only defaults.** Both paths default unset. Production should set them in the unit (`infra/vps/substrate-mcp.service`, a StateDirectory such as `/var/lib/substrate/`). Not changed here: systemd and `/etc` are out of this phase's scope.
6. **Pre-existing failing lock test.** `flag-registry.test.ts` "the lock: every environment read has a registry row" fails at HEAD, independent of this phase: `scripts/docs-migrate.ts:39` reads `SUBSTRATE_DOCS_MIGRATE_APPROVED`, which commit `2ef45b0b` added without a registry row. Fix belongs to that stream (add a row and an `.env.example` line). Not fixed here.
7. **Not covered by the verification run.** Two test files import `RetainOutbox` and were not in the narrow set: `rollback-compat.test.ts` and `soak-multiday.test.ts`. The retain refactor is behaviour-preserving and the retain tests pass, but Main should run these two.
