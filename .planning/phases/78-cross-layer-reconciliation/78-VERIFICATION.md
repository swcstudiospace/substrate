---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T05:45:08Z
status: human_needed
score: 1/2 must-haves verified
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
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
covered_digest: "v3:sha256:777e0080454a45c81c2878f4060253758b987873f596312d6aa4585de6219fe4"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 1/2 must-haves verified
  gaps_closed:
    - "executePlan failing-scan branch now tested: 'a scan that fails removes nothing and reports the failure' (reconcile-repair.test.ts:240) passes this pass. Only the flush's own scan (substrate:v1:*) throws; the report's scans use narrower prefixes (reconcile-run.ts:84, :88) and succeed, so the digest check passes and the failure reaches the try block at reconcile-repair.ts:163-172. Asserts executed false, refused false, repaired 0, a non-empty error with no password, and unlinkKeys never called"
    - "CLI failed-flush path now tested: 'a failed flush exits 1 and writes the result file with the error' (reconcile-main.test.ts:52) passes this pass. Real plan file in a mkdtemp dir; io.open seam returns fake clients; asserts exit 1, the stderr line matching /unlink failed/ (reconcile-main.ts:214-216), and <plan>.result.json with executed false, refused false, repaired 0, error 'unlink failed', recorded_at"
  gaps_remaining:
    - "Scheduled tick (reconcileTick and runScheduledReconcile, service.ts:3827-3854) has no test. Human check; behavior_unverified"
    - "Cache-off scheduled counts read 0 with truncated set, not absent (reconcile-run.ts:85-86; cache.ts:1064). The report is not clean. WARNING, decision requested"
    - "Live-only checks: Dragonfly SCAN and UNLINK at production key counts; GreptimeDB queryEvents in a busy window; a live CLI run with real stores"
  regressions: []
coincidental_reliance_items: []
behavior_unverified_items:
  - truth: "A scheduled reconcile tick (runScheduledReconcile) writes nothing on a clean run and writes one log line"
    test: "Start a server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture, let one interval tick run, and compare ledger, index and cache write counts before and after; start a second tick while one is in flight"
    expected: "One `[substrate] reconcile {...}` line on stdout with clean:true; no ledger, index or cache write; the second tick starts no run"
    why_human: "No test calls reconcileTick or runScheduledReconcile (service.ts:3827-3854). Write-freedom of runReport is tested (reconcile-read.test.ts:343); the scheduled wrapper is not"
human_verification:
  - test: "Scheduled tick on a clean fixture (behavior_unverified)"
    expected: "One stdout line `[substrate] reconcile {...}` with clean:true; ledger, index and cache write counts unchanged; a tick during a run starts nothing"
    why_human: "No test covers service.ts:3827-3854 (the tick, single-flight and log line)"
  - test: "Cache-off scheduled line: counts 0 or absent"
    expected: "With DRAGONFLY_URL unset and the interval at 60, one tick logs clean:false with truncated[cache.<class>]=true. Decide whether counts[cache.<class>]=0 is acceptable or the counts should be omitted and the layer named as unchecked"
    why_human: "Design choice about the report's shape. The report is not clean; the open question is presentation"
  - test: "Live Dragonfly SCAN and UNLINK at production key counts"
    expected: "Per-class counts within the 10,000-key cap; a truncated scan sets truncated; execute removes only substrate:v1:*; a second execute refuses"
    why_human: "Tests use a fake cache. Real SCAN cost (H5) and UNLINK at scale are not exercised"
  - test: "Live GreptimeDB queryEvents for lease kinds in a busy window"
    expected: "ledger.lease_transitions and ledger.memory_writes reported; truncated[ledger.leases] set when a kind fills 500 rows; recent holds not reported as drift"
    why_human: "Tests use fake ledgers"
  - test: "Live CLI run with real stores"
    expected: "report exits 0 or 1; missing --plan exits 2; unreadable plan exits 1; execute writes <plan>.result.json; unset GREPTIME_URL or DRAGONFLY_URL exits 2"
    why_human: "The exit-1 failed-flush and result-file paths are now unit-tested with fakes (reconcile-main.test.ts:52). No run against real stores has been made"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T05:45:08Z
