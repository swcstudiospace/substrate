---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-18T12:25:01Z
status: human_needed
score: 5/8 must-haves verified
covered_files:
  - ".env.example"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-PLAN.md"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-SUMMARY.md"
  - "docs/config-reference.md"
  - "docs/live-steering.md"
  - "docs/runbooks/rollback-compat.md"
  - "packages/mcp-server/src/config.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/index-store.migrate-contract.test.ts"
  - "packages/mcp-server/src/index-store.migrate-harness.test.ts"
  - "packages/mcp-server/src/index-store.migrations.digests.json"
  - "packages/mcp-server/src/index-store.ts"
  - "packages/mcp-server/src/live-session-restart.pg.test.ts"
  - "packages/mcp-server/src/mcp.ts"
  - "packages/mcp-server/src/planning/steering-durable.test.ts"
  - "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
  - "packages/mcp-server/src/planning/steering-rest.test.ts"
  - "packages/mcp-server/src/planning/steering-rest.ts"
  - "packages/mcp-server/src/planning/steering-store.ts"
  - "packages/mcp-server/src/planning/steering-tools.test.ts"
  - "packages/mcp-server/src/planning/steering-tools.ts"
  - "packages/mcp-server/src/planning/steering-waiters.test.ts"
  - "packages/mcp-server/src/planning/steering-waiters.ts"
  - "packages/mcp-server/src/planning/steering.test.ts"
  - "packages/mcp-server/src/planning/steering.ts"
  - "packages/mcp-server/src/server.steering.test.ts"
  - "packages/mcp-server/src/server.ts"
  - "packages/mcp-server/src/service.ts"
covered_digest: "v3:sha256:07ec607b4c5692064f205ac2646c31659846f0c77d3cdd13519d340c18df7b78"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/8
  previous_verified: 2026-11-02T10:04:50Z
  previous_commit: 9b3636ab
  current_commit: 357d6b15
  gaps_closed: []
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres: PG test skipped, no Postgres in this environment"
    - "T6: audit-plus-claim atomicity through Postgres: unexecuted"
    - "T7 (W2): cross-process single winner through Postgres: unexecuted"
    - "HARD-H1 ownership: REQUIREMENTS.md maps HARD-H1 to phase 77; PLAN 77-01 has no requirements field"
    - "D-1: a concurrent keyed loser still takes a sequence number (owner decision outstanding)"
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "Set SUBSTRATE_TEST_PG_URL, migrate with steering-audit on, then run steering-idempotency.pg.test.ts once. Also queue a keyed command through one process, restart, repeat the key within the retention window, then queue a distinct command."
    expected: "The saved replay is returned exactly by the second instance with no audit row written. The distinct command takes the next number. Expired rows are pruned and rows beyond the cap are deleted."
    why_human: "The restart suite (steering-durable.test.ts:883-922) uses MemorySteeringIdempotencyStore as a stand-in. steering-idempotency.pg.test.ts is describe.skip without SUBSTRATE_TEST_PG_URL (steering-idempotency.pg.test.ts:13), and no Postgres is available here. Migration 43 and bunSteeringIdempotencyStore have never executed."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "On Postgres, force an audit insert to fail inside a keyed claim, then retry the same key. Separately, lose the reply after commit and retry."
    expected: "A refused audit leaves no queued row and no replay record, and the retry queues once. A reply lost after commit replays on retry and is never queued twice."
    why_human: "The atomicity is one sql.begin in steering-store.ts:689-715 with the audit written through tx. The inbox tests use an in-memory store with no transaction to roll back. The PG test 'a claim whose unit fails keeps no replay record' (steering-idempotency.pg.test.ts:93) is skipped here."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "Run steering-idempotency.pg.test.ts case 'two concurrent keyed commands through two instances queue one directive and both get its reply' against Postgres."
    expected: "One queued audit row for the session. One caller sees replayed false and the other replayed true, with the same directive id."
    why_human: "The single winner rests on insert ... on conflict (scope_key) do nothing (steering-store.ts:694), which only the database can exercise. The test (steering-idempotency.pg.test.ts:122) is skipped here."
