---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-03T10:28:39Z
status: human_needed
score: 4/8 must-haves verified
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
  - "packages/mcp-server/src/mcp.steering.test.ts"
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
covered_digest: "v3:sha256:169a999784dd5b4a6103dd43796b833b4effbc2c860acc5ee3e744d95b434e78"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/8
  previous_verification: "77-VERIFICATION.md at 9ab6f111 (verified 2026-11-03T08:45:18Z, digest v3:sha256:aad227323ff15df7b20d622547c734853f6efb0db3de6ca52b172795583e3853); earlier records c7788f9d and 749e97e3"
  gaps_closed: []
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres. Present and wired; not run by this verifier. Orchestrator per-file log cited, labelled as the orchestrator's (4 pass, 0 fail; file-level, names no test)."
    - "T6 (W1): audit row and replay claim share one transaction. Present and wired; not run by this verifier. Same orchestrator per-file log."
    - "T7 (W2): cross-process single winner per scope key. Present and wired; not run by this verifier. Same orchestrator per-file log."
    - "T8 (narrowed this pass): the documented per-session order (docs/live-steering.md:35) holds for the wait cursor only. steering_list, GET /steering/directives and the docs_search notice order by priority. Open decision H5."
    - "HARD-H1 ownership: no plan claims it (REQUIREMENTS.md:124 unchecked, :139 Not started). Open decision H5."
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "steering-idempotency.pg.test.ts:73 under SUBSTRATE_TEST_PG_URL. Not run by this verifier (PG unset by design). Orchestrator per-file log pg-perfile-steering-idempotency.pg.test.log: 4 pass, 0 fail, 12 expect() calls, 4 tests across 1 file."
    expected: "The second IndexStore returns the saved replay exactly, and the sequence continues from the saved value."
    why_human: "This verifier did not start Postgres. The orchestrator's per-file log is orchestrator evidence and names no test. The restart suite (steering-durable.test.ts) uses MemorySteeringIdempotencyStore and a fake SQL port, which are not durable evidence."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "steering-idempotency.pg.test.ts:93 (claim whose unit fails keeps no record) and :112 (audit row and replay record committed together; retry replays)."
    expected: "A refused audit leaves no replay record; a retry on the other instance replays and no second queued row exists."
    why_human: "Not run by this verifier. Atomicity is one sql.begin (steering-store.ts:689-716). The inbox tests in steering-durable.test.ts (:948, :960) use MemorySteeringIdempotencyStore, which has no transaction. The orchestrator log is cited, not re-observed."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "steering-idempotency.pg.test.ts:122."
    expected: "One queued audit row for the session. One caller sees replayed false, the other replayed true, with the same directive id and sequence."
    why_human: "Not run by this verifier. The single winner rests on insert ... on conflict (scope_key) do nothing returning scope_key (steering-store.ts:691-695) and the scope_key primary key (index-store.ts:924). Only Postgres exercises it. The orchestrator log is cited, not re-observed."
