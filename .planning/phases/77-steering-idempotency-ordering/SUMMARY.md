# Phase 77: Steering idempotency and ordering - Summary

Implements the decisions in CONTEXT.md. Keyed `steering_queue` and `steering_acknowledge` calls apply once per `(surface, key)`, replay the original result with its sequence, and refuse a different request under the same key. Unkeyed calls take the code path they took before.

## Changes

| File | Change |
| --- | --- |
| `packages/mcp-server/src/planning/steering-idempotency.ts` | New. `keyedDirectiveId`, `queueFingerprint`, `acknowledgeFingerprint`, `SteeringIdempotency` (per-key lanes, bounded reply index). |
| `packages/mcp-server/src/planning/steering-tools.ts` | `idempotency_key` on both input schemas; `sequence?` on queued and acknowledged replies; keyed branches in `queueSteering` (`keyedQueue`) and both acknowledgement paths (`applyAcknowledgement`). `SteeringWiring.idempotency`. |
| `packages/mcp-server/src/planning/steering.ts` | `idempotency-conflict` in the refusal vocabulary. |
| `packages/mcp-server/src/planning/steering-rest.ts` | Body parsers accept `idempotency_key`; `restDirective(record, sequence)`; `sequence` on `RestDirective`; `idempotency-conflict` is 409. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` reply carries the directive's sequence. |
| `packages/mcp-server/src/service.ts` | Builds one `SteeringIdempotency` per process into the steering wiring. |
| `packages/mcp-server/src/mcp.ts` | Descriptions of `steering_queue` and `steering_acknowledge` name the key, the replay and the sequence. |
| `docs/live-steering.md` | Field table rows, an idempotency section, the restart limits. |
| Tests | `steering-idempotency.test.ts` (new, 9 tests); `steering-tools.test.ts` (12 new tests); `steering-rest.test.ts` (3 new tests; existing `restDirective` calls pass the new argument). |

## Criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A replayed keyed command returns the original result and writes nothing. | Met in process. Restart cases are limited (L77-02, L77-03). | `steering-tools.test.ts` "a replayed keyed queue returns the original reply and writes nothing"; "a replayed keyed acknowledgement returns the stored reply and writes no second row"; "a replayed keyed acknowledgement that moved the session does not move it again" (port called once); "two identical keyed acknowledgements running at once apply the directive once". |
| 2 | Unkeyed commands keep working unchanged. | Met. The unkeyed queue reply keeps its four fields (no `sequence`), ids stay fresh, and no dedupe happens. | "an unkeyed queue keeps its reply shape and a fresh id, and is never deduplicated"; the existing steering tests in the four narrow files pass; the only change to an existing test is the new argument on `restDirective`. |
| 3 | A keyed reply exposes its sequence; a replay returns the same sequence; two distinct commands are delivered in sequence order; `restDirective` exposes the sequence. | Met in process. The sequence is not durable across restart (L77-01). | "a replay keeps its sequence after later commands are queued"; "two distinct keyed commands are delivered in sequence order, and a replay does not reorder them" (`nextQueuedDirective` cursor); `steering-rest.test.ts` "a directive carries its delivery sequence"; the MCP replay test. |

## Also covered

- Same key, different request (other session, action, body, plan, conflict flag, or outcome/confirm for an acknowledgement): `idempotency-conflict`, 409, nothing written.
- Same key from another surface is a different command.
- A keyed command refused by the audit is not kept, so the retry applies it (`audit-unavailable` then one `queued` row).
- Keyed input validation: the event key rule; a malformed key answers `invalid idempotency_key` and never echoes the value.

## Deviations and open items

- **Durable sequence and key index are not built.** The roadmap goal says "applies once across retries". Within a process that holds. Across a restart it holds in the sense that nothing is applied twice, but the original reply may not come back, and the sequence may change for restored open directives. Closing that needs a sequence column on the audit row and a durable key table. That is a migration and a schema decision, so it is left for the owner. Limits are in CONTEXT.md (L77-01 to L77-04) and in `docs/live-steering.md`.
- Replays still write the access audit row for the tool call (the audit-before-effect rule of `executeLiveCall`). No steering state is written. The phrase "writes nothing" is read as "writes no steering transition and no session transition".
- The CLI (`packages/cli/src/steer/client.ts`) does not send `idempotency_key` yet. It is an additive field, so it can follow without a server change.
- The directive id for a keyed queue is `idem-` plus a hash. It is not a UUID, so `steering_queue` replies for keyed calls differ in id shape from unkeyed ones.
