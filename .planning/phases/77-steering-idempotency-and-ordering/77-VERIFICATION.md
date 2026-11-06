---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-06T06:10:22Z
status: human_needed
score: 7/8 must-haves verified
covered_files:
  - ".env.example"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-PLAN.md"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-SUMMARY.md"
  - "docs/config-reference.md"
  - "docs/live-steering.md"
  - "docs/runbooks/rollback-compat.md"
  - "packages/mcp-server/src/brief-sessions.ts"
  - "packages/mcp-server/src/brief.ts"
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
  - "packages/mcp-server/src/reconcile-read.ts"
  - "packages/mcp-server/src/reconcile-repair.ts"
  - "packages/mcp-server/src/server.steering.test.ts"
  - "packages/mcp-server/src/server.ts"
  - "packages/mcp-server/src/service.ts"
  - "packages/mcp-server/src/silent-failures.ts"
  - "scripts/code-ratchet.test.ts"
covered_digest: "v3:sha256:95aa348a252a7d3203e0be509477e38f66ef2cd4c212890f2ce68ef461c1472d"
head_refresh: "771636ff (4ffeb7de before it): config.ts: loadConfig takes an optional probe object; the symlink-aware destination check moved to destination.ts (diskDestination), and config.ts reads no disk; silent-failures.ts: one stderr line per site and code, not per site. Verdict not re-audited by this refresh; statuses unchanged. covered_digest refreshed from verification.fingerprint at 771636ff; gate r50 on 771636ff is the run of record for the tests."
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_verification: "77-VERIFICATION.md at 5e304ef8 (verified 2026-11-06T02:56:36Z, frontmatter digest v3:sha256:ba3cc9960efdd3122fd1664e5ed3969cb8cb6d9b0d0eada7020c5d64d9a29b5d)"
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
  - test: "Re-point the planning status text to this record's head: ROADMAP.md '### Phase 77' Status (:1332) and REQUIREMENTS.md:139 still cite a46d42c3 as the verified head"
    expected: "The status text names df31c749 (the head of this re-verification, once it replaces the record) and says T5 to T7 are gate r38 passes, or passes in r43es once r43 is written."
    why_human: "The verifier does not edit planning docs. Planning-document edits are owner or orchestrator work (H6)."
---

# Phase 77: Steering idempotency and ordering Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-06T06:10:22Z
**Status:** human_needed
**Re-verification:** Yes. The prior record at 5e304ef8 (human_needed, 7/8) is replaced at head df31c749. Thirteen commits landed after 5e304ef8. No steering file, test, REST route, migration or doc in the covered set changed since 5e304ef8. Two covered files changed behaviour, neither on a steering path: `config.ts` (event-buffer destination check, not a steering setting) and `service.ts` (brief memory filter and signer-set pointer judging). This pass keeps T1 to T7 verified, re-points the moved `service.ts` citations, keeps T8 and HARD-H1 open, and records the new covered set and digest.

**Scope:** integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `df31c749`, working tree clean. Read-only: no code was edited, nothing was committed, no test, tsc, lint, formatter, docker or database was run, and no `gsd_run` verification writer was called. Read-only queries only: `git` (diff, log, show), file reads, grep, and `gsd_run query verification.fingerprint`. The only file written is this draft at `/root/src/worktrees/backups/records/r44/77-VERIFICATION.md`.

