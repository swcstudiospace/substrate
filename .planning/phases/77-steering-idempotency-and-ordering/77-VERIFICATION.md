---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-06T00:43:37Z
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
covered_digest: "v3:sha256:cd963ce7d17f2cd1ea077e294be67e4f8992aa0120fb0a0efbfad19e302b1bcc"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_verification: "77-VERIFICATION.md at aef8a351 (verified 2026-11-05T07:59:57Z, digest v3:sha256:3a7fe63cb8e9396dd87df0f76ab37739bfe59aff3035336784d981ee970322be)"
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
    why_human: "Operator migration on a restored database. Gate r36 ran the PG file's beforeAll migrate() as a named pass; the down path was not executed by anyone, and no restored-database rehearsal exists. The migration-43 rehearsal stays open."
  - test: "Decide the ordering rule (H5): either the pull reads (steering_list, GET /steering/directives, docs_search notice) gain sequence order, or docs/live-steering.md:35 is narrowed to the wait cursor. Also decide HARD-H1 ownership: add it to a plan's requirements field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader."
    expected: "One documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping."
    why_human: "REQUIREMENTS.md:124 is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make."
  - test: "Reconcile the stale status text: ROADMAP.md '### Phase 77' Status (:1332) and Plans (:1342), and REQUIREMENTS.md:139"
    expected: "The status text matches this record: 7 of 8 truths verified, T5 to T7 named gate passes at a46d42c3, T8 open under H5, status human_needed."
    why_human: "Planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. ROADMAP :1332 still reads 'human_needed: 4 of 8' and 'T5 to T7 ... not verifier-observed'; REQUIREMENTS :139 still reads 'not re-observed'."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-06T00:43:37Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at aef8a351 (human_needed, 7/8, digest `v3:sha256:3a7fe63c…2be`) is replaced. Nine commits landed after aef8a351 (the record commit), and seven covered files changed. This pass re-audits T1 to T7 against those changes, confirms the replay and sequence paths are unchanged, takes T5 to T7 from the gate r36 JUnit, and keeps T8 and HARD-H1 open.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `a46d42c3`, working tree clean. Read-only: no code was edited, nothing was committed, no test, tsc, lint, formatter, docker or database was run. The only file written is this draft at `/root/src/worktrees/backups/records/77-VERIFICATION.md`.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01.

**Gate evidence used:** gate r36 at HEAD. `/root/src/worktrees/backups/gates-int-r36.log` records `PG_READY port=51007 head=a46d42c3` and `GATES_DONE rc=0`. The JUnit is `/root/src/worktrees/backups/gate-r36-junit.xml`: 12,317 testcases, 0 `<failure>`, 0 `<error>`, 2 `<skipped>`. The two skipped cases are `redact.test.ts:815` ("D-04 fixtures do not survive the write path while counts do") and `cache-conformance.test.ts:120` ("live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)"). Neither is a covered file. The verifier parsed the JUnit read-only and checked each cited title: it is a testcase with no `failure`, `error` or `skipped` child, and its file and line match the source. These are gate passes, not a verifier re-run. The PG suites were not started.

**Change since the prior record (aef8a351 to a46d42c3):** nine commits: `e3914640`, `e958e8b1`, `885e73ce`, `7a1d923a`, `c371cece`, `f0f3c04e`, `9b793653`, `a46d42c3`, `b1bb49f2` (docs only). `git diff aef8a351 HEAD` touches seven covered files, and the steering-relevant ones are:
- `packages/mcp-server/src/service.ts` (`f0f3c04e`). Two steering emit sites now report their rejection, and return the same value as before:
  - `service.ts:2252-2255` (session open/close receipt): `reportSilent("emit.steering-session", cause)`, then `return false`. Previously `() => false`.
  - `service.ts:2283-2286` (session ended): `reportSilent("emit.steering-ended", cause)`, then `return false`.
  - The helper `reportSilent` (`packages/mcp-server/src/silent-failures.ts`) writes one stderr line per site per process and does not throw. `eventStored` and the receipt are unchanged. These sites are the only steering hunks in `service.ts`. The other hunks in the range are non-steering: `emit.bus-hint` (`:3033`), `emit.teachable`, `retain.forward`, `emit.retain-warning`, `emit.bind-correlation`, `emit.lease-expired`, `handover.release`, and a deadLetters wiring field (`:2123`). None of them is on the keyed replay, claim or sequence path.
