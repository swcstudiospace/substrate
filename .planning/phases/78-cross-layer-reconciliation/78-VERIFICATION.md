---
phase: 78-cross-layer-reconciliation
verified: 2026-11-03T16:04:28Z
status: human_needed
score: "1/2 must-haves verified; SC1 verified in code and by named tests (live cadence and single-flight are human items); SC2 UNCERTAIN (WARNING): post-flush audit placement owner-ratified; unreadable-plan audit gap (7c) and counter-cut test gap (8) stay open; 4 live proofs human_needed"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 4b84e50c"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (ROADMAP.md:1352-1355)"
covered_files: [".planning/REQUIREMENTS.md", ".planning/ROADMAP.md", ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/mcp-audit.md", "docs/reconcile.md", "docs/runbooks/corpus-sync.md", "packages/audit/src/log.ts", "packages/audit/src/policy.ts", "packages/cli/src/capsule.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/lease.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/types.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:c29234d6402655a693493506b2ff679b9da2d1b0ea83f2c4ffd716513614760c"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at HEAD 8a604455: human_needed, 1/2, SC2 UNCERTAIN (unreadable-plan audit gap 7c; counter-cut test gap 8; set-but-unwritable chain test gap 9; post-flush append test gap 17; single-flight test gap; operator items 1 to 4; HARD-H2 ORPHANED)"
  selection: "Step 0: the prior record has no top-level gaps: key, so initial mode. The prior record is the checklist of claims and carried residuals."
  changed_since_previous: "Commit 4b84e50c only (one commit, 8 files). No phase 78 module changed: reconcile.ts, reconcile-read.ts, reconcile-run.ts, reconcile-repair.ts, reconcile-main.ts and their tests, scripts/reconcile.ts, cache.ts, server.ts, corpus/*.ts, packages/audit, packages/corpus, docs/reconcile.md, docs/mcp-audit.md, docs/runbooks/corpus-sync.md, REQUIREMENTS.md, ROADMAP.md, event.ts, lease.ts, mcp.ts (git diff 8a604455..4b84e50c is empty on all of them). Changed: index-store.ts (memorySearch agentRepo and memoryForBrief repo, 2 lines), memory-policy.ts, memory-write.ts (row repo), service.ts (four one-line repo comparisons at 8a604455 lines 2501, 3647, 3735, 4592; none at the chain-tip, write-refusal, claim, release or tick lines), session-context.ts, types.ts (doc comment), packages/cli/src/capsule.ts, memory-policy.test.ts (new regression test)."
  gaps_closed: []
  gaps_remaining:
    - "Unreadable plan writes no audit record (warning 7c): reconcile-main.ts:246-247 returns 1 before executePlan (:251) and recordRepair (:260). Code gap, untested. Unchanged."
    - "Counter-cut refusal untested (warning 8): reconcile-repair.test.ts has no counter-cut test; :424 is the answer-cut case. Unchanged."
    - "Set-but-unwritable chain path untested (warning 9). Unchanged."
    - "Post-flush append failure untested (warning 17): reconcile-main.ts:270-273. Unchanged."
    - "Single-flight guard untested (behavior-unverified item): service.test.ts:6428 is the only reconcileTick call, a single call. Unchanged."
    - "Operator items 1 to 4, including the R8 live proof that the server is stopped. Not run in this pass."
    - "HARD-H2 ORPHANED in REQUIREMENTS.md (warning 13): :125 unticked, :140 'Not started'. Unchanged at 4b84e50c."
    - "Protocol constant comment (warning 16): packages/corpus/src/protocol.ts:261 still describes a per-list bound. Unchanged."
  gaps_new: []
  regressions: []
  corrections: "The 8a604455 record cited service.ts:3012 (chain-tip normalizeKey), :3090-3092 (assertWriteTextFields) and :4168 (startReconcile). The 8a604455 and 4b84e50c blobs have them at :3014, :3093 and :4182 (setInterval :4185, reconcileTick :4199-4201, runScheduledReconcile :4207). Code unchanged; citations corrected here."
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4199-4201, reconcilePass ??=)"
    test: "Start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture. Start a second tick while the first is in flight (or force one with a slow ledger read)"
    expected: "Exactly one run is in flight. The second tick returns the in-flight promise and writes no second line. Neither run writes to the ledger, the index or the cache"
    why_human: "No test covers the guard. The interval cadence is real time and no test fires setInterval. The only reconcileTick call in the tests is a single call (service.test.ts:6428). This is an ordering invariant that presence and wiring cannot show"
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval cadence is real time and no test fires the interval. The single-flight guard has no test"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run); then repair --plan <file> --execute --server-stopped; then a second execute. If the bound cut into the counter pass, plan again and repair again"
    expected: "The dry run writes nothing and its reason states the one-run split. The execute removes at most 500 keys: answers first, then generation counters, then the forget mark; budget: and emb: keys are kept. <plan>.result.json holds planned, removed, remaining, limit and truncated. One audit record is appended with outcome, counts and plan_digest. A prefix above 1000000 keys refuses with nothing removed"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores and a real audit file: report; repair --plan <file> --execute without --server-stopped (exit 2); repair --plan <file> --execute --server-stopped without SUBSTRATE_AUDIT_PATH (exit 2, nothing flushed); the execute with SUBSTRATE_AUDIT_PATH set; then restart substrate-mcp and verify the audit chain"
    expected: "Exit codes match docs/reconcile.md:66-68. The chain verifies after the restart, with the repair record in place and a continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest"
    why_human: "Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence that the owner's second-writer approval depends on, and of the R8 operator assertion (that the server is in fact stopped)"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-03T16:04:28Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 8a604455. Step 0 selected initial mode (no `gaps:` key); the prior record is the checklist of claims and carried residuals.
