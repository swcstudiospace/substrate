---
phase: 78-cross-layer-reconciliation
verified: 2026-11-03T03:02:15Z
status: human_needed
score: 1/2 must-haves verified; SC1 verified in code and by named tests (live cadence and single-flight are human items); SC2 UNCERTAIN on the owner-held bound reading and post-flush audit policy, and on the R8 operator assertion; D78-5 and the audit second writer are owner-ratified in docs; 4 live proofs human_needed
tree: /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 79b3ba32
criteria_source: this tree's ROADMAP, Phase 78 success criteria (lines 1354-1355). Identical to origin/main lines 1350-1351. The Status line differs from origin/main ("Not started"); this tree's line is used and reported stale (W11), not chosen silently
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
    ".planning/phases/78-cross-layer-reconciliation/78-CONTEXT.md",
    ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md",
    "docs/mcp-audit.md",
    "docs/reconcile.md",
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
covered_digest: "v3:sha256:149e1d1a6e85a43ecdc7d7560de2606d1bddfa26d5293b2a5e9e6c8acae2e8de"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at tree 9ee12695, status human_needed, 1/2, SC2 UNCERTAIN (owner-held: D78-5, R3 per-key form, R8, single-writer statement, post-flush record placement, bound reading)"
  selection: "Step 0 selects initial mode, because the prior record has no `gaps:` key. The prior record is used as the checklist of claims and carried residuals. Source of change is commit 79b3ba32 (owner decisions 2026-11-03)."
  gaps_closed:
    - "D78-5 (warning 2, whole-prefix flush and three ordered passes): owner-ratified as the design of record, docs/reconcile.md:48, 2026-11-03. This closes the owner ratification request. The code is unchanged and matches the ratified design (reconcile-repair.ts:272-276)"
    - "Audit single-writer statement (open decision): docs/mcp-audit.md:37-38 records the repair execute as an owner-approved second writer, 2026-11-03, conditioned on --server-stopped. The docs are closed. The code comment at packages/audit/src/log.ts:1-8 still states the old sentence (warning 12)"
  gaps_remaining:
    - "Bound reading, total per run versus per kind (owner-held, kept as recorded): docs/reconcile.md:46; corpus-sync.md:70 says 'of each'"
    - "Post-flush audit policy (owner-held, kept as recorded): mcp-audit.md:37-38 and reconcile.md:79 state a failed append exits 1 after the flush; corpus-sync.md:75-76 still says the execute is fail-closed"
    - "R8: --server-stopped is an operator assertion, not checked by code (reconcile-main.ts:98-99; reconcile-repair.ts:252-259)"
    - "Code and test gaps: unreadable plan writes no audit record (reconcile-main.ts:240-248, warning 7c); set-but-unwritable chain path untested (warning 9); counter-cut same-plan refusal untested (documented at reconcile.md:57, warning 8)"
    - "Live proofs (human items 1 to 4)"
  regressions: []
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4068-4071, reconcilePass ??=)"
    test: "Start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture. Start a second tick while the first is in flight (or force one with a slow ledger read)"
    expected: "Exactly one run is in flight. The second tick returns the in-flight promise and writes no second line. Neither run writes to the ledger, the index or the cache"
    why_human: "No test covers the guard. The interval cadence is real time and no test fires setInterval. This is an ordering invariant that presence and wiring cannot show"
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval cadence is real time and no test fires the interval. The single-flight guard has no test"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run); then repair --plan <file> --execute --server-stopped; then a second execute. If the bound cut into the counter pass, plan again and repair again"
    expected: "The dry run writes nothing and its reason states the one-run split. The execute removes at most 500 keys: answers first, then generation counters, then the forget mark; budget: and emb: keys are kept. <plan>.result.json holds planned, removed, remaining, limit and truncated (no listed or repaired). One audit record is appended with outcome, counts and plan_digest. A prefix above 1000000 keys refuses with nothing removed"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores and a real audit file: report; repair --plan <file> --execute without --server-stopped (exit 2); repair --plan <file> --execute --server-stopped without SUBSTRATE_AUDIT_PATH (exit 2, nothing flushed); the execute with SUBSTRATE_AUDIT_PATH set; then restart substrate-mcp and verify the audit chain"
    expected: "Exit codes match docs/reconcile.md:66-68. The chain verifies after the restart, with the repair record in place and a continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest"
    why_human: "Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence that the owner's second-writer approval depends on, and of the R8 assertion"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-03T03:02:15Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 9ee12695. Step 0 selected initial mode (no `gaps:` key in the prior record); the prior record is the checklist of claims and residuals.