**Status:** human_needed
**Re-verification:** Yes, fourth pass (HEAD cb56ec2a, after 16513b53; the only changes since the third pass are two test files). Earlier passes: gaps_found, human_needed, human_needed.

Must-haves are the ROADMAP Phase 78 success criteria, verbatim (ROADMAP.md:1350-1351). 78-01-PLAN.md declares no `must_haves` and no `requirements:` field, so Steps 4, 5 and 6 are not applicable. Wiring was checked by reading.

1. A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run.
2. Repair is a separate confirmed step with a plan record, following the corpus delete rules.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Scheduled reconcile reports per-layer counts and first mismatching key; writes nothing on a clean run | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | The report is behaviorally tested: lease identity (reconcile-read.test.ts:236), cache-off not clean (cache.ts:1061-1064, reconcile-run.ts:84-86, reconcile.ts:205, reconcile-read.test.ts:274), clean-run write-freedom of `runReport` (reconcile-read.test.ts:343). The timer start gate is tested (service.test.ts:5654-5664). The scheduled tick is not: `reconcileTick` and `runScheduledReconcile` (service.ts:3827-3854) have no test. Per Step 3 rule 5 the truth stays PRESENT_BEHAVIOR_UNVERIFIED and routes to human verification |
| 2   | Repair is a separate confirmed step with a plan record, following the corpus delete rules | ✓ VERIFIED | Plan record `planFromReport` (reconcile-repair.ts:71-91, schema `substrate.reconcile.plan.v1`). Dry run is the default: `execute` is set only by `--execute` (reconcile-main.ts:88); `executePlan` returns before any write when `execute` is false (reconcile-repair.ts:151-160). Digest check (:124-134). Orphan re-check (:135-145). Plan gating `planRefusal` (:97-108, called at :146-149). Whole-prefix flush of `substrate:v1:*` (:13, :164-167). Failed-flush count via `onBatch` (:161-172). Failed scan and failed unlink both return `executed: false` with a redacted error (:168-172). Tests (this pass, run once by name): reconcile-repair.test.ts:240 failing scan, PASS; reconcile-main.test.ts:52 failed flush exit 1 and result file, PASS. Carried forward from earlier passes: dry run :91, digest mismatch :101, orphan gone :115, execute removes only the prefix :142, second execute no-op :152, action refusal :189, orphan refusal :201, failed batch count :219, plan-match refusal :177 |

**Score:** 1/2 truths verified (1 present, behavior-unverified; `behavior_unverified: 1`)

### Must-have 1, sub-checks

