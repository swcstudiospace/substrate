---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-02T16:01:01Z
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
covered_digest: "v3:sha256:08e7c13376e7cec978259f60b96cd73431a98c1f513ff6db3f986c40f8f5f4e7"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/8
  gaps_closed: []
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres (PG-gated, not run: no SUBSTRATE_TEST_PG_URL)"
    - "T6 (W1): audit row and replay claim share one transaction (PG-gated, not run)"
    - "T7 (W2): cross-process single winner per scope key (PG-gated, not run)"
    - "HARD-H1 ownership: no plan claims it (REQUIREMENTS.md:124 unchecked, :139 Not started)"
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "Set SUBSTRATE_TEST_PG_URL, migrate with the steering-audit opt-in, run steering-idempotency.pg.test.ts once (test at line 73). Queue a keyed command through one IndexStore, drop it, repeat the key through a second IndexStore within the retention window, then queue a distinct command."
    expected: "The second instance returns the saved replay exactly, with no audit row written. The distinct command takes the next number. Expired rows are pruned and rows beyond the cap are deleted."
    why_human: "The restart suite (steering-durable.test.ts:873-929) uses MemorySteeringIdempotencyStore and the DurableSql fake, not Postgres. steering-idempotency.pg.test.ts is skipped without SUBSTRATE_TEST_PG_URL. Migration 43 and bunSteeringIdempotencyStore have never executed."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "On Postgres, force an audit insert to fail inside a keyed claim, then retry the same key. Separately, lose the reply after commit and retry. Runs: steering-idempotency.pg.test.ts:93 and :112."
    expected: "A refused audit leaves no queued row and no replay record, and the retry queues once. A reply lost after commit replays on retry and is never queued twice."
    why_human: "Atomicity is one sql.begin (steering-store.ts:688-716) with the audit written through tx (steering-store.ts:298). The inbox tests (steering-durable.test.ts:948, :960) use MemorySteeringIdempotencyStore, which runs the queue before setting the record and has no database transaction to roll back. Both PG tests are skipped here."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "Run steering-idempotency.pg.test.ts case 'two concurrent keyed commands through two instances queue one directive and both get its reply' (line 122) against Postgres."
    expected: "One queued audit row for the session. One caller sees replayed false and the other replayed true, with the same directive id and sequence."
    why_human: "The single winner rests on insert ... on conflict (scope_key) do nothing returning scope_key (steering-store.ts:691-695) and the loser branch (steering-store.ts:696-704). Only the database can exercise this. The test is skipped here."
coincidental_reliance_items: []
human_verification:
  - test: "Run steering-idempotency.pg.test.ts (4 tests) once against a migrated Postgres with SUBSTRATE_TEST_PG_URL set."
    expected: "All 4 pass. The afterAll hook deletes only rows whose session starts with the run prefix. Covers T5, T6 and T7."
    why_human: "No Postgres in this environment, and the assignment forbids setting SUBSTRATE_TEST_PG_URL."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it."
    expected: "Applies and reverses cleanly (index-store.ts:913-937, down at :917). Reversal drops planning_steering_audit.delivery_sequence and the two new tables, so stored sequence values are lost. Audit rows remain."
    why_human: "Needs a live database and an operator rehearsal, which the migration header requires before production."
  - test: "On Postgres, force an audit failure inside a keyed claim and observe the reported error code."
    expected: "The queue is refused as audit-unavailable, the claim rolls back, and nothing is queued. lastErrorCode may show the aborted-transaction code rather than the original driver error, because the bounded audit retry runs inside the same transaction (steering.ts:769-780). Owner decision H3 stays open."
    why_human: "Behaviour under a real Postgres transaction abort is code reasoning here ([INFERENCE]). No double-apply follows from it."
  - test: "HARD-H1 ownership and the out-of-order rule."
    expected: "Either add HARD-H1 to a plan's requirements field, or re-map it with the owner's approval. Decide whether docs/live-steering.md:35 is the one documented out-of-order rule, and state what a number skipped by a refused or lost keyed command means to a reader."
    why_human: "REQUIREMENTS.md:124 is unchecked and :139 says Not started. PLAN 77-01 has no requirements field. Closing this is a planning edit the verifier cannot make. Decision stays open."
  - test: "Reconcile stale text before merge."
    expected: "77-01-PLAN.md D11 and R1 are updated to claim-in-transaction behaviour (the replay save no longer runs after the audit, and a failed claim fails the queue). The origin/main ROADMAP phase 77 section (Status: Not started; Plans: none written) and REQUIREMENTS.md:124 and :139 are updated."
    why_human: "Documentation reconciliation needs the owner or orchestrator. The verifier does not edit planning docs."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-02T16:01:01Z
