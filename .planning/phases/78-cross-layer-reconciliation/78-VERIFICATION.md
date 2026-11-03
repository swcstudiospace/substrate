---
phase: 78-cross-layer-reconciliation
verified: 2026-11-03T12:42:29Z
status: human_needed
score: "1/2 must-haves verified; SC1 verified in code and by named tests (live cadence and single-flight are human items); SC2 UNCERTAIN (WARNING): the post-flush audit placement is owner-accepted (2026-11-03), documented in three places, and the code matches it; the unreadable-plan audit gap (7c) and the counter-cut test gap (8) stay open; 4 live proofs human_needed"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 6644698e"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (lines 1354-1355). Unchanged since f1854711"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-CONTEXT.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/corpus.md", "docs/mcp-audit.md", "docs/reconcile.md", "docs/runbooks/corpus-sync.md", "packages/audit/src/log.ts", "packages/audit/src/policy.ts", "packages/cli/src/corpus/render-sync.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.test.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:af18cb91a339d31a6b05bb36ec002b118ec13ca861d476cdfc96e9950648bd06"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at HEAD 97defd59: human_needed, 1/2, SC2 UNCERTAIN (post-flush audit placement open as recorded; unreadable-plan audit gap 7c; counter-cut test gap 8; R8 operator assertion; HARD-H2 ORPHANED)"
  selection: "Step 0: the prior record has no top-level gaps: key, so initial mode. The prior record is the checklist of claims and carried residuals."
  changed_since_previous: "Commits 97defd59..6644698e (2 commits, 18 files). 6644698e changes docs/runbooks/corpus-sync.md at one line (:76, the cache-repair cross-reference to the owner-accepted post-flush policy) and records the owner decisions. d23a919a changes event.ts, memo.ts, anchor.ts and their tests (lone surrogate refusal): not on the reconcile read or repair path. No reconcile*.ts, scripts/reconcile.ts, cache.ts, index-store.ts, server.ts, corpus/*.ts, policy.ts, packages/audit/src/log.ts, docs/reconcile.md or docs/mcp-audit.md file changed in the range (checked by name list and git diff --quiet)."
  gaps_closed:
    - "Post-flush audit placement (warning 7a at 97defd59): owner-accepted 2026-11-03 and documented at docs/mcp-audit.md:37, docs/reconcile.md:68 and :79, and docs/runbooks/corpus-sync.md:76. The code at reconcile-main.ts:259-272 matches the text. Closed as ratified design of record."
    - "Stale STATE citation (warning 15 at 97defd59): .planning/STATE.md no longer cites f1854711. Checked by grep, no match."
  gaps_remaining:
    - "Unreadable plan writes no audit record (warning 7c): reconcile-main.ts:242-248 returns 1 at :247 before executePlan and recordRepair. Code gap, untested. Unchanged."
    - "Counter-cut refusal untested (warning 8); set-but-unwritable chain path untested (warning 9). Unchanged."
    - "Operator items 1 to 4, including the R8 live proof that the server is stopped. Not run in this pass."
    - "HARD-H2 ORPHANED in REQUIREMENTS.md (warning 13): :125 unticked, :140 'Not started'. Unchanged at 6644698e."
    - "Stale status records: ROADMAP.md:1348 and :1426 still say the post-flush audit policy is open (warning 11, now partly stale). protocol.ts:261 comment still describes a per-list bound (warning 16). Owed by the orchestrator; no edits in this pass."
    - "Live items 1 to 4."
  gaps_new:
    - "No test covers the post-flush audit append failure (reconcile-main.ts:270-272, exit 1). The only exit-1 flush test is the flush failure (reconcile-main.test.ts:106). Non-blocking; the behaviour is documented and owner-accepted (warning 17)."
  regressions: []
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4197-4201, reconcilePass ??=)"
    test: "Start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture. Start a second tick while the first is in flight (or force one with a slow ledger read)"
    expected: "Exactly one run is in flight. The second tick returns the in-flight promise and writes no second line. Neither run writes to the ledger, the index or the cache"
    why_human: "No test covers the guard. The interval cadence is real time and no test fires setInterval. The only reconcileTick call in the tests is a single call (service.test.ts:6322). This is an ordering invariant that presence and wiring cannot show"
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
**Verified:** 2026-11-03T12:42:29Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 97defd59. Step 0 selected initial mode (no `gaps:` key); the prior record is the checklist.
**Scope:** integration tree at HEAD 6644698e, branch gsd/v18-int-all. Procedure: gsd-verifier, goal-backward. Focus: the post-flush audit policy, the corpus route's fail-closed audit, and whether the docs say the same as the code. Owner decisions in force (2026-11-03) applied as recorded. Live proofs are operator items. No code edits, no commits, no full suite, no tsc, lint or formatters. Two targeted `bun test` commands.

