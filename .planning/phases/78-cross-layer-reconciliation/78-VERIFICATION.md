---
phase: 78-cross-layer-reconciliation
verified: 2026-11-03T10:27:54Z
status: human_needed
score: "1/2 must-haves verified; SC1 verified in code and by named tests (live cadence and single-flight are human items); SC2 UNCERTAIN (WARNING): the phase 78 bound is total and the corpus bound is now total too (d05ae871, closes warning 14); the post-flush audit policy stays open as recorded; 4 live proofs human_needed"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 97defd59"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (lines 1354-1355). Unchanged since f1854711"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-CONTEXT.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/corpus.md", "docs/mcp-audit.md", "docs/reconcile.md", "docs/runbooks/corpus-sync.md", "packages/audit/src/log.ts", "packages/cli/src/corpus/render-sync.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.test.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:7f6560e3cd3424c92f82264a4e7bf209e5a0f33ad3889f79470d9206a7b3c114"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at HEAD 9ab6f111: human_needed, 1/2, SC2 UNCERTAIN (corpus bound mismatch, warning 14; post-flush audit policy open; unreadable-plan audit gap, warning 7c; R8 operator assertion; HARD-H2 ORPHANED)"
  selection: "Step 0: the prior record has no top-level gaps: key, so initial mode. The prior record is the checklist of claims and carried residuals."
  changed_since_previous: "Commits 9ab6f111..97defd59 (2 commits). d05ae871 (corpus bound total): packages/mcp-server/src/corpus/reconcile.ts, packages/mcp-server/src/corpus/reconcile.test.ts, packages/corpus/src/protocol.ts, packages/cli/src/corpus/render-sync.ts, docs/corpus.md, docs/runbooks/corpus-sync.md. 97defd59 (phase 73 memo v3 round 4): packages/mcp-server/src/greptime.ts (+12, new method lookbackGraphCount, outside queryEvents), packages/mcp-server/src/service.ts (phase 73 hunks above the reconcile block), service.test.ts (hunks above the reconcile describe block), anchor, event and ledger files, docs/adr/0006, docs/greptime-ledger.md, docs/runbooks/devnet-reset-and-reanchor.md. No phase 78 reconcile implementation file changed (git diff 9ab6f111..97defd59 is empty for reconcile*.ts, cache.ts, index-store.ts, audit/log.ts, docs/reconcile.md, docs/mcp-audit.md, scripts/reconcile.ts). Covered list extended from 24 to 28 files by the four bound-evidence files (corpus/reconcile.ts, corpus/reconcile.test.ts, cli render-sync.ts, docs/corpus.md), so the digest is not comparable with v3:sha256:7c77005d"
  gaps_closed:
    - "Corpus runbook bound versus corpus code (warning 14 at 9ab6f111): d05ae871 makes the corpus reconcile one total bound (corpus/reconcile.ts:170-174), tested at corpus/reconcile.test.ts:250-270; protocol.ts:278-279, render-sync.ts:101, docs/corpus.md:317 and docs/runbooks/corpus-sync.md:55 and :70 say the same. Closed."
  gaps_remaining:
    - "Post-flush audit policy (owner-held, kept open as recorded): docs/mcp-audit.md:37 and docs/reconcile.md:79 say a failed append exits 1 after the flush. docs/runbooks/corpus-sync.md:75-76 is fail-closed for the corpus side and is not the phase 78 policy."
    - "Unreadable plan writes no audit record (warning 7c): reconcile-main.ts:240-247 returns 1 before recordRepair. Code gap, untested."
    - "Counter-cut refusal untested (warning 8); set-but-unwritable chain path untested (warning 9)"
    - "R8 live proof that the server is stopped (human item 4)"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md (warning 13): :125 unticked, :140 Not started; unchanged at 97defd59"
    - "New, minor: protocol.ts:261 doc comment still describes RECONCILE_MAX_ITEMS as a per-list bound (warning 16). Behaviour is total; comment only"
    - "Stale status records: ROADMAP.md:1348 and :1426 still list the bound as open; .planning/STATE.md lines 5, 6 and 9 still cite f1854711 (warnings 11, 15)"
    - "Live items 1 to 4"
  regressions: []
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4197, reconcilePass ??=)"
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
**Verified:** 2026-11-03T10:27:54Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 9ab6f111. Step 0 selected initial mode (no `gaps:` key); the prior record is the checklist.
**Scope:** integration tree at HEAD 97defd59, branch gsd/v18-int-all. Procedure: gsd-verifier, goal-backward. Owner decisions in force (2026-11-03) applied as recorded. Live proofs are operator items. No code edits, no commits, no full suite, no tsc, lint or formatters.

## Requested checks

