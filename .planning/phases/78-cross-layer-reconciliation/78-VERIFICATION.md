---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T06:35:01Z
status: human_needed
score: 1/2 must-haves verified
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
    ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md",
    "package.json",
    "packages/mcp-server/src/cache.ts",
    "packages/mcp-server/src/config.test.ts",
    "packages/mcp-server/src/config.ts",
    "packages/mcp-server/src/flag-registry.ts",
    "packages/mcp-server/src/index-store.ts",
    "packages/mcp-server/src/reconcile-main.test.ts",
    "packages/mcp-server/src/reconcile-main.ts",
    "packages/mcp-server/src/reconcile-read.test.ts",
    "packages/mcp-server/src/reconcile-read.ts",
    "packages/mcp-server/src/reconcile-repair.test.ts",
    "packages/mcp-server/src/reconcile-repair.ts",
    "packages/mcp-server/src/reconcile-run.ts",
    "packages/mcp-server/src/reconcile.test.ts",
    "packages/mcp-server/src/reconcile.ts",
    "packages/mcp-server/src/service.test.ts",
    "packages/mcp-server/src/service.ts",
    "scripts/reconcile.ts"
  ]
covered_digest: "v3:sha256:ef5931a422f67440111aa2cdbdec05231f3638c3acf83cd3df789d5e441c9cd8"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 1/2 must-haves verified
  gaps_closed:
    - "The counter-pass and mark-pass failure paths had no test (fifth-pass WARNING). Now covered: 'a failure in the counter pass keeps the forget mark in place' (reconcile-repair.test.ts:228) and 'a failure in the mark pass leaves the answers and counters removed and the mark in place' (reconcile-repair.test.ts:250). Both run once by name this pass and pass."
    - "78-SUMMARY.md named no regression test for the rejected 'missing key is free' finding and cited STATE Run 17 without naming tests. The summary now names 'a hold granted before the window is found by its node, with no time bound' (reconcile-read.test.ts:222) and 'a lookup whose rows run out before any transition is truncated' (reconcile-read.test.ts:246). Both exist with those exact names."
    - "78-SUMMARY.md commit list now includes d43c259e. All seven commits it names exist, in the order it gives."
  gaps_remaining:
    - "Scheduled tick (reconcileTick, runScheduledReconcile; service.ts:3827-3854) still has no test. Human check, behavior_unverified."
    - "Cache-off scheduled line reads cache counts 0 with truncated true (reconcile-run.ts:83-86). The report is not clean. WARNING, owner decision requested."
    - "Live-only checks: Dragonfly SCAN and UNLINK at production key counts with the server stopped; GreptimeDB queryEvents in a busy window; a live CLI run with real stores."
    - "WARNING: STATE.md has no Run 17 entry at d43c259e (last entry Run 16, STATE.md:689). The amendment that 78-SUMMARY.md cites as 'STATE, Run 17' is unresolved at this HEAD. Its content is not verified here."
  regressions: []
behavior_unverified_items:
  - truth: "A scheduled reconcile tick (runScheduledReconcile) writes nothing on a clean run and writes one log line"
    test: "Start a server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture, let one interval tick run, and compare ledger, index and cache write counts before and after; start a second tick while one is in flight"
    expected: "One '[substrate] reconcile {...}' line on stdout with clean:true; no ledger, index or cache write; the second tick starts no run"
    why_human: "No test calls reconcileTick or runScheduledReconcile (service.ts:3827-3854; grep over packages and scripts finds no test reference). Write-freedom of runReport is tested (reconcile-read.test.ts:343); the scheduled wrapper is not"
coincidental_reliance_items: []
human_verification:
  - test: "Scheduled tick on a clean fixture: start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 and a clean fixture; let one tick run; start a second tick while the first is in flight"
    expected: "One '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no run"
    why_human: "The tick is untested (service.ts:3827-3854). runReport's write-freedom is tested, not the wrapper"
  - test: "Decide how a cache-off scheduled line reads. With the cache off, scanKeys returns truncated (cache.ts:1064), so each cache.* count is 0 with truncated true (reconcile-run.ts:85-86). The line is not clean. Choose: keep 0 with truncated, or report the cache layer as absent"
    expected: "The owner records the choice. The line carries truncated:true for every cache class"
    why_human: "A design decision. Not a defect: the report is not clean"
  - test: "Live Dragonfly run, with the server stopped, on a copy of production key counts: run repair --plan <file> (dry run), then --execute --server-stopped"
    expected: "Dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps budget: and emb: keys. A prefix above 1000000 keys refuses with nothing removed. <plan>.result.json shows repaired against listed"
    why_human: "Real SCAN and UNLINK cost and behavior at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup cap (200)"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores: report exit code; repair --execute without --server-stopped; a dry run; repair --execute --server-stopped writes the result file"
    expected: "Exit codes match docs/reconcile.md (report 0 or 1, usage and missing config 2, refused or failed repair 1). Missing --server-stopped exits 2 before any connection. The result file holds executed, refused, repaired, listed and error"
    why_human: "Needs live PG, GreptimeDB and Dragonfly"
  - test: "Owner decision on the amended design: accept the ordered three-pass flush (D78-5 as amended in ee1c9534) and the mandatory --server-stopped (D78-6) as the design of record, and record both in STATE.md"
    expected: "STATE.md gets the Run 17 record. 78-SUMMARY.md cites 'STATE, Run 17', but STATE.md has no Run 17 entry at d43c259e"
    why_human: "A design-of-record decision. The code cannot settle it. The STATE entry is not present at this HEAD"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T06:35:01Z