**Scope:** integration tree at HEAD 79b3ba32. Procedure: gsd-verifier, goal-backward. Live proofs are operator items. Owner-held readings stay as recorded.

## What changed since 9ee12695

- **No phase 78 implementation file changed.** `git diff --stat 9ee12695 HEAD` over `reconcile*.ts`, `reconcile-main.ts`, `observe.ts`, `service.ts`, `config.ts`, `cache.ts`, `index-store.ts`, `packages/audit/src/log.ts`, `packages/corpus/src/protocol.ts` and `scripts/reconcile.ts` is empty. Code citations carry from the prior record; spot-checks this pass matched (`RECONCILE_MAX_ITEMS` reconcile-repair.ts:11, :86; `openRepairAudit` reconcile-main.ts:135; `recordRepair` :156; the repair append :260; the scheduled single-flight `reconcilePass ??=` service.ts:4068-4071).
- **Docs changed (owner commit 79b3ba32, "owner decisions 2026-11-03"):** `docs/reconcile.md` gained line 48 (D78-5 ratified as the design of record, owner, 2026-11-03). `docs/mcp-audit.md` gained lines 37-38 (the repair execute is an owner-approved second writer, conditioned on `--server-stopped`; a failed append after the flush exits 1). Line numbers in `docs/reconcile.md` after line 46 moved by +2; this record uses the current numbers.
- **Phase 72 files changed in the same range** (`repo-scope.ts`, `repo-executor.ts`, `corpus/src/discover.ts`). `service.ts` and `config.ts` import `repo-scope.ts` (service.ts:179, config.ts:38), so a28ecac8 touches that import chain. No reconcile-specific file imports it. The reconcile-named tests in command 2 (config.test.ts and service.test.ts filters) pass at HEAD. `repo-scope.ts`'s own tests were not run in this pass. Phase 72 decisions are outside this record.
- **Tree state:** the worktree has one uncommitted edit besides this record: `.planning/phases/76-telemetry-buffer-and-dead-letter/76-VERIFICATION.md`. It predates this pass, is not this phase's, and was not read or changed.

## Criteria and conflicts

- **Criteria source:** this tree's ROADMAP Phase 78 section, success criteria at lines 1354-1355. The text is identical to origin/main lines 1350-1351.
- **Status line, reported not chosen:** this tree's ROADMAP line 1348 says `owner items open: D78-5, audit-chain single-writer statement, post-flush audit failure policy, bound reading`. D78-5 and the second writer are now ratified or approved in the docs, so that line is stale on two items (warning 11). origin/main says `Not started`.
- **Requirement mapping:** HARD-H2 (REQUIREMENTS.md:125) maps to phase 78. Its checkbox is unticked and its table row (:140) says `Not started`. PLAN 78-01 has no `requirements:` field and no `must_haves:` block. Result: ORPHANED under Step 6c (see Requirements coverage).
- **Plan must-haves:** none. `verify.artifacts` and `verify.key-links` both exit 66 (`NO_INPUT`: the plan declares no must_haves). Steps 4 and 5 are not applicable and nothing was marked VERIFIED from them. Wiring is checked by hand below.
- **Naming deviation carried:** CONTEXT D78-6 names the window field `window`; the code writes `window_hours` (reconcile-repair.ts:45, :125-145).

## Must-haves

| # | Criterion (this tree's ROADMAP) | Verdict | Evidence on 79b3ba32 |
| - | ------------------------------- | ------- | -------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by named tests (re-observed this pass). Live cadence and single-flight: human | Counts reconcile-run.ts:55-96. First key reconcile.ts:193-194, :205-209. Comparators reconcile.ts:82-119 (lease), :129-153 (memory), :162-174 (generation). Scheduled line service.ts:4089-4090. Tick writes one stdout line; stderr only on skip or failure (service.ts:4075-4094). Report path is read-only: `queryEvents` SELECT (greptime.ts:1519-1538), index SELECTs (index-store.ts:2924-2981), cache SCAN (cache.ts:1061-1079) |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (WARNING). R1 to R9 hold as ruled, with R3 now owner-ratified. Held open as recorded: bound reading, post-flush audit policy. R8 is an operator assertion | Separate `repair` subcommand, dry run by default (reconcile-main.ts:92-101; reconcile-repair.ts:243-251). Execute needs `--server-stopped`, usage error exit 2 before any client (reconcile-main.ts:98-99). Plan record `planFromReport` (reconcile-repair.ts:125-145), written with `wx` (reconcile-main.ts:235). Digest recheck (reconcile-repair.ts:210-216). Orphan recheck (:217-222). Audit record (reconcile-main.ts:156-171, :259-260) |

