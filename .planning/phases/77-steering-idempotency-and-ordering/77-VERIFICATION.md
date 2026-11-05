---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-05T00:13:45Z
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
covered_digest: "v3:sha256:30aaf2b0f9d5ce9759a2bbc96e9a646dd6a943dfc6ef770577ce251fc6a14b68"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_verification: "77-VERIFICATION.md at 9e71f263 (verified 2026-11-04T23:00:41Z, digest v3:sha256:641ff4b1505e68df6fb61a48110aa074e51fde9c335a1558cc4afa35e8bb5097); earlier records at 504da465, 4b84e50c, 8a604455, 97defd59, 9ab6f111, c7788f9d and 749e97e3"
  gaps_closed: []
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
    why_human: "Operator migration on a restored database. The PG file's beforeAll calls migrate(); whether migration 43 was applied by that run or was already present was not checked, and the down path was not executed. The migration-43 rehearsal stays open."
  - test: "Decide the ordering rule (H5): either the pull reads (steering_list, GET /steering/directives, docs_search notice) gain sequence order, or docs/live-steering.md:35 is narrowed to the wait cursor. Also decide HARD-H1 ownership: add it to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader."
    expected: "One documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping."
    why_human: "REQUIREMENTS.md:124 is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Reconcile the stale status text: ROADMAP.md '### Phase 77' Status (:1332) and Plans (:1342), and REQUIREMENTS.md:139"
    expected: "The status text matches this record: 7 of 8 truths verified, T8 open under H5, status human_needed."
    why_human: "Planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. ROADMAP :1332 still reads 'human_needed: 4 of 8' at HEAD c40ffc9a."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-05T00:13:45Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 9e71f263 (human_needed, 7/8) carries no `gaps:` block. This run re-audits the covered set at HEAD c40ffc9a, runs the Postgres file again on scratch PostgreSQL 16.15, and re-runs the phase's non-PG test files. T8 and HARD-H1 remain open.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `c40ffc9a`. No code was edited, nothing was committed, and the full suite, tsc, lint and formatters were not run. Postgres was used only for the two PG-gated files in the covered set, on scratch PostgreSQL 16.15 (127.0.0.1:5439, database `substrate_test_v77`). Production and port 5432 were not touched. Only `.planning/phases/77-steering-idempotency-and-ordering/77-VERIFICATION.md` was written, in the worktree.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01. The ROADMAP Status line (:1332) still reads `human_needed: 4 of 8` and is stale against this record (H6).

**Change since the prior record (9e71f263 to c40ffc9a):**
- The covered set (29 entries, PLAN and SUMMARY included) is the same list as before. The covered-set digest changed from `v3:sha256:641ff4b1…5097` to `v3:sha256:30aaf2b0…4b68`, recomputed at HEAD by `verification.fingerprint`. The digest moved because five covered files changed in wave 6, all outside phase 77's steering logic:
  - `config.ts` (a4a9a8f0): one doc comment and the sync-lag objective name. The steering settings are unchanged.
  - `flag-registry.ts` (a4a9a8f0, db4f98f6, 3c5dcfa0): a new `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` row, a comment, and the dispatcher roots text. The `SUBSTRATE_PLANNING_STEERING_IDEMPOTENCY_TTL_S` and `..._CAP` rows are unchanged.
  - `service.ts` (75d2ce56 at :6392 and :6418, a4a9a8f0 at :2958): a steering-session docs_search row change, and a `recordSyncLag` call. Both lie outside the steering wiring block at `service.ts:1988-2017`, which is unchanged in content.
  - `index-store.ts` (ebabe6ef): archive-only changes at :3043 and later (`PG_TYPE`, `advanceIdentity`, `jsonb` export). Migration 43 (`:912-937`, `version: 43` at `:913`, `down` at `:917`) and `steeringIdempotency()` (`:1034`) are unchanged.
  - `index-store.migrate-contract.test.ts` (ebabe6ef): one line removed, the `corpus_documents` allowlist entry. The two phase 77 allowlist entries (`planning_steering_sequence`, `planning_steering_replay`, `:68-69`) are intact.