**Status:** human_needed
**Re-verification:** Yes. Sixth pass at HEAD `d43c259e`. The prior record (`ee1c9534`, human_needed, 1/2) is carried forward as `re_verification`. Its frontmatter has no `gaps:` key, so Step 0 selects initial mode. Both must-haves were re-checked in full, and the implementation evidence from the fifth pass was re-read at `d43c259e`.

## Scope of this pass

- HEAD check: `git -C /root/src/worktrees/as-gsd-v18-p78 log --oneline -1` names `d43c259e`.
- Working tree: equals HEAD except `78-SUMMARY.md` and `78-VERIFICATION.md` in the phase directory (both uncommitted). `git status --short --untracked-files=all` shows nothing else.
- Changed since `ee1c9534`: `reconcile-repair.test.ts` only (+42 lines, two tests). No source file changed, so the fifth-pass code evidence stands. Test line numbers in `reconcile-repair.test.ts` after line 227 moved by +42; all citations below use the new numbers.
- `78-SUMMARY.md` was read as it now stands and each code claim in it was checked (section "Summary claims checked" below).
- Gate evidence is taken from the brief (tsc 0; lint 0; bun test 11503 pass, 2 skip, 0 fail; test:py 0; phase-close 236/0; CLI usage exit 2). The gate and the full suite were not re-run.
- Named tests run this pass, once each, by name (`bun test reconcile-repair.test.ts -t "<name>"`): the two new tests. Both pass.
- Fingerprint: `gsd_run query verification.fingerprint` over the 18 changed implementation files from `git diff --name-only gsd/v18-int-73-75-76...HEAD` (code files only; `.planning`, `docs/*.md` and `.env.example` dropped). Output copied verbatim into the frontmatter. The digest changed from `551aa001...` (fifth pass) to `ef5931a4...` because `reconcile-repair.test.ts` changed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Scheduled reconcile reports per-layer counts and first mismatching key; writes nothing on a clean run | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Report content is tested: counts and caps (reconcile-run.ts:32, :49-107), first key per comparison (reconcile.ts:189-204), identity-only leases (reconcile.ts:78-115), truncation makes the report unclean (reconcile.ts:191, :205). Tests: "a clean fixture reports clean, the unchecked row is counted, and nothing is written" (reconcile-read.test.ts:343), "a dirty fixture reports the first mismatching key for each comparison" (:361), "a capped cache scan makes the run unclean" (:380). The timer gate is tested: service.test.ts:5654. The scheduled tick is not: `reconcileTick` (service.ts:3827-3832) and `runScheduledReconcile` (service.ts:3835-3854) have no test. Routed to Human Verification 1 |
| 2   | Repair is a separate confirmed step with a plan record, following the corpus delete rules | ✓ VERIFIED | Separate step: `plan` writes only its `--out` file, with `wx` (reconcile-main.ts:187-193). `repair` is a dry run unless `--execute` is set (reconcile-main.ts:87-96; reconcile-repair.ts:167-175). Plan record: `planFromReport` (reconcile-repair.ts:86-106), schema `substrate.reconcile.plan.v1`, `report_digest`. Confirmation: digest check (reconcile-repair.ts:141-150), live orphan re-check (:151-161), `planRefusal` for action, match and orphan (:112-123, called at :162-165), `--server-stopped` (:177-186). Ordered flush (:198-220). Result file (reconcile-main.ts:212-220). Behavioral tests: "execute removes answers, then counters, then the forget mark, and only those" (reconcile-repair.test.ts:157), "a failure in the answer pass leaves every counter and the mark in place" (:209), "a failure in the counter pass keeps the forget mark in place" (:228, new, run this pass), "a failure in the mark pass leaves the answers and counters removed and the mark in place" (:250, new, run this pass), "a scan that cannot be completed removes nothing" (:188), "execute without the server stopped refuses and removes nothing" (:270), "a second execute after the first finds nothing and is a no-op" (:176) |

**Score:** 1/2 truths verified (1 present, behavior-unverified; `behavior_unverified: 1`)

### Must-have 1, sub-checks

