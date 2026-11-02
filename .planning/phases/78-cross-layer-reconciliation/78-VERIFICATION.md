---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T07:19:27Z
status: human_needed
score: 2/2 must-haves verified
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
covered_digest: "v3:sha256:5460ba04e388d63017c23c5a558f204f4dde1fc33990717243faece929b182b0"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 1/2 must-haves verified
  gaps_closed:
    - "The scheduled tick had no test (sixth-pass behavior_unverified). Now 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (service.test.ts:5665) drives reconcileTick and passes when run once by name."
    - "With the cache off, the report showed cache counts of 0 with truncated true (sixth-pass WARNING). Now the cache.* counts are omitted, unchecked_layers is ['cache'] and the classes stay truncated (reconcile-run.ts:91-97). Test 'with the cache off, the cache layer is unchecked and absent from the counts, and the run is not clean' (reconcile-read.test.ts:391) passes when run once by name."
    - "The scheduled log line did not say the cache was off (sixth-pass WARNING). It now carries unchecked_layers (service.ts:3849)."
    - "STATE.md had no Run 17 entry at d43c259e (sixth-pass WARNING). Run 17 is present at STATE.md:700 (commit afd35f71)."
  gaps_remaining:
    - "WARNING, documentation: docs/reconcile.md:26 says the scheduled log line carries counts, truncated, first and clean 'but not unchecked_layers'. The code (service.ts:3849) and 78-SUMMARY.md:14 say the line does carry it. One sentence to correct. Not a must-have failure."
    - "Live-only checks: the interval firing and single-flight of the scheduled timer, Dragonfly SCAN and UNLINK at production key counts, GreptimeDB queryEvents in a busy window, and a live CLI run with real stores."
  regressions: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval firing is real-time and no test covers it. The single-flight guard (service.ts:3828, reconcilePass ??=) has no test. The tick body is covered by the named test at service.test.ts:5665"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run), then repair --plan <file> --execute --server-stopped"
    expected: "The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps budget: and emb: keys. A prefix above 1000000 keys refuses with nothing removed. <plan>.result.json shows repaired against listed"
    why_human: "Real SCAN and UNLINK cost and behavior at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores: report; repair --plan <file> --execute without --server-stopped; a dry run; repair --plan <file> --execute --server-stopped"
    expected: "Exit codes match docs/reconcile.md: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing --server-stopped exits 2 before any connection. The result file holds executed, refused, repaired, listed and error"
    why_human: "Needs live PG, GreptimeDB and Dragonfly"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T07:19:27Z
**Status:** human_needed
**Re-verification:** Yes. Seventh pass at HEAD `0d896577`. The prior record (`d43c259e`, the sixth pass, at HEAD `afd35f71`, human_needed, 1/2) is carried forward as `re_verification`. Its frontmatter has no `gaps:` key, so Step 0 selects initial mode. Both must-haves were re-checked. Must-have 2 is carried forward, since none of its files changed after `afd35f71`. Must-have 1 was re-read in full.

## Scope of this pass