**Scope:** integration tree at HEAD 4b84e50c, branch gsd/v18-int-all. Procedure: gsd-verifier, goal-backward. Focus as assigned: re-verify phase 78 at 4b84e50c, keeping every open item open. No code edits, no commits, no full suite, no tsc, lint or formatters. One targeted `bun test` command. Only this file was written, in the worktree.

## Requested checks

| Check | Verdict | Evidence at 4b84e50c |
| ----- | ------- | -------------------- |
| Commit 4b84e50c leaves the reconcile path unchanged | PASS | `git diff 8a604455..4b84e50c` is empty on every phase 78 module: `reconcile.ts`, `reconcile-read.ts`, `reconcile-run.ts`, `reconcile-repair.ts`, `reconcile-main.ts` and their tests, `scripts/reconcile.ts`, `cache.ts`, `server.ts`, `corpus/*.ts`, `event.ts`, `lease.ts`, `mcp.ts`, `packages/audit`, `packages/corpus`, the three phase 78 docs, `REQUIREMENTS.md`, `ROADMAP.md`. The 4b84e50c hunks are at `index-store.ts` (memorySearch and memoryForBrief repo), `memory-policy.ts`, `memory-write.ts`, `service.ts` (four repo lines), `session-context.ts`, `types.ts` (doc) and `capsule.ts` (CLI repo filter) |
| Reconcile session handling unchanged for ordinary ids | PASS | `reconcile-read.ts:122` reads the ledger hold's `session_id` as stored; `reconcile-read.ts:224` reads the index's `claim_session` as stored. Neither applies a normalizer. The write side is still `normalizeKey` at `event.ts:401`, unchanged since 8a604455. For an ordinary id `normalizeKey(x) === normalizeIdentifier(x) === x` (`event.ts:207-217`) |
| Reconcile repo handling | PASS (no repo key on the reconcile path) | Zero whole-word `repo`, `repo_id` or `repoId` identifiers in `reconcile*.ts` and `scripts/reconcile.ts`. The lease, memory and generation comparisons key on graph/node, entry id and `gen:graph:<id>`. The 4b84e50c repo changes therefore cannot reach a reconcile comparison |
| Memory readers | PASS | `reconcile-read.ts:233` calls `index.reconcileMemoryIds(sinceIso, cap)` (`index-store.ts:2950`), which is not one of the changed hunks (changed hunks are at `:2650` and `:2682`). The memory comparison is by entry id (`reconcile.ts` `compareMemory`) |
| Corpus repo key | PASS (unchanged) | The corpus delete and reconcile key is `(repo, path)` (`corpus/reconcile.ts:62`, `:98-102`, `:192`). `corpus/*.ts` is unchanged in the range. The 4b84e50c repo spelling change does not reach the corpus repair path |
| Write path for ordinary ids | PASS | `service.ts:3014` is the sessioned chain-tip lookup on `normalizeKey` (unchanged). `service.ts:3093` calls `assertWriteTextFields(input)` before the replay lookup and the chain tip. `event.ts:277` refuses only lone surrogates, on raw input |
| Regression test for the 4b84e50c repo fix | PASS (by test) | `memory-policy.test.ts:359` ("a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo") is in the targeted run below and passes |
| Unreadable-plan audit gap (7c) | OPEN | `reconcile-main.ts:246-247` writes `refused:` to stderr and returns 1 before `executePlan` (`:251`) and `recordRepair` (`:260`). No audit record, no flush. Unchanged. Untested |
| Counter-cut test gap (8) | OPEN | `reconcile-repair.test.ts` test names: `:126` digest mismatch, `:169` removal order, `:230` answer-pass failure, `:249` counter-pass failure, `:271` mark-pass failure, `:424` second run after the answer cut. No counter-cut refusal test |
| Single-flight (behavior-unverified item) | OPEN | `service.test.ts:6428` is the only `reconcileTick` call in the tests, a single call. The `??=` guard (`service.ts:4200`) has no concurrent test |
| Post-flush append failure (17) | OPEN | No test for `reconcile-main.ts:270-273`. `reconcile-main.test.ts` names: `:106` flush failure, `:176` one record, `:199` no durable chain, `:159` and `:168` usage refusals |
| Set-but-unwritable chain path (9) | OPEN | No test. Only the unset path is covered (`reconcile-main.test.ts:199`) |
| Operator items (live proofs 1 to 4) | OPEN | Human items below. None run in this pass |
| HARD-H2 | OPEN, ORPHANED | `.planning/REQUIREMENTS.md:125` unticked; `:140` "Not started". Unchanged in the range |

