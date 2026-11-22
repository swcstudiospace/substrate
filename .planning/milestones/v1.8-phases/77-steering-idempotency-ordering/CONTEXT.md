# Phase 77: Steering idempotency and ordering - Context

**Goal (ROADMAP):** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Success criteria:**
1. A replayed keyed command returns the original result and writes nothing.
2. Unkeyed commands keep working unchanged (owner decision, 2026-10-30).
3. A keyed reply exposes its sequence number, a replay returns the same sequence, and two distinct commands are delivered in sequence order. `restDirective` omits the sequence today, though `SteeringInbox` tracks one internally.
**Depends on:** Phase 71.

## Discovery (what existed before this phase)

- Queue path: `POST /steering/queue` (`server.ts`) and the `steering_queue` tool both call `queueSteering` (`planning/steering-tools.ts`). It builds a `SteeringDirective` with a random UUID (`wiring.newDirectiveId ?? randomUUID()`) and calls `SteeringInbox.enqueue`.
- Acknowledge path: `acknowledgeSteeringWithState` (tools) runs `SteeringInbox.acknowledge` through `executeLiveCall`, then drives the session state port. Its reply carries `session_state` and `checkpoint_hint`.
- `SteeringInbox` (`planning/steering.ts`) already assigns each directive a delivery sequence on entry (`sequences`, `lastSequence`), exposes it through `sequenceOf` and `queuedFor`, and uses it for the wait cursor (`steering-waiters.ts` `nextQueuedDirective`). Restore assigns sequences in restore order.
- `restDirective` (`planning/steering-rest.ts`) builds the REST shape from a record only, so the sequence never reaches a reply or a listing.
- Neither input schema (`STEERING_QUEUE_INPUT`, `STEERING_ACKNOWLEDGE_INPUT`) nor the REST body parsers carry a key.
- The house idempotency rule for keys is `IDEMPOTENCY_KEY_PATTERN` in `event.ts` (8 to 128 characters from `A-Z a-z 0-9 . _ : -`). Phase 76 (D76-06) answers a keyed replay from the stored record and writes nothing.
- Every live call is audited before its effect by `Substrate.executeLiveCall` (`auditPreparedBatch`). That access audit is mandatory and is not a steering write, so a replay still produces it.
- The audit table `planning_steering_audit` has a unique `(directive_id, transition)` key. A second `queued` row for the same directive id with a different payload is an `AUDIT_CONFLICT`.
- Restart: `restoreSteeringInboxPaged` loads only open (queued, unacknowledged) directives. Acknowledged directives are not in memory after a restart.

## Decisions

- **D77-01 Input.** `steering_queue` and `steering_acknowledge` take an optional `idempotency_key` (MCP input schema and REST body). It uses the event rule (`IDEMPOTENCY_KEY_PATTERN`). Unset means unkeyed, and the unkeyed path is the code that already exists.
- **D77-02 Scope.** A key belongs to the caller's surface (the author principal for a queue). Two surfaces may use one key without meeting.
- **D77-03 Deterministic directive id for a keyed queue.** The id is `idem-` plus the SHA-256 of `steering.queue.v1 NUL surface NUL key`, so it is 68 characters and matches `DIRECTIVE_ID_RE`. Every retry of one key names the same directive. This is what makes a replay safe after a restart and across processes: the inbox's `duplicate-directive` check and the audit table's unique key both refuse a second `queued` row for that id. Without it a retry after a restart would create a second directive with a new random id.
- **D77-04 Queue replay is answered from the inbox.** Inside a per-key lane, a keyed queue looks up the directive with the derived id. If it exists, the request fingerprint (action, priority, target session, plan reference, conflict flag and the redacted body) is compared with the record's. Equal: the original `queued` reply is rebuilt from the record and its sequence, and nothing is written (no rate token, no audit row). Different: refused with `idempotency-conflict` (HTTP 409), nothing written.
- **D77-05 Acknowledge replay is answered from an index.** An acknowledgement's reply includes the session-state outcome, which is decided by a port call that a replay must not repeat. So the reply is stored, not rebuilt. `SteeringIdempotency` (new module `planning/steering-idempotency.ts`) holds, per `(surface, key)`, the fingerprint (directive id, resolved session, outcome, confirm flag) and the reply. Equal fingerprint: the stored reply is returned, with no port call and no audit row. Different: `idempotency-conflict`. Only an applied acknowledgement is stored. A refused one is not, so a retry runs again. The index is bounded at 10,000 entries, oldest evicted first.
- **D77-06 Serialization.** `SteeringIdempotency.serialize` runs the body for one `(surface, key)` after the previous body for that key settles. Two identical concurrent retries therefore see the first result instead of racing the inbox (where the second would be a `duplicate-directive` refusal). Different keys are not serialized against each other. The lane is a promise chain that never rejects, like the inbox lock.
- **D77-07 Sequence exposure.** A keyed reply (queued or acknowledged) carries `sequence`: the inbox's delivery sequence of the directive. An unkeyed reply does not gain the field, so unkeyed output is byte-identical to before. Every REST directive (`restDirective`, the listing and the wait reply) carries `sequence`, or `null` when the inbox does not hold the directive (a durable-history row after a restart). The field is additive.
- **D77-08 Ordering.** `/steering/wait` already delivers by sequence (`nextQueuedDirective`, `after` cursor). With the sequence in the reply, a reader can check order directly. No change to the order itself, so unkeyed delivery stays as it was.
- **D77-09 Errors.** `idempotency-conflict` is added to the refusal vocabulary (`SimpleSteeringCode`) and maps to HTTP 409, like the other conflicts.

## Limits, stated not hidden

These are process-local, like the inbox ordering they depend on. Durable replay across a restart is not fully met.

- **L77-01 Sequence across a restart.** Restored open directives take restore-order sequences. A keyed replay after a restart answers with the sequence the inbox now holds, which can differ from the one first returned. A durable sequence needs a column on the audit row, which is a migration and a schema decision for the owner.
- **L77-02 Keyed acknowledge replay after a restart.** The index is memory-only. A retry after a restart finds no stored reply, and the restored inbox does not hold a directive that was acknowledged before the restart, so the retry is refused with `not-found` (404). It is not replayed. A directive still open at the restart is held, and its keyed acknowledgement runs once as usual.
- **L77-03 Keyed queue replay for a directive acknowledged before a restart.** The restored inbox does not hold acknowledged directives, so the retry reaches the audit log, which refuses the second `queued` row as a conflict (`audit-unavailable`, 503). Nothing is written twice. The fix is a durable key index, which is the same owner decision as L77-01.
- **L77-04 Index bound.** Past 10,000 applied keyed acknowledgements, the oldest entry is evicted. A replay of an evicted key falls through to the inbox and is refused (`already-acknowledged`). Refused, not repeated.

None of these can apply a command twice. Each one turns a replay into an explicit refusal, not a second write.

## Non-goals

- No change to delivery priority ordering in `steeringNoticeFor`, `steering_list` or the directive listing (unkeyed behaviour stays).
- No new environment flag. The key is a request field, not configuration.
- No CLI change. The CLI can pass the field later without a server change.
