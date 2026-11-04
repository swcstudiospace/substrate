---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-04T23:00:41Z
status: human_needed
score: 7/8 must-haves verified
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
covered_digest: "v3:sha256:641ff4b1505e68df6fb61a48110aa074e51fde9c335a1558cc4afa35e8bb5097"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/8
  previous_verification: "77-VERIFICATION.md at 504da465 (verified 2026-11-04T22:33:39Z, digest v3:sha256:641ff4b1505e68df6fb61a48110aa074e51fde9c335a1558cc4afa35e8bb5097); earlier records at 4b84e50c, 8a604455, 97defd59, 9ab6f111, c7788f9d and 749e97e3"
  gaps_closed:
    - "T5: durable replay and sequence survive a restart through Postgres. steering-idempotency.pg.test.ts:73 passes on scratch PostgreSQL 16.15 (observed here)."
    - "T6 (W1): audit row and replay claim commit together; a failed unit leaves no claim; a lost reply replays. steering-idempotency.pg.test.ts:93 and :112 pass on scratch PostgreSQL 16.15 (observed here)."
    - "T7 (W2): one winner per scope key across two instances. steering-idempotency.pg.test.ts:122 passes on scratch PostgreSQL 16.15 (observed here)."
  gaps_remaining:
    - "T8: the documented per-session order (docs/live-steering.md:35) holds for the wait cursor only. steering_list, GET /steering/directives and the docs_search notice order by priority. Open decision H5."
    - "HARD-H1 ownership: no plan claims it (REQUIREMENTS.md:124 unchecked, :139 status text). Open decision H5."
  regressions: []
behavior_unverified_items: []
human_verification:
  - test: "Force an audit refusal inside a keyed Postgres claim through SteeringInbox (the AuditRefused path, not a thrown error injected into claimReplay) and read the reported error code"
    expected: "The queue is refused as audit-unavailable, the claim rolls back, nothing is queued. lastErrorCode may show the aborted-transaction code rather than the driver error (steering.ts:769-780). Owner decision H3 stays open."
    why_human: "steering-idempotency.pg.test.ts:93 proves the rollback with a thrown error inside the claim unit, not the inbox's audit-refusal error path. Which error code the operator sees is an owner decision (H3)."
  - test: "Apply migration 43 up and down on a restored rehearsal copy of the database, and walk the steering-audit opt-in steps (33, 34, 43) in docs/runbooks/rollback-compat.md"
    expected: "Up and down both apply cleanly; the opt-in steps in the runbook match the migration numbers."
    why_human: "Operator migration on a restored database. The PG file's beforeAll calls migrate(); whether migration 43 was applied by that run or was already present was not checked, and the down path was not executed."
  - test: "Decide the ordering rule (H5): either the pull reads (steering_list, GET /steering/directives, docs_search notice) gain sequence order, or docs/live-steering.md:35 is narrowed to the wait cursor. Also decide HARD-H1 ownership: add it to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader."
    expected: "One documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping."
    why_human: "REQUIREMENTS.md:124 is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Reconcile the stale status text: ROADMAP.md '### Phase 77' Status (:1332) and Plans (:1342), and REQUIREMENTS.md:139"
    expected: "The status text matches this record: 7 of 8 truths verified, T8 open under H5, status human_needed."
    why_human: "Planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-04T23:00:41Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 504da465 (human_needed, 4/8) carries no `gaps:` block. This run closes T5 to T7 by observing their named Postgres test at HEAD 9e71f263. T8 and HARD-H1 are unchanged.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `9e71f263` (docs(65): the corpus sync runbook and the reconcile drop-in example). No code was edited, nothing was committed, and the full suite, tsc, lint and formatters were not run. Postgres was used only for the one named file below, on scratch PostgreSQL 16.15 (127.0.0.1:5439, database `substrate_test_v77`). Production and port 5432 were not touched. Only `.planning/phases/77-steering-idempotency-and-ordering/77-VERIFICATION.md` was written, in the worktree.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01. The ROADMAP Status line (:1332) still reads `human_needed: 4 of 8` and is stale against this record (H6).

