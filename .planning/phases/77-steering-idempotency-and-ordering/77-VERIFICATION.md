---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-03T16:03:09Z
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
  - "packages/mcp-server/src/event.test.ts"
  - "packages/mcp-server/src/event.ts"
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
covered_digest: "v3:sha256:03048971de56700a7c67770c7f3e07045093fe3e1749d21b519032e671e92fde"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/8
  previous_verification: "77-VERIFICATION.md at 8a604455 (verified 2026-11-03T15:36:53Z, digest v3:sha256:ff56c17e9849468777616f02a29e7f9eacd90a977230abf34d322eb9be618712); earlier records at 97defd59, 9ab6f111, c7788f9d and 749e97e3"
  gaps_closed:
    - "T1 to T4 re-observed by name at 4b84e50c (11 named tests, 11 pass). Their status is unchanged: VERIFIED."
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres. Present and wired; not run by this verifier. Orchestrator per-file log cited, labelled as the orchestrator's (4 pass, 0 fail; file-level, names no test; file mtime 2026-11-02 18:37:04 +0000, predates 8a604455 and 4b84e50c)."
    - "T6 (W1): audit row and replay claim share one transaction. Present and wired; not run by this verifier. Same orchestrator per-file log."
    - "T7 (W2): cross-process single winner per scope key. Present and wired; not run by this verifier. Same orchestrator per-file log."
    - "T8: the documented per-session order (docs/live-steering.md:35) holds for the wait cursor only. steering_list, GET /steering/directives and the docs_search notice order by priority. Open decision H5."
    - "HARD-H1 ownership: no plan claims it (REQUIREMENTS.md:124 unchecked, :139 Not started). Open decision H5."
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "steering-idempotency.pg.test.ts:73 under SUBSTRATE_TEST_PG_URL. Not run by this verifier (PG unset by design). ORCHESTRATOR PER-FILE EVIDENCE, not this verifier's: /root/src/worktrees/backups/pg-perfile-steering-idempotency.pg.test.log, file mtime 2026-11-02 18:37:04 +0000, which predates commit 8a604455 (2026-11-03 15:23 +0000) and commit 4b84e50c (2026-11-03 15:52 +0000): 4 pass, 0 fail, 12 expect() calls, 4 tests across 1 file."
    expected: "The second IndexStore returns the saved replay exactly, and the sequence continues from the saved value."
    why_human: "This verifier did not start Postgres. The orchestrator's per-file log is orchestrator evidence, predates 4b84e50c, and names no test. The restart suite (steering-durable.test.ts) uses MemorySteeringIdempotencyStore and a fake SQL port, which are not durable evidence."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "steering-idempotency.pg.test.ts:93 (claim whose unit fails keeps no record) and :112 (audit row and replay record committed together; retry replays). ORCHESTRATOR PER-FILE EVIDENCE: the same log as T5 (predates 4b84e50c)."
    expected: "A refused audit leaves no replay record; a retry on the other instance replays and no second queued row exists."
    why_human: "Not run by this verifier. Atomicity is one sql.begin (steering-store.ts:689-716). The inbox tests in steering-durable.test.ts (:948, :960) use MemorySteeringIdempotencyStore, which has no transaction. The orchestrator log is cited, not re-observed."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "steering-idempotency.pg.test.ts:122. ORCHESTRATOR PER-FILE EVIDENCE: the same log as T5 (predates 4b84e50c)."
    expected: "One queued audit row for the session. One caller sees replayed false, the other replayed true, with the same directive id and sequence."
    why_human: "Not run by this verifier. The single winner rests on insert ... on conflict (scope_key) do nothing returning scope_key (steering-store.ts:692-695) and the scope_key primary key (index-store.ts:924). Only Postgres exercises it. The orchestrator log is cited, not re-observed."