**Must-haves: 1 of 2 verified in code.** No truth FAILED. The human items are non-empty, so the status is `human_needed` (Step 9, rule 2). SC2 is UNCERTAIN, not FAILED.

## SC2: the corpus delete rules, point by point

The rules are in `docs/runbooks/corpus-sync.md` (§2 lines 60-79; §5 lines 115-121). The bound is `RECONCILE_MAX_ITEMS = 500` in `packages/corpus/src/protocol.ts:262`.

| # | Corpus rule | Reconcile evidence on 79b3ba32 | Verdict |
| - | ----------- | ------------------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | Dry run is the default (reconcile-repair.ts:243-251; reconcile-main.ts:98-101). Read-only SCAN (:226), then writes nothing. Not audited (warning 7b) | MET |
| R2 | Explicit execute | `--execute --server-stopped` (reconcile-main.ts:98-99) | MET |
| R3 | Act only on what the plan names; a key an active row holds is kept | Plan pinned by digest and by live orphan set (reconcile-repair.ts:210-222). The flush selects by class, not by named key: answer classes (:24-31, :168-179), every `gen` counter, the mark. The divergence from the per-key text is now **ratified** as D78-5 (docs/reconcile.md:48, owner, 2026-11-03) | MET as ratified design of record (D78-5). The code is unchanged |
| R4 | A delete confirmed by the store; an unconfirmed delete is not counted | `removed` is the UNLINK count per batch (reconcile-repair.ts:264-271); the count is the server's reply (cache.ts:1087-1102) | MET |
| R5 | At most 500 per run (corpus: "at most 500 of each") | One run removes at most `RECONCILE_MAX_ITEMS` keys across the three passes: `boundPasses` takes the first 500 keys in pass order (reconcile-repair.ts:185-192, :240); `truncated` is `planned > limit` (:87). The owner's text is "keys per run" (total), which the code follows. The corpus "of each" reading stays **open as recorded** | MET as the owner ruled; bound reading held open |
| R6 | `repaired` read against the listed items in one unit | `planned`, `removed` and `remaining` are all cache keys (reconcile-repair.ts:56-67; :239). `listed` and `repaired` are gone from source and docs | MET as the owner ruled |
| R7 | Audit: the dry run is audited (fail-open); the execute is audited (fail-closed) | One record per execute: tool `reconcile_repair`, surface `operator`, transport `internal`, `decision` allowed or denied, `reason` with `outcome`, `planned`, `removed`, `remaining`, `limit`, `plan_digest` (reconcile-main.ts:260), `report_digest` (reconcile-main.ts:156-171). Owner decision 6 text scopes R7 to the execute. Residuals: post-flush placement (held as recorded); unreadable plan writes none (warning 7c) | MET for the execute as the owner ruled; residuals listed |
| R8 | Serialised with ingest by the corpus lock | `--server-stopped` is an operator assertion (reconcile-main.ts:98-99; reconcile-repair.ts:252-259). Not checked by code. The second-writer approval (mcp-audit.md:37) depends on it | OPEN: operator assertion, proof is human item 4 |
| R9 | A re-run is safe: a second run finds nothing | A second execute after a full flush is refused with no orphans (reconcile-repair.ts:217-220); test reconcile-repair.test.ts:197 | MET |

**Reading:** R1, R2, R3 (ratified), R4, R5 (total reading), R6 and R9 hold. R7 holds for the execute with the residuals in warning 7. R8 is an operator assertion. SC2 stays UNCERTAIN because the bound reading and the post-flush audit policy are kept as recorded, and R8 is open.

## Owner ratifications, checked against the docs