| Check | Verdict | Evidence at 97defd59 |
| ----- | ------- | -------------------- |
| Corpus reconcile bound is total per run | PASS | `packages/mcp-server/src/corpus/reconcile.ts:170-174`: `missing = gone.slice(0, RECONCILE_MAX_ITEMS)`, `orphans = drift.orphans.slice(0, RECONCILE_MAX_ITEMS - missing.length)`, `truncated` when `gone.length + drift.orphans.length > RECONCILE_MAX_ITEMS` (or the listing, row read, lookup or lookup budget was incomplete). Requeue `:178` and delete `:179` act only on those slices. Test `reconcile.test.ts:250-270` ("missing rows and orphans share one bound in total"): 300 missing and 300 orphans; dry run lists 300 and 200, truncated, repaired zero; execute requeues 300, deletes 200, leaves 100. Named test run (command 1): 21 pass |
| Corpus bound holds for the oversized-manifest case | PASS | `reconcile.test.ts:272-284`: requeued equals `RECONCILE_MAX_ITEMS` (500), no orphan asserted, none deleted |
| Phase 78 repair bound is total per run | PASS | `packages/mcp-server/src/reconcile-repair.ts:185-192` `boundPasses` (one budget across answers, counters, mark, in pass order); `:240` `bounded = boundPasses(passes, RECONCILE_MAX_ITEMS)`; `:241` `willRemain`; `:243-250` dry-run reason. Test `reconcile-repair.test.ts:402` "a run removes at most the corpus bound of keys and reports the remainder". Named test run (command 2, with `reconcile-main.test.ts`): 28 pass |
| Protocol constant | PASS, one stale comment | `packages/corpus/src/protocol.ts:262` `RECONCILE_MAX_ITEMS = 500`. The doc comment at `:261` still reads "The most items `reconcile` lists in one list; the counts always cover all of them." That describes a per-list bound. The behaviour is total. Comment only, warning 16 |
| Truncation wording: protocol and renderer | PASS | `protocol.ts:278-279` ("cut at {@link RECONCILE_MAX_ITEMS} keys in total, missing rows and orphans together"); `packages/cli/src/corpus/render-sync.ts:101` ("the drift is capped at ${RECONCILE_MAX_ITEMS} keys in total"). No test asserts the old renderer string |
| Docs say the same: corpus | PASS | `docs/runbooks/corpus-sync.md:55` ("cut at 500 keys in total (missing rows and orphans together)"); `:70` ("At most 500 keys are repaired per run, in total."); `docs/corpus.md:317` ("the lists are cut at 500 keys in total, missing rows and orphans together") |
| Docs say the same: phase 78 | PASS | `docs/reconcile.md:46` ("removes at most 500 keys per run"); `:55` ("removes up to 500 keys"); `:57` (counter-cut re-plan) |
| Post-flush audit policy | OPEN, kept as recorded | `docs/mcp-audit.md:37` and `docs/reconcile.md:79`: a failed append after the flush exits 1, the flush has already run. Corpus side `docs/runbooks/corpus-sync.md:75-76` is fail-closed and is a different path |
| Operator items | OPEN | Human items 1 to 4 below. None run in this pass |
| HARD-H2 | OPEN, ORPHANED | `.planning/REQUIREMENTS.md:125` unticked; `:140` "Not started". Neither changed in `9ab6f111..97defd59` (the file is not in the diff) |

## What changed since 9ab6f111

`git diff --name-only 9ab6f111..97defd59` is 19 files in two commits. The phase 78 reconcile implementation is unchanged: `git diff 9ab6f111..97defd59` is empty for `reconcile*.ts`, `scripts/reconcile.ts`, `cache.ts`, `index-store.ts`, `packages/audit/src/log.ts`, `docs/reconcile.md`, `docs/mcp-audit.md`, `REQUIREMENTS.md`, `ROADMAP.md` and `STATE.md`.

| File | Change | Phase 78 relevance |
| ---- | ------ | ------------------ |
| `packages/mcp-server/src/corpus/reconcile.ts` | d05ae871: one total bound (`:170-174`) | **Yes.** The corpus bound now matches the owner decision |
| `packages/mcp-server/src/corpus/reconcile.test.ts` | d05ae871: mixed missing and orphan test (`:250-270`) | **Yes** |
| `packages/corpus/src/protocol.ts` | d05ae871: truncation comment (`:278-279`) | **Yes.** The constant's comment (`:261`) was not changed |
| `packages/cli/src/corpus/render-sync.ts` | d05ae871: renderer wording (`:101`) | **Yes** |
| `docs/corpus.md`, `docs/runbooks/corpus-sync.md` | d05ae871: "in total" wording (`corpus.md:317`; `corpus-sync.md:55`, `:70`) | **Yes** |
| `packages/mcp-server/src/greptime.ts` | 97defd59: +12, new method `lookbackGraphCount` (`:1895-1904`), phase 73 adoption window | Not on the reconcile read path. `queryEvents` (`:1519`) and `readRecentEvents` (`:1684`) are unchanged |
| `packages/mcp-server/src/service.ts` | 97defd59: phase 73 hunks at old lines 866-950 and 8018 | Not the reconcile block. The reconcile block at HEAD `:4180-4224` is byte-identical to `9ab6f111:4179-4223` (md5 `36f6a50c` on both) |
| `packages/mcp-server/src/service.test.ts` | 97defd59: hunks at old 4282, 5825-5894 | Not the reconcile describe block. It moved from 6168 to 6252 (+84) with no hunk inside it. Its content is unchanged |
| Anchor, event, ledger memo files; `docs/adr/0006-memo-only-anchoring.md`; `docs/greptime-ledger.md`; `docs/runbooks/devnet-reset-and-reanchor.md` | 97defd59 (phase 73 and docs) | No |