coincidental_reliance_items: []
human_verification:
  - test: "Live Postgres proof for T5 to T7: run steering-idempotency.pg.test.ts (4 tests) against a migrated Postgres with SUBSTRATE_TEST_PG_URL set, at HEAD 4b84e50c."
    expected: "All four pass. The afterAll hook deletes only rows whose session starts with the run prefix (steering-idempotency.pg.test.ts:50-58). The orchestrator's per-file log is labelled orchestrator evidence and predates 4b84e50c until this run is observed."
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
    expected: "77-01-PLAN.md D11 (line 49) and R1 (line 87) are updated to the claim-in-transaction behaviour. The ROADMAP phase 77 Status line (:1332) and Plans line (:1342), and REQUIREMENTS.md:124 and :139, are updated by the owner or orchestrator. The SUMMARY header (line 1, 'revision 2') is updated to revision 3."
    why_human: "Documentation reconciliation. The verifier does not edit planning docs."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-03T16:03:09Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 8a604455 (human_needed, 4/8) carries no `gaps:` block, so it is treated as re-verification metadata. Nothing was closed by code. T1 to T4 were re-observed by name at 4b84e50c. T5 to T8 and HARD-H1 are unchanged.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `4b84e50c` (fix(72,73): access and visibility compare exact repo spellings; the key normalizer is for session keys only). No code was edited, nothing was committed, the full suite, tsc, lint and formatters were not run, and no Postgres was started. `SUBSTRATE_TEST_PG_URL` was unset for the one test command. Only `.planning/phases/77-steering-idempotency-and-ordering/77-VERIFICATION.md` was written, in the worktree.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1330 and 1338 to 1340). They match PLAN 77-01. The Status line (:1332) and the Plans line (:1342) are stale against the code (H6).

**Change since the prior record (8a604455 to 4b84e50c):**
- Commit 4b84e50c changes 8 files. Of the phase 77 covered files, only `service.ts` and `index-store.ts` changed. Both changes are single-line replacements, so no line number moved.
- `index-store.ts` hunks are at `:2650` (memory search `agentRepo`) and `:2682` (`memoryForBrief` `normalizedRepo`). Neither touches migration 43 (`:912-937`) or `steeringIdempotency()` (`:1034`).
- `service.ts` hunks are at `:2501`, `:3647`, `:3735` and `:4592`, all memory and repo sites. None touches the steering wiring (`:1984-2040`), so the steering citations below still hold. Verified with `git diff -U0 8a604455 4b84e50c`.
- `event.ts` and `event.test.ts` are byte-identical across the window. So `normalizeKey` (`event.ts:216`) and `normalizeIdentifier` (`event.ts:207`) are unchanged, and the session-key claim below rests on the same code as before.
- The steering modules (`planning/`), `server.ts`, `mcp.ts`, `config.ts`, `flag-registry.ts`, the migration contract and harness tests, the digests file, the steering test files, `.env.example` and `docs/` are byte-identical (`git diff --quiet 8a604455 4b84e50c` over those paths is empty).
- The 4b84e50c change to `memory-policy.ts`, `session-context.ts`, `memory-write.ts`, `types.ts` and `capsule.ts` is outside the phase 77 covered set. It switches repo comparisons to `normalizeIdentifier` on both sides. It touches no steering path (no `steering` symbol in those hunks).

## Session-key normalization (8a604455, unchanged at 4b84e50c): does `normalizeKey` change steering session keys' stored form?

**Answer: no.** The stored form of every steering session key is unchanged, for every value the steering path accepts.

1. **The normalizer.** `normalizeKey(v) = withoutDanglingHigh(normalizeIdentifier(v))` (`event.ts:216-218`). `normalizeIdentifier` is `clean(v, MAX_FIELD)` (`event.ts:207-209`). `withoutDanglingHigh` (`event.ts:190-196`) changes a string only when its last UTF-16 code unit is in `D800`–`DBFF`. Since `normalizeKey` differs from `normalizeIdentifier` only in that case, the two are equal for any string whose capped form does not end in a high surrogate.
2. **The steering keys are ASCII and bounded.** Every steering session key is validated before it is stored or read:
   - Target session ids (`targetSessionId`, `session_id`, `steering_session_id`, `target_session_id`) match `SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` (`planning/presence.ts:18`). They are ASCII and at most 128 code units.
   - Live steering session ids match `LIVE_ID = /^ls_[a-f0-9]{64}$/` (`planning/steering-sessions-store.ts:122`), also ASCII.
   - Steering repo ids pass `scopeRepoId` (`event.ts:650-654`), which admits only `[a-z0-9._-]+/[a-z0-9._-]+`, also ASCII.
   For any such value the last code unit is never a high surrogate, so `withoutDanglingHigh` is the identity, and the 512-unit cap does not cut. Therefore `normalizeKey(s) === normalizeIdentifier(s) === s`.
