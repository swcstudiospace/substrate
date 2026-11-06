---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-06T02:56:36Z
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
  - "packages/mcp-server/src/corpus/sync-event.ts"
  - "packages/mcp-server/src/event.test.ts"
  - "packages/mcp-server/src/event.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/index-archive-spec.ts"
  - "packages/mcp-server/src/index-store.migrate-contract.test.ts"
  - "packages/mcp-server/src/index-store.migrate-harness.test.ts"
  - "packages/mcp-server/src/index-store.migrations.digests.json"
  - "packages/mcp-server/src/index-store.ts"
  - "packages/mcp-server/src/index-sweep.ts"
  - "packages/mcp-server/src/live-session-restart.pg.test.ts"
  - "packages/mcp-server/src/mcp.steering.test.ts"
  - "packages/mcp-server/src/mcp.ts"
  - "packages/mcp-server/src/memory-retain.ts"
  - "packages/mcp-server/src/planning/steering-delivery.ts"
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
  - "packages/mcp-server/src/silent-failures.ts"
  - "scripts/code-ratchet.test.ts"
covered_digest: "v3:sha256:ba3cc9960efdd3122fd1664e5ed3969cb8cb6d9b0d0eada7020c5d64d9a29b5d"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_verification: "77-VERIFICATION.md at a46d42c3 (verified 2026-11-06T00:43:37Z, frontmatter digest v3:sha256:cd963ce7d17f2cd1ea077e294be67e4f8992aa0120fb0a0efbfad19e302b1bcc)"
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
    why_human: "Operator migration on a restored database. Gate r38 ran the PG file's beforeAll migrate() as a named pass; the down path was not executed by anyone, and no restored-database rehearsal exists. The migration-43 rehearsal is operator-only and stays open."
  - test: "Decide the ordering rule (H5): either the pull reads (steering_list, GET /steering/directives, docs_search notice) gain sequence order, or docs/live-steering.md:35 is narrowed to the wait cursor. Also decide HARD-H1 ownership: add it to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader."
    expected: "One documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping."
    why_human: "REQUIREMENTS.md:124 is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Re-point the planning status text to this record's head: ROADMAP.md '### Phase 77' Status (:1332) and REQUIREMENTS.md:139 now carry this record's wording (commit 5041193f), but both still cite a46d42c3 as the verified head"
    expected: "The status text names the head of the re-verification that replaces this record, and says T5 to T7 are gate r38 passes. Planning-document edits are owner or orchestrator work (H6)."
    why_human: "The verifier does not edit planning docs. The text is otherwise consistent with this record (7 of 8 truths, T8 open under H5, status human_needed)."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-06T02:56:36Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at a46d42c3 (human_needed, 7/8) is replaced. Fourteen commits landed after a46d42c3. Of the covered files, the steering code changed only by removal of the `export` keyword from self-only declarations (commit `b8cbdeac`), with no other diff; the only non-export hunks in covered files are a REST `/handoff` refusal above the wait route, an `event.ts` and an `index-store.ts` comment line, a `service.ts` `manifestCommit` change owned by phase 63, and the retainDocumentId narrowing in `memory-retain.ts` and `index-sweep.ts`. This pass keeps T1 to T7 as verified, takes T5 to T7 from gate r38 (not r36), re-points the moved `/steering/wait` citations, keeps T8 and HARD-H1 open, and records the new covered set and digest from `gsd_run query verification.fingerprint` at head `5e304ef8`.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `5e304ef8`, working tree clean. Read-only: no code was edited, nothing was committed, no test, tsc, lint, formatter, docker or database was run, and no `gsd_run` verification writer was called. The only file written is this draft at `/root/src/worktrees/backups/records/r39/77-VERIFICATION.md`.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01.