Covered digest: recomputed with `gsd-tools query verification.fingerprint` over the 24 prior files plus the four bound-evidence files, 28 in all. The phase's own PLAN, CONTEXT and SUMMARY are included. `covered_digest` is `v3:sha256:7f6560e3…`.

## Must-haves

| # | Criterion (this tree's ROADMAP) | Verdict | Evidence at 97defd59 |
| - | ------------------------------- | ------- | -------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by named tests at 9ab6f111. The reconcile sources are unchanged at 97defd59 and the scheduled block is byte-identical. Live cadence and single-flight: human | Counts `reconcile-run.ts:55-96`. First key `reconcile.ts:193-194, :205-209`. Scheduled path `service.ts:4180` (`startReconcile`), `:4197-4201` (`reconcileTick`, single flight `??=`), `:4205` (`runScheduledReconcile`, one stdout line, stderr only on skip or failure). Read-only: ledger `greptime.ts:1519-1538`, index SELECTs `index-store.ts:2924-2981`, cache SCAN `cache.ts:1061-1079`. Clean-run test `service.test.ts:6270` (tick writes nothing), `:6259` (interval 0 and 60) |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (WARNING). R1 to R9 hold as ruled (table below). The phase 78 bound is total and ratified. Open: post-flush audit policy, as recorded; unreadable-plan audit gap (7c); counter-cut test gap (8). R8 is a documented operator assertion; its live proof is human item 4 | Separate `repair` subcommand, dry run by default (`reconcile-main.ts:98-101`; `reconcile-repair.ts:243-251`). Execute needs `--server-stopped`, usage error exit 2 before any client (`reconcile-main.ts:98-99`). Durable chain check before the flush (`reconcile-main.ts:203-212`). Plan record `planFromReport` (`reconcile-repair.ts:125-145`), written with `wx`. Digest recheck (`reconcile-repair.ts:210-216`). Orphan recheck (`:217-222`). Scan refusal (`:226-233`). Server-stopped refusal (`:252-259`). Only destructive call `unlinkKeys` (`:264-276`). Record after the flush (`reconcile-main.ts:259-260`) |

**Must-haves: 1 of 2 verified in code.** No truth FAILED. The human items are non-empty, so the status is `human_needed` (Step 9, rule 2). SC2 is UNCERTAIN, not FAILED.

## SC2: the corpus delete rules, point by point

The rules are in `docs/runbooks/corpus-sync.md` (§2 lines 45-79; §5 lines 115-121). The phase 78 bound constant is `RECONCILE_MAX_ITEMS = 500` in `packages/corpus/src/protocol.ts:262`.