| Sub-check | Status | Evidence |
| --------- | ------ | -------- |
| Lease comparison uses identity only (surface, session, epoch), never expiry or heartbeats | ✓ VERIFIED | `compareLeases` reconcile.ts:78-115. The only comparison is `surface`, `session_id` and `epoch` (:101-105). No expiry or heartbeat field is read. Tests: reconcile.test.ts (carried forward) |
| Lease reader keeps the newest transition, including a release | ✓ VERIFIED | reconcile-read.ts:178: `if (latest === undefined) latest = transition.hold;` over rows sorted newest first (:171). Test "a newest release frees the key even when an older grant exists" (reconcile-read.test.ts:236, carried forward) |
| Memory reader counts warning-kind audit events as well as note-kind | ✓ VERIFIED | `MEMORY_KINDS = ["note", "warning"]` (reconcile-read.ts:55). `readLedgerMemoryIds` (:194) counts `outcome: "accepted"` with a non-empty `entry_id` (:200). Test "only accepted writes that name an entry id count, and a note without one is ignored" (reconcile-read.test.ts:159) |
| Per-node ledger lookup is capped and reports truncation | ✓ VERIFIED | `readLedgerLatestLeases` slices to `maxLookups` and sets `truncated` when nodes exceed it (reconcile-read.ts:161-162). Caller passes `caps.ledgerLookups` (reconcile-run.ts:70). Default 200 (reconcile-run.ts:32). Tests: "a latest-lease lookup past its cap is truncated, so the run is not clean" (reconcile-read.test.ts:231). "a lookup whose rows run out before any transition is truncated" (:246) |
| Scheduled log line carries the cache-off reason | ⚠️ WARNING | `truncated` is in the line (service.ts:3849). A cache-off tick reads `clean:false` with `truncated["cache.<class>"]: true`. The line does not say "cache off" in words. Owner decision requested (Human Verification 2) |
| Timer is off by default (`SUBSTRATE_RECONCILE_INTERVAL_S` = 0) and writes nothing except its log line | ✓ VERIFIED (default and gate); ⚠️ tick unverified | Default 0: `loadReconcileSettings` (config.ts:1597-1601). `startReconcile` returns false at 0 and otherwise starts an unref'd interval (service.ts:3810-3818; `handle.unref()` at :3814). Test "startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears" (service.test.ts:5654-5663) asserts the return values (false at 0; true, then false on a second call, then true after stop); `afterEach` stops the timer (:5648-5652). The tick writes only its stdout line (service.ts:3849-3850); a skip or failure writes one stderr line (:3837-3839, :3851-3853). The tick is not tested (see Truth 1) |
| Repair is a whole derived-cache flush of `substrate:v1`, confirmed | ✓ VERIFIED | Flush match `substrate:v1:*` (reconcile-repair.ts:15). Limit 1000000 (:18). Refusal on a truncated scan (:200-208). Three passes (:218-220). Tests as in must-have 2 |
| Dry run by default, digest check, orphan re-check, re-run safety | ✓ VERIFIED | Dry run (reconcile-repair.ts:167-175). Digest (:141-150). Orphan re-check (:151-161). Re-run: "a second execute after the first finds nothing and is a no-op" (reconcile-repair.test.ts:176) |
| Hazard H4 is a design decision, not a defect | ✓ VERIFIED as a decision | docs/reconcile.md H4 (line 85) and the Repair section (lines 36-66) state the rationale. Snapshots and the forget mark are cache, and the forget mark goes last. D78-5 (78-CONTEXT.md:48) and H4 (78-CONTEXT.md:63) describe the whole-prefix design; the ordered flush is the amendment recorded in Deviations |

### Known-defect check (78.md): cache off makes the report read clean

**Not reproduced at d43c259e.** The cache-off path reports not clean:

- `ReadThroughCache.scanKeys` returns `{ keys: [], truncated: true }` when the cache is off (cache.ts:1064).
- `runReport` records each class scan's `truncated` (reconcile-run.ts:84-86, :88-90).
- `buildReport` is unclean when any `truncated` is true (reconcile.ts:191, :205).
- The CLI refuses a cache-off config before reading (reconcile-main.ts:106, :163-167).
- Tests: "with the cache off, a scan is empty and incomplete, and an unlink removes nothing" (reconcile-read.test.ts:274). "a capped cache scan makes the run unclean" (:380).

Residual, WARNING: with the cache off the scheduled line shows the cache counts as 0 with `truncated: true`, not as absent (reconcile-run.ts:85). This is Human Verification 2.

### Must-have 2, sub-checks (behavioral, by test)