**Gate evidence used:** gate r38, JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`, run on code head `66fa97bd`. Its one `<failure>` is `scripts/code-ratchet.test.ts:549` ("the ratchet is tight: no source counter sits below its baseline"), the ratchet check that `5e304ef8` (as_unknown_as ratchet lowered to 22) addresses. `5e304ef8` landed after the r38 run, so a pass for that check at head is for gate r39 to confirm. The r38 run has two `<skipped>` cases, neither in a covered file: `redact.test.ts:815` ("D-04 fixtures do not survive the write path while counts do") and `cache-conformance.test.ts:120` ("live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)"). The verifier read the JUnit (read-only) and checked the cited titles: each is a testcase with a pass status (no `failure`, `error` or `skipped` child), and each title exists in source at the cited file and line. No testcase in a covered test file has a failure, error or skip. No pass count is claimed here. These are gate passes, not a verifier re-run. Gate r39 (`/root/src/worktrees/backups/gate-r39-junit.xml`) had not been written when this draft was made, and no verdict rests on it. The PG suites were not started by the verifier.

**Change since the prior record (a46d42c3 to 5e304ef8):** fourteen commits. Covered-file hunks, checked by comparing each covered file at a46d42c3 and at HEAD with the `export ` prefix normalised away, so that only behaviour-relevant differences remain:
- Steering code (`planning/steering.ts`, `steering-store.ts`, `steering-tools.ts`, `steering-waiters.ts`, `steering-rest.ts`, `steering-delivery.ts`): the only difference is the removal of `export` from self-only declarations, in commit `b8cbdeac`. `config.ts` (`b8cbdeac`, `5e304ef8`), `flag-registry.ts` and `mcp.ts` (`b8cbdeac`) differ only by the same removal. Line counts are unchanged, so every cited line in these files is still valid. No behaviour change. The replay, claim and sequence code (`steering.ts:451-593`, `steering-store.ts:663-730`) and the waiter cursor (`steering-waiters.ts:63-68`) are unchanged.
- `server.ts` (`14ac787a`): one refusal added at `:1507-1511`, in the REST `/handoff` route. It refuses a `to` outside `SURFACES` with 400 and writes nothing. It is not a `/steering/*` route. Because it adds five lines above the wait route, the `/steering/wait` route moved from `:2288-2302` to `:2293-2307`, and the `restDirective(waited.record, waited.sequence)` call moved from `:2302` to `:2307`. The code at each point is the same.
- `service.ts`: `manifestCommit` (`0947001e`, phase 63) now returns the row rather than its `commit` field, which is the shape `docs-search.ts:362` declares. It is outside phase 77 and is not a steering hunk. The export removal is the only other change. The steering emit sites at `:2252-2255` and `:2283-2286` are unchanged from a46d42c3 and still return `false`.
- `event.ts` (`e62bc17b`) and `index-store.ts` (`e62bc17b`): one comment line each. The migration 43 block `index-store.ts:912-937` and the adapter `:1034` are unchanged.
- `memory-retain.ts` and `index-sweep.ts` (`a2176f96`): `retainDocumentId` takes `{ scope, kind, subject? }` in place of a cast `MemoryEntry`, and `index-sweep.ts` stops building that fabricated object. The function body is unchanged: a subject-less call still returns the idempotency key, and a subject call still returns `subj_` plus the hash of the canonical JSON of `{ scope, kind, subject }`, the same three fields as before. Neither file references steering, and `retainDocumentId` is not on any steering path. Both files are added to `covered_files` for the record, as the orchestrator asked, but they bear on no criterion here.
- The other covered-set files (`docs/*.md`, `.env.example`, `index-store.migrate-*`, `*.test.ts` in the covered set, `index-store.migrations.digests.json`) are byte-identical between a46d42c3 and HEAD.
- `5041193f` reconciled `ROADMAP.md` and `REQUIREMENTS.md` to this record's status. Neither is a covered input (planning docs are excluded from the digest by construction).

A grep for `RestSteeringSession`, `isPlanningUpdate` and `STEERING_AUDIT_TABLE` finds no remaining export; the only match is `STEERING_AUDIT_TABLE_ENV` in `steering-store.ts:49`, which is a different, still-used identifier.

**Covered digest:** `v3:sha256:ba3cc996…b5`, as returned by `gsd_run query verification.fingerprint` at HEAD `5e304ef8` over the 38 `covered_files` above. The digest was not hand-computed. It is pasted verbatim into the frontmatter.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED | Replay lookup runs after directive schema (`steering.ts:504-505`), key pattern (`:507`), author (`:509`) and allowlist (`:510`), and before duplicate (`:520`), rate (`:522-526`) and audit (`:528-543`): `:512-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !receipt.value.replayed`), wake-up only when `freshlyQueued` (`:159`). Gate r38: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left": pass. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152` (`if (input.idempotency_key === undefined) return queued`). Gate r38: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence" and `steering.test.ts:438` "an unkeyed repeat is a second directive, as before": pass. Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:665-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156` (throws at `:155` when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Gate r38: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" and `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order": pass. |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`), over `queuedFor` sorted by sequence (`steering.ts:456-462`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:98` inside `:88-108`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2307` (moved from `:2302` by the REST handoff refusal at `:1507`). Gate r38: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns": pass. Restart: `live-session-restart.pg.test.ts` suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)" (`:162`), testcases at `:181` and `:225`: pass, no `<skipped/>`. |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (gate r38 named pass; not re-run by the verifier) | Gate r38, suite `steering replay and delivery sequence against PostgreSQL` (file `steering-idempotency.pg.test.ts:36`), testcase "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" (`steering-idempotency.pg.test.ts:73`): pass, no `<skipped/>`. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937` (version `:913`, down `:917`, `planning_steering_sequence` `:919`, `planning_steering_replay` `:923`, `scope_key` primary key `:924`); Bun adapter `index-store.ts:1034`, `steering-store.ts:663-730` (`nextSequence` `:665-672`, `findReplay` `:679-686`, `claimReplay` `:687-714`, `replayRecord` `:719-730`). |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (gate r38 named passes) | Gate r38, same suite: "a claim whose unit fails keeps no replay record on either instance" (`steering-idempotency.pg.test.ts:93`) pass; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" (`:112`) pass. Also gate r38 `steering-durable.test.ts` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" (`:948`) and "an audit refusal inside the keyed claim holds nothing, so the retry queues once" (`:960`): pass. Code: the keyed path takes the claim with the audit inside it, `steering.ts:546`; `claimKeyed` `:582-593` (the audit runs inside the claim unit at `:585`; an `AuditRefused` is thrown into the unit at `:586` and mapped back to its refusal at `:590`); the store's transaction is `steering-store.ts:688` (`sql.begin`), the claim insert `:690-694`, the audit `queue(tx)` `:704` in the same transaction, and the audit port uses the unit at `:297`. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (gate r38 named pass) | Gate r38, same suite: "two concurrent keyed commands through two instances queue one directive and both get its reply" (`steering-idempotency.pg.test.ts:122`) pass. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:690-694`); a loser reads the winner's row in the same transaction and queues nothing. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged since a46d42c3 (`docs/live-steering.md` has no diff). `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` (`steering-tools.ts:178`) reads `recordsFor` (`steering.ts:475-480`), which sorts by `compareDirectives` (`steering.ts:480`, comparator `:998`: priority rank, then `createdAtMs`, then id). Its listed shape `ListedSteeringDirective` (`steering-tools.ts:137`) has no `sequence` field. `GET /steering/directives` (`listRestDirectives`, `steering-rest.ts:138-147`) sorts by `compareDirectives` at `:144`; its body carries `sequence` (`restDirective` `:98`), but the order is priority. The docs_search notice (`steeringNoticeFor`, `steering-delivery.ts:62-70`, "highest priority first, then oldest" at `:53`) is called from `service.ts:4222`. No commit in this range changed any of these. The sentence in the doc is therefore broader than the pull reads. Decision H5. Excluded from the score. |

**Score:** 7/8 truths verified (T1 to T7). T8 is UNCERTAIN and is excluded from the score. No truth is FAILED.

### Phase fix commit check (G1 to G5)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:665-672`, `:679-714`, `:719-730` | `steering-idempotency.pg.test.ts:73` | Gate r38 pass (T5). |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`; `steering-store.ts:688`, `:704`, `:297` | PG `steering-idempotency.pg.test.ts:93`, `:112` (gate r38 pass); memory `steering-durable.test.ts:948`, `:960` (gate r38 pass) | VERIFIED (T6). Error-code surface is H3. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:690-694`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG `steering-idempotency.pg.test.ts:122` (gate r38 pass) | VERIFIED (T7). |
| G4: wait body carries sequence | `server.ts:2307`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (gate r38 pass) | VERIFIED. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

Level 1 and 2 (exists, substantive): all 38 entries of the covered set exist at HEAD and are non-stub. The debt-marker grep (`TBD|FIXME|XXX`) over the implementation files (`planning/steering*.ts`, `service.ts` steering block, `server.ts` steering routes, `index-store.ts` migration 43) returned no match. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` is not applicable and nothing is marked VERIFIED on that basis.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive. Changed since a46d42c3 only by `export` removal on `SteeringInboxDeps`, `SteeringPolicy` and other self-only types; line numbers unchanged. Wired through `service.ts:2001-2053`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive. Changed only by `export` removal (`b8cbdeac`); exercised by gate r38 `steering-idempotency.pg.test.ts`. |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; unchanged except one comment line at `:2785` (`e62bc17b`). Migration digest contract passes in gate r38 (`index-store.migrate-contract.test.ts`). Up path reached by the PG file's `migrate()` in gate r38; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:137`, `:143`, `:150-159`, `:178`; changed only by `export` removal. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `restDirective` `:88-108` (`sequence` `:98`); `listRestDirectives` `:138-147` (sort `:144`). |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`; changed only by `export` removal. |
| `packages/mcp-server/src/planning/steering-delivery.ts` | steering hint announcer, docs_search notice | ✓ VERIFIED | `steeringNoticeFor` `:62-70`; `SteeringHintAnnouncer` announce at `:186`; changed only by `export` removal. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `/steering/wait` `:2293-2307` (`restDirective` `:2307`), moved by +5 lines from the REST `/handoff` refusal at `:1507-1511`; no hunk in any `/steering/*` route. |
| `packages/mcp-server/src/service.ts` | steering idempotency wiring and settings; steering emit sites | ✓ VERIFIED | Steering wiring `:2001-2053` (`steeringErrors` `:2001`, `steeringIdempotency()` `:2018`, settings `:2024`, `onQueued` `:2053`), no steering hunk. Emit sites `:2252-2255` and `:2283-2286` report via `reportSilent` and return `false` (since `f0f3c04e`). Other non-steering hunk: `manifestCommit` (phase 63). |
| `packages/mcp-server/src/memory-retain.ts`, `packages/mcp-server/src/index-sweep.ts` | (not a phase 77 criterion) | ✓ NO STEERING IMPACT | `retainDocumentId` narrowed to `{ scope, kind, subject? }` (`a2176f96`); body unchanged; no steering reference. Listed in `covered_files` as the orchestrator requested. |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Gate r38: the suite's cited titles are pass with no `<skipped/>`. |
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | PG-gated, covered by the phase digest | ✓ VERIFIED (gate r38) | Gate r38: suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)" cited testcases `:181` and `:225` pass. |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable. Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path exercised by gate r38 `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:2018` and `:2024`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `steering.ts` `onSteeringQueued` hint | `service.ts` `emit` | `SteeringHintAnnouncer` (`service.ts:2058`, `steering-delivery.ts:186`) | WIRED, unaffected | `emit` still returns `.stored`. The `publishHint` bus call (`service.ts:3029-3033`) is fire-and-forget and only logs through `reportSilent` on rejection. `recordSyncLag` ignores `steering.queued` payloads (`corpus/sync-event.ts:20`). |
| `server.ts` `/steering/wait` | `steering-waiters.ts` `nextQueuedDirective` | `restDirective(waited.record, waited.sequence)` | WIRED | `server.ts:2307`; observed by gate r38 `server.steering.test.ts:249`. |
| `steering_list` / `GET /steering/directives` | per-session sequence order | `compareDirectives` | NOT WIRED to sequence | Priority order, not sequence (T8). Open decision H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering-tools.ts` keyed reply | `sequence` | `inbox.sequenceOf` ← `sequences` map ← `replayOf` / `doEnqueue` | Yes (memory store in tests; PG store in gate r38) | ✓ FLOWING |
| `steering-waiters.ts` cursor | `queued[]` | `queuedFor` sorted by sequence | Yes | ✓ FLOWING |
| `steering_list` | priority-ordered records | `recordsFor` | Yes, but order is priority | ⚠️ FLOWING, order disputed (T8) |

### Behavioral Spot-Checks

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A (gate r38 JUnit, covered test files) | Read-only parse of `/root/src/worktrees/backups/gate-r38-junit.xml`: every testcase whose title, file or classname is in a covered test file | No testcase in a covered test file has a `failure`, `error` or `skipped` child. Every title cited in this record was matched by exact name and checked against source at the cited file and line. | ✓ PASS (gate evidence, not re-run) |
| A2 (gate r38 run totals) | JUnit root attributes | One `<failure>` in the run, `scripts/code-ratchet.test.ts:549` (the ratchet check, fixed at head by `5e304ef8`, after the run). Two `<skipped>`, neither in a covered file. | ✓ GATE EVIDENCE; gate r39 pending |
| B (non-PG targeted run) | none | Not run in this pass (no test runs by assignment). | ? SKIP |
| C (PG, per file) | none | Not run: Postgres not started. T5 to T7 rely on the r38 named passes. | ? SKIP (gate evidence only) |

### Probe Execution

No probes are declared or implied for this phase (no `scripts/*/tests/probe-*.sh` in the PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-H1 | none (no plan claims it) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence | ✗ ORPHANED (open, H5) | `REQUIREMENTS.md:124` unchecked; `:139` status (updated at `5041193f`): "Human-needed (2026-11-06): 7 of 8 truths verified at a46d42c3 (T1 to T7); T8 uncertain and not scored; T5 to T7 named gate passes; open: T8 per-session ordering rule and HARD-H1 ownership, no plan claims it (STATE Needs Human, H5)". The ownership question is open under H5. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/live-steering.md` | 35 | Ordering sentence is broader than the pull reads deliver | ⚠️ Warning | T8, under H5. |
| `packages/mcp-server/src/planning/steering-store.ts` | 688-714 | Claim unit depends on a transaction; the memory store has none | ℹ️ Info | Stated in PLAN R1 and SUMMARY R1. Memory store is used only in tests and as the default when the audit opt-in is off. |
| `packages/mcp-server/src/index-archive-spec.ts` | 10-22 | The index archive list does not include the `planning_steering_*` tables, including the two that migration 43 adds (verified: the file has no `planning_steering` reference) | ℹ️ Info | Not a phase 77 criterion, and the archive test does not require them. Recorded for the owner; not a gap. |