## Requested checks

| Check | Verdict | Evidence at 6644698e |
| ----- | ------- | -------------------- |
| Corpus route is fail-closed: audit before acting | PASS | `packages/mcp-server/src/server.ts:1782-1792`: the body is parsed, `execute = parsed.execute === true`, then `auditedRest(..., execute ? "corpus_ingest" : "corpus_status", ...)` runs at `:1789`, and `substrate.corpusReconcile` runs only after it returns true at `:1790`. `auditedRest` (`server.ts:703-714`) answers 503 and stops when the audit refuses. `auditRest` (`:661-692`) refuses a fail-closed tool when the audit throws. Dry run is `corpus_status` (fail-open, `policy.ts:131`); execute is `corpus_ingest` (`policy.ts:48`, not in the fail-open set; `auditMode` defaults to fail-closed, `policy.ts:144-147`). The mode table is asserted at `policy.test.ts:92` (read, not run). Test `corpus/routes.test.ts:332` (run, pass): an unwritable chain refuses execute with 503 and leaves the row active; the dry run still answers 200 |
| Handler and route agree on `execute` | PASS | `corpus/validate.ts:186-187`: a non-boolean `execute` is `bad-request`; otherwise `execute: raw.execute === true`. The route's `parsed.execute === true` (`server.ts:1788`) matches. A non-boolean value is audited as a dry run but refused by the handler before any action (`routes.test.ts:343`, run, pass). Nothing is changed |
| Repair execute exits 1 after its flush | PASS (code; no test on this branch) | `packages/mcp-server/src/reconcile-main.ts:203-212`: durable-chain check before any store client opens; not durable → exit 2, nothing flushed. `:251` `executePlan`. `:260` `recordRepair` after the flush. `:270-273`: append failure → stderr `the repair ran, but its audit record was not written` → return 1. `:264-268`: `<plan>.result.json` is written in `finally` whatever the outcome. No test reaches `:270-272` (warning 17) |
| Docs say the same: repair execute | PASS | `docs/reconcile.md:56` (non-durable chain → exit 2, flushes nothing); `:68` (exit 1 includes an audit record not written after the flush); `:79` (record written after the flush; if it cannot be written the flush has already run, exit 1, `<plan>.result.json` still holds the result); `:81` (repair is the second writer, run with the server stopped). `docs/mcp-audit.md:37` (approved second writer; a failed append after the flush exits 1; owner-approved 2026-11-03). `docs/runbooks/corpus-sync.md:75-76` (corpus `execute` is fail-closed; the cache repair is a different execute: a failed append exits 1 with the flush already run; owner-accepted 2026-11-03). No conflicting text found |
| Post-flush audit policy | RATIFIED (owner, 2026-11-03); closed as documented | Open at 97defd59 (warning 7a). 6644698e adds the cross-reference at `docs/runbooks/corpus-sync.md:76` (the one changed line in the runbook) and records the owner acceptance. Code unchanged since 97defd59 and matches the text. The corpus side and the cache side are kept distinct in the docs |
| Unreadable-plan audit gap (7c) | OPEN | `reconcile-main.ts:242-248`: an unreadable or unparseable plan writes `refused:` to stderr and returns 1 at `:247`, before `executePlan` and `recordRepair`. No audit record, no flush. Unchanged. Untested |
| Counter-cut test gap (8) | OPEN | `reconcile-repair.test.ts:424` ("a second run with the same plan removes the remainder, counter and mark last") is the answer-cut case: the first run stops inside the answers at 500, so no counter has gone. No test stops the first run inside the counter pass and checks that a re-run with the same plan is refused by the digest (`reconcile-repair.ts:210-216`, unchanged). Run: pass |
| Operator items (live proofs 1 to 4) | OPEN | Human items 1 to 4 below. None run in this pass |
| HARD-H2 | OPEN, ORPHANED | `.planning/REQUIREMENTS.md:125` unticked; `:140` "Not started". Both unchanged at 6644698e. The file changed elsewhere in the range (HARD-S2 row, `:134`) |

