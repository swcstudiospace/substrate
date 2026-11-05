---
phase: 78-cross-layer-reconciliation
verified: 2026-11-05T07:10:22Z
status: human_needed
score: "9/9 must-haves verified; behavior_unverified 0; 4 live proofs open (human); HARD-H2 ORPHANED in REQUIREMENTS.md (owner)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 42e3cf13"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (SC1, SC2)"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/reconcile.md", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.test.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:3bb78a6d1f95467815a5dcf6e90ff4e480ba4621dfa6c48aba41533f86956466"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "9/9 must-haves verified (ca9d02ec record, covered_digest v3:sha256:74f6d2bff0fe72cb339fb9ad15a9f945fae922408abaa452908e7d6ccb23fdcd)"
  selection: "Prior record carries a non-empty gaps_remaining list and no open gaps: re-verification mode. Covered files were diffed from ca9d02ec to 42e3cf13 with git diff; carried claims are marked as such."
  changed_since_previous: "ca9d02ec..42e3cf13. Two covered implementation files changed, neither on the phase 78 reconcile path. (a) cache.ts: snapshotSurvivesForget is now a wrapper over the new forgetVerdict (9e6fa1f2, 9c86ffab); its boolean behaviour is unchanged. scanKeys (:1069) and unlinkKeys (:1095) bodies are untouched; the hunk moved them by +8 lines. (b) service.ts: in-process last-good brief (rememberLastGood, inProcessLastGood, briefForgottenAtMs) and the brief read path (phase 75, H-1). Hunks at service.ts lines 54, 543, 1642, 2495, 2594, 2723 and 4545 only; none touches the reconcile timer, which now sits at :4229-4250 (was :4183-4208). service.test.ts, the reconcile-repair, reconcile-main, reconcile-read, reconcile and corpus files, config.ts, index-store.ts, reconcile-run.ts, reconcile.ts and docs/reconcile.md are unchanged in range. Docs commits e185cd8a and 42e3cf13 (docs/observability.md, docs/config-reference.md) are not covered files. Counter-cut commit 463f42f4 is an ancestor of HEAD. The covered digest changed because cache.ts and service.ts changed; the covered list is the same 21 entries."
  gaps_closed:
    - "Re-verified against HEAD 42e3cf13: no truth regressed; the covered digest moved with the two changed files"
  gaps_remaining:
    - "Operator items 1 to 4 (live proofs). Not run in this pass; open"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at 42e3cf13; owner or orchestrator decision"
    - "512-unit session and node_id straddle (pre-existing, owner decisions). Unchanged"
  regressions: []
advisory: []
overrides: []
gaps: []
human_verification:
  - test: "Scheduled tick on a staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 and a live ledger, index and cache"
    expected: "One '[substrate] reconcile {...}' line per tick with clean:true; no ledger, index or cache write; a second tick while a run is in flight starts no second run"
    why_human: "Live cadence and real stores cannot be observed by unit tests. The single-flight case is covered by a named test and is not a reason for this item"
  - test: "Live Dragonfly SCAN and UNLINK at production key counts, with the server stopped: plan --out <file> from a live report with a generation orphan, then repair --plan <file> --execute --server-stopped"
    expected: "Three passes (answers, counters, mark); at most 500 keys removed per run; a prefix above 1000000 keys refuses with nothing removed; the removed count matches the listed items in <file>.result.json. A plan written before 463f42f4 is refused with a digest mismatch: re-plan first"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores and a real audit file: report; repair --plan <file> --execute without --server-stopped (exit 2); repair --plan <file> --execute --server-stopped without SUBSTRATE_AUDIT_PATH (exit 2, nothing flushed); the execute with SUBSTRATE_AUDIT_PATH set; then restart substrate-mcp and verify the audit chain"
    expected: "Exit codes match docs/reconcile.md. The chain verifies after the restart, with the repair record in place and a continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest"
    why_human: "Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence and of the operator assertion that the server is in fact stopped"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Phase success criteria (ROADMAP Phase 78):** SC1 a scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run. SC2 repair is a separate confirmed step with a plan record, following the corpus delete rules.
