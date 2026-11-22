# Phase 76: Telemetry buffer and dead-letter - Context

**Goal (ROADMAP):** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently.
**Success criteria:**
1. A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash.
2. Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag.
**Depends on:** Phase 73 (shared ledger write path; the chain and `event_ingest` record it relies on).

## Discovery (what existed before this phase)

- Write path: `Substrate.emit` → `appendChained` (`packages/mcp-server/src/service.ts`) → `GreptimeClient.insertEvent` (`greptime.ts`). A failed `insertEvent` returned `{ stored: false, error }` and nothing was queued. The chain-tip read, the append-mode gate and the ingest record are on the same path.
- No retry anywhere on the event path. `insertEvent` retries nothing.
- Existing outbox: `retain-outbox.ts` (uplift-2 R3) parks failed Hindsight forwards. It has a 0600 JSONL file with last-line-per-key hydrate, temp-file-and-rename compaction, a "save failed, durable off" state, an `outbox-full` bound that drops the oldest, `retainBackoffMs` (30 s doubling, 1 h cap, ±20 %), and a drain that shares one pass.
- Flags: `flag-registry.ts` (one row per variable, documented in `.env.example` and `docs/`), read in `config.ts`.
- `/healthz`: `Substrate.health()` builds the body and `server.ts` spreads it. The retain outbox reports through the Hindsight block, not `/healthz` itself.

## Decisions

- **D76-01 Scope of "write failure".** The buffer takes a failed `insertEvent` only. The two refusals before the write stay `stored: false` with no buffering: a chain tip that cannot be read (the event's hash is over a `prev` that is unknown) and a ledger that is not append-only (writing is the policy violation). Both are named in the docs.
- **D76-02 Reuse, not a second outbox.** The file persistence and the backoff are extracted from the retain outbox into `outbox-file.ts` (`OutboxFile`, `outboxBackoffMs`). `RetainOutbox` now uses them, with unchanged behaviour and stderr text. The event buffer is a separate class because its semantics differ: events are never replaced by a newer copy of the same key, they must land in chain order, and a dead letter keeps the whole event.
- **D76-03 Chain order is preserved.** A session's events are parked and retried in order. While a session has a parked event, its new events are parked behind it with `prev` = the parked tail's hash, and nothing for that session is written directly. Without this, a later event would be written onto the pre-failure tip and the parked earlier event would then fork the chain (`verify` would detect it later, nothing would prevent it).
- **D76-04 Exhaustion cascades to the session.** When a parked event spends its budget, its session's later parked events are dead-lettered as `chain-blocked`: their `prev` names a row that will never exist. An overflow dead-letters only the new event: earlier parked events are still valid and later events chain onto them.
- **D76-05 Ambiguous writes are checked before retry.** A write that timed out may have landed. Before each retry the buffer asks the ledger whether the row exists (`GreptimeClient.eventStored`). If it does, only the missing `event_ingest` record is written. Otherwise a retry would store the event twice.
- **D76-06 Keyed replays.** A replay of a keyed event whose first attempt is still parked answers with the parked event and writes nothing. The ledger's idempotency lookup cannot see parked events, so without this a replay would write a second copy.
- **D76-07 Dead-letter record.** The record holds the whole normalised, redacted event (`prev` and `hash` included), its hash at top level, the cause (`exhausted`, `overflow`, `chain-blocked`, `abandoned`), attempts, the last reason and the time. A parked event must be written later and a dead letter must be recoverable by an operator; the hash alone is not enough. The record is never replayed by the substrate.
- **D76-08 Bounds.** `SUBSTRATE_LEDGER_BUFFER_MAX` (default 1000) bounds parked events; a new event over it is dead-lettered (`overflow`). `SUBSTRATE_LEDGER_DEAD_LETTER_MAX` (default 10000) bounds dead letters; over it the oldest is evicted, its id and hash written to stderr, and the eviction count reported. A dead letter is not silently lost.
- **D76-09 Budget and backoff.** `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS` (default 10, live attempt included). Backoff is 2 s doubling, capped at 5 min, ±20 %: about 13.5 minutes of retries before dead-lettering. The retain outbox's 30 s / 1 h schedule is for HTTP plane outages; a ledger write should be retried sooner.
- **D76-10 Breaker.** A `GreptimeBreakerOpen` answer is "held": no attempt is spent and the pass stops.
- **D76-11 Durability.** Both stores are memory-only unless `SUBSTRATE_LEDGER_BUFFER_PATH` / `SUBSTRATE_LEDGER_DEAD_LETTER_PATH` is set (0600 JSONL, hydrated at boot). Memory-only shutdown moves parked events to the dead letters as `abandoned` and names the count on stderr; memory-only dead letters are named at exit. `/healthz` reports `durable` for both.
- **D76-12 Health does not change status.** `/healthz.eventBuffer` reports `pending`, `max`, `oldestAt`, `durable` and `deadLetters` (`depth`, `max`, `durable`, `evicted`). The HTTP status is not affected: the substrate keeps serving, and a backlog is reported, not refused.
- **D76-13 Caller answer.** A parked event answers `stored: false`, `buffered: true`, with the reason in `error`. A dead-lettered event answers `stored: false`, `deadLettered: true`. `stored: true` is never returned for a parked event.
- **D76-14 Flags.** Five rows in `flag-registry.ts`, `.env.example` and `docs/greptime-ledger.md`: `SUBSTRATE_LEDGER_BUFFER_PATH`, `SUBSTRATE_LEDGER_BUFFER_MAX`, `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS`, `SUBSTRATE_LEDGER_DEAD_LETTER_PATH`, `SUBSTRATE_LEDGER_DEAD_LETTER_MAX`.
- **D76-15 Shutdown.** `index.ts` gives parked events one due pass inside `SHUTDOWN_EVENT_MS` (5 s), then `drainPendingEvents(..., { abandon: true })`, after the retain outbox and before the flush.

## Out of scope

- Automatic replay of dead letters (D76-07): an operator decision.
- Metrics for buffer depth (only `/healthz` is required by the phase).
- A route or CLI to list dead letters. The file is the record; `/healthz` gives the depth.
- Changing `claimNode` withdrawal semantics: a claim whose event is parked is withdrawn today as it is for any `stored: false` (`SUBSTRATE_CLAIM_REQUIRE_LEDGER`). Recorded as a residual in SUMMARY.md.
- Any production store, Railway, systemd or `/etc`. Tests use a ledger fake and temporary directories.

## Files

- `packages/mcp-server/src/outbox-file.ts` (new): shared JSONL persistence and backoff.
- `packages/mcp-server/src/retain-outbox.ts`: uses `outbox-file.ts`; behaviour unchanged.
- `packages/mcp-server/src/event-buffer.ts` (new): `EventBuffer`, `DeadLetterStore`.
- `packages/mcp-server/src/greptime.ts`: `eventStored(id)`.
- `packages/mcp-server/src/service.ts`: emit path, `parkEvent`, delivery, drain tick, shutdown pass, `/healthz`.
- `packages/mcp-server/src/config.ts`, `flag-registry.ts`, `index.ts`, `.env.example`, `docs/greptime-ledger.md`.
- Tests: `event-buffer.test.ts`, `service-event-buffer.test.ts`; `service.test.ts` health shape extended.
