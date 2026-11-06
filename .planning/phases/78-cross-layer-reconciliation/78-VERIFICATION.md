---
phase: 78-cross-layer-reconciliation
verified: 2026-11-06T00:42:17Z
status: human_needed
score: "9/9 must-haves verified; behavior_unverified 0; 4 live proofs open (human); HARD-H2 ORPHANED in REQUIREMENTS.md (owner)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD a46d42c3"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (SC1, SC2)"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md", ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md", "docs/reconcile.md", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.test.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/reconcile-main.test.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-read.test.ts", "packages/mcp-server/src/reconcile-read.ts", "packages/mcp-server/src/reconcile-repair.test.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/reconcile.test.ts", "packages/mcp-server/src/reconcile.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/reconcile.ts"]
covered_digest: "v3:sha256:cab6dfe497c49fae0dbc003b09c483de57a9c8c02b7e883cdf6633a8866df332"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "9/9 must-haves verified (6e5d766e record, covered_digest v3:sha256:a6ac5f85711e3695535079c42f4f8ef238c54df2fd14f6b7ec26c0cca280b7f7)"
  selection: "Prior record carries a non-empty gaps_remaining list and no open gaps: re-verification mode. Changed commits 6e5d766e..a46d42c3 were diffed per covered file and per reconcile path; carried claims are marked as such. No targeted test was run in this pass: the test evidence is the gate r36 JUnit."
  changed_since_previous: "6e5d766e..a46d42c3. (a) reconcile-* files, corpus/reconcile*.ts, index-store.ts, flag-registry.ts, scripts/reconcile.ts, docs/reconcile.md, service.test.ts, config.test.ts: no net change (git diff --name-only over the range is empty for these paths). The commits that match a path filter (a46d42c3, f0f3c04e, 884e0753) touch shared files (cache.ts, config.ts, service.ts), not these. (b) cache.ts, f0f3c04e: reportSilent import (+1 line) and the ms <= 0 branch of withDeadline now reports the rejection; scanKeys is now :1072 and unlinkKeys :1098 (were :1071 and :1097); forgetVerdict :891 and snapshotSurvivesForget :915 bodies unchanged. The reconcile path calls neither (grep: only service.ts:2539, :2668, :2734 and cache.ts). (c) service.ts, f0f3c04e and earlier range commits: the scheduled reconcile block is byte-identical over the range (no hunk between old lines 4216 and 4300). It moved from :4230 to :4247 (startReconcile), stopReconcile :4258, reconcileTick :4264, runScheduledReconcile :4272. (d) config.ts: comment-only edit at lightragPollMs (lines 333-340), net 0 lines; SUBSTRATE_RECONCILE_INTERVAL_S still at :1632. (e) consistency-run.ts and consistency-verify.ts, f0f3c04e (the LedgerSkip change): not imported by any reconcile file; read-side only. (f) scripts/code-ratchet.baseline.json, a46d42c3: as_unknown_as 26 to 23, json_parse_casts 45 to 37. Not a covered file. (g) a46d42c3 deleted exports in modules the reconcile files do not import (grep of reconcile sources for each removed name: no match)."
  gaps_closed: []
  gaps_remaining:
    - "Operator items 1 to 4 (live proofs). Not run in this pass; open"
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at a46d42c3 (REQUIREMENTS.md not changed in range); owner or orchestrator decision"
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
**Verified:** 2026-11-06T00:42:17Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at 6e5d766e (human_needed, 9/9). HEAD a46d42c3, branch gsd/v18-int-all.
**Scope:** integration worktree, HEAD a46d42c3. Goal-backward, gsd-verifier procedure. Read-only: no edits, no commits, no test, tsc, lint or formatter run, no database. Test evidence is the gate r36 JUnit (`/root/src/worktrees/backups/gate-r36-junit.xml`: 12,317 testcases, 0 failures, 0 errors, 2 skipped). The two skipped cases are `D-04 fixtures do not survive the write path while counts do` (redact.test.ts:815) and `live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)` (cache-conformance.test.ts:120); neither is cited here. A cited title counts only when its testcase has no `failure`, `error` or `skipped` child, checked by parsing the XML.

## Focus of this pass

