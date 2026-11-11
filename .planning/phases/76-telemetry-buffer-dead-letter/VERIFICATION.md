# Phase 76: Telemetry buffer and dead-letter - Verification

Each ROADMAP criterion, with the tests that show it and the result of the final run. Commands and counts are from this session; nothing here was run against a live ledger.

## Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | **Met** | `event-buffer.test.ts`: "a transient answer spends one attempt and waits out the next, longer backoff" (the second wait is 4 s; a pass at 5.999 s touches nothing, one at 6.000 s delivers); "an event that spends its budget is dead-lettered with its hash, and its session's later events with it" (record `cause: exhausted`, `attempts: 2`, `hash === event.hash`). `service-event-buffer.test.ts`: "retry then success" (same id and hash, `prev` unchanged, pending 0); "retry exhausted" (the dead-letter **file** holds the record with `hash === result.event.hash`). |
| 2a | Buffer and dead-letter depth are reported in `/healthz`. | **Met** | `service-event-buffer.test.ts`: "a full buffer dead-letters the new event at once, and healthz reports the depth" (`pending 1`, `max 1`, `deadLetters.depth 1`); "retry exhausted" asserts the full `eventBuffer` block. `service.test.ts`: "healthz separates reachability from writability" asserts the block's shape. `service-event-buffer.test.ts`: "parked events survive a restart ..." reports `pending 1, durable true` after boot. |
| 2b | Bounded by a flag. | **Met** | Buffer bound: `SUBSTRATE_LEDGER_BUFFER_MAX=1` → "a full buffer dead-letters the new event at once" (cause `overflow`, the parked event kept). Dead-letter bound: `event-buffer.test.ts` "the dead-letter store is bounded: the oldest record is evicted and the eviction is counted". Flags read in `config.ts` (`eventBuffer`) and registered in `flag-registry.ts` (five rows, all in `.env.example` and `docs/greptime-ledger.md`); the registry lock test reports no unregistered name from these. |

## Behaviour checks beyond the criteria

| Behaviour | Test |
|---|---|
| A write that succeeds is not parked | `service-event-buffer.test.ts` "a write that succeeds at once is stored, not parked" |
| A session's later event waits behind the parked one and chains onto it; both land in order | `service-event-buffer.test.ts` "a session's later event waits behind the parked one"; `event-buffer.test.ts` "a session's events are delivered in chain order" |
| An event parked behind an untried predecessor is not tried before it | `event-buffer.test.ts` "an event parked without an attempt is due at once, yet still waits behind its session's earlier event" |
| A keyed replay of a parked event answers with it and writes nothing | `service-event-buffer.test.ts` "a keyed replay of a parked event answers with it and writes nothing" |
| A replay whose original landed with a lost reply is a dedupe hit | `event-idempotency.test.ts` (three cases, all passing) |
| Ambiguous write: an existing row is not written twice | `service.ts` `deliverBufferedEvent` asks `eventStored` before each retry and, when the row exists, writes only its ingest record. The fakes answer "no row", so the existing-row branch has **no dedicated test** (see gaps). |
| Breaker open: no attempt is spent | `event-buffer.test.ts` "a held delivery (the ledger's breaker is open) stops the pass and spends no attempt" |
| Ceiling of one attempt dead-letters the live failure at once | `event-buffer.test.ts` "a ceiling of one attempt dead-letters the live failure at once" |
| Memory-only buffer: shutdown moves parked events to the dead letters as `abandoned` | `event-buffer.test.ts` "abandonAll moves every parked event to the dead letters as abandoned" |
| File-backed buffer survives a restart with order and tips; 0600 | `event-buffer.test.ts` "a file-backed buffer survives a restart with its order and chain tips, and the file is 0600" |
| Malformed buffer line skipped, neighbours kept | `event-buffer.test.ts` "a malformed line is skipped and the entries around it survive a restart" |
| Dead-letter store keeps records, hash included, across a restart | `event-buffer.test.ts` "a file-backed dead-letter store keeps its records, hash included, across a restart" |
| Existing chain-tip behaviour, reworked for parking | `ledger-chain.test.ts` "an event-row error forgets the tip and parks the event ..." (updated; see SUMMARY) |
| Existing "not stored" log contract for a refused insert | `service.test.ts` "an insert that fails before the event row lands is still stored: false" (passing with the parked log line) |
| `RetainOutbox` after the extraction into `outbox-file.ts` | `retain-outbox.test.ts` (all passing, unchanged) |

## Final run

- `bun test` on the 9 narrow files: **617 pass, 1 fail, 618 tests, 9 files.**
- The 1 failure: "the lock: every environment read has a registry row". Pre-existing at HEAD: `scripts/docs-migrate.ts:39` reads `SUBSTRATE_DOCS_MIGRATE_APPROVED`, which commit `2ef45b0b` added without a registry row. Confirmed by `git show HEAD:packages/mcp-server/src/flag-registry.ts` (zero matches). The scanner (`envReadSources` / `findUnregistered`) lists this as the only unregistered name in the tree.
- `bunx tsc --noEmit`: exit 0.

## Gaps in this verification

- **No live ledger.** Every Greptime interaction is a fake or the `ledger-chain` HTTP fake. The real `INSERT` / `SELECT` behaviour under a timeout is not exercised.
- **Existing-row retry branch.** `deliverBufferedEvent` takes the "row already there" branch only when `eventStored` returns true. The narrow tests return false from `eventStored` on the drain path. The branch is simple (existence, then ingest record), but it has no dedicated test; the ledger-chain fake would need a `SELECT "id"` answer to cover it.
- **Concurrency.** The per-session emit gate and the single-pass drain are reasoned about in `CONTEXT.md` and `event-buffer.ts`, not stressed by a concurrency test.
- **Not run:** full `bun test`; `rollback-compat.test.ts` and `soak-multiday.test.ts`, which import `RetainOutbox` (see SUMMARY residual 7).