- `packages/mcp-server/src/server.ts` (`f0f3c04e`): body-shape guards on `/evidence`, `/handoff`, `/drift`, `/verify` and the MCP close handler. No hunk touches a `/steering/*` route. The `/steering/wait` route (now `:2288-2302`) shifted by line count only.
- `packages/mcp-server/src/mcp.ts` (`f0f3c04e`): `reportSilent("railway.write-note", cause)`. Not steering.
- `packages/mcp-server/src/config.ts` (`a46d42c3`): one doc comment reworded. Not steering.
- `packages/mcp-server/src/event.ts` (`a46d42c3`): unreferenced `isPlanningUpdate` removed. Not steering.
- `packages/mcp-server/src/planning/steering-rest.ts` (`a46d42c3`): unreferenced `RestSteeringSession` interface removed (-9 lines above `restDirective`). `restDirective` and `listRestDirectives` are unchanged.
- `packages/mcp-server/src/planning/steering-store.ts` (`a46d42c3`): unreferenced `export const STEERING_AUDIT_TABLE` removed (-1 line). `nextSequence`, `findReplay` and `claimReplay` are unchanged.

A grep over `*.ts`, `*.tsx`, `*.md` and `*.json` (excluding `node_modules`) finds no remaining reference to `RestSteeringSession`, `isPlanningUpdate` or `STEERING_AUDIT_TABLE`.

**Replay and sequence paths: unchanged.** `git diff aef8a351 HEAD` has no hunk in any of these ranges: `planning/steering.ts` (replay and claim `:503-593`, sequence and queue order `:451-480`, `compareDirectives` `:998`), `planning/steering-tools.ts` (`:143-159`), `planning/steering-waiters.ts` (`:63-68`), `index-store.ts` (migration 43 `:912-937`, adapter `:1034`), the `service.ts` steering wiring (`:2001-2053`), and the `server.ts` `/steering/wait` route (`:2288-2302`). In `steering-store.ts` only the unused constant line was removed. The store's claim, sequence and replay code (`:665-730`) is unchanged apart from the one-line shift. In `steering-rest.ts` only the unused interface was removed.

**Covered digest:** the digest moved from `3a7fe63c…322be` to `e0999bab…55e3`, as expected for the seven changed covered files. It was computed at HEAD with `gsd_run query verification.fingerprint .planning/phases/77-steering-idempotency-and-ordering` over the 31 `covered_files` above. The working tree was clean.