- `index-store.migrations.digests.json` is unchanged. Digests 1 to 43 are as recorded.
- No file under `packages/mcp-server/src/planning/` or `docs/live-steering.md` changed since 9e71f263. The steering line citations below hold at HEAD, except where a line is re-cited.
- Planning docs: `ROADMAP.md` and `REQUIREMENTS.md` changed in wave 6 only for phases 63 and 68 (1e17db11, bdc1dc1a). The phase 77 Status text at ROADMAP `:1332` and the HARD-H1 row at REQUIREMENTS `:139` are unchanged.
- Observed in this run: T5 to T7 and the Postgres file's four tests pass on scratch PostgreSQL 16.15 at HEAD c40ffc9a (see the PG counts below). Nothing moved from the prior record's status.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (observed at c40ffc9a) | Replay lookup runs after directive schema, key pattern, author and allowlist checks, and before duplicate, rate and audit checks: `steering.ts:503-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !replayed`), wake-up only when `freshlyQueued` (`:159`). Observed in the non-PG run: `steering.test.ts` "a keyed replay returns the original record and writes nothing, even with no rate token left" passes (Run C, 269 pass). |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED (observed at c40ffc9a) | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152` (`if (input.idempotency_key === undefined) return queued`). Observed: `steering-tools.test.ts` "an unkeyed queue keeps its reply shape, with no sequence" and `steering.test.ts` "an unkeyed repeat is a second directive, as before" pass (Run C). Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED (observed at c40ffc9a) | Keyed reply carries `sequence`: `steering-tools.ts:154-158` (throws when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Observed: `steering-tools.test.ts` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" and `steering.test.ts` "distinct keyed commands take their sequence per target session, and queue order is sequence order" pass (Run C). |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`queuedFor` sorted by sequence, `steering.ts:456-462`; cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:107`, inside `:97-117`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2286`. Observed: `server.steering.test.ts` "the wait body carries the delivery sequence of the directive it returns" and the restart suite `steering-durable.test.ts` ("after a restart the next distinct command takes the next sequence, and a restored directive keeps its own") pass (Run C). |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (observed at c40ffc9a on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:73` "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" passes. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937`; Bun adapter `bunSteeringIdempotencyStore` `steering-store.ts:664-717`; factory `steeringIdempotency()` `index-store.ts:1034`. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (observed at c40ffc9a on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:93` "a claim whose unit fails keeps no replay record on either instance" passes: a unit that throws rolls the claim back on both instances. `:112` "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" passes: the audit row and the replay claim are queued once, and the retry on the second instance returns `replayed: true` with the original directive id. Code: keyed path takes the claim with the audit inside it, `steering.ts:546` (`claimKeyed`, `:582-593`); the claim unit is `claimReplay` at `steering-store.ts:688`, with its transaction at `:705`. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (observed at c40ffc9a on scratch PostgreSQL 16.15) | `steering-idempotency.pg.test.ts:122` "two concurrent keyed commands through two instances queue one directive and both get its reply" passes: `Promise.all` over two `IndexStore` instances, each with its own pool, yields one queued audit row and one directive id; exactly one caller sees `replayed: false`. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:692-695`); a loser reads the winner's row in the same transaction and queues nothing. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged. `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` reads `recordsFor` (`steering.ts:471-480`), which sorts by `compareDirectives` (`steering.ts:998`: priority rank, then `createdAtMs`, then id), and its listed shape has no `sequence` field. `GET /steering/directives` (`steering-rest.ts:147-155`) uses the same comparator and does carry `sequence`. The docs_search notice is also priority-ordered. The sentence is therefore overstated for the pull reads. It is kept as UNCERTAIN, not FAILED: the owner has to choose the ordering rule (H5). |

**Score:** 7/8 truths verified (T1 to T7). T8 is UNCERTAIN and is excluded from the score. No truth is FAILED.

### Phase 77 fix commit check (G1 to G5)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:664-687`, `:688-716`, `:720-730` | `steering-idempotency.pg.test.ts:73` | PASS on scratch PostgreSQL 16.15 (T5). |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`; `steering-store.ts:689`, `:705`, `:298` | PG `steering-idempotency.pg.test.ts:93`, `:112` (PASS); memory `steering-durable.test.ts` (PASS, Run C) | VERIFIED (T6). Error-code surface is H3. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:692-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG `steering-idempotency.pg.test.ts:122` (PASS) | VERIFIED (T7), two pools in one process. |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts` (PASS, Run C) | VERIFIED. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

