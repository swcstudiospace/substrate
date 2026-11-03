---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T22:21:10Z
status: human_needed
score: 1/2 must-haves verified; SC2 mechanics and owner decision 6 rules (R5, R6, R7) verified in code and by named tests; SC2 stays UNCERTAIN on owner-held items (D78-5, R3 per-key form, R8, audit single-writer statement, post-flush record placement); 4 live proofs human_needed
tree: /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 9ee12695
criteria_source: this tree's ROADMAP, Phase 78 section. The success-criteria text matches origin/main exactly. The Status and Plans lines differ (origin/main: "Not started", "none written"); this tree's section is used, and the difference is reported below, not chosen silently
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
    ".planning/phases/78-cross-layer-reconciliation/78-CONTEXT.md",
    ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md",
    "docs/reconcile.md",
    "docs/mcp-audit.md",
    "docs/runbooks/corpus-sync.md",
    "packages/audit/src/log.ts",
    "packages/corpus/src/protocol.ts",
    "packages/mcp-server/src/cache.ts",
    "packages/mcp-server/src/config.ts",
    "packages/mcp-server/src/greptime.ts",
    "packages/mcp-server/src/index-store.ts",
    "packages/mcp-server/src/observe.ts",
    "packages/mcp-server/src/reconcile-main.test.ts",
    "packages/mcp-server/src/reconcile-main.ts",
    "packages/mcp-server/src/reconcile-read.test.ts",
    "packages/mcp-server/src/reconcile-read.ts",
    "packages/mcp-server/src/reconcile-repair.test.ts",
    "packages/mcp-server/src/reconcile-repair.ts",
    "packages/mcp-server/src/reconcile-run.ts",
    "packages/mcp-server/src/reconcile.test.ts",
    "packages/mcp-server/src/reconcile.ts",
    "packages/mcp-server/src/service.ts",
    "scripts/reconcile.ts"
  ]
covered_digest: "v3:sha256:72803a186210afc7834e17ce76825c15156f6ece62742769e5018042f4611e5d"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at tree c7788f9d, status human_needed, 1/2, SC2 UNCERTAIN (WARNINGS 1, 7, 8)"
  reason: "Owner decision 6 applied in 1633fecf (R5 bound, R6 one unit, R7 audit record) and gated by 9ee12695 (reconcile-main.ts import and REPAIR_ENV fixture). The SC1 code paths (reconcile.ts, reconcile-run.ts, reconcile-read.ts, service.ts, config.ts, cache.ts, index-store.ts) have no delta since c7788f9d; SC1 is re-observed below by name."
  gaps_closed:
    - "WARNING 1 (repair result units): closed. The result counts keys in one unit: planned, removed, remaining (reconcile-repair.ts:56-67); `listed` and `repaired` are gone from the source and docs"
    - "WARNING 7 (no per-run bound): closed for the owner's rule. One execute removes at most RECONCILE_MAX_ITEMS = 500 keys across the three passes (reconcile-repair.ts:11, :240, :185-192)"
    - "WARNING 8 (no audit record): closed for executes. One record per execute on the MCP audit chain (reconcile-main.ts:156-171, :259-260), with the plan digest, counts and outcome. Two residuals stay open, listed below"
  gaps_remaining:
    - "D78-5: whole-prefix flush and the three ordered passes. Owner ratification pending (WARNING 2; R3 per-key form)"
    - "R8: --server-stopped is an operator assertion (reconcile-main.ts:98-99; reconcile-repair.ts:252-259)"
    - "Audit-chain single-writer: docs/mcp-audit.md:33-35 says substrate-mcp is the only writer; docs/reconcile.md:79 says a repair execute is a second writer. Owner statement needed (see Open decisions)"
    - "Post-flush record: the audit append follows the flush (reconcile-main.ts:258-260, :270-273). Only the chain's durability is checked before the flush (:201-212)"
    - "Second run with the same plan is refused when the bound cuts into the counter pass (digest changes; see W9). The named test covers only the answer-cut case"
    - "An execute with an unreadable plan file writes no audit record (reconcile-main.ts:240-248)"
    - "Live proofs (human items 1 to 4)"
  regressions: []
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4067-4072, reconcilePass ??=)"
    test: "Start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture. Start a second tick while the first is in flight (or force one with a slow ledger read)"
    expected: "Exactly one run is in flight. The second tick returns the in-flight promise and writes no second line. Neither run writes to the ledger, the index or the cache"
    why_human: "No test covers the guard. The interval cadence is real time and no test fires setInterval. This is an ordering invariant that presence and wiring cannot show"