- HEAD check: `git -C /root/src/worktrees/as-gsd-v18-p78 log --oneline -1` names `0d896577`.
- Working tree: `git status --short` shows only `.planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md` (uncommitted, read as it stands). This pass writes `78-VERIFICATION.md`, which is the only other phase-directory file it touches.
- Changed since `afd35f71` (`git diff --stat afd35f71 0d896577`): `docs/reconcile.md`, `reconcile-read.test.ts`, `reconcile-run.ts`, `reconcile.test.ts`, `reconcile.ts`, `service.test.ts`, `service.ts`, and `.planning/STATE.md`. `reconcile-repair.ts`, `reconcile-main.ts`, `cache.ts`, `scripts/reconcile.ts`, `reconcile-repair.test.ts`, `reconcile-main.test.ts` and `store-lock.test.ts` did not change, so their evidence from the sixth pass stands at the same line numbers.
- Named tests run this pass, once each, by name from `packages/mcp-server`. All four pass (see Behavioral Spot-Checks).
- Gate evidence is taken from the brief (tsc 0; lint 0; bun test 11506 pass, 2 skip, 0 fail; test:py 0; phase-close 236/0; CLI usage exit 2). The gate and the full suite were not re-run.
- Fingerprint: `gsd_run query verification.fingerprint` over the 18 changed implementation files from `git diff --name-only gsd/v18-int-73-75-76...HEAD` (`package.json` and the 17 `.ts` files; `.planning`, `docs/*.md` and `.env.example` dropped). Output copied verbatim into the frontmatter. The digest changed from `ef5931a4...` (sixth pass) because `service.ts`, `service.test.ts`, `reconcile.ts`, `reconcile-run.ts` and their tests changed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Scheduled reconcile reports per-layer counts and first mismatching key; writes nothing on a clean run | ✓ VERIFIED | Per-layer counts: `runReport` (reconcile-run.ts:55-98). First mismatching key per comparison: `buildReport` (reconcile.ts:205-209). Scheduled line: `runScheduledReconcile` (service.ts:3835-3854; the line object at :3849 carries `counts`, `truncated`, `unchecked_layers`, `first`, `clean`). The tick writes only its stdout line (:3850). Behaviour test for the tick: "one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing" (service.test.ts:5665). It calls `reconcileTick` (:5715-5717), asserts one stdout line with the prefix, `clean: true`, no stderr, and an empty write list for the ledger, index and cache (:5720-5725). Passes this pass. Report tests: "a clean fixture reports clean, the unchecked row is counted, and nothing is written" (reconcile-read.test.ts:343, changed by one line this pass, passes); "a dirty fixture reports the first mismatching key for each comparison" (:361, carried) |
| 2   | Repair is a separate confirmed step with a plan record, following the corpus delete rules | ✓ VERIFIED | Carried forward from the sixth pass. Its code and tests are unchanged since `afd35f71`. Sub-checks below and in Must-have 2 |

**Score:** 2/2 truths verified (0 present, behavior-unverified)

### Must-have 1, sub-checks

| Sub-check | Status | Evidence |
| --------- | ------ | -------- |
| Lease comparison uses identity only (surface, session, epoch), never expiry or heartbeats | ✓ VERIFIED | `compareLeases` reconcile.ts:78-115. The only comparison is `surface`, `session_id` and `epoch`. No expiry or heartbeat field is read. Carried forward, file unchanged |
| Lease reader keeps the newest transition, including a release | ✓ VERIFIED | reconcile-read.ts:178: `if (latest === undefined) latest = transition.hold;`, over rows sorted newest first (:171). Test "a newest release frees the key even when an older grant exists" (reconcile-read.test.ts:236, carried forward) |
| Memory reader counts warning-kind audit events as well as note-kind | ✓ VERIFIED | `MEMORY_KINDS = ["note", "warning"]` (reconcile-read.ts:55). `readLedgerMemoryIds` (:194) counts `outcome: "accepted"` with a non-empty `entry_id` (:200). Test at reconcile-read.test.ts:159 (carried forward) |
| Per-node ledger lookup is capped and reports truncation | ✓ VERIFIED | `readLedgerLatestLeases` slices to `maxLookups` and sets `truncated` (reconcile-read.ts:161-162). Caller passes `caps.ledgerLookups` (reconcile-run.ts:70). Default 200 (reconcile-run.ts:32). Tests: reconcile-read.test.ts:231 and :246 (carried forward) |
| Cache layer when off is unchecked, never zero | ✓ VERIFIED | See "Known-defect check" below. `unchecked_layers` names `cache` (reconcile-run.ts:97, :112; reconcile.ts:203). The `cache.*` counts are omitted (reconcile-run.ts:93-96). The classes stay truncated (:95), so the run is not clean (reconcile.ts:210). Test: reconcile-read.test.ts:391, run this pass, passes. Assertions: `unchecked_layers` equals `["cache"]`, no `cache.*` key in `counts`, `index.holds` still counted, `truncated["cache.brief"]` and `truncated["cache.gen:graph"]` true, `clean` false |
| Scheduled log line carries the cache-off reason | ✓ VERIFIED | The line includes `unchecked_layers` (service.ts:3849), so a cache-off tick names the layer in words. The line content is checked by reading and by the runReport test. No tick test runs a cache-off fixture (see Gaps, WARNING 2) |
| Timer is off by default (`SUBSTRATE_RECONCILE_INTERVAL_S` = 0) and writes nothing except its log line | ✓ VERIFIED | Default 0: `loadReconcileSettings` (config.ts:1597-1601). `startReconcile` returns false at 0 and otherwise starts an unref'd interval (service.ts:3810-3818; `setInterval` :3813, `unref` :3814). Test "startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears" (service.test.ts:5654-5663, unchanged) asserts the return values, and `afterEach` stops the timer (:5649-5652). The tick writes only its stdout line (service.ts:3849-3850). A skip or failure writes one stderr line (:3837-3839, :3851-3853). The tick body is tested at service.test.ts:5665. The firing cadence is not (see Human Verification 1) |
| Repair is a whole derived-cache flush of `substrate:v1`, confirmed | ✓ VERIFIED | Flush match `substrate:v1:*` (reconcile-repair.ts:15). Limit 1000000 (:18). Refusal on a truncated scan (:200-208). Three passes (:218-220). Tests as in Must-have 2. The flush removes answer, counter and mark keys only, not the whole prefix; the design amendment is recorded in the Deviations section |
| Dry run by default, digest check, orphan re-check, re-run safety | ✓ VERIFIED | Dry run (reconcile-repair.ts:167-175). Digest (:141-150). Orphan re-check (:151-161). Re-run: "a second execute after the first finds nothing and is a no-op" (reconcile-repair.test.ts:176, carried forward) |
| Hazard H4 is a design decision, not a defect | ✓ VERIFIED as a decision | docs/reconcile.md H4 and the Repair section state the rationale. D78-5 (78-CONTEXT.md:48) and H4 (78-CONTEXT.md:63) describe the whole-prefix design; the ordered flush is the amendment recorded in Deviations |