| # | Corpus rule | Reconcile evidence at 97defd59 | Verdict |
| - | ----------- | ------------------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | Dry run is the default (`reconcile-repair.ts:243-251`; `reconcile-main.ts:98-101`). Read-only SCAN (`:226`), then nothing is written. Not audited (warning 7b) | MET |
| R2 | Explicit execute | `--execute --server-stopped` (`reconcile-main.ts:98-99`) | MET |
| R3 | Act only on what the plan names; a key an active row holds is kept | Plan pinned by digest and by live orphan set (`reconcile-repair.ts:210-222`). The flush selects by class, not by named key: answer classes (`:24-31`, `:168-179`), every `gen` counter, the mark. The divergence is ratified as D78-5 (`docs/reconcile.md:48`, owner, 2026-11-03). Code unchanged | MET as ratified design of record (D78-5) |
| R4 | A delete confirmed by the store; an unconfirmed delete is not counted | `removed` is the UNLINK count per batch (`reconcile-repair.ts:264-271`); the count is the server's reply (`cache.ts:1087-1102`) | MET |
| R5 | Bound per run | One run removes at most `RECONCILE_MAX_ITEMS` keys across the three passes: `boundPasses` (`reconcile-repair.ts:185-192`, `:240`); `truncated` when `planned > limit`. Total per run, as the owner ruled (`docs/reconcile.md:46`; `docs/runbooks/corpus-sync.md:70`). Corpus command: now total too (`corpus/reconcile.ts:170-174`) | MET for phase 78 and for the corpus command |
| R6 | `repaired` read against the listed items in one unit | `planned`, `removed` and `remaining` are all cache keys (`reconcile-repair.ts:56-67`; `:239`). `listed` and `repaired` are gone from source and docs | MET as the owner ruled |
| R7 | Audit: the dry run is audited (fail-open); the execute is audited (fail-closed) | One record per execute: tool `reconcile_repair`, surface `operator`, transport `internal`, `decision`, `reason` with `outcome`, `planned`, `removed`, `remaining`, `limit`, `plan_digest` (`reconcile-main.ts:156-171`), `report_digest`. Owner decision 6 scopes R7 to the execute. Residuals: post-flush placement (open, as recorded); unreadable plan writes none (warning 7c) | MET for the execute as the owner ruled; residuals listed |
| R8 | Serialised with ingest by the corpus lock | `--server-stopped` is an operator assertion, stated as one in the chain header (`packages/audit/src/log.ts:1-9`, unchanged). The code checks the flag is present (`reconcile-main.ts:97-99`; `reconcile-repair.ts:252-259`); it does not check the server state. Live proof is human item 4 | CLOSED as a documented operator assertion (not as fact). Live proof open |
| R9 | A re-run is safe: a second run finds nothing | A second execute after a full flush is refused with no orphans (`reconcile-repair.ts:217-220`); test `reconcile-repair.test.ts:424` covers the answer-cut case | MET |

**Reading:** R1, R2, R3 (ratified), R4, R5 (total, owner-ruled, now in both commands), R6, R8 (as a documented operator assertion) and R9 hold. R7 holds for the execute with the residuals in warnings 7 and 8. SC2 stays UNCERTAIN because the post-flush audit policy is kept open as recorded and the unreadable-plan audit gap is open. The corpus runbook/code mismatch that kept it UNCERTAIN at 9ab6f111 is closed.

## Bound check, point by point (this pass's focus)

1. **Corpus command, one total bound.** `missing` takes first (`:172`), `orphans` takes the remainder (`:173`), so `missing.length + orphans.length <= RECONCILE_MAX_ITEMS`. `repaired.requeued + repaired.deleted` is at most the listed count, because `deleteOrphans` can only skip (`activeReferences > 0`) or fail, never add. Lookups for missing rows are also capped at `RECONCILE_MAX_ITEMS` (`:156`). A row past that cap is not looked up, and `truncated` is set (`unlooked`).
2. **Truncation flag.** `truncated` is true when `gone.length + drift.orphans.length > RECONCILE_MAX_ITEMS` (`:174`), so a cut is always reported. It is also true for an incomplete listing, an incomplete row read, a failed lookup or an unlooked row.
3. **Docs and wording agree.** Protocol `:278-279`, renderer `:101`, `docs/corpus.md:317`, `docs/runbooks/corpus-sync.md:55` and `:70`, all "in total", "missing rows and orphans together". The only residual is the constant's own comment (`protocol.ts:261`, warning 16).
4. **Phase 78 repair, same rule.** `docs/reconcile.md:46` ("at most 500 keys per run") and `reconcile-repair.ts:185-192`, `:240` agree.
5. **Not the same thing.** `docs/corpus.md:146` "at most 500 each" is the ingest tombstone request size. It is not the reconcile bound.
6. **Known difference, not a conflict.** The corpus reconcile response has no numeric remainder field; `drift.truncated` only (commit message of d05ae871, "left for a later change"). The phase 78 report does carry `remaining`.

## Owner ratifications, checked against the docs at 97defd59

| Item | Where recorded | Verdict at 97defd59 |
| ---- | -------------- | ------------------- |
| D78-5: whole-prefix flush, three ordered passes | `docs/reconcile.md:48` ratified 2026-11-03; code `reconcile-repair.ts:272-276` | Closed as design of record |
| Audit second writer | `docs/mcp-audit.md:37-38`; `packages/audit/src/log.ts:1-9` | Documented approval, conditioned on R8. Closed in docs |
| Post-flush audit policy | `docs/mcp-audit.md:37`, `docs/reconcile.md:79`; exit codes `docs/reconcile.md:68` | **Open, kept as recorded (owner-held).** `docs/runbooks/corpus-sync.md:75-76` is the corpus side and is fail-closed. This pass does not accept the phase 78 placement |
| Bound: total per run (phase 78) | `docs/reconcile.md:46`; `docs/runbooks/corpus-sync.md:70`; code `reconcile-repair.ts:185-192` | Closed for phase 78 |
| Bound: total per run (corpus) | `docs/runbooks/corpus-sync.md:55, :70`; `docs/corpus.md:317`; `protocol.ts:278-279`; `render-sync.ts:101`; code `corpus/reconcile.ts:170-174`; test `corpus/reconcile.test.ts:250-270` | Closed at 97defd59 (d05ae871). Comment `protocol.ts:261` stale (warning 16) |

