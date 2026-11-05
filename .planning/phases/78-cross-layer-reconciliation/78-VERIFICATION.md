---
phase: 78-cross-layer-reconciliation
verified: 2026-11-05T07:59:32Z
status: human_needed
score: "9/9 must-haves verified; behavior_unverified 0; 4 live proofs open (human); HARD-H2 ORPHANED in REQUIREMENTS.md (owner)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 6e5d766e"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (SC1, SC2)"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/reconcile.md", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.test.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:a6ac5f85711e3695535079c42f4f8ef238c54df2fd14f6b7ec26c0cca280b7f7"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "9/9 must-haves verified (42e3cf13 record, covered_digest v3:sha256:3bb78a6d1f95467815a5dcf6e90ff4e480ba4621dfa6c48aba41533f86956466)"
  selection: "Prior record carries a non-empty gaps_remaining list and no open gaps: re-verification mode. Changed commits 42e3cf13..6e5d766e were diffed per covered file with git diff; carried claims are marked as such."
  changed_since_previous: "42e3cf13..6e5d766e. Covered files that changed: (a) cache.ts, d1a5e89b: forgetVerdict returns forgotten for any failed mark read except BreakerOpenError (was unreadable); snapshotSurvivesForget is still a wrapper over it. scanKeys is now :1071 and unlinkKeys :1097 (were :1069 and :1095; +2 lines). The reconcile path does not call forgetVerdict or snapshotSurvivesForget (grep: only service.ts and cache.ts). (b) service.ts, b4bdd0fc: the docs.sync emit now sets the sync-lag reading for buffered and dead-lettered notes (line 3005). Not on the reconcile path. The reconcile timer moved down one line: startReconcile :4230, stopReconcile :4241, reconcileTick :4247, runScheduledReconcile :4255. (c) docs/reconcile.md, 6e5d766e: the second execute refuses when the cache counters changed too, and the re-run paragraph says a run reaching the counters changes the digest. Checked against reconcile-repair.ts executePlan and planDigest: matches. (d) flag-registry.ts is added to covered_files: it is a VERIFIED artifact in this record and changed in range for the snapshot TTL text only. Uncovered changes checked and not on the phase 78 path: event-buffer.ts and its tests (49b9aece), worktree.py (b4fe6bfe), .planning records and REQUIREMENTS/ROADMAP text (6e5d766e)."
  gaps_closed:
    - "Scheduled tick single-flight: named test 'overlapping scheduled ticks share one run' (94f4bc8e) is in the gate JUnit as a pass and passes in this run"
    - "Counter-cut second run: named test 'a counter cut that removes only a live-graph counter refuses the next execute' (463f42f4, ancestor of HEAD) passes in the gate JUnit and in this run; docs/reconcile.md now states the counter rule (6e5d766e)"
  gaps_remaining:
    - "Operator items 1 to 4 (live proofs). Not run in this pass; open"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at 6e5d766e; owner or orchestrator decision"
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
**Verified:** 2026-11-05T07:59:32Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 42e3cf13 (human_needed, 9/9). HEAD 6e5d766e, branch gsd/v18-int-all.
**Scope:** integration worktree, HEAD 6e5d766e. Goal-backward, gsd-verifier procedure. No code edits, no commits, no full suite, no tsc, lint or formatters. Targeted runs: two commands, both without a database (`SUBSTRATE_TEST_PG_URL` unset, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`). No Postgres-gated file was run; the Postgres-gated named passes are cited from the gate JUnit report (`/root/src/worktrees/backups/gate-r33-junit.xml`, gate r33 at 6e5d766e, 12290 testcases, none skipped, none failing). No database was started.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED | `reconcile-run.ts:49-112` builds counts and truncation for ledger, index and cache. `reconcile.ts` `buildReport` (`:186-212`) sets `first` per comparison and `clean`. Named JUnit passes: 'a clean fixture reports clean, the unchecked row is counted, and nothing is written', 'a dirty fixture reports the first mismatching key for each comparison'. Re-run this pass in the 81-pass run (`reconcile.test.ts`, `reconcile-read.test.ts`). Files unchanged in range |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED | Static: reads are `queryEvents`, index `select` only (`index-store.ts:2929-2990`), cache `scanKeys` only (`cache.ts:1071`). `unlinkKeys` (`cache.ts:1097`) is reached only from `executePlan` (`reconcile-repair.ts:295`). The `cache.ts` change since 42e3cf13 is in `forgetVerdict` (`:890`) and the `snapshotSurvivesForget` wrapper (`:913`); neither is on the scan or unlink path, and neither is called from a reconcile file. Behavioral: 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (`service.test.ts:6448`), JUnit pass and re-run this pass: pass. `runScheduledReconcile` (`service.ts:4255`) is unchanged in logic |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED | `config.ts:1632` (0 is off; above 0 clamped to 60; file unchanged). `service.ts:4230-4238` `startReconcile` (no timer when `intervalS <= 0`; `unref`); `stopReconcile` `:4241-4244` clears it. `startRecall` (`service.ts:4216`) calls `startReconcile`, called from `index.ts:202`; `stopRecall` clears it at `index.ts:240`. Tests: 'startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears' and 'the scheduled reconcile is off when the interval is unset, blank or 0' (JUnit pass); `service.test.ts` describe 'the scheduled reconcile timer (phase 78)' re-run this pass: 3 pass. `config.test.ts:726-760` carried forward from 42e3cf13 (file unchanged, not re-run this pass) |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED | `service.ts:4247-4252` `reconcileTick`: `this.reconcilePass ??= this.runScheduledReconcile().finally(() => { this.reconcilePass = null; })`. Named test `service.test.ts:6471` 'overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again' (commit 94f4bc8e). JUnit pass in gate r33 with no `<skipped/>`; re-run this pass: pass |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED | `reconcile-main.ts:98-101` (execute needs `--server-stopped`, exit 2); `reconcile-repair.ts` `executePlan` (`:218-299`): digest check (`planDigest` mismatch refusal), no-orphan refusal, `planRefusal` (`:164-175`); dry run (`:271-279`); no-server-stopped refusal (`:280-287`). JUnit passes: 'a dry run writes nothing', 'a digest mismatch refuses and writes nothing', 'an orphan that is gone refuses and writes nothing'. Re-run this pass: `reconcile-repair.test.ts`, `reconcile-main.test.ts` |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED | `reconcile-repair.ts:181-192` (`flushPasses`), `:198-205` (`boundPasses`, total bound), `:254-261` (truncated scan refuses, nothing removed), `:292-299` (per-pass `unlinkPass`, batches counted by callback). JUnit passes: 'execute removes answers, then counters, then the forget mark, and only those'; 'a scan that cannot be completed removes nothing'; 'a failure in the answer pass leaves every counter and the mark in place'; 'a failure in the counter pass keeps the forget mark in place'. `reconcile-main.test.ts:288` bound case (executed, exit 0, `outcome=truncated planned=502 removed=500 remaining=2`) |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ✓ VERIFIED | `reconcile-main.ts:202-213` (durable check before any client opens, exit 2 with nothing flushed); `:246-270` (unreadable or missing plan: `recordRepair` with `outcome=refused`, then exit 1); `:271-295` (execute, record after flush, `.result.json` written in `finally`, exit 1 if the append fails). Tests in `reconcile-main.test.ts` (re-run this pass, 81 pass): one-record, no-durable-chain (exit 2, nothing flushed), unreadable plan (`:225`) and missing plan (`:249`) refusal records, unwritable path (exit 2) |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED | `corpus/reconcile.ts:170-174` (one total bound, RECONCILE_MAX_ITEMS), `:114-130` (`deleteOrphans`: `deleteDocuments`; only confirmed ids count as repaired), `:112` (manifest re-read, only `corpus:` names). `corpus/reconcile.ts` and `corpus/reconcile.test.ts` are unchanged in range. Carried forward from the c40ffc9a and ca9d02ec runs (JUnit passes: 'a delete the plane refused, or did not confirm, is not counted as repaired', 'missing rows and orphans share one bound in total'); not re-run this pass |
| 9 | SC2 (behavior): a counter cut changes the repair digest, so the next execute refuses; plans written before the change do not match | ✓ VERIFIED | `reconcile-repair.ts:98-109` `planDigest(findings, counters)` pins counter keys as `counter|key`; `:123-132` `scanCounters` (one `substrate:v1:gen*` scan, filtered to class `gen`, `truncated` carried); `:138-158` `planFromReport` pins the counters; `:218-244` `executePlan` re-reads them and refuses with "digest mismatch" (`:238-244`). `reconcile-main.ts:234-238` plan pins counter keys and throws if the counter scan is truncated. Named test `reconcile-repair.test.ts:151` 'a counter cut that removes only a live-graph counter refuses the next execute' (commit 463f42f4, ancestor of HEAD): JUnit pass in gate r33 and pass in this run. `docs/reconcile.md:57` states the rule and matches the code |

**Score:** 9/9 truths verified (0 present, behavior-unverified). At the roadmap level, SC1 and SC2 are each verified in code and by named tests. The four live proofs remain open (Human Verification Required).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `buildReport` `:186-212`; `compareMemory` `:129` takes sets; unchanged in range; re-run this pass |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `:122` (ledger session as stored), `:194` (`readLedgerMemoryIds`, returns a Set), `:224` (index claim_session as stored); unchanged in range; re-run this pass |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `:49-112`; read-only; unchanged in range |
| `packages/mcp-server/src/reconcile-repair.ts` | digest over findings and counter keys, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `:98-109`; `:123-132`; `:138-158`; `:164-175`; `:181-205`; `:218-299`; re-read this pass, unchanged in range; re-run this pass |
| `packages/mcp-server/src/reconcile-main.ts` | plan pins counters; durable check; audit record on every execute; post-flush append; exit codes | ✓ VERIFIED | plan `:233-242`; durable check `:202-213`; refused-plan record `:253-270`; execute and record `:271-295`; outer catch `:301-303` returns 1; re-run this pass |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4230-4238`; `stopReconcile` `:4241-4244`; `reconcileTick` `:4247-4252`; `runScheduledReconcile` `:4255`. The in-range hunks (`:54`, `:543`, `:1642`, `:2495`, `:2594`, `:2723`, `:3005`, `:4545`, moved by the prior edits) are the brief last-good path, the forget stamp (phase 75) and the docs.sync sync-lag reading (phase 70); none is in the reconcile timer block. Timer tests re-run this pass |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1632` (file unchanged); `config.test.ts:726-760` carried forward. `flag-registry.ts` changed in range only for the snapshot TTL text (phase 75), not for the reconcile flags |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `:114-130`; `:170-174`; unchanged in range; carried forward |
| `packages/mcp-server/src/index-store.ts` | read-only reconcile readers | ✓ VERIFIED | reconcile SELECTs `:2929-2990` unchanged |
| `packages/mcp-server/src/cache.ts` | `scanKeys` with truncation, `unlinkKeys` with per-batch callback | ✓ VERIFIED | `scanKeys` `:1071`; `unlinkKeys` `:1097` (bodies unchanged; the in-range change is `forgetVerdict` `:890` and the `snapshotSurvivesForget` wrapper `:913`, which the reconcile path does not call); reconcile-read and reconcile-repair tests re-run this pass |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, re-plan rule | ✓ VERIFIED | `docs/reconcile.md:55` and `:57` state the counter-cut re-plan rule the code implements (changed in 6e5d766e, checked against `executePlan` and `planDigest`). `scripts/reconcile.ts` unchanged in range |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | identity for ordinary ids unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `:63-77` and `:77` | WIRED | all SELECTs (`index-store.ts:2929-2990`) |
| `service.ts` `startRecall` | `startReconcile` | `index.ts:202` boot; `stopRecall` clears at `index.ts:240` | WIRED | |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4248`) | WIRED | exercised by the named overlapping-tick test, re-run this pass |
| `reconcileMain` (plan) | `scanCounters` → `planFromReport` | `reconcile-main.ts:234-238` | WIRED | counter keys pinned; a truncated scan throws, reported as `reconcile failed:` with exit 1 (outer catch `:301-303`). No dedicated test for the truncated branch (see Warnings, item 2) |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:202-213`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:253-270` before exit 1 | WIRED | refused-plan record present |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:273`) | WIRED | |
| `executePlan` | `scanCounters` | `reconcile-repair.ts:226`; digest check `:238` | WIRED | live counter keys are pinned into the comparison |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:292-299`) | WIRED | |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:114-130`, confirmed ids only | WIRED | |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2929-2990`) and cache SCANs (`cache.ts:1071`), combined at `reconcile-run.ts:49-112`. The plan's counter list is a live `substrate:v1:gen*` scan (`reconcile-repair.ts:123-132`), not a stored value. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:181-192`, `:292-299`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:135-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1632`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`unchecked_layers`), repair never automatic (confirmed plan, `--server-stopped`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`); both unchanged at 6e5d766e (6e5d766e touched only the ATLAS-03, PROOF and EVAL lines of REQUIREMENTS.md). Owner or orchestrator decision on the status |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`: no match in the phase 78 reconcile sources (`reconcile*.ts`, `corpus/reconcile*.ts`), `scripts/reconcile.ts` or `docs/reconcile.md` at 6e5d766e, and none in the added lines of the diff 42e3cf13..6e5d766e for `cache.ts`, `service.ts` and `docs/reconcile.md`. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 source. The `=> {}` no-ops are test seams in `reconcile-main.test.ts` only.
- **Re-verification evidence gate.** No 🛑 Blocker is raised in this pass, so the gate has nothing to classify.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:170-174` do. Not changed in this pass; the file is not in the covered list.
- **Commit-hash gate.** The phase's SUMMARY names commit hashes for phase 78 (`3ad7bc12` through `0d896577`), and the later commits 94f4bc8e (single-flight test) and 463f42f4 (counter-cut digest) are ancestors of HEAD (`git merge-base --is-ancestor`, both true).

## Behavioral Spot-Checks (Step 7b)

Two targeted runs at 6e5d766e, both with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No full suite.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 78 core reconcile: repair (counter-cut digest refusal `reconcile-repair.test.ts:151`, plan, execute, orphan and bound behaviour), CLI execute and audit paths, read path, comparators | `cd packages/mcp-server && bun test --timeout 30000 src/reconcile-repair.test.ts src/reconcile-main.test.ts src/reconcile-read.test.ts src/reconcile.test.ts` | 81 pass, 0 fail, 310 expect() calls, 4 files | ✓ PASS |
| Scheduled timer: clean tick writes nothing (`service.test.ts:6448`), single-flight (`service.test.ts:6471`), interval and timer lifecycle (`service.test.ts:6380` block) | `cd packages/mcp-server && bun test --timeout 30000 --test-name-pattern "the scheduled reconcile timer" src/service.test.ts` | 3 pass, 0 fail, 15 expect() calls, 321 filtered out | ✓ PASS |
| Gate r33 JUnit (`/root/src/worktrees/backups/gate-r33-junit.xml`), Postgres-gated and other named passes cited above | grep of testcase names; none carries `<skipped/>` or a failure | every named case listed in the truths table: PASS | ✓ PASS (named evidence) |
| `config.test.ts:726-760` (interval and window clamps) | Run at c40ffc9a and ca9d02ec | not re-run this pass; `config.ts` and `config.test.ts` unchanged in range | ✓ PASS (carried forward) |
| Corpus reconcile routes (`corpus/reconcile.test.ts`) | Run at c40ffc9a; JUnit pass in gate r33 | not re-run this pass; unchanged in range | ✓ PASS (carried forward) |
| Live report, scheduled tick and repair against real stores | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human items 1 to 4 |

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` exists in the tree, and no PLAN or SUMMARY declares a probe. Skipped.