### Known-defect check (78.md): cache off makes the report read clean

**Not reproduced at `0d896577`. The cache-off run is not clean, and the cache layer is no longer shown as zero.**

- `ReadThroughCache.scanKeys` returns `{ keys: [], truncated: true }` when the cache is off (cache.ts:1064).
- `runReport` detects an off cache when every class scan and the generation scan is empty and truncated (reconcile-run.ts:91). Each scan is recorded (:93-96). The layer is named unchecked (:97) and passed to the report (:112).
- The detection is equivalent to "the cache is off" for a live cache. A live `scanKeys` ends truncated only when its loop stops with `found.size > cap` (cache.ts:1071-1078). A cap of at least 1 then means keys is non-empty. So a live cache with an empty result is never mistaken for an off cache, and an off cache is never reported with zero counts.
- `buildReport` is unclean when any `truncated` is true (reconcile.ts:210). `unchecked_layers` does not affect `clean` directly; the guarantee rests on the cache classes staying truncated (reconcile-run.ts:95). Test reconcile-read.test.ts:401-406 asserts both `clean` false and the truncated cache classes, so a change that dropped the flags would fail it.
- The CLI refuses a cache-off config before reading (reconcile-main.ts:106, :163-167, unchanged).
- Tests: "with the cache off, a scan is empty and incomplete, and an unlink removes nothing" (reconcile-read.test.ts:274, carried); "with the cache off, the cache layer is unchecked and absent from the counts, and the run is not clean" (:391, run this pass, passes); "unchecked layers are reported as given, and the run is not clean while one of its classes is truncated" (reconcile.test.ts:188, run this pass, passes); "a clean fixture reports clean..." (reconcile-read.test.ts:343, `unchecked_layers` equals `[]` at :353, run this pass, passes).
- Zero counts for an unread cache: none reported. The `cache.*` keys are absent when the cache is off, and present with real values when it is on (reconcile-run.ts:93-96).

### Must-have 2, sub-checks (behavioral, by test; carried forward)

Files unchanged since `afd35f71`. Evidence from the sixth pass stands.