| Sub-check | Status | Evidence |
| --------- | ------ | -------- |
| The flush is refused unless `--server-stopped` is set, and the check runs after the dry-run branch | ✓ VERIFIED | Dry-run branch returns first (reconcile-repair.ts:167-175); `serverStopped` refusal (:177-186). Test "execute without the server stopped refuses and removes nothing" (reconcile-repair.test.ts:270; asserts no flush scan and no unlink) |
| The CLI rejects `repair --execute` without `--server-stopped` with exit 2, before config or client | ✓ VERIFIED | Parse error at reconcile-main.ts:93-94, thrown from `parseReconcileArgs`, which runs at :150 before `loadConfig` (:158) and `open` (:171). Tests reconcile-main.test.ts:104 ("execute without --server-stopped exits 2 and opens no client") |
| The CLI rejects `--server-stopped` with a command other than `repair` | ✓ VERIFIED | `flagsOf` rejects any flag not in the subcommand's lists (reconcile-main.ts:55-71). `report` takes no flags (:78-80) and `plan` takes only `--out` (:82-86), so `--server-stopped` throws `unknown argument`. Test reconcile-main.test.ts:113 ("--server-stopped with a command other than repair exits 2 and opens no client") |
| A scan that cannot be completed removes nothing | ✓ VERIFIED | Truncated scan refuses (reconcile-repair.ts:200-208). Test reconcile-repair.test.ts:188 |
| Pass order: answers, then counters, then mark; only those removed | ✓ VERIFIED | Groups (reconcile-repair.ts:212-217): answers by `FLUSH_ANSWER_CLASSES`, counters `classOf(key) === "gen"` excluding `FORGET_MARK_KEY`, mark `=== FORGET_MARK_KEY`. Passes awaited in order (:218-220). `classOf` (cache.ts:75-81) returns the head segment, so `substrate:v1:gen:graph:<id>` and `substrate:v1:gen:forgotten` both have class `gen`. Test reconcile-repair.test.ts:157 (checks the order of the three unlink calls, the removed list and the survivors) |
| No path unlinks a counter or the mark before pass 1 returns | ✓ VERIFIED | Each `unlinkPass` is awaited before the next (:218-220). A throw in pass 1 goes to the catch (:221-226) before the counter or mark lists run. A truncated or failing scan returns or throws before any unlink (:199-208). Tests: reconcile-repair.test.ts:209 (one `unlinkKeys` call with the two answer keys only; counters and mark kept) and :228 (pass 2 throws; answers removed, counters and mark kept; `unlinkKeys` called twice) |
| No path unlinks the mark before the counter pass returns | ✓ VERIFIED | Mark pass is the third `unlinkPass` (:220), awaited after the counter pass (:219). Test reconcile-repair.test.ts:250 (pass 3 throws when the list contains `FORGET_MARK_KEY`; answers and counters removed, `repaired` 4, mark kept, `unlinkKeys` called three times) |
| Failed flush keeps its count (callback) and the callback path is reached | ✓ VERIFIED | `unlinkPass` takes each batch through `onBatch` (reconcile-repair.ts:190-197). `unlinkKeys` calls `onBatch` after each batch (cache.ts:1087-1102). Test reconcile-repair.test.ts:330 (callback reports 500, then the unlink throws; `repaired` 500, `error` set) |
| A failing flush scan removes nothing and reports the failure | ✓ VERIFIED | The scan is inside the try (reconcile-repair.ts:198-199). Catch returns `executed:false`, `refused:false`, `error` redacted (:221-226; `failureReason` :73-80). Test "a scan that fails removes nothing and reports the failure" (reconcile-repair.test.ts:351). The test reaches the try, because the report's scans use narrower prefixes (reconcile-run.ts:84, :88) and succeed |
| A failed flush records the result file | ✓ VERIFIED | The result is written in `finally` for every execute (reconcile-main.ts:212-220). Exit 1 on refused or error (:221-224). Test reconcile-main.test.ts:52 ("a failed flush exits 1 and writes the result file with the error"); it passes `--server-stopped` (line 91) |
| Plan gating: other action, other match, orphan not live | ✓ VERIFIED | `planRefusal` (reconcile-repair.ts:112-123), called before the server-stopped check (:162-165). Tests reconcile-repair.test.ts:288 (other match), :300 (other action), :312 (orphan the fresh report does not list). Each leaves the digest unchanged, so each reaches `planRefusal` rather than the digest check |
| The flush touches only `substrate:v1:*` answer, counter and mark keys; budget and emb are never removed | ✓ VERIFIED | Classes (reconcile-repair.ts:21-28; `CACHE_CLASSES` cache.ts). `budget` and `emb` are in neither group (:212-217). Tests assert survivors: reconcile-repair.test.ts:173 |
| Docs match the code | ✓ VERIFIED | docs/reconcile.md: three passes (:40-42), excluded classes (:44), bound 1000000 (:46), server-stopped usage error exit 2 (:52, :65), result file (:53), operator procedure (:56-61). No test or doc text pins the removed partial-flush wording (grep of packages, docs and scripts for "partial" and "whole-prefix" finds nothing relevant) |

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile-repair.ts` | Plan, digest, refusal, ordered confirmed flush | ✓ VERIFIED | `FLUSH_MATCH` :15; `FLUSH_SCAN_LIMIT` :18; `FLUSH_ANSWER_CLASSES` :21; `findingsDigest` :63; `failureReason` :73; `planFromReport` :86; `planRefusal` :112; `executePlan` :134; server-stopped refusal :177; scan refusal :200; passes :218-220 |
| `packages/mcp-server/src/cache.ts` | `scanKeys`, `unlinkKeys` with `onBatch` | ✓ VERIFIED | `classOf` :75; `FORGET_MARK_KEY` :115; `scanKeys` :1061 (cache-off return :1064); `unlinkKeys` :1087 (`onBatch` :1098-1099) |
| `packages/mcp-server/src/reconcile-main.ts` | CLI operator entry | ✓ VERIFIED | `flagsOf` :55; `parseReconcileArgs` (`--execute` needs `--server-stopped` :93-94); usage exit 2 :148-154; `loadConfig` :158; `open` :171; store clients built here (:115-116); result written in `finally` :212-220; exit 1 on refused or error :221-224 |
| `packages/mcp-server/src/reconcile-main.test.ts` | CLI tests | ✓ VERIFIED | :34, :42 (carried forward). :52 (`--server-stopped` at :91). :104 and :113. `GREPTIME_URL` loopback set with the bracket form at :59 |
| `packages/mcp-server/src/reconcile-repair.test.ts` | Repair tests | ✓ VERIFIED | Changed this pass (test-only): new tests at :228 and :250, both run and passing. Shifted by +42 after :227: plan-gating tests now :288, :300, :312; failed-batch test :330; failing-scan test :351; no-server-stopped test :270. Carried: :157, :176, :188, :209, :173 |
| `packages/mcp-server/src/reconcile-read.test.ts` | Reader and cache tests | ✓ VERIFIED | :159, :222, :231, :236, :246, :274, :343, :361, :380 (not changed this pass) |
| `packages/mcp-server/src/service.ts` | Scheduled timer | ⚠️ PRESENT; tick BEHAVIOR UNVERIFIED | `startReconcile` :3810-3818 (tested); `stopReconcile` :3821-3824 (tested); `reconcileTick` :3827-3832 and `runScheduledReconcile` :3835-3854 (untested; `truncated` in line at :3849) |
| `packages/mcp-server/src/service.test.ts` | Timer start test | ✓ VERIFIED | `afterEach` :5648-5652; test :5654-5663 |
| `packages/mcp-server/src/reconcile-run.ts` | Read-only run and caps | ✓ VERIFIED | `DEFAULT_RECONCILE_CAPS` :32; run :49-107; class scans :83-86; generation scan :88-90 |
| `packages/mcp-server/src/reconcile.ts` | Pure comparators and report | ✓ VERIFIED | `compareLeases` :78-115; `compareMemory` :125-137 (both directions); `buildReport` :182-207 (`truncated` :191, `clean` :205) |
| `packages/mcp-server/src/reconcile-read.ts` | Ledger and index readers | ✓ VERIFIED | `MEMORY_KINDS` :55; `LOOKUP_LIMIT` :61; `readLedgerLatestLeases` :157-189 (no time bound: the query at :165-170 matches graph and node only); `readLedgerMemoryIds` :194 |
| `scripts/reconcile.ts` | Thin wrapper, explicit exit | ✓ VERIFIED | Calls `reconcileMain` (:7, :9) and `process.exit(code)` at :14, after output |
| `docs/reconcile.md` | Criteria, repair, hazards, exit codes | ✓ VERIFIED | Matches the code (see Must-have 2) |
| `packages/mcp-server/src/store-lock.test.ts` | Unchanged | ✓ VERIFIED | Not in `git diff --name-only gsd/v18-int-73-75-76...HEAD`, so unchanged on this branch. Only `reconcile-main.ts` (:115-116) builds `GreptimeClient` and `IndexStore` for this feature (`scripts/reconcile.ts:3-5` says so). `consistency-run.ts`, `anchor-run.ts`, `service.ts` and others construct clients under existing code, not this feature |

## Key Link Verification

Step 5 is not applicable as plan-declared: `verify.key-links` exits 66 (NO_INPUT). `78-01-PLAN.md` has no `must_haves.key_links`. The fallback wiring checks were done by reading:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcileMain` | import and call | ✓ WIRED | scripts/reconcile.ts:14 exits with the returned code |
| `reconcileMain` | `parseReconcileArgs` | call before config | ✓ WIRED | reconcile-main.ts:150 |
| `reconcileMain` (repair) | `executePlan` | call with `serverStopped` | ✓ WIRED | reconcile-main.ts:204 |
| `executePlan` | `cache.unlinkKeys` with callback | per pass | ✓ WIRED | reconcile-repair.ts:190-197 |
| `executePlan` | `runReport` | re-run before any write | ✓ WIRED | reconcile-repair.ts:140 |
| `startReconcile` | `reconcileTick` | `setInterval` | ✓ WIRED | service.ts:3813, :3827 |
| `reconcileTick` | `runScheduledReconcile` | single-flight | ✓ WIRED, ⚠️ untested | service.ts:3828, :3837 |
| `service` startup | `startReconcile` | start path | ✓ WIRED | service.ts:3796 |