Postgres: no Postgres-gated file was run in the targeted runs. `SUBSTRATE_TEST_PG_URL` was unset for both. The Postgres-gated named passes are cited from gate r33's JUnit only. No scratch database was used.

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run: RESOLVED (verified by named test).** Commit 463f42f4 pins the generation counter keys in the plan digest. The named test passes in the gate and in this run. Plans written before 463f42f4 do not match and must be re-planned (`docs/reconcile.md:57`, commit message).
2. **Plan counter-scan failure path: INFO, not test-covered.** `reconcile-main.ts:237` throws when the counter scan is truncated, so `plan` exits 1 with `reconcile failed: the cache counters could not be read completely`. No test names this branch. The truncated-scan refusal inside `executePlan` is covered (`reconcile-repair.ts:254-261`, reason text "could not be read completely").
3. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** `docs/reconcile.md` and `docs/mcp-audit.md` state it; the code matches.
4. **Refused-plan record: RESOLVED.** `reconcile-main.test.ts` refused-plan cases pass in this run.
5. **Scheduled tick single-flight: RESOLVED by test** (`service.test.ts:6471`, gate JUnit pass, re-run and passing at 6e5d766e). The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Owner decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing).** The ledger's stored session id is capped (`normalizeKey`); the index's `claim_session` is read as stored (`reconcile-read.ts:224`). Owner decision.
8. **Node id straddle (carried, pre-existing data class).** Named in the ROADMAP Phase 78 status.
9. **ROADMAP status text is stale (INFO, orchestrator).** The ROADMAP Phase 78 status (`ROADMAP.md:1348`, progress row `:1426`) still lists the counter-cut test gap, the unwritable-path test gap and the post-flush append-failure test gap as open. Tests at 6e5d766e show the counter-cut case (463f42f4), the single-flight case (94f4bc8e), the unreadable and missing plan audit cases and the unwritable path present and passing. Not edited in this pass (ROADMAP is not a covered file, and the orchestrator owns it).
10. **Corpus tombstone scope (informational).** The phase 78 repair and `corpus/reconcile.ts` delete orphans through the plane, not ingest, so the tombstone scope rule of `docs/corpus.md` (owner decision 2026-11-05: the scope is the caller's own declaration) does not change this phase's repair.
11. **Scheduled corpus reconcile unit (informational, phase 65).** The operator installs and enables the unit; this pass does not.
12. **Duplicate ledger events (informational, carried from 49b9aece).** The in-flight event recorded at shutdown can land twice (at-least-once). The comparators take sets (`compareMemory`, `readLedgerMemoryIds` returns a Set) and the lease read keeps the latest transition, so a duplicate row does not by itself create a finding. [INFERENCE from reading the comparators; not exercised by a test in this pass.]

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
**Why human:** Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence and of the operator assertion that the server is in fact stopped.

## Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired. No regression against the 42e3cf13 record. Status is `human_needed` by the Step 9 decision tree: rule 1 does not fire, and human items 1 to 4 are open.

Changed since 42e3cf13: the covered files that moved (`cache.ts`, `service.ts`, `docs/reconcile.md`) are either off the phase 78 reconcile path or are the docs change that the code already implements; the reconcile tests pass at 6e5d766e (81 + 3 pass, 0 fail), and the Postgres-gated named passes are cited from gate r33.

Still open: the four live proofs; HARD-H2's status in REQUIREMENTS.md (owner); the pre-existing 512-unit identity and node_id straddle items (owner decisions); the stale ROADMAP status text (orchestrator).

---

_Verified: 2026-11-05T07:59:32Z_
_Verifier: Claude (gsd-verifier)_