| Sub-check | Status | Evidence |
| --------- | ------ | -------- |
| The flush is refused unless `--server-stopped` is set, and the check runs after the dry-run branch | ✓ VERIFIED | Dry-run branch returns first (reconcile-repair.ts:167-175); `serverStopped` refusal (:177-186). Test "execute without the server stopped refuses and removes nothing" (reconcile-repair.test.ts:270) |
| The CLI rejects `repair --execute` without `--server-stopped` with exit 2, before config or client | ✓ VERIFIED | Parse error at reconcile-main.ts:93-94, thrown from `parseReconcileArgs`, which runs at :150 before `loadConfig` (:158) and `open` (:171). Test reconcile-main.test.ts:104 |
| The CLI rejects `--server-stopped` with a command other than `repair` | ✓ VERIFIED | `flagsOf` rejects any flag not in the subcommand's list (reconcile-main.ts:55-71). Test reconcile-main.test.ts:113 |
| A scan that cannot be completed removes nothing | ✓ VERIFIED | Truncated scan refuses (reconcile-repair.ts:200-208). Test reconcile-repair.test.ts:188 |
| Pass order: answers, then counters, then mark; only those removed | ✓ VERIFIED | Groups (reconcile-repair.ts:212-217): answers by `FLUSH_ANSWER_CLASSES` (:21-28, the six classes `brief`, `memory-search`, `graph-view`, `brief-snapshot`, `recall-snapshot`, `docs-search`), counters `classOf(key) === "gen"` excluding `FORGET_MARK_KEY`, mark `=== FORGET_MARK_KEY`. Passes awaited in order (:218-220). Test reconcile-repair.test.ts:157 |
| No path unlinks a counter or the mark before pass 1 returns | ✓ VERIFIED | Each `unlinkPass` is awaited before the next (:218-220). Tests reconcile-repair.test.ts:209 and :228 |
| No path unlinks the mark before the counter pass returns | ✓ VERIFIED | Test reconcile-repair.test.ts:250 |
| Failed flush keeps its count (callback) and the callback path is reached | ✓ VERIFIED | `unlinkPass` takes each batch through `onBatch` (reconcile-repair.ts:190-197). `unlinkKeys` calls `onBatch` after each batch (cache.ts:1087-1102). Test reconcile-repair.test.ts:330 |
| A failing flush scan removes nothing and reports the failure | ✓ VERIFIED | Scan inside the try (reconcile-repair.ts:198-199). Catch returns `executed:false`, `refused:false`, redacted `error` (:221-226). Test reconcile-repair.test.ts:351 |
| A failed flush records the result file | ✓ VERIFIED | Result written in `finally` for every execute (reconcile-main.ts:212-220). Exit 1 on refused or error (:221-224). Test reconcile-main.test.ts:52 |
| Plan gating: other action, other match, orphan not live | ✓ VERIFIED | `planRefusal` (reconcile-repair.ts:112-123), called before the server-stopped check (:162-165). Tests reconcile-repair.test.ts:288, :300, :312 |
| The flush touches only `substrate:v1:*` answer, counter and mark keys; budget and emb are never removed | ✓ VERIFIED | `budget` and `emb` are in neither group (reconcile-repair.ts:212-217). Test reconcile-repair.test.ts:173 |
| Docs match the code (repair section) | ✓ VERIFIED | docs/reconcile.md Repair section: three passes, excluded classes, bound 1000000, exit 2 for a missing `--server-stopped`. The scheduled-report paragraph is a separate matter, see the Warning below |

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile-run.ts` | Read-only run, caps, cache-off detection | ✓ VERIFIED | Class scans and the generation scan :83-90; `cacheOff` :91; counts guard :93-96; `uncheckedLayers` :97; `buildReport` :106-114 |
| `packages/mcp-server/src/reconcile.ts` | Pure comparators and report | ✓ VERIFIED | `Report.unchecked_layers` :35; `ReportInput.unchecked_layers` :49; `buildReport` :186-211 (`unchecked_layers` passed through :203; `clean` :210); `compareLeases` :78-115; `compareMemory` :125-137 |
| `packages/mcp-server/src/service.ts` | Scheduled timer and tick | ✓ VERIFIED | `startReconcile` :3810-3818 (`setInterval` :3813, `unref` :3814, start line :3816); `stopReconcile` :3821-3824; `reconcileTick` :3827-3832; `runScheduledReconcile` :3835-3854 (line object :3849; skip and failure stderr :3837-3839, :3851-3853) |
| `packages/mcp-server/src/service.test.ts` | Timer and tick tests | ✓ VERIFIED | `afterEach` :5649-5652; start test :5654-5663; tick test :5665-5730 (cast to `reconcileTick` at :5715-5717; assertions :5720-5725) |
| `packages/mcp-server/src/reconcile-read.test.ts` | Reader and cache tests | ✓ VERIFIED | :159, :222, :231, :236, :246, :274, :343 (`unchecked_layers` :353), :361, :380, :391 |
| `packages/mcp-server/src/reconcile.test.ts` | Core report tests | ✓ VERIFIED | `unchecked_layers` in the fixture :172; "unchecked layers are reported as given..." :188 |
| `packages/mcp-server/src/cache.ts` | `scanKeys`, `unlinkKeys` with `onBatch` | ✓ VERIFIED | `scanKeys` :1061 (cache-off return :1064; loop :1071-1075; return :1078); `unlinkKeys` :1087 (`onBatch` :1098-1099). Unchanged since `afd35f71` |
| `packages/mcp-server/src/reconcile-repair.ts` | Plan, digest, refusal, ordered confirmed flush | ✓ VERIFIED | Unchanged since `afd35f71`. Line evidence as in Must-have 2 |
| `packages/mcp-server/src/reconcile-main.ts` | CLI operator entry | ✓ VERIFIED | Unchanged since `afd35f71`. Line evidence as in Must-have 2 |
| `packages/mcp-server/src/reconcile-repair.test.ts`, `reconcile-main.test.ts` | Repair and CLI tests | ✓ VERIFIED | Unchanged since `afd35f71` |
| `scripts/reconcile.ts` | Thin wrapper, explicit exit | ✓ VERIFIED | Calls `reconcileMain` and `process.exit(code)` after output. Unchanged since `afd35f71` |
| `docs/reconcile.md` | Criteria, repair, hazards, exit codes | ⚠️ WARNING | Repair section matches the code. Line 26 (the scheduled-report paragraph) states the scheduled line lacks `unchecked_layers`. The code includes it (service.ts:3849). See Gaps, WARNING 1 |
| `packages/mcp-server/src/store-lock.test.ts` | Unchanged | ✓ VERIFIED | Not in the branch diff since `afd35f71`. Only `reconcile-main.ts` (:115-116) builds `GreptimeClient` and `IndexStore` for this feature (`scripts/reconcile.ts` says so) |

## Key Link Verification

Step 5 is not applicable as plan-declared: `78-01-PLAN.md` has no `must_haves.key_links`. The wiring checks were done by reading.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcileMain` | import and call | ✓ WIRED | scripts/reconcile.ts exits with the returned code |
| `reconcileMain` | `parseReconcileArgs` | call before config | ✓ WIRED | reconcile-main.ts:150 |
| `reconcileMain` (repair) | `executePlan` | call with `serverStopped` | ✓ WIRED | reconcile-main.ts:204 |
| `executePlan` | `cache.unlinkKeys` with callback | per pass | ✓ WIRED | reconcile-repair.ts:190-197 |
| `executePlan` | `runReport` | re-run before any write | ✓ WIRED | reconcile-repair.ts:140 |
| `startReconcile` | `reconcileTick` | `setInterval` | ✓ WIRED | service.ts:3813, :3827 |
| `reconcileTick` | `runScheduledReconcile` | single-flight | ✓ WIRED; single-flight untested | service.ts:3828, :3835 |
| `runScheduledReconcile` | `runReport` | call with `DEFAULT_RECONCILE_CAPS` | ✓ WIRED | service.ts:3841-3848 |
| `runReport` | `cache.scanKeys` | class and generation scans | ✓ WIRED | reconcile-run.ts:86-90 |
| `service` startup | `startReconcile` | start path | ✓ WIRED | service.ts:3796 |