**Verified:** 2026-11-05T07:10:22Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at ca9d02ec (human_needed, 9/9). HEAD 42e3cf13, branch gsd/v18-int-all.
**Scope:** integration worktree, HEAD 42e3cf13. Goal-backward, gsd-verifier procedure. No code edits, no commits, no full suite, no tsc, lint or formatters. Targeted runs: two commands, both without a database (`SUBSTRATE_TEST_PG_URL` unset, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`). No Postgres-gated file is in the targeted set (grep for `SUBSTRATE_TEST_PG_URL` in the four reconcile test files and `service.test.ts` returned none). No scratch database was used.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED | `reconcile-run.ts:49-112` builds counts and truncation for ledger, index and cache. `reconcile.ts` `buildReport` (`:186-212`) sets `first` per comparison and `clean`. Tests re-run this pass in the 81-pass run (`reconcile.test.ts`, `reconcile-read.test.ts`). Files unchanged in range |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED | Static: reads are `queryEvents`, index `select` only (`index-store.ts:2929-2990`), cache `scanKeys` only (`cache.ts:1069`). `unlinkKeys` (`cache.ts:1095`) is reached only from `executePlan`. The `cache.ts` hunk since ca9d02ec changes only `snapshotSurvivesForget` and adds `forgetVerdict`; neither is on the scan or unlink path. Behavioral: `service.test.ts:6448` "one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing" re-run this pass: pass. `runScheduledReconcile` (`service.ts:4254`) is unchanged |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED | `config.ts:1632` (0 is off; above 0 clamped to 60; file unchanged). `service.ts:4229-4238` `startReconcile` (no timer when `intervalS <= 0`; `unref`); `stopReconcile` `:4240-4243` clears it. `startRecall` (`service.ts:4213-4217`) calls `startReconcile`, called from `index.ts:202`; `stopRecall` clears it at `index.ts:240`. Tests: `service.test.ts:6380` describe block (re-run this pass, 3 pass with the timer name filter); `config.test.ts:726-760` carried forward from ca9d02ec (file unchanged, not re-run this pass) |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED | `service.ts:4246-4250` `reconcileTick`: `this.reconcilePass ??= this.runScheduledReconcile().finally(() => { this.reconcilePass = null; })`. Named test `service.test.ts:6471` "overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again" re-run this pass: pass |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED | `reconcile-main.ts:98-101` (execute needs `--server-stopped`, exit 2); `reconcile-repair.ts` `executePlan` (`:218-250`): digest check `:238-244`, no-orphan refusal `:245-248`, `planRefusal` `:164-175`; dry run `:271-279`; no-server-stopped refusal `:280-287`. Tests re-run this pass: `reconcile-repair.test.ts` and `reconcile-main.test.ts` (dry run writes nothing, digest mismatch, orphan gone, execute without `--server-stopped` exits 2) |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED | `reconcile-repair.ts:181-192` (`flushPasses`), `:198-205` (`boundPasses`, total bound), `:254-261` (truncated scan refuses, nothing removed), `:292-299` (per-pass `unlinkPass`, batches counted by callback). Tests re-run this pass: "execute removes answers, then counters, then the forget mark, and only those", the failure and bound tests in `reconcile-repair.test.ts`; `reconcile-main.test.ts` bound case (executed, exit 0, `outcome=truncated planned=502 removed=500 remaining=2`) |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ✓ VERIFIED | `reconcile-main.ts:203-214` (durable check before any client opens, exit 2 with nothing flushed); `:253-270` (unreadable or missing plan: `recordRepair` with `outcome=refused`, then exit 1); `:272-291` (execute, record after flush, `.result.json` written in `finally`, exit 1 if the append fails). Tests re-run this pass: `reconcile-main.test.ts` one-record, no-durable-chain (exit 2, nothing flushed), unreadable plan and missing plan refusal records, unwritable path (exit 2) |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED | `corpus/reconcile.ts:170-174` (one total bound, RECONCILE_MAX_ITEMS), `:114-130` (`deleteOrphans`: `deleteDocuments`; only confirmed ids count as repaired), `:112` (manifest re-read, only `corpus:` names). `corpus/reconcile.ts` and `corpus/reconcile.test.ts` are unchanged in range. Carried forward from the c40ffc9a and ca9d02ec runs (24 pass across the scheduled and corpus filter); not re-run this pass |
| 9 | SC2 (behavior): a counter cut changes the repair digest, so the next execute refuses; plans written before the change do not match | ✓ VERIFIED | `reconcile-repair.ts:98-109` `planDigest(findings, counters)` pins counter keys as `counter|key`; `:123-132` `scanCounters` (one `substrate:v1:gen*` scan, filtered to class `gen`, `truncated` carried); `:138-158` `planFromReport` pins the counters; `:218-244` `executePlan` re-reads them and refuses with "digest mismatch" (`:238-244`). `reconcile-main.ts:234-238` plan pins counter keys and throws if the counter scan is truncated. Named test `reconcile-repair.test.ts:151` "a counter cut that removes only a live-graph counter refuses the next execute" passes in this run. Commit 463f42f4 is an ancestor of HEAD |

**Score:** 9/9 truths verified (0 present, behavior-unverified). At the roadmap level, SC1 and SC2 are each verified in code and by named tests. The four live proofs remain open (Human Verification Required).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `buildReport` `:186-212`; unchanged in range; re-run this pass |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `:122` (ledger session as stored), `:224` (index claim_session as stored); unchanged in range; re-run this pass |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `:49-112`; read-only; unchanged in range |
| `packages/mcp-server/src/reconcile-repair.ts` | digest over findings and counter keys, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `:98-109`; `:123-132`; `:138-158`; `:164-175`; `:181-205`; `:218-329`; re-run this pass |
| `packages/mcp-server/src/reconcile-main.ts` | plan pins counters; durable check; audit record on every execute; post-flush append; exit codes | ✓ VERIFIED | plan `:233-242`; durable check `:203-214`; refused-plan record `:253-270`; execute and record `:272-291`; re-run this pass |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4229-4238`; `stopReconcile` `:4240-4243`; `reconcileTick` `:4246-4250`; `runScheduledReconcile` `:4254`. The in-range hunks (lines 54, 543, 1642, 2495, 2594, 2723, 4545) are the brief last-good path and the forget stamp (phase 75); none is in the reconcile timer block. Timer tests re-run this pass |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1632` (file unchanged); `config.test.ts:726-760` carried forward. `flag-registry.ts` changed in range only for the snapshot TTL text (phase 75), not for the reconcile flags |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `:114-130`; `:170-174`; unchanged in range; carried forward |
| `packages/mcp-server/src/index-store.ts` | read-only reconcile readers | ✓ VERIFIED | reconcile SELECTs `:2929-2990` unchanged |
| `packages/mcp-server/src/cache.ts` | `scanKeys` with truncation, `unlinkKeys` with per-batch callback | ✓ VERIFIED | `scanKeys` `:1069`; `unlinkKeys` `:1095` (bodies unchanged; the in-range change is `forgetVerdict` and the `snapshotSurvivesForget` wrapper at `:881-915`, which the reconcile path does not call); reconcile-read and reconcile-repair tests re-run this pass |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, re-plan rule | ✓ VERIFIED | `docs/reconcile.md:57` states the counter-cut re-plan rule the code implements. Both files unchanged in range |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | identity for ordinary ids unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `:63-77` and `:77` | WIRED | all SELECTs (`index-store.ts:2929-2990`) |
| `service.ts` `startRecall` | `startReconcile` | `index.ts:202` boot; `stopRecall` clears at `index.ts:240` | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4247`) | WIRED | exercised by the named overlapping-tick test, re-run this pass |
| `reconcileMain` (plan) | `scanCounters` → `planFromReport` | `reconcile-main.ts:234-238` | WIRED | counter keys pinned; a truncated scan throws, reported as `reconcile failed:` with exit 1. No dedicated test for the truncated branch (see Warnings, item 2) |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:203-214`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:253-270` before exit 1 | WIRED | refused-plan record present |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:273`) | WIRED | |
| `executePlan` | `scanCounters` | `reconcile-repair.ts:226`; digest check `:238` | WIRED | live counter keys are pinned into the comparison |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:292-299`) | WIRED | |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:114-130`, confirmed ids only | WIRED | |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2929-2990`) and cache SCANs (`cache.ts:1069`), combined at `reconcile-run.ts:49-112`. The plan's counter list is a live `substrate:v1:gen*` scan (`reconcile-repair.ts:123-132`), not a stored value. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:181-192`, `:292-299`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:135-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1632`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`unchecked_layers`), repair never automatic (confirmed plan, `--server-stopped`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`); both unchanged at 42e3cf13. Owner or orchestrator decision on the status |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`, `not yet implemented`, `coming soon`: no match in the phase 78 reconcile sources and `docs/reconcile.md` at 42e3cf13, and none in the added lines of the changed `cache.ts` and `service.ts` hunks (grep of the diff ca9d02ec..42e3cf13). The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 source. The `=> {}` no-ops are test seams in `reconcile-main.test.ts` only.
- **Re-verification evidence gate.** No 🛑 Blocker is raised in this pass, so the gate has nothing to classify.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:170-174` do. Not changed in this pass; the file is not in the covered list.
- **Commit-hash gate.** Not run: the phase's SUMMARY names no commit hashes for phase 78 beyond the base. Commit 463f42f4 is named in the record and is an ancestor of HEAD.

## Behavioral Spot-Checks (Step 7b)

Two targeted runs at 42e3cf13, both with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No full suite.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 78 core reconcile: repair (counter-cut digest refusal `reconcile-repair.test.ts:151`, plan, execute, orphan and bound behaviour), CLI execute and audit paths, read path, comparators | `cd packages/mcp-server && bun test --timeout 30000 src/reconcile-repair.test.ts src/reconcile-main.test.ts src/reconcile-read.test.ts src/reconcile.test.ts` | 81 pass, 0 fail, 310 expect() calls, 4 files | ✓ PASS |
| Scheduled timer: clean tick writes nothing (`service.test.ts:6448`), single-flight (`service.test.ts:6471`), interval and timer lifecycle (`service.test.ts:6380` block) | `cd packages/mcp-server && bun test --timeout 30000 --test-name-pattern "the scheduled reconcile timer" src/service.test.ts` | 3 pass, 0 fail, 15 expect() calls, 321 filtered out | ✓ PASS |
| `config.test.ts:726-760` (interval and window clamps) | Run at c40ffc9a and ca9d02ec | not re-run this pass; `config.ts` and `config.test.ts` unchanged in range | ✓ PASS (carried forward) |
| Corpus reconcile routes (`corpus/reconcile.test.ts`) | Run at c40ffc9a (24 pass across the scheduled and corpus filter) | not re-run this pass; unchanged in range | ✓ PASS (carried forward) |
| Live report, scheduled tick and repair against real stores | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human items 1 to 4 |

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` exists in the tree, and no PLAN or SUMMARY declares a probe. Skipped.

