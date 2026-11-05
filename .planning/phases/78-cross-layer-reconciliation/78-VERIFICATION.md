---
phase: 78-cross-layer-reconciliation
verified: 2026-11-05T00:14:02Z
status: human_needed
score: "2/2 roadmap criteria verified in code and by named tests; 8/8 truths verified; behavior_unverified 0; counter-cut second-run refusal open (warning, owner); 4 live proofs human_needed; HARD-H2 ORPHANED in REQUIREMENTS.md (owner)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD c40ffc9a"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (ROADMAP.md:1352-1355)"
covered_files: [".planning/REQUIREMENTS.md", ".planning/ROADMAP.md", ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/mcp-audit.md", "docs/reconcile.md", "docs/runbooks/corpus-sync.md", "packages/audit/src/log.ts", "packages/audit/src/policy.ts", "packages/cli/src/capsule.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/lease.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:38c5122512e8811d0742bc626605ab7998d9afc00d879d0bdec98e27fe85fdba"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at HEAD 9e71f263 (covered_digest v3:sha256:e889373b...): human_needed, 8/8 truths, counter-cut second-run open (warning), 4 live proofs open, HARD-H2 ORPHANED"
  selection: "Step 0: no top-level gaps: key in the prior record, so initial mode. The prior record is the checklist of claims and carried residuals. Re-checked against every covered file at c40ffc9a."
  changed_since_previous: "Range 9e71f263..c40ffc9a (12 commits). Phase 78 covered files that changed in range, and why none of it reaches a phase 78 criterion: config.ts:683 (comment only, docsSlo doc); flag-registry.ts:325 and :894 (docs SLO flag comment and the new SUBSTRATE_DOCS_SLO_SYNC_LAG_S row, phase 70); index-store.ts:3046-3134 (archive export and restore, phase 63; the reconcile readers at :2929-2990 are unchanged); service.ts:2958 (planning event, sync-lag SLO, phase 70) and :6392-6400 (retrieval row, phase 66); REQUIREMENTS.md:17,19 and ROADMAP.md:1064,1067,1178 (other phases; HARD-H2 at REQUIREMENTS.md:125 and :140 and ROADMAP 1352-1355 unchanged). No change to reconcile.ts, reconcile-read.ts, reconcile-run.ts, reconcile-repair.ts, reconcile-main.ts, reconcile*.test.ts, scripts/reconcile.ts, cache.ts, corpus/reconcile.ts, docs/reconcile.md, or the scheduled timer in service.ts (startReconcile :4185, reconcileTick :4202, runScheduledReconcile :4210). The line numbers in the prior record for the scheduled tests were stale; current ones are cited below."
  gaps_closed: []
  gaps_remaining:
    - "Counter-cut second-run refusal (WARNING, open, owner): not implemented as a dedicated refusal and no test names the scenario. The reading is undecided (owner). See Requirements and Warnings item 1"
    - "Operator items 1 to 4 (live proofs). Not run in this pass; open"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at c40ffc9a; owner or orchestrator decision"
    - "Pre-existing 512-unit session and node_id straddle items (owner decisions). Unchanged"
  regressions: []
advisory: []
overrides: []
gaps: []
human_verification:
  - test: "Scheduled tick on a staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 and a live ledger, index and cache"
    expected: "One '[substrate] reconcile {...}' line per tick with clean:true; no ledger, index or cache write"
    why_human: "Live cadence and real stores cannot be observed by unit tests. The concurrent-tick case is covered by the named single-flight test and is not a reason for this item"
  - test: "Live Dragonfly SCAN and UNLINK at production key counts, with the server stopped: reconcile repair --plan <file> --execute --server-stopped against a plan made from a live report with a generation orphan"
    expected: "Three passes (answers, counters, mark); at most 500 keys removed per run; a prefix above 1000000 keys refuses with nothing removed; the removed count matches the listed items in <file>.result.json"
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
**Verified:** 2026-11-05T00:14:02Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 9e71f263. Step 0 selected initial mode (no `gaps:` key). HEAD c40ffc9a, branch gsd/v18-int-all.
**Scope:** integration tree, HEAD c40ffc9a. Goal-backward, gsd-verifier procedure. No code edits, no commits, no full suite, no tsc, lint or formatters. Only this file was written, in the worktree. No database was connected to.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED | `reconcile-run.ts:49-112` builds counts and truncation for ledger, index and cache. `reconcile.ts` `buildReport` (`:186-212`) sets `first` per comparison and `clean`. Tests: `reconcile.test.ts:234` ("first is the first finding of each comparison in sorted order"), `:271` (end to end), `reconcile-read.test.ts` (17 tests). Scheduled log line carries `counts`, `first`, `truncated`, `unchecked_layers` (`service.ts:4223` area). Core targeted run at c40ffc9a: 235 pass, 0 fail |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED | Static: the reads are `queryEvents`, index `select` only (`index-store.ts:2929-2990`), cache `scanKeys` only (`cache.ts:1061`). `unlinkKeys` (`cache.ts:1087`) is reached only from `executePlan`. Behavioral: service.test.ts "one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing" (`service.test.ts:6448`) passes in the scheduled run at c40ffc9a; every store is a proxy that throws and records any write method |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED | `config.ts:1632` (0 is off; above 0 clamped to 60 to `RECONCILE_MAX_INTERVAL_S`); `flag-registry.ts:987-988`; `service.ts:4185-4199` (no timer when `intervalS <= 0`; `unref`); `startRecall` calls `startReconcile` (`service.ts:4171`), called from `index.ts:202`; `stopRecall` clears it (`service.ts:4177`, `index.ts:240`). Tests: `service.test.ts:6380` describe block passes; `config.test.ts:726-760` passes |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED | `service.ts:4202-4206` `this.reconcilePass ??= ... .finally(() => null)`. Named test `service.test.ts:6471` "overlapping scheduled ticks share one run" passes at c40ffc9a: the second `reconcileTick()` returns the in-flight promise while the first run's first read is held open; one `[substrate] reconcile` line is written for the shared run; after it settles, the next tick runs again, which shows `reconcilePass` was cleared |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED | `reconcile-main.ts:98-101` (usage: execute needs `--server-stopped`, exit 2); `reconcile-repair.ts:204-216` (digest mismatch refuses and writes nothing), orphan refusal via `planRefusal` (`:151`); dry run `:243`; no-server-stopped refusal `:252`. Tests: `reconcile-repair.test.ts:107` (dry run writes nothing), `:126` (digest mismatch), `:140` (orphan gone), `:151` (no orphans left), `:291` (execute without server stopped), `:312`, `:324`, `:336` (plan items refused). All pass in the core run at c40ffc9a |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED | `reconcile-repair.ts:168-178` (`flushPasses`), `:185-192` (`boundPasses`, total bound), `:227-233` (truncated scan refuses), `:264-276` (three passes, each batch counted via callback). Tests: `:169` (order and only those), `:197` (second run no-op), `:209` (scan fails, nothing removed), `:230`, `:249`, `:271` (failure in each pass), `:354`, `:376`, `:402` (bound), `:424` (second run removes remainder). All pass |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ✓ VERIFIED | `reconcile-main.ts:203-214` (durable check before any client opens, exit 2 with nothing flushed); `:246-266` (unreadable or missing plan: `recordRepair` with `outcome=refused`, then exit 1); `:270-291` (execute, record after flush, `.result.json`, exit 1 if the append fails). Tests: `reconcile-main.test.ts:177` (one record), `:200` (no durable chain: exit 2, nothing flushed), `:229`, `:253` (refusal records), `:298` (unwritable path: exit 2, `open` never called), `:331` (append throws, or reports `written: false`: exit 1, flush already done). All pass |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED | `corpus/reconcile.ts:170-174` (one total bound, RECONCILE_MAX_ITEMS), `:114-130` (`deleteOrphans`: `deleteDocuments` and only confirmed ids count as repaired), `:8-12` (documented rules), `:112` (manifest re-read, only `corpus:` names). Unchanged in range. Tests: `corpus/reconcile.test.ts` `diffPlane` and `reconcileCorpus` pass at c40ffc9a (scheduled run, 24 pass) |

**Score:** 8/8 truths verified (0 present-only, behavior-unverified). At the roadmap level, SC1 and SC2 are each verified in code and by named tests. The counter-cut second-run refusal (open criterion, see item 1 under Requirements and Warnings) and the four live proofs remain open.

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `compareLeases` `:82`; identity `:105-109`; `buildReport` `:186-212`; unchanged in range |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `:122` (ledger session as stored); `:224` (index claim_session as stored); `:233` (memory ids); unchanged in range |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `:49-112`; read-only by its own header; unchanged in range |
| `packages/mcp-server/src/reconcile-repair.ts` | digest, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `:56-67` (result counts); `:125-145` (planFromReport); `:151-160` (planRefusal); `:168-178`; `:185-192`; `:204-276`; unchanged in range |
| `packages/mcp-server/src/reconcile-main.ts` | durable check, R7 record on every execute, post-flush append, exit codes | ✓ VERIFIED | `:203-214`; `:246-266` (refused-plan record); `:270-291`; unchanged in range |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4185`; `reconcileTick` `:4202`; `runScheduledReconcile` `:4210`; the in-range hunks (`:2958`, `:6392-6400`) are outside it; single-flight exercised by a passing named test |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1632` (interval parse); `flag-registry.ts:987-988`; `config.test.ts:726-760` pass. In-range edits are comments and the phase 70 flag row only |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `:114-130`; `:170-174`; unchanged in range; tests pass at c40ffc9a |
| `packages/mcp-server/src/index-store.ts` | read-only reconcile readers | ✓ VERIFIED | reconcile SELECTs at `:2929-2990` unchanged. In-range edits (`:3046-3134`) are the phase 63 archive restore |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, scheduled report | ✓ VERIFIED | Unchanged in range. `docs/reconcile.md` matches `reconcile-main.ts` exit codes and audit reason fields, including the refused-plan record and the post-flush placement (owner-ratified) |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | identity for ordinary ids unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `:63-77` and `:77` (`reconcileMemoryRowsBefore`) | WIRED | all SELECTs (`index-store.ts:2929-2990`) |
| `service.ts` `startRecall` | `startReconcile` | `:4171` | WIRED | called at boot from `index.ts:202`; cleared by `stopRecall` (`index.ts:240`) |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4203`) | WIRED | single flight exercised by the named overlapping-tick test |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:204-214`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:258-266` before exit 1 | WIRED | refused-plan record present |
| `reconcileMain` (execute) | `executePlan` | with `serverStopped` (`:270`) | WIRED | |
| `reconcileMain` (append failed) | exit code | `:289-291` returns 1 after the flush | WIRED | covered by `reconcile-main.test.ts:331` |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:264-276`) | WIRED | |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:114-130`, confirmed ids only | WIRED | |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2929-2990`) and cache SCANs (`cache.ts:1061`), combined at `reconcile-run.ts:49-112`. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:168-178`, `:264-276`). The audit record's counts come from the `RepairResult` the flush returns (`reconcile-main.ts:157-171`). The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:135-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1632`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`reconcile-run.ts`, `unchecked_layers`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`); both unchanged at c40ffc9a. Owner or orchestrator to decide the status |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`: none in `reconcile*.ts`, `corpus/reconcile.ts`, `scripts/reconcile.ts`, `docs/reconcile.md` at c40ffc9a. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in phase 78 source. The `=> {}` no-ops are test seams in `reconcile-main.test.ts` only.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:170-174` do.
- **Commit-hash gate.** Not run: the phase's SUMMARY names no commit hashes for phase 78 beyond the base.

## Behavioral Spot-Checks (Step 7b)

Targeted runs at c40ffc9a, each with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. Two commands; no full suite.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Reconcile core, read, repair, main, memory policy, config, corpus routes | `bun test --timeout 30000 packages/mcp-server/src/reconcile.test.ts packages/mcp-server/src/reconcile-read.test.ts packages/mcp-server/src/reconcile-repair.test.ts packages/mcp-server/src/reconcile-main.test.ts packages/mcp-server/src/memory-policy.test.ts packages/mcp-server/src/config.test.ts packages/mcp-server/src/corpus/routes.test.ts` | 235 pass, 0 fail, 866 expect() calls, 7 files | ✓ PASS |
| Scheduled reconcile timer (describe at `service.test.ts:6380`: clean tick writes nothing; timer off and on; stop; overlapping ticks share one run) and corpus reconcile | `bun test --timeout 30000 -t "scheduled reconcile\|overlapping scheduled ticks\|reconcileCorpus\|diffPlane" packages/mcp-server/src/service.test.ts packages/mcp-server/src/corpus/reconcile.test.ts` | 24 pass, 0 fail, 83 expect() calls, 2 files (321 filtered) | ✓ PASS |
| Single-flight: a second tick starts no run | Named test `service.test.ts:6471` "overlapping scheduled ticks share one run" in the row above | passes within the 24 | ✓ PASS |
| Counter-cut: the first run that cuts into the counter pass is executed, not refused | `reconcile-main.test.ts:272` in the 235 row above | passes | ✓ PASS (execution only) |
| Counter-cut: second run after the cut is refused | no test names the scenario; read from code only (see Requirements and Warnings item 1) | none | ? OPEN (warning) |
| Live repair, audit record, chain verify after restart | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human item 4 |
| Live report and scheduled tick against real stores | not run: needs live stores | none | ? SKIP, human items 1 and 3 |

Probe execution (Step 7c): no `scripts/*/tests/probe-*.sh` exists in the tree (`find scripts -path '*/tests/probe-*.sh'` empty); no PLAN or SUMMARY declares a probe. Skipped.