**Reading.** On the session, repo and memory axes, 4b84e50c changes nothing that phase 78 reads or writes. The reconcile readers take stored values as stored. The 4b84e50c repo change is an access-control fix in the memory and recall paths, and it does not touch any reconcile comparison. SC2 stays UNCERTAIN because of 7c and the test gaps, not because of this commit. The status stays `human_needed` because of the four live proofs and the single-flight item.

## Session handling: what 4b84e50c changes, and what it does not

1. **Write side (unchanged in 4b84e50c).** `normalizeEvent` stores `session_id` as `normalizeKey(input.session_id)` (`event.ts:401`) and `repo` as `normalizeKey(input.repo)` (`event.ts:407`). `node_id` is `normalizeIdentifier` (`event.ts:403`). `service.ts:3014` looks up the chain tip with the same `normalizeKey`.
2. **Read side (unchanged).** `reconcile-read.ts:122` and `:224` read stored values verbatim.
3. **Access side (changed by 4b84e50c, not on the reconcile path).** Memory and recall repo comparisons moved from `normalizeKey` to `normalizeIdentifier` on both sides. The reconcile comparators do not read those comparisons, so the change is outside SC1 and SC2.
4. **Lease claim path (pre-existing split, unchanged).** `mcp.ts:1427` passes `session_id` (`z.string()`, no length cap) raw to `service.claimNode` (`:5530-5540`), which passes it raw to `index.claimNode`, which writes it raw as `claim_session`. The claim emit passes the same raw value to the ledger, where `normalizeEvent` caps it at 512 units. For a session id over 512 units the ledger and index strings differ, and `reconcile.ts:107` reports an identity mismatch. Owner decision, carried.
5. **Node id split (new to this record, pre-existing, same class as item 4).** `graph_register` and `graph_claim` take `node_id` as `z.string()` with no cap (`mcp.ts`, `graph_claim` at `:1382`). The ledger stores `node_id` through `normalizeIdentifier`, which is capped at 512 units (`event.ts:403`, `clean` at `:180-184`). The index stores `node_id` raw. For a node id over 512 units, `reconcileHolds` looks up the capped ledger key, and the index hold appears under the full key, so the comparison can report two drift findings for one hold. This is the open owner item W-L3b (node_id cut at 512 without the trim). [INFERENCE from code; not reproduced.] Nothing in 4b84e50c changes it.

## Must-haves

