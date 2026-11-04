---
phase: 78-cross-layer-reconciliation
verified: 2026-11-04T23:00:34Z
status: human_needed
score: "2/2 roadmap criteria verified in code and by named tests; 8/8 truths verified (scheduled tick single-flight now VERIFIED by a passing named test, 94f4bc8e); 4 live proofs human_needed; HARD-H2 ORPHANED in REQUIREMENTS.md (owner decision)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 9e71f263"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (ROADMAP.md:1352-1355)"
covered_files: [".planning/REQUIREMENTS.md", ".planning/ROADMAP.md", ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/mcp-audit.md", "docs/reconcile.md", "docs/runbooks/corpus-sync.md", "packages/audit/src/log.ts", "packages/audit/src/policy.ts", "packages/cli/src/capsule.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/lease.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:e889373bf3073f4b38224def7b762c9028be5a843ddd9afd2714d514e446ad43"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at HEAD 504da465: human_needed, 7/8 truths (single-flight PRESENT_BEHAVIOR_UNVERIFIED), 4 live proofs open, HARD-H2 ORPHANED"
  selection: "Step 0: no top-level gaps: key in the prior record, so initial mode. The prior record is the checklist of claims and carried residuals. Re-verified against every phase 78 file at 9e71f263."
  changed_since_previous: "Commits 504da465..9e71f263 (four): 94f4bc8e adds the overlapping-tick test to service.test.ts (the only phase 78 code-adjacent change); 4d142247 (fabric tei row) and 3139c948 (corpus proofs.test.ts) are outside phase 78; 9e71f263 rewrites the scheduled-reconcile paragraph of docs/runbooks/corpus-sync.md, which describes the phase 65 corpus unit, not the phase 78 timer. No change to reconcile.ts, reconcile-read.ts, reconcile-run.ts, reconcile-repair.ts, reconcile-main.ts, scripts/reconcile.ts, cache.ts, config.ts, flag-registry.ts, corpus/reconcile.ts, docs/reconcile.md, REQUIREMENTS.md or ROADMAP.md. The phase 78 timer code in service.ts (startReconcile :4184, reconcileTick :4201, runScheduledReconcile :4209) is unchanged since 504da465"
  gaps_closed:
    - "Single-flight guard untested (prior behavior-unverified item, truth 4): service.test.ts 'overlapping scheduled ticks share one run' passes. The second tick returns the in-flight promise (toBe), one stdout line is written for the shared run, and a tick after it settles runs again, which shows reconcilePass was cleared. Human item 1 no longer needs to cover the concurrent-tick case"
  gaps_remaining:
    - "Counter-cut second run refused after a cut: no scenario test. The refusal follows from the digest check (reconcile-repair.ts:210-216), tested generically at reconcile-repair.test.ts:126. WARNING, open; counter-cut design stays open (owner)"
    - "Operator items 1 to 4, including the live stopped-server proof and the live audit-chain verify after restart. Not run in this pass; open"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at 9e71f263; owner or orchestrator decision"
    - "packages/corpus/src/protocol.ts:263 comment says RECONCILE_MAX_ITEMS bounds the items reconcile 'lists in one list'; the bound is total per run (reconcile-repair.ts:185-192, corpus/reconcile.ts:170-174). Doc drift only, unchanged"
  regressions: []
advisory: []
overrides: []
gaps: []
human_verification:
  - test: "Scheduled tick on a staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 and a live ledger, index and cache"
    expected: "One '[substrate] reconcile {...}' line per tick with clean:true; no ledger, index or cache write"
    why_human: "Live cadence and real stores cannot be observed by unit tests. The concurrent-tick case is covered by the named single-flight test (94f4bc8e) and is no longer a reason for this item"
  - test: "Live Dragonfly SCAN and UNLINK at production key counts, with the server stopped: reconcile repair --plan <file> --execute --server-stopped against a plan made from a live report with a generation orphan"
    expected: "Three passes (answers, counters, mark); at most 500 keys removed per run; a prefix above 1000000 keys refuses with nothing removed; the removed count matches the listed items in <file>.result.json"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores and a real audit file: report; repair --plan <file> --execute without --server-stopped (exit 2); repair --plan <file> --execute --server-stopped without SUBSTRATE_AUDIT_PATH (exit 2, nothing flushed); the execute with SUBSTRATE_AUDIT_PATH set; then restart substrate-mcp and verify the audit chain"
    expected: "Exit codes match docs/reconcile.md. The chain verifies after the restart, with the repair record in place and a continuous seq and prev. The record reason carries outcome, planned, removed, remaining, limit, plan_digest and report_digest"
    why_human: "Needs live PG, GreptimeDB, Dragonfly and an audit file the server writes. This run is the only proof of the single-writer sequence and of the operator assertion that the server is in fact stopped"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-04T23:00:34Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 504da465. Step 0 selected initial mode (no `gaps:` key). Head 9e71f263, branch gsd/v18-int-all.
**Scope:** integration tree, HEAD 9e71f263. Goal-backward, gsd-verifier procedure. No code edits, no commits, no full suite, no tsc, lint or formatters. Only this file was written, in the worktree.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED | `reconcile-run.ts:49-112` builds counts and truncation for ledger, index and cache. `reconcile.ts` `buildReport` (`:186-212`) sets `first` per comparison and `clean`. Tests: `reconcile.test.ts:234` ("first is the first finding of each comparison in sorted order"), `:271` (end to end), `reconcile-read.test.ts` (17 tests). Scheduled log line carries `counts`, `first`, `truncated`, `unchecked_layers` (`service.ts:4223`). Core targeted run at 9e71f263: 235 pass |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED | Static: the reads are `queryEvents`, index `select` only (`index-store.ts:2929-2990`, each a `select`), cache `scanKeys` only (`cache.ts:1061`). `unlinkKeys` (`cache.ts:1087`) is reached only from `executePlan`. Behavioral: `service.test.ts:6398` ("one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing") passes in the scheduled run at 9e71f263; every store is a proxy that throws and records any write method |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED | `config.ts:1631-1636` (0 is off, above 0 clamped to 60 to `RECONCILE_MAX_INTERVAL_S`); `flag-registry.ts:986-987`; `service.ts:4184-4199` (no timer when `intervalS <= 0`; `unref`); `startRecall` calls `startReconcile` (`service.ts:4170`), called from `index.ts:202`; `stopRecall` clears it (`service.ts:4176`, `index.ts:240`). Tests: `service.test.ts:6387` passes; `config.test.ts:726-760` passes |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED | `service.ts:4201-4204` `this.reconcilePass ??= ... .finally(() => null)`. Named test `service.test.ts` "overlapping scheduled ticks share one run" (added 94f4bc8e) passes at 9e71f263: the second `reconcileTick()` returns the in-flight promise (`toBe(first)`) while the first run's first read is held open; one `[substrate] reconcile` line is written for the shared run; after it settles, the next tick runs again and writes a second line, which shows `reconcilePass` was cleared. Prior record's behavior-unverified item closed |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED | `reconcile-main.ts:98-101` (usage: execute needs `--server-stopped`, exit 2); `reconcile-repair.ts:204-216` (digest mismatch refuses and writes nothing), orphan refusal via `planRefusal` (`:151`); dry run `:243`; no-server-stopped refusal `:252`. Tests: `reconcile-repair.test.ts:107` (dry run writes nothing), `:126` (digest mismatch), `:140` (orphan gone), `:151` (no orphans left), `:291` (execute without server stopped), `:312`, `:324`, `:336` (plan items refused). All pass in the core run at 9e71f263 |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED | `reconcile-repair.ts:168-178` (`flushPasses`), `:185-192` (`boundPasses`, total bound), `:227-233` (truncated scan refuses), `:264-276` (three passes, each batch counted via callback). Tests: `:169` (order and only those), `:197` (second run no-op), `:209` (scan fails, nothing removed), `:230`, `:249`, `:271` (failure in each pass), `:354`, `:376`, `:402` (bound), `:424` (second run removes remainder). All pass |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ✓ VERIFIED | `reconcile-main.ts:203-214` (durable check before any client opens, exit 2 with nothing flushed); `:246-266` (unreadable or missing plan: `recordRepair` with `outcome=refused`, then exit 1; prior gap 7c closed by a86e97aa); `:270-291` (execute, record after flush, `.result.json`, exit 1 if the append fails). Tests: `reconcile-main.test.ts:177` (one record), `:200` (no durable chain: exit 2, nothing flushed), `:229`, `:253` (refusal records), `:298` (unwritable path: exit 2, `open` never called), `:331` (append throws, or reports `written: false`: exit 1, the result file stands). All pass |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED | `corpus/reconcile.ts:170-174` (one total bound, RECONCILE_MAX_ITEMS), `:114-130` (`deleteOrphans`: `deleteDocuments` and only confirmed ids count as repaired), `:8-12` (documented rules), `:112` (manifest re-read, only `corpus:` names). Unchanged in range. Tests: `corpus/reconcile.test.ts` `diffPlane` and `reconcileCorpus` pass at 9e71f263 (scheduled run, 24 pass). The ingest tombstone rule tightened by 77d6b2c8 (scope required, `corpus/validate.ts`) does not reach this path, which calls the plane directly |

**Score:** 8/8 truths verified (0 present-only, behavior-unverified). At the roadmap level, SC1 and SC2 are each verified in code and by named tests; SC2's live proofs and the counter-cut second-run scenario remain open.

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `compareLeases` `:82`; identity `:105-109`; `buildReport` `:186-212`; unchanged since 504da465 |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `:122` (ledger session as stored); `:224` (index claim_session as stored); `:233` (memory ids); unchanged since 504da465 |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `:49-112`; read-only by its own header; unchanged since 504da465 |
| `packages/mcp-server/src/reconcile-repair.ts` | digest, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `:56-67` (result counts); `:125-145` (planFromReport); `:151-160` (planRefusal); `:168-178`; `:185-192`; `:204-276`; unchanged since 504da465 |
| `packages/mcp-server/src/reconcile-main.ts` | durable check, R7 record on every execute, post-flush append, exit codes | ✓ VERIFIED | `:203-214`; `:246-266` (refused-plan record, a86e97aa); `:270-291`; unchanged since 504da465 |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4184`; `reconcileTick` `:4201`; `runScheduledReconcile` `:4209`; single-flight now exercised by a passing named test |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1631-1636`; `flag-registry.ts:986-987`; `config.test.ts:726-760` pass |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `:114-130`; `:170-174`; unchanged since 504da465; tests pass at 9e71f263 |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, scheduled report | ✓ VERIFIED | `docs/reconcile.md` matches `reconcile-main.ts` exit codes and audit reason fields, including the refused-plan record and the post-flush placement (owner-ratified) |
| `infra/vps/substrate-corpus-reconcile.{service,timer}` | (not a phase 78 SC1 artifact; corpus-plane scheduled reconcile, phase 65) | ✓ VERIFIED as dry run | `ExecStart` runs `corpus reconcile --json` with no `--execute`; `corpus reconcile` is a dry run by default (`packages/cli/src/corpus/index.ts:13`). Not installed or enabled. The runbook paragraph describing it was corrected at 9e71f263 (phase 65 doc, no phase 78 effect) |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | identity for ordinary ids unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `:63-77` and `:77` (`reconcileMemoryRowsBefore`) | WIRED | all SELECTs (`index-store.ts:2929-2990`) |
| `service.ts` `startRecall` | `startReconcile` | `:4170` | WIRED | called at boot from `index.ts:202`; cleared by `stopRecall` (`index.ts:240`) |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4202`) | WIRED | single flight exercised by the named overlapping-tick test |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:204-214`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:258-266` before exit 1 | WIRED | closed gap 7c |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:270`) | WIRED | |
| `reconcileMain` (append failed) | exit code | `:289-291` returns 1 after the flush | WIRED | covered by `reconcile-main.test.ts:331` |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:264-276`) | WIRED | |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:114-130`, confirmed ids only | WIRED | |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2929-2990`) and cache SCANs (`cache.ts:1061`), combined at `reconcile-run.ts:49-112`. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:168-178`, `:264-276`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts:157-171`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:135-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1631-1636`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`reconcile-run.ts`, `unchecked_layers`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`); both unchanged at 9e71f263. Owner or orchestrator to decide the status |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`: none in `reconcile*.ts`, `corpus/reconcile.ts`, `scripts/reconcile.ts`, `docs/reconcile.md`, and none in the overlapping-tick test added at 94f4bc8e. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in phase 78 source. The `=> {}` no-ops are test seams in `reconcile-main.test.ts` only.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:170-174` do.
- **Commit-hash gate.** Not run: the phase's SUMMARY names no commit hashes for phase 78 beyond the base.

## Behavioral Spot-Checks (Step 7b)

Targeted runs at 9e71f263, each with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No Postgres-gated file is in phase 78; no PG run was made.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Reconcile core, read, repair, main, memory policy, config, corpus routes | `bun test --timeout 30000 packages/mcp-server/src/reconcile.test.ts packages/mcp-server/src/reconcile-read.test.ts packages/mcp-server/src/reconcile-repair.test.ts packages/mcp-server/src/reconcile-main.test.ts packages/mcp-server/src/memory-policy.test.ts packages/mcp-server/src/config.test.ts packages/mcp-server/src/corpus/routes.test.ts` | 235 pass, 0 fail, 866 expect() calls, 7 files | ✓ PASS |
| Scheduled reconcile timer (clean tick writes nothing; timer off and on; stop; overlapping ticks share one run) and corpus reconcile | `bun test --timeout 30000 -t "scheduled reconcile\|reconcileCorpus\|diffPlane"` on `packages/mcp-server/src/service.test.ts` and `packages/mcp-server/src/corpus/reconcile.test.ts` (ERE alternation: `scheduled reconcile|reconcileCorpus|diffPlane`) | 24 pass, 0 fail, 83 expect() calls, 2 files (321 filtered) | ✓ PASS |
| Single-flight: a second tick starts no run | Named test "overlapping scheduled ticks share one run" in the row above (`service.test.ts`) | passes within the 24 | ✓ PASS |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report and scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` for this phase; no PLAN or SUMMARY declares a probe. Skipped.