coincidental_reliance_items: []
human_verification:
  - test: "Run steering-idempotency.pg.test.ts (4 tests) once against a migrated Postgres database with SUBSTRATE_TEST_PG_URL set."
    expected: "All 4 pass. The afterAll hook deletes only rows whose session starts with the run prefix."
    why_human: "No Postgres in this environment. Covers T5, T6 and T7."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it (the migration header requires this rehearsal)."
    expected: "Forward and reverse both succeed; the migration digest in index-store.migrations.digests.json matches; the three objects are present forward and absent after reverse."
    why_human: "Needs a database. Migration 43 has never run."
  - test: "Owner decisions: (a) accept that a losing concurrent keyed caller consumes one sequence number, or move the nextSequence take inside the claim (steering.ts:532, claim at :546); (b) HARD-H1 ownership: add requirements: [HARD-H1] to 77-01-PLAN.md or re-map it; (c) confirm docs/live-steering.md:35 is the one out-of-order rule."
    expected: "A decision recorded in 77-01-PLAN.md or in REQUIREMENTS.md."
    why_human: "Owner decisions; the verifier cannot make them."
---

# Phase 77: Steering idempotency and ordering: Verification

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-18T12:25:01Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (2026-11-02, commit `9b3636ab`) is re-checked against HEAD `357d6b15` on `gsd/autonomous-rerun`. Commit `05cdf2c6` (the merge of this phase's branch) is an ancestor of HEAD.

## What changed since the prior record

- `git diff 9b3636ab HEAD -- packages/mcp-server/src/planning/` touches one file: `steering-waiters.ts` (2 insertions, 1 deletion). It moves the timer clear to after `this.total -= 1` in `finish`, so a timer observer sees the waiter gone. No steering contract changes.
- `steering.ts`, `steering-store.ts`, `steering-rest.ts`, `steering-tools.ts`, `index-store.ts` (migration 43), `server.ts` (wait route) and `service.ts` steering wiring are byte-identical to `9b3636ab` for this phase's logic. Later commits in `service.ts`, `server.ts`, `mcp.ts` and `index-store.ts` belong to phases 71-76 and 78.
- No gap from the prior record is closed or reopened by this run. The Postgres-gated truths still have no database to run against.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (in-process) | Replay check runs under the inbox lock after validation and authorisation and before the duplicate, rate and audit checks: `steering.ts:517` (`findReplay`) then `replayOf` (`:571-576`), which returns the held record with `replayed: true` and runs no audit, no token spend, no state change. Tests: `steering.test.ts` replay tests, `steering-tools.test.ts:217` ("a keyed reply carries its sequence, and a replay returns the same reply with no..."), all PASS in the targeted run. Caveat: a concurrent loser still runs the `nextSequence` upsert (`steering.ts:532`) before its claim, see D-1. |
| 2 | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | `steering-tools.ts:153-159`: an unkeyed call returns `{status, directive_id, target_session_id, queued_at_ms}` with no `sequence`; the keyed branch adds `sequence`. Unkeyed directives gain `sequence` on the read shape only (R5), which is additive. Unkeyed path audits and queues as before (`steering.ts:537-541`). |
| 3 | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156`. Replay restores the stored number: `steering.ts:572-580` (`replayOf` takes `held.sequence`). Test PASS. |
| 4 | SC3b: two distinct commands are delivered in sequence order, and `restDirective` and the wait expose the sequence | ✓ VERIFIED | Queue order sorts by sequence (`steering.ts:456-462`). The wait cursor walks sequence (`steering-waiters.ts:63-67`). `restDirective(record, sequence)` includes `sequence` (`steering-rest.ts:82-83`, `:97-107`). `GET /steering/wait` body carries `sequence` (`server.ts:2229`; `server.steering.test.ts:243-251` PASS). |
| 5 | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired. Migration 43 has the three tables and the nullable column (`index-store.ts:915-937`). The Bun adapter `bunSteeringIdempotencyStore` (`steering-store.ts:664-717`) is wired through `steeringIdempotency()`. The restart tests (`steering-durable.test.ts:883-922`) use `MemorySteeringIdempotencyStore`, so they prove the inbox's use of the port, not durability. The PG test is skipped here. |
| 6 | W1: a lost or refused audit reply cannot double-apply a keyed command | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code: the keyed path takes the claim with the audit inside it (`steering.ts:546`, `claimKeyed` `:582-593`). The adapter runs `queue(tx)` inside `sql.begin` (`steering-store.ts:689`, `:705`). A refused audit throws `AuditRefused`, which rolls the claim back. Inbox tests `steering-durable.test.ts:948` and `:960` pass against the memory store. SQL atomicity unexecuted. |
| 7 | W2: two processes that accept the same key concurrently queue one directive | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Scope key is `JSON[author, session, key]` (`steering.ts:513`) and is the primary key (`index-store.ts:923-925`). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:694`). Code is atomic; unexecuted. |
| 8 | Per-session delivery order is documented | ✓ VERIFIED | `docs/live-steering.md:33` states the durable keys, the sequence and the bounds. `docs/live-steering.md:35` states delivery order per target session and no order across target sessions. Matches `steering.ts:456-462` and `steering-waiters.ts:63-67`. |

