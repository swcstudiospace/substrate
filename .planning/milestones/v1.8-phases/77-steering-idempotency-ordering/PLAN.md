# Phase 77: Steering idempotency and ordering - Plan

Decisions and limits: see CONTEXT.md (D77-01 to D77-09, L77-01 to L77-04).

## Tasks

1. **Vocabulary and key.** `steering.ts`: `idempotency-conflict` joins the refusal union. `steering-tools.ts`: optional `idempotency_key` (`IDEMPOTENCY_KEY_PATTERN`) on `STEERING_QUEUE_INPUT` and `STEERING_ACKNOWLEDGE_INPUT`.
2. **Index module.** New `planning/steering-idempotency.ts`: `SteeringIdempotency` (per-key lane `serialize`, bounded `remember`/`recall`), `keyedDirectiveId`, `queueFingerprint`, `acknowledgeFingerprint`.
3. **Queue.** `queueSteering`: keyed path inside the caller's live-call wrapper. Replay from the inbox record; conflict refusal; first keyed application under the derived id, with `sequence`. Unkeyed path unchanged.
4. **Acknowledge.** `acknowledgeSteering` and `acknowledgeSteeringWithState`: the effect goes through `applyAcknowledgement`. Keyed: replay from the index, conflict refusal, applied replies kept with `sequence`. Unkeyed: the effect runs as before.
5. **Wiring.** `SteeringWiring.idempotency`; `service.ts` builds one `SteeringIdempotency` per process.
6. **REST.** Body parsers accept `idempotency_key`; `restDirective(record, sequence)` with `sequence` on every `RestDirective`; `listRestDirectives` passes `inbox.sequenceOf`; `idempotency-conflict` maps to 409; `server.ts` wait reply passes the sequence.
7. **MCP.** Tool descriptions name the key, the replay and the sequence. The input schema is the shared zod object, so REST and MCP expose the same field.
8. **Docs.** `docs/live-steering.md`: request field, replay and conflict behaviour, `sequence`, the restart limits.
9. **Tests.** `steering-idempotency.test.ts` (new), `steering-tools.test.ts` (new describe block), `steering-rest.test.ts` (new describe block; existing `restDirective` calls pass the sequence argument).
10. **Checks.** `bunx tsc --noEmit` (repo root) once; the narrow test files once. See VERIFICATION.md.