## Data-Flow Trace (Level 4)

Step 4b applies to the report, which renders live data. Counts come from real scans and reads (reconcile-run.ts:55-90). The flush reads the live `substrate:v1:*` keys and removes only those it classifies (reconcile-repair.ts:198-220). No static return or hardcoded literal feeds these values.

## Artifact Level 1-3 (Step 4)

Step 4 is not applicable as plan-declared: `verify.artifacts` exits 66 (NO_INPUT). Existence, substance and wiring were checked by reading, as in the table above. No artifact is missing or a stub.

## Behavioral Spot-Checks

Each changed test was run once, by name, from `packages/mcp-server`. Nothing else was run. The suite was not run.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Counter-pass failure keeps the forget mark and the counters | `bun test reconcile-repair.test.ts -t "a failure in the counter pass keeps the forget mark in place"` | 1 pass, 0 fail, 9 expect calls | ✓ PASS |
| Mark-pass failure keeps the mark, after answers and counters are removed | `bun test reconcile-repair.test.ts -t "a failure in the mark pass leaves the answers and counters removed and the mark in place"` | 1 pass, 0 fail, 9 expect calls | ✓ PASS |
| Scheduled tick writes nothing | not run; no test exists | n/a | ? SKIP, routed to human (behavior_unverified) |