**Reading.** The corpus execute is fail-closed: the audit is written before the handler runs, and a refused audit stops it with no change. The repair execute writes its record after the flush, and a failed append exits 1. The owner accepted that placement on 2026-11-03. The code and the three documents say the same thing, and no doc contradicts the code. SC2 stays UNCERTAIN, not because of the post-flush placement, but because of 7c (and 8 and 9 remain test gaps). The status stays `human_needed` because of the four live proofs and the single-flight item.

## What changed since 97defd59

`git diff --name-only 97defd59..6644698e` lists 18 files in two commits. Those relevant to phase 78:

| File | Change | Phase 78 relevance |
| ---- | ------ | ------------------ |
| `docs/runbooks/corpus-sync.md` | 6644698e: one line, `:76`, adds the cache-repair cross-reference and the owner acceptance | **Yes.** The only doc text changed for the post-flush policy |
| `.planning/REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` | 6644698e and d23a919a bookkeeping | HARD-H2 lines unchanged. ROADMAP status text not updated (warning 11). STATE no longer cites f1854711 (warning 15) |
| `docs/greptime-ledger.md`; `packages/ledger/src/memo.ts`, `anchor.ts`, `event.ts` and their tests | d23a919a (lone surrogate refusal), 6644698e (ledger doc) | No. Not on the reconcile read or repair path |
| `packages/mcp-server/src/reconcile*.ts`, `scripts/reconcile.ts`, `cache.ts`, `index-store.ts`, `server.ts`, `corpus/*.ts`, `packages/audit/src/policy.ts`, `packages/audit/src/log.ts`, `docs/reconcile.md`, `docs/mcp-audit.md` | none in the range | Unchanged since 97defd59 (name list; `git diff --quiet` on `policy.ts`, `corpus/`, `server.ts` is empty) |

Covered digest: recomputed with `gsd-tools query verification.fingerprint` over the 24 prior files plus the 11 evidence files read in this pass, 35 in all, including this phase's own PLAN, CONTEXT and SUMMARY. `covered_digest` is `v3:sha256:af18cb91…`.

## Must-haves

| # | Criterion (this tree's ROADMAP) | Verdict | Evidence at 6644698e |
| - | ------------------------------- | ------- | -------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by named tests (carried from 97defd59). The live cadence and the single-flight guard are human items | Counts `reconcile-run.ts:55-96`. First key `reconcile.ts:193-194, :205-209`. Scheduled path `service.ts:4180` (`startReconcile`), `:4197-4201` (`reconcileTick`, single flight `??=`), `:4205` (`runScheduledReconcile`). Read-only: ledger `greptime.ts:1519-1538`, index SELECTs `index-store.ts:2924-2981`, cache SCAN `cache.ts:1061-1079`. The SC1 filter was not re-run in this pass; its sources are unchanged in the range |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (WARNING). R1 to R9 hold as ruled. The post-flush placement is ratified and documented. Open: the unreadable-plan audit gap (7c) and the counter-cut test gap (8). R8 is a documented operator assertion; its live proof is human item 4 | Separate `repair` subcommand, dry run by default (`reconcile-main.ts:98-101`; `reconcile-repair.ts:243-251`). Execute needs `--server-stopped`, usage error exit 2 before any client (`reconcile-main.ts:98-99`). Durable chain check before the flush (`reconcile-main.ts:203-212`). Plan record `planFromReport` (`reconcile-repair.ts:125-145`). Digest recheck and orphan recheck (`reconcile-repair.ts:210-222`). Flush and bound (`:185-192`, `:240`, `:264-276`). Audit after the flush (`reconcile-main.ts:259-273`) |

**Must-haves: 1 of 2 verified in code.** No truth FAILED. The human items are non-empty, so the status is `human_needed` (Step 9, rule 2). SC2 is UNCERTAIN, not FAILED.

## SC2: the corpus delete rules, point by point

The rules are in `docs/runbooks/corpus-sync.md` (§2 lines 45-79; §5 lines 115-121). The cache repair rules are in `docs/reconcile.md` (lines 36-68).