Level 1 and 2 (exists, substantive): all 29 implementation, docs and test files in the covered set exist at HEAD and are non-stub. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` (exit 66, NO_INPUT) is not applicable and nothing is marked VERIFIED on that basis; artifact status is from the citations above.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive, unchanged since 9e71f263; wired through `service.ts:1988-2017`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive, unchanged since 9e71f263; executed against scratch PostgreSQL 16.15 by `steering-idempotency.pg.test.ts` (4 pass). |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; migration digest contract passes (Run C, `index-store.migrate-contract.test.ts`). Up path reached by the PG file's `migrate()`; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:143`, `:150-159`. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `:97-117`, `:107`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `:2272-2286`. |
| `packages/mcp-server/src/service.ts` | steering idempotency wiring and settings | ✓ VERIFIED | Steering wiring `:1988-2017` (`steeringErrors` `:1988`, `steeringIdempotency()` `:2005`, settings `:2017`). Wave 6 edits at `:2958` and `:6392-6418` are outside it. |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Run on scratch PostgreSQL 16.15: 4 pass, 0 fail. |
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | PG-gated, covered by the phase digest | ✓ VERIFIED (run) | Run on scratch PostgreSQL 16.15: 16 pass, 0 fail. |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable (Step 5). Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path executed by `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:2005` and `:2017`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `server.ts` `/steering/wait` | `steering-waiters.ts` `nextQueuedDirective` | `restDirective(waited.record, waited.sequence)` | WIRED | `server.ts:2286`; observed by `server.steering.test.ts`. |
| `steering_list` / `GET /steering/directives` | per-session sequence order | `compareDirectives` | NOT WIRED to sequence | Priority order, not sequence (T8). Open decision H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering-tools.ts` keyed reply | `sequence` | `inbox.sequenceOf` ← `sequences` map ← `replayOf` / `doEnqueue` | Yes (memory store in tests; PG store on scratch PostgreSQL 16.15) | ✓ FLOWING |
| `steering-waiters.ts` cursor | `queued[]` | `queuedFor` sorted by sequence | Yes | ✓ FLOWING |
| `steering_list` | priority-ordered records | `recordsFor` | Yes, but order is priority | ⚠️ FLOWING, order disputed (T8) |

### Behavioral Spot-Checks

Run from `packages/mcp-server`. Non-PG runs used `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. The PG runs set `SUBSTRATE_TEST_PG_URL=postgres://postgres:<scratch password>@127.0.0.1:5439/substrate_test_v77` and the same TMPDIR. Each PG file was run separately.

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A (PG, per file) | `bun test src/planning/steering-idempotency.pg.test.ts` | 4 pass, 0 fail, 12 expect() calls, 303 ms, on scratch PostgreSQL 16.15, `substrate_test_v77` | ✓ PASS |
| B (PG, per file) | `bun test src/live-session-restart.pg.test.ts` | 16 pass, 0 fail, 148 expect() calls, 2.99 s, on scratch PostgreSQL 16.15, `substrate_test_v77`. One stderr line from the live-session expiry path (`live session expiry pass failed ... ERR_POSTGRES_SERVER_ERROR`) is printed during a passing run; the same message format is asserted by `live-session-authority.test.ts:90`, so it is an expected-failure path, not a test failure. | ✓ PASS |
| C (non-PG, targeted, one command) | `bun test` on `index-store.migrate-contract.test.ts`, `index-store.migrate-harness.test.ts`, `planning/steering.test.ts`, `planning/steering-durable.test.ts`, `planning/steering-tools.test.ts`, `planning/steering-rest.test.ts`, `planning/steering-waiters.test.ts`, `server.steering.test.ts`, `mcp.steering.test.ts` | 269 pass, 0 fail, 2245 expect() calls, 3.98 s across 9 files | ✓ PASS |