1. The `LedgerSkip` change (f0f3c04e): `LedgerReader.memoryWrites` returns `skipped`, the verifier adds it to `counts.ledger_events_malformed`, and `ledgerWriteReader` counts an unparseable accepted-write row without inventing an event.
2. The reconcile-* files and the scheduled timer: unchanged in range.
3. The counter-cut digest refusal (463f42f4): still holds at HEAD.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED | `reconcile-run.ts:49-112` builds counts and truncation for ledger, index and cache. `reconcile.ts` `buildReport` (`:186-212`) sets `first` and `clean`. Files unchanged in range. JUnit passes, no child element: 'a clean fixture reports clean, the unchecked row is counted, and nothing is written' (reconcile-read.test.ts:343), 'a dirty fixture reports the first mismatching key for each comparison' (reconcile-read.test.ts:362). Not re-run this pass |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED | Reads only: `queryEvents`; index SELECTs (`index-store.ts:2929-2990`, unchanged); cache `scanKeys` (`cache.ts:1072`). `unlinkKeys` (`cache.ts:1098`) is called only from `executePlan` (`reconcile-repair.ts:295`). The cache.ts range change is the `reportSilent` line in `withDeadline`, which is not on the scan or unlink path. JUnit pass, no child: 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (service.test.ts:6448) |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED | `config.ts:1632` (`SUBSTRATE_RECONCILE_INTERVAL_S`; 0 is off; above 0 is at least 60; no change in range). `service.ts:4247-4256` `startReconcile` (returns false with no timer when `intervalS <= 0`, `unref` at `:4251`); `stopReconcile` `:4258-4261`. The block is byte-identical to 6e5d766e (no hunk in service.ts between old lines 4216 and 4300). `startRecall` calls it at `service.ts:4233`; `index.ts:202` calls `startRecall`. JUnit passes, no child: 'startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears' (service.test.ts:6437), 'the scheduled reconcile is off when the interval is unset, blank or 0' (config.test.ts:727) |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED | `service.ts:4264-4268` `reconcileTick`: `this.reconcilePass ??= this.runScheduledReconcile().finally(...)`. Named test 'overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again' (service.test.ts:6471), JUnit pass, no child. Test file unchanged in range |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED | `reconcile-main.ts:98-101` (execute needs `--server-stopped`, exit 2); `reconcile-repair.ts` `executePlan` (`:218-299`): digest check `:238-244`, orphan refusal, dry run and no-server-stopped refusal. JUnit passes, no child: 'a dry run writes nothing', 'a digest mismatch refuses and writes nothing', 'an orphan that is gone refuses and writes nothing' (reconcile-repair.test.ts) |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED | `reconcile-repair.ts:181-192` (`flushPasses`), `:198-205` (`boundPasses`, total bound), `:254-261` (truncated scan refuses, nothing removed), `:292-299` (per-pass `unlinkKeys`, batches counted by callback). JUnit passes, no child: 'execute removes answers, then counters, then the forget mark, and only those'; 'a scan that cannot be completed removes nothing'; 'a failure in the answer pass leaves every counter and the mark in place'; 'a failure in the counter pass keeps the forget mark in place' |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ✓ VERIFIED | `reconcile-main.ts:202-213` (durable check before any client opens, exit 2, nothing flushed); `:253-270` (unreadable or missing plan: `recordRepair` with `outcome=refused`, then exit 1); `:271-295` (execute, record after flush, `.result.json` written, exit 1 if the append fails). JUnit passes, no child: 'reconcile-main.test.ts' cases as listed in the prior record (one-record, no-durable-chain, unreadable plan, missing plan, unwritable path) |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED | `corpus/reconcile.ts:170-174` (one total bound, RECONCILE_MAX_ITEMS), `:114-130` (`deleteOrphans`, only confirmed ids count as repaired), `:112` (manifest re-read, only `corpus:` names). `corpus/reconcile.ts` and its test unchanged in range. JUnit passes, no child: 'a delete the plane refused, or did not confirm, is not counted as repaired and the orphan …' and 'missing rows and orphans share one bound in total: more drift than RECONCILE_MAX_ITEMS is …' (titles truncated here; matched by prefix in gate r36, no child). Not re-run this pass |
| 9 | SC2 (behavior): a counter cut changes the repair digest, so the next execute refuses; plans written before the change do not match | ✓ VERIFIED | Commit `463f42f4` is an ancestor of HEAD (`git merge-base --is-ancestor`: true). `reconcile-repair.ts:103` `planDigest(findings, counters)` pins counter keys as `counter|key`; `:128` `scanCounters` (one `substrate:v1:gen*` scan, filtered to class `gen`, `truncated` carried); `:138` `planFromReport` pins the counters into `report_digest` (`:155`); `:218-244` `executePlan` re-reads the counters (`:226`), refuses when the scan is truncated (`:231`) and returns 'refused: the findings or the cache counters changed since the plan was made (digest mismatch); re-plan before repairing' when `planDigest` differs (`:238-244`). `reconcile-main.ts:236-238` pins the counter keys and throws when the counter scan is truncated. The reconcile-repair.ts and reconcile-main.ts files are unchanged since 463f42f4. Named test 'a counter cut that removes only a live-graph counter refuses the next execute' (reconcile-repair.test.ts:151, JUnit line 151, no child, 8 assertions) |

