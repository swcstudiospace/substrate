# Phase 76 Plan 01 Summary: Telemetry buffer and dead-letter

Branch `gsd/v18-p76-telemetry-dlq`, worktree `/root/src/worktrees/as-gsd-v18-p76`. Decisions are in `76-01-PLAN.md` (D76-01 to D76-14).

## Discovery, confirmed

- `GreptimeClient.insertEvent` had no retry. A thrown write propagated unchanged.
- `Substrate.appendChained` turned that into `{ stored: false, error }` with nothing queued (fail-open, nothing kept).
- `/healthz` is built in `server.ts` from `substrate.health()`, so a field added to `SubstrateHealth` appears in the body.

## What changed

- `event.ts`: `StoredEvent` zod schema and `parseStoredLine`, the one validator for persisted events.
- `event-buffer.ts` (new): bounded per-session FIFO, backoff with jitter, overflow and cascade, in-flight protection, JSONL persistence mirroring the retain outbox.
- `event-dead-letter.ts` (new): append-only JSONL dead-letter store, one record per event (hash, reason, attempts, last error, whole event). Memory mode reports `durable: false`.
- `greptime.ts`: `insertEvent(event, { mayExist })` checks the row by id inside its cell and repairs a missing ingest record instead of inserting twice. The cell predicate is shared with `findByIdempotencyKey`. The default path is unchanged.
- `service.ts`: `withSessionTurn` extracted from `append`. `appendChained` answers a keyed replay from the ledger first, then from the queue, queues a later event behind its session's buffered tail (`prev` = that tail's hash), and buffers a failed direct write. `deliverBuffered` and the drain run inside the session turn. `drainPendingEvents` handles shutdown. `health().eventBuffer` carries depths and durability. `EmitResult` gains `buffered` and `deadLettered`.
- `config.ts`: `eventBuffer` settings and six flags. `index.ts`: shutdown calls `drainPendingEvents`. `reanchor-run.ts`: isolated config nulls the buffer and dead-letter paths.
- `mcp.ts` (`events_emit` reply) and `server.ts` (`POST /events` body) carry `buffered` and `deadLettered`.
- `flag-registry.ts`, `.env.example`, `docs/config-reference.md`, `docs/greptime-ledger.md`: six flags documented. The config-reference rows were written by hand in the renderer's format.
- Tests, new: `event-buffer.test.ts`, `event-dead-letter.test.ts`, `service-event-buffer.test.ts`. Added: an `insertEvent with mayExist` block in `greptime.test.ts`.
- Existing tests: `ledger-chain.test.ts` and `event-idempotency.test.ts` are back to their original text. The buffer is off by default, so their failed-write assertions (`stored: false`, the original chain and replay expectations) hold unchanged.

## Verification

Not run, by assignment: the test suite, typecheck, lint, formatter, build. The orchestrator must run them. Check in particular:
- `bun run config:reference -- --check` (the rows were hand-written; the check is the authority).
- `flag-registry.test.ts` and `config-reference.test.ts`.
- The three new test files, and the `mayExist` block appended to `greptime.test.ts`. No other existing suite changed.
- `mcp.test.ts` "says so when the append did not land" runs with the buffer off by default, so its reply is `stored: false` with an error and no `buffered` key, as before.
- Only with the buffer on do `/events` 503 bodies and the `events_emit` reply carry `buffered` or `deadLettered`; a test asserting their exact shape with the buffer on would need those keys.

## Criteria

1. A failed write enters the bounded buffer, is retried with backoff, and after the budget is dead-lettered with its hash. Covered by `service-event-buffer.test.ts` ("buffered, not dropped", "waits behind", "lost its reply", "exhausts its budget") and `event-buffer.test.ts` (backoff boundaries, ceiling, in-flight protection).
2. Depths are reported in `/healthz`, and the buffer is bounded by a flag. Covered by the `health().eventBuffer` test, the overflow test with `SUBSTRATE_EVENT_BUFFER_MAX=3`, and the `loadConfig` flag test. The dead-letter store is deliberately unbounded (D76-13): a bound would have to discard records. Its depth is reported.

## Risks and open items

- **Buffer is opt-in (follow-up).** Off unless `SUBSTRATE_EVENT_BUFFER_PATH` is set. Then `SUBSTRATE_EVENT_DEAD_LETTER_PATH` is required, and boot refuses without it, naming the variable. The earlier memory-only default is gone from configuration; the classes keep a null path only for unit tests. Unset, a failed write answers `stored: false` exactly as before.
- Buffered `session.end` does not close its steering session until it lands. `noteDocsCanary` runs only for stored events (D76-14).
- Sessionless buffered events are independent, with no ordering promise, because they have no chain.
- Service tests use a fake ledger whose `insertEvent` implements `mayExist` as the client does. The client's own semantics are covered by the `greptime.test.ts` block, not against a live GreptimeDB.
- A drain delivery holds its session's turn for up to the Greptime write timeout, so same-session emits wait that long during an outage. This is the existing per-session serialisation, now also covering retries.
- Chain-tip and append-mode refusals still answer `stored: false` without buffering (D76-10); they need an operator, not a retry.
- Residual test-isolation risk: a test that builds a real `GreptimeClient` over a global `fetch` stub, with the buffer on, can leave a write buffered that drains into a later stub. The buffer is off by default, so the existing suites never buffer. The new suite uses its own fake ledgers and temp files, and abandons its substrates after each test.
- Process note: a one-off Python string replacement changed `service-event-buffer.test.ts` in the first pass. The follow-up rewrote that whole file with the edit tool, and its `afterEach` was re-read: it abandons each opened substrate, which keeps a durable buffer.
- Residuals kept as documented: the buffered `session.end` side effect (steering stays open until the event lands) and the sessionless ordering note (no chain, no ordering promise).
- `/events` answers 503 for a buffered event, as for any unstored event. A client that resends without an idempotency key creates a second row. Keyed replays are deduplicated against the queue and the ledger; keyless resends are not.