3. **The steering store does not normalize.** `planning/steering-store.ts` and the other steering modules do not import `normalizeKey` or `normalizeIdentifier` (checked by reading the import blocks). The steering rows, the sequence table (`planning_steering_sequence`, `target_session_id`) and the replay `scope_key` (`JSON[author, session, key]`, `steering.ts:513`) are written and read with the raw validated value.
4. **Ledger writes of steering events.** Steering events reach the ledger through `normalizeEvent`, where `session_id` is `normalizeKey(input.session_id)` (`event.ts:401`). Per point 2 this is the same stored value as before the commit for every steering session key. The `assertWriteTextFields` refusal (`event.ts:277`) refuses only lone surrogates, which no SESSION_ID_RE value can contain, so steering writes are not refused.
5. **Read paths agree with the write path.** The ledger reads that take a session key use `normalizeKey` on both sides (`service.ts:4628`, `:4663`, `:4924` at 4b84e50c, unchanged line numbers), which is the identity for these keys.
6. **Out of scope for steering.** The straddling-identifier owner item (rows stored with a lone high surrogate before the change, `event.ts` and the 8a604455 commit message) can only affect a `session_id` or `repo` longer than 512 code units that ends in a straddling pair. Steering session keys are at most 128 ASCII units and steering repo ids are `scopeRepoId`-bounded, so that item cannot reach a steering session key. It remains the owner's data decision.

The 4b84e50c change (exact `normalizeIdentifier` on repo comparisons) does not alter this argument: it touches no key normalizer, no steering key and no `event.ts` line.

**Test evidence for the claim (4b84e50c).** Run D (below) includes `event.test.ts:273` and `:302`, both passing at 4b84e50c.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (re-observed at 4b84e50c; accepted residual noted) | Replay lookup runs after directive schema, key pattern, author and allowlist checks and before duplicate, rate and audit checks: `steering.ts:503-518` (checks, scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !replayed`), `:159`. Re-observed at 4b84e50c: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left", `:417` "the same key with different content is refused as a conflict and writes nothing", `:427` "a key from another author, or for another target session, does not replay". Restart replay `steering-durable.test.ts:883` carried forward from 97defd59 (Run B). Residual: a concurrent cross-process loser consumes a sequence number before its claim (`steering.ts:532`, `:546`); a gap, never a duplicate. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED (re-observed at 4b84e50c) | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152`. Re-observed at 4b84e50c: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence"; `steering.test.ts:438` "an unkeyed repeat is a second directive, as before". Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under that opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED (re-observed at 4b84e50c) | Keyed reply carries `sequence`: `steering-tools.ts:153-156` (throws when a queued directive has no sequence, `:155`). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Re-observed at 4b84e50c: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"; `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order". |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`queuedFor` sorted by sequence, `steering.ts:456-462`; cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:107`, inside `:97-117`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2286`, inside `/steering/wait` at `:2272`. Re-observed at 4b84e50c: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns". Restart keeps stored numbers and advances the counter past them (`steering.ts:657`, `restoredSequence` `:663-667`); `steering-durable.test.ts:899` carried forward from 97defd59 (Run B). Waiter and restart tests were not re-run at 4b84e50c. |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T5; present and wired; not run by this verifier) | Migration 43: `index-store.ts:912-937` (`version: 43` at `:913`, expand, reversible `down` at `:917`, `scope_key text primary key` at `:924`, nullable `delivery_sequence` at `:935`). Bun adapter `bunSteeringIdempotencyStore`: `steering-store.ts:664-717`, sequence upsert `:666-672`, replay find `:680-687`, claim transaction `:688-716`. Factory `steeringIdempotency()` at `index-store.ts:1034`. Wired under the audit opt-in: `service.ts:1995-2006`, inbox at `:2010-2019`. Execution: not run here. Orchestrator per-file log cited (T5 to T7 section), labelled as the orchestrator's, predates 4b84e50c. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T6; present and wired; not run by this verifier) | Keyed path takes the claim with the audit inside it: `steering.ts:546` (`claimKeyed`, `:582-593`). An audit refusal throws `AuditRefused` (`steering.ts:586`; class `:978-983`), which the store turns into a rollback: `steering-store.ts:689` (`sql.begin`), `:705` (`await queue(tx)`). The audit writes through the transaction: `steering-store.ts:298` (`bunSteeringAuditSql(unit)`). The inbox protocol is exercised by the memory store: `steering-durable.test.ts:948` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" and `:960` "an audit refusal inside the keyed claim holds nothing, so the retry queues once" (name-matched at 4b84e50c, not re-run; carried forward from 97defd59, Run B). SQL atomicity not observed here. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (T7; present and wired; not run by this verifier) | Scope key is `JSON[author, session, key]` (`steering.ts:513`), and `scope_key` is the primary key (`index-store.ts:924`). The author stays in the key by design (SUMMARY G3; `steering.test.ts:427` requires it). The claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:692-695`). A loser reads the winner's row in the same transaction and returns its reply (`steering-store.ts:696-704`; `steering.ts:548`). The in-process path is serialised by the inbox lock. Only Postgres exercises the cross-process case. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` (`steering-tools.ts:178`) reads `recordsFor` (`steering.ts:475-481`), which sorts by `compareDirectives` (`steering.ts:998-999`: priority rank, then `createdAtMs`, then id), and its listed shape has no `sequence` field (`steering-tools.ts:179`). `GET /steering/directives` (`steering-rest.ts:147-155`) uses the same comparator and does carry `sequence`. The docs_search notice (`steering-delivery.ts:62-63`) reads `recordsFor` and takes the first entries in priority order. The documented sentence is therefore true of the wait cursor and not of the pull reads. Whether pull reads count as delivery is owner decision H5. |