| # | Corpus rule | Reconcile evidence at 6644698e | Verdict |
| - | ----------- | ------------------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | Dry run is the default (`reconcile-repair.ts:243-251`; `reconcile-main.ts:98-101`). Read-only SCAN, then nothing is written. The cache dry run is not audited (owner decision 6 scopes R7 to the execute) | MET |
| R2 | Explicit execute | `--execute --server-stopped` (`reconcile-main.ts:98-99`). Corpus: `execute: true` in the body (`corpus/validate.ts:186-187`) | MET |
| R3 | Act only on what the plan names; a key an active row holds is kept | Plan pinned by digest and by live orphan set (`reconcile-repair.ts:210-222`). The flush selects by class, not by named key: answer classes, every `gen` counter, the mark. Ratified as D78-5 (`docs/reconcile.md:48`, owner, 2026-11-03). Corpus: an orphan an active row holds at that moment is kept (`docs/runbooks/corpus-sync.md:68`) | MET as ratified design of record (D78-5) |
| R4 | A delete confirmed by the store; an unconfirmed delete is not counted | `removed` is the UNLINK count per batch (`reconcile-repair.ts:264-271`); the count is the server's reply (`cache.ts:1087-1102`). Corpus: `repaired.deleted` counts confirmed deletes only (`corpus/reconcile.ts`, unchanged) | MET |
| R5 | Bound per run | One run removes at most `RECONCILE_MAX_ITEMS` keys across the three passes (`reconcile-repair.ts:185-192`, `:240`). Corpus: one total bound (`corpus/reconcile.ts:170-174`). Both total, as ruled | MET |
| R6 | `repaired` read against the listed items in one unit | `planned`, `removed` and `remaining` are all cache keys (`reconcile-repair.ts:56-67`; `:239`) | MET as the owner ruled |
| R7 | Audit: the dry run is audited (fail-open); the execute is audited (fail-closed) | Corpus: dry run under `corpus_status` (fail-open), execute under `corpus_ingest` (fail-closed), audited before the handler (`server.ts:1782-1790`; test `routes.test.ts:332`). Cache: one record per execute, `reason` with `outcome`, `planned`, `removed`, `remaining`, `limit`, `plan_digest` (`reconcile-main.ts:156-171`), written after the flush (`:260`); a failed write exits 1 (`:270-272`), owner-accepted (`docs/mcp-audit.md:37`). Residual: unreadable plan writes no record (7c) | MET for the execute as the owner ruled; 7c open |
| R8 | Serialised with ingest by the corpus lock | The cache flush is serialised by `--server-stopped`, an operator assertion stated in the chain header (`packages/audit/src/log.ts:1-9`). The code checks the flag, not the server state (`reconcile-main.ts:98-99`; `reconcile-repair.ts:252-259`). Corpus takes the ingest lock (`docs/runbooks/corpus-sync.md:76`) | CLOSED as a documented operator assertion (not as fact). Live proof open (human item 4) |
| R9 | A re-run is safe: a second run finds nothing | A second execute after a full flush is refused with no orphans (`reconcile-repair.ts:217-220`); test `reconcile-repair.test.ts:424` covers the answer-cut case | MET |

**Reading:** R1 to R6, R8 (as an operator assertion) and R9 hold. R7 holds for both the corpus execute and the cache execute, with the post-flush placement now owner-ratified. SC2 stays UNCERTAIN on the unreadable-plan audit gap (7c).

## Post-flush audit policy: what was checked

1. **Code.** `reconcile-main.ts:203-212` (durable check before any client), `:251` (flush), `:260` (append after the flush), `:270-273` (append failure → `return 1`), `:264-268` (`<plan>.result.json` in `finally`). The branch that returns 1 is the one the docs describe.
2. **Docs.** `docs/reconcile.md:56, :68, :79, :81`; `docs/mcp-audit.md:37`; `docs/runbooks/corpus-sync.md:75-76`. All four describe the same ordering: durable check before the flush, record after it, exit 1 when the record cannot be written, the flush already run, `<plan>.result.json` still written.
3. **Corpus route.** The route audit is fail-closed and precedes the handler (`server.ts:1782-1790`, `:703-714`). A refused audit answers 503 and changes nothing (`routes.test.ts:332`).
4. **Test coverage of this policy.** The durable-chain refusal is tested (`reconcile-main.test.ts:199`, pass). The single-record write is tested (`reconcile-main.test.ts:176`, pass). The flush-failure exit 1 is tested (`reconcile-main.test.ts:106`, pass). **The post-flush append failure exit 1 is not tested** (warning 17).

## Bound check (carried)

Corpus `reconcile.ts:170-174` and cache `reconcile-repair.ts:185-192` are both total. `docs/reconcile.md:46`, `docs/runbooks/corpus-sync.md:55` and `:70`, `docs/corpus.md:317`, `protocol.ts:278-279` and `render-sync.ts:101` say "in total". The only stale text is the constant's own comment at `protocol.ts:261` ("The most items `reconcile` lists in one list"), warning 16.