The earlier fifth-pass results for the other repair and CLI tests are carried forward: their code and assertions are unchanged, and the commit `d43c259e` changes only the test file's two added tests.

## Probe Execution

Not applicable. `find scripts -path '*/tests/probe-*.sh'` finds no probes, and no PLAN or SUMMARY declares one.

## Requirements Coverage

Not applicable. The plan declares no requirement IDs. `.planning/REQUIREMENTS.md` has no line naming Phase 78.

## Deferred Items

None. Step 9b was not needed because there are no gaps to defer.

## Advisory (New Scope, Unevidenced)

Re-verification ran, so this section is included. Each finding below is evidenced by code reading, so none is unevidenced in the Step 7 sense. Each is reported, not blocking.

| # | Finding | Category | Why Advisory |
| --- | ------- | -------- | ------------ |
| 1 | The repair is gated on at least one live generation orphan, not on a clean report. A truncated report (for example the `cache.gen:graph` scan at its 10000 cap, reconcile-run.ts:88-90) can still produce a plan and a repair. The flush itself is fail-closed on its own 1000000-key scan (reconcile-repair.ts:198-208), so removal is still complete or refused. The effect is a partial orphan justification, not a partial removal | architectural | Accepted design reading of D78-6. Owner may tighten to require a clean report |
| 2 | `--server-stopped` is an operator assertion. The code cannot check that the server is stopped (reconcile-main.ts:93-94; reconcile-repair.ts:177-186). The same convention is used by `consistency-run.ts:22-23` | security | Accepted convention. Recorded in the runbook step 1 |

## Anti-Patterns Found

