---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-05T07:59:57Z
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
covered_digest: "v3:sha256:3a7fe63cb8e9396dd87df0f76ab37739bfe59aff3035336784d981ee970322be"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_verification: "77-VERIFICATION.md at 42e3cf13 (verified 2026-11-05T07:10:25Z, digest v3:sha256:7aa7737ba2c8f93f74bf817b8cc72d1a8853f24eac0753e6103c23f3fa89d763); earlier records at 835a2742 (digest v3:sha256:076835c0c992c778c4ce3f7b1ac41f18a68f775f643969fc344430df3c421032), c40ffc9a (v3:sha256:30aaf2b0f9d5ce9759a2bbc96e9a646dd6a943dfc6ef770577ce251fc6a14b68), 9e71f263 (v3:sha256:641ff4b1505e68df6fb61a48110aa074e51fde9c335a1558cc4afa35e8bb5097), 504da465, 4b84e50c, 8a604455, 97defd59, 9ab6f111, c7788f9d and 749e97e3"
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
    why_human: "Operator migration on a restored database. Gate r33 ran the PG file's beforeAll migrate() as a named pass; the down path was not executed by anyone, and no restored-database rehearsal exists. The migration-43 rehearsal stays open."
  - test: "Decide the ordering rule (H5): either the pull reads (steering_list, GET /steering/directives, docs_search notice) gain sequence order, or docs/live-steering.md:35 is narrowed to the wait cursor. Also decide HARD-H1 ownership: add it to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader."
    expected: "One documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping."
    why_human: "REQUIREMENTS.md:124 is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Reconcile the stale status text: ROADMAP.md '### Phase 77' Status (:1332) and Plans (:1342), and REQUIREMENTS.md:139"
    expected: "The status text matches this record: 7 of 8 truths verified, T5 to T7 named gate passes at 6e5d766e, T8 open under H5, status human_needed."
    why_human: "Planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. ROADMAP :1332 still reads 'human_needed: 4 of 8' and 'T5 to T7 ... not verifier-observed' at HEAD 6e5d766e; REQUIREMENTS :139 still reads 'not re-observed'."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-05T07:59:57Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 42e3cf13 (human_needed, 7/8, digest `v3:sha256:7aa7737b…d763`) is replaced. One covered file changed after 42e3cf13 (`service.ts`), so `verification.status` reported `stale`. This run re-audits that change against phase 77's criteria, takes T5 to T7 from the gate r33 JUnit report, and re-runs the nine non-PG covered test files at HEAD. T8 and HARD-H1 remain open.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `6e5d766e`. No code was edited, nothing was committed, no database or docker was started, and the full suite, tsc, lint and formatters were not run. Only `.planning/phases/77-steering-idempotency-and-ordering/77-VERIFICATION.md` was written, in the worktree.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01.

**Gate evidence used for T5 to T7:** gate r33 at 6e5d766e (`/root/src/worktrees/backups/gate-r33-junit.xml`, 12290 testcases). Suite `steering replay and delivery sequence against PostgreSQL` (file `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts`): `tests="4" failures="0" skipped="0"`, each testcase with no `<skipped/>` child. These are gate passes, not a verifier re-run; no Postgres was started for this record. The prior verifier-observed scratch PostgreSQL 16 runs at 42e3cf13 (4 pass, and 16 pass for `live-session-restart.pg.test.ts`) are carried forward because neither file has changed since.