Postgres: no Postgres-gated file in phase 78; `SUBSTRATE_TEST_PG_URL` unset for both runs; the index reads are verified by static read (SELECT only). No PG counts for this phase.

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run (prior gap 8, narrowed).** The first run that cuts into the counter pass is executed, not refused: `reconcile-main.test.ts:272` (passes). The second run after that cut is refused by the digest check (`reconcile-repair.ts:210-216`), but no test names that scenario. The generic digest refusal is tested at `reconcile-repair.test.ts:126`. WARNING, open (design owner).
2. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** `docs/reconcile.md` and `docs/mcp-audit.md` state it; the code matches.
3. **Refused-plan record (gap 7c): RESOLVED at 504da465 (a86e97aa).** Two tests pass.
4. **Prior gaps 9 and 17: RESOLVED by test.** `reconcile-main.test.ts:298` and `:331`.
5. **Scheduled tick single-flight: RESOLVED by test (94f4bc8e).** The named test passes at 9e71f263. The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Owner decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing).** The ledger's stored session id is capped (`normalizeKey`); the index's `claim_session` is read as stored (`reconcile-read.ts:224`). Owner decision.
8. **Node id straddle (carried, pre-existing data class).** Named in ROADMAP Phase 78 status.
9. **Corpus tombstone scope (informational).** `77d6b2c8` requires `scope` on ingest tombstones and refuses out-of-scope ones (`corpus/validate.ts`, `corpus/service.ts`). The phase 78 repair and `corpus/reconcile.ts` delete orphans through the plane, not ingest, so the rule does not change this phase's repair.
10. **Scheduled corpus reconcile unit (informational, phase 65).** `infra/vps/substrate-corpus-reconcile.{service,timer}` runs `corpus reconcile` daily as a dry run. Operator installs and enables it; this pass does not. The unit's ProtectHome mismatch with the sync and watch units is an owner decision (9e71f263).

## Human Verification Required

### 1. Scheduled tick on a staging host

**Test:** Start the server with `SUBSTRATE_RECONCILE_INTERVAL_S=60` against live stores. Wait for two ticks.
**Expected:** One `[substrate] reconcile {...}` line per tick with `clean:true`; no ledger, index or cache write.
**Why human:** Live cadence and real stores are not observable from unit tests. The concurrent-tick case is covered by the named test and is not part of this item.

### 2. Live cache flush at production key counts

**Test:** With the server stopped, `bun run reconcile -- plan --out <file>` from a live report with a generation orphan, then `repair --plan <file> --execute --server-stopped`.
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

No truth FAILED. No artifact is missing or a stub. No key link is unwired. Status is `human_needed` by the Step 9 decision tree: human items 1 to 4 are open.

Closed since 504da465: the single-flight test (truth 4 now VERIFIED by the named overlapping-tick test, 94f4bc8e).

Still open: the second-run counter-cut scenario (warning; counter-cut design stays open with the owner), the four live proofs, HARD-H2's status in REQUIREMENTS.md (owner), and the pre-existing 512-unit identity and node_id straddle items (owner decisions).

---

_Verified: 2026-11-04T23:00:34Z_
_Verifier: Claude (gsd-verifier)_