| Sub-check | Status | Evidence |
| --------- | ------ | -------- |
| Lease comparison is identity only (surface, session, epoch); never expiry or heartbeats | ✓ VERIFIED | `compareLeases` reconcile.ts:78-115. The only comparison is `surface`, `session_id` and `epoch` at :101-105; no expiry or heartbeat field is read. Tests reconcile.test.ts:23-106 (carried forward) |
| Lease reader keeps the newest transition, including a release | ✓ VERIFIED | reconcile-read.ts:173-178: `if (latest === undefined) latest = transition.hold;` over rows sorted newest first (:171). Test reconcile-read.test.ts:236: release at 1h ago, grant at 5h ago, expects the release (null). Carried forward. Reasoned: the old `??=` lets the older grant replace the release's null, so the test fails on the old line |
| Scheduled log line carries the cache-off reason | ⚠️ WARNING | `truncated` is in the line (service.ts:3849). A cache-off tick reads `clean:false` with `truncated["cache.<class>"]: true`. The line does not say "cache off" in words. Counts stay 0 (reconcile-run.ts:85-86) because `scanKeys` returns empty (cache.ts:1064). Decision requested (Human Verification 2) |
| Memory reader counts warning-kind audit events as well as note-kind | ✓ VERIFIED | `MEMORY_KINDS = ["note", "warning"]` (reconcile-read.ts:55); `readLedgerMemoryIds` (:194-206) keeps only `outcome === "accepted"` with a non-empty `entry_id`. Test reconcile-read.test.ts:159 (carried forward) |
| Per-node ledger lookup is capped and reports truncation | ✓ VERIFIED | `readLedgerLatestLeases` (reconcile-read.ts:157-188): `maxLookups` slice and `truncated` (:161-162); row exhaustion (:183-185); `LOOKUP_LIMIT = 100` (:61). Cap `ledgerLookups: 200` (reconcile-run.ts:24, :32), reported as `truncated["ledger.lease_lookups"]` (:70-71). Tests: reconcile-read.test.ts:231 (past the cap is truncated) and :246 (rows run out before any transition is truncated). Carried forward |
| Scheduled timer off by default (interval 0) and writes nothing except its log line | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Config: unset or 0 gives 0 (config.ts:1596-1601). Gate: `startReconcile` returns false when `intervalS <= 0` (service.ts:3812). Start, second start and restart are tested (service.test.ts:5647-5664, passed on the third pass; file unchanged since). The tick (single-flight :3827-3832; `runScheduledReconcile` :3835-3854) is not tested. Write-freedom of `runReport` is tested (reconcile-read.test.ts:343) |
| Repair confirmed, dry run by default, digest check, orphan re-check, re-run safety | ✓ VERIFIED | See must-have 2 above |
| CLI: usage exits 2, refused plan exits 1, explicit process.exit | ✓ VERIFIED (by reading; tests cover exit 2 and now exit 1 for a failed flush) | Usage exit 2: reconcile-main.ts:145-146 (parse), :153-155 (config), :156-160 (missing config and cache off, via `missingConfig` :94-101, cache check :99). Report exit 1 when not clean :177. Refused or failed execute exit 1 :214-216; outer catch exit 1 :219-221. `scripts/reconcile.ts:14` calls `process.exit(code)`. Tests: reconcile-main.test.ts:34 (unknown subcommand exits 2), :42 (no index exits 2, reads nothing), :52 (failed flush exits 1, writes result file; PASS this pass) |
| Store lock: only `packages/mcp-server/src` builds GreptimeClient or IndexStore for this feature | ✓ VERIFIED | Feature builds clients only in `openReconcileClients`: IndexStore at reconcile-main.ts:108, GreptimeClient at :109. `scripts/reconcile.ts` imports `reconcileMain` and builds none. `git diff gsd/v18-int-73-75-76...HEAD -- packages/mcp-server/src/store-lock.test.ts` is empty (0 lines) |

### Must-have 2, sub-checks (behavioral, by test)

| Check | Status | Evidence |
| ----- | ------ | -------- |
| Flush count after a failed batch: `repaired` keeps the batches already removed | ✓ VERIFIED | Cache level: `unlinkKeys` calls `onBatch(batchRemoved)` after each batch (cache.ts:1094-1098). Test reconcile-read.test.ts:288 (carried forward). Repair level: the callback adds to `repaired` (reconcile-repair.ts:167); the catch returns `repaired` (:168-172). Test reconcile-repair.test.ts:219 (carried forward) |
| Failed scan or unlink returns `executed: false` with a redacted error; the CLI writes the result file | ✓ VERIFIED | Failing scan: reconcile-repair.ts:163-172 (scan at :164). Test reconcile-repair.test.ts:240 PASS this pass. Asserts `executed` false, `refused` false, `repaired` 0, non-empty `error` without `hunter2`, `unlinkKeys` not called. The error goes through `failureReason` (:58-65), which redacts and replaces URLs with `<url>`. Failing unlink: test reconcile-main.test.ts:52 PASS this pass. CLI result file: `finally` write at reconcile-main.ts:205-212 (`<plan>.result.json`, every execute outcome). Same test asserts the file content and exit 1 |
| Plan item naming another action is refused and writes nothing | ✓ VERIFIED | `planRefusal` action branch (reconcile-repair.ts:99-100). Test reconcile-repair.test.ts:189 (carried forward). Digest passes because `...plan` keeps `report_digest` and `findingsDigest` hashes findings only (:48-53) |
| Plan item naming an orphan the fresh report does not list is refused and writes nothing | ✓ VERIFIED | Orphan branch (reconcile-repair.ts:103-104). Test reconcile-repair.test.ts:201 (carried forward). `report_digest` is unchanged, so the digest check at :125 passes and the refusal comes from `planRefusal` |
| Plan read, write, and refused paths | ✓ VERIFIED | `plan` writes with `flag: "wx"` (reconcile-main.ts:183). Unreadable plan exits 1 (:190-194). Dry run exits 0 (:151-160, executed false, refused false) |
| Cache-off `unlinkKeys` removes nothing; `scanKeys` is incomplete | ✓ VERIFIED | cache.ts:1064 (`truncated: true`), :1089 (returns 0). Test reconcile-read.test.ts:274 (carried forward) |