Postgres: no Postgres-gated file in phase 78. None of the phase 78 test files references `SUBSTRATE_TEST_PG_URL`. The `SUBSTRATE_PG_URL` matches in `reconcile-main.test.ts`, `service.test.ts` and `config.test.ts` are the app's runtime configuration variable with in-process fixture URLs; they do not connect and are not the scratch gate. The database `substrate_test_v78` was not used. No PG counts for this phase. The index reads are verified by static read (SELECT only).

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run: OPEN (WARNING, owner).** The first run that cuts into the counter pass is executed, not refused: `reconcile-main.test.ts:272` (passes). The counter-cut second-run refusal is NOT implemented as a dedicated refusal, and no test names that scenario. Read from code [INFERENCE, not run]: after the cut removes the orphan's counter, a second run's live report no longer lists the generation orphan, so `executePlan` refuses on the findings digest (`reconcile-repair.ts:210-216`) or, failing that, on "no generation orphans remain" (`:217-218`). The generic digest refusal is tested at `reconcile-repair.test.ts:126`. Why it stays open: CONTEXT D78-6 says a re-run is safe because "a second run finds nothing to repair", and the owner has not decided whether a counter cut should be a named refusal (reading A) or left to the existing digest and orphan checks (reading B). Until decided, the criterion is not verified and the item is not closed.
2. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** `docs/reconcile.md` and `docs/mcp-audit.md` state it; the code matches.
3. **Refused-plan record (gap 7c): RESOLVED at 504da465 (a86e97aa).** Two tests pass.
4. **Prior gaps 9 and 17: RESOLVED by test.** `reconcile-main.test.ts:298` and `:331`.
5. **Scheduled tick single-flight: RESOLVED by test.** The named test `service.test.ts:6471` passes at c40ffc9a. The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Owner decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing).** The ledger's stored session id is capped (`normalizeKey`); the index's `claim_session` is read as stored (`reconcile-read.ts:224`). Owner decision.
8. **Node id straddle (carried, pre-existing data class).** Named in ROADMAP Phase 78 status.
9. **Corpus tombstone scope (informational).** `77d6b2c8` requires `scope` on ingest tombstones and refuses out-of-scope ones (`corpus/validate.ts`, `corpus/service.ts`). The phase 78 repair and `corpus/reconcile.ts` delete orphans through the plane, not ingest, so the rule does not change this phase's repair.
10. **Scheduled corpus reconcile unit (informational, phase 65).** `infra/vps/substrate-corpus-reconcile.{service,timer}` runs `corpus reconcile` daily as a dry run. Operator installs and enables it; this pass does not. Unit changes in range (ProtectHome) are phase 65 and not a phase 78 effect.

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

Unchanged since 9e71f263: the counter-cut second-run refusal (warning, open, owner reading undecided; no dedicated refusal, no named test), the four live proofs, HARD-H2's status in REQUIREMENTS.md (owner), and the pre-existing 512-unit identity and node_id straddle items (owner decisions).

---

_Verified: 2026-11-05T00:14:02Z_
_Verifier: Claude (gsd-verifier)_