coincidental_reliance_items: []
human_verification:
  - test: "Live Postgres proof for T5 to T7: run steering-idempotency.pg.test.ts (4 tests) against a migrated Postgres with SUBSTRATE_TEST_PG_URL set."
    expected: "All four pass. The afterAll hook deletes only rows whose session starts with the run prefix. The orchestrator's per-file log is labelled orchestrator evidence until this run is observed."
    why_human: "Operator live proof. This verifier did not run it, and the brief keeps the operator live proofs open."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it."
    expected: "Both directions run cleanly (index-store.ts:912-937; down at :917). Reversal drops planning_steering_audit.delivery_sequence and the two new tables, so stored sequence values are lost. Audit rows remain."
    why_human: "Operator item. Needs a live database and a rehearsal, which the migration requires before production. Migration 43 stays open."
  - test: "On Postgres, force an audit failure inside a keyed claim and observe the reported error code."
    expected: "The queue is refused as audit-unavailable, the claim rolls back, and nothing is queued. lastErrorCode may show the aborted-transaction code rather than the driver error, because the bounded audit retry runs inside the same transaction (steering.ts:769-780). Owner decision H3 stays open."
    why_human: "Behaviour under a real Postgres transaction abort is code reasoning here ([INFERENCE]). No double-apply follows from it."
  - test: "Decide HARD-H1 ownership and the ordering rule (H5), with the pull-surface finding below in view."
    expected: "Add HARD-H1 to a plan's requirements field, or re-map it with the owner's approval. Decide whether docs/live-steering.md:35 is the one documented ordering rule. If it is, either the pull reads (steering_list, GET /steering/directives, the docs_search notice) gain sequence order, or the sentence is narrowed to the wait cursor. State what a number skipped by a refused or lost keyed command means to a reader."
    why_human: "REQUIREMENTS.md:124 is unchecked and :139 says Not started. PLAN 77-01 has no requirements field. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Reconcile stale text before merge (H6)."
    expected: "77-01-PLAN.md D11 (line 49) and R1 (line 87) are updated to the claim-in-transaction behaviour. The origin/main ROADMAP phase 77 Status line (:1328) and Plans line, and REQUIREMENTS.md:124 and :139, are updated by the owner or orchestrator. The SUMMARY header (line 1, 'revision 2') is updated to revision 3."
    why_human: "Documentation reconciliation. The verifier does not edit planning docs."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-03T10:28:39Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 9ab6f111 (human_needed, 5/8) carries no `gaps:` block, so it is treated as re-verification metadata. Nothing was closed. No code regressed. The verdict on T8 is narrowed on a doc-to-code check that the prior record did not make.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `97defd59` (fix(73) memo v3 round 4). No code was edited, nothing was committed, the full suite, tsc, lint and formatters were not run, and no Postgres was started. `SUBSTRATE_TEST_PG_URL` was unset for every test command. Only `.planning/phases/77-steering-idempotency-and-ordering/77-VERIFICATION.md` was written, in the worktree.