**Status:** human_needed
**Re-verification:** No, in the procedure's sense. Step 0 found no `gaps:` block in the prior record, so this is initial mode. The prior record (human_needed, 5/8, on the phase branch at 9b3636ab) is carried in `re_verification` metadata. It was overwritten here as the brief requires.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `7382ad10`. Phase commits `ce06da4d` (feature) and `9b3636ab` (hardening) are ancestors of HEAD, merged through `1cdc25cd` and `9f39db90`. Integration commit `634b6171` is also an ancestor. No code was edited, nothing was committed, and the full suite, tsc, lint and formatters were not run.

**Criteria source:** `origin/main` `.planning/ROADMAP.md`, the section from `### Phase 77` to the next `### Phase`. The three success criteria match this worktree's ROADMAP verbatim. Two lines differ, and both are stale on origin/main, not criteria: `Status` (origin/main: "Not started"; worktree: "human_needed") and `Plans` (origin/main: "none written"; worktree: 77-01). Nothing in the criteria conflicts with the phase's CONTEXT or PLAN, except the stale PLAN text recorded below under "Anti-Patterns". PLAN 77-01 has no `must_haves` block, so Steps 4 and 5 are not applicable: `verify.artifacts` and `verify.key-links` both exit 66. The three roadmap criteria are the must-haves.

**Integration facts judged on this tree**