| # | Criterion (this tree's ROADMAP, `:1352-1355`) | Verdict | Evidence at 4b84e50c |
| - | ------------------------------------------- | ------- | -------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by named tests. The live cadence and the single-flight guard are human items | Counts `reconcile-run.ts:55-96`. First key `reconcile.ts` `firstOf` and the sort. Clean `reconcile.ts:210`. Scheduled path `service.ts:4182` (`startReconcile`), `:4185` (`setInterval`), `:4199-4201` (`reconcileTick`, single flight `??=`), `:4207` (`runScheduledReconcile`). Targeted run below passes |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (WARNING). R1 to R9 hold as ruled. The post-flush placement is ratified and documented. Open: the unreadable-plan audit gap (7c) and the test gaps (8, 9, 17). R8 is a documented operator assertion; its live proof is human item 4 | Separate `repair` subcommand, dry run by default (`reconcile-repair.ts:243-251`). Execute needs `--server-stopped`, usage refusal exit 2 before any client (`reconcile-main.ts:203-212`). Durable chain check before the flush. Plan record `planFromReport` (`reconcile-repair.ts:125-145`). Digest recheck (`:210-214`) and orphan recheck (`:218-222`). Flush and total bound (`:185-192`, `:240`). Unlink passes (`:264-276`). Post-flush audit record (`reconcile-main.ts:260`), append failure exit 1 (`:270-273`) |

**Must-haves: 1 of 2 verified in code.** No truth FAILED. The human items are non-empty, so the status is `human_needed` (Step 9, rule 2). SC2 is UNCERTAIN, not FAILED.

**Classification note.** The unreadable-plan gap (7c) is recorded as an open WARNING under SC2, as in the prior record. I did not reclassify it. Read literally it breaks "one audit record per repair execute" (`reconcile-main.ts:246-247`). Whether it must close before SC2 is verified is an owner decision. A BLOCKER reading would move the status to `gaps_found`; I did not make that call in this pass.

## SC2: the corpus delete rules, point by point

The rules are in `docs/runbooks/corpus-sync.md` (§2 lines 45-79; §5 lines 115-121). The cache repair rules are in `docs/reconcile.md` (lines 36-68). Those documents and the code they cite are unchanged since 8a604455.

| # | Corpus rule | Reconcile evidence at 4b84e50c | Verdict |
| - | ----------- | ------------------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | Dry run is the default (`reconcile-repair.ts:243-251`; `reconcile-main.ts:98-101`). The cache dry run is not audited (owner decision 6 scopes R7 to the execute) | MET |
| R2 | Explicit execute | `--execute --server-stopped` (`reconcile-main.ts:98-99`). Corpus: `execute: true` in the body (`corpus/validate.ts:186-187`) | MET |
| R3 | Act only on what the plan names; a key an active row holds is kept | Plan pinned by digest and by live orphan set (`reconcile-repair.ts:210-222`). The flush selects by class, not by named key: answer classes, every `gen` counter, the mark. Ratified as D78-5 (`docs/reconcile.md:48`, owner, 2026-11-03). Corpus: an orphan an active row holds at that moment is kept (`docs/runbooks/corpus-sync.md:68`) | MET as ratified design of record (D78-5) |
| R4 | A delete confirmed by the store; an unconfirmed delete is not counted | `removed` is the UNLINK count per batch (`reconcile-repair.ts:264-271`); the count is the server's reply (`cache.ts:1087-1102`). Corpus: `repaired.deleted` counts confirmed deletes only (`corpus/reconcile.ts`, unchanged) | MET |
| R5 | Bound per run | One run removes at most `RECONCILE_MAX_ITEMS` keys across the three passes (`reconcile-repair.ts:185-192`, `:240`). Corpus: one total bound (`corpus/reconcile.ts:170-174`) | MET |
| R6 | `repaired` read against the listed items in one unit | `planned`, `removed` and `remaining` are all cache keys (`reconcile-repair.ts:56-67`; `:239`) | MET as the owner ruled |
| R7 | Audit: the dry run is audited (fail-open); the execute is audited (fail-closed) | Corpus: dry run under `corpus_status` (fail-open), execute under `corpus_ingest` (fail-closed), audited before the handler (`server.ts:1782-1790`; `routes.test.ts:332`). Cache: one record per execute, written after the flush (`reconcile-main.ts:260`); a failed write exits 1 (`:270-273`), owner-accepted (`docs/mcp-audit.md:37`). Residual: an unreadable plan writes no record (7c) | MET for the execute as the owner ruled; 7c open |
| R8 | Serialised with ingest by the corpus lock | The cache flush is serialised by `--server-stopped`, an operator assertion stated in the chain header (`packages/audit/src/log.ts:1-9`). The code checks the flag, not the server state (`reconcile-main.ts:98-99`; `reconcile-repair.ts:252-259`). Corpus takes the ingest lock (`docs/runbooks/corpus-sync.md:76`) | CLOSED as a documented operator assertion (not as fact). Live proof open (human item 4) |
| R9 | A re-run is safe: a second run finds nothing | A second execute after a full flush is refused with no orphans (`reconcile-repair.ts:217-220`). `reconcile-repair.test.ts:424` covers the answer-cut case. The counter-cut refusal (digest, `:210-214`) has no test | MET for the answer cut; counter-cut test gap (8) open |

