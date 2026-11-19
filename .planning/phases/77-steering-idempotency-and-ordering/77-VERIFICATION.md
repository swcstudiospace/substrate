---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-02T10:04:50Z
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
covered_digest: "v3:sha256:eb8f58d54e5293979e42e86612aa60e786d7dd369effdb16a5427ee83fad7b0c"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5
  gaps_closed:
    - "W1 lost audit reply double-apply: the audit row and the replay claim share one sql.begin (steering-store.ts:689-711, steering.ts:546-549); inbox-level tests pass (steering-durable.test.ts:948, :960). The SQL atomicity itself is still unexecuted (see T6)."
    - "GET /steering/wait body carries sequence (server.ts:2229; server.steering.test.ts:249 PASS)"
    - "Ordering rule documented (docs/live-steering.md:35)"
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres: PG test skipped, no Postgres in this environment"
    - "T7 (W2): cross-process single winner: code is atomic, unexecuted"
    - "HARD-H1: no plan claims it (ORPHANED)"
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "Set SUBSTRATE_TEST_PG_URL, migrate with steering-audit on, then run steering-idempotency.pg.test.ts once. Also queue a keyed command through one process, restart, repeat the key within the retention window, then queue a distinct command."
    expected: "The saved replay is returned exactly by the second instance with no audit row written. The distinct command takes the next number. Expired rows are pruned and rows beyond the cap are deleted."
    why_human: "The restart suite (steering-durable.test.ts:873-929) uses MemorySteeringIdempotencyStore as a stand-in. steering-idempotency.pg.test.ts is describe.skip without SUBSTRATE_TEST_PG_URL, and no Postgres is installed here. Migration 43 and bunSteeringIdempotencyStore have never executed."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "On Postgres, force an audit insert to fail inside a keyed claim, then retry the same key. Separately, lose the reply after commit and retry."
    expected: "A refused audit leaves no queued row and no replay record, and the retry queues once. A reply lost after commit replays on retry and is never queued twice."
    why_human: "The atomicity is one sql.begin in steering-store.ts:689-711, with the audit written through tx (steering-store.ts:298). The inbox tests use an in-memory store, which has no transaction to roll back. The PG test 'a claim whose unit fails keeps no replay record' is skipped here."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "Run steering-idempotency.pg.test.ts case 'two concurrent keyed commands through two instances queue one directive and both get its reply' against Postgres."
    expected: "One queued audit row for the session. One caller sees replayed false and the other replayed true, with the same directive id."
    why_human: "The single winner rests on insert ... on conflict (scope_key) do nothing (steering-store.ts:694), which only the database can exercise. The test is skipped here."
coincidental_reliance_items: []
human_verification:
  - test: "Run steering-idempotency.pg.test.ts (4 tests) once against a migrated Postgres database with SUBSTRATE_TEST_PG_URL set."
    expected: "All 4 pass. The afterAll hook deletes only rows whose session starts with the run prefix."
    why_human: "No Postgres in this environment. Covers T5, T6 and T7."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it (the migration header requires this rehearsal before production)."
    expected: "The migration applies and reverses cleanly. Reversal drops planning_steering_audit.delivery_sequence and the two new tables, so stored sequence values in that column are lost. The audit rows themselves remain."
    why_human: "Needs a live database and an operator rehearsal."
  - test: "On Postgres, force an audit failure inside a keyed claim and observe the reported error code."
    expected: "The queue is refused as audit-unavailable, the claim rolls back, and nothing is queued. lastErrorCode may show the aborted-transaction code rather than the original driver error, because steering.ts:769-779 retries the audit inside the same transaction. Decide whether to accept this or fail fast inside the transaction."
    why_human: "Behavior under a real Postgres transaction abort is code reasoning here ([INFERENCE]). No double-apply follows from it."
  - test: "Owner decision on the concurrent-loser counter gap."
    expected: "A decision recorded in 77-01-PLAN.md. Either accept that a losing keyed caller consumes one sequence number (SC1 says it writes nothing), or move the nextSequence take (steering.ts:532) inside the claim transaction so only the winner takes a number."
    why_human: "The number is taken before the claim (steering.ts:532, claim at :546), so a concurrent loser performs a counter upsert. Sequential replays write nothing. This is a documented residual in SUMMARY revision 3, not yet an owner decision."
  - test: "Owner decision on HARD-H1 ownership and its out-of-order rule."
    expected: "Either add HARD-H1 to a plan's requirements field, or re-map it with the owner's approval. Also decide whether docs/live-steering.md:35 is the one documented out-of-order rule. It states per-session sequence order but does not say what a number skipped by a refused or lost keyed command means to a reader."
    why_human: "REQUIREMENTS.md:124 is unchecked and :139 says Not started. PLAN 77-01 has no requirements field. Closing this is a planning edit the verifier cannot make."
  - test: "Reconcile stale status and plan text before merge."
    expected: "77-01-PLAN.md D11 and R1 are updated to the claim-in-transaction behavior (the replay save no longer runs after the audit, and a failed claim fails the queue). ROADMAP.md:147 and :1330-1334 stop saying Not started and Plans: none written. REQUIREMENTS.md:124 and :139 are updated."
    why_human: "Documentation reconciliation needs the owner or orchestrator."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-02T10:04:50Z