**Score:** 4/8 truths verified (T1 to T4). T5 to T7 are present and wired, not behaviour-verified by this verifier, and are excluded from the score. T8 is UNCERTAIN and is excluded from the score.

### Phase 77 fix commit check (G1 to G5)

The G1 to G5 fixes are in `9b3636ab`, an ancestor of `8a604455`. Their code is unchanged at 4b84e50c.

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:664-687` (`nextSequence`, `findReplay`), `:688-716` (claim), `:720-730` (`replayRecord`) | `steering-idempotency.pg.test.ts:73` | Test present; PG-gated; not run here. Orchestrator per-file log cited (predates 4b84e50c). T5. |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`, `:586`; `steering-store.ts:689`, `:705`, `:298` | Memory side: `steering-durable.test.ts:948`, `:960`. PG side: `steering-idempotency.pg.test.ts:93`, `:112` (not run here) | Inbox protocol carried forward (97defd59). SQL atomicity not observed here. T6. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:692-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG side: `steering-idempotency.pg.test.ts:122` (not run here). No in-process concurrent test | Code present; race behaviour not observed here. T7. |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` | VERIFIED, re-observed at 4b84e50c (Run D). The SUMMARY cites `:243-251`; the test is at `:249`. Citation drift only. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

`verify.artifacts` on `77-01-PLAN.md` reports no `must_haves.artifacts` in the plan frontmatter, so Step 4 is not applicable. Manual Levels 1 to 3 below. None is a stub. Each is imported and used.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED (code) | Keyed path `:503-550`, `replayOf` `:572-576`, `claimKeyed` `:582-593`, `restoredSequence` `:663-667`, audit retry `:769-780`, `MemorySteeringIdempotencyStore` `:329`, `loadSteeringIdempotencySettings` `:876`, `AuditRefused` `:978-983`. Wired: `service.ts:2010-2019`. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with `unit`, Bun idempotency adapter | ✓ VERIFIED (code) / not executed here | Unit-aware audit `:298`, `bunSteeringAuditSql` `:327`, `bunSteeringIdempotencyStore` `:664-717`, `replayRecord` `:720`. Execution unverified (T5, T6, T7). Unchanged at 4b84e50c; does not call a normalizer. |
| `packages/mcp-server/src/index-store.ts` | Migration 43 and factories | ✓ VERIFIED (code) / not executed here | Migration `:912-937` (`version: 43`, expand, reversible `down` `:917`, `scope_key` PK `:924`, `delivery_sequence` `:935`). Factories `steeringAudit()` `:1026`, `steeringIdempotency()` `:1034`. Digest `"43"` at `index-store.migrations.digests.json:44`. Not executed here; operator item. 4b84e50c edits `index-store.ts` at `:2650` and `:2682` only. |
| `packages/mcp-server/src/event.ts` | Normalizer for steering session keys on the ledger | ✓ VERIFIED (code) | `withoutDanglingHigh` `:190-196`, `normalizeIdentifier` `:207`, `normalizeKey` `:216`, `assertWriteTextFields` `:277`, `session_id` `:401`, `repo` `:407`, `scopeRepoId` `:650-654`. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/event.test.ts` | normalizeKey ordinary-id test | ✓ VERIFIED (run) | `:273` and `:302`, both passed in Run D at 4b84e50c. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | Enqueue `:148`; `freshlyQueued` `:150`; unkeyed early return `:152`; keyed reply `:153-156`; wake-up only on a fresh queue `:158-159`. `steering_list` `:174-184` has no sequence (see T8). Unchanged at 4b84e50c. |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries sequence; 409 and 503 mapping | ✓ VERIFIED | `restDirective` `:97-117` (sequence `:107`); listing `:147-155`; `idempotency-conflict` → 409 `:290-291`; `audit-unavailable` → 503 `:294-295`. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | `nextQueuedDirective` `:63-68`. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/planning/steering-delivery.ts` | Notice ordering | ✓ VERIFIED (code) / ordering caveat | `steeringNoticeFor` `:62` reads `recordsFor` (priority order); documented "highest priority first, then oldest" `:53`. See T8. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `/steering/wait` `:2272`; body `restDirective(waited.record, waited.sequence)` `:2286`. Re-observed by `server.steering.test.ts:249` (Run D). Unchanged at 4b84e50c. |
| `packages/mcp-server/src/service.ts` | Wiring of the durable store, idempotency store and inbox | ✓ VERIFIED (code) | `steeringErrors` `:1988`; `steeringDurable` `:1995-2000`; `steeringDurableIdempotency` `:2001-2006`; `SteeringInbox` `:2010-2019`. Steering wiring lines are not in any 4b84e50c hunk (hunks at `:2501`, `:3647`, `:3735`, `:4592`). |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | Settings and flags | ✓ VERIFIED | `config.ts:785-786` (type), `:1324-1325` (loader). `flag-registry.ts:344-345` (`SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S`, `_CAP`). Unchanged at 4b84e50c. |
| `.env.example`, `docs/config-reference.md` | Documented settings | ✓ VERIFIED | `.env.example:935`, `:937`; `docs/config-reference.md:60-61`. Unchanged at 4b84e50c. |
| `docs/runbooks/rollback-compat.md` | Step 43 named | ✓ VERIFIED | `:56` names step 43 `planning_steering_idempotency`, opt-in `steering-audit`. Unchanged at 4b84e50c. |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED (keys) / ⚠️ ordering sentence overstated | `:33` keys, sequence, settings and bounds. `:35` see T8. Unchanged at 4b84e50c. |
| `packages/mcp-server/src/index-store.migrate-contract.test.ts`, `.migrate-harness.test.ts` | Step 43 allowlisted; opt-in expectation 33, 34, 43 | ✓ VERIFIED (carried forward) | Allowlist reasons `:69-70`. Harness `:194` `[...ALL, 33, 34, 43]`; `:198` `ledger.has(43)`. Both files passed in Run A at 97defd59 (0 fail). Byte-identical at 4b84e50c; not re-run. |

### Key Link Verification

`verify.key-links` on `77-01-PLAN.md` reports no `must_haves.key_links` in the plan frontmatter. Manual wiring checks, read at 4b84e50c:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts:148` | `SteeringInbox.enqueueReceipt` | direct call | ✓ WIRED | Passes `idempotency_key`; reads `replayed` (`:150`). |
| `steering-tools.ts:154` | `inbox.sequenceOf` | keyed reply | ✓ WIRED | Throws when a queued directive has no sequence (`:155`). |
| `steering.ts:532` | `store.nextSequence` | before claim or audit | ✓ WIRED | Source of the accepted counter-gap residual for concurrent losers. |
| `steering.ts:546` | `store.claimReplay` (via `claimKeyed` `:582`) | audit in unit | ✓ WIRED | Commit-or-rollback via the unit (code). |
| `steering-store.ts:705` | `history.append` in `tx` | `queue(tx)` → `audit(entry, unit)` → `record` | ✓ WIRED | The audit uses the transaction (`:298`). `append` throws on refusal; `audit` retries and reports. |
| `service.ts:2001-2006` | `index.steeringIdempotency()` | durable opt-in only | ✓ WIRED | Built only when `steeringDurable` is set, i.e. the audit opt-in is on. Otherwise `MemorySteeringIdempotencyStore` (`steering.ts:329`). |
| `steering-waiters.ts:64-67` | `inbox.queuedFor` → `sequenceOf` | cursor | ✓ WIRED | Cursor is sequence, not time. |
| `server.ts:2286` | `restDirective(waited.record, waited.sequence)` | wait body | ✓ WIRED | `server.steering.test.ts:249`, re-observed at 4b84e50c. |
| `steering.ts:657`, `:665` | `store.advancePast` | `restoredSequence` | ✓ WIRED | Restored directives keep their stored number; the counter moves past it. |
| `steering-tools.ts:178` / `steering-rest.ts:148` | `inbox.recordsFor` → `compareDirectives` | pull listing order | ⚠️ WIRED, order is priority | Not sequence order (`steering.ts:998-999`). `steering_list` returns no sequence. See T8 and H5. |
| `steering.ts` session key (`targetSessionId`) | `event.ts` `normalizeKey` via `normalizeEvent` | ledger `session_id` | ✓ WIRED, identity for steering keys | `steering-delivery.ts:154` → `event.ts:401`. Steering keys are SESSION_ID_RE-bounded ASCII, so `normalizeKey` returns the key unchanged. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering.ts` `replayOf` | `held` (replay record) | `findReplay` or claim result | In memory: yes (re-observed at 4b84e50c). Postgres: code path only. | ✓ FLOWING (memory). Postgres not run by this verifier (T5). |
| `steering-rest.ts` listing | `sequence` | `inbox.sequenceOf` | Yes, from the counter the queue set | ✓ FLOWING |
| `steering-waiters.ts` | `sequence` | `inbox.sequenceOf` via `queuedFor` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Run D is this pass's one targeted command, at HEAD 4b84e50c. It replaces Run C (at 8a604455) as the phase 77 evidence for T1 to T4.

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| D (4b84e50c, this pass): named phase 77 tests across four files | `cd packages/mcp-server && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test src/event.test.ts src/planning/steering.test.ts src/planning/steering-tools.test.ts src/server.steering.test.ts --timeout 30000 -t "a keyed replay returns the original|the same key with different content|a key from another author|an unkeyed repeat|a keyed reply carries its sequence|an unkeyed queue keeps its reply shape|a replayed keyed queue announces nothing|distinct keyed commands take their sequence|the wait body carries|leaves an ordinary identifier"` | 11 pass, 0 fail, 33 expect() calls, 160 filtered out; "Ran 11 tests across 4 files [337.00ms]". Mapping by static enumeration [INFERENCE; the count of 11 equals the enumerated matches]: `event.test.ts:273`, `:302`; `steering.test.ts:406`, `:417`, `:427`, `:438`, `:447`; `steering-tools.test.ts:217`, `:227`, `:257`; `server.steering.test.ts:249`. The verbose per-name lines were not printed. | ✓ PASS (0 fail) |
| A (carried from 97defd59): phase 77 steering suites plus `service.test.ts` (file run) | `bun test` on eleven files | At 97defd59: 585 pass, 6 skip, 0 fail; 591 tests across 11 files. Not re-run at 4b84e50c. `service.test.ts` changed at 8a604455 (not run here). | Carried forward |
| B (carried from 97defd59): named phase 77 tests over five steering files | `bun test --verbose -t` | At 97defd59: 12 pass, 4 skip, 0 fail; "Ran 16 tests across 5 files". Not re-run at 4b84e50c. | Carried forward |

Run D's count is consistent with the enumeration above. It is one command, so no other test was run at 4b84e50c.

### Orchestrator Postgres per-file evidence (T5 to T7; labelled as the orchestrator's, not this verifier's)

`/root/src/worktrees/backups/pg-perfile-steering-idempotency.pg.test.log`, file mtime `2026-11-02 18:37:04 +0000`: `bun test v1.4.0`; 4 pass, 0 fail, 12 expect() calls; "Ran 4 tests across 1 file [1.69s]". This is the orchestrator's statement. It is **not** this verifier's observation. It names no test, so it does not show which of the four tests passed. It is cited for T5 to T7 and does not upgrade them.

Its date predates both head commits: 8a604455 is dated `2026-11-03 15:23:12 +0000`, 4b84e50c is dated `2026-11-03 15:52:19 +0000`. The log therefore covers the phase 77 code before the `index-store.ts` and `service.ts` edits in 8a604455. The steering Postgres path itself is not in those edit sets: the steering store, the migration 43 block and `steeringIdempotency()` are unchanged, and `steering-store.ts` calls no normalizer. That is code reasoning [INFERENCE], not a Postgres observation. The four PG tests in `steering-idempotency.pg.test.ts` are at lines 73, 93, 112 and 122, and the file's `afterAll` (`:50-58`) deletes only rows whose session starts with the run prefix.

### Probe Execution

No probe applies. Neither the PLAN nor the SUMMARY declares a probe path, and this is not a tooling phase. Migration 43 is covered by human item 2.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements:` field) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence; same-key/same-payload replay returns the identical original result without another effect; changed payload under the same key is refused; one documented out-of-order rule; schema/size caps; durable replay state; unkeyed commands get no false idempotency guarantee | ✗ ORPHANED (ownership open, H5) | Covered in code and tests: keyed replay and conflict (T1), sequence and wait (T3, T4), key grammar (`steering.ts:507`, 8 to 128 characters), body cap (4096 characters, `docs/live-steering.md:33`), unkeyed reply has no key (T2). Durable state is T5 to T7, present and wired, not run by this verifier. The "one documented out-of-order rule" is T8, uncertain. |