advisory:
  - finding: "A write whose memory row is created before the window start but whose audit event is stamped after it is reported as an accepted audit event with no index row (false drift at the window edge)"
    category: other
    reason: "Both sides use one sinceIso (reconcile-run.ts:51). The row is inserted in governMemoryWrite and its audit is awaited before the reply (service.ts:3259, :3289). A write straddling the window start appears on the ledger side only. Not repaired; the report never repairs memory"
    evidence_status: "code-order reasoning only [INFERENCE]; not reproduced"
  - finding: "Dry-run result reads remaining equal to planned (remaining = planned - removed, with removed 0). The reason string states the one-run split (500 removed, the rest left)"
    category: other
    reason: "Consistent with the field definition (reconcile-repair.ts:51-54). A reader comparing `remaining` in a dry run to the post-run figure will read it wrong; the reason string is the one-run figure"
    evidence_status: "read in code"
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval cadence is real time and no test fires the interval. The single-flight guard (service.ts:4067-4072) has no test"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run); then repair --plan <file> --execute --server-stopped; then a second execute. Then, if the bound cut into the counter pass, plan again and repair again"
    expected: "The dry run writes nothing and its reason states the one-run split. The execute removes at most 500 keys: answers first, then generation counters, then the forget mark; budget: and emb: keys are kept. <plan>.result.json holds planned, removed, remaining, limit and truncated (no listed or repaired). One audit record is appended with outcome, counts and plan_digest. A prefix above 1000000 keys refuses with nothing removed"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores and a real audit file: report; repair --plan <file> --execute without --server-stopped (exit 2); repair --plan <file> --execute --server-stopped without SUBSTRATE_AUDIT_PATH (exit 2, nothing flushed); the execute with SUBSTRATE_AUDIT_PATH set; then restart substrate-mcp and verify the audit chain"
    expected: "Exit codes match docs/reconcile.md. The chain verifies after the restart, with the repair record in place and a continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest"
    why_human: "Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. The single-writer sequence (CLI append, then server restart and verify) is the proof the owner's statement depends on"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T22:21:10Z
**Status:** human_needed
**Re-verification:** Yes, at HEAD 9ee12695 (previous record at c7788f9d)
**Scope:** the integration tree at `9ee12695`. Procedure: gsd-verifier, goal-backward. Live proofs are operator items. Owner-held decisions stay open.

## Criteria and conflicts