**Status:** human_needed
**Re-verification:** No, in the procedure's sense. Step 0 found no `gaps:` block in the prior record (human_needed, 4/5, first pass), so this is initial mode. The prior record is carried in `re_verification` metadata. This is a second pass after hardening commit 9b3636ab.

**Scope:** worktree `/root/src/worktrees/as-gsd-v18-p77`, HEAD 9b3636ab, on merge 9f39db90. Phase commits: ce06da4d (feature) and 9b3636ab (hardening). No code was edited, nothing committed, and the full suite was not run.

**Contract:** the three roadmap success criteria, verbatim from `.planning/ROADMAP.md:1330-1345` on this branch (Step 2a). PLAN 77-01 has no `must_haves` block, so Steps 4 and 5 are not applicable (`verify.artifacts` and `verify.key-links` exit 66). The roadmap criteria are the must-haves.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: A replayed keyed command returns the original result and writes nothing | ✓ VERIFIED | Replay runs after validation and authorisation and before the duplicate, rate and audit checks: `steering.ts:513-520`. A live record returns `replayed: true` through `replayOf` (`steering.ts:572-580`) with no audit append, no rate token and no state change. A different fingerprint is `idempotency-conflict` (`steering.ts:573`). Wake-up is suppressed for a replay: `steering-tools.ts:150`, `:159`. Named tests PASS in the targeted run: `steering.test.ts:406` ("a keyed replay returns the original record and writes nothing, even with no rate token left"), `steering.test.ts:417` (conflict), `steering-durable.test.ts:883` (retry after restart, memory stand-in). Deviation: the replay check runs before the counter, but a concurrent loser (T6/T7 path) still takes a counter number at `steering.ts:532`. See Deviations D-1. |
| 2 | SC2: Unkeyed commands keep working unchanged | ✓ VERIFIED | An unkeyed reply returns before any sequence is attached: `steering-tools.ts:152`. Named tests PASS: `steering-tools.test.ts:227` ("an unkeyed queue keeps its reply shape, with no sequence"), `steering.test.ts:438` (unkeyed repeat is a second directive). Caveat: an unkeyed queue now takes a durable counter (`steering.ts:532`). Under the audit opt-in it is one Postgres upsert, so a counter failure fails the unkeyed queue with `audit-unavailable`. Reply shape is unchanged. Recorded in R5 and R6. |
| 3 | SC3a: A keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156`. A replay restores the stored number: `steering.ts:572-580` (`replayOf` sets it from `held.sequence`). Named tests PASS: `steering-tools.test.ts:217` ("a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"), `steering.test.ts:447` ("distinct keyed commands take their sequence per target session, and queue order is sequence order"). |
| 4 | SC3b: Two distinct commands are delivered in sequence order, and `restDirective` and the wait expose the sequence | ✓ VERIFIED | Queue order sorts by sequence: `steering.ts:456-462`. The wait cursor walks sequence, not timestamp: `steering-waiters.ts:63-67`. The waiter returns `{ record, sequence }`: `steering-waiters.ts:29`, `:35`, `:122`, `:177`. `restDirective(record, sequence)` includes `sequence`: `steering-rest.ts:82-83`, `:97-107`. The REST listing passes `inbox.sequenceOf`: `steering-rest.ts:155`. The wait route passes it through: `server.ts:2229`. Named tests PASS: `steering-waiters.test.ts:334` ("each directive carries its sequence in its own session, and an after cursor walks one session in queue order"), `steering-rest.test.ts:326` ("a held directive reports its sequence, and the listing reports the same number in queue order"), `server.steering.test.ts:249` ("the wait body carries the delivery sequence of the directive it returns"). |
| 5 | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired. Migration 43 has the three tables and the column (`index-store.ts:915-937`). The Bun adapter is `bunSteeringIdempotencyStore` (`steering-store.ts:664-717`): one upsert for the sequence (`:668-672`), the replay find (`:680-687`), and the claim transaction (`:689-716`). It is wired under the audit opt-in (`service.ts:1822-1825`, `index-store.ts` `steeringIdempotency()`). The PG test that would exercise it is `steering-idempotency.pg.test.ts:73` ("a saved replay is returned exactly by a second instance..."). That file is `describe.skip` without `SUBSTRATE_TEST_PG_URL`, and no Postgres is installed here, so it was skipped. The restart suite proves the inbox's use of the port with a memory stand-in only. |
| 6 | W1: A lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code: the keyed path takes the claim with the audit inside it (`steering.ts:546`, `:582-593`). The adapter runs `queue(tx)` inside `sql.begin` (`steering-store.ts:689`, `:705`). A refused audit throws, which rolls the claim back (`steering-store.ts:705` inside `:689`). The audit writes through the transaction when one is passed (`steering-store.ts:298`). Named inbox tests PASS with the memory store: `steering-durable.test.ts:948` ("a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice"), `steering-durable.test.ts:960` ("an audit refusal inside the keyed claim holds nothing, so the retry queues once"). The atomicity of a real transaction is only executed by `steering-idempotency.pg.test.ts:93` and `:112`, both skipped. Not counted as VERIFIED. |
| 7 | W2: Two processes that accept the same key concurrently queue one directive (one winner per scope key) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code: scope key is `JSON[author, session, key]` (`steering.ts:513`), and it is the primary key (`index-store.ts:923-925`, `scope_key text primary key`). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:694-697`). A loser reads the winner's row and returns its reply (`steering-store.ts:698-704`, `steering.ts:548`). The author-in-key decision is consistent across code, PLAN D2 and SUMMARY revision 3 (G3). Test `steering-idempotency.pg.test.ts:122` is skipped here. The in-process path is serialised by the inbox lock, which no test exercises concurrently. |
| 8 | Per-session delivery order is documented (the ordering rule) | ✓ VERIFIED | `docs/live-steering.md:33` states the durable keys, the sequence, the settings and the bounds. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." Matches the code at `steering.ts:456-462` and `steering-waiters.ts:63-67`. |