- Commit `634b6171` made the `Substrate` live-session facade lazy: `service.ts:1654-1658` (`liveSessions` getter), `:1884-1889` (`liveSessionsSource`, `resolveLive`). The steering inbox and session-state port reach it only through `resolveLive()` (`:1908`). Every phase-77 steering test passes its authority through the test seam (`steeringSeam.liveSessions`, `service.ts:1884`), and the getter returns that override. The phase-77 inbox replay, sequence and wait paths do not read the facade. Judged: no dependency that the facade change could break, and the targeted run passed on this tree.
- Commit `634b6171` also changed `settle()` in `live-session-consumer.test-support.ts:59` to a 3 s wall-clock wait. No phase-77 test uses it. `mcp.steering.test.ts:8` imports the module but not `settle`. `server.steering.test.ts:34-43` has its own local `settle`, bounded at 2 s real time, which `9b3636ab` set. Judged: unaffected.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: A replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (accepted residual noted) | The replay lookup runs after validation and authorisation, and before the duplicate, rate and audit checks: `steering.ts:512-517`. A live record returns `replayed: true` with no audit, no rate token and no state change through `replayOf` (`steering.ts:572-576`). A different fingerprint is `idempotency-conflict` (`steering.ts:573`). Wake-up is suppressed for a replay: `steering-tools.ts:150`, `:159`. Named tests PASS in the targeted run: `steering.test.ts:406` ("a keyed replay returns the original record and writes nothing, even with no rate token left"; the conflict assertion is at `:422`), and `steering-durable.test.ts:883` (retry after restart, using the memory replay store and the DurableSql fake). Accepted residual, per the assignment brief: a concurrent keyed loser takes one counter number before its claim (`steering.ts:532`, claim at `:546`). It performs a counter upsert and never a duplicate: the claim inserts nothing and returns the winner's reply (`steering-store.ts:696-704`). Sequential replays write nothing. |
| 2 | SC2: Unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152`. Named tests PASS: `steering-tools.test.ts:227` ("an unkeyed queue keeps its reply shape, with no sequence"); `steering.test.ts:438` ("an unkeyed repeat is a second directive, as before"). Caveat, recorded as R5/R6 in the SUMMARY: every queue now takes a sequence (`steering.ts:532`). With the audit opt-in, that is one Postgres upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That is the same failure class the audit already has. The reply shape is unchanged. |
| 3 | SC3a: A keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | The keyed reply carries `sequence`: `steering-tools.ts:153-156`. A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf` (`steering-tools.ts:154`). Named tests PASS: `steering-tools.test.ts:217` ("a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"); `steering.test.ts:447` ("distinct keyed commands take their sequence per target session, and queue order is sequence order"). |
| 4 | SC3b: Two distinct commands are delivered in sequence order, and `restDirective` and the wait expose the sequence | ✓ VERIFIED | The queue sorts by sequence: `steering.ts:456-462`. The wait cursor walks sequence, not timestamp: `steering-waiters.ts:63-67`. `restDirective(record, sequence)` includes `sequence`: `steering-rest.ts:82-83`, `:97-107`. The REST listing passes `inbox.sequenceOf`: `steering-rest.ts:155`. The wait route returns `restDirective(waited.record, waited.sequence)`: `server.ts:2286`, inside the `/steering/wait` route at `:2272`. The restart path keeps stored numbers and advances the counter past them: `steering.ts:636-665` (`advancePast` at `:665`). Named tests PASS: `steering-waiters.test.ts:334`; `steering-rest.test.ts:326` ("a held directive reports its sequence, and the listing reports the same number in queue order"); `server.steering.test.ts:249` ("the wait body carries the delivery sequence of the directive it returns"); `steering-durable.test.ts:899` (restored directive keeps its own sequence). The SC3 clause "`restDirective` omits the sequence today" is discovery context for the pre-change state. The criterion is judged by its intent, and `restDirective` now exposes it. |
| 5 | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T5, PG-gated, not run) | Present and wired. Migration 43 has the three tables and the column (`index-store.ts:913-937`, expand, reversible `down` at `:917`). The Bun adapter is `bunSteeringIdempotencyStore` (`steering-store.ts:664-717`): one upsert for the sequence (`:666-672`), the replay find (`:680-687`) and the claim transaction (`:688-716`). It is wired under the audit opt-in: `service.ts:1865-1870` (`this.index.steeringIdempotency()`), factory at `index-store.ts:1034`. The PG test that exercises it is `steering-idempotency.pg.test.ts:73`. The file's gate is `describeLive = PG_URL ? describe : describe.skip` (`:12-13`), and it is skipped here. The restart suite (`steering-durable.test.ts:873-929`) uses `MemorySteeringIdempotencyStore` (`:885`, `:901`) and the `DurableSql` fake, so it proves the inbox's use of the ports, not durability. |
| 6 | W1: A lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T6, PG-gated, not run) | Code: the keyed path takes the claim with the audit inside it (`steering.ts:546`, `claimKeyed` `:582-593`). A refused audit throws `AuditRefused`, which rolls the claim back (`steering.ts:584-590`, `steering-store.ts:705` inside `sql.begin` at `:689`). The audit writes through the transaction (`steering-store.ts:298`). Named inbox tests PASS with the memory store: `steering-durable.test.ts:948` ("a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice") and `:960` ("an audit refusal inside the keyed claim holds nothing, so the retry queues once"). The memory store runs the queue before it sets the record (`steering.ts:352-353`), so it emulates rollback without a database transaction. The PG tests are `steering-idempotency.pg.test.ts:93` and `:112`, both skipped. |
| 7 | W2: Two processes that accept the same key concurrently queue one directive (one winner per scope key) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T7, PG-gated, not run) | Code: the scope key is `JSON[author, session, key]` (`steering.ts:513`), and `scope_key` is the primary key (`index-store.ts:923-925`). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:691-695`). A loser that sees no row reads the winner's row and returns its reply (`steering-store.ts:696-704`, `steering.ts:548`). The in-process path is serialised by the inbox lock (`steering.ts:801-805`, `enqueueReceipt` at `:421-422`). No test exercises two processes. The PG test is `steering-idempotency.pg.test.ts:122`, skipped here. |
| 8 | Per-session delivery order is documented (the ordering rule) | ✓ VERIFIED | `docs/live-steering.md:33` states the durable keys, the sequence, the settings and the bounds. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." This matches `steering.ts:456-462` and `steering-waiters.ts:63-67`. The rule does not say what a number skipped by a refused or lost keyed command means to a reader. That is open decision H5 below. |

**Score:** 5/8 truths verified (3 present, behavior-unverified). T1 carries the accepted residual; the assignment brief accepts it.

### Deferred Items

None. There are no gaps, so Step 9b was not invoked.

### Advisory (New Scope, Unevidenced)

Not applicable. Initial mode (Step 0).

### Required Artifacts

Steps 4 Level 1-3 by query is not applicable (`verify.artifacts` exit 66: "No must_haves.artifacts found in frontmatter"). Manual Levels 1-3 below. None is a stub. Each is imported and used.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED | Keyed path `:503-550`, `claimKeyed` `:582-593`, `MemorySteeringIdempotencyStore` `:329-361`, `loadSteeringIdempotencySettings`. Wired: `service.ts:1874-1883`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with `unit`, Bun idempotency adapter | ✓ VERIFIED (code) / unexecuted | `record` with the unit (`:291-298`), `bunSteeringIdempotencyStore` (`:664-717`). Wired through `index-store.ts` `steeringIdempotency()`. Exec unverified (T5, T6, T7). |
| `packages/mcp-server/src/index-store.ts` | Migration 43 and the factory | ✓ VERIFIED (code) / unexecuted | Migration `:913-937` (expand, reversible `down` at `:917`). Factory at `:1034`. Digest `"43"` present in `index-store.migrations.digests.json:44`. Not executed. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | `:148-160`. The sequence is on the keyed reply only (`:152-156`). The wake-up runs only on a fresh queue (`:158-159`). |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries sequence | ✓ VERIFIED | `:82-83`, `:97-107`, `:155`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `:57-68`. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `/steering/wait` at `:2272`; body at `:2286`. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | Settings and flags | ✓ VERIFIED | `config.ts:783` (settings), `flag-registry.ts:344-345` (`SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S`, `_CAP`). |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED | `:33`, `:35`. |

### Key Link Verification

Step 5's query is not applicable (`verify.key-links` exit 66: "No must_haves.key_links found in frontmatter"). Manual wiring checks:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts:148` | `SteeringInbox.enqueueReceipt` | direct call | ✓ WIRED | Passes `idempotency_key` and reads `replayed` (`:148-150`). |
| `steering-tools.ts:154` | `inbox.sequenceOf` | keyed reply | ✓ WIRED | Throws if a queued directive has no sequence (`:155`). |
| `steering.ts:532` | `store.nextSequence` | before claim or audit | ✓ WIRED | The source of the accepted counter-gap residual for concurrent losers. |
| `steering.ts:546` | `store.claimReplay` (via `claimKeyed` `:582`) | audit in unit | ✓ WIRED | Commit-or-rollback via the unit. |
| `steering-store.ts:705` | `history.append` in `tx` | `queue(tx)` | ✓ WIRED | The audit uses the transaction (`:298`). |
| `service.ts:1865-1870` | `index.steeringIdempotency()` | opt-in only | ✓ WIRED | Memory store otherwise (`service.ts:1880`, `:1869`). |
| `steering-waiters.ts:65-67` | `inbox.sequenceOf` | cursor | ✓ WIRED | Cursor is sequence, not time. |
| `server.ts:2286` | `restDirective(waited.record, waited.sequence)` | wait body | ✓ WIRED | Test `server.steering.test.ts:249` passes. |
| `steering.ts:665` | `store.advancePast` | `doRestore` | ✓ WIRED | Restored directives keep their stored number; the counter moves past it. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering.ts` `replayOf` | `held` (replay record) | `findReplay` or claim result | In memory: yes. Postgres: code path only. | ✓ FLOWING (memory, tested). ⚠️ Postgres unexecuted (T5). |
| `steering-rest.ts` listing | `sequence` | `inbox.sequenceOf` | Yes, from the counter the queue set | ✓ FLOWING |
| `steering-waiters.ts` | `sequence` | `inbox.sequenceOf` via `queuedFor` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Targeted runs on this tree (the assignment's per-verifier limit is three `bun test` commands; two were used). Both used `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, so no Postgres URL was set or inherited.

