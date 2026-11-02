---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-02T18:27:16Z
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
covered_digest: "v3:sha256:6fc38bdd4caaa69a6a919432448f35ca36d55f47c140ec58f5d31c2baa0b1fc5"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/8
  previous_verification: "749e97e3 record (digest v3:sha256:c9535a76a16b30be56ae9b403295ab5c148fda5aa36e2e759ed4749d95983ef9)"
  gaps_closed: []
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres. Present; not run by this verifier. The orchestrator's log is cited, labelled, and names no test file."
    - "T6 (W1): audit row and replay claim share one transaction. Present; not run by this verifier. Same orchestrator log."
    - "T7 (W2): cross-process single winner per scope key. Present; not run by this verifier. Same orchestrator log."
    - "HARD-H1 ownership: no plan claims it (REQUIREMENTS.md:124 unchecked, :139 Not started)"
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "steering-idempotency.pg.test.ts:73 under SUBSTRATE_TEST_PG_URL. Not run here (PG unset). The orchestrator's log is labelled evidence and does not name this file."
    expected: "The second IndexStore returns the saved replay exactly, and the sequence continues from the saved value."
    why_human: "The brief forbids this verifier from starting Postgres or setting SUBSTRATE_TEST_PG_URL. The restart suite (steering-durable.test.ts) uses MemorySteeringIdempotencyStore and a DurableSql fake, which are not durable evidence."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "steering-idempotency.pg.test.ts:93 (refused audit inside the claim) and :112 (audit row and replay record committed together, retry replays)."
    expected: "A refused audit leaves no replay record; a retry on the other instance replays and no second queued row exists."
    why_human: "Not run here. Atomicity is one sql.begin (steering-store.ts:689-714). The inbox tests in steering-durable.test.ts (:948, :960) use MemorySteeringIdempotencyStore, which has no transaction."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "steering-idempotency.pg.test.ts:122."
    expected: "One queued audit row for the session. One caller sees replayed false, the other replayed true, with the same directive id and sequence."
    why_human: "Not run here. The single winner rests on insert ... on conflict (scope_key) do nothing returning scope_key (steering-store.ts:691-695) and the scope_key primary key (index-store.ts:924). Only Postgres exercises it."
coincidental_reliance_items: []
human_verification:
  - test: "Run steering-idempotency.pg.test.ts (4 tests) against a migrated Postgres with SUBSTRATE_TEST_PG_URL set, or accept the orchestrator's log as the record for T5 to T7."
    expected: "All four pass. The afterAll hook deletes only rows whose session starts with the run prefix."
    why_human: "This verifier did not run it. The orchestrator's log (/root/src/worktrees/backups/pg-targeted.log) reads 44 pass, 0 fail, 4 files, but names none of the files and contains one run block. It cannot be tied to steering-idempotency.pg.test.ts from the log."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it."
    expected: "Both directions run cleanly (index-store.ts:912-937; down at :917). Reversal drops planning_steering_audit.delivery_sequence and the two new tables, so stored sequence values are lost. Audit rows remain."
    why_human: "Needs a live database and an operator rehearsal, which the migration requires before production."
  - test: "On Postgres, force an audit failure inside a keyed claim and observe the reported error code."
    expected: "The queue is refused as audit-unavailable, the claim rolls back, and nothing is queued. lastErrorCode may show the aborted-transaction code rather than the driver error, because the bounded audit retry runs inside the same transaction (steering.ts:769-780). Owner decision H3 stays open."
    why_human: "Behaviour under a real Postgres transaction abort is code reasoning here ([INFERENCE]). No double-apply follows from it."
  - test: "HARD-H1 ownership and the out-of-order rule (H5)."
    expected: "Add HARD-H1 to a plan's requirements field, or re-map it with the owner's approval. Decide whether docs/live-steering.md:35 is the one documented out-of-order rule, and state what a number skipped by a refused or lost keyed command means to a reader."
    why_human: "REQUIREMENTS.md:124 is unchecked and :139 says Not started. PLAN 77-01 has no requirements field. This is an owner decision the verifier cannot make."
  - test: "Reconcile stale text before merge (H6)."
    expected: "77-01-PLAN.md D11 and R1 are updated to the claim-in-transaction behaviour. The origin/main ROADMAP phase 77 Status and Plans lines, and REQUIREMENTS.md:124 and :139, are updated by the owner or orchestrator."
    why_human: "Documentation reconciliation. The verifier does not edit planning docs."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-02T18:27:16Z