## Sub-checks, by test (run at 97defd59)

Both commands ran from `packages/mcp-server` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test … --timeout 30000`. No Postgres container started. No PG-gated test in the filters.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test src/corpus/reconcile.test.ts` | **21 pass, 0 fail**, 68 expect calls, 1 file, 8.29 s. Includes the total-bound test at `:250` and the manifest-over-read-bound test at `:272` |
| 2 | `bun test src/reconcile-repair.test.ts src/reconcile-main.test.ts` | **28 pass, 0 fail**, 131 expect calls, 2 files, 1.11 s. Includes the phase 78 bound test `reconcile-repair.test.ts:402`, the counter-and-mark second run `:424`, the one-audit-record test `reconcile-main.test.ts:176`, and the no-durable-chain test `:199` |

Not re-run at 97defd59 in this pass: the SC1 filter (`reconcile.test.ts`, `reconcile-read.test.ts`, `service.test.ts`, `config.test.ts`) recorded at 9ab6f111 (21 pass). The two targeted commands were spent on the bound. The reconcile sources and the scheduled block are unchanged at 97defd59, so that result stands for SC1 as unchanged evidence. The single-flight guard has no test (behaviour-unverified item).

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` for this phase; no PLAN or SUMMARY declares a probe. Skipped.

## Behavioral spot-checks (Step 7b)

| Behavior | Source | Result | Status |
| -------- | ------ | ------ | ------ |
| Corpus reconcile removes at most 500 of 600 drift keys and reports the remainder | command 1 (`reconcile.test.ts:250`) | pass | PASS (by test) |
| Corpus requeue and delete together stay within the bound | command 1 (`reconcile.test.ts:250`, `:272`) | pass | PASS (by test) |
| Repair removes at most 500 of 601 keys and reports the remainder | command 2 (`reconcile-repair.test.ts:402`) | pass | PASS (by test) |
| Repair `--execute` without `--server-stopped` exits 2 before any connection | command 2 (`reconcile-main.test.ts:159`, unchanged file) | pass | PASS (by test) |
| One audit record per execute, with plan digest | command 2 (`reconcile-main.test.ts:176`) | pass | PASS (by test) |
| Scheduled tick on a clean fixture writes nothing | 9ab6f111 run (`service.test.ts:6270`); block unchanged | pass at 9ab6f111 | PASS (by test, unchanged) |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report, scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/corpus/reconcile.ts` | VERIFIED: total bound | `:156` lookup cap; `:170-174` bound and truncation; `:178-179` act only on the listed slices |
| `packages/mcp-server/src/corpus/reconcile.test.ts` | VERIFIED: 21 pass | `:250-270`, `:272-284` |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED: mechanics, R5 total bound, R6 unit; D78-5 ratified; audit residuals held | `:56-67`; `:125-145`; `:185-192`; `:210-222`; `:226-233`; `:240-241`; `:243-251`; `:252-259`; `:264-276` |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED: R7 record, durable check, exit codes; warning 7c open | `:98-101`; `:203-212`; unreadable plan `:240-247`; `recordRepair` append `:259-260` |
| `packages/mcp-server/src/service.ts` | VERIFIED for SC1; reconcile block byte-identical to 9ab6f111 | `:4180` `startReconcile`; `:4197-4201` `reconcileTick`; `:4205` `runScheduledReconcile` |
| `packages/corpus/src/protocol.ts` | VERIFIED: constant and truncation comment; comment at `:261` stale | `:261-262`; `:278-279` |
| `packages/cli/src/corpus/render-sync.ts` | VERIFIED: total wording | `:101` |
| `docs/runbooks/corpus-sync.md` | VERIFIED: "in total" at `:55`, `:70`; audit fail-closed at `:75-76` is the corpus side | §2 `:45-79` |
| `docs/corpus.md` | VERIFIED: "in total" at `:317` | `:314-320` |
| `docs/reconcile.md` | VERIFIED: bound `:46`, execute `:55`, counter-cut `:57`, exit codes `:68`, post-flush `:79` | Unchanged since 9ab6f111 |
| `docs/mcp-audit.md` | VERIFIED as documentation; post-flush `:37` open as recorded | Unchanged since 9ab6f111 |
| `packages/audit/src/log.ts` | VERIFIED as the chain's sink; header `:1-9` | Unchanged |
| `packages/mcp-server/src/greptime.ts` | VERIFIED: reconcile read path (`queryEvents` `:1519-1538`) unchanged; new method `lookbackGraphCount` is outside it | `:1895-1904` |
| Test files | VERIFIED | commands 1 and 2 |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `corpus/reconcile.ts` `run` | `RECONCILE_MAX_ITEMS` | single total budget (`:172-173`) | WIRED | |
| `corpus/reconcile.ts` `run` | `deleteOrphans` and `requeue` | act only on the listed slices (`:178-179`) | WIRED | |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, `process.exit(code)` | WIRED | |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:203-212`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` | WIRED | |
| `reconcileMain` (execute) | `recordRepair` | after `executePlan` (`reconcile-main.ts:259-260`) | WIRED; post-flush placement held as recorded | |
| `reconcileMain` (unreadable plan) | `recordRepair` | none: returns 1 at `:247` | NOT WIRED (warning 7c) | no audit record on that path |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:264-276`) | WIRED | |
| `startRecall` | `startReconcile` | `service.ts` | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (`service.ts:4198`) | WIRED; single flight untested | |
| `runReport` | `cache.scanKeys` | class and generation scans (`reconcile-run.ts:85-90`) | WIRED | |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents` (`greptime.ts:1519-1538`), index SELECTs (`index-store.ts:2924-2981`) and cache SCANs (`cache.ts:1061-1079`), combined at `reconcile-run.ts:55-96`. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:226-276`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts:156-171`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:145-179`). No hardcoded result feeds these values.

## Requirements coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window `config.ts:1631-1638`, scan caps, `RECONCILE_MAX_ITEMS`, read-only report path, unclean on unavailable layers (`reconcile-run.ts:91-97`). The checkbox is unticked (`:125`) and the table row says `Not started` (`:140`); both unchanged at 97defd59. Owner or orchestrator to decide the status | Requirement status is an owner decision; this pass does not change it |

## Anti-patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`: none in `reconcile*.ts`, `scripts/reconcile.ts`, `docs/reconcile.md`, `docs/mcp-audit.md`, `packages/audit/src/log.ts`. No debt-marker gate fires.
- **Stub scan.** No stub, placeholder or no-op found in the phase 78 files or the d05ae871 corpus change.
- **Doc-comment drift (new, minor).** `packages/corpus/src/protocol.ts:261` describes the constant as a per-list bound. Warning 16.
- **Re-verification evidence gate (Step 7).** Initial mode (Step 0). No blocker raised by the evidence gate in this pass.

