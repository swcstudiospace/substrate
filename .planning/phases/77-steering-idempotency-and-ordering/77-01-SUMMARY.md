# Phase 77 — Steering idempotency and ordering (SUMMARY, revision 2: durable)

Plan: `77-01-PLAN.md` (revision 2). Branch `gsd/v18-p77-steering-idempotency`, stacked on phase 71.

## What changed

Keyed queue: optional `idempotency_key` (REST body, MCP `steering_queue`). A repeat from the same surface to the same target session
returns the original reply, with its `sequence`, and writes nothing. The replay record and the per-session sequence counter are durable
(migration 43, under the `steering-audit` opt-in). A retry after a restart still replays, and sequence order survives a restart.

- `index-store.ts`: migration 43 (`planning_steering_sequence`, `planning_steering_replay`, nullable
  `planning_steering_audit.delivery_sequence`; expand, reversible `down`). `steeringIdempotency()` factory.
- `planning/steering-store.ts`: `deliverySequence` on the audit row (insert, read, restore, payload hash, NULL keeps the hash).
  `bunSteeringIdempotencyStore`: one-upsert sequence, replay find, transactional replay save (prune expired, insert unless a live record holds
  the key, delete the oldest beyond the cap).
- `planning/steering.ts`: `SteeringIdempotencyStore` port; `MemorySteeringIdempotencyStore` default; inbox deps `store` and
  `idempotency`; replay under the inbox lock; sequence from the store before audit; async restore keeps stored sequences and advances the
  counter past them; `loadSteeringIdempotencySettings` (TTL seconds 60..2592000, default 86400; cap 1..1000000, default 10000).
  `idempotency-conflict`.
- `config.ts`: `steeringIdempotency`. `service.ts`: store and settings into the inbox, under the audit opt-in; idempotency settings errors
  join `steeringErrors` (a bad value answers `misconfigured`).
- Unchanged from revision 1: `steering-tools.ts` (key, `sequence` on keyed reply only), `steering-rest.ts` (body key, `RestDirective.sequence`,
  409), `steering-waiters.ts` (`QueuedDelivery`), `server.ts` (`/steering/wait`), `mcp.ts` (description), `docs/live-steering.md`.

## Tests

- `steering.test.ts`: keyed replay appends nothing and spends no token; conflict; scope by author and target session; unkeyed repeats stay two
  directives; per-session sequence and queue order; retention expiry; audit failure not remembered; key grammar; cap from configuration
  (cap 3, the oldest key forgotten, the newest replays); constructor rejects non-positive retention or cap; settings defaults, bounds and
  typed errors.
- `steering-durable.test.ts` (restart suite, new process over the same audit log and the same replay store):
  - `a keyed retry after a restart returns the original record and sequence, even once the directive was acknowledged, and writes no audit row`
  - `after a restart the next distinct command takes the next sequence, and a restored directive keeps its own`
  - `past the retention window a retry across a restart is a new command with the next sequence`
  - `a retry across a restart with different content is refused as a conflict, and writes nothing`
- `steering-tools.test.ts`, `steering-rest.test.ts`, `steering-waiters.test.ts`: as revision 1.

## Verification

Not run, per the contract (no tests, typecheck, lint or build). Checked by reading only: call sites of changed signatures, the
`exactOptionalPropertyTypes` spreads, the exhaustive `steeringHttpStatus` switch, and the test fixtures that build audit rows
(`steering-durable.test.ts` `queuedRow`, now with `deliverySequence`).

NOT verified: `bunSteeringIdempotencyStore` and migration 43 were never executed. No database runs here. A Postgres run of the migration
and the adapter (the `*.pg.test.ts` pattern) is required before merge. The restart tests use `MemorySteeringIdempotencyStore` as the durable
stand-in, so they prove the inbox's use of the port, not the SQL.

## Open risks (residuals)

- R1 **Crash between the audit row and the replay record.** The audit row commits, then the process dies before the replay record is saved:
  a retry of that key applies again. Closing this needs the audit row and the replay record in one transaction, so the sink's append must
  carry the replay record. The audit port is one statement today. Documented residual. A save failure after an accepted audit is reported
  on stderr and does not fail the queue, for the same reason.
- R2 A failed audit after the counter was taken leaves a gap in the session's numbers. Numbers are never reused, and order is unaffected.
- R3 SQL unexecuted (see Verification).
- R4 At capacity the oldest key is forgotten before its retention. Under the default rate (10 per minute per session) this needs very heavy
  keyed traffic.
- R5 `GET /steering/directives` and `GET /steering/wait` gain `sequence` for unkeyed directives too. The unkeyed command reply is unchanged.
- R6 With the audit opt-in on, every queue takes its counter with one database upsert, keyed or not.

## Criteria

1. Replayed keyed command returns the original result and writes nothing: met, including across a restart.
2. Unkeyed commands unchanged: met (reply key set asserted; repeats are two directives).
3. Keyed reply exposes its sequence; a replay returns the same sequence; distinct commands are delivered in sequence order; `restDirective`
   and `/steering/wait` expose it; the next number after a restart is new: met by the tests above, with the SQL caveat.

## Migration contract

- `index-store.migrate-contract.test.ts`: `planning_steering_sequence` and `planning_steering_replay` are allowlisted with reasons, since the
  archive's closed table list does not cover them (same treatment as `planning_steering_audit`).
- `index-store.migrations.digests.json`: step 43 added by regenerating with `bun scripts/migration-digests.ts`, as the script's header
  requires for a new step. The diff against HEAD adds only the `43` digest and the comma on the `42` line. Digests 1 to 42 are unchanged.
  To run it, `bun install --frozen-lockfile` was needed first (the workspace package `@substrate/observability` is unresolved until then).
  `bun.lock` is unchanged. The generator was run as a data step, not as a test, typecheck, lint or build gate.

## Gate fixes (review round)

- Retry after a lost audit reply: a queue whose audit failed keeps the number it took for its directive id, and the retry reuses it, so the
  retried row hashes the same as the committed one (no `AUDIT_CONFLICT`). The reservation is in memory and cleared when the retry is audited.
- A replay announces nothing: `enqueueReceipt` reports `replayed`, and `queueSteering` calls the wiring hook `onQueued` only for a fresh queue.
- Registry and env: `SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S` and `..._CAP` are in `flag-registry.ts`, `.env.example`, and
  `docs/config-reference.md` (regenerated with `bun run config:reference`). The runbook names step 43 in `rollback-compat.md`.
- Harness: the steering-audit opt-in expectation is now steps 33, 34 and 43; each step's own transaction and reversal remain asserted.