**Score:** 5/8 truths verified (3 present, behavior-unverified)

### Deferred Items

None. Step 9b checked the one later phase (78: ledger, index and cache reconciliation). Its goal does not match any gap here.

### Advisory (New Scope, Unevidenced)

Not applicable. This is initial mode.

### Required Artifacts

Steps 4 Level 1-3 by query is not applicable (no `must_haves.artifacts`). Manual Levels 1-3 below. None is a stub, and each is imported and used.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED | Substantive: the keyed path, `MemorySteeringIdempotencyStore` (`:329-355`), `loadSteeringIdempotencySettings`. Wired: `service.ts:1822-1836`, `steering-tools.ts:148`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with `unit`, Bun idempotency adapter | ✓ VERIFIED | Substantive: `record` with the unit (`:291-298`), `bunSteeringIdempotencyStore` (`:664-717`). Wired: `index-store.ts` `steeringIdempotency()`. Exec unverified (T5, T6, T7). |
| `packages/mcp-server/src/index-store.ts` | Migration 43 and the factory | ✓ VERIFIED (migration) / unexecuted | Migration `:915-937` (expand, reversible `down`). Factory `steeringIdempotency()`. Not executed. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | `:19` (key schema), `:148-159` (queue, sequence on keyed reply, wake only on fresh queue). |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries sequence | ✓ VERIFIED | `:82-83`, `:97-107`, `:155`, `:213` (key in body). |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `:29`, `:35`, `:63-67`, `:122`, `:177`. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `:2229`. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | Settings and flags | ✓ VERIFIED | `config.ts:769-770`, `:1284`; `flag-registry.ts:328-329`. |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED | `:33`, `:35`. |

### Key Link Verification