## Behavioral spot-checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Repair removes at most 500 keys of 601 and reports the remainder | `bun test src/reconcile-main.test.ts src/reconcile-repair.test.ts` (run 1) | 28 pass, 0 fail | PASS (by test) |
| Repair execute without a durable chain exits 2 and flushes nothing | run 1, `reconcile-main.test.ts:199` | pass | PASS (by test) |
| One audit record per execute, with plan digest and counts | run 1, `reconcile-main.test.ts:176` | pass | PASS (by test) |
| Corpus execute audited fail-closed: unwritable chain refuses with 503, row unchanged; dry run answers | `bun test src/corpus/routes.test.ts` (run 2), `:332` | 29 pass, 0 fail; stderr shows the expected refusal from the `ENOTDIR` test | PASS (by test) |
| Corpus execute audited under `corpus_ingest`; dry run under `corpus_status` | run 2, `:309` and `:332` | pass | PASS (by test) |
| Post-flush append failure exits 1 after the flush | none | no test | ? NOT TESTED (warning 17); by code only |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report, scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

Commands ran from `packages/mcp-server` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test … --timeout 30000`. No Postgres container started. No PG-gated test in the filters. The SC1 filter (`reconcile.test.ts`, `reconcile-read.test.ts`, `service.test.ts`, `config.test.ts`) was not re-run; its sources are unchanged in the range, so the 97defd59 result is carried as unchanged evidence.

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` for this phase; no PLAN or SUMMARY declares a probe. Skipped.

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED: durable check, flush, R7 record, post-flush exit 1; warning 7c open | `:203-212`; `:240-248` (unreadable plan, 7c); `:251`; `:259-273` |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED: mechanics, total bound, D78-5 ratified | `:56-67`; `:125-145`; `:185-192`; `:210-222`; `:240-251`; `:252-259`; `:264-276` |
| `packages/mcp-server/src/corpus/reconcile.ts` | VERIFIED: total bound | `:156`; `:170-174`; `:178-179` |
| `packages/mcp-server/src/corpus/validate.ts` | VERIFIED: `execute` boolean-only | `:182-188` |
| `packages/mcp-server/src/corpus/service.ts` | VERIFIED: reconcile reply; no audit inside the handler (the route audits) | `:251-278` |
| `packages/mcp-server/src/server.ts` | VERIFIED: route audit before the handler; 503 on refusal | `:661-692`; `:703-714`; `:1782-1792` |
| `packages/audit/src/policy.ts` | VERIFIED: `corpus_status` fail-open, default fail-closed | `:131`; `:144-147`; `:48` (read) |
| `packages/mcp-server/src/service.ts` | VERIFIED for SC1; reconcile block unchanged in range | `:4180`; `:4197-4201`; `:4205` |
| `packages/corpus/src/protocol.ts` | VERIFIED: constant, truncation comment; `:261` stale | `:261-262`; `:278-279` |
| `docs/runbooks/corpus-sync.md` | VERIFIED: corpus side fail-closed; cache cross-reference added | `:55`; `:70`; `:75-76` |
| `docs/reconcile.md` | VERIFIED: exit 1 after the flush | `:46`; `:56`; `:68`; `:79`; `:81` |
| `docs/mcp-audit.md` | VERIFIED: owner-approved second writer, exit 1 | `:37` |
| `packages/mcp-server/src/reconcile-main.test.ts`, `reconcile-repair.test.ts` | VERIFIED: 28 pass; no post-flush append test | run 1 |
| `packages/mcp-server/src/corpus/routes.test.ts` | VERIFIED: 29 pass; fail-closed corpus audit test | run 2, `:309`, `:332`, `:343` |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `server.ts` `/corpus/reconcile` | `auditedRest` | before `substrate.corpusReconcile` (`:1789-1790`) | WIRED | a refused audit answers 503, no handler call (`:712`) |
| `server.ts` `execute` detection | `validate.ts` `parseReconcileRequest` | `parsed.execute === true` (`:1788`) and `raw.execute === true` (`validate.ts:187`) | WIRED | a non-boolean is refused by the handler before any action |
| `corpus/reconcile.ts` `run` | `RECONCILE_MAX_ITEMS` | single total budget (`:172-173`) | WIRED | |
| `corpus/reconcile.ts` `run` | `deleteOrphans` and `requeue` | act only on the listed slices (`:178-179`) | WIRED | |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, `process.exit(code)` | WIRED | |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:203-212`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:251`) | WIRED | |
| `reconcileMain` (execute) | `recordRepair` | after `executePlan` (`:260`) | WIRED | |
| `reconcileMain` (append failed) | exit code | `:270-273` returns 1 | WIRED | not covered by a test (warning 17) |
| `reconcileMain` (unreadable plan) | `recordRepair` | none: returns 1 at `:247` | NOT WIRED (warning 7c) | no audit record on that path |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:264-276`) | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (`service.ts:4198`) | WIRED; single flight untested | |
| `runReport` | `cache.scanKeys` | class and generation scans (`reconcile-run.ts:85-90`) | WIRED | |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents` (`greptime.ts:1519-1538`), index SELECTs (`index-store.ts:2924-2981`) and cache SCANs (`cache.ts:1061-1079`), combined at `reconcile-run.ts:55-96`. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:226-276`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts:156-171`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:145-179`). No hardcoded result feeds these values.

## Requirements coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window `config.ts:1631-1638`, scan caps, `RECONCILE_MAX_ITEMS`, read-only report path, unclean on unavailable layers (`reconcile-run.ts:91-97`). The checkbox is unticked (`:125`) and the table row says `Not started` (`:140`); both unchanged at 6644698e. Owner or orchestrator to decide the status | Requirement status is an owner decision; this pass does not change it |

## Anti-patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`: none in `reconcile-main.ts`, `reconcile-repair.ts`, `corpus/validate.ts`, `corpus/service.ts`, `docs/runbooks/corpus-sync.md`, `docs/reconcile.md`, `docs/mcp-audit.md`. No debt-marker gate fires.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 files or the 6644698e doc change.
- **Doc-comment drift (minor).** `packages/corpus/src/protocol.ts:261` still describes the constant as a per-list bound. Warning 16.
- **Re-verification evidence gate (Step 7).** Initial mode (Step 0). No blocker raised by the evidence gate in this pass.