Files in both runs: `packages/mcp-server/src/planning/steering.test.ts`, `planning/steering-durable.test.ts`, `planning/steering-tools.test.ts`, `planning/steering-waiters.test.ts`, `planning/steering-rest.test.ts`, `planning/steering-idempotency.pg.test.ts`, `packages/mcp-server/src/server.steering.test.ts`, `packages/mcp-server/src/mcp.steering.test.ts`, `packages/mcp-server/src/index-store.migrate-contract.test.ts`.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| All targeted steering suites (run 1, pass count) | `bun test` on the nine files above | 254 pass, 6 skip, 0 fail; 260 tests across 9 files; 1716 expect() calls; 18.80 s | ✓ PASS (0 fail) |
| Skip accounting (run 2, JUnit reporter, same nine files) | `bun test --reporter=junit --reporter-outfile=…/p77-junit.xml` on the same nine files | exit 0; 6 skipped entries, all under the one skipped describe block `steering replay and delivery sequence against PostgreSQL` in `steering-idempotency.pg.test.ts`: the four named PG tests (lines 73, 93, 112, 122) plus two `(unnamed)` entries from the same block | ✓ PASS (no other skips) |
| Replay and conflict (SC1) | included in run 1 | `steering.test.ts:406` (conflict at `:422`) and `steering-durable.test.ts:883` pass | ✓ PASS |
| Sequence and wait (SC3) | included in run 1 | `steering-tools.test.ts:217`, `steering-waiters.test.ts:334`, `steering-rest.test.ts:326`, `server.steering.test.ts:249` pass | ✓ PASS |
| Restart stand-in (W1 inbox) | included in run 1 | `steering-durable.test.ts:948` and `:960` pass (memory replay store, DurableSql fake) | ✓ PASS (not durable evidence) |
| Postgres suite | included in run 1 | `steering-idempotency.pg.test.ts` (4 tests) skipped: no `SUBSTRATE_TEST_PG_URL` | ? SKIP, routed to human |