| Item | Where recorded | Verdict on 79b3ba32 |
| ---- | -------------- | ------------------- |
| D78-5: whole-prefix flush and three ordered passes | `docs/reconcile.md:48`: "ratified as the design of record (D78-5), owner, 2026-11-03" | Documented ratification. The code matches the ratified design (reconcile-repair.ts:272-276). Closed as design of record. Ratification does not change the code |
| Audit second writer | `docs/mcp-audit.md:37`: "approved second writer ... only with the server stopped ... Owner-approved, 2026-11-03". `docs/reconcile.md:81` matches | Documented approval, conditioned on R8. Closed in docs. The chain header (`packages/audit/src/log.ts:1-8`) still says `substrate-mcp` is the only writer (warning 12) |
| Post-flush audit policy | `docs/mcp-audit.md:37-38`: a failed append after the flush exits 1, the flush has already run. `docs/reconcile.md:79` and exit codes `:68` match | **Kept as recorded: owner-held.** The text is in the same approved paragraph, but the corpus runbook still reads fail-closed (corpus-sync.md:75-76). This pass does not treat the post-flush placement as accepted |
| Bound reading: total per run or per kind | `docs/reconcile.md:46`: "at most 500 keys per run" | **Kept as recorded: owner-held.** The corpus text is "of each" (corpus-sync.md:70) |

## Owner decision 6: the bound, the unit and the audit record, checked point by point

| Requirement (owner decision 6) | Code | Named test (re-run this pass) | Verdict |
| ------------------------------ | ---- | ----------------------------- | ------- |
| R5: at most 500 keys per run, reporting planned, removed, remaining and truncated | reconcile-repair.ts:11, :56-67, :87, :185-192, :239-241, :290-300 | reconcile-repair.test.ts:402 "a run removes at most the corpus bound of keys and reports the remainder" | VERIFIED (command 1, 28 pass) |
| R5: a second run with the same plan finishes the remainder | reconcile-repair.ts:210-222 (digest and orphan recheck before the flush) | reconcile-repair.test.ts:424 "a second run with the same plan removes the remainder, counter and mark last". Covers only an answer-pass cut (warning 8) | VERIFIED for the answer-cut case; the counter-cut case is refused and needs a re-plan (warning 8, documented at reconcile.md:57) |
| R6: one unit for planned, removed and remaining | reconcile-repair.ts:56-67, :239, :285-300 | reconcile-repair.test.ts:169 (exact shape `planned: 5, removed: 5, remaining: 0`) | VERIFIED (command 1) |
| R7: one audit record per execute, with plan digest, counts and outcome | reconcile-main.ts:156-171 (record), :259-260 (append after flush), :203-212 (durable check before flush) | reconcile-main.test.ts:176 "one repair execute writes exactly one audit record, carrying the plan digest and the counts" | VERIFIED for an execute that reaches the plan parse (command 1) |
| Execute exits 2 with no durable audit chain, nothing flushed | reconcile-main.ts:203-212; `openRepairAudit` :135 | reconcile-main.test.ts:199 "a repair execute with no durable audit chain exits 2 and flushes nothing" (unset path) | VERIFIED for the unset path (command 1). The set-but-unwritable path is untested (warning 9) |

## Sub-checks, by test (re-observed this pass)