## Deferred items (Step 9b)

None, as at 97defd59. No later v1.8 phase exists in the ROADMAP section read for that record. HARD-R1 (phase 74) is scheduled after v1.8 by owner decision and is unrelated to these gaps.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard have no test. This is also the behavior-unverified item.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts. Dry run, then execute with `--server-stopped`, then a second execute; if the bound cut into the counter pass, plan again and repair again. Expected as in the frontmatter. Why human: H5 cost and behaviour at scale.
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores and a real audit file.** Expected: exit codes per `docs/reconcile.md:66-68`; `--execute` without `--server-stopped` exits 2 before any connection; `--execute --server-stopped` without `SUBSTRATE_AUDIT_PATH` exits 2 with nothing flushed; with the path set, the execute appends one record and exits 0. After a `substrate-mcp` restart the chain verifies, with the repair record in sequence. Why human: needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This is the only proof of the single-writer sequence the owner's second-writer approval depends on, and the only check that the server was in fact stopped during the execute. The code cannot make that check (R8 is an operator assertion).

## Warnings (non-blocking)

1. **Repair result units (R6): RESOLVED by owner decision 6.** `planned`, `removed` and `remaining` count keys (`reconcile-repair.ts:56-67`).
2. **Flush scope, whole prefix (D78-5): RESOLVED as design of record.** Owner ratification 2026-11-03, `docs/reconcile.md:48`. Code unchanged and matches.
3. **No tick test runs a cache-off fixture: unchanged.** The cache-off line is covered by `runReport` (`reconcile-read.test.ts:391`).
4. **Advisory: index read cost: unchanged.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a batch (`index-store.ts:2924-2934`). [INFERENCE from the SQL; not measured]
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report: unchanged.** A truncated report can still produce a plan (`reconcile-run.ts:88-90`). The flush is fail-closed on its own 1000000-key scan (`reconcile-repair.ts:226-233`).
6. **Per-run bound, total or per kind: RESOLVED.** Phase 78 is total (`reconcile-repair.ts:185-192`, `:240`; `docs/reconcile.md:46`). The corpus command is total (warning 14).
7. **Audit record (R7) residuals:**
   - (a) **Post-flush placement: RESOLVED, owner-ratified 2026-11-03.** The durable check runs before the flush (`reconcile-main.ts:203-212`); the append runs after it (`:260`); a failed append exits 1 with the reason (`:270-273`). The approved text is `docs/mcp-audit.md:37`, `docs/reconcile.md:68` and `:79`, and `docs/runbooks/corpus-sync.md:76`. The code matches.
   - (b) **Dry run not audited.** Owner decision 6 text scopes R7 to the execute. Carried.
   - (c) **Unreadable plan writes no record: OPEN code gap, untested.** An `--execute` whose plan cannot be read or parsed returns 1 before `executePlan` and before `recordRepair` (`reconcile-main.ts:242-248`), with no audit record and no flush. Read literally, this breaks "one audit record per repair execute". Fix: write the record on that path too, with a reason that names the parse failure. Not fixed here (no code edits in this pass).
   - (d) **Single writer: RESOLVED in docs and in the code header** by the owner approval (`docs/mcp-audit.md:37-38`, 2026-11-03), conditioned on R8. See warning 12.
