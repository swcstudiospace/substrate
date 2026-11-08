# Phase 77 — hardening summary (Track S)

Branch `gsd/v18-harden-live-steering`. Scope: the steering code, its tests, migration 43, `docs/live-steering.md`. Nothing was run:
every check below is for the orchestrator. Planning files `ROADMAP.md`, `STATE.md` and `77-VERIFICATION.md` were not edited.

## 1. Success criteria to named tests

Each row names the test(s) that prove the criterion at HEAD. The existing tests were read, not run.

**SC1, a replayed keyed command returns the original result and writes nothing**

- `steering.test.ts`: "a keyed replay returns the original record and writes nothing, even with no rate token left" (no append, no rate token, no state change).
- `steering.test.ts` (new): "a replay takes no sequence, so the next distinct command takes the number after the first" (no sequence advance).
- `steering-tools.test.ts`: "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write".
- `steering-tools.test.ts`: "a replayed keyed queue announces nothing: only the fresh queue wakes its session" (no wake-up on replay).
- `steering-durable.test.ts`: "a keyed retry after a restart returns the original record and sequence, even once the directive was acknowledged, and writes no audit row".
- `steering-idempotency.pg.test.ts` (PG-gated): "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value".

**SC2, unkeyed commands keep working unchanged**

- `steering.test.ts`: "an unkeyed repeat is a second directive, as before".
- `steering-tools.test.ts`: "an unkeyed queue keeps its reply shape, with no sequence" (asserts the reply's exact key set).
- `server.steering.test.ts`: "bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint".

**SC3, a keyed reply exposes its sequence, a replay returns the same one, two distinct commands deliver in sequence order**

- Keyed reply: `steering-tools.test.ts` "a keyed reply carries its sequence, …" (`sequence: 1`, replay `toEqual` first reply).
- Wait path: `server.steering.test.ts` "the wait body carries the delivery sequence of the directive it returns"; `steering-waiters.test.ts` "each directive carries its sequence in its own session, and an after cursor walks one session in queue order".
- REST directive read: `steering-rest.test.ts` "a held directive reports its sequence, and the listing reports the same number in queue order".
- Order under concurrency (new): `steering.test.ts` "eight concurrent distinct keyed queues take gapless sequences, and the wait cursor delivers them in that order".
- Order across restart: `steering-durable.test.ts` "after a restart the next distinct command takes the next sequence, and a restored directive keeps its own".

**SC3 gap as written in the ROADMAP ("`restDirective` omits the sequence"), status: already closed.** At HEAD `restDirective(record, sequence: number | null)` takes the sequence as a required argument. Its two call sites pass it: `server.ts` (wait body, `waited.sequence`) and `steering-rest.ts` `listRestDirectives` (`inbox.sequenceOf`). The keyed queue reply gets its `sequence` in `steering-tools.ts` `queueSteering`. Commits `ce06da4d` and `9b3636ab` made this change. No code change was needed for item 2. The unkeyed reply is unchanged (see SC2).

## 2. Hardening items (step 7)

| Item | Disposition | Evidence |
|---|---|---|
| a. Replayed keyed command writes nothing | Covered by existing tests; one test added for sequence | §1 SC1 |
| b. Unavailable store is an explicit rejection | Covered; two tests added for a failing replay lookup and a failing sequence take | `steering.test.ts` "a replay lookup that fails is audit-unavailable, …", "a sequence the store cannot take is audit-unavailable, …"; existing `steering.test.ts` "a queue that cannot be audited stores nothing and returns a typed error" |
| c. Concurrent keyed submits keep sequence order | Test added (memory store); PG same-key race already covered | `steering.test.ts` "eight concurrent distinct keyed queues …"; `steering-idempotency.pg.test.ts` "two concurrent keyed commands through two instances queue one directive and both get its reply" |
| d. Cancel versus apply yields one terminal state | Test added. The steering vocabulary has no "cancel" verb, so the race is `applied` against `declined` on one directive (the other terminal path, live-session close, is a separate boundary) | `steering.test.ts` "applied and declined racing on one directive leave one terminal state and one acknowledgement" |
| e. Owner-only refusals unchanged | No behaviour change; existing tests kept | `server.steering.test.ts` "bound nonoperator writes403, …" (403 `operator-required`); "MCP and REST owner/sibling refusals are equivalent with trusted ports"; `steering-tools.test.ts` "surface allowlist is checked after bound operator admission" |
| f. Structured logs carry no payload text | Covered by an existing test; the lines carry counts, codes and a redacted error message only | `steering-delivery.test.ts` "a hint the ledger did not store, or that threw, is not counted as sent and may be retried" (asserts the line does not contain the secret-shaped body text) |

No production code changed. Nothing beyond the seven items was added.

## 3. Owner items H3, H5, H6, T8

- **H3 (audit-refusal error code, `steering.ts` ~769-780 and ~582-593): owner decision, code unchanged.** The refusal path returns a typed `audit-unavailable` (D10, D11), which matches the documented behaviour. The code the operator sees is a choice, not a defect. Observation (not executed, [INFERENCE]): `audit()` retries inside the same `sql.begin` unit. After the first failed statement, the retries run against an aborted transaction, so `lastErrorCode` may report the aborted-transaction code rather than the driver's first error. Options: (A) keep the current behaviour and document that `lastErrorCode` is the last attempt's code; (B) make the audit inside a unit run once (`attempts: 1`) and report the first driver code; (C) keep the retries outside the unit. Owner picks one.
- **H5 (pull path ordering): owner decision, code unchanged.** The current behaviour: the wait cursor delivers in sequence order; `steering_list`, `GET /steering/directives` and the docs_search and brief notices order by priority (`compareDirectives`). Options: (A) pull reads gain sequence order for keyed commands only; (B) the rule is narrowed to the wait cursor (the wording in `docs/live-steering.md` now states this).
- **H6 (planning-document status text): handled by the orchestrator.** Not edited here; `ROADMAP.md` and `STATE.md` are orchestrator-owned.
- **T8 (documented ordering rule): done.** `docs/live-steering.md` line 35 was rewritten to state what each read path guarantees today: the wait cursor in sequence order; `steering_list`, `GET /steering/directives` and the docs_search and brief notices by priority; the REST list and wait body carry `sequence`, the MCP `steering_list` rows do not; no order across target sessions. This is a factual correction, not a choice. Which option H5 takes remains the owner's.

## 4. Migration 43 evidence

- Test: `planning/steering-idempotency-migration.pg.test.ts`, "up adds the tables, the column and its check; down removes exactly those; up again restores them".
- Method: a throwaway database `substrate_m43_<base36 time>_<random>` created with `create database` from the SUBSTRATE_TEST_PG_URL role. `IndexStore.migrate()` runs with `steering-audit` on. The test checks the two tables, the `planning_steering_audit.delivery_sequence` column (bigint, nullable), and its constraint (`delivery_sequence >= 1`) in the catalog. It then runs the step's `down` and checks those objects are gone while `planning_steering_audit` remains. It runs the step's `up` again and checks the shape matches the first up. `afterAll` drops the database `with (force)`.
- The shared `substrate_test` database is not altered. No real store is touched.
- Not done: applying migration 43 to a restored rehearsal copy stays an operator item (runbook `rollback-compat.md`, steps 33, 34 and 43). Not run in this environment.

## 5. Decision entries (for ROADMAP)

- D77-H3: audit-refusal error code. Owner options A, B, C in §3.
- D77-H5: pull-path ordering. Owner options A, B in §3. The docs match the current code under option B.
- D77-T8: documented ordering rule now matches the code (docs/live-steering.md:35). Closed as a factual correction.
- D77-SC3: the `restDirective` sequence gap is already closed at HEAD (§1). No change.
- D77-HARDEN-1: no code path was changed; the three new inbox tests and the migration test are the whole diff.

## 6. Checks for the orchestrator

- `bun test packages/mcp-server/src/planning/steering` (covers `steering*.test.ts`, including `steering-idempotency-migration.pg.test.ts` with the PG skips when `SUBSTRATE_TEST_PG_URL` is unset).
- `SUBSTRATE_TEST_PG_URL=… bun test packages/mcp-server/src/planning/steering-idempotency.pg.test.ts packages/mcp-server/src/planning/steering-idempotency-migration.pg.test.ts` (PG run: the migration test needs a role that can create databases).
- `bunx tsc --noEmit` (new test code: `override` methods in `DownStore`, `connectionLost`, the `SQL` null narrowing in the migration test).

## 7. Open risks

- R3 (carried from 77-01): the Bun SQL adapter and migration 43 were not executed in this track. The PG runs in §6 are the first execution.
- `steering-durable.test.ts` and the PG file use fakes and the scratch database; a fake that differs from real SQL behaviour is not caught here.
