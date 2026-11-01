---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-01
status: human_needed
score: 2 of 2 success criteria PASS in the repository; criterion 2 PASS on the buffer bound (the dead-letter store is unbounded by decision D76-13); live GreptimeDB rehearsal not run
verified_on: branch gsd/v18-p76-telemetry-dlq at 327e7c8d (files read; nothing was run by the author of this record)
---

# 76-VERIFICATION: Telemetry buffer and dead-letter

## Gates

Not run by the author of this record, per the brief. The orchestrator's brief states that on this branch tsc exited 0, `bun test` reported 11413 pass, 2 skip, 0 fail, phase-close passed and the config reference was up to date. This record cites no test or CI result of its own. Its evidence is file paths, line numbers, function names and test titles read at 327e7c8d. A test title below means the test is present and was read; it does not mean the test was run here.

## Success criteria

ROADMAP phase 76, success criteria 1 and 2.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash | PASS | Entry: `service.ts` `appendChained` (2796-2802) hands a failed direct write to `bufferEvent` (2810-2816) with `attempts: 1`. Bound: `event-buffer.ts` `enqueue` (179-209), size from `SUBSTRATE_EVENT_BUFFER_MAX` via `config.ts` `loadEventBufferSettings` (2512-2530). Backoff: `eventBufferBackoffMs` (37-41), base × 2^n capped at `SUBSTRATE_EVENT_BUFFER_BACKOFF_CAP_MS`, ±20 % jitter; applied in `enqueue` (195) and `runDrain` (257). Budget: `runDrain` (251-256) counts attempts and gives the entry up at `maxAttempts` (`dropFrom(…, "exhausted")`, 253-254). Dead-letter with hash: `event-dead-letter.ts` `record` (92-112, `event_hash` at 98), record shape `StoredDeadLetter` (44-57), wired at `service.ts` 1886. No double write on retry: `greptime.ts` `insertEvent` `mayExist` (1262-1266), `eventRowPresent` (1291-1294). Tests present: `service-event-buffer.test.ts` "a failed write is buffered, not dropped, and lands once the ledger is back" (70), "a later event of the session waits behind the buffered one" (88), "a write that landed but lost its reply is not stored a second time on retry" (106), "a write that exhausts its budget is dead-lettered with its hash and its reason" (119); `event-buffer.test.ts` "an entry is not attempted before its backoff ends, and each failure lengthens the wait" (163), "the attempt that reaches the ceiling gives the entry up" (181); `event-dead-letter.test.ts` "a record carries the event's hash and the reason, and survives a restart" (22); `greptime.test.ts` "insertEvent with mayExist" (241-278). The service tests run against a fake ledger (`service-event-buffer.test.ts` `fakeLedger`, 13-32), not GreptimeDB. |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag | PASS, scoped to the buffer (see Deviation 1) | Reported: `service.ts` `health()` (8169) sets `eventBuffer` to `{ enabled, depth, max, oldestAt, durable, deadLetter: { depth, durable } }`, or `{ enabled: false }`; type at 8630-8631. `server.ts` `/healthz` compute spreads `...health` into the body (924-931). The body is memoised for `healthzCacheMs` (`server.ts` 922; default 5000, `config.ts` 1184). Buffer bounded by a flag: `SUBSTRATE_EVENT_BUFFER_MAX`, default 256 (`config.ts` 2525); `enqueue` refuses or gives up above the bound (183-188, 199-203); registered in `flag-registry.ts` 339 and `docs/config-reference.md` 76. Dead-letter depth: `DeadLetterStore.depth()` (`event-dead-letter.ts` 87-89), reported as above. Dead-letter store not bounded by design: `event-dead-letter.ts` header lines 11-12, decision D76-13. Tests present: `service-event-buffer.test.ts` "the health body reports the buffer's depth and the dead-letter depth, each with its durability" (208), "the buffer is off unless its path is set, and the bound comes from the flag with an unusable value falling back" (225; `SUBSTRATE_EVENT_BUFFER_MAX=2` gives 2, `0` gives 256), "overflow dead-letters the oldest buffered event…" (136; health reads depth 2, max 3 at 152); `event-buffer.test.ts` "over the bound the oldest entry is given up with a record, never dropped silently" (71). |