**Status:** human_needed
**Re-verification:** A prior record exists (749e97e3, human_needed, 5/8). It has no `gaps:` block, so this is recorded as re-verification metadata. Nothing was closed; nothing regressed.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `c7788f9d`. Both `9b3636ab` (phase 77's G1 to G5 fixes) and `c7788f9d` are ancestors of HEAD. No code was edited, nothing was committed, the full suite, tsc, lint and formatters were not run.

**Brief note correction (G1 to G3 commit).** The brief's phase 77 note says the G1, G2 and G3 fixes are in commit `c7788f9d`. They are not. `c7788f9d` is titled "fix(mcp): phase 76 SC1 gaps found by re-verification (G1, G2, G3)" and changes only `event-buffer.ts`, `event-dead-letter.ts`, `service.ts` (event-ledger paths), their tests and `docs/greptime-ledger.md`. No steering file is in its diff. Phase 77's G1 to G3 (and G4, G5) are in `9b3636ab` ("feat(77): harden keyed replay: durable test, audit-first claim, wait body, ordering rule"), which touches `steering.ts`, `steering-store.ts`, `steering-durable.test.ts`, `steering-idempotency.pg.test.ts`, `server.steering.test.ts`, `docs/live-steering.md` and the SUMMARY. This record judges G1 to G3 at their code in `9b3636ab`, which is what the tree carries.

**Criteria source:** `origin/main` `.planning/ROADMAP.md`, `### Phase 77` to the next `### Phase`. The Goal and the three Success Criteria match this worktree's ROADMAP verbatim. Two lines differ, and both are status lines, not criteria: `Status` (origin/main: "Not started. Discovery: ..."; worktree, uncommitted: "human_needed (verified on gsd/v18-int-all 7382ad10; live items open)") and `Plans` (origin/main: "none written"; worktree: link to 77-01). Nothing in the criteria conflicts with PLAN 77-01 except the stale text under Anti-Patterns (H6).

**Changes since the prior record (749e97e3 to c7788f9d).** `git diff 749e97e3 HEAD` touches only `service.ts` among the phase's covered code (11 insertions, 3 deletions, the phase 76 event-buffer/ledger paths). No steering module, `server.ts`, `index-store.ts` or `docs/live-steering.md` changed. The covered digest moved from `c9535a76...` to `6fc38bdd...` for that reason. The steering wiring in `service.ts` is at the same place it was.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1: A replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (accepted residual noted) | The replay lookup runs after validation and authorisation, before the duplicate, rate and audit checks: `steering.ts:512-517` (`findReplay` at `:515`, `replayOf` at `:517`). A live record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` at `steering.ts:572-576`. A different fingerprint is `idempotency-conflict`: `steering.ts:573`. Wake-up is suppressed for a replay: `steering-tools.ts:159` (`if (outcome.freshlyQueued ...)`, with `freshlyQueued = !replayed` at `:150`). Tests PASS: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left"; `steering-durable.test.ts:883` (restart retry, memory store and DurableSql fake, not durable evidence). |
| 2 | SC2: Unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152`. Tests PASS (file run): `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence"; `steering.test.ts:438` "an unkeyed repeat is a second directive, as before". Caveat (SUMMARY R5/R6): every queue takes a sequence (`steering.ts:532`). With the audit opt-in that is one Postgres upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. The reply shape is unchanged. |
| 3 | SC3a: A keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | The keyed reply carries `sequence`: `steering-tools.ts:153-156`. A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Tests PASS (name run): `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"; `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order". |
| 4 | SC3b: Two distinct commands are delivered in sequence order; `restDirective` and the wait expose the sequence | ✓ VERIFIED | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`nextQueuedDirective`, cursor via `inbox.sequenceOf` at `:65`). `restDirective(record, sequence)` includes `sequence`: `steering-rest.ts:97-107`. The REST listing passes `inbox.sequenceOf`: `steering-rest.ts:155`. The wait route returns `restDirective(waited.record, waited.sequence)`: `server.ts:2286`, inside `/steering/wait` at `:2272`. Restart keeps stored numbers and advances the counter past them: `steering.ts:657` (`restoredSequence` used), `steering.ts:663-667` (`advancePast` at `:665`). Tests PASS: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns" (name run); `steering.test.ts:447`. |
| 5 | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T5; present in code, not run by this verifier) | Present and wired. Migration 43 has the two tables and the column (`index-store.ts:912-937`; expand; reversible `down` at `:917`; `scope_key text primary key` at `:924`). The Bun adapter is `bunSteeringIdempotencyStore` (`steering-store.ts:664-717`): sequence upsert (`:666-672`), replay find (`:680-687`), claim transaction (`:688-716`). Factory `steeringIdempotency()` at `index-store.ts:1034-1035`. Wired under the audit opt-in: `service.ts:1871-1876`. The PG test is `steering-idempotency.pg.test.ts:73`, gated at `:12-13` (`describeLive`). Not run here (PG unset). The Postgres-only claim is not observed by this verifier. |
| 6 | W1 (G2): A lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T6; present in code, not run by this verifier) | The keyed path takes the claim with the audit inside it: `steering.ts:546` (`claimKeyed`), `steering.ts:582-593`. An audit refusal throws `AuditRefused` (`steering.ts:586`, class at `:978`), which the store turns into a rollback: `steering-store.ts:689` (`sql.begin`), `:705` (`await queue(tx)`). The audit writes through the transaction: `steering-store.ts:298` (`bunSteeringAuditSql(unit)`). Named inbox tests PASS with the memory store: `steering-durable.test.ts:948` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" and `:960` "an audit refusal inside the keyed claim holds nothing, so the retry queues once". These prove the inbox's use of the claim protocol, not the SQL transaction. The SQL atomicity is exercised only by `steering-idempotency.pg.test.ts:93` and `:112`, not run here. |
| 7 | W2 (G3): Two processes that accept the same key concurrently queue one directive (one winner per scope key) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T7; present in code, not run by this verifier) | The scope key is `JSON[author, session, key]` (`steering.ts:513`), and `scope_key` is the primary key (`index-store.ts:924`). The author stays in the key by design (see SUMMARY G3; no unique on (session, key) was added). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:691-695`). A loser reads the winner's row inside the same transaction and returns its reply (`steering-store.ts:696-704`; `steering.ts:548`). The in-process path is serialised by the inbox lock (`steering.ts:801-805`, `exclusive`). No in-process test exercises two processes. PG test `steering-idempotency.pg.test.ts:122`, not run here. |
| 8 | Per-session delivery order is documented (the ordering rule) | ✓ VERIFIED | `docs/live-steering.md:33` states the durable keys, the sequence, both settings and their bounds. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." This matches `steering.ts:456-462` (queue order) and `steering-waiters.ts:63-68`. The rule does not say what a number skipped by a refused or lost keyed command means to a reader: open decision H5. |

**Score:** 5/8 truths verified. T5, T6 and T7 are present in code and wired, and this verifier did not exercise them against Postgres. They are not upgraded on the strength of the orchestrator's log.

### Phase 77 fix commit check (brief note: G1, G2, G3)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence test (PG) | `steering-store.ts:664-687` (`nextSequence`, `findReplay`), `:688-716` (`claimReplay`) | `steering-idempotency.pg.test.ts:73` "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" | Test present; PG-gated; not run (PG unset). Code reading: `replayRecord` (`steering-store.ts:720-730`) returns exactly the fields the test's `toEqual` asserts. [INFERENCE] the round-trip passes; not observed. T5. |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`, `:586`; `steering-store.ts:689`, `:705`, `:298` | Memory-side: `steering-durable.test.ts:948`, `:960` (PASS). PG-side: `steering-idempotency.pg.test.ts:93`, `:112` (not run) | Inbox protocol verified by the two named PASS tests. The atomicity of the SQL transaction is not observed here. T6. |
| G3: one winner per (author, session, key), claim is insert on conflict | `steering-store.ts:691-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG-side: `steering-idempotency.pg.test.ts:122` (not run). No in-process concurrent test | Code present; race behaviour not observed. T7. |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (PASS) | VERIFIED. The SUMMARY cites `:243-251`; the test is at `:249-257` (citation drift only). |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | VERIFIED (truth 8). |

Name-run result for the named tests (see Behavioral Spot-Checks): 8 pass, 4 skip. The 8 passes are `steering.test.ts:406`, `:427`, `:447`, `steering-tools.test.ts:217`, `steering-durable.test.ts:883`, `:948`, `:960`, `server.steering.test.ts:249`. The 4 skips are the four tests of `steering-idempotency.pg.test.ts` under `describeLive` (PG unset).

### Required Artifacts

`verify.artifacts` on `77-01-PLAN.md` returns `No must_haves.artifacts found in frontmatter`; PLAN 77-01 has no `must_haves` block. Step 4 is not applicable and is not VERIFIED on that basis. Manual Levels 1-3 below. None is a stub. Each is imported and used.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED | Keyed path `:503-550`, `replayOf` `:572-576`, `claimKeyed` `:582-593`, `restoredSequence` `:663-667`, `audit` retry `:769-780`, `MemorySteeringIdempotencyStore` `:329-361`, `loadSteeringIdempotencySettings` `:876`. Wired: `service.ts:1880-1889`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with `unit`, Bun idempotency adapter | ✓ VERIFIED (code) / not executed here | `record` with the unit `:291-298`, `deliverySequence` `:596`, `bunSteeringIdempotencyStore` `:664-717`. Exec unverified here (T5, T6, T7). |
| `packages/mcp-server/src/index-store.ts` | Migration 43 and the factory | ✓ VERIFIED (code) / not executed here | Migration `:912-937` (`version: 43`, expand, reversible `down` at `:917`, `scope_key` PK `:924`). Factory `steeringIdempotency()` at `:1034-1035`. Digest `"43"` in `index-store.migrations.digests.json:44`. Not executed here. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | Keyed reply `:153-156`; unkeyed early return `:152`; wake-up only on a fresh queue `:158-159`. |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries sequence | ✓ VERIFIED | `restDirective` `:97-107`; listing `:155`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `nextQueuedDirective` `:63-68`. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `/steering/wait` `:2272`; body `:2286`. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | Settings and flags | ✓ VERIFIED | `config.ts:785` (`steeringIdempotency` type), `:1310` (loader); `flag-registry.ts:344-345` (`SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S`, `_CAP`). |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED | `:33`, `:35`. |

### Key Link Verification

`verify.key-links` on `77-01-PLAN.md` returns `No must_haves.key_links found in frontmatter`. Manual wiring checks:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts:148` | `SteeringInbox.enqueueReceipt` | direct call | ✓ WIRED | Passes `idempotency_key` and reads `replayed` (`:148-150`). |
| `steering-tools.ts:154` | `inbox.sequenceOf` | keyed reply | ✓ WIRED | Throws if a queued directive has no sequence (`:155`). |
| `steering.ts:532` | `store.nextSequence` | before claim or audit | ✓ WIRED | Source of the accepted counter-gap residual for concurrent losers. |
| `steering.ts:546` | `store.claimReplay` (via `claimKeyed` `:582`) | audit in unit | ✓ WIRED | Commit-or-rollback via the unit (code). |
| `steering-store.ts:705` | `history.append` in `tx` | `queue(tx)` → `audit(entry, unit)` → `record` | ✓ WIRED | The audit uses the transaction (`:298`). `append` throws on refusal (`steering-store.ts:236`), which `audit` retries and then reports. |
| `service.ts:1871-1876` | `index.steeringIdempotency()` | opt-in only | ✓ WIRED | Memory store otherwise (`steering.ts:329`). |
| `steering-waiters.ts:65-67` | `inbox.sequenceOf` | cursor | ✓ WIRED | Cursor is sequence, not time. |
| `server.ts:2286` | `restDirective(waited.record, waited.sequence)` | wait body | ✓ WIRED | Test `server.steering.test.ts:249` PASS. |
| `steering.ts:665` | `store.advancePast` | `restoredSequence` | ✓ WIRED | Restored directives keep their stored number; the counter moves past it. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering.ts` `replayOf` | `held` (replay record) | `findReplay` or claim result | In memory: yes. Postgres: code path only. | ✓ FLOWING (memory, tested). ⚠️ Postgres not run by this verifier (T5). |
| `steering-rest.ts` listing | `sequence` | `inbox.sequenceOf` | Yes, from the counter the queue set | ✓ FLOWING |
| `steering-waiters.ts` | `sequence` | `inbox.sequenceOf` via `queuedFor` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Three `bun test` commands, the phase's budget. All ran from `packages/mcp-server` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No Postgres was started and no URL was set.

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A: phase 77 steering suites (file run) | `bun test` on `steering.test.ts`, `steering-durable.test.ts`, `steering-tools.test.ts`, `steering-waiters.test.ts`, `steering-rest.test.ts`, `steering-idempotency.pg.test.ts`, `server.steering.test.ts`, `mcp.steering.test.ts`, `index-store.migrate-contract.test.ts` | 254 pass, 6 skip, 0 fail; 260 tests across 9 files; 1716 expect() calls; 11.18 s. Totals match the prior record. The 6 skips match the prior record's count; I did not re-run JUnit to re-derive their identity. | ✓ PASS (0 fail) |
| B: named G1 to G4 tests (name filter) | `bun test` with `-t` over `steering.test.ts`, `steering-durable.test.ts`, `steering-tools.test.ts`, `server.steering.test.ts`, `steering-idempotency.pg.test.ts`; pattern: "a keyed replay returns the original record", "a key from another author", "a keyed reply carries its sequence", "distinct keyed commands take", "keyed queue whose reply is lost", "audit refusal inside the keyed claim", "keyed retry after a restart", "the wait body carries the delivery sequence", "a saved replay is returned exactly", "a claim whose unit fails", "a keyed queue commits its audit row", "two concurrent keyed commands" | 8 pass, 4 skip, 0 fail; 12 tests across 5 files. Mapping is by count: the 4 skips are the four `describeLive` tests of `steering-idempotency.pg.test.ts`; the 8 passes are the eight non-PG named tests listed under Goal Achievement. | ✓ PASS (non-PG named tests); PG skipped |
| C: same filter with `--verbose` | same command with `--verbose` | 8 pass, 4 skip, 0 fail. This reporter printed counts only, so the name mapping in Run B is by count, not by observed test names. | ✓ PASS (confirms Run B counts) |

Run A's `steering-idempotency.pg.test.ts` contributes 4 skips. Its tests did not run; no PG result is claimed from this verifier's runs.

### Probe Execution

No probe applies. Neither the PLAN nor the SUMMARY declares a probe path, and this is not a tooling phase. Migration 43 is covered by human item 2.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence; same-key/same-payload replay returns the identical original result without another effect; changed payload under the same key is refused; one documented out-of-order rule; schema/size caps; durable replay state; unkeyed commands get no false idempotency guarantee | ✗ ORPHANED (ownership open, H5) | Covered in code and tests: keyed replay and conflict (T1), sequence and wait (T3, T4), ordering rule (T8), key grammar (`steering.ts:507`, 8 to 128 characters), body cap (4096 characters, `docs/live-steering.md:33`), unkeyed reply has no key (T2). Durable state is T5 to T7, present in code and not run by this verifier. |

Other requirements mapped to Phase 77: none.

Owner text (`REQUIREMENTS.md:124`, from commit `23bd0733`): "Keyed commands carry a client-generated idempotency key and per-session monotonic sequence. ... Follow one documented out-of-order rule. Enforce schema/size caps and durable replay state. The owner explicitly retained legacy unkeyed commands; they receive no false idempotency guarantee." `REQUIREMENTS.md:139`: "Not started". Both unchecked. No plan in `.planning` claims HARD-H1 other than the phase text.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `steering.ts` | 532, 546 | Counter taken before the claim, so a concurrent loser consumes a sequence number | ⚠️ Warning (accepted residual) | SC1 "writes nothing" holds for sequential replays and for in-process concurrency (inbox lock). Cross-process concurrent losers leave a gap, never a duplicate. Accepted per the brief. |
| `steering.ts` | 769-780 with `steering-store.ts:298` | Bounded audit retry runs inside the same Postgres transaction after a failed statement | ⚠️ Warning (H3) | [INFERENCE] Later attempts fail with the aborted-transaction code, so `lastErrorCode` can differ from the driver error. The claim still rolls back, so no double-apply. |
| `steering-store.ts` | 688-716 | Claim and audit atomicity exists only in the SQL adapter, never executed here | ⚠️ Warning | T6 and T7, behavior-unverified by this verifier. |
| `77-01-PLAN.md` | D11 (line 49), R1 (section 5) | D11 says the replay record is written after the audit and a save failure does not fail the queue; R1 says a crash between audit commit and replay save is a documented residual. Both describe superseded behaviour: the claim is one transaction (`steering.ts:546`, `steering-store.ts:689`), and a failed claim fails the queue. SUMMARY revision 3 states the new behaviour. | ℹ️ Info (stale) | Open decision H6. |
| origin/main `ROADMAP.md` phase 77 | Status and Plans lines | "Not started", "Plans: none written" | ℹ️ Info (stale) | The worktree ROADMAP (uncommitted) says human_needed citing 7382ad10. Open decision H6. |
| `REQUIREMENTS.md` | 124, 139 | HARD-H1 unchecked; "Not started" | ℹ️ Info | Open decision H5. |
| `docs/live-steering.md` | 35 | Ordering rule does not explain skipped numbers | ℹ️ Info | Open decision H5. |
| `77-01-SUMMARY.md` | G4 | Cites `server.steering.test.ts:243-251`; the test is at `:249-257` | ℹ️ Info | Citation drift only. |

Debt-marker grep (`TBD|FIXME|XXX|HACK|PLACEHOLDER|TODO|not implemented`) over the phase's steering modules, `index-store.ts`, `service.ts`, `server.ts` and `docs/live-steering.md`: no matches recorded in the prior pass; this pass re-read the changed code paths and saw none.

### Human Verification Required

1. **Run or accept the PG evidence for T5 to T7.** Set `SUBSTRATE_TEST_PG_URL` against a migrated Postgres and run `steering-idempotency.pg.test.ts` (4 tests). Expected: all pass. The orchestrator's log (`/root/src/worktrees/backups/pg-targeted.log`: 44 pass, 0 fail, 281 expect() calls, "Ran 44 tests across 4 files") is labelled orchestrator evidence, not this verifier's observation. It names no test file, contains one run block (the prior record said it ran twice), and prints two stderr lines (`[substrate] live session expiry pass failed`, one `PostgresError ERR_POSTGRES_SERVER_ERROR`, one `Error`) that this verifier did not examine. [INFERENCE] Its 4 files may be live-session PG files rather than the steering file, so it cannot be tied to phase 77.
2. **Rehearse migration 43.** Apply it on a restored dump under the `steering-audit` opt-in, then reverse it. Expected: both directions run cleanly. Reversal drops `delivery_sequence` and its stored values; audit rows remain.
3. **Observe a forced audit failure inside a keyed claim on Postgres.** Expected: `audit-unavailable`, claim rolled back, nothing queued. Decide whether the in-transaction retry (H3) is acceptable.
4. **Decide HARD-H1 ownership and the out-of-order rule (H5).** Add `requirements: [HARD-H1]` to PLAN 77-01 or re-map it with owner approval. Decide whether `docs/live-steering.md:35` is the single out-of-order rule and state what a skipped number means to a reader.
5. **Reconcile stale text before merge (H6).** Update PLAN 77-01 D11 and R1 to the claim-in-transaction behaviour. Update the origin/main ROADMAP phase 77 Status and Plans lines, and `REQUIREMENTS.md:124` and `:139`.

### Open Decisions (kept open)

- **H3 (retry inside the failed transaction).** Whether to accept the aborted-transaction `lastErrorCode` or fail fast inside the transaction (`steering.ts:769-780`). Open. Not verified.
- **H5 (HARD-H1 ownership and out-of-order rule).** Open. No plan claims HARD-H1. `docs/live-steering.md:35` does not say what a skipped number means.
- **H6 (stale text).** Open. PLAN 77-01 D11 and R1, and the origin/main ROADMAP Status and Plans lines, contradict the code and the SUMMARY.

### Accepted Residual (per the brief; reported, not an open decision)

- **Counter gap for a concurrent keyed loser.** A concurrent keyed loser may consume one sequence number before its claim (`steering.ts:532`, claim at `:546`). It never produces a duplicate. The loser's claim inserts nothing and returns the winner's reply (`steering-store.ts:696-704`). Sequential replays write nothing. SUMMARY revision 3 records it.

### Gaps Summary

No must-have is FAILED. No blocker was found: no stub patterns, no missing or unwired artifact. Status is `human_needed` rather than `passed` for three reasons. T5, T6 and T7 are present and wired, but this verifier did not exercise them against Postgres (the orchestrator's log is cited and labelled, not re-observed). Decisions H3, H5 and H6 remain open. HARD-H1 ownership remains unassigned.

### Deviations and Evidence Notes

- **Mode.** A prior record exists (749e97e3, digest `c9535a76...`). Carried in `re_verification` as metadata; no gap closure claimed.
- **Brief HEAD and commit.** The brief's phase 77 note names `c7788f9d` for G1 to G3; that commit is phase 76's fix (see the correction at the top). Phase 77's G1 to G3 are in `9b3636ab`, an ancestor of HEAD. HEAD is `c7788f9d`, not `749e97e3`.
- **Citation drift from 749e97e3.** `service.ts` moved by 11 insertions and 3 deletions (phase 76 event-buffer paths). The steering wiring (`steeringDurableIdempotency` `:1871`, inbox `:1880-1889`, `resolveLive` `:1894`) is at the same lines the prior record cites. Steering modules did not change.
- **Settings line.** The idempotency config entry is `config.ts:785` (type) and `:1310` (loader); the prior record's `:784-785` is now `:785`.
- **Fingerprint.** `gsd_run query verification.fingerprint` over the 26 non-PLAN/SUMMARY files named in the frontmatter (the command added PLAN and SUMMARY automatically). Digest `6fc38bdd...`.
- **Full suite not run.** Assignment rule. The orchestrator's full gate on the integration tree is green per the brief.
- **Self-check.** From the worktree, `gsd_run query verification.status .planning/phases/77-steering-idempotency-and-ordering --pick status` printed `human_needed` with exit 0, after this record was written.

---

_Verified: 2026-11-02T18:27:16Z_
_Verifier: Claude (gsd-verifier)_