8. **Second run with the same plan, counter cut (R5): documented, test gap OPEN.** The digest refusal (`reconcile-repair.ts:210-216`) is documented at `docs/reconcile.md:57` and in the reason string. The named test (`reconcile-repair.test.ts:424`) covers only the answer-cut case. Recommend a test for the counter-cut refusal, plus re-plan-then-finish.
9. **Set-but-not-durable chain path untested: OPEN, minor.** The unset path is tested (`reconcile-main.test.ts:199`). An unwritable `SUBSTRATE_AUDIT_PATH` takes the same branch (`reconcile-main.ts:207-211`) and is not tested.
10. **Cache layer reported unchecked, not zero: recorded** (78-SUMMARY.md; STATE owner decision 2). The code matches (`reconcile-run.ts:91-97`). Open for the owner.
11. **ROADMAP status text: STALE.** `ROADMAP.md:1348` and `:1426` still list the post-flush audit policy as open, and the phase 78 status line should now read the ratified placement. The bound item is correctly recorded as total. The orchestrator should update the ROADMAP text. This pass did not edit ROADMAP.
12. **Chain header vs the approved second writer: RESOLVED.** `packages/audit/src/log.ts:1-9` names `substrate-mcp` as the writer, the repair execute as the approved second writer, and states the stopped-server condition as an operator assertion.
13. **HARD-H2 orphaned: OPEN.** `REQUIREMENTS.md:125` is unticked; the row at `:140` says `Not started`. Unchanged at 6644698e. PLAN 78-01 declares no requirements.
14. **Corpus runbook bound versus corpus code: RESOLVED (d05ae871).** The corpus reconcile is one total bound (`corpus/reconcile.ts:170-174`), tested at `reconcile.test.ts:250-270`.
15. **STATE.md citations: RESOLVED.** `.planning/STATE.md` no longer cites f1854711 (grep, no match at 6644698e).
16. **Protocol constant comment: OPEN, minor.** `packages/corpus/src/protocol.ts:261` reads "The most items `reconcile` lists in one list; the counts always cover all of them." It describes a per-list bound; the behaviour and the `:278-279` comment are total. One comment line; not changed in this pass.
17. **NEW, minor: post-flush append failure is untested.** `reconcile-main.ts:270-273` (append failed after the flush → exit 1) has no test. The flush-failure exit 1 is tested (`reconcile-main.test.ts:106`); the audit-failure branch is not. The behaviour is documented and owner-accepted, so this is a test gap, not a code gap. Recommend a test that makes the append fail after a successful flush and asserts exit 1 with the flush's result file written.

## Info (non-blocking)

- **Window-edge false drift (carried advisory, not reproduced).** A write whose memory row is created before the window start but whose audit event is stamped after it appears as an accepted audit event with no index row. Both sides use one `sinceIso` (`reconcile-run.ts:51`). [INFERENCE from code order; not reproduced]
- **Dry-run `remaining` reads equal to `planned`** (carried). The field is defined as `planned - removed`, with removed 0 in a dry run (`reconcile-repair.ts:51-54`). The reason string states the one-run split.
- **Corpus response has no remainder count** (d05ae871 commit message: "left for a later change"). `drift.truncated` only.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; `docs/reconcile.md:70`; STATE owner decision 3. Open for the owner.

## Open decisions (kept as recorded)