## Data-Flow Trace (Level 4)

The report renders live data. Counts come from real reads and scans (reconcile-run.ts:55-90). The off-cache case reports no count at all. The flush reads the live `substrate:v1:*` keys and removes only those it classifies (reconcile-repair.ts:198-220). No static return or hardcoded literal feeds these values.

## Behavioral Spot-Checks

Each changed test was run once, by name, from `packages/mcp-server`. Nothing else was run. The suite was not run.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Scheduled tick logs one clean line and writes nothing | `bun test service.test.ts -t "one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing"` | 1 pass, 322 filtered out, 0 fail, 5 expect calls | ✓ PASS |
| Cache off: unchecked, absent from counts, not clean | `bun test reconcile-read.test.ts -t "with the cache off, the cache layer is unchecked and absent from the counts, and the run is not clean"` | 1 pass, 16 filtered out, 0 fail, 6 expect calls | ✓ PASS |
| Clean fixture: clean, `unchecked_layers` empty, nothing written | `bun test reconcile-read.test.ts -t "a clean fixture reports clean, the unchecked row is counted, and nothing is written"` | 1 pass, 16 filtered out, 0 fail, 11 expect calls | ✓ PASS |
| Core: unchecked layer reported, not clean while truncated | `bun test reconcile.test.ts -t "unchecked layers are reported as given, and the run is not clean while one of its classes is truncated"` | 1 pass, 50 filtered out, 0 fail, 2 expect calls | ✓ PASS |