**Cited-line refresh:** the prior record cited pre-shift lines in three files. They are updated below: `steering-rest.ts` (-9), `steering-store.ts` (-1), `server.ts` (+16 at the wait route). The code at each cited point is the same.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED | Replay lookup runs after directive schema (`steering.ts:504-505`), key pattern (`:507`), author (`:509`) and allowlist (`:510`), and before duplicate (`:520`), rate (`:522-526`) and audit (`:528-543`): `:512-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !receipt.value.replayed`), wake-up only when `freshlyQueued` (`:159`). Gate r36: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left": pass. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152` (`if (input.idempotency_key === undefined) return queued`). Gate r36: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence" and `steering.test.ts:438` "an unkeyed repeat is a second directive, as before": pass. Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:665-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156` (throws at `:155` when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Gate r36: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" and `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order": pass. |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`), over `queuedFor` sorted by sequence (`steering.ts:456-462`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:98` inside `:88-108`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2302`. Gate r36: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns": pass. Restart: `live-session-restart.pg.test.ts` suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)" (`:162`): 16 pass, 0 failed, 0 skipped. |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (gate r36 named pass; not re-run by the verifier) | Gate r36, suite `steering replay and delivery sequence against PostgreSQL` (file `steering-idempotency.pg.test.ts:36`, `tests="4" failures="0" skipped="0"`), testcase "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" (`steering-idempotency.pg.test.ts:73`): pass, no `<skipped/>`. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937` (version `:913`, down `:917`, `planning_steering_sequence` `:919`, `planning_steering_replay` `:923`, `scope_key` primary key `:924`); Bun adapter `index-store.ts:1034`, `steering-store.ts:663-730` (`nextSequence` `:665-672`, `findReplay` `:679-686`, `claimReplay` `:687-714`, `replayRecord` `:719-730`). |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (gate r36 named passes) | Gate r36, same suite: "a claim whose unit fails keeps no replay record on either instance" (`steering-idempotency.pg.test.ts:93`) pass; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" (`:112`) pass. Also gate r36 `steering-durable.test.ts` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" (`:948`) and "an audit refusal inside the keyed claim holds nothing, so the retry queues once" (`:960`): pass. Code: the keyed path takes the claim with the audit inside it, `steering.ts:546`; `claimKeyed` `:582-593` (an `AuditRefused` is thrown into the unit at `:586` and mapped at `:590`); the store's transaction is `steering-store.ts:688` (`sql.begin`), the claim insert `:690-694`, the audit `queue(tx)` `:704` in the same transaction, and the audit port uses the unit at `:297`. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (gate r36 named pass) | Gate r36, same suite: "two concurrent keyed commands through two instances queue one directive and both get its reply" (`steering-idempotency.pg.test.ts:122`) pass. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:690-694`); a loser reads the winner's row in the same transaction and queues nothing. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged since aef8a351 (`docs/live-steering.md` has no diff). `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` (`steering-tools.ts:178`) reads `recordsFor` (`steering.ts:475-480`), which sorts by `compareDirectives` (`steering.ts:480`, comparator `:998`: priority rank, then `createdAtMs`, then id). Its listed shape `ListedSteeringDirective` (`steering-tools.ts:137`) has no `sequence` field. `GET /steering/directives` (`listRestDirectives`, `steering-rest.ts:138-147`) sorts by `compareDirectives` at `:144`; its body carries `sequence` (`restDirective` `:98`), but the order is priority. The docs_search notice (`steeringNoticeFor`, `steering-delivery.ts:62-70`, "highest priority first, then oldest" at `:53`) is called from `service.ts:4222`. `f0f3c04e` did not change any of these. The sentence in the doc is therefore broader than the pull reads. Decision H5. Excluded from the score. |

**Score:** 7/8 truths verified (T1 to T7). T8 is UNCERTAIN and is excluded from the score. No truth is FAILED.

### Phase fix commit check (G1 to G5)

| Fix | Code at HEAD | Named test | This verifier's result |
| --- | ------------ | ---------- | ---------------------- |
| G1: durable replay and sequence (PG) | `steering-store.ts:665-672`, `:679-714`, `:719-730` | `steering-idempotency.pg.test.ts:73` | Gate r36 JUnit pass (T5). |
| G2: audit row and replay claim in one transaction; refused audit rolls back; lost reply replays | `steering.ts:546`, `:582-593`; `steering-store.ts:688`, `:704`, `:297` | PG `steering-idempotency.pg.test.ts:93`, `:112` (gate r36 pass); memory `steering-durable.test.ts:948`, `:960` (gate r36 pass) | VERIFIED (T6). Error-code surface is H3. |
| G3: one winner per (author, session, key); claim is insert on conflict | `steering-store.ts:690-694`; PK `index-store.ts:924`; scope key `steering.ts:513` | PG `steering-idempotency.pg.test.ts:122` (gate r36 pass) | VERIFIED (T7). |
| G4: wait body carries sequence | `server.ts:2302`; `steering-waiters.ts:63-68` | `server.steering.test.ts:249` (gate r36 pass) | VERIFIED. |
| G5: ordering rule in docs | `docs/live-steering.md:35` | none (docs) | Sentence present. Overstated for pull reads (T8). Not VERIFIED on its own. |

### Required Artifacts