**Reading:** R1 to R6, R8 (as an operator assertion) and R9 (answer cut) hold. R7 holds for both the corpus execute and the cache execute, with the post-flush placement owner-ratified. SC2 stays UNCERTAIN on 7c.

## Post-flush audit policy: what was checked

1. **Code.** `reconcile-main.ts:203-212` (durable check before any client), `:251` (flush), `:260` (append after the flush), `:270-273` (append failure → `return 1`), `:264-268` (`<plan>.result.json` in `finally`). Unchanged in the range.
2. **Docs.** `docs/reconcile.md:56, :68, :79, :81`; `docs/mcp-audit.md:37`; `docs/runbooks/corpus-sync.md:75-76`. All four describe the same ordering. Unchanged in the range.
3. **Corpus route.** The route audit is fail-closed and precedes the handler (`server.ts:1782-1790`, `:703-714`). Unchanged in the range.
4. **Test coverage of this policy.** The durable-chain refusal is tested (`reconcile-main.test.ts:199`, pass). The single-record write is tested (`reconcile-main.test.ts:176`, pass). The flush-failure exit 1 is tested (`reconcile-main.test.ts:106`, pass). **The post-flush append failure exit 1 is not tested** (warning 17).

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED: durable check, flush, R7 record, post-flush exit 1; warning 7c open | `:203-212`; `:246-247` (unreadable plan, 7c); `:251`; `:260`; `:270-273` |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED: mechanics, total bound, D78-5 ratified | `:56-67`; `:125-145`; `:185-192`; `:210-222`; `:240-251`; `:252-259`; `:264-276` |
| `packages/mcp-server/src/reconcile-read.ts` | VERIFIED: stored values read as stored; no normalizer on the reconcile path | `:122`; `:224`; `:233` |
| `packages/mcp-server/src/reconcile-run.ts` | VERIFIED: counts, truncation, cache-off unchecked | `:55-97` |
| `packages/mcp-server/src/reconcile.ts` | VERIFIED: comparators, `first`, `clean` | `compareLeases` `:82`; identity `:105-109`; `clean` `:210` |
| `packages/mcp-server/src/corpus/reconcile.ts` | VERIFIED: total bound; `(repo, path)` key, unchanged | `:62`; `:98-102`; `:170-174`; `:192` |
| `packages/mcp-server/src/corpus/validate.ts` | VERIFIED: `execute` boolean-only | `:186-187` |
| `packages/mcp-server/src/server.ts` | VERIFIED: route audit before the handler; 503 on refusal | `:703-714`; `:1782-1792` |
| `packages/audit/src/policy.ts` | VERIFIED: `corpus_status` fail-open, default fail-closed | `:131`; `:144-147`; `:48` |
| `packages/mcp-server/src/service.ts` | VERIFIED for SC1 and the write-side session key; claim, release and tick unchanged in range | `:3014`; `:3093`; `:4182`; `:4185`; `:4199-4201`; `:4207`; `:5530`; `:5703` |
| `packages/mcp-server/src/event.ts` | VERIFIED: `normalizeKey` for session and repo on write; lone-surrogate refusal; unchanged in range | `:207-217`; `:277`; `:401`; `:403`; `:407` |
| `packages/mcp-server/src/mcp.ts` | VERIFIED as read: `graph_claim` `session_id` and `node_id` unbounded, passed raw | `:1382`; `:1427` |
| `packages/mcp-server/src/memory-policy.test.ts` | VERIFIED: pass; lone-surrogate regression test for the 4b84e50c access fix | `:359`; in targeted run |
| `packages/mcp-server/src/reconcile-main.test.ts`, `reconcile-repair.test.ts` | VERIFIED: pass; no post-flush append test; no counter-cut test | run below; names at `reconcile-repair.test.ts:126-424` |
| `packages/mcp-server/src/corpus/routes.test.ts` | VERIFIED: pass; fail-closed corpus audit test | run below |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `server.ts` `/corpus/reconcile` | `auditedRest` | before `substrate.corpusReconcile` (`:1789-1790`) | WIRED | a refused audit answers 503, no handler call |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | identity for ordinary ids unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-read.ts` memory ids | `index-store.ts` `reconcileMemoryIds` | `:233`, `:2950` | WIRED | unchanged by 4b84e50c |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:203-212`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:251`) | WIRED | |
| `reconcileMain` (execute) | `recordRepair` | after `executePlan` (`:260`) | WIRED | |
| `reconcileMain` (append failed) | exit code | `:270-273` returns 1 | WIRED | not covered by a test (warning 17) |
| `reconcileMain` (unreadable plan) | `recordRepair` | none: returns 1 at `:247` | NOT WIRED (warning 7c) | no audit record on that path |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:264-276`) | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (`service.ts:4200`) | WIRED; single flight untested | |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2924-2981`) and cache SCANs (`cache.ts:1061`), combined at `reconcile-run.ts:55-96`. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:226-276`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts:156-171`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:145-179`). No hardcoded result feeds these values.