- **Criteria source used:** this tree's ROADMAP, Phase 78 section (`/root/src/worktrees/as-gsd-v18-all/.planning/ROADMAP.md`). The brief uses origin/main only when its text matches this tree. The two success-criteria texts are identical. Only the Status and Plans lines differ.
- **Difference reported, not chosen:** origin/main says `Status: Not started` and `Plans: none written`. This tree says `human_needed: 1 of 2 in code; SC2 uncertain, with corpus delete-rule clauses R5, R6 and R7 not met as written; owner decides`. That Status line is now stale: 1633fecf met R5, R6 and R7 in code under owner decision 6. The owner or orchestrator should update the ROADMAP line (W11). The verdicts below do not depend on which section is used.
- **Naming deviation (no criterion failure):** 78-CONTEXT.md D78-6 names the plan's window field `window`. The code writes `window_hours` (reconcile-repair.ts:45, :125-145).
- **Recorded amendment:** 78-CONTEXT.md D78-5 specifies a whole-prefix delete. The code runs three ordered passes (reconcile-repair.ts:272-276). The amendment is recorded in 78-SUMMARY.md and STATE.md. Owner ratification is pending (Open decisions).
- **Gate evidence (orchestrator's run, not re-run here):** `/root/src/worktrees/backups/gates-int-r10.log` line 7 `PG_READY port=54285 head=9ee12695`; line 8 `TSC_EXIT=0`; line 11 `LINT_EXIT=0`; line 17097 `12075 pass`; line 17099 `0 fail`; line 17131 `PY_EXIT=0`; line 17135 `239 pass`; line 17136 `0 fail`; line 17141 `GATES_DONE rc=0`.
- **Tree state:** `packages/` and `docs/` at 9ee12695 change phase 78 in three files since c7788f9d: reconcile-repair.ts, reconcile-main.ts and observe.ts (which now exposes `openAuditLog`, observe.ts:294-296). `reconcile.ts`, `reconcile-run.ts`, `reconcile-read.ts`, `service.ts`, `config.ts`, `cache.ts` and `index-store.ts` are unchanged since c7788f9d (checked by `git diff --stat`). `docs/mcp-audit.md` is unchanged. `packages/audit/src/log.ts` is unchanged. An unrelated uncommitted edit exists in the tree at `.planning/phases/76-telemetry-buffer-and-dead-letter/76-VERIFICATION.md`; it is not this phase's and was not read or changed.

## Must-haves

| # | Criterion (this tree's ROADMAP) | Verdict | Evidence on this tree |
| - | ------------------------------- | ------- | --------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by named test (re-observed this pass); live cadence and single-flight human_needed | Counts: reconcile-run.ts:55-96. First key: reconcile.ts:193-194 (`firstOf`), :205-209. Comparators: reconcile.ts:82-119 (lease), :129-153 (memory), :162-174 (generation). Scheduled line: service.ts:4089-4090. The tick writes one stdout line and stderr only on skip or failure (service.ts:4075-4094). The report path is read-only: `queryEvents` SELECT (greptime.ts:1519-1538), index SELECTs (index-store.ts:2924-2981), cache SCAN (cache.ts:1061-1079) |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (WARNING; owner-held items D78-5, R3 per-key form, R8, single-writer statement, post-flush record placement). The owner decision 6 rules R5, R6, R7 are VERIFIED in code and by named tests | Separate `repair` subcommand, dry run by default (reconcile-main.ts:92-101; reconcile-repair.ts:243-251). Execute needs `--server-stopped`, a usage error with exit 2 before any client (reconcile-main.ts:98-99, called at :183, before `loadConfig` at :191). Plan record: `planFromReport` (reconcile-repair.ts:125-145), written with `wx` (reconcile-main.ts:235). Digest recheck (reconcile-repair.ts:210-216). Orphan and plan-item recheck (:217-222; `planRefusal` :151-162). Scan once, refuse on truncation (:226-233). Bound (R5): reconcile-repair.ts:240-241 and :185-192. Unit (R6): :56-67. Audit (R7): reconcile-main.ts:156-171 and :203-212, :259-260 |

Must-haves: 1 of 2 verified in code. SC2 is UNCERTAIN on owner-held items, with no truth FAILED. The human items are non-empty, so the status is `human_needed` (Step 9, rule 2).

## SC2: the corpus delete rules, point by point

The rules are in `docs/runbooks/corpus-sync.md` (§2 lines 60-79; §5 lines 115-121). The bound is `RECONCILE_MAX_ITEMS = 500` in `packages/corpus/src/protocol.ts:262`.

| # | Corpus rule | Reconcile evidence on 9ee12695 | Verdict |
| - | ----------- | ------------------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | Dry run is the default (reconcile-repair.ts:243-251; reconcile-main.ts:98-101). The dry run reads the cache keys with a read-only SCAN (:226), then writes nothing. The dry run is not audited (see W8) | MET |
| R2 | Explicit execute | `--execute --server-stopped` (reconcile-main.ts:98-99) | MET |
| R3 | Act only on what the plan names; a key an active row holds is kept | Plan pinned by digest and by the live orphan set (reconcile-repair.ts:210-222). The flush selects by class, not by named key: every answer class (:24-31, :168-179), every `gen` counter and the mark (:172-177). Recorded divergence: D78-5 and W2 | PARTLY MET; owner decision (D78-5) |
| R4 | A delete confirmed by the store; an unconfirmed delete is not counted | `removed` is the UNLINK count per batch (reconcile-repair.ts:264-271); the count is the server's reply (cache.ts:1087-1102) | MET |
| R5 | At most 500 per run (corpus: "at most 500 of each") | One run removes at most `RECONCILE_MAX_ITEMS` keys across the three passes: `boundPasses` takes the first 500 keys in pass order (reconcile-repair.ts:185-192, :240); `truncated` is `planned > limit` (:87). The owner's text is "at most RECONCILE_MAX_ITEMS keys per run", which the code follows. The corpus text says "of each", a per-kind reading; the owner should confirm the total reading (Open decisions) | MET as the owner ruled |
| R6 | `repaired` read against the listed items in one unit | `planned`, `removed` and `remaining` are all cache keys (reconcile-repair.ts:56-67; :239 `planned` = sum of the pass lengths). `listed` and `repaired` are gone from source and from docs/reconcile.md:46 | MET as the owner ruled |
| R7 | Audit: the dry run is audited (fail-open); the execute is audited (fail-closed) | One record per execute, tool `reconcile_repair`, surface `operator`, transport `internal`, `decision` allowed or denied, `reason` with `outcome`, `planned`, `removed`, `remaining`, `limit`, `plan_digest` (sha256 of the plan file bytes, reconcile-main.ts:260) and `report_digest` (reconcile-main.ts:156-171). Owner text scopes R7 to the execute. Residuals: the record is appended after the flush (see W8); the dry run writes no record; an unreadable plan writes none (W8) | MET for the execute as the owner ruled; residuals open |
| R8 | Serialised with ingest by the corpus lock | `--server-stopped` is an operator assertion (reconcile-main.ts:98-99; reconcile-repair.ts:252-259). Not checked by code | OPEN (operator assertion; recorded) |
| R9 | A re-run is safe: a second run finds nothing | A second execute after a full flush refuses with no orphans left (reconcile-repair.ts:217-220); test at reconcile-repair.test.ts:197 | MET |

**Reading:** R1, R2, R4, R5, R6 and R9 hold as written. R7 holds for the execute with the residuals below. R3 holds in its digest form and diverges in its per-key form (D78-5, open). R8 is an operator assertion, open.

**Why SC2 stays UNCERTAIN rather than VERIFIED:** D78-5 (whole-prefix flush, three ordered passes) has not been ratified by the owner. R8 and the single-writer statement are owner-held. Whether the record may follow the flush is also an owner reading (see Open decisions). Nothing here is FAILED.

## Owner decision 6: the bound, the unit and the audit record, checked point by point

| Requirement (owner decision 6) | Code | Named test | Verdict |
| ------------------------------ | ---- | ---------- | ------- |
| R5: at most RECONCILE_MAX_ITEMS (500) keys per run, reporting planned, removed, remaining and truncated | reconcile-repair.ts:11, :56-67, :87, :185-192, :239-241, :290-300 | reconcile-repair.test.ts:402 "a run removes at most the corpus bound of keys and reports the remainder" (asserts `planned: 601`, `removed: 500`, `remaining: 101`, `truncated: true`, and that the orphan counter is still present) | VERIFIED |
| R5: a second run with the same plan finishes the remainder | reconcile-repair.ts:210-222 (digest and orphan recheck before the flush) | reconcile-repair.test.ts:424 "a second run with the same plan removes the remainder, counter and mark last". It covers only a cut that stays in the answer pass. See W9 | VERIFIED for the answer-cut case; the counter-cut case is refused and needs a re-plan (W9) |
| R6: one unit for planned, removed and remaining | reconcile-repair.ts:56-67, :239, :285-300 | reconcile-repair.test.ts:169 (exact result shape: `planned: 5, removed: 5, remaining: 0`), :402 | VERIFIED |
| R7: one audit record per execute, with the plan digest, counts and outcome | reconcile-main.ts:156-171 (record), :259-260 (write after the flush), :203-212 (durable check before the flush) | reconcile-main.test.ts:176 "one repair execute writes exactly one audit record, carrying the plan digest and the counts" (asserts one line, `tool: reconcile_repair`, `decision: allowed`, `plan_digest=` the sha256 of the plan text, `report_digest=`, `outcome=executed planned=2 removed=2 remaining=0`) | VERIFIED for an execute that reaches the plan parse |
| Execute exits 2 without SUBSTRATE_AUDIT_PATH | reconcile-main.ts:203-212; `openRepairAudit` at :134-137 | reconcile-main.test.ts:199 "a repair execute with no durable audit chain exits 2 and flushes nothing" (exit 2; the message names SUBSTRATE_AUDIT_PATH; no client opened; nothing removed) | VERIFIED for the unset path |
| Execute exits 2 without a durable chain | `audit.open()` durable check at reconcile-main.ts:205-211 (`durable` false when the path is null or the file cannot be opened; packages/audit/src/log.ts:261-263, :305-420) | The unset path is tested (above). The set-but-not-durable path (for example, an unwritable file) is not tested | VERIFIED in code; the set-but-unwritable path is not tested (W10) |

## Sub-checks, by test (re-observed this pass)

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Scheduled tick on a clean fixture logs one clean line and writes nothing | PASS | Run 3 below ("scheduled reconcile timer" tests match by name; prior record service.test.ts:5871) |
| Clean fixture is clean, `unchecked_layers` empty, nothing written | PASS | reconcile-read.test.ts:343 (run 3, name "a clean fixture reports clean") |
| Dirty fixture reports the first mismatching key per comparison | PASS | reconcile-read.test.ts:362 (run 3) |
| Cache off: layer unchecked, absent from counts, not clean | PASS | reconcile-read.test.ts:391 (run 3, "with the cache off"); reconcile.test.ts:188 (run 3, "unchecked layers are reported as given") |
| A capped cache scan makes the run unclean | PASS | reconcile-read.test.ts:381 (run 3) |
| Unlink runs in batches of at most 500; a failed batch keeps earlier batches | PASS | reconcile-read.test.ts:280, :288 (run 3). Code: cache.ts:1087-1102 |
| Comparators and buildReport (first key, clean) | PASS | reconcile.test.ts "first is the first finding..." and "end to end: comparator output feeds buildReport..." (run 3) |
| Config: SUBSTRATE_RECONCILE interval and window clamps | PASS | config.test.ts "SUBSTRATE_RECONCILE" (run 3) |

## Repair sub-checks

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Execute removes answers, then counters, then the mark; budget and emb untouched | PASS | reconcile-repair.test.ts:169 (run 2): unlink calls `2, 2, 1` in that order; keys left are budget, emb and the unrelated key |
| Second execute after a full flush is a refused no-op | PASS | reconcile-repair.test.ts:197 (run 2) |
| Truncated or incomplete scan removes nothing | PASS | reconcile-repair.test.ts:209 (run 2) |
| Failure in the answer, counter or mark pass keeps the later keys in place | PASS | reconcile-repair.test.ts:230, :249, :271 (run 2) |
| Failed batch keeps the count of earlier batches | PASS | reconcile-repair.test.ts:354 (run 2); reconcile-repair.ts:264-271 |
| Execute without `--server-stopped` refuses and removes nothing | PASS | reconcile-repair.test.ts:291 (run 2); reconcile-main.test.ts:159 (exit 2, no client) |
| `--server-stopped` with another command exits 2 | PASS | reconcile-main.test.ts:168 (run 2) |
| Failed flush exits 1 and writes the result file with the error | PASS | reconcile-main.test.ts:106 (run 2); reconcile-main.ts:264-269, :274-277 |
| Only destructive call on this path is `unlinkKeys` | PASS by reading | reconcile-repair.ts:264-271 is the only caller of `unlinkKeys`. It runs after the server-stopped gate (:252-259). Report and readers call `queryEvents`, index SELECTs and `scanKeys` only |
| Flush excludes `budget:` and `emb:` keys, and any unnamed key | PASS by reading | `FLUSH_ANSWER_CLASSES` :24-31; `flushPasses` :168-179 (only `FORGET_MARK_KEY`, `gen` and the listed answer classes enter a pass) |
| The dry run reads with SCAN and refuses on a truncated scan | PASS by reading | reconcile-repair.ts:226-233 runs before the dry-run return at :243 |

## Behavioral spot-checks (Step 7b, this pass)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Repair `--execute` without `--server-stopped` exits 2 before any connection | Not re-run this pass. Covered by reconcile-main.test.ts:159 | none | PASS (by test) |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file the server writes | none | ? SKIP, see human item 4 |
| Live report, scheduled tick against real stores | not run: needs live stores | none | ? SKIP, see human items 1 and 3 |

## Targeted tests (this pass)

Three `bun test` commands in total, run from `packages/mcp-server`, each with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No Postgres container was started. Each filter is by test name.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test reconcile-repair.test.ts reconcile-main.test.ts -t "corpus bound\|second run with the same plan\|one repair execute\|no durable audit chain\|execute removes answers\|mark pass\|failed flush exits 1\|one batch\|second execute after"` | 9 pass, 19 filtered out, 0 fail, 45 expect calls. Covers the R5, R6 and R7 named tests and the failure-path tests |
| 2 | `bun test reconcile-repair.test.ts reconcile-main.test.ts -t "executePlan\|reconcileMain"` | 25 pass, 3 filtered out, 0 fail, 125 expect calls. This is every test in the `executePlan` (18) and `reconcileMain` (7) describe blocks. The 3 filtered are `planFromReport` (2) and `findingsDigest` (1) |
| 3 | `bun test reconcile.test.ts reconcile-read.test.ts service.test.ts config.test.ts -t "a clean fixture reports clean\|a dirty fixture reports\|with the cache off\|unlink runs in batches\|a capped cache scan\|scheduled reconcile timer\|SUBSTRATE_RECONCILE\|no findings and no truncation is clean\|first is the first finding\|end to end: comparator\|unchecked layers are reported"` | 21 pass, 493 filtered out, 0 fail, 94 expect calls, "Ran 21 tests across 12 files" (SC1 names) |

Totals across the three commands: 46 distinct tests pass (command 2's 25 and command 3's 21; command 1's 9 are a subset of command 2), 0 fail, 0 skip. No PG-gated test was in these filters. The single-flight guard has no test and was not exercised.

**Counter-cut probe (this pass, not a test run).** A `bun -e` script in `packages/mcp-server`, importing `reconcile-repair.ts` and `reconcile-run.ts` by absolute path, over a fake cache with 499 `brief:` keys and 3 `gen:graph:` counters (no graph in the index):

- first execute: planned 502, removed 500, remaining 2, truncated true; the answers and one counter removed.
- second execute, same plan: refused, reason `refused: the findings changed since the plan was made (digest mismatch); re-plan before repairing`; planned 0, removed 0; 2 generation keys left.

So the second run with the same plan finishes the remainder only when the bound stops inside the answer pass. When it stops in the counter pass, the removed counters change the report digest and the same plan is refused. Re-plan, then repair, finishes it. This is fail-closed and the reason string says so (reconcile-repair.ts:299). `docs/reconcile.md:55` states the same. The named test (reconcile-repair.test.ts:424) and the commit message describe "a second run with the same plan" without that limit.

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED (mechanics, R5 bound, R6 unit); audit residual and D78-5 held | Result shape :56-67; `repairOutcome` :70-91; `planFromReport` :125-145; `planRefusal` :151-162; `flushPasses` :168-179; `boundPasses` :185-192; `executePlan` :204-301 |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED (R7 record, durable check, exit codes); residuals open | Args and execute gate :79-103; `missingConfig` :106-113; `openRepairAudit` :134-137; `parsePlan` :140-148; `recordRepair` :156-171; `reconcileMain` :177-285 |
| `packages/mcp-server/src/observe.ts` | VERIFIED | `openAuditLog` :294-296 (the server's factory; the CLI and the server build the chain the same way) |
| `packages/audit/src/log.ts` | VERIFIED as the chain's sink; its header states single writer | Header :1-8 (single writer; "substrate-mcp is the only process that writes it"); `durable` :261-263; `open` :305+; `append` fail-closed throw :434-478 |
| `packages/mcp-server/src/reconcile-run.ts`, `reconcile.ts`, `reconcile-read.ts`, `service.ts`, `config.ts`, `cache.ts`, `index-store.ts` | VERIFIED for SC1; unchanged since c7788f9d | Same citations as the previous record; `git diff --stat c7788f9d 9ee12695` shows no delta on these files |
| `docs/reconcile.md` | VERIFIED (accurate to the code); the single-writer paragraph at :79 is the owner statement's subject | :46 bound and key counts; :54 audited; :55 re-run continues; :66 exit codes; :70-79 audit record |
| `docs/mcp-audit.md` | CONFLICTS with `docs/reconcile.md:79` | :33-35 "single writer. `substrate-mcp` is the only process that writes it"; unchanged since before 1633fecf |
| `docs/runbooks/corpus-sync.md` | VERIFIED as the rule source | §2 :60-79 (bound :70; audit :75-76); §5 :115-121 |
| Test files | VERIFIED | Named tests in the targeted runs above |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, `process.exit(code)` | WIRED | scripts/reconcile.ts |
| `reconcileMain` | `parseReconcileArgs` | before `loadConfig` (reconcile-main.ts:183, :191) | WIRED | usage errors exit 2 before config |
| `reconcileMain` (execute) | `openAudit` durable check | before any client opens (reconcile-main.ts:203-212, :216) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (reconcile-main.ts:251) | WIRED | |
| `reconcileMain` (execute) | `recordRepair` | after `executePlan`, before the result is printed (reconcile-main.ts:259-260) | WIRED; placement after the flush is an open reading | |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (reconcile-repair.ts:264-276) | WIRED | |
| `executePlan` | `runReport` | re-run before any write (reconcile-repair.ts:209) | WIRED | |
| `startRecall` | `startReconcile` | service.ts:4034-4038 | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (service.ts:4067-4072) | WIRED; single flight untested | |
| `runReport` | `cache.scanKeys` | class and generation scans (reconcile-run.ts:85-90) | WIRED | |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents` (greptime.ts:1519-1538), index SELECTs (index-store.ts:2924-2981) and cache SCANs (cache.ts:1061-1079), combined at reconcile-run.ts:55-96. The flush reads the live `substrate:v1:*` keys and removes only the classes it names (reconcile-repair.ts:226-276). The audit record's counts come from the same `RepairResult` the flush returns (reconcile-main.ts:156-171). No hardcoded result feeds these values.

## Anti-patterns (Step 7)

Debt-marker scan (TODO, FIXME, XXX, HACK, PLACEHOLDER, "not yet implemented", "coming soon") over `packages/mcp-server/src/reconcile*.ts`, `scripts/reconcile.ts` and `docs/reconcile.md`: no matches. No debt-marker gate fires. No stub, placeholder or no-op was found in the R5, R6 or R7 code.

## Probe execution (Step 7c)

No `scripts/*/tests/probe-*.sh` exists for this phase, and no PLAN or SUMMARY declares a probe. Skipped: no probes declared. The counter-cut probe above is this verifier's own one-off check, not a declared probe.

## Warnings (non-blocking)

1. **Repair result units (R6): RESOLVED by owner decision 6.** `planned`, `removed` and `remaining` count keys (reconcile-repair.ts:56-67). The old `listed` and `repaired` pair is gone.
2. **Flush scope is the whole prefix (D78-5): OPEN, owner ratification.** `FLUSH_MATCH` `substrate:v1:*` (reconcile-repair.ts:18). The flush selects by class, not by the orphan graph (:168-179). Answer keys carry no graph id (D78-5), so this is the recorded design. Under the corpus reading "act only on what the plan names", it is a deliberate divergence.
3. **No tick test runs a cache-off fixture: unchanged.** The cache-off line is covered by runReport (reconcile-read.test.ts:391).
4. **Advisory: index read cost: unchanged.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a batch (index-store.ts:2924-2934). [INFERENCE from the SQL; not measured]
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report: unchanged.** A truncated report can still produce a plan (reconcile-run.ts:88-90). The flush is fail-closed on its own 1000000-key scan (reconcile-repair.ts:226-233).
6. **Advisory: window-edge false drift:** see the advisory frontmatter entry. Not tested.
7. **Repair has a per-run bound: RESOLVED for the owner's rule (R5).** Total keys per run, 500 (reconcile-repair.ts:185-192, :240). The owner should confirm the total reading, since the corpus text says "of each" (corpus-sync.md:70).
8. **Audit record (R7): PARTLY RESOLVED. Four residuals are open, each an owner reading or a small code gap:**
   - (a) **Post-flush placement.** The durable check runs before the flush (reconcile-main.ts:203-212). The append runs after it (:259-260). A write failure at that point leaves the flush done, and the run exits 1 with `the repair ran, but its audit record was not written` (:270-273). The corpus runbook says the execute is "fail-closed" (corpus-sync.md:75-76). docs/reconcile.md:77 records this reading. The owner must accept it or require a pre-flush intent record.
   - (b) **Dry run not audited.** The corpus rule audits the dry run as `corpus_status` (fail-open). The owner's decision 6 text scopes R7 to the execute. The owner should confirm the scope.
   - (c) **Unreadable plan writes no record.** An `--execute` whose plan file cannot be read or parsed returns 1 before `executePlan` (reconcile-main.ts:240-248). No audit record is written and no flush runs. This is a gap against "one audit record per repair execute" read literally. No test covers it. Fixing it means writing the record on that path too, with a reason that names the parse failure.
   - (d) **Single writer.** See Open decisions.
9. **Second run with the same plan (R5): NEW.** When the bound cuts into the counter pass, the second run with the same plan is refused by the digest check (reconcile-repair.ts:210-216). The docs say so (docs/reconcile.md:55), and the reason string says so (reconcile-repair.ts:299). The named test and the commit message describe "a second run with the same plan" without that limit. The test covers only the answer-cut case. Recommend a test for the counter-cut refusal, plus re-plan-then-finish. No code change is needed for the bound itself.
10. **Set-but-not-durable chain path untested: NEW, minor.** The unset path is tested (reconcile-main.test.ts:199). An unwritable `SUBSTRATE_AUDIT_PATH` takes the same branch (reconcile-main.ts:207-211) and is not tested.
11. **ROADMAP Status line is stale: NEW.** This tree's Phase 78 Status (ROADMAP.md) still names R5, R6 and R7 as not met. The owner decision 6 commit met them in code. The owner or orchestrator should update the line. Not edited here.

## Open decisions (kept open)

- **Whole-prefix flush and the three ordered passes (D78-5).** Recorded in 78-CONTEXT.md, 78-SUMMARY.md and STATE.md. Warning 2. Stays open for the owner to ratify. This is also the reading of "act only on what the plan names" that R3 depends on.
- **`--server-stopped` as an operator assertion (R8, D78-6 as amended).** The code cannot check the server is stopped (reconcile-main.ts:98-99; reconcile-repair.ts:252-259). Same convention as `consistency-run`. Stays open.
- **Audit-chain single writer: an owner statement is needed.** `docs/mcp-audit.md:33-35` and the chain's own header (`packages/audit/src/log.ts:5-8`) say `substrate-mcp` is the only writer. `docs/reconcile.md:79` says a repair execute is "the one other writer", run with the server stopped. The append is correct only if the server really is stopped: the server holds `seq` and `tip` in memory (log.ts, `open` and `append`), so a live server would chain from a stale tip. The owner must state either that a repair execute is an allowed second writer under the server-stopped rule (then `docs/mcp-audit.md` and the log header change), or that it is not (then the repair needs another route). Not decided here.
- **Post-flush record placement (fail-closed reading).** See Warning 8(a). The owner must accept the post-flush append, or require a pre-flush intent record.
- **Dry-run audit scope.** See Warning 8(b). The owner's text scopes R7 to the execute.
- **Bound: total per run or per kind.** The owner's text says "keys per run" (implemented as a total). The corpus text says "at most 500 of each" (corpus-sync.md:70). Owner confirms the total reading.
- **Cache layer reported as unchecked, not zero.** Recorded: 78-SUMMARY.md; STATE.md owner decision (2). The code matches the decision (reconcile-run.ts:91-97). Stays open for the owner.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; docs/reconcile.md:68; STATE.md owner decision (3). Stays open for the owner.
- **ROADMAP Status line.** origin/main and this tree disagree, and this tree's line is stale on R5, R6, R7 (Warning 11). Not chosen; the owner should reconcile.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard (service.ts:4067-4072) have no test. This is also the behavior-unverified item.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts. Dry run, then execute with `--server-stopped`, then a second execute; if the bound cut into the counter pass, plan again and repair again. Expected as in the frontmatter, with `<plan>.result.json` holding `planned`, `removed`, `remaining`, `limit` and `truncated`, and one audit record appended. Why human: H5 cost and behaviour at scale.
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores and a real audit file.** Expected: exit codes per docs/reconcile.md; `--execute` without `--server-stopped` exits 2 before any connection; `--execute --server-stopped` without `SUBSTRATE_AUDIT_PATH` exits 2 with nothing flushed; with the path set, the execute appends one record. After a `substrate-mcp` restart the chain verifies, with the repair record in sequence. Why human: needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is also the only proof of the single-writer sequence the owner's statement depends on.

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED. SC1 is verified in code and by named tests on this HEAD. SC2's mechanics are verified in code. Owner decision 6 (R5, R6, R7) is met in code and by named tests, with residuals: the post-flush record placement, the dry-run audit scope, the unreadable-plan no-record path, and the counter-cut same-plan refusal (Warnings 8 and 9). SC2 stays UNCERTAIN until the owner ratifies D78-5, R8 and the single-writer statement.

**Status:** `human_needed`, from the four human items and the owner-held decisions. Warnings 1 to 11 do not change the status.

## Summary claims checked (78-SUMMARY.md and the 1633fecf and 9ee12695 commit messages)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| R5: at most 500 keys per run, with the remainder reported | TRUE | reconcile-repair.ts:185-192, :240, :290-300; reconcile-repair.test.ts:402 (run 1) |
| R6: one unit in the report; the listed-versus-repaired comparison is gone | TRUE | reconcile-repair.ts:56-67; no `listed` or `repaired` in source or docs/reconcile.md |
| R7: one audit record per execute with the plan digest, counts and outcome | TRUE for the execute that reaches the plan parse | reconcile-main.ts:156-171, :259-260; reconcile-main.test.ts:176 (run 1) |
| A repair execute with no durable chain exits 2 and flushes nothing | TRUE for the unset path | reconcile-main.ts:203-212; reconcile-main.test.ts:199 (run 1). Set-but-unwritable path untested (W10) |
| "A second run with the same plan removes the remainder" | TRUE for the answer-cut only | reconcile-repair.test.ts:424 (run 1); the counter-cut probe above shows a digest refusal (W9) |
| "Repair --execute now requires SUBSTRATE_AUDIT_PATH" | TRUE | reconcile-main.ts:203-212 |
| Targeted counts: reconcile.test.ts, reconcile-read.test.ts, reconcile-repair.test.ts, reconcile-main.test.ts 73 pass; config SUBSTRATE_RECONCILE 9 pass | Not re-run as stated. This pass ran a different filter: 25 repair and CLI tests pass (command 2); 9 named R5/R6/R7 tests pass (command 1); 21 SC1 tests pass (command 3) | Command outputs above |
| Full gate green on 9ee12695 | Orchestrator's evidence, not re-run | gates-int-r10.log lines 7, 8, 11, 17097, 17099, 17131, 17135-17136, 17141 |
| Single-writer and D78-5, R8 kept open | TRUE: the commit says so and this pass agrees | commit 1633fecf message; docs/reconcile.md:79; docs/mcp-audit.md:33-35 |

---

_Verifier: Claude (gsd-verifier, re-verification at HEAD 9ee12695). Verified by this pass: the code reads and line citations above; three targeted `bun test` commands; the counter-cut probe; `git diff --stat` on the SC1 files; the ROADMAP section comparison. Orchestrator's evidence, not re-run: the full gate on 9ee12695 (gates-int-r10.log) and the commit-message before-and-after claims._