**Score:** 9/9 truths verified (0 present, behavior-unverified). The four live proofs remain open (Human Verification Required).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### LedgerSkip (adjacent change, not a phase 78 truth)

The change is in `f0f3c04e`. It is in the consistency verifier (`consistency-run.ts`, `consistency-verify.ts`), which is not in this phase's covered list and is not imported by any reconcile file (grep of `reconcile*.ts`, `corpus/reconcile*.ts` and `scripts/reconcile.ts`: no `consistency` import).

- `consistency-verify.ts:181-185`: `LedgerReader.memoryWrites` now returns `skipped: number` in its page, documented as rows "the reader could not read as an event; they are not in `events`".
- `consistency-verify.ts:1053`: `counts.ledger_events_malformed += page.skipped` once per page. The per-event malformed path (`:1060`) is unchanged.
- `consistency-run.ts:593-630` `ledgerWriteReader`: an accepted-write row (summary starts with `memory.write accepted`) that `writeEventOf` cannot read is counted in `skipped` and is not pushed to `events`. The count is deduplicated by `id:<row.id>` (or the JSON of the row when it has no id) through `countedSkips`, a Set that lives in the closure. The reader is built once per process (`openRealContext`, `consistency-run.ts:721`), so the set does not grow across runs. Read-side only: the diff adds no write.
- JUnit passes, no child element, cited by the title in the test file:
  - 'an unparseable ledger payload is counted as skipped, and no event is invented for it' (consistency-run.test.ts:732). It checks `page.skipped === 1`, `events` equal to `["ok"]`, and through the verifier `ok: true, findings: []` with `ledger_events_malformed: 1`.
  - 'a resumed page does not count the same unparseable row twice' (consistency-run.test.ts:754). It checks `[first.skipped, again.skipped]` equal `[1, 0]` on a resumed cursor.
  - 'malformed events are counted, not trusted' (consistency-verify.test.ts:681) is in gate r36 as a passing case.