## Deferred items (Step 9b)

None. No later v1.8 phase exists in the ROADMAP (no phase 79 or later section). HARD-R1 (phase 74) is scheduled after v1.8 by owner decision and is unrelated to these gaps.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard have no test. This is also the behavior-unverified item.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts. Dry run, then execute with `--server-stopped`, then a second execute; if the bound cut into the counter pass, plan again and repair again. Expected as in the frontmatter. Why human: H5 cost and behaviour at scale.
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores and a real audit file.** Expected: exit codes per `docs/reconcile.md:66-68`; `--execute` without `--server-stopped` exits 2 before any connection; `--execute --server-stopped` without `SUBSTRATE_AUDIT_PATH` exits 2 with nothing flushed; with the path set, the execute appends one record. After a `substrate-mcp` restart the chain verifies, with the repair record in sequence. Why human: needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This is the only proof of the single-writer sequence the owner's second-writer approval depends on, and the only check that the server was in fact stopped during the execute. The code cannot make that check (R8 is an operator assertion).

## Warnings (non-blocking)

1. **Repair result units (R6): RESOLVED by owner decision 6.** `planned`, `removed` and `remaining` count keys (`reconcile-repair.ts:56-67`).
2. **Flush scope, whole prefix (D78-5): RESOLVED as design of record.** Owner ratification 2026-11-03, `docs/reconcile.md:48`. Code unchanged and matches.
3. **No tick test runs a cache-off fixture: unchanged.** The cache-off line is covered by `runReport` (`reconcile-read.test.ts:391`).
4. **Advisory: index read cost: unchanged.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a batch (`index-store.ts:2924-2934`). [INFERENCE from the SQL; not measured]
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report: unchanged.** A truncated report can still produce a plan (`reconcile-run.ts:88-90`). The flush is fail-closed on its own 1000000-key scan (`reconcile-repair.ts:226-233`).
6. **Per-run bound, total or per kind: RESOLVED.** Phase 78 is total (`reconcile-repair.ts:185-192`, `:240`; `docs/reconcile.md:46`). The corpus command is total as of d05ae871 (warning 14).
7. **Audit record (R7) residuals:**
   - (a) **Post-flush placement: OPEN, kept as recorded (owner-held).** The durable check runs before the flush (`reconcile-main.ts:203-212`); the append runs after it (`:259-260`). A failed append leaves the flush done, and the run exits 1 with `the repair ran, but its audit record was not written`. The approved text (`docs/mcp-audit.md:37`) and `docs/reconcile.md:79` state this. `docs/runbooks/corpus-sync.md:75-76` is the corpus side and is fail-closed. This pass does not accept the phase 78 reading.
   - (b) **Dry run not audited.** Owner decision 6 text scopes R7 to the execute. Carried.
   - (c) **Unreadable plan writes no record: OPEN code gap, untested.** An `--execute` whose plan cannot be read or parsed returns 1 before `executePlan` and before `recordRepair` (`reconcile-main.ts:240-247`), with no audit record and no flush. Read literally, this breaks "one audit record per repair execute". Fix: write the record on that path too, with a reason that names the parse failure. Not fixed here (no code edits in this pass).
   - (d) **Single writer: RESOLVED in docs and in the code header** by the owner approval (`docs/mcp-audit.md:37-38`, 2026-11-03), conditioned on R8. See warning 12.