Postgres: no Postgres-gated file in the targeted runs. `SUBSTRATE_TEST_PG_URL` was unset for both runs. No scratch database was used.

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run: RESOLVED (verified by named test).** Commit 463f42f4 pins the generation counter keys in the plan digest. The named test passes in this run. Plans written before 463f42f4 do not match and must be re-planned (`docs/reconcile.md:57`, commit message).
2. **Plan counter-scan failure path: INFO, not test-covered.** `reconcile-main.ts:234-238` throws when the counter scan is truncated, so `plan` exits 1 with `reconcile failed: the cache counters could not be read completely`. No test names this branch. The truncated-scan refusal inside `executePlan` is covered (`reconcile-repair.ts:231-237`).
3. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** `docs/reconcile.md` and `docs/mcp-audit.md` state it; the code matches.
4. **Refused-plan record: RESOLVED.** `reconcile-main.test.ts` refused-plan cases pass in this run.
5. **Scheduled tick single-flight: RESOLVED by test** (`service.test.ts:6471`, re-run and passing at 42e3cf13). The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Owner decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing).** The ledger's stored session id is capped (`normalizeKey`); the index's `claim_session` is read as stored (`reconcile-read.ts:224`). Owner decision.
8. **Node id straddle (carried, pre-existing data class).** Named in the ROADMAP Phase 78 status.
9. **ROADMAP status text is stale (INFO, orchestrator).** The ROADMAP Phase 78 status line (`ROADMAP.md:1348`) still carries older open-gap wording, including the unreadable-plan audit gap, which tests at 42e3cf13 show closed. Not edited in this pass.
10. **Corpus tombstone scope (informational).** The phase 78 repair and `corpus/reconcile.ts` delete orphans through the plane, not ingest, so the scope rule of `77d6b2c8` does not change this phase's repair.
11. **Scheduled corpus reconcile unit (informational, phase 65).** The operator installs and enables the unit; this pass does not.