**Change since the prior record (504da465 to 9e71f263):**
- `git diff --name-only 504da465 9e71f263` touches none of the 31 covered files. The changed mcp-server files are `corpus/proofs.test.ts`, `fabric/status.ts`, `fabric/status.test.ts`, `fabric/types.ts` and `service.test.ts`, and none is in the covered set. `docs/runbooks/corpus-sync.md` changed, and it is not in the covered set.
- The covered-set digest is unchanged, `v3:sha256:641ff4b1…5097`, recomputed at HEAD by `verification.fingerprint`. The covered content is therefore byte-identical to the prior record, and the line citations below hold at HEAD.
- What changed in this run is evidence: T5 to T7 are now observed by running `steering-idempotency.pg.test.ts` on scratch Postgres, and they move from PRESENT_BEHAVIOR_UNVERIFIED to VERIFIED.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (observed at 9e71f263) | Replay lookup runs after directive schema, key pattern, author and allowlist checks, and before duplicate, rate and audit checks: `steering.ts:503-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !replayed`), wake-up only when `freshlyQueued` (`:158-159`). Observed: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left" passes (Run A, junit). |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED (observed at 9e71f263) | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152-153` (`if (input.idempotency_key === undefined) return queued`). Observed: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence" and `steering.test.ts:438` "an unkeyed repeat is a second directive, as before" pass (Run A). Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED (observed at 9e71f263) | Keyed reply carries `sequence`: `steering-tools.ts:154-158` (throws when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Observed: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" and `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order" pass (Run A, junit). |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`queuedFor` sorted by sequence, `steering.ts:456-462`; cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:107`, inside `:97-117`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2286`. Observed: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns" passes (Run A). Restart: the six tests of "keyed replay and delivery sequence across a restart" (`steering-durable.test.ts:873` suite; `:883`, `:899`, `:912`, `:922`, `:948`, `:960`) pass on the memory store (Run A, junit, 6 of 6). The Postgres form of the restart is T5. |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (observed at 9e71f263 on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:73` "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" passes. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937` (`version: 43` at `:913`, `scope_key text primary key` at `:924`, nullable `delivery_sequence` at `:935`); Bun adapter `bunSteeringIdempotencyStore` `steering-store.ts:664-717`; factory `steeringIdempotency()` `index-store.ts:1034`; wired under the audit opt-in `service.ts:1995-2006`. The file's beforeAll runs `migrate()` on `substrate_test_v77`. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (observed at 9e71f263 on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:93` "a claim whose unit fails keeps no replay record on either instance" passes: a unit that throws rolls the claim back on both instances. `:112` "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" passes: the audit row and the replay claim are queued once, and the retry on the second instance returns `replayed: true` with the original directive id. Code: keyed path takes the claim with the audit inside it, `steering.ts:546` (`claimKeyed`, `:582-593`); an audit refusal throws `AuditRefused` (`steering.ts:586`); SQL claim transaction `steering-store.ts:688-716`. Memory twins `steering-durable.test.ts:948` and `:960` pass (Run A). The refused-audit error code is H3 (human item 2), not part of this truth. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (observed at 9e71f263 on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:122` "two concurrent keyed commands through two instances queue one directive and both get its reply" passes: `Promise.all` over two `IndexStore` instances, each with its own pool, yields one queued audit row and one directive id; exactly one caller sees `replayed: false`. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:692-695`); a loser reads the winner's row in the same transaction and returns its reply (`steering-store.ts:696-704`; `steering.ts:548`). Scope of the proof: two IndexStore instances with separate connection pools in one OS process, not two OS processes. The database serialises the two connections, so the cross-connection race is exercised; the process boundary is not. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` reads `recordsFor` (`steering.ts:475-481`), which sorts by `compareDirectives` (`steering.ts:998-999`: priority rank, then `createdAtMs`, then id), and its listed shape has no `sequence` field. `GET /steering/directives` (`steering-rest.ts:147-155`) uses the same comparator and does carry `sequence`. The docs_search notice orders by priority too. No test at HEAD asserts sequence order on a pull read. Not run in this record. |

**Score:** 7/8 truths verified (T1 to T7). T8 is UNCERTAIN and is excluded from the score. No truth is FAILED.

### Phase 77 fix commit check (G1 to G5)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:664-687`, `:688-716`, `:720-730` | `steering-idempotency.pg.test.ts:73` | PASS on scratch PostgreSQL 16.15 (T5). |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`; `steering-store.ts:689`, `:705`, `:298` | PG `steering-idempotency.pg.test.ts:93`, `:112` (PASS); memory `steering-durable.test.ts:948`, `:960` (PASS) | VERIFIED (T6). Error-code surface is H3. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:692-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG `steering-idempotency.pg.test.ts:122` (PASS) | VERIFIED (T7), two pools in one process. |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (PASS) | VERIFIED. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

Level 1 and 2 (exists, substantive): all 29 implementation, docs and test files in the covered set exist at HEAD and are non-stub. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` (exit 66, NO_INPUT) is not applicable and nothing is marked VERIFIED on that basis; artifact status is from the citations above.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive, wired through `service.ts:1984-2040`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive; executed against scratch PostgreSQL 16.15 by `steering-idempotency.pg.test.ts` (4 pass). |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; migration digest contract passes (Run B). Up path reached by the PG file's `migrate()`; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:150-158`. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `:97-117`, `:107`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `:2272-2286`. |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Run on scratch PostgreSQL 16.15: 4 pass, 0 fail. |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable (Step 5). Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path executed by `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:1995-2019`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `server.ts` `/steering/wait` | `steering-waiters.ts` `nextQueuedDirective` | `restDirective(waited.record, waited.sequence)` | WIRED | `server.ts:2286`; observed by `server.steering.test.ts:249`. |
| `steering_list` / `GET /steering/directives` | per-session sequence order | `compareDirectives` | NOT WIRED to sequence | Priority order, not sequence (T8). Open decision H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering-tools.ts` keyed reply | `sequence` | `inbox.sequenceOf` ← `sequences` map ← `replayOf` / `doEnqueue` | Yes (memory store in tests; PG store on scratch PostgreSQL 16.15) | ✓ FLOWING |
| `steering-waiters.ts` cursor | `queued[]` | `queuedFor` sorted by sequence | Yes | ✓ FLOWING |
| `steering_list` | priority-ordered records | `recordsFor` | Yes, but order is priority | ⚠️ FLOWING, order disputed (T8) |

### Behavioral Spot-Checks

Run from `packages/mcp-server`. Non-PG commands used `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. The PG command set `SUBSTRATE_TEST_PG_URL=postgres://postgres:<scratch password>@127.0.0.1:5439/substrate_test_v77` and the same TMPDIR. JUnit outputs were written outside the repo, under `/root/src/worktrees/backups/gate-tmpfs/`.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| T5, T6 (`:93`, `:112`), T7 (scratch PostgreSQL 16.15, one file) | `bun test --verbose --timeout 30000 src/planning/steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` set to database `substrate_test_v77` | 4 pass, 0 fail, 12 expect() calls; "Ran 4 tests across 1 file" | ✓ PASS (4 of 4) |
| T1 to T4, T6-memory, restart suite (seven steering suites, no PG) | `bun test --timeout 30000 --reporter=junit` on `steering.test.ts`, `steering-durable.test.ts`, `steering-tools.test.ts`, `steering-rest.test.ts`, `steering-waiters.test.ts`, `mcp.steering.test.ts`, `server.steering.test.ts` (Run A) | 201 pass, 0 skip, 0 fail, 1629 expect() calls; "Ran 201 tests across 7 files" | ✓ PASS |
| Migration contract and harness, event (three files, no PG) | `bun test --timeout 30000 --reporter=junit` on `index-store.migrate-contract.test.ts`, `index-store.migrate-harness.test.ts`, `event.test.ts` (Run B) | 152 pass, 0 skip, 0 fail, 830 expect() calls; "Ran 152 tests across 3 files" | ✓ PASS |

Run A printed one stderr line from `service.ts:1990` ("steering settings invalid; steering tools answer misconfigured: SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN"). It is a log line, not a failure, and it did not change any count. The earlier record's two unattributed skips per run do not reappear: both non-PG runs report 0 skipped.

Step 7c probe execution: no probe is declared in the PLAN or SUMMARY, and this is not a tooling phase. Not applicable.

### Probe Execution

No probe applies. Neither the PLAN nor the SUMMARY declares a probe path, and this is not a tooling phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no requirements field) | Steering idempotency and ordering (REQUIREMENTS.md:124) | ORPHANED (no plan claims it); ? NEEDS HUMAN | REQUIREMENTS.md:124 unchecked; :139 still reads the 4b84e50c status text. Phase 77 is the mapped phase. Ownership is open decision H5. Reported here as required by Step 6c. |

