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