No `TBD`, `FIXME` or `XXX` markers were found in the phase's implementation files. No debt-marker blocker.

### Human Verification Required

1. **Audit refusal error code (H3)**
   - Test: force an audit refusal inside a keyed Postgres claim through `SteeringInbox` (the `AuditRefused` path, not a thrown error injected into `claimReplay`) and read the reported error code.
   - Expected: the queue is refused as `audit-unavailable`, the claim rolls back, nothing is queued. `lastErrorCode` may show the aborted-transaction code rather than the driver error (`audit()` retry loop, `steering.ts:769-780`, reached through `claimKeyed` `:585`).
   - Why human: `steering-idempotency.pg.test.ts:93` proves the rollback with a thrown error inside the claim unit. Which code the operator sees is an owner decision (H3). Open.

2. **Migration 43 rehearsal (operator-only)**
   - Test: apply migration 43 up and down on a restored rehearsal copy of the database, and walk the steering-audit opt-in steps (33, 34, 43) in `docs/runbooks/rollback-compat.md`.
   - Expected: up and down both apply cleanly; the opt-in steps in the runbook match the migration numbers.
   - Why human: operator migration on a restored database. Gate r38 ran the PG file's `beforeAll` `migrate()` as a named pass, but no one executed the down path or a restored-database rehearsal. Open.