- **Post-flush audit policy.** Owner-accepted 2026-11-03. Documented at `docs/mcp-audit.md:37`, `docs/reconcile.md:68` and `:79`, `docs/runbooks/corpus-sync.md:76`. Code matches. Closed as ratified.
- **Unreadable-plan audit gap (7c).** Open. Code change owed; the owner decides whether it is required before SC2 is verified.
- **Counter-cut test gap (8) and set-but-unwritable chain test gap (9).** Open. Test changes owed.
- **Operator items (human 1 to 4) and R8.** Not run here.
- **HARD-H2.** Orphaned in REQUIREMENTS.md (`:125`, `:140`). Requirement status is the owner's or orchestrator's to set.
- **Bound: total per run.** Closed for phase 78 and for the corpus command.
- **Cache layer unchecked, not zero.** Recorded (warning 10). Open for the owner.
- **Stale status records:** `ROADMAP.md:1348` and `:1426` (warning 11); `protocol.ts:261` comment (warning 16).

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED on the phase 78 SC1 path. SC1 is verified in code and by named tests, with the live cadence and single-flight guard as human items. SC2's mechanics are verified; R1 to R9 hold as ruled. The post-flush audit placement is owner-accepted and the code and the three documents agree. SC2 stays UNCERTAIN on the unreadable-plan audit gap (7c).

**Status:** `human_needed`, from the four live proofs and the single-flight item. Warnings 1 to 17 do not change the status.

## Summary claims checked (6644698e, 78-SUMMARY.md, and the phase 78 docs)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| The repair execute appends its audit record after the flush, and a failed append exits 1 | TRUE | `reconcile-main.ts:260`, `:270-273`; `docs/mcp-audit.md:37`; `docs/reconcile.md:68`, `:79`; `docs/runbooks/corpus-sync.md:76` |
| The corpus execute is audited fail-closed before it acts | TRUE | `server.ts:1782-1790`, `:703-714`; `policy.ts:131`, `:144-147`; `corpus/routes.test.ts:332` (run 2, pass) |
| The corpus dry run is audited fail-open | TRUE | `server.ts:1788-1789` (`corpus_status`); `policy.ts:131`; `corpus/routes.test.ts:335` (run 2, pass) |
| The docs for the cache and the corpus execute say the same thing | TRUE, with distinct sides kept apart | `docs/reconcile.md:68`, `:79`; `docs/runbooks/corpus-sync.md:75-76`; `docs/mcp-audit.md:37` |
| A repair execute with no durable chain exits 2 and flushes nothing | TRUE | `reconcile-main.ts:203-212`; `reconcile-main.test.ts:199` (run 1, pass) |
| An unreadable plan writes no audit record | TRUE (confirms the gap) | `reconcile-main.ts:242-248`; no test (warning 7c) |
| "A second run with the same plan removes the remainder" | TRUE for the answer cut only | `reconcile-repair.test.ts:424`; counter cut untested (warning 8) |
| A repair execute's post-flush append failure exits 1 | TRUE by code; untested | `reconcile-main.ts:270-273`; no test (warning 17) |

## Self-check

- Read at 6644698e: `corpus-sync.md` (§2 `:45-79`, the 6644698e change at `:76`), `reconcile.md` (`:30-98`), `mcp-audit.md` (`:25-53`), `reconcile-main.ts` (`:98-99`, `:140-148`, `:150-285`), `reconcile-repair.test.ts` (`:81-434` names and `:424-433`), `reconcile-main.test.ts` names, `server.ts` (`:661-714`, `:1735-1803`), `corpus/service.ts` (`:250-278`), `corpus/validate.ts` (`:181-188`), `corpus/routes.test.ts` (`:309-346`), `policy.ts` (`:46-49`, `:129-147`), `REQUIREMENTS.md` (`:122-140`), `protocol.ts:261`, `STATE.md` (grep for f1854711).
- Targeted tests, both within the two-command limit, both at 6644698e, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `--timeout 30000`: run 1 `reconcile-main.test.ts` + `reconcile-repair.test.ts` 28 pass; run 2 `corpus/routes.test.ts` 29 pass. 0 fail.
- The covered list and digest came from `gsd-tools query verification.fingerprint`; 35 files, `v3:sha256:af18cb91…`.
- Only `78-VERIFICATION.md` in the worktree was written. No code edits, no commits, no ROADMAP, STATE or REQUIREMENTS edits, no full suite, no tsc, lint or formatters. No file under `/root/src/repos/agent-substrate` was written.
- Kept open, as instructed: the unreadable-plan audit gap (7c), the counter-cut test gap (8), the operator items (human 1 to 4 and R8), and HARD-H2.

_Verified: 2026-11-03T12:42:29Z_
_Verifier: Claude (gsd-verifier, re-verification at HEAD 6644698e)_