## Human Verification Required

### 1. Scheduled tick on a staging host

**Test:** Start the server with `SUBSTRATE_RECONCILE_INTERVAL_S=60` against live stores. Wait for two ticks.
**Expected:** One `[substrate] reconcile {...}` line per tick with `clean:true`; no ledger, index or cache write; a tick while a run is in flight starts no second run.
**Why human:** Live cadence and real stores are not observable from unit tests. The single-flight case is covered by a named test and is not the reason for this item.

### 2. Live cache flush at production key counts

**Test:** With the server stopped, `bun run reconcile -- plan --out <file>` from a live report with a generation orphan, then `repair --plan <file> --execute --server-stopped`. A plan written before 463f42f4 is refused with a digest mismatch and must be made again.
**Expected:** Three passes (answers, counters, mark); at most 500 keys removed per run; a prefix above 1000000 keys refuses with nothing removed; the removed count matches `<file>.result.json`.
**Why human:** Real SCAN and UNLINK cost and behaviour at production counts cannot be exercised by a unit test.

### 3. Live ledger read in a busy window

**Test:** Run `report` against GreptimeDB during a busy window with claim, warning and note events.
**Expected:** The lease comparison completes, or reports `truncated` when a node exceeds 100 rows or the lookup count passes 200.
**Why human:** Needs a live ledger with real volume.

### 4. Live CLI run with real stores and a real audit file

**Test:** `report`; `repair --plan <file> --execute` without `--server-stopped` (exit 2); `--server-stopped` without `SUBSTRATE_AUDIT_PATH` (exit 2, nothing flushed); the execute with `SUBSTRATE_AUDIT_PATH` set; then restart `substrate-mcp` and verify the audit chain.
**Expected:** Exit codes match `docs/reconcile.md`. The chain verifies after the restart, with the repair record in place and continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest.
**Why human:** Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence and of the operator assertion that the server is stopped.

## Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired. No regression against the ca9d02ec record. Status is `human_needed` by the Step 9 decision tree: rule 1 does not fire, and human items 1 to 4 are open.

Changed since ca9d02ec: the two covered implementation files that moved (`cache.ts`, `service.ts`) are off the phase 78 reconcile path, and the reconcile tests pass at 42e3cf13 (81 + 3 pass, 0 fail).

Still open: the four live proofs; HARD-H2's status in REQUIREMENTS.md (owner); the pre-existing 512-unit identity and node_id straddle items (owner decisions).

---

_Verified: 2026-11-05T07:10:22Z_
_Verifier: Claude (gsd-verifier)_