Level 1 and 2 (exists, substantive): all 31 entries of the covered set exist at HEAD and are non-stub. The debt-marker grep (`TBD|FIXME|XXX`) over the implementation files (`planning/steering*.ts`, `service.ts` steering block, `server.ts` steering routes, `index-store.ts` migration 43) returned no match. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` is not applicable and nothing is marked VERIFIED on that basis.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive, unchanged since aef8a351; wired through `service.ts:2001-2053`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive. Changed only by removal of an unused export (`a46d42c3`); exercised by gate r36 `steering-idempotency.pg.test.ts` (4 pass, 0 skipped). |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; unchanged since aef8a351. Migration digest contract passes in gate r36 (`index-store.migrate-contract.test.ts`, 53 pass). Up path reached by the PG file's `migrate()` in gate r36; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:143`, `:150-159`; unchanged since aef8a351. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `restDirective` `:88-108` (`sequence` `:98`); `listRestDirectives` `:138-147`. Unused `RestSteeringSession` removed (`a46d42c3`). |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`; unchanged since aef8a351. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `/steering/wait` `:2288-2302` (`restDirective` `:2302`); no hunk in the steering routes in the change range. |
| `packages/mcp-server/src/service.ts` | steering idempotency wiring and settings; steering emit sites | ✓ VERIFIED | Steering wiring `:2001-2053` (`steeringErrors` `:2001`, `steeringIdempotency()` `:2018`, settings `:2024`, `onQueued` `:2053`), no hunk. Emit sites `:2252-2255` and `:2283-2286` changed to `reportSilent` with the same return value (see Change). |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Gate r36 JUnit: suite `tests="4" failures="0" skipped="0"`. |
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | PG-gated, covered by the phase digest | ✓ VERIFIED (gate r36) | Gate r36 JUnit: suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)" `tests="16" failures="0" skipped="0"`. |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable. Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path exercised by gate r36 `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:2018` and `:2024`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `steering.ts` `onSteeringQueued` hint | `service.ts` `emit` | `SteeringHintAnnouncer` (`service.ts:2058`, `steering-delivery.ts:186`) | WIRED, unaffected | `emit` still returns `.stored`. The `publishHint` bus call (`service.ts:3029-3033`) is fire-and-forget and only logs through `reportSilent` on rejection. `recordSyncLag` ignores `steering.queued` payloads (`corpus/sync-event.ts:20`). |
| `server.ts` `/steering/wait` | `steering-waiters.ts` `nextQueuedDirective` | `restDirective(waited.record, waited.sequence)` | WIRED | `server.ts:2302`; observed by gate r36 `server.steering.test.ts:249`. |
| `steering_list` / `GET /steering/directives` | per-session sequence order | `compareDirectives` | NOT WIRED to sequence | Priority order, not sequence (T8). Open decision H5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `steering-tools.ts` keyed reply | `sequence` | `inbox.sequenceOf` ← `sequences` map ← `replayOf` / `doEnqueue` | Yes (memory store in tests; PG store in gate r36) | ✓ FLOWING |
| `steering-waiters.ts` cursor | `queued[]` | `queuedFor` sorted by sequence | Yes | ✓ FLOWING |
| `steering_list` | priority-ordered records | `recordsFor` | Yes, but order is priority | ⚠️ FLOWING, order disputed (T8) |

### Behavioral Spot-Checks

| Run | Command | Result | Status |
| --- | ------- | ------ | ------ |
| A (gate r36 JUnit, covered files) | Read-only parse of `/root/src/worktrees/backups/gate-r36-junit.xml` (ElementTree) for the 12 covered test files | 373 testcases: event 84, migrate-contract 53, migrate-harness 15, live-session-restart.pg 16, mcp.steering 21, steering-durable 45, steering-idempotency.pg 4, steering-rest 23, steering-tools 21, steering-waiters 21, steering 41, server.steering 29. None has a `failure`, `error` or `skipped` child. Every cited title in this record was checked by exact name, file and line against the source. | ✓ PASS (gate evidence, not re-run) |
| A2 (gate r36 run totals) | `gates-int-r36.log`, `bun test` summary and JUnit header | Suite: 12,315 pass, 0 fail; JUnit: 12,317 testcases, 0 failures, 0 errors, 2 skipped (both outside covered files). `GATES_DONE rc=0`, `PG_READY head=a46d42c3`. | ✓ PASS (gate evidence) |
| B (non-PG targeted run) | none | Not run in this pass (no test runs by assignment). | ? SKIP |
| C (PG, per file) | none | Not run: Postgres not started. T5 to T7 rely on the r36 named passes. | ? SKIP (gate evidence only) |

### Probe Execution

No probes are declared or implied for this phase (no `scripts/*/tests/probe-*.sh` in the PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-H1 | none (no plan claims it) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence | ✗ ORPHANED (open, H5) | `REQUIREMENTS.md:124` unchecked; `:139` status "Human-needed (2026-11-03): 4 of 8 truths verified at 4b84e50c (T1 to T4); T5 to T7 Postgres proofs present and wired, not re-observed; open: T8 per-session ordering rule and HARD-H1 ownership, no plan claims". The text predates this record and is stale (H6). The ownership question is open under H5. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/live-steering.md` | 35 | Ordering sentence is broader than the pull reads deliver | ⚠️ Warning | T8, under H5. |
| `packages/mcp-server/src/planning/steering-store.ts` | 688-714 | Claim unit depends on a transaction; the memory store has none | ℹ️ Info | Stated in PLAN R1 and SUMMARY R1. Memory store is used only in tests and as the default when the audit opt-in is off. |
| `packages/mcp-server/src/index-archive-spec.ts` | 10-22 | The index archive whitelist (`graph_*`, `memory_*`, `corpus_documents`) does not include the `planning_steering_*` tables, including the two that migration 43 adds | ℹ️ Info | Not a phase 77 criterion, and the archive test does not require them. Recorded for the owner; not a gap. |

No `TBD`, `FIXME` or `XXX` markers were found in the phase's implementation files. No debt-marker blocker.

### Human Verification Required

1. **Audit refusal error code (H3)**
   - Test: force an audit refusal inside a keyed Postgres claim through `SteeringInbox` (the `AuditRefused` path, not a thrown error injected into `claimReplay`) and read the reported error code.
   - Expected: the queue is refused as `audit-unavailable`, the claim rolls back, nothing is queued. `lastErrorCode` may show the aborted-transaction code rather than the driver error (`audit()` retry loop, `steering.ts:769-780`, reached through `claimKeyed` `:585`).
   - Why human: `steering-idempotency.pg.test.ts:93` proves the rollback with a thrown error inside the claim unit. Which code the operator sees is an owner decision (H3).

2. **Migration 43 rehearsal**
   - Test: apply migration 43 up and down on a restored rehearsal copy of the database, and walk the steering-audit opt-in steps (33, 34, 43) in `docs/runbooks/rollback-compat.md`.
   - Expected: up and down both apply cleanly; the opt-in steps in the runbook match the migration numbers.
   - Why human: operator migration on a restored database. Gate r36 ran the PG file's `beforeAll` `migrate()` as a named pass, but no one executed the down path or a restored-database rehearsal. This stays open.

3. **Ordering rule and HARD-H1 ownership (H5)**
   - Test: decide either that the pull reads (`steering_list`, `GET /steering/directives`, the docs_search notice) gain sequence order, or that `docs/live-steering.md:35` is narrowed to the wait cursor. Decide HARD-H1 ownership: add it to a plan's `requirements` field, or re-map it with owner approval. State what a number skipped by a refused or lost keyed command means to a reader.
   - Expected: one documented ordering rule that matches the code; HARD-H1 has an owning plan or an approved re-mapping.
   - Why human: `REQUIREMENTS.md:124` is unchecked. Whether a pull read counts as delivery is an owner decision the verifier cannot make.

4. **Stale status text (H6)**
   - Test: reconcile `ROADMAP.md` `### Phase 77` Status (`:1332`) and Plans (`:1342`), and `REQUIREMENTS.md:139`.
   - Expected: the status text matches this record: 7 of 8 truths verified, T5 to T7 named gate passes at a46d42c3, T8 open under H5, status `human_needed`.
   - Why human: planning-document edits are owner or orchestrator work (H6). The verifier does not edit planning docs. `ROADMAP:1332` still reads "human_needed: 4 of 8" and "T5 to T7 ... not verifier-observed"; `REQUIREMENTS:139` still reads "not re-observed".

### Gaps Summary

No truth is FAILED, no artifact is missing or stubbed, and no key link is broken on the phase's own wiring. The change since aef8a351 leaves the replay, claim and sequence code and their tests unchanged. The two steering emit sites changed only in their rejection handler, and they still return `false`. The phase is not complete for three reasons, none of which is a code gap the verifier can close:

- T8 (WARNING): the ordering sentence in `docs/live-steering.md:35` is broader than the pull reads deliver. This is decision H5.
- HARD-H1 ownership is open under H5. No plan claims it.
- Migration 43's down path and restored-database rehearsal were not executed (human item 2). The H3 error-code surface (human item 1) and the stale planning text under H6 (human item 4) are also open.

Post-verification: nothing was committed or edited in the repository. The only file written is this draft, at `/root/src/worktrees/backups/records/77-VERIFICATION.md`.

---

_Verified: 2026-11-06T00:43:37Z_
_Verifier: Claude (gsd-verifier, re-verification pass)_