## Human verification

These cannot be decided from the repository. Criterion 1 and 2 are not reclassified by them.

1. **Live GreptimeDB rehearsal (not run; SUMMARY risk).** With `SUBSTRATE_EVENT_BUFFER_PATH` and `SUBSTRATE_EVENT_DEAD_LETTER_PATH` set against a real server: block or stop GreptimeDB; emit a sequence of events for one session; confirm each answers 503 with `buffered: true` and `stored: false`; confirm `/healthz` `eventBuffer.depth` rises. Restore the server; confirm each event lands exactly once in `agent_events`, in chain order (each `prev` equals the prior event's `hash`), each with an `event_ingest` row. This also exercises the `mayExist` presence check (`SELECT "id" … WHERE` cell predicate, `greptime.ts` 1291-1294) against real `ts` precision, which the unit tests do not reach. Separately, let one event exhaust the default budget (about four minutes of outage, see Deviation 2) and confirm a line in the dead-letter file carries its `event_hash`, the file is mode 0600, and a boot with the buffer path and no dead-letter path refuses and names `SUBSTRATE_EVENT_DEAD_LETTER_PATH`.
2. **Restart during an outage.** Stop the process with entries waiting and a durable file; confirm the next boot reports the depth and drains the entries once.
3. **Shutdown under the service manager.** Confirm `drainPendingEvents` (`index.ts` 251) finishes within the shutdown bound with a durable buffer, and that an unsaved buffer leaves an `abandoned` record for each entry (Deviation 4).
4. **Buffered `session.end` (D76-14, SUMMARY risk).** On a live session, confirm the steering session stays open until its `session.end` lands, and that the wake-up hint is published only once it does.
5. **Keyed replay after a dead-letter record (Residual R-1 below).** Confirm live what a collector spool replay does once the server has given the event up.
6. **Operator decision.** Whether the buffer should be on by default. It is off unless `SUBSTRATE_EVENT_BUFFER_PATH` is set (D76-15), so criterion 1 holds only where an operator enables it.
7. **`/healthz` staleness.** The body is served from a memo for up to `SUBSTRATE_HEALTHZ_CACHE_MS` (default 5000). Confirm a poller reads the depth change within that window.

## Residual risks

Confirmed as stated in `76-01-SUMMARY.md`:

- **The buffer is opt-in.** Off unless `SUBSTRATE_EVENT_BUFFER_PATH` is set; with it unset a failed write answers `stored: false` as before (`service-event-buffer.test.ts` 189). Operator-gated, not a failure.
- **A buffered `session.end` does not close its steering session until it lands**, and a buffered event does not run `noteDocsCanary` (`service.ts` 2567: `if (result.stored)`).
- **Sessionless buffered events have no chain and no ordering promise** (`event-buffer.ts` header, lines 9-13).
- **Service tests use a fake ledger**, and the client's `mayExist` semantics are covered only by the `greptime.test.ts` block (no live GreptimeDB).
- **A drain delivery holds its session's turn** for up to the Greptime write timeout, so same-session emits wait during an outage (`service.ts` 2841-2843).
- **Chain-tip and append-mode refusals are not buffered** (D76-10; `service.ts` 2753-2765).
- **Test isolation.** A test that builds a real `GreptimeClient` over a global `fetch` stub with the buffer on could leave a write buffered that drains into a later stub. The new suite uses fake ledgers and temp files and abandons its substrates after each test (`service-event-buffer.test.ts` 64-67).
- **Keyless resends duplicate.** `/events` answers 503 for a buffered event; a client that resends without an idempotency key creates a second row. The collectors send a key (`packages/collectors/src/emit.ts` `prepareEvent`, 328-366), so this affects direct API callers only.

Found in this verification, by reading the code. None was exercised:

- **R-1. A dead-letter record does not stop a later write of the same event.** Event ids are random per `normalizeEvent` (`event.ts` 282). A keyed replay after the event was given up finds nothing in the buffer (`findKeyed`, `event-buffer.ts` 154-159) and nothing in the ledger (`replayOutcome`, `service.ts` 2693-2706), so `appendChained` writes it fresh (2781-2783). The collector spool replays a 503 with its key (`emit.ts` 575-578), so an event dead-lettered after the server's budget can land later as a second row beside its record. The same happens when `abandonAll` (`service.ts` 2864) runs while a delivery is in flight and that delivery then succeeds. Nothing in `docs/greptime-ledger.md` or the SUMMARY states this.
- **R-2. A shutdown pass can be coalesced into a periodic pass.** `EventBuffer.drain` returns the in-flight promise and ignores its `all` option (`event-buffer.ts` 215-221). `drainPendingEvents` (`service.ts` 2862) can therefore return without attempting entries that are not yet due. A durable buffer keeps them for the next boot; an unsaved one gives them up with records. No entry vanishes unrecorded.

## Deviations and gaps

1. **Criterion 2 is met on the buffer bound only.** The ROADMAP text bounds "buffer and dead-letter depth … by a flag". The dead-letter store has no bound (D76-13, `event-dead-letter.ts` 11-12), and its depth is reported but not bounded. This record follows the brief, which fixes the bound's scope to the buffer. If the orchestrator does not accept that scoping for the literal criterion, criterion 2 becomes not met and the status becomes `gaps_found`.
2. **Documented outage tolerance is overstated.** `docs/greptime-ledger.md` (line 951) says the defaults "ride out an outage of about five minutes". The schedule in code gives nine retry waits (1, 2, 4, 8, 16, 32, 60, 60, 60 s nominal; `eventBufferBackoffMs` with the default base and cap), totalling 243 s nominal, or about 195 to 292 s with ±20 % jitter, before the tenth attempt gives the event up. Four minutes is the accurate figure.
3. **Plan decision D76-11 is superseded in part.** It says a memory-only buffer gives its entries up at shutdown. Configuration never builds a memory buffer (the path is required; `config.ts` 2513-2516), so `abandonAll` is reached only when the file is unsaved (`service.ts` 2864). This is the reading of D76-17 and the follow-up in `76-01-PLAN.md`, and the code matches it. The SUMMARY does not restate it.
4. **Shutdown abandon can race a delivery in flight.** `drainPendingEvents` races the pass against `Bun.sleep(timeoutMs)` (`service.ts` 2862) and then calls `abandonAll` on an unsaved buffer (2864) even when the pass has not returned. An in-flight delivery that then succeeds is stored after its `abandoned` record. This is R-1 in the shutdown case.
5. **Gates and test runs were not performed by this record.** The claims about `flag-registry.test.ts`, `config-reference.test.ts`, `greptime.test.ts` and the service tests rest on the orchestrator's brief. The config-reference rows were read against `flag-registry.ts` 339-344 and `docs/config-reference.md` 76-81, and they agree on name, default, allowed values and unset behaviour.
6. **Criterion 1 needs the flag.** Under the default configuration a failed write answers `stored: false` with no buffering, which is the behaviour the phase set out to change. The criterion is met with `SUBSTRATE_EVENT_BUFFER_PATH` set. This is recorded as operator-gated, not as a failure.

## Planning records

- `.planning/ROADMAP.md` (line 1322) still reads "Plans: none written", and line 1313 "Status: Not started"; the progress row (line 1420) reads "0/0 Not started". This record changes none of them; the orchestrator updates them after this return.
- `STATE.md` was not edited.
- Nothing was committed.