Step 7b classification: the tick test shows the tick writes nothing and logs one clean line, which is the state-transition-free side-effect invariant of Must-have 1. It is the single named test that closes the sixth pass's behavior_unverified item. The interval firing is not covered (see Human Verification 1).

Probe Execution: not applicable. `find scripts -path '*/tests/probe-*.sh'` finds no probes, and no PLAN or SUMMARY declares one.

Requirements Coverage: not applicable. The plan declares no requirement IDs, and `.planning/REQUIREMENTS.md` has no line naming Phase 78.

## Anti-Patterns Found

Scan of the lines added by `git diff afd35f71 0d896577` (packages, scripts, docs) for `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER` and placeholder phrases: no matches. No debt marker is unlinked.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/reconcile.md` | 26 | States the scheduled log line lacks `unchecked_layers`; the code includes it (service.ts:3849) | ⚠️ Warning | Wrong documentation of the scheduled line. Not a truth failure. See Gaps, WARNING 1 |
| `packages/mcp-server/src/service.test.ts` | 5665-5730 | The tick test calls `reconcileTick` through a typed cast, not the interval | ℹ️ Info | The cast reason is stated in the test. The name says "tick", which the test exercises. The interval wiring is one `setInterval` call (service.ts:3813) |
| `packages/mcp-server/src/service.test.ts` | 5665-5730 | Only the clean fixture is run through the tick | ℹ️ Info | The cache-off line content is covered by the runReport test, not through the tick (Gaps, WARNING 2) |
| `packages/mcp-server/src/service.ts` | 3816 | `startReconcile` writes one stdout line at start (`reconcile: every N s ...`) | ℹ️ Info | Once at start, not per tick. Per-tick output is one line (:3849-3850) |
| `packages/mcp-server/src/service.ts` | 3837-3839, 3851-3853 | A skipped or failed tick writes one stderr line, not the stdout line | ℹ️ Info | Carried from the sixth pass |
| `packages/mcp-server/src/reconcile-main.test.ts` | 59 | Loopback fixture as `env["GREPTIME_URL"] = ...` | ℹ️ Info | Not a finding. The value is loopback. Bracket form is the convention in `anchor-run.test.ts` |

## Summary claims checked (78-SUMMARY.md as it now stands)

| Claim | Result | Evidence |
| --- | --- | --- |
| Branch `gsd/v18-p78-reconcile`, base `0a1f7c68`; commit list through `0d896577` (`3ad7bc12`, `1e592b8c`, `16513b53`, `cb56ec2a`, `ee1c9534`, `1cfce155`, `d43c259e`, `afd35f71`, `9908aa2b`, `0d896577`) | ✓ TRUE | `git log --oneline -12` lists the commits in that order with the stated subjects; `0a1f7c68` is the merge commit they follow |
| `reconcile.ts`: identity-only leases; memory both ways; generation orphans; "never clean when a layer is truncated"; names an unchecked layer in `unchecked_layers` | ✓ TRUE | reconcile.ts:78-115 (leases), :125-137 (memory), :162-174 (generations), :210 (`clean`), :35 and :203 (`unchecked_layers`) |
| Caps `ledgerRows` 500, `ledgerLookups` 200, `indexRows` 5000, `cacheKeys` 10000 | ✓ TRUE | reconcile-run.ts:32 |
| A held node's latest transition is looked up with no time bound | ✓ TRUE | reconcile-run.ts:67-70; reconcile-read.ts:165-170 queries by graph and node only |
| With the cache off: layer listed in `unchecked_layers`, counts omitted, classes truncated, run never clean | ✓ TRUE | reconcile-run.ts:91-97, :112; test reconcile-read.test.ts:391 |
| `cache.ts`: `scanKeys` reports `truncated` when off; `unlinkKeys(keys, onBatch?)` | ✓ TRUE | cache.ts:1064; cache.ts:1087 |
| `service.ts`: unref'd timer behind `SUBSTRATE_RECONCILE_INTERVAL_S` (default 0); each tick one read-only report and one log line with `counts`, `truncated`, `unchecked_layers`, `first`, `clean` | ✓ TRUE | service.ts:3813-3814; config.ts:1597-1601; service.ts:3849 (the line also carries `schema` and `generated_at`, which the summary does not list) |
| Flush: `substrate:v1:*` scanned once, refused when incomplete, three ordered passes, `budget:` and `emb:` and unnamed keys never removed | ✓ TRUE | reconcile-repair.ts:15, :18, :21-28, :198-220; the answer list is exactly the six classes named in the summary |
| Execute needs `--server-stopped`; dry run is the default | ✓ TRUE | reconcile-main.ts:93-94; reconcile-repair.ts:167-186 |
| `reconcile-main.ts` is the only place this feature builds the ledger or index client | ✓ TRUE | reconcile-main.ts:115-116; `scripts/reconcile.ts` header |
| Rejected: reuse of `scripts/cache-stats.ts` SCAN loop | Owner-delegated decision, not checked as code | Recorded as design of record |
| Rejected: "missing lease key is free"; the two named tests exist with those names | ✓ TRUE | reconcile-read.test.ts:222 and :246 |
| D78-5 and D78-6 amendments; CONTEXT not edited | Owner-delegated decisions, not checked as code. The code matches them (reconcile-repair.ts:218-220; reconcile-main.ts:93-94). STATE.md Run 17 is present (STATE.md:700) | Recorded as design of record |
| Cache layer when off; memory overlap not converged | Owner-delegated decisions. The code matches the first (reconcile-run.ts:91-97). The second is consistent with `compareMemory` (reconcile.ts:125-137) and docs/reconcile.md | Recorded as design of record |
| Bracket form `env["GREPTIME_URL"]` with a loopback value | ✓ TRUE | reconcile-main.test.ts:59 |
| Gate results (11506 pass, 2 skip, 0 fail; tsc 0; lint 0; test:py 0; phase-close 236/0) | Taken from the brief; not re-run | Brief, this pass |
| "Gate runs were voided once by a full root filesystem" | Not verified; no artifact was read | [INFERENCE] from the summary text only |

## Human Verification Required

### 1. Scheduled interval: one clean tick, and single-flight

**Test:** Start the server with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after.
**Expected:** One `[substrate] reconcile {...}` line per tick, with `clean:true`. No ledger, index or cache write. The second tick starts no second run.
**Why human:** The interval cadence is real-time. No test fires the interval. The single-flight guard `reconcilePass ??=` (service.ts:3828) has no test. The tick body is covered by service.test.ts:5665.

### 2. Live Dragonfly SCAN and UNLINK at production key counts

**Test:** With the server stopped, on a copy of production key counts: `repair --plan <file>` (dry run), then `repair --plan <file> --execute --server-stopped`.
**Expected:** The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps `budget:` and `emb:` keys. A prefix above 1000000 keys refuses with nothing removed. `<plan>.result.json` shows `repaired` against `listed`.
**Why human:** Real SCAN and UNLINK cost and behavior at production counts (H5) cannot be exercised by a unit test.

### 3. Live GreptimeDB queryEvents in a busy window

**Test:** Run the report against a busy ledger window.
**Expected:** The lease comparison completes, or reports `truncated` when a node exceeds `LOOKUP_LIMIT` (100) rows or the lookup count passes the cap of 200.
**Why human:** Needs a live ledger with real volume.

### 4. Live CLI run with real stores

**Test:** `report`; `repair --plan <file> --execute` without `--server-stopped`; a dry run; `repair --plan <file> --execute --server-stopped`.
**Expected:** Exit codes match docs/reconcile.md: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing `--server-stopped` exits 2 before any connection. The result file holds `executed`, `refused`, `repaired`, `listed` and `error`.
**Why human:** Needs live PG, GreptimeDB and Dragonfly.

## Gaps Summary

**Blocking gaps: none.** Both must-haves are VERIFIED. No truth FAILED, no artifact MISSING or STUB, no key link NOT_WIRED, and the debt-marker scan found nothing. Status is `human_needed` by the decision tree's second rule, because the human items above are non-empty. No `gaps:` section is written.

**Warnings (non-blocking):**

1. **Documentation contradicts the code, docs/reconcile.md:26.** The paragraph says the scheduled log line carries `counts`, `truncated`, `first` and `clean`, "but not `unchecked_layers`". The code includes it (service.ts:3849), and 78-SUMMARY.md:14 says it does. The sentence should say the line carries `unchecked_layers` too. This verifier does not edit other files, so the correction is for the author. The truth it describes (the line reports counts and the first key, and writes nothing on a clean run) is not affected.
2. **No test runs a cache-off fixture through the scheduled tick.** The cache-off line content (`unchecked_layers` in the line, service.ts:3849) is covered by reading and by the runReport test (reconcile-read.test.ts:391), not by a tick test. Low risk: the line copies the report field.

**Closed since the sixth pass:**

- The scheduled tick has a passing test (service.test.ts:5665).
- The cache-off report is unchecked and not zero (reconcile-run.ts:91-97; reconcile-read.test.ts:391).
- The scheduled line names the unchecked layer (service.ts:3849).
- STATE.md has the Run 17 entry (STATE.md:700).

## Deviations and Notes

- **Design, amended after the earlier passes.** CONTEXT D78-5 (78-CONTEXT.md:48) specified one whole-prefix delete. The code runs three ordered passes (reconcile-repair.ts:218-220). CONTEXT D78-6 (78-CONTEXT.md:50) did not mention `--server-stopped`; the code requires it. Both amendments are recorded in STATE.md Run 17 (STATE.md:700) and in 78-SUMMARY.md. They are owner-delegated decisions and are recorded here as design of record, not as facts this pass verified about the code. The code matches them.
- **Cache-off design, owner-delegated.** The report names the cache layer unchecked and omits its counts, instead of reporting zero (78-SUMMARY.md, "Decisions carried from the context"). This pass checked that the code does this, not that the choice is right.
- **Memory overlap, owner-delegated.** Not converged with `consistency-verify.ts` in this phase (78-SUMMARY.md). The report's memory check is the ledger-to-index window comparison.
- **Interval firing judged by reading.** The tick body is tested. The interval is one `setInterval` call (service.ts:3813) whose callback is the tested tick. Its real-time cadence is a human check (Human Verification 1), not a separate PRESENT_BEHAVIOR_UNVERIFIED truth. If the owner counts the cadence as a behavior-dependent truth, `behavior_unverified` would be 1 and the status would not change, since it is already `human_needed`.
- **Store-lock bracket convention.** `reconcile-main.test.ts:59` uses `env["GREPTIME_URL"] = ...`, the same form as `anchor-run.test.ts`. The value is loopback. No other Greptime literal was added on the branch.
- **Fingerprint.** `covered_files` and `covered_digest` are copied verbatim from `gsd_run query verification.fingerprint` over the 18 changed implementation files (`package.json` and the 17 `.ts` files). `.planning`, `docs/*.md` and `.env.example` are dropped.

## Advisory (New Scope, Unevidenced)

Carried forward from the sixth pass. Each is evidenced by code reading, so none is unevidenced in the Step 7 sense. Each is reported, not blocking.

| # | Finding | Category | Why Advisory |
| --- | ------- | -------- | ------------ |
| 1 | The repair is gated on at least one live generation orphan, not on a clean report. A truncated report (for example the `cache.gen:graph` scan at its 10000 cap, reconcile-run.ts:88-90) can still produce a plan and a repair. The flush itself is fail-closed on its own 1000000-key scan (reconcile-repair.ts:198-208), so removal is still complete or refused. The effect is a partial orphan justification, not a partial removal | architectural | Accepted design reading of D78-6. Owner may tighten to require a clean report |
| 2 | `--server-stopped` is an operator assertion. The code cannot check that the server is stopped (reconcile-main.ts:93-94; reconcile-repair.ts:177-186). The same convention is used by `consistency-run.ts:22-23` | security | Accepted convention. Recorded in the runbook step 1 |

---

_Verified: 2026-11-02T07:19:27Z_
_Verifier: Claude (gsd-verifier)_