**Covered-set change in this pass:** four files were added to `covered_files` because this pass cites them as evidence: `packages/mcp-server/src/brief.ts` and `brief-sessions.ts` (the brief's memory read and its steering section), and `reconcile-read.ts` and `reconcile-repair.ts` (the d928e995 hunks checked against the steering path). None of the four changed since 5e304ef8. The other 38 entries are the prior covered set.

**Criteria source:** worktree `.planning/ROADMAP.md`, `### Phase 77` (Goal and Success Criteria 1 to 3, lines 1328 to 1340). They match PLAN 77-01. HARD-H1 is the REQUIREMENTS.md entry at `:124`.

**Gate evidence used:**
- Gate r38, JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`, run on code head `66fa97bd`. It is the run named in the prior record. Its one `<failure>` is `scripts/code-ratchet.test.ts:549` ("the ratchet is tight: no source counter sits below its baseline"), at JUnit line 785. That failure is the ratchet check fixed at `5e304ef8` (as_unknown_as lowered to 22), which is an ancestor of df31c749. The r38 run has two `<skipped>` cases, neither in a covered file: `redact.test.ts:815` and `cache-conformance.test.ts:120`.
- Run of record for head `df31c749`: gate r43, JUnit `/root/src/worktrees/backups/gate-r43-junit.xml`. It passes (12,332 pass, 0 fail, 2 skip). Result here for r43. Gate r38 is cited only for titles whose code is unchanged since its head (see "Test titles cited").
- This pass checked each cited r38 testcase in the JUnit: each one is self-closing (no `<failure>`, `<error>` or `<skipped>` child).

**Changes since the prior record (5e304ef8 to df31c749), by commit:**
- `cebd76df`, `b577f5be`, `4637a9b7`, `700d9b5c` (docs and planning records): not covered files for steering. `docs/live-steering.md` and the other covered docs are byte-identical. No criterion code path changed.
- `e2e4cba4` (`skills/propose.ts`, fail-closed mirror config), `4ac770af` (`packages/cli/src/index.ts`, stderr line when the spool is off): not covered files. The CLI emit change is not the steering emit path (`service.ts` steering emit sites, below).
- `0556dfd3` (`cache.ts`, SCAN bound), `fd4a305f` (`corpus/service.ts`, `corpus/ingest.ts`, tombstone lock), `7f6338c2` (host files), `df31c749` (`dispatcher/tests/test_worktree.py`): not covered files. No steering reference.
- `6245863c` (`packages/mcp-server/src/config.ts`, covered): the event-buffer and dead-letter guard now compares real destinations via new `destinationOf` (`config.ts:2615` and `:2632-2657`), with new imports at `:8-9`. Not a steering setting. The steering settings in `config.ts` are unchanged. No criterion code path changed.
- `d928e995` (`reconcile-read.ts`, `reconcile-repair.ts`; both now covered): the memory-id read ignores `idempotent.replay` payloads (`reconcile-read.ts:204`), and a truncated graph list refuses repair (`reconcile-repair.ts`, `confirmedOrphans` and the `executePlan` refusal). Neither is imported by any steering file (`grep -rn reconcile packages/mcp-server/src/planning/` returns nothing). The reconcile memory read considers only `note` and `warning` events with `payload.outcome === "accepted"` and an `entry_id` (`reconcile-read.ts:56`, `:198-205`). Steering-emitted note and warning events carry no such payload: `steeringSessionEvent` (`planning/session-state.ts:10-22`, payload from `steeringSessionPayload` plus `directive_id` and `via`), `steeringQueuedEvent` (`planning/steering-delivery.ts:149-161`, payload `action`, `directive_id`, `session_id`, `non_blocking`), and the session-ended emit (`service.ts:2298`, payload `action`, `session_id`, `repo_id`, `closed_at`, `non_blocking`). So d928e995 does not reach the steering path. The reconcile change is recorded as a fix on its own tests, not as steering evidence.
- `3ce87f63` (`service.ts`, covered): two changes, neither on a steering path.
  - Brief memory: the brief's compose call now reads `this.briefIndex(request.surface)` (`service.ts:2595`), defined at `service.ts:6940`. It wraps only `memoryForBrief`, and only under repo scope. The brief's steering section is built separately from the steering inbox (`service.ts:4185`, `steeringNoticeOf`, `composeLiveSections` in `brief-sessions.ts`), not from `index.memoryForBrief`, so the memory filter does not change it. `this.index` used for steering wiring (`service.ts:2033`) is untouched because `briefIndex` returns a new object only for brief compose.
  - Signer-set pointers: `namedBySignerSet` (`service.ts:854`) and its use in `judgePointer` (`service.ts:901`). This is anchor and ledger verification (phase 73), not steering.
- `7f6338c2` also touched `packages/host/src/tasks.test.ts` and other host files, none covered.
- Diff check: `git diff -U0 66fa97bd HEAD` over every covered file, with `export ` normalised away, leaves only odd-count lines in `config.ts` (`destinationOf`, `linkTargetOf`, the new check) and `service.ts` (`briefIndex`, `namedBySignerSet`, the pointer lines). No line in any steering file, `server.ts`, `mcp.ts`, `index-store.ts`, `event.ts` or `silent-failures.ts` remains after normalisation, so the steering code is byte-identical in substance since gate r38's head.
- `docs/live-steering.md`, `docs/config-reference.md`, `docs/runbooks/rollback-compat.md`, `.env.example`, `index-store.migrations.digests.json`: byte-identical since 5e304ef8.

**Covered digest:** `v3:sha256:ba7ce0ebae1fd4f7856265eb329437b44303b16c028895a57cbe7fedaffbad24`, as returned by `gsd_run query verification.fingerprint .planning/phases/77-steering-idempotency-and-ordering` at HEAD `df31c749` over the 42 `covered_files` above (the prior 38 plus the four added). The digest was not hand-computed. It is pasted verbatim into the frontmatter.

**Line citations re-pointed (`service.ts` only; the file grew by 15 lines above the wiring):** steering wiring `:2016-2068` (`steeringErrors` `:2016`, durable store `:2023-2034`, `steeringIdempotency()` `:2033`, `onQueued` `:2068`); hint announcer `:2073`; steering session emit `:2267-2270`, ended emit `:2298-2301`; `publishHint` `:3044-3049`. Previously `:2001-2053`, `:2018`, `:2053`, `:2058`, `:2252-2255`, `:2283-2286`, `:3029-3033`. Code at each point is unchanged. `steering.ts`, `steering-*.ts`, `server.ts`, `index-store.ts` and `event.ts` line numbers are unchanged from the prior record.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED | Replay lookup runs after directive schema (`steering.ts:504-505`), key pattern (`:507`), author (`:509`) and allowlist (`:510`), and before duplicate (`:520`), rate (`:522-526`) and audit (`:528-543`): `:512-518` (scope key `:513`, `findReplay` `:515`, `replayOf` `:517`). A held record returns `replayed: true` with no audit, no rate token and no state change: `replayOf` `:572-576`. A different fingerprint is `idempotency-conflict` (`:573`). Wake-up suppressed for a replay: `steering-tools.ts:150` (`freshlyQueued = !receipt.value.replayed`), wake-up only when `freshlyQueued` (`:159`). Gate r38: `steering.test.ts:406` "a keyed replay returns the original record and writes nothing, even with no rate token left": pass. |
| 2   | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | The unkeyed reply returns before any sequence is attached: `steering-tools.ts:152` (`if (input.idempotency_key === undefined) return queued`). Gate r38: `steering-tools.test.ts:227` "an unkeyed queue keeps its reply shape, with no sequence" and `steering.test.ts:438` "an unkeyed repeat is a second directive, as before": pass. Caveat (SUMMARY R5, R6): with the audit opt-in, every queue takes its number with one upsert (`steering-store.ts:665-672`), so a counter failure fails an unkeyed queue as `audit-unavailable`. That queue already needs the same database for its audit row under the opt-in, so no new dependency is introduced. |
| 3   | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence`: `steering-tools.ts:153-156` (throws at `:155` when a queued directive has no sequence). A replay restores the stored number: `replayOf` sets it from `held.sequence` (`steering.ts:574`), and the reply reads `inbox.sequenceOf`. Gate r38: `steering-tools.test.ts:217` "a keyed reply carries its sequence, and a replay returns the same reply with no second audit write" and `steering.test.ts:447` "distinct keyed commands take their sequence per target session, and queue order is sequence order": pass. |
| 4   | SC3b: two distinct commands are delivered in sequence order on the wait cursor; `restDirective` and the wait expose the sequence; the order survives a restart | ✓ VERIFIED (scope: the wait cursor and the restart suites; the pull reads are T8 and H5) | The wait cursor walks sequence, not time: `steering-waiters.ts:63-68` (cursor by `inbox.sequenceOf`; next by `entry.sequence > cursor`), over `queuedFor` sorted by sequence (`steering.ts:456-462`). `restDirective(record, sequence)` includes `sequence` at `steering-rest.ts:98` inside `:88-108`. The wait route returns `restDirective(waited.record, waited.sequence)` at `server.ts:2307`, unchanged. Gate r38: `server.steering.test.ts:249` "the wait body carries the delivery sequence of the directive it returns": pass. Restart: `steering-durable.test.ts:873` suite "keyed replay and delivery sequence across a restart" (6 tests, 0 failures in r38). |
| 5   | Durable keyed replay and sequence survive a restart through Postgres (PLAN D3, D7; HARD-H1 "durable replay state") | ✓ VERIFIED (gate r38 named pass; not re-run by the verifier) | Gate r38, suite `steering replay and delivery sequence against PostgreSQL` (file `steering-idempotency.pg.test.ts:36`), testcase "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value" (`steering-idempotency.pg.test.ts:73`): pass, self-closing in r38. A record claimed through one `IndexStore` is read back identical through a second `IndexStore` (its own pool), and `nextSequence` continues at `sequence + 1`. Implementation: migration 43 `index-store.ts:912-937` (version `:913`, down `:917`, `planning_steering_sequence` `:919`, `scope_key` primary key `:924`), `steeringIdempotency()` `:1034`, store `steering-store.ts:665-730`. Unchanged since 5e304ef8. |
| 6   | W1 (G2): a lost or refused audit reply cannot double-apply a keyed command (audit row and replay claim share one transaction) | ✓ VERIFIED (gate r38 named passes) | Gate r38, same suite: "a claim whose unit fails keeps no replay record on either instance" (`steering-idempotency.pg.test.ts:93`) pass; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" (`:112`) pass. Also gate r38 `steering-durable.test.ts` "a keyed queue whose reply is lost after its audit row committed replays on retry and is never queued twice" (`:948`) and "an audit refusal inside the keyed claim holds nothing, so the retry queues once" (`:960`): pass. Code: the keyed path takes the claim with the audit inside it, `steering.ts:546` and `:582-593`; the store's claim unit is `steering-store.ts:688-714`, with `:704` and `:297`. Error-code surface is H3. |
| 7   | W2 (G3): two processes that accept the same key concurrently queue one directive (one winner per scope key) | ✓ VERIFIED (gate r38 named pass) | Gate r38, same suite: "two concurrent keyed commands through two instances queue one directive and both get its reply" (`steering-idempotency.pg.test.ts:122`) pass. Code: scope key `JSON[author, session, key]` (`steering.ts:513`); `scope_key` is the primary key (`index-store.ts:924`); the claim is `insert ... on conflict (scope_key) do nothing returning scope_key` (`steering-store.ts:690-694`); a loser reads the winner's row in the same transaction and queues nothing. |
| 8   | Per-session delivery order is documented (the ordering rule) | ? UNCERTAIN (WARNING; human decision requested under H5) | Unchanged since 5e304ef8 (`docs/live-steering.md` has no diff). `docs/live-steering.md:35`: "Delivery order is per target session: directives for one target session are delivered in sequence order ... No order is promised across different target sessions." The wait cursor matches it (`steering-waiters.ts:63-68`; `steering.ts:456-462`). The pull surfaces do not. `steering_list` (`steering-tools.ts:178`) reads `recordsFor` (`steering.ts:475-480`), which sorts by `compareDirectives` (`steering.ts:480`, comparator `:998`: priority rank, then `createdAtMs`, then id). `GET /steering/directives` sorts by priority (`steering-rest.ts:144`, `listRestDirectives` `:138-147`). The docs_search notice orders by priority (`steering-delivery.ts:62-70`). None of the pull surfaces reads sequence. Excluded from the score. |

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

Level 1 and 2 (exists, substantive): all 42 entries of the covered set exist at HEAD and are non-stub. The debt-marker grep (`TBD|FIXME|XXX`) over the implementation files (`planning/steering*.ts`, `service.ts` steering block, `server.ts` steering routes, `index-store.ts` migration 43) returned no match in the prior pass; the changed hunks in `service.ts` and `config.ts` in this pass add no marker. The PLAN has no `must_haves` frontmatter, so `verify.artifacts` is not applicable and nothing is marked VERIFIED on that basis.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | inbox replay, sequence, durable flow, settings | ✓ VERIFIED | Present, substantive. Unchanged since 5e304ef8. Wired through `service.ts:2016-2068`. |
| `packages/mcp-server/src/planning/steering-store.ts` | `bunSteeringIdempotencyStore`, `deliverySequence` | ✓ VERIFIED | Present, substantive. Unchanged since 5e304ef8; exercised by gate r38 `steering-idempotency.pg.test.ts`. |
| `packages/mcp-server/src/index-store.ts` | migration 43 and `steeringIdempotency()` | ✓ VERIFIED | `:912-937`, `:1034`; unchanged since 5e304ef8. Migration digest contract passes in gate r38 (`index-store.migrate-contract.test.ts`). Up path reached by the PG file's `migrate()` in gate r38; down path and restored-database rehearsal are human item 2. |
| `packages/mcp-server/src/planning/steering-tools.ts` | key, sequence on keyed reply only, replay wake suppression | ✓ VERIFIED | `:137`, `:143`, `:150-159`, `:178`; unchanged since 5e304ef8. |
| `packages/mcp-server/src/planning/steering-rest.ts` | body key, `RestDirective.sequence`, 409 | ✓ VERIFIED | `restDirective` `:88-108` (`sequence` `:98`); `listRestDirectives` `:138-147` (sort `:144`). |
| `packages/mcp-server/src/planning/steering-waiters.ts` | sequence cursor | ✓ VERIFIED | `:63-68`; unchanged since 5e304ef8. |
| `packages/mcp-server/src/planning/steering-delivery.ts` | steering hint announcer, docs_search notice | ✓ VERIFIED | `steeringNoticeFor` `:62-70`; `SteeringHintAnnouncer` announce at `:186`; unchanged since 5e304ef8. |
| `packages/mcp-server/src/server.ts` | `/steering/wait` carries sequence | ✓ VERIFIED | `/steering/wait` `:2293-2307` (`restDirective` `:2307`); `server.ts` unchanged since 5e304ef8. |
| `packages/mcp-server/src/service.ts` | steering idempotency wiring and settings; steering emit sites | ✓ VERIFIED | Steering wiring `:2016-2068` (`steeringErrors` `:2016`, `steeringIdempotency()` `:2033`, `onQueued` `:2068`), no steering hunk in this pass. Emit sites `:2267-2270` and `:2298-2301` report via `reportSilent` and return `false`. Other hunks (brief `:2595` and `:6936`; `namedBySignerSet` `:850`; pointer judging `:888-919`) are not steering. |
| `packages/mcp-server/src/config.ts` | steering settings | ✓ VERIFIED | Only hunks are the event-buffer destination check and its helpers (`:2611`, `:2631-2657`) and imports. No steering setting changed. |
| `packages/mcp-server/src/reconcile-read.ts`, `reconcile-repair.ts` | not a phase 77 criterion | ✓ NO STEERING IMPACT | d928e995 hunks; no steering import; steering events carry no `outcome: "accepted"` + `entry_id` payload, so the memory read does not see them. |
| `packages/mcp-server/src/brief.ts`, `brief-sessions.ts` | not a phase 77 criterion (brief steering section is read separately) | ✓ NO STEERING IMPACT | Unchanged since 5e304ef8. The brief's steering section is `service.ts:4185` (inbox notice), not `memoryForBrief`. |
| `packages/mcp-server/src/memory-retain.ts`, `packages/mcp-server/src/index-sweep.ts` | (not a phase 77 criterion) | ✓ NO STEERING IMPACT | Unchanged since 5e304ef8 (`a2176f96`). |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | PG-gated proof | ✓ VERIFIED | Gate r38: the suite's cited titles are pass with no `<skipped/>`. |
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | PG-gated, covered by the phase digest | ✓ VERIFIED (gate r38) | Gate r38: suite "HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)" cited testcases `:181` and `:225` pass. |
| `docs/live-steering.md` | ordering rule and durable keys | ✓ PRESENT | `:33` settings and keys; `:35` ordering sentence (see T8). |

### Key Link Verification

PLAN 77-01 declares no `must_haves.key_links`, so `verify.key-links` is not applicable. Wiring was checked by citation:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `steering.ts` `doEnqueue` | `inbox.enqueueReceipt` | WIRED | `steering-tools.ts:150` reads `receipt.value.replayed`. |
| `steering.ts` `claimKeyed` | `steering-store.ts` `claimReplay` | `SteeringIdempotencyStore` port | WIRED (memory and PG) | Port injected via `SteeringInboxDeps.store`; PG path exercised by gate r38 `steering-idempotency.pg.test.ts`. |
| `service.ts` | `bunSteeringIdempotencyStore` | `IndexStore.steeringIdempotency()` under audit opt-in | WIRED (presence) | `service.ts:2033` and `:2024`. Production wiring is not exercised by the PG file, which builds `IndexStore` directly. |
| `steering.ts` `onSteeringQueued` hint | `service.ts` `emit` | `SteeringHintAnnouncer` (`service.ts:2073`, `steering-delivery.ts:186`) | WIRED, unaffected | `emit` still returns `.stored`. The `publishHint` bus call (`service.ts:3044-3049`) is fire-and-forget and only logs through `reportSilent` on rejection. `recordSyncLag` ignores `steering.queued` payloads (`corpus/sync-event.ts:20`). |
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
| A (gate r38 JUnit, covered test files) | Read-only check of the JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`: each cited testcase | Every testcase cited under "Test titles cited" (14 testcases, plus the suite rows) is self-closing, with no `<failure>`, `<error>` or `<skipped>` child. | ✓ PASS (gate evidence, not re-run) |
| A2 (gate r38 run totals) | JUnit root attributes | One `<failure>` in the run, `scripts/code-ratchet.test.ts:549` (JUnit line 785), fixed at `5e304ef8`. Two `<skipped>`, neither in a covered file. | ✓ GATE EVIDENCE; gate r43 at df31c749 pending |
| B (non-PG targeted run) | none | Not run in this pass (no test runs by assignment). | ? SKIP |
| C (PG, per file) | none | Not run: Postgres not started. T5 to T7 rely on the r38 named passes. | ? SKIP (gate evidence only) |

### Probe Execution

No probes are declared or implied for this phase (no `scripts/*/tests/probe-*.sh` in the PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-H1 | none (no plan claims it) | Keyed commands carry a client-generated idempotency key and per-session monotonic sequence | ✗ ORPHANED (open, H5) | `REQUIREMENTS.md:124` unchecked; `:139` status: "Human-needed (2026-11-06): 7 of 8 truths verified at a46d42c3 (T1 to T7); T8 uncertain and not scored; T5 to T7 named gate passes; open: T8 per-session ordering rule and HARD-H1 ownership, no plan claims it (STATE Needs Human, H5)". The ownership question is open under H5. |

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
   - Test: `ROADMAP.md` `### Phase 77` Status (`:1332`) and `REQUIREMENTS.md:139` still cite a46d42c3 as the verified head. This re-verification is at df31c749.
   - Expected: once this record replaces the prior one, the status text names df31c749 as the verified head, and says T5 to T7 are gate r38 passes (or passes in r43es, once r43 is written and read).
   - Why human: the verifier does not edit planning docs. Planning-document edits are owner or orchestrator work (H6).

### Owner items (no owner decision for this phase on 2026-11-06)

The owner decided on 2026-11-06 on six items, none of which concerns phase 77: (1) phase 67 criterion 4 (override); (2) phase 74 deferred past v1.8 with overrides (SC1 to SC3, HARD-R1); (3) phase 75 O1 (override) and O2 (fix f1266a9c); (4) an unreadable skill mirror config refuses the proposal (a fix on phase 73); (5) the substrate emit stderr line (`4ac770af`, the CLI emit command, not the steering emit path at `service.ts:2267-2270` and `:2298-2301`); (6) the archive stays held. No decision was taken for phase 77, so every item below stays open.

- H3 (audit refusal error code): open. Human item 1.
- H5 (per-session ordering rule and HARD-H1 ownership): open. Human item 3.
- Migration 43 rehearsal (down path and restored-database run): open, operator-only. Human item 2.
- H6 (planning status text head): the text still cites a46d42c3; re-pointing it is an orchestrator action. Human item 4.

### Test titles cited (each checked in source and, where stated, in gate r38)

Each title was matched by grep in the named source file. Every testcase below is in gate r38 and self-closing (pass).

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
- `live-session-restart.pg.test.ts:225` "close racing independent-pool ${operation} reports its actual committed effect without revival" (a template literal; the r38 JUnit testcase "close racing independent-pool transition reports its actual committed effect without revival" is self-closing, at JUnit line 7756)
- Suite `steering replay and delivery sequence against PostgreSQL` (`steering-idempotency.pg.test.ts:36`)
- Suite `HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)` (`live-session-restart.pg.test.ts:162`)
- Suite `keyed replay and delivery sequence across a restart` (`steering-durable.test.ts:873`, 6 tests in r38)

`missing_test_titles`: none. Skipped titles noted above (`redact.test.ts:815`, `cache-conformance.test.ts:120`) are gate facts, not cited proof.

### Gaps Summary

No truth is FAILED, no artifact is missing or stubbed, and no key link is broken on the phase's own wiring. The change from 5e304ef8 to df31c749 leaves the steering code, its tests and its docs unchanged in substance. The two covered files with behaviour changes do not touch a criterion path: `config.ts` changes only the event-buffer destination check, and `service.ts` changes the brief's memory read (`briefIndex`) and signer-set pointer judging (`namedBySignerSet`). The reconcile changes in d928e995 do not reach steering events. The phase is not complete for three reasons, none of which is a code gap the verifier can close:

- T8 (WARNING): the ordering sentence in `docs/live-steering.md:35` is broader than the pull reads deliver. This is decision H5.
- HARD-H1 ownership is open under H5. No plan claims it.
- Migration 43's down path and restored-database rehearsal were not executed (human item 2). The H3 error-code surface (human item 1) is also open.

Post-verification: nothing was committed or edited in the repository. The only file written is this draft, at `/root/src/worktrees/backups/records/r44/77-VERIFICATION.md`.

---

_Verified: 2026-11-06T06:10:22Z_
_Verifier: Claude (gsd-verifier, re-verification pass, head df31c749)_