**Score:** 5/8 truths verified (3 present, behavior-unverified: T5, T6, T7).

### Targeted test run (this verification)

`bun test` on the phase's seven test files (`steering.test.ts`, `steering-durable.test.ts`, `steering-rest.test.ts`, `steering-tools.test.ts`, `steering-waiters.test.ts`, `server.steering.test.ts`, `steering-idempotency.pg.test.ts`): **180 pass, 6 skip, 0 fail** (186 tests, 7.16 s).

- The 6 skips: 4 are the `describe.skip` block in `steering-idempotency.pg.test.ts` (gated on `SUBSTRATE_TEST_PG_URL`). The other 2 are not identified by a `skip` marker in these files; the same unidentified pair was recorded in the prior run (D-3). Not resolved here.
- Full workspace suite not run, per the one-run rule.

### Deferred Items

None. The one later phase with overlapping scope (phase 78, ledger and cross-layer reconciliation) does not address the steering idempotency gaps.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED | Keyed path `:503-550`, `replayOf` `:571`, `claimKeyed` `:582`, `MemorySteeringIdempotencyStore` `:329-355`. Wired: `service.ts`, `steering-tools.ts`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with unit, Bun idempotency adapter | ✓ VERIFIED (unexecuted SQL) | `bunSteeringIdempotencyStore` `:664-717`. |
| `packages/mcp-server/src/index-store.ts` | Migration 43 | ✓ VERIFIED (unexecuted) | `:915-937`, expand with reversible `down` at `:919`. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | `:148-159`. Wake only on fresh queue (`outcome.freshlyQueued`). |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries key and sequence | ✓ VERIFIED | `:82-83`, `:97-107`, `:179` (QUEUE_FIELDS includes `idempotency_key`), `:213`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `:63-67`, `:122`, `:177`. Changed since prior record: timer-clear ordering only. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `:2229`. |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED | `:33`, `:35`. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | TTL and cap settings | ✓ VERIFIED | `flag-registry.ts:344-345` (`..._TTL_S` default 86400, `..._CAP` default 10000); `config.ts:783`. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `SteeringInbox.enqueueReceipt` | `:148-150` | ✓ WIRED | `replayed` drives `freshlyQueued` |
| `steering-tools.ts` | `onQueued` wake hook | `:163` | ✓ WIRED | only on fresh queue |
| `steering.ts` keyed path | `store.claimReplay` | `:546` → `claimKeyed` `:582` | ✓ WIRED | audit runs inside `unit` |
| `steering-store.ts` claim | `sql.begin` transaction | `:689` | ✓ WIRED (unexecuted) | `queue(tx)` at `:705` |
| `steering-rest.ts` restDirective | `inbox.sequenceOf` | `:155` | ✓ WIRED | |
| `server.ts` wait route | waiter sequence | `:2229` | ✓ WIRED | test PASS |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| keyed reply | `sequence` | `inbox.sequenceOf` ← `nextSequence` or `held.sequence` | Yes (memory store in tests; Postgres sequence row in production, unexecuted) | ✓ FLOWING (in-process); ⚠️ DB path unexecuted |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Keyed replay, sequence, restart suite, REST and wait shapes | `cd packages/mcp-server && bun test src/planning/steering.test.ts src/planning/steering-durable.test.ts src/planning/steering-rest.test.ts src/planning/steering-tools.test.ts src/planning/steering-waiters.test.ts src/server.steering.test.ts src/planning/steering-idempotency.pg.test.ts` | 180 pass, 6 skip, 0 fail | ✓ PASS |
| Postgres replay, claim atomicity, concurrent winner | `steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` | not run (no database) | ? SKIP (human) |