Other requirements mapped to Phase 77: none. Step 9b: no later phase of the roadmap names HARD-H1, steering idempotency or the steering sequence, so nothing is deferred.

Owner text (`REQUIREMENTS.md:124`) and status (`REQUIREMENTS.md:139`, "Not started") unchanged. No plan in `.planning` claims HARD-H1.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `steering.ts` | 532, 546 | Counter taken before the claim, so a concurrent loser consumes a sequence number | ⚠️ Warning (accepted residual) | SC1 "writes nothing" holds for sequential replays and for in-process concurrency (inbox lock). Cross-process concurrent losers leave a gap, never a duplicate. Accepted per the brief. |
| `steering.ts` | 769-780 with `steering-store.ts:298` | Bounded audit retry runs inside the same Postgres transaction after a failed statement | ⚠️ Warning (H3) | [INFERENCE] Later attempts fail with the aborted-transaction code, so `lastErrorCode` can differ from the driver error. The claim still rolls back, so no double-apply. |
| `steering-store.ts` | 688-716 | Claim and audit atomicity exists only in the SQL adapter, never executed here | ⚠️ Warning | T6 and T7, behaviour-unverified by this verifier. |
| `steering-tools.ts` / `steering-rest.ts` / `steering-delivery.ts` | 178-180 / 147-155 / 62-63 | Pull listing and notice are priority-ordered; `steering_list` has no `sequence` | ⚠️ Warning | T8. Against `docs/live-steering.md:35`. Owner decision H5. |
| `77-01-PLAN.md` | D11 (line 49), R1 (line 87) | D11 says the replay record is written after the audit and a save failure does not fail the queue; R1 says a crash between audit commit and replay save is a documented residual. Both describe superseded behaviour: the claim is one transaction (`steering.ts:546`, `steering-store.ts:689`), and a failed claim fails the queue. | ℹ️ Info (stale) | Open decision H6. |
| worktree `ROADMAP.md` phase 77 | `:1332` Status, `:1342` Plans | Status line is consistent with this record; the Plans line names only 77-01. | ℹ️ Info | Owner or orchestrator to reconcile (H6). Not edited. |
| `REQUIREMENTS.md` | 124, 139 | HARD-H1 unchecked; "Not started" | ℹ️ Info | Open decision H5. |
| `77-01-SUMMARY.md` | G4 (line 91) | Cites `server.steering.test.ts:243-251`; the test is at `:249` | ℹ️ Info | Citation drift only. |
| `77-01-SUMMARY.md` | line 1 | Header says "revision 2: durable"; the body has a "Revision 3" section (line 86) | ℹ️ Info | Header not updated. No effect on code. |