Two targeted commands, both with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, run from `packages/mcp-server`. No Postgres container started; no PG-gated test in the filters.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test reconcile-repair.test.ts reconcile-main.test.ts` | **28 pass, 0 fail**, 131 expect calls, 805 ms. Covers the whole repair and CLI files: planFromReport, findingsDigest, executePlan, reconcileMain, including every R5, R6 and R7 named test above |
| 2 | `bun test reconcile.test.ts reconcile-read.test.ts service.test.ts config.test.ts -t "a clean fixture reports clean\|a dirty fixture reports\|with the cache off\|unlink runs in batches\|a capped cache scan\|scheduled reconcile timer\|SUBSTRATE_RECONCILE\|no findings and no truncation is clean\|first is the first finding\|end to end: comparator\|unchecked layers are reported"` | **21 pass, 0 fail**, 493 filtered out, 94 expect calls, 12 files |

Counts match the prior record (28 and 21). The single-flight guard has no test and was not exercised.

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Scheduled tick on a clean fixture logs one clean line and writes nothing | PASS (by test) | command 2, "scheduled reconcile timer" |
| Clean fixture is clean, nothing written | PASS | reconcile-read.test.ts:343 (command 2) |
| Dirty fixture reports the first mismatching key per comparison | PASS | reconcile-read.test.ts:362 (command 2) |
| Cache off: layer unchecked, absent from counts, not clean | PASS | reconcile-read.test.ts:391 (command 2); reconcile.test.ts:188 |
| A capped cache scan makes the run unclean | PASS | reconcile-read.test.ts:381 (command 2) |
| Unlink runs in batches of at most 500; a failed batch keeps earlier batches | PASS | reconcile-read.test.ts:280, :288 (command 2). Code cache.ts:1087-1102 |
| Comparators and buildReport (first key, clean) | PASS | reconcile.test.ts, "first is the first finding" and "end to end" (command 2) |
| Config: SUBSTRATE_RECONCILE interval and window clamps | PASS | config.test.ts "SUBSTRATE_RECONCILE" (command 2) |
| Execute removes answers, then counters, then the mark; budget and emb untouched | PASS | reconcile-repair.test.ts:169 (command 1) |
| Second execute after a full flush is a refused no-op | PASS | reconcile-repair.test.ts:197 (command 1) |
| Truncated or incomplete scan removes nothing | PASS | reconcile-repair.test.ts:209 (command 1) |
| Failure in the answer, counter or mark pass keeps later keys | PASS | reconcile-repair.test.ts:230, :249, :271 (command 1) |
| Failed batch keeps the count of earlier batches | PASS | reconcile-repair.test.ts:354 (command 1) |
| Execute without `--server-stopped` refuses and removes nothing | PASS | reconcile-repair.test.ts:291; reconcile-main.test.ts:159 (command 1) |
| `--server-stopped` with another command exits 2 | PASS | reconcile-main.test.ts:168 (command 1) |
| Failed flush exits 1 and writes the result file with the error | PASS | reconcile-main.test.ts:106 (command 1); reconcile-main.ts:264-277 |
| Only destructive call is `unlinkKeys` | PASS by reading | reconcile-repair.ts:264-271 is the only caller; it runs after the server-stopped gate (:252-259) |
| Flush excludes `budget:` and `emb:` and any unnamed key | PASS by reading | `FLUSH_ANSWER_CLASSES` :24-31; `flushPasses` :168-179 |
| Dry run reads with SCAN and refuses on a truncated scan | PASS by reading | reconcile-repair.ts:226-233, before the dry-run return at :243 |

**Counter-cut probe (carried from 9ee12695, not re-run this pass).** Two-command limit; the source files are unchanged since 9ee12695, so the result stands. Fake cache with 499 `brief:` keys and 3 `gen:graph:` counters: first execute planned 502, removed 500, remaining 2, truncated true. The second execute with the same plan is refused by the digest check (reconcile-repair.ts:210-216), planned 0, removed 0. Documented at reconcile.md:57.

## Behavioral spot-checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Repair `--execute` without `--server-stopped` exits 2 before any connection | command 1 (reconcile-main.test.ts:159) | pass | PASS (by test) |
| R5 bound: removes at most 500 of 601 and reports remainder | command 1 (reconcile-repair.test.ts:402) | pass | PASS (by test) |
| One audit record per execute, with plan digest | command 1 (reconcile-main.test.ts:176) | pass | PASS (by test) |
| Scheduled tick on a clean fixture writes nothing | command 2 ("scheduled reconcile timer") | pass | PASS (by test) |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report, scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

## Probe execution (Step 7c)

No `scripts/*/tests/probe-*.sh` exists for this phase, and no PLAN or SUMMARY declares a probe. Skipped: no probes declared.

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED (mechanics, R5 bound, R6 unit); D78-5 now ratified; audit residuals held | Result shape :56-67; `repairOutcome` :70-91; `planFromReport` :125-145; `planRefusal` :151-162; `flushPasses` :168-179; `boundPasses` :185-192; `executePlan` :204-301 |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED (R7 record, durable check, exit codes); residuals held | Execute gate :98-99; `openRepairAudit` :135; `recordRepair` :156-171; repair append :259-260; `reconcileMain` :177-285 |
| `packages/mcp-server/src/observe.ts` | VERIFIED | `openAuditLog` :294-296, the server's factory; the CLI builds the chain the same way |
| `packages/audit/src/log.ts` | VERIFIED as the chain's sink. **Header stale** (warning 12) | Header :1-8 states `substrate-mcp` is the only process that writes it. The checkpoint sibling file (`<path>.checkpoint`) is described at :14, with contradiction detection at :78. [INFERENCE] from the header: a stale live writer would meet a checkpoint mismatch rather than silently fork the chain. Not reproduced |
| `packages/mcp-server/src/reconcile-run.ts`, `reconcile.ts`, `reconcile-read.ts`, `service.ts`, `config.ts`, `cache.ts`, `index-store.ts` | VERIFIED for SC1; unchanged since 9ee12695 | `git diff --stat 9ee12695 HEAD` empty on all of them |
| `docs/reconcile.md` | VERIFIED accurate to the code. Ratification line 48 added | Bound :46; ratification :48; server stopped :54; re-run continues :57; exit codes :68; audit record :72-81; single writer :81 |
| `docs/mcp-audit.md` | VERIFIED as documentation. Second-writer approval :37-38 added. Single-writer sentence at :33-35 still precedes it | :33-35 (unchanged); :37-38 (added, owner-approved, 2026-11-03) |
| `docs/runbooks/corpus-sync.md` | VERIFIED as the rule source (unchanged) | §2 :60-79 (bound :70; audit :75-76); §5 :115-121 |
| Test files | VERIFIED | command 1 (28 pass) and command 2 (21 pass) |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, `process.exit(code)` | WIRED | |
| `reconcileMain` | `parseReconcileArgs` | before `loadConfig` (reconcile-main.ts:183, :191) | WIRED | usage errors exit 2 before config |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (reconcile-main.ts:203-212) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (reconcile-main.ts:251) | WIRED | |
| `reconcileMain` (execute) | `recordRepair` | after `executePlan`, before the result is printed (reconcile-main.ts:259-260) | WIRED; post-flush placement is held as recorded | |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (reconcile-repair.ts:264-276) | WIRED | |
| `executePlan` | `runReport` | re-run before any write (reconcile-repair.ts:209) | WIRED | |
| `startRecall` | `startReconcile` | service.ts:4034-4038 | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (service.ts:4068-4071) | WIRED; single flight untested | |
| `runReport` | `cache.scanKeys` | class and generation scans (reconcile-run.ts:85-90) | WIRED | |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents` (greptime.ts:1519-1538), index SELECTs (index-store.ts:2924-2981) and cache SCANs (cache.ts:1061-1079), combined at reconcile-run.ts:55-96. The flush reads live `substrate:v1:*` keys and removes only the classes it names (reconcile-repair.ts:226-276). The audit record's counts come from the `RepairResult` the flush returns (reconcile-main.ts:156-171). No hardcoded result feeds these values.

## Requirements coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence (below). The checkbox is unticked and the table row says `Not started` (:140) | Bounded: window 1 to 168 h, scan cap, `RECONCILE_MAX_ITEMS`. Read-only: report path SELECT and SCAN only. Unavailable: unchecked layers and truncated scans make the run unclean (reconcile-run.ts:91-97). No automatic mutation: repair is a separate confirmed step. Owner or orchestrator to decide: claim it in a plan, or tick the box and update the row |

## Anti-patterns (Step 7)

Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER, "coming soon", "not yet implemented") over the phase 78 implementation files and `docs/reconcile.md` and `docs/mcp-audit.md`: no matches. No debt-marker gate fires. No stub, placeholder or no-op found. Re-verification evidence gate (Step 7): no 🛑 Blocker raised in this pass.

## Deferred items (Step 9b)

None. No later v1.8 phase exists in the ROADMAP (no phase 79 or later section). HARD-R1 (phase 74) is scheduled after v1.8 by owner decision and is unrelated to these gaps.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard have no test. This is also the behavior-unverified item.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts. Dry run, then execute with `--server-stopped`, then a second execute; if the bound cut into the counter pass, plan again and repair again. Expected as in the frontmatter. Why human: H5 cost and behaviour at scale.
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores and a real audit file.** Expected: exit codes per docs/reconcile.md:66-68; `--execute` without `--server-stopped` exits 2 before any connection; `--execute --server-stopped` without `SUBSTRATE_AUDIT_PATH` exits 2 with nothing flushed; with the path set, the execute appends one record. After a `substrate-mcp` restart the chain verifies, with the repair record in sequence. Why human: needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This is the only proof of the single-writer sequence that the owner's second-writer approval depends on, and of R8.

## Warnings (non-blocking)

1. **Repair result units (R6): RESOLVED by owner decision 6.** `planned`, `removed` and `remaining` count keys (reconcile-repair.ts:56-67).
2. **Flush scope, whole prefix (D78-5): RESOLVED as design of record.** Owner ratification 2026-11-03, docs/reconcile.md:48. The code is unchanged and matches the ratified design.
3. **No tick test runs a cache-off fixture: unchanged.** The cache-off line is covered by runReport (reconcile-read.test.ts:391).
4. **Advisory: index read cost: unchanged.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a batch (index-store.ts:2924-2934). [INFERENCE from the SQL; not measured]
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report: unchanged.** A truncated report can still produce a plan (reconcile-run.ts:88-90). The flush is fail-closed on its own 1000000-key scan (reconcile-repair.ts:226-233).
6. **Per-run bound, total or per kind: OPEN, kept as recorded (owner-held).** Implemented as a total (reconcile-repair.ts:185-192, :240). The corpus text says "of each" (corpus-sync.md:70).
7. **Audit record (R7) residuals:**
   - (a) **Post-flush placement: OPEN, kept as recorded (owner-held).** The durable check runs before the flush (reconcile-main.ts:203-212); the append runs after it (:259-260). A failed append leaves the flush done, and the run exits 1 with `the repair ran, but its audit record was not written` (:270-273). The approved text (mcp-audit.md:37-38) and reconcile.md:79 state this. Corpus-sync.md:75-76 still says fail-closed. This pass does not accept the reading.
   - (b) **Dry run not audited.** Owner decision 6 text scopes R7 to the execute. Carried; the corpus rule audits the dry run as fail-open.
   - (c) **Unreadable plan writes no record: OPEN code gap, untested.** An `--execute` whose plan cannot be read or parsed returns 1 before `executePlan` (reconcile-main.ts:240-248), with no audit record and no flush. Read literally, this breaks "one audit record per repair execute". Fix: write the record on that path too, with a reason that names the parse failure.
   - (d) **Single writer: RESOLVED in docs** by the owner approval (mcp-audit.md:37-38, 2026-11-03), conditioned on R8. See warning 12 for the code header.
8. **Second run with the same plan, counter cut (R5): documented, test gap OPEN.** The digest refusal (reconcile-repair.ts:210-216) is documented at reconcile.md:57 and in the reason string (:299). The named test (reconcile-repair.test.ts:424) covers only the answer-cut case. Recommend a test for the counter-cut refusal, plus re-plan-then-finish.
9. **Set-but-not-durable chain path untested: OPEN, minor.** The unset path is tested (reconcile-main.test.ts:199). An unwritable `SUBSTRATE_AUDIT_PATH` takes the same branch (reconcile-main.ts:207-211) and is not tested.
10. **Cache layer reported unchecked, not zero: recorded** (78-SUMMARY.md; STATE owner decision 2). The code matches (reconcile-run.ts:91-97). Open for the owner, unchanged.
11. **ROADMAP Status line stale: NOT EDITED HERE.** ROADMAP.md:1348 and the table row still list D78-5 and the audit-chain single-writer statement as owner items open. Both are now ratified or approved in the docs (79b3ba32). The owner or orchestrator should reconcile the line.
12. **Chain header stale vs the approved second writer: NEW, NOT EDITED HERE.** `packages/audit/src/log.ts:1-8` still says `substrate-mcp` is the only process that writes the chain. The owner approval (mcp-audit.md:37) allows a repair execute as a second writer under `--server-stopped`. The code comment should carry the approval. No code edits in this pass.
13. **HARD-H2 orphaned: NEW, NOT EDITED HERE.** REQUIREMENTS.md:125 is unticked; the row at :140 says `Not started`; PLAN 78-01 declares no requirements. The clauses have implementation evidence (see Requirements coverage).

## Info (non-blocking)

- **Window-edge false drift (carried advisory, not reproduced).** A write whose memory row is created before the window start but whose audit event is stamped after it appears as an accepted audit event with no index row. Both sides use one `sinceIso` (reconcile-run.ts:51). The row is inserted in `governMemoryWrite` and its audit is awaited before the reply (service.ts:3259, :3289). [INFERENCE from code order; not reproduced]
- **Dry-run `remaining` reads equal to `planned`** (carried). The field is defined as `planned - removed`, with removed 0 in a dry run (reconcile-repair.ts:51-54). The reason string states the one-run split. A reader comparing a dry run with the post-run figure will read it wrong.

## Open decisions (kept as recorded)

- **Bound reading: total per run or per kind.** Owner-held. Kept as recorded. The docs (reconcile.md:46) follow the owner's total reading. The corpus text (corpus-sync.md:70) says "of each".
- **Post-flush audit policy.** Owner-held. Kept as recorded. The text is in the approved paragraph (mcp-audit.md:37-38), and the corpus runbook (corpus-sync.md:75-76) still says fail-closed.
- **R8, `--server-stopped` as an operator assertion.** Open. The code cannot check the server is stopped (reconcile-main.ts:98-99; reconcile-repair.ts:252-259). The proof is human item 4.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; docs/reconcile.md:70; STATE owner decision 3. Open for the owner.
- **Cache layer unchecked, not zero.** Recorded (warning 10). Open for the owner.
- **Stale status records:** ROADMAP.md:1348 and table row; REQUIREMENTS.md:125 and :140 (warnings 11 and 13). Owner or orchestrator to reconcile.

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED. SC1 is verified in code and by named tests on 79b3ba32, with the live cadence and single-flight guard as human items. SC2's mechanics are verified; R1 to R9 hold as ruled, with R3 now owner-ratified through D78-5. SC2 stays UNCERTAIN on the bound reading and the post-flush audit policy, which are kept as recorded, and on R8, an operator assertion.

**Status:** `human_needed`, from the four live proofs, the single-flight item, and the owner-held readings. Warnings 1 to 13 do not change the status.

## Summary claims checked (78-SUMMARY.md, 1633fecf, 9ee12695 and 79b3ba32 commit messages)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| D78-5 whole-prefix flush and three ordered passes are the design of record | TRUE, as the owner's documented ratification | docs/reconcile.md:48 (owner, 2026-11-03); code reconcile-repair.ts:272-276 |
| Repair execute is an owner-approved second writer, under `--server-stopped` | TRUE as documentation; the code header still says single writer (warning 12) | docs/mcp-audit.md:37-38; packages/audit/src/log.ts:1-8 |
| R5: at most 500 keys per run, remainder reported | TRUE | reconcile-repair.ts:185-192, :240, :290-300; reconcile-repair.test.ts:402 (command 1, pass) |
| R6: one unit in the report | TRUE | reconcile-repair.ts:56-67; no `listed` or `repaired` in source or docs |
| R7: one audit record per execute with plan digest, counts and outcome | TRUE for the execute that reaches the plan parse | reconcile-main.ts:156-171, :259-260; reconcile-main.test.ts:176 (command 1, pass) |
| A repair execute with no durable chain exits 2 and flushes nothing | TRUE for the unset path | reconcile-main.ts:203-212; reconcile-main.test.ts:199 (command 1, pass). Set-but-unwritable untested (warning 9) |
| "A second run with the same plan removes the remainder" | TRUE for the answer-cut only | reconcile-repair.test.ts:424 (command 1, pass); counter-cut refusal documented at reconcile.md:57 (warning 8) |
| Gates green at 79b3ba32 | Orchestrator's evidence, not re-run. `/root/src/worktrees/backups/gates-int-r15.log`: line 7 `PG_READY ... head=79b3ba32`; line 8 `TSC_EXIT=0`; line 11 `LINT_EXIT=0`; lines 16570 and 16572 `12082 pass`, `0 fail`; line 16604 `PY_EXIT=0`; lines 16608-16609 `239 pass`, `0 fail`; line 16614 `GATES_DONE rc=0` | gates-int-r15.log |

---

_Verified: 2026-11-03T03:02:15Z_
_Verifier: Claude (gsd-verifier, re-verification at HEAD 79b3ba32). Verified by this pass: the git delta from 9ee12695 on every phase 78 implementation file (empty); the two docs diffs and their current line numbers; the ROADMAP criteria against origin/main; the two targeted `bun test` commands (28 and 21 pass); the artifact and key-link queries (exit 66, no must-haves); debt-marker and import-coupling scans; the fingerprint command. Carried from 9ee12695, not re-run: the counter-cut probe and the orchestrator's gate evidence (gates-int-r15.log)._