Pass counts are the run-1 totals. Run 2 identified the skips. It did not re-count passes.

### Probe Execution

No probe applies. Neither the PLAN nor the SUMMARY declares a probe path, and this is not a migration or tooling phase. Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client key and per-session monotonic sequence; same-key same-payload replay returns the identical original result without effect; changed payload refused; one documented out-of-order rule; schema and size caps; durable replay state; unkeyed commands get no false guarantee | ✗ ORPHANED | Covered in code and tests: keyed replay and conflict (T1), sequence and wait (T3, T4), ordering rule (T8), key grammar (`event.ts:91`, `steering.ts:507`), body cap (`steering.ts` redaction, `docs/live-steering.md:33`), unkeyed reply has no key (T2). Durable state is T5-T7, unexecuted. REQUIREMENTS.md:124 is unchecked and `:139` says "Not started". Ownership is open decision H5 below. |

Other requirements mapped to Phase 77: none.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `steering.ts` | 532, 546 | Counter taken before the claim, so a concurrent loser writes a counter row | ⚠️ Warning (accepted residual) | SC1 literal "writes nothing" holds for sequential replays. Concurrent losers leave a gap, never a duplicate. Accepted per the assignment brief; the PLAN does not yet record it. |
| `steering.ts` | 769-780 with `steering-store.ts:298` | Bounded audit retry runs inside the same Postgres transaction after a failed statement | ⚠️ Warning (H3) | [INFERENCE] Later attempts fail with the aborted-transaction code, so `lastErrorCode` can differ from the driver error. The claim still rolls back, so no double-apply. |
| `steering-store.ts` | 688-716 | Claim and audit atomicity exists only in the SQL adapter, never executed | ⚠️ Warning | T6 and T7, behavior-unverified. |
| `77-01-PLAN.md` | D11, R1 | Describes superseded behaviour: replay save after the audit, and a failed save does not fail the queue | ℹ️ Info (stale) | Code at `steering.ts:546-549` and `:582-593` fails the queue on a failed claim, so the replay save is not separate. SUMMARY revision 3 states the new behaviour. Open decision H6. |
| origin/main `ROADMAP.md` phase 77 | Status and Plans lines | "Not started", "Plans: none written" | ℹ️ Info (stale) | The worktree ROADMAP (uncommitted modification) says human_needed. Open decision H6. |
| `docs/live-steering.md` | 35 | Ordering rule does not explain skipped numbers | ℹ️ Info | Open decision H5. |

Debt-marker gate: `grep -nE "TBD|FIXME|XXX|HACK|PLACEHOLDER"` across the 26 implementation and doc files in the phase commits returned nothing. Passes.

### Human Verification Required