Debt-marker grep this pass (`TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|not yet implemented` across `service.ts`, `index-store.ts`, `event.ts`, the steering modules, `server.ts`, `config.ts`, `flag-registry.ts` and `docs/live-steering.md`, at HEAD 4b84e50c): no matches. The Step 7 debt gate is not triggered.

### Human Verification Required

1. **Live Postgres proof for T5 to T7.** Set `SUBSTRATE_TEST_PG_URL` against a migrated Postgres and run `steering-idempotency.pg.test.ts` (4 tests) at HEAD 4b84e50c. Expected: all pass. Until it is observed, T5 to T7 stay ⚠️ PRESENT_BEHAVIOR_UNVERIFIED, and the orchestrator's log remains labelled orchestrator evidence that predates 4b84e50c.
2. **Rehearse migration 43.** Apply it on a restored dump under the `steering-audit` opt-in, then reverse it. Expected: both directions run cleanly. Reversal drops `delivery_sequence` and the two tables, and stored values are lost; audit rows remain.
3. **Observe a forced audit failure inside a keyed claim on Postgres.** Expected: `audit-unavailable`, claim rolled back, nothing queued. Decide whether the in-transaction retry (H3) is acceptable.
4. **Decide HARD-H1 ownership and the ordering rule (H5), with the pull-surface finding in view.** Add `requirements: [HARD-H1]` to PLAN 77-01 or re-map it with owner approval. Decide whether `docs/live-steering.md:35` is the single ordering rule. If it is, either `steering_list`, `GET /steering/directives` and the docs_search notice move to sequence order, or the sentence is narrowed to the wait cursor. State what a skipped number means to a reader.
5. **Reconcile stale text before merge (H6).** Update PLAN 77-01 D11 (line 49) and R1 (line 87). Update the ROADMAP phase 77 Status and Plans lines, `REQUIREMENTS.md:124` and `:139`, and the SUMMARY header.