Scan of the lines added by `d43c259e` and by `ee1c9534..d43c259e` for `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER` and the placeholder phrases: no matches. No debt marker is unlinked. Earlier passes scanned the other changed files; none has changed since.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/reconcile-main.test.ts` | 59 | Loopback fixture as `env["GREPTIME_URL"] = ...` | ℹ️ Info | Not a finding. The value is loopback. The bracket form is the convention in `anchor-run.test.ts` (:86, :114) and is not matched by the no-secrets scan in `store-lock.test.ts` |
| `packages/mcp-server/src/reconcile-main.test.ts` | 104 | The "exits 2" test does not assert that config is unread | ℹ️ Info | Config order is by code (reconcile-main.ts:150 before :158). The test asserts exit 2, the message, and that `open` is not reached |
| `packages/mcp-server/src/reconcile-main.ts` | 87-96 | `--server-stopped` is accepted by a dry-run `repair` and ignored there | ℹ️ Info | Harmless. Dry run writes nothing |
| `packages/mcp-server/src/reconcile-repair.test.ts` | 228, 250 | The two new pass-failure tests make the mock throw before any key of that pass is removed | ℹ️ Info | Each test pins the guarantee its name states. A failure part way through a single pass's batches is covered by the callback test at :330, which uses the same `unlinkPass` code for every pass |
| `packages/mcp-server/src/reconcile-repair.test.ts` | 228-248 | The counter-pass test does not assert the `repaired` count | ℹ️ Info | Not claimed by its name. The count on failure is asserted by the mark-pass test (`repaired: 4`, :260) |
| `packages/mcp-server/src/service.ts` | 3837-3839, 3851-3853 | A skipped or failed tick writes one stderr line, not the stdout log line | ℹ️ Info | Matches "writes nothing except its log line" only if a stderr diagnostic counts as the line. Covered by Human Verification 1 |

## Summary claims checked (78-SUMMARY.md at d43c259e)

| Claim | Result | Evidence |
| --- | --- | --- |
| Commit list: `3ad7bc12`, `1e592b8c`, `16513b53`, `cb56ec2a`, `ee1c9534`, `1cfce155`, `d43c259e`; base `0a1f7c68` | ✓ TRUE | `git log --oneline -12` lists all seven in that order; `0a1f7c68` is the merge commit they follow |
| Two regression tests named: "a hold granted before the window is found by its node, with no time bound" and "a lookup whose rows run out before any transition is truncated" | ✓ TRUE | Exact names at reconcile-read.test.ts:222 and :246 |
| Caps: `ledgerRows` 500, `ledgerLookups` 200, `indexRows` 5000, `cacheKeys` 10000 | ✓ TRUE | reconcile-run.ts:32 |
| A held node's latest transition is looked up with no time bound | ✓ TRUE | reconcile-run.ts:70 (comment at :67-69); reconcile-read.ts:165-170 queries by `graph_id` and `node_id` only |
| `cache.ts` `scanKeys` reports `truncated` when the cache is off; `unlinkKeys(keys, onBatch?)` | ✓ TRUE | cache.ts:1064; cache.ts:1087 |
| Scheduled timer is unref'd, off at 0, one read-only report and one log line per tick | ✓ TRUE, with the nuance in Anti-Patterns (skip and failure write stderr) | service.ts:3810-3818; config.ts:1597-1601; service.ts:3835-3854 |
| Flush scans `substrate:v1:*` once, refuses when incomplete, three ordered passes, `budget:` and `emb:` never removed, unnamed keys never removed | ✓ TRUE | reconcile-repair.ts:15, :18, :21-28, :198-220; cache.ts `CACHE_CLASSES` lists `emb` and `budget` as classes outside the answer and `gen` groups |
| Execute needs `--server-stopped`; dry run is the default | ✓ TRUE | reconcile-main.ts:93-94; reconcile-repair.ts:167-186 |
| `reconcile-main.ts` is the only place this feature builds the ledger or index client | ✓ TRUE | reconcile-main.ts:115-116; `scripts/reconcile.ts:3-5` |
| Rejected: reuse of the SCAN loop in `scripts/cache-stats.ts` (5000 keys, 250 ms census; imports from `packages/`) | ✓ TRUE | scripts/cache-stats.ts: `KEY_BUDGET = 5000`, `WALL_BUDGET_MS = 250`; line 29 imports from `../packages/mcp-server/src/cache.ts` |
| Open: memory overlaps `consistency-verify.ts` (legacy pairing, forget and expiry exemptions) | ✓ TRUE | packages/mcp-server/src/consistency-verify.ts exists; its header (:22-37) describes the exemptions. `compareMemory` (reconcile.ts:125) is the simpler two-way set comparison |
| Open: lease identity is not covered by `coord_drift_scan`, which checks lease health | ✓ TRUE | packages/mcp-server/src/drift.ts lease kinds `lease.expired`, `lease.idle`, `lease.orphaned` (:87-91) |
| The stray reconcile line in the primary checkout's `package.json` was removed; a patch copy exists | ✓ TRUE | `grep reconcile` on `/root/src/repos/agent-substrate/package.json` finds nothing; `/root/src/worktrees/backups/primary-package-json-reconcile-line.patch` exists (493 B) |
| Bracket form `env["GREPTIME_URL"]` with a loopback value | ✓ TRUE | reconcile-main.test.ts:59, value `http://127.0.0.1:4000` |
| D78-5 specified a whole-prefix flush; D78-6 did not require `--server-stopped` | ✓ TRUE | 78-CONTEXT.md:48 (D78-5); 78-CONTEXT.md:50 (D78-6, no mention of `--server-stopped`) |
| "STATE, Run 17" records the amendment and the Run 16 correction | ✗ NOT PRESENT at d43c259e | STATE.md's last entry is Run 16 (STATE.md:689); no "Run 17" in the worktree's STATE.md or the primary checkout's. Run 16's environment incident (STATE.md:695) is present. WARNING, see gaps_remaining |
| Open 1: no test calls the tick | ✓ TRUE | grep for `reconcileTick` and `runScheduledReconcile` finds only service.ts |

## Human Verification Required

### 1. Scheduled tick on a clean fixture (behavior_unverified)

**Test:** Start the server with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one tick run, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after.
**Expected:** One `[substrate] reconcile {...}` line with `clean:true`. No ledger, index or cache write. The second tick starts no run.
**Why human:** `reconcileTick` and `runScheduledReconcile` (service.ts:3827-3854) have no test. `runReport`'s write-freedom is tested (reconcile-read.test.ts:343). The wrapper is not.

### 2. Cache-off scheduled line: counts 0 or absent

**Test:** Run the server's scheduled report with the cache off.
**Expected:** The owner chooses. Today the line shows every cache class count as 0 with `truncated: true` (reconcile-run.ts:85-86). A report that is absent for the cache layer is the other option.
**Why human:** A design decision. The report is not clean, so this is not a defect.