### Probe Execution

No probes are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client key and per-session monotonic sequence; same-key same-payload replay returns the identical original result; changed payload refused | ⚠️ ORPHANED (ownership) | `REQUIREMENTS.md:124,139` maps HARD-H1 to phase 77 ("Not started"). The behaviour is implemented (truths 1-4, 8), so this is a bookkeeping gap for the owner. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/planning/steering.ts` | `:532` | `nextSequence` taken before the keyed claim | ⚠️ Warning | A concurrent loser performs a counter upsert and consumes a number: a gap, never a duplicate. SC1 says "writes nothing" (D-1). |
| `packages/mcp-server/src/planning/steering.ts` | `:329-355` | `MemorySteeringIdempotencyStore` used by the restart suite | ℹ️ Info | The durable claims are proven only through the port, not the database (D-5). |
| `.planning/phases/77-steering-idempotency-and-ordering/77-01-PLAN.md` | D11, R1 | plan text contradicts the code (D-6) | ℹ️ Info | The SUMMARY and code agree; the plan text is stale. |

No `TBD`, `FIXME` or `XXX` markers in the phase's implementation files.

### Deviations and Evidence Notes

- **D-1 (SC1 "writes nothing").** A concurrent keyed loser takes a counter number before the claim (`steering.ts:532`). Sequential replays write nothing, which the tests show. Matches SUMMARY revision 3 residual; PLAN 77-01 does not record it. Owner decision outstanding.
- **D-2 (retry inside a transaction).** [INFERENCE] from Postgres transaction semantics, not executed.
- **D-3 (test counts).** This run: 180 pass, 6 skip, 0 fail on the seven files (a different file set and count from the prior run's 201 / 205). The 4 PG skips are confirmed. The other 2 skips are unidentified.
- **D-4 (full suite).** Not run. The prior full-suite result at the merge commit is not re-derived here.
- **D-5 (restart evidence).** The "restart" tests share `MemorySteeringIdempotencyStore`. They prove the inbox's use of the port, not durability.
- **D-6 (stale plan text).** PLAN 77-01 D11 and R1 contradict the code.
- **D-7 (scope key).** Code, PLAN D2 and SUMMARY revision 3 agree: the replay is keyed on (author, session, key).
- **D-8 (steering-waiters reorder).** Changed since the prior record: timer clear moved after the waiter is removed. Targeted tests pass.
- **D-9 (mode).** Re-verification mode. The prior record is carried in `re_verification`.

---

_Verified: 2026-11-18T12:25:01Z_
_Verifier: Claude (gsd-verifier)_