- Observation (informational, not a phase 78 finding): a skipped accepted-write row is counted but does not make the consistency run unclean. The test at consistency-run.test.ts:751 pins `ok: true` with the count at 1. Owner or orchestrator may want to confirm that this is the intended reading for the consistency verifier. It does not touch HARD-H2, which is about the reconcile report.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `buildReport` `:186-212`; unchanged in range |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `:122`, `:194`, `:224`; unchanged in range |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `:49-112`; unchanged in range |
| `packages/mcp-server/src/reconcile-repair.ts` | digest over findings and counter keys, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `:103`, `:128`, `:138`, `:218-244`, `:181-205`, `:292-299`; unchanged since 463f42f4 |
| `packages/mcp-server/src/reconcile-main.ts` | plan pins counters; durable check; audit record on every execute; post-flush append; exit codes | ✓ VERIFIED | `:236-238` plan; `:202-213` durable check; `:253-270` refused-plan record; `:271-295` execute and record; unchanged since 463f42f4 |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4247`; `stopReconcile` `:4258`; `reconcileTick` `:4264`; `runScheduledReconcile` `:4272`. Block identical to 6e5d766e. Hunks in range are outside it |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1632` unchanged; config.ts range change is a comment at `:333-340`. `flag-registry.ts` unchanged in range |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `:114-130`; `:170-174`; unchanged in range |
| `packages/mcp-server/src/index-store.ts` | read-only reconcile readers | ✓ VERIFIED | reconcile SELECTs `:2929-2990`; unchanged in range |
| `packages/mcp-server/src/cache.ts` | `scanKeys` with truncation, `unlinkKeys` with per-batch callback | ✓ VERIFIED | `scanKeys` `:1072`; `unlinkKeys` `:1098` (were `:1071` and `:1097`; one import line added) |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, re-plan rule | ✓ VERIFIED | Unchanged in range. `docs/reconcile.md:55-57` state the counter-cut re-plan rule the code implements |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:122`) | WIRED | unchanged |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:224`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `:63-77` and `:77` | WIRED | unchanged |
| `service.ts` `startRecall` | `startReconcile` | `service.ts:4233`; `index.ts:202` boot | WIRED | unchanged |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4265`) | WIRED | exercised by the named overlapping-tick test |
| `reconcileMain` (plan) | `scanCounters` → `planFromReport` | `reconcile-main.ts:236-238` | WIRED | counter keys pinned; a truncated scan throws, reported as `reconcile failed:` with exit 1. No dedicated test for the truncated branch (see Warnings, item 2) |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:202-213`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:253-270` before exit 1 | WIRED | refused-plan record present |
| `executePlan` | `scanCounters` | `reconcile-repair.ts:226`; digest check `:238` | WIRED | live counter keys are pinned into the comparison |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:292-299`) | WIRED | |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:114-130`, confirmed ids only | WIRED | |
| `ledgerWriteReader` (LedgerSkip) | `verifyConsistency` | `skipped` added to `counts.ledger_events_malformed` (`consistency-verify.ts:1053`) | WIRED | consistency verifier only; not on the reconcile path |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2929-2990`) and cache SCANs (`cache.ts:1072`), combined at `reconcile-run.ts:49-112`. The plan's counter list is a live `substrate:v1:gen*` scan (`reconcile-repair.ts:128-131`), not a stored value. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:181-192`, `:292-299`). The audit record's counts come from the `RepairResult` the flush returns. The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:135-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1632`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`unchecked_layers`), repair never automatic (confirmed plan, `--server-stopped`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`); both unchanged at a46d42c3 (REQUIREMENTS.md is not changed in range). Owner or orchestrator decision; kept as the prior record has it |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the phase 78 reconcile sources, and none in the added lines of the range diff for `cache.ts`, `config.ts`, `service.ts`, `consistency-run.ts` or `consistency-verify.ts`. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 source. The range changes add no stub.
- **Re-verification evidence gate.** No Blocker is raised in this pass.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:170-174` do. Not changed in this pass; the file is not in the covered list.
- **Commit-hash gate.** The phase's SUMMARY names commit hashes for phase 78. `94f4bc8e` (single-flight test) and `463f42f4` (counter-cut digest) are ancestors of HEAD.

## Behavioral Spot-Checks (Step 7b)

No test was run in this pass (the assignment forbids it). The behavioral evidence is the gate r36 JUnit. Each title below was checked by parsing the XML: a testcase with no `failure`, `error` or `skipped` child.

| Behavior | Evidence | Result | Status |
| -------- | -------- | ------ | ------ |
| Counter-cut digest refusal | 'a counter cut that removes only a live-graph counter refuses the next execute' (reconcile-repair.test.ts:151) | pass in r36, no child | ✓ PASS (named evidence) |
| Scheduled tick, clean writes nothing | 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (service.test.ts:6448) | pass in r36, no child | ✓ PASS (named evidence) |
| Single-flight tick | 'overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again' (service.test.ts:6471) | pass in r36, no child | ✓ PASS (named evidence) |
| Timer lifecycle | 'startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears' (service.test.ts:6437) | pass in r36, no child | ✓ PASS (named evidence) |
| Interval clamps | 'the scheduled reconcile is off when the interval is unset, blank or 0' (config.test.ts:727) | pass in r36, no child | ✓ PASS (named evidence) |
| Ledger skip, no invented event | 'an unparseable ledger payload is counted as skipped, and no event is invented for it' (consistency-run.test.ts:732) | pass in r36, no child | ✓ PASS (named evidence) |
| Ledger skip, resumed page | 'a resumed page does not count the same unparseable row twice' (consistency-run.test.ts:754) | pass in r36, no child | ✓ PASS (named evidence) |
| Malformed events counted | 'malformed events are counted, not trusted' (consistency-verify.test.ts:681) | pass in r36, no child | ✓ PASS (named evidence) |
| Live report, scheduled tick and repair against real stores | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human items 1 to 4 |

Probe execution (Step 7c): no probe is declared in any PLAN or SUMMARY. Skipped.

Postgres: no Postgres-gated file was run in this pass. Gate r36 is the evidence for the named passes.

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run: RESOLVED (verified by named test).** Commit 463f42f4 pins the generation counter keys in the plan digest. Plans written before 463f42f4 do not match and must be re-planned (`docs/reconcile.md:57`, commit message).
2. **Plan counter-scan failure path: INFO, not test-covered.** `reconcile-main.ts:237` throws when the counter scan is truncated, so `plan` exits 1 with `reconcile failed: the cache counters could not be read completely`. No test names this branch. The truncated-scan refusal inside `executePlan` is covered (`reconcile-repair.ts:254-261`).
3. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** `docs/reconcile.md` and `docs/mcp-audit.md` state it; the code matches.
4. **Refused-plan record: RESOLVED.** `reconcile-main.test.ts` refused-plan cases pass in gate r36.
5. **Scheduled tick single-flight: RESOLVED by test** (`service.test.ts:6471`, gate r36 pass). The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Owner decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing).** The ledger's stored session id is capped (`normalizeKey`); the index's `claim_session` is read as stored (`reconcile-read.ts:224`). Owner decision.
8. **Node id straddle (carried, pre-existing data class).** Named in the ROADMAP Phase 78 status.
9. **ROADMAP status text is stale (INFO, orchestrator).** The ROADMAP Phase 78 status still lists the counter-cut test gap, the unwritable-path test gap and the post-flush append-failure test gap as open. Those tests are present and pass in gate r36. ROADMAP.md is not changed in range; not edited in this pass.
10. **Corpus tombstone scope (informational).** The phase 78 repair deletes orphans through the plane, not ingest, so the tombstone scope rule of `docs/corpus.md` does not change this phase's repair.
11. **Scheduled corpus reconcile unit (informational, phase 65).** The operator installs and enables the unit; this pass does not.
12. **Duplicate ledger events (informational, carried from 49b9aece).** The comparators take sets, so a duplicate row does not by itself create a finding. [INFERENCE from reading the comparators; not exercised by a test in this pass.]
13. **Ledger skip count does not fail the consistency run (informational, new, `f0f3c04e`).** See the LedgerSkip section. The count is reported, and `ok` stays true. Outside phase 78's covered files.
14. **Code-ratchet baseline (informational, `a46d42c3`).** `scripts/code-ratchet.baseline.json` moved `as_unknown_as` 26 to 23 and `json_parse_casts` 45 to 37, with the casts removed. Not a covered file.

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

No truth FAILED. No artifact is missing or a stub. No key link is unwired. No regression against the 6e5d766e record. Status is `human_needed` by the Step 9 decision tree: rule 1 does not fire, and human items 1 to 4 are open.

Changed since 6e5d766e: the reconcile-* files, the scheduled timer block and the counter-cut digest code are unchanged. The covered files that moved (`cache.ts`, `config.ts`, `service.ts`) changed off the reconcile path, so `covered_digest` moved to `v3:sha256:9257348c18e49b763cd59a94b777e63efb9ee8d596849c6c5a25a8e701955042`. The LedgerSkip change is in the consistency verifier, which no reconcile file imports.

Still open: the four live proofs; HARD-H2's status in REQUIREMENTS.md (owner); the pre-existing 512-unit identity and node_id straddle items (owner decisions); the stale ROADMAP status text (orchestrator).

---

_Verified: 2026-11-06T00:42:17Z_
_Verifier: Claude (gsd-verifier, re-verification pass; draft at backups/records)_