8. **Second run with the same plan, counter cut (R5): documented, test gap OPEN.** The digest refusal (`reconcile-repair.ts:210-216`) is documented at `docs/reconcile.md:57` and in the reason string (`:299`). The named test (`reconcile-repair.test.ts:424`) covers only the answer-cut case. Recommend a test for the counter-cut refusal, plus re-plan-then-finish.
9. **Set-but-not-durable chain path untested: OPEN, minor.** The unset path is tested (`reconcile-main.test.ts:199`). An unwritable `SUBSTRATE_AUDIT_PATH` takes the same branch (`reconcile-main.ts:207-211`) and is not tested.
10. **Cache layer reported unchecked, not zero: recorded** (78-SUMMARY.md; STATE owner decision 2). The code matches (`reconcile-run.ts:91-97`). Open for the owner.
11. **ROADMAP status text: STALE on the bound item.** `ROADMAP.md:1348` and `:1426` still list "the bound reading (total versus per kind)" as open. The owner decided it (total; commit 61c63e5e, and d05ae871 for the corpus side). The orchestrator should update the ROADMAP text. This pass did not edit ROADMAP.
12. **Chain header vs the approved second writer: RESOLVED.** `packages/audit/src/log.ts:1-9` names `substrate-mcp` as the writer, the repair execute as the approved second writer, and states the stopped-server condition as an operator assertion.
13. **HARD-H2 orphaned: OPEN.** `REQUIREMENTS.md:125` is unticked; the row at `:140` says `Not started`. Neither changed in `9ab6f111..97defd59`. PLAN 78-01 declares no requirements.
14. **Corpus runbook bound versus corpus code: RESOLVED at 97defd59 (d05ae871).** The corpus reconcile is one total bound (`corpus/reconcile.ts:170-174`), tested at `reconcile.test.ts:250-270` (21 pass in command 1). `docs/runbooks/corpus-sync.md:55, :70`, `docs/corpus.md:317`, `protocol.ts:278-279` and `render-sync.ts:101` say the same.
15. **STATE.md citations: STALE.** `.planning/STATE.md` lines 5, 6 and 9 still say phase 78 was re-verified at f1854711. Not updated at 97defd59. Owner or orchestrator to update.
16. **NEW, minor: protocol.ts constant comment.** `packages/corpus/src/protocol.ts:261` reads "The most items `reconcile` lists in one list; the counts always cover all of them." It describes a per-list bound; the behaviour and the `:278-279` comment are total. The fix is one comment line (not made in this pass: no code edits).

## Info (non-blocking)

- **Window-edge false drift (carried advisory, not reproduced).** A write whose memory row is created before the window start but whose audit event is stamped after it appears as an accepted audit event with no index row. Both sides use one `sinceIso` (`reconcile-run.ts:51`). [INFERENCE from code order; not reproduced]
- **Dry-run `remaining` reads equal to `planned`** (carried). The field is defined as `planned - removed`, with removed 0 in a dry run (`reconcile-repair.ts:51-54`). The reason string states the one-run split.
- **Corpus response has no remainder count** (d05ae871 commit message: "left for a later change"). `drift.truncated` only.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; `docs/reconcile.md:70`; STATE owner decision 3. Open for the owner.

## Open decisions (kept as recorded)

- **Post-flush audit policy.** Owner-held. Kept open as recorded. Approved text `docs/mcp-audit.md:37` and `docs/reconcile.md:79`. The corpus runbook `docs/runbooks/corpus-sync.md:75-76` is the corpus side and is fail-closed.
- **Operator items (human 1 to 4).** Live cadence and single-flight, live Dragonfly at production counts, live GreptimeDB `queryEvents`, live CLI run with the real audit file and the R8 check that the server is stopped. Not run here.
- **R8, `--server-stopped` as an operator assertion.** Documented as an assertion (`packages/audit/src/log.ts:7-9`). The code checks the flag only (`reconcile-main.ts:97-99`; `reconcile-repair.ts:252-259`). The live proof is human item 4.
- **HARD-H2.** Orphaned in REQUIREMENTS.md (`:125`, `:140`). Requirement status is the owner's or orchestrator's to set.
- **Bound: total per run.** Closed for phase 78 and for the corpus command.
- **Cache layer unchecked, not zero.** Recorded (warning 10). Open for the owner.
- **Stale status records:** `ROADMAP.md:1348` and `:1426` (warning 11); `.planning/STATE.md` lines 5, 6, 9 (warning 15); `protocol.ts:261` comment (warning 16).

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED on the phase 78 SC1 path. SC1 is verified in code and by named tests, with the live cadence and single-flight guard as human items. SC2's mechanics are verified; R1 to R9 hold as ruled. The corpus bound is total and consistent across code, tests and docs at 97defd59. SC2 stays UNCERTAIN on the post-flush audit policy (kept open as recorded) and the unreadable-plan audit gap (warning 7c).

