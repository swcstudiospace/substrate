# Phase 77: Steering idempotency and ordering - Verification

## Commands run

| Command | Result |
| --- | --- |
| `bunx tsc --noEmit` (repo root) | One run. It reported three type errors, all in the new test block of `steering-tools.test.ts` (a refusal literal widened `status` to `string`). Fixed with `as const`. The implementation files typechecked clean in that run. **Not re-run after the fix.** |
| `bun test` on `steering-idempotency.test.ts`, `steering-tools.test.ts`, `steering-rest.test.ts`, `server.steering.test.ts` | 88 pass, 0 fail (includes the 24 new tests). |
| `bun test` on `steering-wiring.test.ts`, `mcp.steering.test.ts`, `planning/steering-durable.test.ts`, `planning/steering-waiters.test.ts`, `planning/steering-delivery.test.ts`, `planning/steering-store.test.ts` | 168 pass, 0 fail. |

No full `bun test` run. The shared rules limit the run to narrow files.

## Criteria

| Criterion | Check | Result |
| --- | --- | --- |
| 1. Replayed keyed command returns the original result and writes nothing | Queue replay returns a deep-equal reply and adds no audit row or directive. Acknowledgement replay returns the stored reply; the session port is called once; no second audit row. Two identical concurrent acknowledgements produce one `acknowledged` row. | Pass (in process) |
| 2. Unkeyed commands unchanged | Unkeyed queue reply has exactly `status, directive_id, target_session_id, queued_at_ms`; ids are fresh; no dedupe. Existing steering tests pass. | Pass |
| 3. Sequence exposed, replayed equal, delivered in order | Keyed queue and acknowledgement replies carry `sequence`; a replay after later commands returns the same value; `nextQueuedDirective` yields first then second and stops; `queuedFor` order is preserved after a replay; `restDirective` and the REST listing carry `sequence` (null when not held). | Pass (in process) |

## Refusal and validation cases

| Case | Test | Result |
| --- | --- | --- |
| Same key, different body / action / session / plan-independent fields | "the same key with a different request is refused and writes nothing" | `idempotency-conflict`, nothing written |
| Same key, different outcome or confirm on an acknowledgement | "a keyed acknowledgement with another outcome under the same key is refused" | `idempotency-conflict` |
| Same key from another surface | "the same key from another surface is a different command" | Different directive id |
| Audit refused the first attempt | "a keyed command refused by the audit is not kept: the retry applies it" | Retry applies once |
| Malformed key over REST | `steering-rest.test.ts` "the queue and acknowledge bodies take an idempotency key..." | 400 `invalid idempotency_key`, value not echoed |
| `idempotency-conflict` HTTP status | `steering-rest.test.ts` "an idempotency conflict answers 409" | 409 |
| MCP schema | "the MCP tools expose idempotency_key..." | Field present on both tools; MCP replay answers the same reply |

## Gaps

- **Restart behaviour is verified by reasoning, not by a test.** The restart paths (L77-01 to L77-03 in CONTEXT.md) were not exercised. The inbox restore path has its own tests (`steering-durable.test.ts`), which still pass. A test that restarts a durable inbox and replays a keyed command would need the Postgres harness (`*.pg.test.ts`), which was not run here.
- **Eviction** (L77-04) is covered for the index class ("evicts the oldest reply past the bound") but not for the end-to-end path.
- **Final `tsc`** after the `as const` fix was not re-run, per the shared rules.

## Closure of L77-01 to L77-04 (2026-11-11, branch `reconcile/main-2026-11-11`)

Scope: the restart limits in CONTEXT.md. Migration step 44 `planning_steering_audit_delivery` (additive, opt-in `steering-audit`, expand) gives every queued row its `delivery_sequence`, and gives keyed rows their surface, key and request fingerprint, with the partial unique index `planning_steering_audit_idempotency_key` on `(transition, idempotency_surface, idempotency_key)`: that index is the durable key index. Migration step 45 `planning_steering_movements` (also phase 67) records each acknowledgement's session-state result.

| # | Gap | Status | Closure and evidence |
| --- | --- | --- | --- |
| L77-01 | Sequence not durable across restart | CLOSED | Queued rows store the sequence. Restore keeps it, and the counter is seeded from the table's maximum, so a directive queued after a restart never ties a restored one (`steering.ts` `doRestore`, `seedSequence`; `steering-store.ts` `readSequenceFloor`). Test: `steering-idempotency.pg.test.ts` "delivery sequence is kept across a restart, and a directive queued after it sorts last". |
| L77-02 | Keyed ack replay after restart refused `not-found` | CLOSED | The keyed reply is durable (step 44 key, step 45 session result). The live-session boundary resolves an acknowledged directive's target session from the log when the inbox no longer holds it (`steering-tools.ts` `prepareReserved`; `service.ts` `resolveDurableDirective`), so the replay is answered and not refused as unknown. Tests: "a keyed acknowledgement replays after a restart with the same reply, and drives no second session move"; "a keyed acknowledgement retried under another request after a restart is refused, and moves nothing". |
| L77-03 | Keyed queue for a pre-restart directive refused `audit-unavailable` | CLOSED | A keyed queue looks up its surface and key in the log before enqueueing (`steering-tools.ts` `keyedQueue`), replays the stored reply, and refuses a different request with `idempotency-conflict`. Test: "a keyed queue retried after its directive was acknowledged before a restart replays, and is not refused". |
| L77-04 | Index bounded at 10,000 keyed acks | CLOSED | The in-process index is now a cache. Past its bound a replay reads the log instead of being refused (`steering-tools.ts` `applyAcknowledgement`). The eviction branch has no direct test, since it needs 10,000 keyed acknowledgements; the restart tests run the same fall-through, because a new process starts with an empty index. |

Keys stay scoped to the caller's surface (D77-02): the surface and key are the lookup, and the target session is part of the request fingerprint, so one key reused for another session is `idempotency-conflict`. The assignment's "(session, idempotency key)" is read as this scope; no decision was changed.

Evidence was run here. `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts`: 6 of 6 pass against a disposable `postgres:16`, in a database of their own that the test creates and drops. The narrow set of 23 files (the steering suites, `index-store.migrate*`, `rollback-compat`, `corpus/store`, `corpus/reflect-store`, `corpus/reflect-service`, `live-session-restart.pg`, `live-session-authority.pg`) passes with `SUBSTRATE_TEST_PG_URL` set: 487 pass, 0 fail. `bunx biome check` is clean on the touched files.

Residual, by design: the step-45 row is written after the session port answers, because the audit row must be written before the effect. A crash between the two replays the acknowledgement without `session_state` and without a hint. That fails safe, and nothing is applied twice.

Operator gate, not run: rehearse migration steps 44 and 45 on a restored production dump before `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` is enabled in production (`docs/runbooks/rollback-compat.md`, the rows for steps 44 and 45). No production migration, flag change or hook installation was performed.