### Known defect check (78.md): cache off makes the report read clean

Checked by reading. The defect as briefed is not present. `ReadThroughCache.scanKeys` returns `{ keys: [], truncated: true }` when the cache is off (cache.ts:1061-1064). `runReport` stores that flag per class and for `gen:graph` (reconcile-run.ts:84-90), and `buildReport` makes `clean` require no truncation (reconcile.ts:205). The CLI refuses to run with the cache off (reconcile-main.ts:94-101, cache check :99, exit 2; docs/reconcile.md:57). The scheduled tick does not check the cache (service.ts:3841-3848), so its line reads `clean:false` with `truncated` set. What remains is presentation, recorded as WARNING in Must-have 1 (counts 0, not absent). Not a must-have failure, since the report is not clean and the reason is in `truncated`.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | Pure comparators and `buildReport` | ✓ VERIFIED | `compareLeases` :78-115, `buildReport` :182-207; `clean` requires no findings and no truncation (:205). Unchanged since 16513b53 |
| `packages/mcp-server/src/reconcile-read.ts` | Readers | ✓ VERIFIED | Lease fix at :178. `readLedgerLatestLeases` :157-188; `readLedgerMemoryIds` :194-206. Unchanged since 16513b53 |
| `packages/mcp-server/src/reconcile-run.ts` | `runReport` | ⚠️ WARNING | Read-only and capped (:32, :49-107). Cache-off counts are 0 with `truncated` true (:85-86). Unchanged since 16513b53 |
| `packages/mcp-server/src/reconcile-repair.ts` | Plan, digest, refusal, confirmed execute | ✓ VERIFIED | `planFromReport` :71-91; `failureReason` :58-65; `findingsDigest` :48-53; `planRefusal` :97-108; `executePlan` :118-177; flush and count :161-172 |
| `packages/mcp-server/src/cache.ts` | `scanKeys`, `unlinkKeys` with `onBatch` | ✓ VERIFIED | `scanKeys` :1061-1079 (cache-off return :1064); `unlinkKeys` :1087-1102 (`onBatch` :1098) |
| `packages/mcp-server/src/reconcile-main.ts` | CLI operator entry | ✓ VERIFIED | Parse :71-91 (`execute` only with `--execute`, :88). Missing config and cache-off exit 2 :94-101, :156-160. Clients :104-120. Result written in `finally` :205-213 |
| `packages/mcp-server/src/reconcile-main.test.ts` | CLI tests | ✓ VERIFIED | Three tests: :34 and :42 (carried forward, both call `reconcileMain`), :52 (PASS this pass) |
| `packages/mcp-server/src/reconcile-repair.test.ts` | Repair tests | ✓ VERIFIED | New :240 (PASS this pass); earlier tests carried forward |
| `scripts/reconcile.ts` | Thin wrapper, explicit exit | ✓ VERIFIED | `process.exit(code)` at :14 |
| `packages/mcp-server/src/service.ts` | Scheduled timer | ⚠️ PRESENT; tick BEHAVIOR UNVERIFIED | `startReconcile` :3810-3818 (tested); `stopReconcile` :3821-3824 (tested); `reconcileTick` :3827-3832 and `runScheduledReconcile` :3835-3854 (untested; `truncated` in line at :3849) |
| `packages/mcp-server/src/service.test.ts` | Timer start test | ✓ VERIFIED | Describe :5647; afterEach stops the timer; test :5654-5664 asserts `startReconcile()` return values false, true, false, then true after `stopReconcile()` |
| `packages/mcp-server/src/config.ts` | `SUBSTRATE_RECONCILE_*` parsing | ✓ VERIFIED | `loadReconcileSettings` :1596-1601; interval unset or 0 gives 0 (off); above 0 clamped to 60..max; window 1..168, default 24 |
| `docs/reconcile.md` | Criteria, hazards, exit codes | ✓ VERIFIED | Exit codes :57 match reconcile-main.ts: exit 1 for a refused, unreadable or failed-part-way `repair` (reconcile-main.ts:192-193, :214-216); exit 2 for usage, missing PG or Greptime URL, and cache off (reconcile-main.ts:94-101). H4 as a design decision (:75). Exit 1 for a not-clean `report` (reconcile-main.ts:177) |