**Status:** `human_needed`, from the four live proofs, the single-flight item, and the open owner-held audit policy. Warnings 1 to 16 do not change the status.

## Summary claims checked (d05ae871, 78-SUMMARY.md, and the phase 78 docs)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| d05ae871: the corpus reconcile bound is 500 keys per run, in total | TRUE | `corpus/reconcile.ts:170-174`; `reconcile.test.ts:250-270` (command 1, pass) |
| d05ae871: `protocol.ts` and `render-sync.ts` say "in total" | TRUE for the truncation comment and renderer; the constant's comment (`protocol.ts:261`) is stale | `protocol.ts:278-279`; `render-sync.ts:101`; warning 16 |
| d05ae871: `docs/corpus.md` and `docs/runbooks/corpus-sync.md` say the same | TRUE | `corpus.md:317`; `corpus-sync.md:55, :70` |
| d05ae871: the corpus code matches `docs/reconcile.md` | TRUE for the bound (both say at most 500 per run) | `docs/reconcile.md:46` |
| Phase 78 repair bound is total, 500 per run | TRUE | `reconcile-repair.ts:185-192, :240`; `reconcile-repair.test.ts:402` (command 2, pass) |
| D78-5 whole-prefix flush and three ordered passes are the design of record | TRUE, as the owner's documented ratification | `docs/reconcile.md:48`; `reconcile-repair.ts:272-276` |
| Repair execute is an owner-approved second writer, under `--server-stopped` | TRUE as documentation and as the code header | `docs/mcp-audit.md:37-38`; `packages/audit/src/log.ts:1-9` |
| R7: one audit record per execute with plan digest, counts and outcome | TRUE for the execute that reaches the plan parse | `reconcile-main.ts:156-171, :259-260`; `reconcile-main.test.ts:176` (command 2, pass) |
| A repair execute with no durable chain exits 2 and flushes nothing | TRUE for the unset path | `reconcile-main.ts:203-212`; `reconcile-main.test.ts:199` (command 2, pass). Set-but-unwritable untested (warning 9) |
| "A second run with the same plan removes the remainder" | TRUE for the answer cut only | `reconcile-repair.test.ts:424`; counter-cut refusal documented at `docs/reconcile.md:57` (warning 8) |
| Scheduled tick is read-only and writes one line per run | TRUE by test at 9ab6f111; block unchanged at 97defd59; single flight untested | `service.test.ts:6270`; `service.ts:4197-4223` |

## Self-check

- Read at 97defd59: the corpus bound (`corpus/reconcile.ts`, `reconcile.test.ts`), the protocol constant and comment (`protocol.ts:261-262, :278-279`), the renderer (`render-sync.ts:101`), the corpus runbook (`corpus-sync.md:55, :70, :75-76`), `corpus.md:317`, `reconcile.md:46, :55, :57, :68, :79`, `mcp-audit.md:37`, the phase 78 bound (`reconcile-repair.ts:185-192, :240-250`), the unreadable-plan branch (`reconcile-main.ts:240-247`), the service reconcile block (md5-compared to 9ab6f111), the service test block offset, `REQUIREMENTS.md:125, :140`, `ROADMAP.md:1348, :1426`, `STATE.md` lines 5, 6, 9.
- Targeted tests, both within the two-command limit, both at 97defd59, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `--timeout 30000`: command 1 21 pass, command 2 28 pass, 0 fail.
- The covered list and digest came from `gsd-tools query verification.fingerprint`; 28 files, `v3:sha256:7f6560e3…`.
- Only `78-VERIFICATION.md` in the worktree was written. No code edits, no commits, no ROADMAP, STATE or REQUIREMENTS edits, no full suite, no tsc, lint or formatters. No file under `/root/src/repos/agent-substrate` was written.
- Kept open, as instructed: the post-flush audit policy, the operator items (human 1 to 4 and R8), and HARD-H2.

_Verified: 2026-11-03T10:27:54Z_
_Verifier: Claude (gsd-verifier, re-verification at HEAD 97defd59)_