**Criteria source:** `origin/main` `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3). They match PLAN 77-01. The Status line (:1328, "Not started") is stale (H6).

**Change since the prior record (9ab6f111 to 97defd59):**
- Phase 77 code is unchanged. `planning/` (every steering module and steering test), `index-store.ts`, the digests file, the migration contract and harness tests, and `docs/live-steering.md` are unchanged at the git-tree level from 96feb7b0 (2026-11-02 10:20) to 97defd59. The one file that changed in that window, `observer.test.ts` (48fb961c), is not covered and is a test timeout only.
- `packages/mcp-server/src/service.ts` is the only covered file changed since 9ab6f111. Its hunks are the phase 73 anchor-verify paths (`:863-948`, `:8017-8025`). No steering line changed content. The steering wiring is at the lines cited below.
- `mcp.steering.test.ts` was run in this pass and is now listed as evidence. It was not in the prior covered list.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (accepted residual noted) | Replay lookup runs after directive schema, key pattern, author and allowlist checks and before duplicate, rate and audit checks: `steering.ts:503-511` (checks), `:512-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` at `:573`. Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !replayed`), `:159`. Tests: `steering.test.ts:406` and `:427`, `steering-durable.test.ts:883` (non-PG, passed in Run B by count; see Targeted results). Residual: a cross-process concurrent loser takes a number before its claim (`steering.ts:532`), so a gap appears, never a duplicate. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152`. Tests: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence"; `steering.test.ts:438` "an unkeyed repeat is a second directive, as before". Both passed in Run B by count and the two files passed with 0 fail in Run A. Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under that opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156` (throws when a queued directive has no sequence, `:155`). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Tests: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"; `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order". |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`queuedFor` sorted by sequence, `steering.ts:456-462`; cursor by `inbox.sequenceOf` at `:65`; next by `entry.sequence > cursor` at `:67`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:107`, inside `:97-117`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2286`, inside `/steering/wait` at `:2272`. Restart keeps stored numbers and advances the counter past them: `steering.ts:657` (`restoredSequence`), `:663-667` (`advancePast` at `:665`). Tests: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns" (Run B by count); "after a restart the next distinct command takes the next sequence, and a restored directive keeps its own" in `steering-durable.test.ts` (in the Run A file run, 0 fail). |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T5; present and wired; not run by this verifier) | Migration 43: `index-store.ts:912-937` (`version: 43` at `:913`, expand, reversible `down` at `:917`, `scope_key text primary key` at `:924`, nullable `delivery_sequence` at `:935`). Bun adapter `bunSteeringIdempotencyStore`: `steering-store.ts:664-717`, sequence upsert `:666-672`, replay find `:680-687`, claim transaction `:688-716`. Factory `steeringIdempotency()` at `index-store.ts:1034`. Wired under the audit opt-in: `service.ts:1995-2006` (`steeringDurable`, `steeringDurableIdempotency`), inbox at `:2010-2019`. Execution: not run here. Orchestrator per-file log: see Orchestrator evidence. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T6; present and wired; not run by this verifier) | Keyed path takes the claim with the audit inside it: `steering.ts:546` (`claimKeyed`, `:582-593`). An audit refusal throws `AuditRefused` (`steering.ts:586`; class `:978-983`), which the store turns into a rollback: `steering-store.ts:689` (`sql.begin`), `:705` (`await queue(tx)`). The audit writes through the transaction: `steering-store.ts:298` (`bunSteeringAuditSql(unit)`). The inbox protocol is exercised by the memory store in Run B: `steering-durable.test.ts:948` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" and `:960` "an audit refusal inside the keyed claim holds nothing, so the retry queues once". The SQL atomicity is not observed here. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T7; present and wired; not run by this verifier) | Scope key is `JSON[author, session, key]` (`steering.ts:513`), and `scope_key` is the primary key (`index-store.ts:924`). The author stays in the key by design (SUMMARY G3; the test "a key from another author ... does not replay", `steering.test.ts:427`, requires it). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:691-695`). A loser reads the winner's row in the same transaction and returns its reply (`steering-store.ts:696-704`; `steering.ts:548`). The in-process path is serialised by the inbox lock (`steering.ts:801-805`, `exclusive`). No in-process concurrent test exists. The PG test is `steering-idempotency.pg.test.ts:122`, not run here. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Changed from the prior VERIFIED. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The other delivery and read surfaces do not: `steering_list`, the pull path that the `steering-delivery.ts` header describes ("a directive sat queued until its session called `steering_list`"), reads `recordsFor` (`steering-tools.ts:178`; `steering.ts:474-480`), which sorts by `compareDirectives` (`steering.ts:998-999`: priority rank, then created time, then id). Its `ListedSteeringDirective` (`steering-tools.ts:137`) carries no `sequence` field. `GET /steering/directives` sorts the same way (`steering-rest.ts:153`) and attaches `sequence` only as a field (`:155`). The docs_search steering notice is "highest priority first, then oldest" (`steering-delivery.ts:53`, `:63`). So the documented sentence holds on the wait surface only. Not FAILED: the criterion is met on the wait path, PLAN D9 scopes sequence delivery to the wait ("Wait delivery carries the sequence"), and whether a pull read counts as delivery is the owner's H5 decision. |

**Score:** 4/8 truths verified (T1 to T4). T5 to T7 are present and wired, not behaviour-verified by this verifier, and are excluded from the score. T8 is UNCERTAIN and is excluded from the score.

### Phase 77 fix commit check (G1 to G5)

The G1 to G5 fixes are in `9b3636ab`, an ancestor of `97defd59`.

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:664-687` (`nextSequence`, `findReplay`), `:688-716` (claim), `:720-730` (`replayRecord`) | `steering-idempotency.pg.test.ts:73` | Test present; PG-gated; not run here. Orchestrator per-file log cited. T5. |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`, `:586`; `steering-store.ts:689`, `:705`, `:298` | Memory side: `steering-durable.test.ts:948`, `:960` (inside Run B's count). PG side: `steering-idempotency.pg.test.ts:93`, `:112` (not run here) | Inbox protocol verified. SQL atomicity not observed here. T6. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:691-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG side: `steering-idempotency.pg.test.ts:122` (not run here). No in-process concurrent test | Code present; race behaviour not observed here. T7. |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (inside Run B's count) | VERIFIED. The SUMMARY cites `:243-251`; the test is at `:249`. Citation drift only. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

`verify.artifacts` on `77-01-PLAN.md` reports no `must_haves.artifacts` in the plan frontmatter, so Step 4 is not applicable. Manual Levels 1 to 3 below. None is a stub. Each is imported and used.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED (code) | Keyed path `:503-550`, `replayOf` `:572-576`, `claimKeyed` `:582-593`, `restoredSequence` `:663-667`, audit retry `:769-780`, `MemorySteeringIdempotencyStore` `:329-361`, `loadSteeringIdempotencySettings` `:876`, `AuditRefused` `:978-983`, `exclusive` `:801-805`. Wired: `service.ts:2010-2019`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with `unit`, Bun idempotency adapter | ✓ VERIFIED (code) / not executed here | `record` with unit `:291-298`, `deliverySequence` `:596`, `bunSteeringIdempotencyStore` `:664-717`, `replayRecord` `:720-730`. Execution unverified (T5, T6, T7). |
| `packages/mcp-server/src/index-store.ts` | Migration 43 and factory | ✓ VERIFIED (code) / not executed here | Migration `:912-937` (`version: 43`, expand, reversible `down` `:917`, `scope_key` PK `:924`, `delivery_sequence` `:935`). Factory `steeringIdempotency()` `:1034`. Digest `"43"` at `index-store.migrations.digests.json:44`. Not executed here; operator item. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | Enqueue `:148`; `freshlyQueued` `:150`; unkeyed early return `:152`; keyed reply `:153-156`; wake-up only on a fresh queue `:158-159`. `steering_list` `:178-180` has no sequence (see T8). |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries sequence; 409 and 503 mapping | ✓ VERIFIED | `restDirective` `:97-117` (sequence `:107`); listing `:148-155`; `idempotency-conflict` → 409 `:290-291`; `audit-unavailable` → 503 `:294-295`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `nextQueuedDirective` `:63-68`. |
| `packages/mcp-server/src/planning/steering-delivery.ts` | Notice ordering | ✓ VERIFIED (code) / ordering caveat | `steeringNoticeFor` `:63` reads `recordsFor` (priority order); documented "highest priority first, then oldest" `:53`. See T8. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `/steering/wait` `:2272`; body `restDirective(waited.record, waited.sequence)` `:2286`. |
| `packages/mcp-server/src/service.ts` | Wiring of the durable store, idempotency store and inbox | ✓ VERIFIED (code) | `steeringErrors` `:1988-1990`; `steeringDurable` `:1995-2000`; `steeringDurableIdempotency` `:2001-2006` (factory `:2005`); `SteeringInbox` `:2010-2019`; `resolveLive` `:2024` (the prior record's `:2023` was the comment line). `onQueued` `:2040`. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | Settings and flags | ✓ VERIFIED | `config.ts:786` (type), `:1325` (loader). `flag-registry.ts:344-345` (`SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S`, `_CAP`). |
| `.env.example`, `docs/config-reference.md` | Documented settings | ✓ VERIFIED | `.env.example:935`, `:937`; `docs/config-reference.md:60-61`. |
| `docs/runbooks/rollback-compat.md` | Step 43 named | ✓ VERIFIED | `:56` names step 43 `planning_steering_idempotency`, opt-in `steering-audit`. |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED (keys) / ⚠️ ordering sentence overstated | `:33` keys, sequence, settings and bounds. `:35` see T8. |
| `packages/mcp-server/src/index-store.migrate-contract.test.ts`, `.migrate-harness.test.ts` | Step 43 allowlisted; opt-in expectation 33, 34, 43 | ✓ VERIFIED | Allowlist reasons `:69-70`. Harness `:194` `[...ALL, 33, 34, 43]`; `:198` `ledger.has(43)`. Both files passed in Run A (0 fail). |

### Key Link Verification

`verify.key-links` on `77-01-PLAN.md` reports no `must_haves.key_links` in the plan frontmatter. Manual wiring checks:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts:148` | `SteeringInbox.enqueueReceipt` | direct call | ✓ WIRED | Passes `idempotency_key`; reads `replayed` (`:150`). |
| `steering-tools.ts:154` | `inbox.sequenceOf` | keyed reply | ✓ WIRED | Throws when a queued directive has no sequence (`:155`). |
| `steering.ts:532` | `store.nextSequence` | before claim or audit | ✓ WIRED | Source of the accepted counter-gap residual for concurrent losers. |
| `steering.ts:546` | `store.claimReplay` (via `claimKeyed` `:582`) | audit in unit | ✓ WIRED | Commit-or-rollback via the unit (code). |
| `steering-store.ts:705` | `history.append` in `tx` | `queue(tx)` → `audit(entry, unit)` → `record` | ✓ WIRED | The audit uses the transaction (`:298`). `append` throws on refusal (`steering-store.ts:236`); `audit` retries and reports. |
| `service.ts:2001-2006` | `index.steeringIdempotency()` | durable opt-in only | ✓ WIRED | Built only when `steeringDurable` is set, i.e. the audit opt-in is on. Otherwise `MemorySteeringIdempotencyStore` (`steering.ts:329`). |
| `steering-waiters.ts:64-67` | `inbox.queuedFor` → `sequenceOf` | cursor | ✓ WIRED | Cursor is sequence, not time. |
| `server.ts:2286` | `restDirective(waited.record, waited.sequence)` | wait body | ✓ WIRED | `server.steering.test.ts:249`. |
| `steering.ts:665` | `store.advancePast` | `restoredSequence` | ✓ WIRED | Restored directives keep their stored number; the counter moves past it. |
| `steering-tools.ts:178` / `steering-rest.ts:148` | `inbox.recordsFor` → `compareDirectives` | pull listing order | ⚠️ WIRED, order is priority | Not sequence order. `steering_list` returns no sequence. See T8 and H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering.ts` `replayOf` | `held` (replay record) | `findReplay` or claim result | In memory: yes. Postgres: code path only. | ✓ FLOWING (memory, tested). Postgres not run by this verifier (T5). |
| `steering-rest.ts` listing | `sequence` | `inbox.sequenceOf` | Yes, from the counter the queue set | ✓ FLOWING |
| `steering-waiters.ts` | `sequence` | `inbox.sequenceOf` via `queuedFor` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Two `bun test` commands, the phase budget. Both ran from `packages/mcp-server` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No Postgres was started.

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A: phase 77 steering suites plus `service.test.ts` (file run, `--timeout 30000`) | `bun test` on `planning/steering.test.ts`, `planning/steering-durable.test.ts`, `planning/steering-tools.test.ts`, `planning/steering-waiters.test.ts`, `planning/steering-rest.test.ts`, `planning/steering-idempotency.pg.test.ts`, `server.steering.test.ts`, `mcp.steering.test.ts`, `index-store.migrate-contract.test.ts`, `index-store.migrate-harness.test.ts`, `service.test.ts` | 585 pass, 6 skip, 0 fail; 591 tests across 11 files; 3382 expect() calls; 30.78 s. Four of the six skips are the `describeLive` tests of `steering-idempotency.pg.test.ts` (PG unset). The other two were not identified. The prior record's run was 564 pass over 10 files; the composition differs, so totals are not comparable. | ✓ PASS (0 fail) |
| B: named phase 77 tests (`-t` filter, `--verbose`, `--timeout 30000`) | `bun test --verbose -t` over `steering.test.ts`, `steering-durable.test.ts`, `steering-tools.test.ts`, `server.steering.test.ts`, `steering-idempotency.pg.test.ts`; pattern covers the replay, author-scope, sequence, restart, lost-reply, audit-refusal, wait-body, PG-replay, PG-unit-failure, PG-commit and PG-concurrency tests, plus the two unkeyed tests and the two retention/conflict restart tests | 12 pass, 4 skip, 0 fail; "Ran 16 tests across 5 files" (1.59 s). The mapping to names is by inference (see below). | ✓ PASS (0 fail) |

**Run B mapping [INFERENCE].** Static enumeration of `test(` names in the five files matches the filter in exactly 16 tests: `steering.test.ts` 406, 427, 438, 447; `steering-durable.test.ts` 883, 912, 922, 948, 960; `steering-tools.test.ts` 217, 227; `server.steering.test.ts` 249; `steering-idempotency.pg.test.ts` 73, 93, 112, 122. That count equals the runner's "Ran 16 tests". The four PG tests in `steering-idempotency.pg.test.ts` are the four skips (`describeLive`, PG unset). The remaining 12 matched tests therefore passed. The per-name verbose lines were dropped by my own output filter, and the two-command budget does not allow a re-run, so no per-name pass line was observed.

### Orchestrator Postgres per-file evidence (T5 to T7; labelled as the orchestrator's, not this verifier's)

`/root/src/worktrees/backups/pg-perfile-steering-idempotency.pg.test.log` (dated 2026-11-02 18:37): `bun test v1.4.0`; 4 pass, 0 fail, 12 expect() calls; "Ran 4 tests across 1 file [1.69s]". This is the orchestrator's statement. It names no test, so it does not show which of the four tests passed. It is cited for T5 to T7 and does not upgrade them. The code it ran against is unchanged at the git-tree level from 96feb7b0 to 97defd59 (see Change since the prior record). The log is dated after 96feb7b0 and before 48fb961c, and `observer.test.ts`, the only file changed in that window, is not steering code.

### Probe Execution

No probe applies. Neither the PLAN nor the SUMMARY declares a probe path, and this is not a tooling phase. Migration 43 is covered by human item 2.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence; same-key/same-payload replay returns the identical original result without another effect; changed payload under the same key is refused; one documented out-of-order rule; schema/size caps; durable replay state; unkeyed commands get no false idempotency guarantee | ✗ ORPHANED (ownership open, H5) | Covered in code and tests: keyed replay and conflict (T1), sequence and wait (T3, T4), key grammar (`steering.ts:507`, 8 to 128 characters), body cap (4096 characters, `docs/live-steering.md:33`), unkeyed reply has no key (T2). Durable state is T5 to T7, present and wired, not run by this verifier. The "one documented out-of-order rule" is T8, which is UNCERTAIN. |

Other requirements mapped to Phase 77: none. Step 9b: no later phase of the origin/main roadmap names HARD-H1, steering idempotency or the steering sequence, so nothing is deferred.

Owner text (`REQUIREMENTS.md:124`) and status (`REQUIREMENTS.md:139`, "Not started") unchanged. No plan in `.planning` claims HARD-H1.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `steering.ts` | 532, 546 | Counter taken before the claim, so a concurrent loser consumes a sequence number | ⚠️ Warning (accepted residual) | SC1 "writes nothing" holds for sequential replays and for in-process concurrency (inbox lock). Cross-process concurrent losers leave a gap, never a duplicate. Accepted per the brief. |
| `steering.ts` | 769-780 with `steering-store.ts:298` | Bounded audit retry runs inside the same Postgres transaction after a failed statement | ⚠️ Warning (H3) | [INFERENCE] Later attempts fail with the aborted-transaction code, so `lastErrorCode` can differ from the driver error. The claim still rolls back, so no double-apply. |
| `steering-store.ts` | 688-716 | Claim and audit atomicity exists only in the SQL adapter, never executed here | ⚠️ Warning | T6 and T7, behaviour-unverified by this verifier. |
| `steering-tools.ts` / `steering-rest.ts` / `steering-delivery.ts` | 178-180 / 148-155 / 63 | Pull listing and notice are priority-ordered; `steering_list` has no `sequence` | ⚠️ Warning | T8. Against `docs/live-steering.md:35`. Owner decision H5. |
| `77-01-PLAN.md` | D11 (line 49), R1 (line 87) | D11 says the replay record is written after the audit and a save failure does not fail the queue; R1 says a crash between audit commit and replay save is a documented residual. Both describe superseded behaviour: the claim is one transaction (`steering.ts:546`, `steering-store.ts:689`), and a failed claim fails the queue. | ℹ️ Info (stale) | Open decision H6. |
| origin/main `ROADMAP.md` phase 77 | `:1328` Status | "Not started" | ℹ️ Info (stale) | Open decision H6. The Plans line was not re-read in this pass. |
| `REQUIREMENTS.md` | 124, 139 | HARD-H1 unchecked; "Not started" | ℹ️ Info | Open decision H5. |
| `77-01-SUMMARY.md` | G4 (line 91) | Cites `server.steering.test.ts:243-251`; the test is at `:249` | ℹ️ Info | Citation drift only. |
| `77-01-SUMMARY.md` | line 1 | Header says "revision 2: durable"; the body has a "Revision 3" section (line 86) | ℹ️ Info | Header not updated. No effect on code. |

Debt-marker grep this pass (`TBD|FIXME|XXX` across the steering modules, `index-store.ts`, `service.ts`, `server.ts`, `config.ts`, `flag-registry.ts` and `docs/live-steering.md`, excluding test files): no matches. The Step 7 debt gate is not triggered.

### Human Verification Required

1. **Live Postgres proof for T5 to T7.** Set `SUBSTRATE_TEST_PG_URL` against a migrated Postgres and run `steering-idempotency.pg.test.ts` (4 tests). Expected: all pass. Until it is observed, T5 to T7 stay ⚠️ PRESENT_BEHAVIOR_UNVERIFIED.
2. **Rehearse migration 43.** Apply it on a restored dump under the `steering-audit` opt-in, then reverse it. Expected: both directions run cleanly. Reversal drops `delivery_sequence` and the two tables, and stored values are lost; audit rows remain.
3. **Observe a forced audit failure inside a keyed claim on Postgres.** Expected: `audit-unavailable`, claim rolled back, nothing queued. Decide whether the in-transaction retry (H3) is acceptable.
4. **Decide HARD-H1 ownership and the ordering rule (H5), with the pull-surface finding in view.** Add `requirements: [HARD-H1]` to PLAN 77-01 or re-map it with owner approval. Decide whether `docs/live-steering.md:35` is the single ordering rule. If it is, either `steering_list`, `GET /steering/directives` and the docs_search notice move to sequence order, or the sentence is narrowed to the wait cursor. State what a skipped number means to a reader.
5. **Reconcile stale text before merge (H6).** Update PLAN 77-01 D11 (line 49) and R1 (line 87). Update the origin/main ROADMAP phase 77 Status and Plans lines, `REQUIREMENTS.md:124` and `:139`, and the SUMMARY header.

### Open Decisions (kept open)

- **H3 (retry inside the failed transaction).** Whether to accept the aborted-transaction `lastErrorCode` or fail fast inside the transaction (`steering.ts:769-780`). Open. Not verified.
- **H5 (HARD-H1 ownership and the ordering rule).** Open. No plan claims HARD-H1. `docs/live-steering.md:35` is unqualified; the pull reads (`steering_list` at `steering-tools.ts:178`, `GET /steering/directives` at `steering-rest.ts:153`, the docs_search notice at `steering-delivery.ts:63`) are priority-ordered, and `steering_list` carries no sequence. This pass adds that fact to H5.
- **H6 (stale text).** Open. PLAN 77-01 D11 and R1, the origin/main ROADMAP Status and Plans lines, REQUIREMENTS `:124` and `:139`, and the SUMMARY header contradict the code and the SUMMARY's revision 3.
- **Migration 43.** Open operator item. Not executed. Rehearsal required before production.

### Accepted Residual (per the brief; reported, not an open decision)

- **Counter gap for a concurrent keyed loser.** A concurrent keyed loser may consume one sequence number before its claim (`steering.ts:532`, claim at `:546`). It never produces a duplicate. The loser's claim inserts nothing and returns the winner's reply (`steering-store.ts:696-704`). Sequential replays write nothing.

### Gaps Summary

No must-have is FAILED. No blocker was found: no stub patterns, no missing or unwired artifact, no debt markers, no stale-code citation that the code contradicts beyond T8's documentation scope. Status is `human_needed` rather than `passed` for four reasons:

1. T5, T6 and T7 are present and wired, but this verifier did not exercise them against Postgres. The orchestrator's per-file log is cited and labelled as the orchestrator's evidence, and it names no test.
2. T8 is UNCERTAIN. The documented per-session order holds for the wait cursor and fails for the pull reads. Whether those reads are "delivery" is owner decision H5.
3. Decisions H3, H5 and H6 remain open, and HARD-H1 ownership remains unassigned.
4. Migration 43 remains an operator item.

Step 9b (deferred items): none.

### Deviations and Evidence Notes

- **HEAD.** `97defd59` (fix(73) round 4). The prior record was at `9ab6f111`. Phase 77 code is unchanged since 96feb7b0 (see Change since the prior record).
- **Citation drift.** `service.ts` steering lines are current as cited above. The prior record's `resolveLive :2023` was the comment line; the const is `:2024`. `config.ts` `:786` and `:1325` are unchanged. `server.steering.test.ts:249` is unchanged.
- **Run A composition.** Run A adds `index-store.migrate-harness.test.ts` and `mcp.steering.test.ts` to the prior set, and keeps `service.test.ts`. The 585 pass total is not comparable to the prior 564.
- **Run B identity.** The verbose names were lost to my output filter, and the two-command budget does not permit a re-run. The 16-test mapping is by static enumeration plus the runner's count, labelled [INFERENCE].
- **Run A skips.** Six skips: four are `describeLive` PG tests. The other two were not identified.
- **Fingerprint.** `node /root/.claude/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/77-steering-idempotency-and-ordering` over the 27 implementation files listed in the frontmatter (PLAN and SUMMARY added automatically). Digest `v3:sha256:169a9997...`. The command's output is copied verbatim above.
- **Full suite, tsc, lint, formatters.** Not run (assignment rule).
- **No code edits, no commits, no PG.** `env -u SUBSTRATE_TEST_PG_URL` on every test command. Nothing written under `/root/src/repos/agent-substrate`.

---

_Verified: 2026-11-03T10:28:39Z_
_Verifier: Claude (gsd-verifier)_