## Key Link Verification

Not applicable as a must-haves check (no `must_haves.key_links`). Wiring checked by reading:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcile-main.ts` | `reconcileMain` import | ✓ WIRED | scripts/reconcile.ts:7 |
| `reconcile-main.ts` | `reconcile-run.ts` / `reconcile-repair.ts` | `runReport`, `planFromReport`, `executePlan` | ✓ WIRED | reconcile-main.ts:175, :181-182, :197 |
| `service.ts` | `reconcile-run.ts` | `runReport` in `runScheduledReconcile` | ✓ WIRED | service.ts:3841 |
| `reconcile-run.ts` | `cache.ts` | `scanKeys` per class and for `gen:graph` | ✓ WIRED | reconcile-run.ts:83-90 |
| `reconcile-repair.ts` | `cache.ts` | `unlinkKeys` with `onBatch` callback | ✓ WIRED | reconcile-repair.ts:167 |
| `startRecall` | `startReconcile` | timer start | ✓ WIRED | service.ts:3796 |

## Data-Flow Trace (Level 4)

Not applicable in the UI sense. The data is ledger, index and cache reads, traced to real sources: `queryEvents` (reconcile-read.ts:165 and the window read), index selects (index-store.ts), and `scan` (cache.ts:1061-1079). None is a static return. The flush count is the sum of `unlink` results per batch (cache.ts:1096).

## Behavioral Spot-Checks

Targeted tests run once each this pass, by name, from the worktree root. No full suite run. The serial gate was not re-run (per the brief); its results are cited below.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Failing scan removes nothing and reports the failure (executePlan) | `bun test packages/mcp-server/src/reconcile-repair.test.ts -t "a scan that fails removes nothing and reports the failure"` | 1 pass, 0 fail | ✓ PASS |
| Failed flush exits 1 and writes the result file with the error (CLI) | `bun test packages/mcp-server/src/reconcile-main.test.ts -t "a failed flush exits 1 and writes the result file with the error"` | 1 pass, 0 fail | ✓ PASS |
| Scheduled tick writes nothing on a clean run (`runScheduledReconcile`) | No test exists | — | ? SKIP (human, behavior_unverified) |
| Cache-off report is not clean | Carried forward (reconcile-read.test.ts:274, PASS on the second pass), composed with reconcile.test.ts:186 | — | [INFERENCE] by composition, not re-run |
| Earlier-pass tests (repair batch count, plan gating, timer start) | Carried forward from the third pass (PASS then); unchanged since | — | Not re-run this pass |

Gate evidence (orchestrator, this tree, not re-run): tsc 0; lint 0; bun test 11497 pass, 2 skip, 0 fail; test:py 0; phase-close 236/0; CLI usage exit 2.

Probe execution: no `scripts/*/tests/probe-*.sh` exists, and neither the PLAN nor any SUMMARY declares one. Not applicable.

## Probe Execution

Not applicable (no probes exist; see Behavioral Spot-Checks).

## Requirements Coverage

Not applicable. 78-01-PLAN.md declares no `requirements:` field, and REQUIREMENTS.md maps no IDs to Phase 78.

## Deferred Items

None. ROADMAP.md has no phase after 78 (no `### Phase 79` or later heading), and no later phase's goal or success criteria cover lease, memory or generation drift, or the cache-off case.

## Advisory (New Scope, Unevidenced)

Re-verification ran. The new-scope checks in this pass are evidenced by reading the code and by the two named tests, or are recorded as gaps.

| # | Finding | Category | Why Advisory |
| - | ------- | -------- | ------------ |
| — | None | — | — |

## Anti-Patterns Found

Scan of added lines in `git diff gsd/v18-int-73-75-76...HEAD` for packages, scripts and docs: no TBD, FIXME, XXX, TODO, HACK or placeholder markers. No debt-marker blocker.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/reconcile-run.ts` | 85-86 | Cache-off cache counts recorded as 0 instead of absent | ⚠️ Warning | Counts read as an empty cache; `truncated` says otherwise. Decision requested |
| `packages/mcp-server/src/reconcile-repair.ts` | 167 | `repaired` is both accumulated in the callback and assigned from the returned total | ℹ️ Info | Equal on success. Either form alone is correct; not a defect |
| `packages/mcp-server/src/reconcile-main.ts` | 205-212 | Result-file write failure after a completed flush exits 1 with no record | ℹ️ Info | Stated for completeness; no test. The flush has already run; the outer catch reports the write error |
| `packages/mcp-server/src/reconcile-main.ts` | 189-194, 162-164 | No result file when the plan is unreadable or the clients fail to open | ℹ️ Info | Neither path reaches the flush, so nothing was removed |
| `packages/mcp-server/src/service.ts` | 3849 | Log line has `truncated` but does not name "cache off" | ℹ️ Info | Operator must infer the cause from the cache flags |
| `packages/mcp-server/src/service.ts` | 3816 | `startReconcile` writes its start line to stdout, which the timer test prints during the run | ℹ️ Info | Cosmetic. The line is the expected start log |
| `packages/mcp-server/src/reconcile-main.test.ts` | 59 | Loopback fixture written as `env["GREPTIME_URL"] = "http://127.0.0.1:4000"` | ℹ️ Info | Not a finding. Value is loopback; no other Greptime literal in the diff. Bracket form is the convention `anchor-run.test.ts` uses (:86, :114). The `store-lock.test.ts:93` pattern matches the key directly followed by `:` or `=`, so the bracket form is not matched |

Resolved since the third pass: the failing-scan branch of `executePlan` (now tested at reconcile-repair.test.ts:240) and the CLI exit-1 and result-file path (now tested at reconcile-main.test.ts:52).

## Human Verification Required

### 1. Scheduled tick on a clean fixture (behavior_unverified)

**Test:** Start a server with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval tick run and compare ledger, index and cache write counts before and after. Start a second tick while one is in flight.
**Expected:** One stdout line `[substrate] reconcile {...}` with `clean:true`. No ledger, index or cache write. The second tick starts no run.
**Why human:** No test covers `reconcileTick` or `runScheduledReconcile` (service.ts:3827-3854). The start gate is tested; the tick is not.

### 2. Cache-off scheduled line: counts 0 or absent

**Test:** Run the server with `DRAGONFLY_URL` unset and the interval at 60. Read one tick's line.
**Expected:** `clean:false`, with `truncated["cache.<class>"]` true for each class. Decide whether `counts["cache.<class>"]: 0` is acceptable, or whether those counts should be omitted and the layer named as unchecked.
**Why human:** A design choice about the report's shape. The report is not clean; the open question is presentation.

### 3. Live Dragonfly SCAN and UNLINK at production key counts

**Test:** `bun run reconcile -- report` against production Dragonfly with the cache on. Then `plan --out` and `repair --plan` (dry run) on a non-production copy, then `--execute`.
**Expected:** Per-class counts within the 10,000-key cap; a truncated scan sets `truncated`; execute removes only `substrate:v1:*`; a second execute refuses.
**Why human:** Tests use a fake cache. Real SCAN cost (H5) and UNLINK at scale are not exercised.

### 4. Live GreptimeDB queryEvents for lease kinds in a busy window

**Test:** Run `report` during a window with heavy `claim`, `warning` and `note` traffic.
**Expected:** `ledger.lease_transitions` and `ledger.memory_writes` reported; `truncated["ledger.leases"]` set when a kind fills 500 rows; recent holds not reported as drift.
**Why human:** Tests use fake ledgers.

### 5. Live CLI run with real stores

**Test:** With `SUBSTRATE_PG_URL`, `GREPTIME_URL` and the cache set: `report` (exit 0 or 1); missing `--plan` (exit 2); unreadable plan (exit 1); an execute that writes `<plan>.result.json`. Then unset `GREPTIME_URL` and confirm exit 2.
**Expected:** Exit codes as in docs/reconcile.md:57; result file present after every execute that reaches the flush.
**Why human:** Exit-1 and result-file paths are unit-tested with fakes only (reconcile-main.test.ts:52). No run against real stores has been made.

## Gaps Summary

No blocking gap: no FAILED truth, no missing or stub artifact, no unwired link, no BLOCKER anti-pattern.

Status is `human_needed` because of:

1. The scheduled tick is untested, so must-have 1 is PRESENT_BEHAVIOR_UNVERIFIED (`behavior_unverified: 1`). The start gate is tested.
2. The cache-off counts still read 0, not absent (WARNING, decision requested).
3. The live-only checks.

Warnings that do not change the status:

- None of the former warnings on test coverage remain open. The failing-scan branch and the CLI exit-1 and result-file path are now tested.

## Deviations and Notes

1. **No SUMMARY.md exists** in the phase directory. The fingerprint's changed-file list stands in for the SUMMARY key-files list.
2. **covered_files** lists the 19 changed code files on this branch versus `gsd/v18-int-73-75-76`. `.env.example` and `docs/config-reference.md` are dropped (not code), as in earlier passes. The fingerprint adds `78-01-PLAN.md` on its own, as it did before. Changed test files are included, so the digest differs from the third pass (267eb283… to 777e0080…), as expected.
3. **Whole-prefix flush (D78-5, H4)** is a design decision, recorded as such (docs/reconcile.md:75). It deletes every key under `substrate:v1:*` found at execute time.
4. **`ledger.memory_writes` counts accepted writes with an `entry_id`** (reconcile-read.ts:200-203), not every memory audit event as D78-9 says. Info, unchanged.
5. **Exit code 1 for a not-clean `report`** (reconcile-main.ts:177) is documented (docs/reconcile.md:34). Info.
6. **Overrides**: none for this phase; none invented.
7. **Test-only change scope (16513b53 to cb56ec2a)**: `reconcile-repair.test.ts` (+28 lines) and `reconcile-main.test.ts` (+60/-1). No non-test code changed. The code line numbers above are unchanged from the third pass; they were re-read this pass.
8. **Gate evidence**: the orchestrator's serial gate on this tree (tsc 0; lint 0; bun test 11497 pass, 2 skip, 0 fail; test:py 0; phase-close 236/0; CLI usage exit 2) is the evidence for the wider suite. This pass ran exactly two named tests, each once, and did not re-run the gate.

---

_Verified: 2026-11-02T05:45:08Z_
_Verifier: Claude (gsd-verifier)_