**Change since the prior record (42e3cf13 to 6e5d766e), checked against phase 77:**
- `packages/mcp-server/src/service.ts:3002-3006` (commit `b4bdd0fc`, phase 70): `emit` now calls `corpusSlo.recordSyncLag` also for a note that is `buffered` or `deadLettered`. This is the only covered-file change, and the covered digest moved from `7aa7737b…d763` to `4ba114fc…a883`. Audit: the steering hint path does reach `Substrate.emit` (`service.ts:2055-2058`, `SteeringHintAnnouncer` `emit` returns `.stored`, unchanged). Its payload is `action: "steering.queued"` (`steering-delivery.ts:143`, `:156`), and `syncLagSeconds` returns null unless `action === "docs.sync"` (`corpus/sync-event.ts:20`). So the hint's wake-up and its stored result are unchanged, and no steering truth is affected. The steering wiring block (`service.ts:1998-2050`, `onQueued` at `:2050`) is unchanged; the change sits 950 lines below it.
- `index-store.ts` and `index-store.migrations.digests.json` are unchanged since 42e3cf13 (`git diff` empty). The `corpus_documents` archive entry (`index-archive-spec.ts:16`, `:216`) was added in `a1d6e8f7` and `80afb6e5`, both ancestors of 42e3cf13, so it is not a change since the prior record. Its whitelist test (`index-store.archive.test.ts:188-191`) is scoped to `graph_%`, `memory_%` and `corpus_documents`. The migrate-contract and migrate-harness files pass in gate r33 (53 and 15) and in Run C here.
- Unchanged since 42e3cf13 and checked: `planning/` (all steering files), `event.ts`, `server.ts`, `mcp.ts`, `docs/live-steering.md`, `index-store.ts`. `REQUIREMENTS.md` changed at lines 19, 68, 70 and 76 only; `:124` and `:139` are unchanged. `ROADMAP.md` changed but none of its phase-77 lines (`:1328-1342`) changed.
- Not phase 77 evidence and no truth cites them: `49b9aece` (`event-buffer.ts`, phase 76), `d1a5e89b` (`cache.ts`, phase 75), `b4fe6bfe` (`worktree.py`, phase 68), `6e5d766e` (docs for phases 63, 65, 69, 70, 75; `docs/corpus.md`, `docs/reconcile.md`).

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED | Replay lookup runs after directive schema, key pattern, author and allowlist checks, and before duplicate, rate and audit checks: `steering.ts:503-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !replayed`), wake-up only when `freshlyQueued` (`:159`). Gate r33: `steering.test.ts` "a keyed replay returns the original record and writes nothing, even with no rate token left" pass (`:406`). Run C at HEAD: pass. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152` (`if (input.idempotency_key === undefined) return queued`). Gate r33: `steering-tools.test.ts` "an unkeyed queue keeps its reply shape, with no sequence" (`:227`) and `steering.test.ts` "an unkeyed repeat is a second directive, as before" (`:438`) pass. Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:666-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:154-158` (throws when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Gate r33: `steering-tools.test.ts` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" (`:217`) and `steering.test.ts` "distinct keyed commands take their sequence per target session, and queue order is sequence order" (`:447`) pass. |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (`queuedFor` sorted by sequence, `steering.ts:456-462`; cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:107`, inside `:97-117`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2286`. Gate r33: `server.steering.test.ts` "the wait body carries the delivery sequence of the directive it returns" (`:249`) pass; restart: `steering-durable.test.ts` "after a restart the next distinct command takes the next sequence, and a restored directive keeps its own" (`:899`) and "a keyed retry after a restart returns the original record and sequence, even once the directive was acknowledged, and writes no audit row" (`:883`) pass. |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (gate r33 named pass; scratch PostgreSQL 16.15 at 42e3cf13) | Gate r33 JUnit, suite `steering replay and delivery sequence against PostgreSQL`, testcase "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" (`steering-idempotency.pg.test.ts:73`): pass, no `<skipped/>`. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937` (`planning_steering_sequence` `:919`, `planning_steering_replay` `:923`, down `:917`); Bun adapter `bunSteeringIdempotencyStore` `steering-store.ts:664-717`; factory `steeringIdempotency()` `index-store.ts:1034`. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (gate r33 named passes) | Gate r33 JUnit, same suite: "a claim whose unit fails keeps no replay record on either instance" (`steering-idempotency.pg.test.ts:93`) pass; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" (`:112`) pass. Also gate r33 `steering-durable.test.ts` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" (`:948`) and "an audit refusal inside the keyed claim holds nothing, so the retry queues once" (`:960`) pass. Code: keyed path takes the claim with the audit inside it, `steering.ts:546` (`claimKeyed`, `:582-593`); claim unit `steering-store.ts:658-717` (`claimReplay`). |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (gate r33 named pass) | Gate r33 JUnit, same suite: "two concurrent keyed commands through two instances queue one directive and both get its reply" (`steering-idempotency.pg.test.ts:122`) pass, `assertions="4"`. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:692-695`); a loser reads the winner's row in the same transaction and queues nothing. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged since 42e3cf13 (`docs/live-steering.md` no diff). `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` reads `recordsFor` (`steering.ts:471-480`), which sorts by `compareDirectives` (`steering.ts:998`: priority rank, then `createdAtMs`, then id), and its listed shape has no `sequence` field. `GET /steering/directives` (`steering-rest.ts:147-155`) uses the same comparator and does carry `sequence`. The docs_search notice also orders by priority. Excluded from the score. |

**Score:** 7/8 truths verified (T1 to T7). T8 is UNCERTAIN and is excluded from the score. No truth is FAILED.

### Phase 77 fix commit check (G1 to G5)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:664-687`, `:688-716`, `:720-730` | `steering-idempotency.pg.test.ts:73` | Gate r33 JUnit pass (T5). |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`; `steering-store.ts:689`, `:705`, `:298` | PG `steering-idempotency.pg.test.ts:93`, `:112` (gate r33 pass); memory `steering-durable.test.ts:948`, `:960` (gate r33 pass) | VERIFIED (T6). Error-code surface is H3. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:692-695`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG `steering-idempotency.pg.test.ts:122` (gate r33 pass) | VERIFIED (T7). |
| G4: wait body carries sequence | `server.ts:2286`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (gate r33 pass; Run C pass at HEAD) | VERIFIED. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

Level 1 and 2 (exists, substantive): all 31 entries of the covered set exist at HEAD and are non-stub; the debt-marker grep (`TBD|FIXME|XXX`) over the implementation files returns no match. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` (exit 66, NO_INPUT) is not applicable and nothing is marked VERIFIED on that basis; artifact status is from the citations above.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive, unchanged since 42e3cf13; wired through `service.ts:1998-2050`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive, unchanged since 42e3cf13; exercised by gate r33 `steering-idempotency.pg.test.ts` (4 pass, 0 skipped). |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; migration digest contract passes (gate r33 `index-store.migrate-contract.test.ts` 53 pass; Run C pass at HEAD). Up path reached by the PG file's `migrate()` in gate r33; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:143`, `:150-159`. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `:97-117`, `:107`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `:2272-2286`. |
| `packages/mcp-server/src/service.ts` | steering idempotency wiring and settings | ✓ VERIFIED | Steering wiring `:1998-2050` (`steeringErrors` `:1998`, `steeringIdempotency()` `:2015`, settings `:2027`, `onQueued` `:2050`), unchanged in content. The `b4bdd0fc` emit change at `:3002-3006` is outside it and does not reach a steering truth (see Change section). |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Gate r33 JUnit: 4 pass, 0 failures, 0 skipped. |
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | PG-gated, covered by the phase digest | ✓ VERIFIED (gate r33) | Gate r33 JUnit: 16 pass, 0 failures, 0 skipped (suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)"). |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable (Step 5). Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path exercised by gate r33 `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:2015` and `:2027`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `steering.ts` `onSteeringQueued` hint | `service.ts` `emit` | `SteeringHintAnnouncer` (`service.ts:2055-2058`, `steering-delivery.ts:186`) | WIRED, unaffected | `emit` returns `.stored`, unchanged by `b4bdd0fc`; `recordSyncLag` ignores `steering.queued` payloads (`corpus/sync-event.ts:20`). |
| `server.ts` `/steering/wait` | `steering-waiters.ts` `nextQueuedDirective` | `restDirective(waited.record, waited.sequence)` | WIRED | `server.ts:2286`; observed by gate r33 `server.steering.test.ts:249`. |
| `steering_list` / `GET /steering/directives` | per-session sequence order | `compareDirectives` | NOT WIRED to sequence | Priority order, not sequence (T8). Open decision H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering-tools.ts` keyed reply | `sequence` | `inbox.sequenceOf` ← `sequences` map ← `replayOf` / `doEnqueue` | Yes (memory store in tests; PG store in gate r33 and scratch PostgreSQL 16.15 at 42e3cf13) | ✓ FLOWING |
| `steering-waiters.ts` cursor | `queued[]` | `queuedFor` sorted by sequence | Yes | ✓ FLOWING |
| `steering_list` | priority-ordered records | `recordsFor` | Yes, but order is priority | ⚠️ FLOWING, order disputed (T8) |

### Behavioral Spot-Checks

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A (gate r33 JUnit, PG files) | parse `/root/src/worktrees/backups/gate-r33-junit.xml` for the covered test files | `steering-idempotency.pg.test.ts` 4 pass; `live-session-restart.pg.test.ts` 16 pass; no failure and no `<skipped/>` in any of the 12 covered test files (373 testcases: event 84, migrate-contract 53, migrate-harness 15, live-session-restart.pg 16, mcp.steering 21, steering-durable 45, steering-idempotency.pg 4, steering-rest 23, steering-tools 21, steering-waiters 21, steering 41, server.steering 29) | ✓ PASS (not re-run) |
| B (non-PG, targeted, one command at HEAD) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000` on `index-store.migrate-contract`, `index-store.migrate-harness`, `planning/steering`, `planning/steering-durable`, `planning/steering-tools`, `planning/steering-rest`, `planning/steering-waiters`, `server.steering`, `mcp.steering` | 269 pass, 0 fail, 2245 expect() calls, 9 files, 6.58 s (same count as the 42e3cf13 run) | ✓ PASS |
| C (PG, per file) | `bun test src/planning/steering-idempotency.pg.test.ts` and `src/live-session-restart.pg.test.ts` | Not run by this verifier: Postgres not started, per the assignment. Gate r33 and the 42e3cf13 scratch runs cited instead. | ? SKIP (evidence carried from gate r33 and the 42e3cf13 record) |

Run B's stderr lines (controlled ledger outage, settings-invalid message) are expected-failure paths asserted by their tests; no test failed.

### Probe Execution

No probes are declared or implied for this phase (no `scripts/*/tests/probe-*.sh` in the PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-H1 | none (no plan claims it) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence | ✗ ORPHANED (open, H5) | REQUIREMENTS.md:124 unchecked; `:139` status "Human-needed (2026-11-03): 4 of 8 truths verified at 4b84e50c ... T5 to T7 Postgres proofs present and wired, not re-observed". The text predates this record and is stale (H6). The ownership question is open under H5. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/live-steering.md` | 35 | Ordering sentence is broader than the pull reads deliver | ⚠️ Warning | T8, under H5. |
| `packages/mcp-server/src/planning/steering-store.ts` | 689-717 | Claim unit depends on a transaction; the memory store has none | ℹ️ Info | Stated in PLAN R1 and SUMMARY R1. Memory store is used only in tests and as the default when the audit opt-in is off. |
| `packages/mcp-server/src/index-archive-spec.ts` | 10-22 | The index archive whitelist (`graph_*`, `memory_*`, `corpus_documents`) does not include the `planning_steering_*` tables, including the two that migration 43 adds | ℹ️ Info | Not a phase 77 criterion, and the archive test does not require them. Recorded for the owner; not a gap. |

No `TBD`, `FIXME` or `XXX` markers were found in the phase's implementation files. No debt-marker blocker.

### Human Verification Required

1. **Audit refusal error code (H3)**
   - Test: force an audit refusal inside a keyed Postgres claim through `SteeringInbox` (the `AuditRefused` path, not a thrown error injected into `claimReplay`) and read the reported error code.
   - Expected: the queue is refused as `audit-unavailable`, the claim rolls back, nothing is queued. `lastErrorCode` may show the aborted-transaction code rather than the driver error (`steering.ts:769-780`).
   - Why human: `steering-idempotency.pg.test.ts:93` proves the rollback with a thrown error inside the claim unit. Which code the operator sees is an owner decision (H3).

2. **Migration 43 rehearsal**
   - Test: apply migration 43 up and down on a restored rehearsal copy of the database, and walk the steering-audit opt-in steps (33, 34, 43) in `docs/runbooks/rollback-compat.md`.
   - Expected: up and down both apply cleanly; the opt-in steps in the runbook match the migration numbers.
   - Why human: operator migration on a restored database. Gate r33 ran the PG file's `beforeAll` `migrate()` as a named pass, but no one executed the down path or a restored-database rehearsal. This stays open.

3. **Ordering rule and HARD-H1 ownership (H5)**
   - Test: decide either that the pull reads (`steering_list`, `GET /steering/directives`, the docs_search notice) gain sequence order, or that `docs/live-steering.md:35` is narrowed to the wait cursor. Decide HARD-H1 ownership: add it to a plan's `requirements` field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader.
   - Expected: one documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping.
   - Why human: `REQUIREMENTS.md:124` is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make.

4. **Stale status text (H6)**
   - Test: reconcile ROADMAP.md `### Phase 77` Status (`:1332`) and Plans (`:1342`), and REQUIREMENTS.md `:139`.
   - Expected: the status text matches this record: 7 of 8 truths verified, T5 to T7 named gate passes at 6e5d766e, T8 open under H5, status `human_needed`.
   - Why human: planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. ROADMAP `:1332` still reads "human_needed: 4 of 8" and "not verifier-observed" at HEAD 6e5d766e.

### Gaps Summary

No truth is FAILED, no artifact is missing or stubbed, and no key link is broken on the phase's own wiring. The phase is not complete for three reasons, none of which is a code gap the verifier can close:

- T8 (WARNING): the ordering sentence in `docs/live-steering.md:35` is broader than the pull reads deliver. This is decision H5.
- HARD-H1 ownership is open under H5. No plan claims it.
- Migration 43's down path and restored-database rehearsal were not executed (human item 2). The H3 error-code surface (human item 1) and the stale planning text under H6 (human item 4) are also open.

Post-verification: nothing was committed. The change set is limited to the VERIFICATION.md in the worktree.

---

_Verified: 2026-11-05T07:59:57Z_
_Verifier: Claude (gsd-verifier)_