3. **Ordering rule and HARD-H1 ownership (H5)**
   - Test: decide either that the pull reads (`steering_list`, `GET /steering/directives`, the docs_search notice) gain sequence order, or that `docs/live-steering.md:35` is narrowed to the wait cursor. Decide HARD-H1 ownership: add it to a plan's `requirements` field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader.
   - Expected: one documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping.
   - Why human: `REQUIREMENTS.md:124` is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make. Open.

4. **Planning status text head (H6)**
   - Test: `ROADMAP.md` `### Phase 77` Status (`:1332`) and `REQUIREMENTS.md:139` now carry this record's wording (commit `5041193f`), and both cite a46d42c3 as the verified head.
   - Expected: when this re-verification replaces the record, the head citation names the new record head, and the text says T5 to T7 are gate r38 passes.
   - Why human: planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. The rest of the text (7 of 8 truths, T8 open under H5, status `human_needed`) matches this record.

### Owner items (no owner decision for this phase on 2026-11-06)

The owner decided on 2026-11-06 only for phases 67 (criterion 4), 74 (HARD-R1) and 75 (O1). Phase 77 has no owner decision, so every item below stays open. No code change in this range is recorded here as a decision.

- H3 (audit refusal error code): open. Human item 1.
- H5 (per-session ordering rule and HARD-H1 ownership): open. Human item 3.
- Migration 43 rehearsal (down path and restored-database run): open, operator-only. Human item 2.
- H6 (planning status text): the text was reconciled by commit `5041193f`, a documentation commit and not an owner decision. Re-pointing its a46d42c3 head citation is an orchestrator action. Human item 4.