Run C covers the non-PG covered test files for this phase. The migrate-harness file has no PG gate; its PG counterpart is `index-store.migrate.test.ts`, which is not in the covered set and was not run.

### Probe Execution

No probes are declared or implied for this phase (no `scripts/*/tests/probe-*.sh` in the PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-H1 | none (no plan claims it) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence | ✗ ORPHANED (open, H5) | REQUIREMENTS.md:124 unchecked; `:139` status "Human-needed (2026-11-03): 4 of 8 truths verified at 4b84e50c". The text predates this record and is stale (H6). The ownership question is open under H5. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/live-steering.md` | 35 | Ordering sentence is broader than the pull reads deliver | ⚠️ Warning | T8, under H5. |
| `packages/mcp-server/src/planning/steering-store.ts` | 689-717 | Claim unit depends on a transaction; the memory store has none | ℹ️ Info | Stated in PLAN R1 and SUMMARY R1. Memory store is used only in tests and as the default when the audit opt-in is off. |

No `TBD`, `FIXME` or `XXX` markers were found in the phase's implementation files. No debt-marker blocker.

### Human Verification Required

1. **Audit refusal error code (H3)**
   - Test: force an audit refusal inside a keyed Postgres claim through `SteeringInbox` (the `AuditRefused` path, not a thrown error injected into `claimReplay`) and read the reported error code.
   - Expected: the queue is refused as `audit-unavailable`, the claim rolls back, nothing is queued. `lastErrorCode` may show the aborted-transaction code rather than the driver error (`steering.ts:769-780`).
   - Why human: `steering-idempotency.pg.test.ts:93` proves the rollback with a thrown error inside the claim unit. Which code the operator sees is an owner decision (H3).

2. **Migration 43 rehearsal**
   - Test: apply migration 43 up and down on a restored rehearsal copy of the database, and walk the steering-audit opt-in steps (33, 34, 43) in `docs/runbooks/rollback-compat.md`.
   - Expected: up and down both apply cleanly; the opt-in steps in the runbook match the migration numbers.
   - Why human: operator migration on a restored database. The PG file's `beforeAll` calls `migrate()`; whether migration 43 was applied by that run or was already present was not checked, and the down path was not executed. This rehearsal stays open.

3. **Ordering rule and HARD-H1 ownership (H5)**
   - Test: decide either that the pull reads (`steering_list`, `GET /steering/directives`, the docs_search notice) gain sequence order, or that `docs/live-steering.md:35` is narrowed to the wait cursor. Decide HARD-H1 ownership: add it to a plan's `requirements` field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader.
   - Expected: one documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping.
   - Why human: `REQUIREMENTS.md:124` is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make.

4. **Stale status text (H6)**
   - Test: reconcile ROADMAP.md `### Phase 77` Status (`:1332`) and Plans (`:1342`), and REQUIREMENTS.md `:139`.
   - Expected: the status text matches this record: 7 of 8 truths verified, T8 open under H5, status `human_needed`.
   - Why human: planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. ROADMAP `:1332` still reads `human_needed: 4 of 8` at HEAD c40ffc9a.

### Gaps Summary

No truth is FAILED, no artifact is missing or stubbed, and no key link is broken on the phase's own wiring. The phase is not complete for three reasons, none of which is a code gap the verifier can close:

- T8 (WARNING): the ordering sentence in `docs/live-steering.md:35` is broader than the pull reads deliver. This is decision H5.
- HARD-H1 ownership is open under H5. No plan claims it.
- Migration 43's down path and restored-database rehearsal were not executed (human item 2). The H3 error-code surface (human item 1) and the stale planning text under H6 (human item 4) are also open.

Post-verification: nothing was committed. The change set is limited to the VERIFICATION.md in the worktree.

---

_Verified: 2026-11-05T00:13:45Z_
_Verifier: Claude (gsd-verifier)_