### Open Decisions (kept open)

- **H3 (retry inside the failed transaction).** Whether to accept the aborted-transaction `lastErrorCode` or fail fast inside the transaction (`steering.ts:769-780`). Open. Not verified.
- **H5 (HARD-H1 ownership and the ordering rule).** Open. No plan claims HARD-H1. `docs/live-steering.md:35` is unqualified; the pull reads (`steering_list` at `steering-tools.ts:178`, `GET /steering/directives` at `steering-rest.ts:147-155`, the docs_search notice at `steering-delivery.ts:62-63`) are priority-ordered (`steering.ts:998-999`), and `steering_list` carries no sequence.
- **H6 (stale text).** Open. PLAN 77-01 D11 and R1, the ROADMAP Status and Plans lines, REQUIREMENTS `:124` and `:139`, and the SUMMARY header contradict the code and the SUMMARY's revision 3.
- **Migration 43.** Open operator item. Not executed. Rehearsal required before production.

### Accepted Residual (per the brief; reported, not an open decision)

- **Counter gap for a concurrent keyed loser.** A concurrent keyed loser may consume one sequence number before its claim (`steering.ts:532`, claim at `:546`). It never produces a duplicate. The loser's claim inserts nothing and returns the winner's reply (`steering-store.ts:696-704`). Sequential replays write nothing.