### Test titles cited (each checked in source and in gate r38)

- `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left"
- `steering.test.ts:438` "an unkeyed repeat is a second directive, as before"
- `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order"
- `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write"
- `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence"
- `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns"
- `steering-idempotency.pg.test.ts:73` "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value"
- `steering-idempotency.pg.test.ts:93` "a claim whose unit fails keeps no replay record on either instance"
- `steering-idempotency.pg.test.ts:112` "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays"
- `steering-idempotency.pg.test.ts:122` "two concurrent keyed commands through two instances queue one directive and both get its reply"
- `steering-durable.test.ts:948` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice"
- `steering-durable.test.ts:960` "an audit refusal inside the keyed claim holds nothing, so the retry queues once"
- `live-session-restart.pg.test.ts:181` "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"
- `live-session-restart.pg.test.ts:225` "close racing independent-pool transition reports its actual committed effect without revival"
- Suite `steering replay and delivery sequence against PostgreSQL` (`steering-idempotency.pg.test.ts:36`)
- Suite `HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)` (`live-session-restart.pg.test.ts:162`)
- Suite `keyed replay and delivery sequence across a restart` (`steering-durable.test.ts:873`)

`missing_test_titles`: none. Skipped titles noted above (`redact.test.ts:815`, `cache-conformance.test.ts:120`) are gate facts, not cited proof.

### Gaps Summary

No truth is FAILED, no artifact is missing or stubbed, and no key link is broken on the phase's own wiring. The change since a46d42c3 leaves the replay, claim and sequence code and their tests unchanged. The steering code changed only by removal of `export` keywords; the REST `/handoff` refusal, the phase 63 `manifestCommit` change and the retainDocumentId narrowing are not steering hunks. The phase is not complete for three reasons, none of which is a code gap the verifier can close:

- T8 (WARNING): the ordering sentence in `docs/live-steering.md:35` is broader than the pull reads deliver. This is decision H5.
- HARD-H1 ownership is open under H5. No plan claims it.
- Migration 43's down path and restored-database rehearsal were not executed (human item 2). The H3 error-code surface (human item 1) is also open.

Post-verification: nothing was committed or edited in the repository. The only file written is this draft, at `/root/src/worktrees/backups/records/r39/77-VERIFICATION.md`.

---

_Verified: 2026-11-06T02:56:36Z_
_Verifier: Claude (gsd-verifier, re-verification pass)_