### 3. Live Dragonfly SCAN and UNLINK at production key counts

**Test:** With the server stopped, on a copy of production key counts: `repair --plan <file>` (dry run), then `repair --plan <file> --execute --server-stopped`.
**Expected:** The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps `budget:` and `emb:` keys. A prefix above 1000000 keys refuses with nothing removed. `<plan>.result.json` shows `repaired` against `listed`.
**Why human:** Real SCAN and UNLINK cost and behavior at production counts (H5) cannot be exercised by a unit test.

### 4. Live GreptimeDB queryEvents for lease kinds in a busy window

**Test:** Run the report against a busy ledger window.
**Expected:** The lease comparison completes, or reports `truncated` when a node has more than `LOOKUP_LIMIT` (100) rows or the lookup count passes the cap of 200.
**Why human:** Needs a live ledger with real volume.

### 5. Live CLI run with real stores

**Test:** `report`; `repair --plan <file> --execute` without `--server-stopped`; a dry run; `repair --plan <file> --execute --server-stopped`.
**Expected:** Exit codes match docs/reconcile.md. Missing `--server-stopped` exits 2 before any connection. `report` exits 0 or 1. A refused or failed repair exits 1. The result file holds `executed`, `refused`, `repaired`, `listed` and `error`.
**Why human:** Needs live PG, GreptimeDB and Dragonfly.

### 6. Owner decision: the amended design of record, and the missing STATE entry

**Test:** Accept the ordered three-pass flush (D78-5 as amended in `ee1c9534`) and the mandatory `--server-stopped` (D78-6) as the design of record. Record both in STATE.md as Run 17.
**Expected:** STATE.md gets a Run 17 record. `78-SUMMARY.md` cites "STATE, Run 17", which at `d43c259e` does not exist (last entry Run 16, STATE.md:689).
**Why human:** A design-of-record decision. The code cannot settle it. The STATE entry was not present at this HEAD, so its content is not verified here.

## Gaps Summary

**Blocking gaps: none.** Must-have 2 is VERIFIED. Must-have 1 is PRESENT_BEHAVIOR_UNVERIFIED (the tick), which routes to human verification and does not block `passed` by itself. The status is `human_needed`, not `gaps_found`.

**Warnings (non-blocking):**

1. The cache-off scheduled line shows counts 0 with `truncated`, not absent (reconcile-run.ts:85). Owner decision (Human 2).
2. `78-SUMMARY.md` cites "STATE, Run 17" for the amendment and the Run 16 correction, but STATE.md has no Run 17 entry at `d43c259e`. The amendment is recorded only in the summary and in CONTEXT's silence. Owner record needed (Human 6).

**Closed since the fifth pass:**

- The counter-pass and mark-pass failure paths are now tested (reconcile-repair.test.ts:228, :250). Both pass when run by name.
- The summary now names the two regression tests and the D78-6 deviation.

## Deviations and Notes

- **Design, amended after the earlier passes.** CONTEXT D78-5 (78-CONTEXT.md:48) specified one whole-prefix delete. The code runs three ordered passes (reconcile-repair.ts:218-220), with the reason in the flush's own comments and docs/reconcile.md. CONTEXT D78-6 (78-CONTEXT.md:50) did not mention `--server-stopped`. The code now requires it. This is stricter than the design of record, and the owner has to accept it (Human 6).
- **Corpus rules, compared.** The corpus reconcile deletes each named orphan, re-checks it right before the delete, sends only `corpus:` names, and counts a delete only when the plane confirms it. The substrate flush follows the same dry-run and explicit-execute pattern, and it re-checks the plan before removing anything. It does not follow the per-item delete. It removes by class under `substrate:v1:*`, which is the accepted H4 design. `listed` counts plan items and `repaired` counts keys (reconcile-repair.ts:47-52). The units differ, and the code says so.
- **Repair gate.** The repair is gated on at least one live generation orphan and not on a clean report. See Advisory 1.
- **Not a finding: store-lock bracket convention.** `reconcile-main.test.ts:59` uses `env["GREPTIME_URL"] = ...`, the same form as `anchor-run.test.ts`. The value is loopback. No other Greptime literal was added on the branch.
- **Test line numbers.** `reconcile-repair.test.ts` gained 42 lines before the plan-gating and failing-batch tests in this pass. Citations from the fifth pass were updated to the new numbers.
- **Fingerprint.** `covered_files` and `covered_digest` are copied verbatim from `gsd_run query verification.fingerprint` over the 18 changed implementation files from `git diff --name-only gsd/v18-int-73-75-76...HEAD` (`package.json` and the `.ts` files; `.planning`, `docs/*.md` and `.env.example` dropped). The fingerprint auto-adds `78-01-PLAN.md` and `78-SUMMARY.md`.

---

_Verified: 2026-11-02T06:35:01Z_
_Verifier: Claude (gsd-verifier)_