### Gaps Summary

No must-have is FAILED. No blocker was found: no stub patterns, no missing or unwired artifact, no debt markers, and no steering citation the code contradicts beyond T8's documentation scope. Status is `human_needed` rather than `passed` for four reasons:

1. T5, T6 and T7 are present and wired, but this verifier did not exercise them against Postgres. The orchestrator's per-file log is cited and labelled as the orchestrator's evidence. It names no test, and it predates 4b84e50c.
2. T8 is UNCERTAIN. The documented per-session order holds for the wait cursor and fails for the pull reads. Whether those reads are "delivery" is owner decision H5.
3. Decisions H3, H5 and H6 remain open, and HARD-H1 ownership remains unassigned.
4. Migration 43 remains an operator item.

Step 9b (deferred items): none.

### Deviations and Evidence Notes

- **HEAD.** `4b84e50c` (fix(72,73): access and visibility compare exact repo spellings). The prior record was at `8a604455`.
- **Re-observed at 4b84e50c.** Eleven named tests (Run D), which cover T1 to T4 and the session-key claim's ordinary-identifier tests. T1 to T4 keep their status. No status changed as a result of the re-observation, because T5 to T8 and HARD-H1 depend on evidence the command did not reach.
- **Covered set.** Unchanged from 8a604455: 31 files. `service.ts` and `index-store.ts` changed content, so the digest changed from `ff56c17e…` to `03048971…`. Nothing was added or removed.
- **Fingerprint.** `node /root/.claude/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/77-steering-idempotency-and-ordering` with the 31 covered files passed as arguments, run from the worktree root. Digest `v3:sha256:03048971de56700a7c67770c7f3e07045093fe3e1749d21b519032e671e92fde`. The command's output is copied into the frontmatter.
- **Path resolution.** One early grep used a relative path and resolved against the main checkout `/root/src/repos/agent-substrate`, which is at a different HEAD. It was read-only and its results were discarded. Every citation in this record was re-read in the worktree with absolute paths.
- **Not re-run at 4b84e50c.** `steering.test.ts` (other than the named tests), `steering-durable.test.ts`, `steering-tools.test.ts` (other than the named tests), `steering-rest.test.ts`, `steering-waiters.test.ts`, `mcp.steering.test.ts`, the migration contract and harness tests, `service.test.ts` and `memory-policy.test.ts`. The T5 to T7 evidence is the orchestrator's log only.
- **Citation drift.** `steering-delivery.ts` `steeringNoticeFor` is at `:62`. `steering_list` is at `steering-tools.ts:174-184`. The steering citations in `service.ts` (`:1984-2040`), `server.ts:2286`, `steering.ts` and the steering store are unchanged at 4b84e50c.
- **Full suite, tsc, lint, formatters.** Not run (assignment rule).
- **No code edits, no commits, no PG.** `env -u SUBSTRATE_TEST_PG_URL` on the one test command. Nothing written under `/root/src/repos/agent-substrate`.

---

_Verified: 2026-11-03T16:03:09Z_
_Verifier: Claude (gsd-verifier)_