## Requirements coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1631-1638`), scan caps, `RECONCILE_MAX_ITEMS`, read-only report path, unclean on unavailable layers (`reconcile-run.ts:91-97`). The checkbox is unticked (`:125`) and the table row says `Not started` (`:140`); both unchanged at 4b84e50c. Owner or orchestrator to decide the status | Requirement status is an owner decision; this pass does not change it |

## Anti-patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`: none in `reconcile*.ts`, `corpus/reconcile.ts`, `scripts/reconcile.ts`, `docs/reconcile.md`, `docs/mcp-audit.md`, `docs/runbooks/corpus-sync.md`. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 files. The 4b84e50c changes are one-line repo spelling changes.
- **Doc-comment drift (minor).** `packages/corpus/src/protocol.ts:261` still describes the constant as a per-list bound. Warning 16.
- **Re-verification evidence gate (Step 7).** Initial mode (Step 0). No blocker raised by the evidence gate in this pass.

## Behavioral spot-checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Reconcile report, repair and lease/memory comparators, event normalization, corpus route audit, and the 4b84e50c memory repo regression still pass at 4b84e50c | `bun test src/reconcile.test.ts src/reconcile-read.test.ts src/reconcile-main.test.ts src/reconcile-repair.test.ts src/event.test.ts src/corpus/routes.test.ts src/memory-policy.test.ts --timeout 30000` (one command, from `packages/mcp-server`, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`) | 224 pass, 0 fail, 727 expect() calls, 7 files. stderr shows the expected ENOTDIR refusal from the corpus audit test | PASS (by test) |
| Repair removes at most 500 keys of 601 and reports the remainder | `reconcile-repair.test.ts:402` ("a run removes at most the corpus bound of keys and reports the remainder") | pass in the run above | PASS (by test) |
| Lone-surrogate repo keeps its exact spelling for visibility | `memory-policy.test.ts:359` | pass in the run above | PASS (by test) |
| Post-flush append failure exits 1 after the flush | none | no test | ? NOT TESTED (warning 17); by code only |
| Counter-cut second run refused by digest | none | no test | ? NOT TESTED (warning 8); by code only |
| Single-flight: second tick starts no run | none | no test | ? SKIP, human item 1 |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report, scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` for this phase; no PLAN or SUMMARY declares a probe. Skipped.

## Warnings (non-blocking)

1. **Repair result units (R6): RESOLVED by owner decision 6.** `planned`, `removed` and `remaining` count keys (`reconcile-repair.ts:56-67`).
2. **Flush scope, whole prefix (D78-5): RESOLVED as design of record.** Owner ratification 2026-11-03, `docs/reconcile.md:48`. Code unchanged and matches.
3. **No tick test runs a cache-off fixture: unchanged.** The cache-off line is covered by `runReport` (`reconcile-read.test.ts`).
4. **Advisory: index read cost: unchanged.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a batch (`index-store.ts:2924-2934`). [INFERENCE from the SQL; not measured]
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report: unchanged.** A truncated report can still produce a plan (`reconcile-run.ts`). The flush is fail-closed on its own 1000000-key scan (`reconcile-repair.ts:226-233`).
6. **Per-run bound, total or per kind: RESOLVED.** Phase 78 is total (`reconcile-repair.ts:185-192`, `:240`; `docs/reconcile.md:46`).
7. **Audit record (R7) residuals:**
   - (a) **Post-flush placement: RESOLVED, owner-ratified 2026-11-03.** The approved text is `docs/mcp-audit.md:37`, `docs/reconcile.md:68` and `:79`, and `docs/runbooks/corpus-sync.md:76`. The code matches.
   - (b) **Dry run not audited.** Owner decision 6 text scopes R7 to the execute. Carried.
   - (c) **Unreadable plan writes no record: OPEN code gap, untested.** An `--execute` whose plan cannot be read or parsed returns 1 before `executePlan` and before `recordRepair` (`reconcile-main.ts:246-247`), with no audit record and no flush. Fix: write the record on that path too, with a reason that names the parse failure. Not fixed here (no code edits in this pass).
   - (d) **Single writer: RESOLVED in docs and in the code header** by the owner approval (`docs/mcp-audit.md:37-38`, 2026-11-03), conditioned on R8.
8. **Second run with the same plan, counter cut (R5): documented, test gap OPEN.** The digest refusal (`reconcile-repair.ts:210-216`) is documented at `docs/reconcile.md:57` and in the reason string. The named test (`reconcile-repair.test.ts:424`) covers only the answer-cut case. Recommend a test for the counter-cut refusal, plus re-plan-then-finish.
9. **Set-but-not-durable chain path untested: OPEN, minor.** The unset path is tested (`reconcile-main.test.ts:199`). An unwritable `SUBSTRATE_AUDIT_PATH` takes the same branch (`reconcile-main.ts:207-211`) and is not tested.
10. **Cache layer reported unchecked, not zero: recorded** (78-SUMMARY.md; STATE owner decision 2). The code matches (`reconcile-run.ts`). Open for the owner.
11. **ROADMAP status text: RESOLVED at 8a604455.** `ROADMAP.md:1348` and `:1426` record the ratified post-flush policy and the open items. Unchanged at 4b84e50c.
12. **Chain header vs the approved second writer: RESOLVED.** `packages/audit/src/log.ts:1-9` names `substrate-mcp` as the writer, the repair execute as the approved second writer, and states the stopped-server condition as an operator assertion.
13. **HARD-H2 orphaned: OPEN.** `REQUIREMENTS.md:125` is unticked; the row at `:140` says `Not started`. Unchanged at 4b84e50c. PLAN 78-01 declares no requirements.
14. **Corpus runbook bound versus corpus code: RESOLVED (d05ae871).**
15. **STATE.md citations: RESOLVED** (no f1854711 citation at 6644698e; not re-checked for 4b84e50c beyond the range name list).
16. **Protocol constant comment: OPEN, minor.** `packages/corpus/src/protocol.ts:261` reads "The most items `reconcile` lists in one list; the counts always cover all of them." It describes a per-list bound; the behaviour is total. Unchanged (`protocol.ts` not in the range).
17. **Post-flush append failure is untested: OPEN.** `reconcile-main.ts:270-273` (append failed after the flush → exit 1) has no test. The behaviour is documented and owner-accepted, so this is a test gap, not a code gap.

## Info (non-blocking)

- **Node id over 512 units splits the lease comparison (new to this record, pre-existing, not a regression).** `graph_register` and `graph_claim` take `node_id` without a length cap; the ledger stores at most 512 units; the index stores the raw value. `reconcileHolds` then reports drift for that hold. 4b84e50c does not widen or narrow it. This is the same owner class as W-L3b. [INFERENCE from code; not reproduced.] Owner decision.
- **Session id over 512 units splits the lease comparison (pre-existing, not a regression).** `graph_claim` takes `session_id` without a length cap; the ledger stores at most 512 units; the index stores the raw value (`claim_session`). `reconcile.ts:107` then reports an identity mismatch for that hold. 4b84e50c does not widen it. [INFERENCE from code; not reproduced.] Owner decision.
- **Session or repo id that `redact` changes splits the same way.** The ledger side is redacted (`clean`); the index side is raw. [INFERENCE from code; not reproduced.] Owner decision.
- **Repo spelling in ledger rows (owner item, 4b84e50c).** `event.ts` keeps the trimmed repo in ledger rows written with scope off. Reconcile never compares repo, so this does not split any reconcile comparison. Recorded for the owner.
- **Window-edge false drift (carried advisory, not reproduced).** [INFERENCE from code order; not reproduced]
- **Dry-run `remaining` reads equal to `planned`** (carried). The reason string states the one-run split.
- **Corpus response has no remainder count** (d05ae871 commit message: "left for a later change"). `drift.truncated` only.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; `docs/reconcile.md:70`; STATE owner decision 3. Open for the owner.

## Open decisions (kept as recorded)

- **Post-flush audit policy.** Owner-accepted 2026-11-03. Documented; code matches. Closed as ratified.
- **Unreadable-plan audit gap (7c).** Open. Code change owed; the owner decides whether it is required before SC2 is verified.
- **Counter-cut test gap (8), set-but-unwritable chain test gap (9), post-flush append failure test gap (17).** Open. Test changes owed.
- **Single-flight guard test.** Open. Human item 1.
- **Session, repo and node keys above the cap, or changed by redaction.** Open for the owner (Info above). Not changed by 4b84e50c.
- **Operator items (human 1 to 4) and R8.** Not run here.
- **HARD-H2.** Orphaned in REQUIREMENTS.md (`:125`, `:140`). Requirement status is the owner's or orchestrator's to set.
- **Cache layer unchecked, not zero.** Recorded (warning 10). Open for the owner.
- **Owner items from 4b84e50c that are not phase 78 items** (phase 73 W-L3b and W-K1 and W-K3 and W-O1, phase 72, phase 77 H3, H5, H6, migration 43, phase 75 O1 and O2, phase 76 D76-15 and others). Carried as the assignment states. Not re-verified in this pass. The one that touches phase 78 is W-L3b (node_id cut at 512), recorded in Info above.

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED on the phase 78 SC1 path. SC1 is verified in code and by named tests, with the live cadence and single-flight guard as human items. SC2's mechanics are verified; R1 to R9 hold as ruled. The session, repo and memory handling on the reconcile path is unchanged by 4b84e50c. SC2 stays UNCERTAIN on the unreadable-plan audit gap (7c).

**Status:** `human_needed`, from the four live proofs and the single-flight item. Warnings 1 to 17 do not change the status.

## Self-check

- Read at 4b84e50c: `reconcile-read.ts:122`, `:224`, `:233`; `reconcile.ts:82`, `:105-109`, `:210`; `reconcile-main.ts:203-212`, `:246-247`, `:251`, `:260`, `:270-273`; `reconcile-repair.ts:125-145`, `:185-192`, `:210-222`, `:240-251`, `:252-259`, `:264-276`; `event.ts:207-217`, `:277`, `:401`, `:403`, `:407`; `index-store.ts:2650`, `:2682`, `:2950`; `service.ts:2501`, `:3014`, `:3093`, `:4182-4207`, `:4592`; `mcp.ts:1382`, `:1427`; `memory-policy.test.ts:359`; `REQUIREMENTS.md:125`, `:140`; `ROADMAP.md:1344-1357`.
- Commit diff: `git diff 8a604455..4b84e50c` on all phase 78 modules is empty. 4b84e50c touches 8 files, none on the reconcile path.
- Targeted test, one command, from `packages/mcp-server`, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test src/reconcile.test.ts src/reconcile-read.test.ts src/reconcile-main.test.ts src/reconcile-repair.test.ts src/event.test.ts src/corpus/routes.test.ts src/memory-policy.test.ts --timeout 30000`: 224 pass, 0 fail, 7 files.
- Covered digest from `gsd-tools query verification.fingerprint` over the 38 listed files: `v3:sha256:c29234d6…`.
- Only `78-VERIFICATION.md` in the worktree was written. No code edits, no commits, no ROADMAP, STATE or REQUIREMENTS edits, no full suite, no tsc, lint or formatters. Nothing under `/root/src/repos/agent-substrate` was written.
- Kept open, as instructed: the unreadable-plan audit gap (7c), the counter-cut test gap (8), the set-but-unwritable and post-flush append test gaps (9, 17), the single-flight item, the operator items (human 1 to 4 and R8), and HARD-H2.

_Verified: 2026-11-03T16:04:28Z_
_Verifier: Claude (gsd-verifier, re-verification at HEAD 4b84e50c)_