Step 5's query is not applicable (`verify.key-links` exit 66). Manual wiring checks:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts:148` | `SteeringInbox.enqueueReceipt` | direct call | ✓ WIRED | Passes `idempotencyKey` and reads `replayed` (`:150`). |
| `steering-tools.ts:154` | `inbox.sequenceOf` | keyed reply | ✓ WIRED | Throws if a queued directive has no sequence (`:155`). |
| `steering.ts:532` | `store.nextSequence` | before claim or audit | ✓ WIRED | Also the cause of D-1 for concurrent losers. |
| `steering.ts:546` | `store.claimReplay` (via `claimKeyed` `:582`) | audit in unit | ✓ WIRED | Commit-or-rollback via the unit. |
| `steering-store.ts:705` | `history.append` in `tx` | `queue(tx)` | ✓ WIRED | The audit uses the transaction (`:298`). |
| `service.ts:1822-1825` | `index.steeringIdempotency()` | opt-in only | ✓ WIRED | Memory store otherwise. |
| `steering-waiters.ts:65-67` | `inbox.sequenceOf` | cursor | ✓ WIRED | Cursor is sequence, not time. |
| `server.ts:2229` | `restDirective(waited.record, waited.sequence)` | wait body | ✓ WIRED | Test `server.steering.test.ts:249`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering.ts` `replayOf` | `held` (replay record) | `findReplay` or claim result | In memory: yes. Postgres: code path only. | ✓ FLOWING (memory, tested). ⚠️ Postgres unexecuted (T5). |
| `steering-rest.ts` listing | `sequence` | `inbox.sequenceOf` | Yes, from the counter the queue set | ✓ FLOWING |
| `steering-waiters.ts` | `sequence` | `inbox.sequenceOf` via `queuedFor` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Single targeted run, once, on the tree at 9b3636ab. Command: `bun test` over the eight named files (`steering.test.ts`, `steering-durable.test.ts`, `steering-tools.test.ts`, `steering-waiters.test.ts`, `steering-rest.test.ts`, `steering-idempotency.pg.test.ts`, `server.steering.test.ts`, `mcp.steering.test.ts`).

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| All targeted steering suites | `bun test` on the eight files | 201 pass, 6 skip, 0 fail; 1629 expect() calls; 207 tests across 8 files; 52.9 s | ✓ PASS (0 fail) |
| Replay and conflict (SC1) | included in the run above | `steering.test.ts:406`, `:417` pass | ✓ PASS |
| Sequence and wait (SC3) | included in the run above | `steering-tools.test.ts:217`, `steering-waiters.test.ts:334`, `steering-rest.test.ts:326`, `server.steering.test.ts:249` pass | ✓ PASS |
| Restart stand-in (W1 inbox) | included in the run above | `steering-durable.test.ts:883`, `:948`, `:960` pass | ✓ PASS (memory store) |
| Postgres suite | included in the run above | `steering-idempotency.pg.test.ts` (4 tests) skipped: no `SUBSTRATE_TEST_PG_URL` | ? SKIP, routed to human |

Skip accounting: the 4 PG-file skips are confirmed (`describe.skip`, `steering-idempotency.pg.test.ts:13`). The other 2 skips in this run were not identified statically, and the set was not re-run to identify them. See D-3.

### Probe Execution

No probe applies. `find scripts -path '*/tests/probe-*.sh'` returned nothing, and neither the PLAN nor the SUMMARY declares a probe path. Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client key and per-session monotonic sequence; same-key same-payload replay returns the identical original result without effect; changed payload refused; one documented out-of-order rule; schema and size caps; durable replay state; unkeyed commands get no false guarantee | ✗ ORPHANED | Content is mostly covered: keyed replay and conflict (T1), sequence and wait (T3, T4), order rule (`docs/live-steering.md:35`, T8), key grammar (`steering.ts` `IDEMPOTENCY_KEY_PATTERN`), body cap after redaction (`steering.ts:37`, `:105`), unkeyed reply has no key (T2). Not covered: durable state is T5/T6/T7 (unexecuted). The out-of-order rule does not explain skipped numbers. Ownership: not claimed by any plan (`REQUIREMENTS.md:124` unchecked, `:139` Not started). Human decision, see H5. |

Other requirements mapped to Phase 77: none.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `steering.ts` | 532, 546 | Counter taken before the claim, so a concurrent loser writes a counter row | ⚠️ Warning (D-1) | SC1 says "writes nothing". Sequential replays comply. Concurrent losers leave a gap. Owner decision H4. |
| `steering.ts` | 769-779 with `steering-store.ts:298` | Bounded audit retry runs inside the same Postgres transaction after a failed statement | ⚠️ Warning (D-2) | [INFERENCE] Later attempts fail with the aborted-transaction code, so the reported `lastErrorCode` can differ. The claim still rolls back, so no double-apply. Owner decision H3. |
| `steering-store.ts` | 689-711 | Claim and audit atomicity exists only in the SQL adapter, never executed | ⚠️ Warning | T6, T7, behavior-unverified. |
| `steering.ts` | 532, 546 concurrency path | Replay write path has no concurrency test on either store | ℹ️ Info | Only the PG file would test it. Skipped. |
| `steering-store.ts` | 686 (`return null` in `findReplay` when no row) | `return null` | ℹ️ Info | Legitimate absence for a missing replay row. Not a stub. |
| `77-01-PLAN.md` | D11, R1 | Describes superseded behavior (stderr, replay save after the audit, queue not failed) | ℹ️ Info | Code at `steering.ts:546-549` and `:582-593` fails the queue on a failed claim. SUMMARY revision 3 states the new behavior. H6. |
| `ROADMAP.md` | 147, 1330-1334 | "Status: Not started", "Plans: none written" | ℹ️ Info | Stale on this branch. H6. |
| `77-01-SUMMARY.md` | revision 3 G2 | Cites `steering-store.ts:658-717` for `claimReplay` | ℹ️ Info | `claimReplay` is at `:688-716`. The range includes the factory, so it is loose but not wrong. |

Debt-marker gate: `grep -E "TBD|FIXME|XXX"` across all 26 changed implementation files returned nothing. No `TODO`, `HACK` or `PLACEHOLDER` was added in the phase diff. Passes.

### Human Verification Required

1. **Run the Postgres suite once.** Set `SUBSTRATE_TEST_PG_URL`, migrate with the audit opt-in, and run `steering-idempotency.pg.test.ts` (4 tests). Expected: all pass. This covers T5, T6 and T7.
2. **Rehearse migration 43.** Apply it on a restored dump under the `steering-audit` opt-in, then reverse it. Expected: both directions run cleanly. Reversal drops `delivery_sequence` and its stored values, while the audit rows remain.
3. **Observe a forced audit failure inside a keyed claim on Postgres.** Expected: `audit-unavailable`, claim rolled back, nothing queued. Decide whether the in-transaction retry (D-2) is acceptable.
4. **Decide the concurrent-loser counter gap (D-1).** Accept it as a documented residual in PLAN 77-01, or move `nextSequence` inside the claim transaction so only the winner takes a number.
5. **Decide HARD-H1 ownership.** Add `requirements: [HARD-H1]` to PLAN 77-01 or re-map it with owner approval. Decide whether `docs/live-steering.md:35` is the single out-of-order rule, and state what a skipped number means to a reader.
6. **Reconcile stale text before merge.** Update PLAN 77-01 D11 and R1 to the claim-in-transaction behavior. Update `ROADMAP.md:147` and `:1330-1334`, and `REQUIREMENTS.md:124` and `:139`.

### Gaps Summary

No must-have is FAILED. No blocker was found: no debt markers, no stub patterns, no missing or unwired artifact. Status is `human_needed` rather than `passed` for two reasons. Three behavior-dependent truths (T5, T6, T7) are PRESENT_BEHAVIOR_UNVERIFIED, because the Postgres adapter and migration 43 have never executed in this environment. And there are owner decisions outstanding: the concurrent-loser counter write (D-1), HARD-H1 ownership, and the documentation reconciliation.

### Deviations and Evidence Notes

- **D-1 (SC1 literal "writes nothing").** A concurrent keyed loser takes a counter number before the claim (`steering.ts:532`, claim at `:546`). Sequential replays write nothing. This matches SUMMARY revision 3 residual "a losing or refused keyed caller still consumes a sequence number", but PLAN 77-01 does not record it.
- **D-2 (retry inside a transaction).** Described in the anti-patterns table. [INFERENCE] from Postgres transaction semantics, not executed.
- **D-3 (test counts).** This run: 201 pass, 6 skip, 0 fail. The orchestrator recorded 205 pass, 0 fail for the same eight files. The 4 PG-file skips are confirmed. The other 2 skips are unidentified. The set was not re-run, per the one-run rule.
- **D-4 (full suite).** Not run at 9b3636ab. The orchestrator's full run at merge 9f39db90 reported 11660 pass, 2 skip, 0 fail. The root disk is at 97% (13 G free), so a full run is not safe to start here. The full suite at 9b3636ab is still unrun.
- **D-5 (restart evidence).** All "restart" tests in `steering-durable.test.ts:873-929` use `MemorySteeringIdempotencyStore` shared between two inboxes. They prove the inbox's use of the port, not durability.
- **D-6 (stale plan text).** PLAN 77-01 D11 and R1 contradict the code. The summary and the code agree.
- **D-7 (W2 summary consistency).** The code, PLAN D2 and SUMMARY revision 3 G3 all key the replay on (author, session, key), with the primary key on `scope_key`. They agree.
- **D-8 (settle helper).** `9b3636ab` changed only the settle helper in `server.steering.test.ts` (turn count to a 2 s real-time bound, `git show 9b3636ab`). It added one test and changed no existing assertion. Confirmed.
- **D-9 (mode).** Initial mode per Step 0. The prior record is carried in `re_verification`.

---

_Verified: 2026-11-02T10:04:50Z_
_Verifier: Claude (gsd-verifier)_