1. **Run the Postgres suite once.** Set `SUBSTRATE_TEST_PG_URL` (not set by this verifier), migrate with the audit opt-in, and run `steering-idempotency.pg.test.ts` (4 tests). Expected: all pass. This covers T5, T6 and T7.
2. **Rehearse migration 43.** Apply it on a restored dump under the `steering-audit` opt-in, then reverse it. Expected: both directions run cleanly. Reversal drops `delivery_sequence` and its stored values. Audit rows remain.
3. **Observe a forced audit failure inside a keyed claim on Postgres.** Expected: `audit-unavailable`, claim rolled back, nothing queued. Decide whether the in-transaction retry (H3) is acceptable.
4. **Decide HARD-H1 ownership (H5).** Add `requirements: [HARD-H1]` to PLAN 77-01 or re-map it with owner approval. Decide whether `docs/live-steering.md:35` is the single out-of-order rule and state what a skipped number means to a reader.
5. **Reconcile stale text before merge (H6).** Update PLAN 77-01 D11 and R1 to the claim-in-transaction behaviour. Update the origin/main ROADMAP phase 77 status and plans lines, and `REQUIREMENTS.md:124` and `:139`.

### Open Decisions (kept open)

- **H3 (retry inside the failed transaction).** Whether to accept the aborted-transaction `lastErrorCode` or fail fast inside the transaction (`steering.ts:769-780`). Open. Not verified.
- **H5 (HARD-H1 ownership and out-of-order rule).** Open. No plan claims HARD-H1. `docs/live-steering.md:35` does not say what a skipped number means.
- **H6 (stale text).** Open. PLAN 77-01 D11 and R1, and the origin/main ROADMAP status and plans lines, contradict the code and the SUMMARY.

### Accepted Residual (per the assignment brief, reported, not an open decision)

- **Counter gap for a concurrent keyed loser.** A concurrent keyed loser may consume one sequence number before its claim (`steering.ts:532`, claim at `:546`). It never produces a duplicate. The loser's claim inserts nothing and returns the winner's reply (`steering-store.ts:696-704`). Sequential replays write nothing. The PLAN does not yet record this residual. The SUMMARY does (revision 3, residual).

### Gaps Summary

No must-have is FAILED. No blocker was found: no debt markers, no stub patterns, no missing or unwired artifact. Status is `human_needed` rather than `passed` for two reasons. Three behaviour-dependent truths (T5, T6, T7) are PRESENT_BEHAVIOR_UNVERIFIED, because the Postgres adapter and migration 43 have never executed here. And decisions and documentation remain open (H3, H5, H6).

### Deviations and Evidence Notes

- **Mode.** Initial mode per Step 0. The prior record had no `gaps:` block, so it is carried in `re_verification`.
- **Citation drift from the prior record (9b3636ab) to this tree (7382ad10).** The wait body is now `server.ts:2286` (route `:2272`), not `:2229`, which is now the sessions query. The wiring is `service.ts:1865-1886`, not `:1822-1836`. The conflict assertion is `steering.test.ts:422`, inside the test at `:406`, not a test at `:417`. The PG gate is `steering-idempotency.pg.test.ts:12-13`, not `describe.skip` at `:13`. The prior record's unidentified 2 skips (D-3) are now identified as two `(unnamed)` entries under the same skipped PG describe block (run 2).
- **New PG test not in the prior record.** `steering-idempotency.pg.test.ts:112` ("a keyed queue commits its audit row and replay record together, and a retry on the other instance replays") is present and skipped. It is part of T6.
- **Restart evidence is a stand-in (prior record D-5).** `steering-durable.test.ts:873-929` uses `MemorySteeringIdempotencyStore` and the `DurableSql` fake for the audit log. It proves the inbox's use of the ports. It does not prove durability.
- **Full suite not run.** Assignment rule. The orchestrator's full gate on this tree is green per the brief.
- **Fingerprint.** Computed with `gsd_run query verification.fingerprint` over the 26 implementation and doc files changed by `ce06da4d` and `9b3636ab`, plus the phase's PLAN and SUMMARY, which the command adds automatically. Interleaved commits between them are excluded.
- **Self-check.** From the worktree, `gsd_run query verification.status .planning/phases/77-steering-idempotency-and-ordering --pick status` printed `human_needed` with exit 0, after this record was written.

---

_Verified: 2026-11-02T16:01:01Z_
_Verifier: Claude (gsd-verifier)_