### Anti-Patterns Found

No `TBD`, `FIXME`, `XXX`, `HACK`, `TODO` or `PLACEHOLDER` marker appears in the steering implementation files or the other covered implementation files. No stub returns were found in the steering modules.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/live-steering.md` | 35 | Ordering sentence broader than the pull reads | ⚠️ Warning | T8. Documentation overstates what `steering_list`, `GET /steering/directives` and the docs_search notice deliver. |
| `packages/mcp-server/src/planning/steering-store.ts` | 666-672 | Every queue takes a counter upsert when the audit opt-in is on | ℹ️ Info | SUMMARY R6. A counter failure fails an unkeyed queue as `audit-unavailable`. |

### Human Verification Required

1. **Audit failure inside a keyed claim on Postgres, through the inbox** — force an audit refusal (`AuditRefused`) and read the reported error code.
   - Expected: the queue is refused as `audit-unavailable`, the claim rolls back, nothing is queued. `lastErrorCode` may show the aborted-transaction code rather than the driver error (`steering.ts:769-780`). Owner decision H3 stays open.
   - Why human: `steering-idempotency.pg.test.ts:93` injects a thrown error into the claim unit. The inbox's refusal path and the error code an operator sees are not exercised on Postgres.
2. **Migration 43 on a restored database** — apply up and down on a rehearsal copy and walk the steering-audit opt-in steps (33, 34, 43) in `docs/runbooks/rollback-compat.md`.
   - Expected: up and down both apply cleanly; the runbook steps match the migration numbers.
   - Why human: operator migration on a restored database. The PG file's `beforeAll` calls `migrate()`; whether migration 43 was applied by that run or already present was not checked, and the down path was not executed.
3. **Decide the ordering rule and HARD-H1 ownership (H5)** — either the pull reads (`steering_list`, `GET /steering/directives`, docs_search notice) gain sequence order, or `docs/live-steering.md:35` is narrowed to the wait cursor. Add HARD-H1 to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader.
   - Why human: `REQUIREMENTS.md:124` is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make.
4. **Reconcile stale status text (H6)** — ROADMAP `### Phase 77` Status (:1332) and Plans (:1342), and REQUIREMENTS.md:139, still carry the 4b84e50c status. Owner or orchestrator to update after the decisions above. The verifier does not edit planning docs.

### Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is NOT_WIRED on the wait path. The status is `human_needed`, not `gaps_found`: T8 is UNCERTAIN, and HARD-H1 has no owning plan. Neither is a blocker under Step 9 rule 1. Score 7/8.

### Open Decisions (kept open)

- ATLAS-03 is not this phase. Not touched.
- H3: the audit-failure error code inside a keyed Postgres claim.
- H5: whether the documented ordering rule covers pull reads, and HARD-H1 ownership.
- H6: planning-doc reconciliation (above).
- Migration 43: operator run, including the down path and a restored-database rehearsal.

### Accepted Residual (reported, not an open decision)

- A losing or refused keyed caller still consumes a sequence number (a gap, never a duplicate). SUMMARY G2 residual.
- At capacity the oldest replay key is forgotten before retention (SUMMARY R4).

### Deviations and Evidence Notes

- **Fingerprint.** `node ~/.claude/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/77-steering-idempotency-and-ordering` with the 29 implementation, docs and test files passed as arguments, run from the worktree root. The command added the PLAN and SUMMARY automatically. Output copied verbatim into `covered_files` and `covered_digest`: `v3:sha256:641ff4b1505e68df6fb61a48110aa074e51fde9c335a1558cc4afa35e8bb5097`.
- **Postgres scope.** One file, one command, against scratch PostgreSQL 16.15 at `127.0.0.1:5439`, database `substrate_test_v77`. Server version was confirmed with `select version()`. Production and port 5432 were not used.
- **Named-test confirmation.** Non-PG runs use JUnit output, so per-test names and statuses come from the XML. The PG run's bun output reports file-level counts only; its four names are the `test()` titles in the file, and the count matches the file's four tests.
- **Citations.** Line citations carry from the 504da465 record. The covered-set digest is identical at 9e71f263, so the covered files are byte-identical and the citations hold.
- **Full suite, tsc, lint, formatters.** Not run (assignment rule).
- **No code edits, no commits.** Nothing written under `/root/src/repos`.

---

_Verified: 2026-11-04T23:00:41Z_
_Verifier: Claude (gsd-verifier)_
