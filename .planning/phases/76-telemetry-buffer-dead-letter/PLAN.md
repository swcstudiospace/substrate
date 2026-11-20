# Phase 76: Telemetry buffer and dead-letter - Plan

Decisions and the reasons for them are in `CONTEXT.md` (D76-01 to D76-15). This plan orders the work and names the check for each step.

## Tasks

1. **Shared outbox file.** Extract the JSONL file store (hydrate with last-line-per-key, append, compact by rename, unsaved state, stderr reporting) and the exponential backoff from `retain-outbox.ts` into `outbox-file.ts`. `RetainOutbox` uses it with unchanged behaviour and stderr text.
   *Check:* `retain-outbox.test.ts` passes unchanged.
2. **Event buffer and dead-letter store.** `event-buffer.ts`: `EventBuffer` (per-session order via a tail index, bounded enqueue with overflow to the dead letters, exhaustion with `chain-blocked` cascade, `held` spends nothing, `abandonAll`) and `DeadLetterStore` (bounded, eviction named on stderr, file-backed hydrate).
   *Check:* `event-buffer.test.ts`.
3. **Ledger existence read.** `GreptimeClient.eventStored(id)`: a single-row `SELECT` by id, for the ambiguous-write check before each retry.
4. **Service wiring.** `appendChained` chains behind parked events; a failed direct write is parked (`parkEvent`); a keyed replay of a parked event answers with it; the drain delivers in order (`deliverBufferedEvent`: exists-then-record, else append-mode gate then insert); `/healthz.eventBuffer`; the shutdown pass.
   *Check:* `service-event-buffer.test.ts`; `service.test.ts` health shape and existing emit tests.
5. **Config and flags.** `config.eventBuffer` with five variables; rows in `flag-registry.ts`; `.env.example`; `docs/greptime-ledger.md`.
   *Check:* `flag-registry.test.ts` (every read name has a row, every documented row is in `.env.example`); `config.test.ts`.
6. **Shutdown.** `index.ts` calls `drainPendingEvents` with `abandon` after the retain outbox pass.
7. **Verify once.** Run the narrow test files this phase touches, then `bunx tsc --noEmit` once. Full `bun test` is not run.

## Acceptance (from the ROADMAP)

- A failed event write enters a bounded buffer, is retried with backoff, and after the budget is written to a dead-letter store with its hash.
- Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag.

## Test cases required by the phase

- success (stored at once, not parked);
- retry-then-success (same event id and hash; `prev` unchanged);
- retry exhausted → dead-letter file record carrying the hash, plus the `/healthz` depth;
- bounded buffer overflow (new event dead-lettered, parked event kept);
- `/healthz` depth reporting (pending, max, dead-letter depth, durable, evicted), including after a restart from a buffer file.

## Files touched

`outbox-file.ts` (new), `event-buffer.ts` (new), `event-buffer.test.ts` (new), `service-event-buffer.test.ts` (new), `retain-outbox.ts`, `greptime.ts`, `service.ts`, `service.test.ts`, `config.ts`, `flag-registry.ts`, `index.ts`, `.env.example`, `docs/greptime-ledger.md`, and this phase directory.
