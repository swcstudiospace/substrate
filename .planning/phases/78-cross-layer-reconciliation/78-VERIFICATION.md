---
phase: 78-cross-layer-reconciliation
verified: 2026-11-06T02:58:51Z
status: human_needed
score: "8 of 9 truths verified; truth 7 partial (owner item: no result file on the unreadable-plan path); behavior_unverified 0; 4 live proofs open (human); HARD-H2 ORPHANED in REQUIREMENTS.md (orchestrator)"
tree: "/root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 5e304ef8"
criteria_source: "this tree's ROADMAP Phase 78 success criteria (SC1, SC2)"
covered_files: [".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md","docs/reconcile.md","packages/mcp-server/src/cache.test.ts","packages/mcp-server/src/cache.ts","packages/mcp-server/src/config.test.ts","packages/mcp-server/src/config.ts","packages/mcp-server/src/consistency-run.test.ts","packages/mcp-server/src/consistency-run.ts","packages/mcp-server/src/consistency-verify.test.ts","packages/mcp-server/src/consistency-verify.ts","packages/mcp-server/src/corpus/reconcile.test.ts","packages/mcp-server/src/corpus/reconcile.ts","packages/mcp-server/src/event.ts","packages/mcp-server/src/flag-registry.ts","packages/mcp-server/src/index-store.ts","packages/mcp-server/src/index.ts","packages/mcp-server/src/mcp.ts","packages/mcp-server/src/reconcile-main.test.ts","packages/mcp-server/src/reconcile-main.ts","packages/mcp-server/src/reconcile-read.test.ts","packages/mcp-server/src/reconcile-read.ts","packages/mcp-server/src/reconcile-repair.test.ts","packages/mcp-server/src/reconcile-repair.ts","packages/mcp-server/src/reconcile-run.ts","packages/mcp-server/src/reconcile.test.ts","packages/mcp-server/src/reconcile.ts","packages/mcp-server/src/service.test.ts","packages/mcp-server/src/service.ts","packages/mcp-server/src/silent-failures.ts","scripts/deploy-preflight.test.ts","scripts/reconcile.ts"]
covered_digest: "v3:sha256:44571bddee047cfef2112e6ad986a3acdf829ff6758783927a2ca07ca2ab7706"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "9/9 must-haves verified at a46d42c3 (record covered_digest v3:sha256:cab6dfe497c49fae0dbc003b09c483de57a9c8c02b7e883cdf6633a8866df332)"
  selection: "Prior record at a46d42c3 carries gaps_remaining and no open gaps: re-verification mode. Head moved a46d42c3..5e304ef8 (14 commits, 317 files). Every covered file was diffed for the range (git diff a46d42c3 5e304ef8 on the 21 covered paths plus 78-01-PLAN.md and 78-SUMMARY.md); a carried verdict is kept only where its evidence is untouched. The record's covered_digest field is left as it was; the orchestrator recomputes it. The record body of a46d42c3 gave a different digest (v3:sha256:9257348c...) from the one in its frontmatter; the frontmatter value is carried here unchanged."
  changed_since_previous: "a46d42c3..5e304ef8. Covered-file hunks in range: (a) cache.ts, f1266a9c: the connect-cooldown refusal in bunRedis run() is now a typed CacheCooldownError with the same message, and script() reports its wait as breakerRetryAfterMs; scanKeys moved from :1072 to :1084 and unlinkKeys from :1098 to :1110 (the new class and an import line). (b) cache.ts, e62bc17b and b8cbdeac: export keywords removed; reportSilent import added. (c) reconcile-read.ts, e62bc17b: payloadOf catch now calls reportSilent and returns null, as before; the import and the reportSilent line shifted the lines below them by two (session_id :124, memory ids :196, claim_session :226). (d) corpus/reconcile.ts, e62bc17b: deleteOrphans reference-check catch calls reportSilent and continues, as before; the import and the reportSilent line shifted the lines below by two (deleteOrphans :115-135, prefix :118, re-read :120, bound :172-176). (e) index-store.ts, e62bc17b: a comment on the ping catch; reconcile readers now :2930-2986. (f) service.ts: export keywords only, plus 0947001e (manifestCommit at :6421, outside the reconcile path); no hunk between :4216 and :4300. (g) config.ts, reconcile-run.ts, reconcile-repair.ts, reconcile-main.ts, reconcile.ts, flag-registry.ts, reconcile-read.ts: export keywords removed (b8cbdeac, d9d0a401, 4c576e5e, 8ec17832, 66fa97bd, 5e304ef8); no other change. config.ts:1632 is unchanged. Removed-export check: 135 removed export lines; a static parse of every relative import and export-from clause in packages/ and scripts/ finds no importer of a removed name. A namespace import (scripts/deploy-preflight.test.ts) uses no removed config export. Runtime not exercised in this pass."
  gaps_closed: []
  gaps_remaining:
    - "Truth 7, result file: `<plan>.result.json` is not written on the unreadable- or missing-plan path (reconcile-main.ts:253-269 returns before the write at :283-291). docs/reconcile.md:55 says the file is written whatever the outcome. Owner item (STATE.md row 78, unreadable-plan audit gap)."
    - "Operator items 1 to 4 (live proofs). Not run in this pass; open."
    - "HARD-H2 ORPHANED in REQUIREMENTS.md: :125 unticked, :140 'Not started'. Unchanged at 5e304ef8 (the 5041193f edit to REQUIREMENTS.md does not touch these lines). Orchestrator decision."
    - "node_id straddle and 512-unit session identity (pre-existing). Owner items, no answer recorded. Unchanged."
  regressions: []
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
**Verified:** 2026-11-06T02:58:51Z
**Status:** human_needed
**Re-verification:** Yes, against the prior record at a46d42c3 (human_needed). HEAD 5e304ef8, branch gsd/v18-int-all.
**Scope:** integration worktree, HEAD 5e304ef8. Goal-backward, gsd-verifier procedure. Read-only: no edits to the worktree, no commits, no test, tsc, lint, gate or formatter run, no database. Test evidence is the gate r38 JUnit (`/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd). That run covers every code change in a46d42c3..5e304ef8 except 5e304ef8 itself, which changes one `export` keyword in config.ts and the code-ratchet baseline (`as_unknown_as` 23 to 22). r38's only failing testcase is `repository ratchet | the ratchet is tight: no source counter sits below its baseline`, which is not cited here and which 5e304ef8 addresses. The r39 JUnit (`gate-r39-junit.xml`) was not present when this pass wrote; this record makes no pass count claim. A cited title counts only when its r38 testcase has no `failure`, `error` or `skipped` child, checked by parsing the XML. Every cited title was also located in source with grep.

## Focus of this pass

1. The range a46d42c3..5e304ef8 on the covered files: 11 of 21 changed. Each hunk was read. The behaviour-touching hunks are the cache.ts connect-cooldown refusal (f1266a9c), the reportSilent calls on the reconcile path (e62bc17b), and export-keyword removals (no behaviour change).
2. The unreadable-plan audit gap (STATE.md row 78): traced reconcile-main.ts:244-270 against docs/reconcile.md:55 and the code comment at reconcile-main.ts:286-289.
3. The node_id straddle: compared the ledger write path (normalizeIdentifier, cut at 512 units without a dangling-high trim) with the index write and read paths.
4. Citations re-anchored at 5e304ef8. Test titles re-checked against r38 and against source.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key | ✓ VERIFIED (kept) | `reconcile-run.ts:49-115` (`runReport`: ledger reads `:55-61`, index reads `:63-81`, cache scans `:85-96`, `buildReport` call `:106`). `reconcile.ts` `buildReport` `:186-212` (only the `export` keyword removed in range; no line moved). In range, the `reconcile-read.ts` payloadOf catch now reports and returns null, as before. r38 pass, no child: 'a clean fixture reports clean, the unchecked row is counted, and nothing is written' (reconcile-read.test.ts:343); 'a dirty fixture reports the first mismatching key for each comparison' (reconcile-read.test.ts:362) |
| 2 | SC1: a clean run writes nothing (ledger, index, cache) | ✓ VERIFIED (kept; citations moved) | Reads only. `scanKeys` `cache.ts:1084-1102` (body unchanged; was :1072). `unlinkKeys` `cache.ts:1110-1125` (was :1098); its only caller is `executePlan`, `reconcile-repair.ts:295` (grep). Hunk checked: `cache.ts` `@@ -407` (`run`). The cooldown refusal is now `CacheCooldownError` with the same message; `scanKeys` reaches `run` through `cache.ts:443`, so a cooldown refusal rejects and reads as a failure, never as clean. The `script` hunk (`@@ -1046`) is not on the scan or unlink path. r38 pass, no child: 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (service.test.ts:6448); 'with the cache off, a scan is empty and incomplete, and an unlink removes nothing' (reconcile-read.test.ts:274). The cooldown itself: 'the connect cooldown is reported and expires; a breaker refusal does not start one' (cache.test.ts:1256, the get path). No reconcile test covers a scan or unlink refused by the cooldown (see Warnings, item 15) |
| 3 | SC1: timer is off at interval 0, starts at 60 or more, stop clears it; started from boot | ✓ VERIFIED (kept) | `config.ts:1632` (`SUBSTRATE_RECONCILE_INTERVAL_S` read in `loadReconcileSettings` `:1631`; 0 is off, above 0 is at least 60; unchanged except the export keyword). `service.ts:4247-4255` `startReconcile` (returns false with no timer when `intervalS <= 0`; `unref` at `:4251`); `stopReconcile` `:4258-4261`. No `service.ts` hunk in range falls between `:4216` and `:4300`. `startRecall` `:4231` calls `startReconcile` at `:4233`; `index.ts:203` calls `startRecall` (line moved from 202 by a reportSilent import). r38 pass, no child: 'startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears' (service.test.ts:6437); 'the scheduled reconcile is off when the interval is unset, blank or 0' (config.test.ts:727) |
| 4 | SC1 (behavior): a tick while a run is in flight starts no second run | ✓ VERIFIED (kept) | `service.ts:4264-4269` `reconcileTick`: `this.reconcilePass ??= this.runScheduledReconcile().finally(...)`. Named test 'overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again' (service.test.ts:6471), r38 pass, no child. The block is unchanged in range |
| 5 | SC2: repair is a separate confirmed step: dry run by default, `--execute` needs `--server-stopped`, a digest pins the plan, a stale plan is refused, a gone orphan is refused | ✓ VERIFIED (kept) | `reconcile-main.ts:97-101` (execute without `--server-stopped` is a usage error, exit 2). `reconcile-repair.ts` `executePlan` `:218-250`: counter re-read `:226`, truncated counter scan refusal `:231`, digest comparison `:238-244`, no-orphan refusal `:246-248`, `planRefusal` `:249-250`. Dry run `:271-278`. r38 pass, no child: 'a dry run writes nothing' (reconcile-repair.test.ts:118); 'a digest mismatch refuses and writes nothing' (reconcile-repair.test.ts:137); 'an orphan that is gone refuses and writes nothing' (reconcile-repair.test.ts:172); 'execute without --server-stopped exits 2 and opens no client' (reconcile-main.test.ts:156) |
| 6 | SC2: the flush runs answers, then counters, then the forget mark; bounded at 500 keys per run; a scan that cannot complete removes nothing; a failed pass keeps later counters and the mark | ✓ VERIFIED (kept) | `reconcile-repair.ts:181-192` (`flushPasses`), `:198-205` (`boundPasses`, one total bound), `:254-261` (truncated scan refuses, nothing removed), `:292-299` (`unlinkPass`, batches counted by callback), `:305-317` (failure keeps the counts so far). r38 pass, no child: 'execute removes answers, then counters, then the forget mark, and only those' (reconcile-repair.test.ts:201); 'a scan that cannot be completed removes nothing' (reconcile-repair.test.ts:241); 'a failure in the answer pass leaves every counter and the mark in place' (reconcile-repair.test.ts:262); 'a failure in the counter pass keeps the forget mark in place' (reconcile-repair.test.ts:281) |
| 7 | SC2: plan record. Every execute leaves one audit record (refused plans too); the chain is checked durable before the flush; the record follows the flush; `<plan>.result.json` is written | ◐ PARTIAL (owner item) | Met: (a) one audit record per execute, refused plans included, on the refusal paths (`reconcile-main.ts:253-270`: unreadable or missing plan, `recordRepair` with `outcome=refused`, then exit 1); (b) the durable check runs before any client opens (`:202-213`, exit 2, nothing flushed); (c) the record follows the flush (`:280-282`, after `executePlan` at `:273`). Not met: (d) `<plan>.result.json` on every execute outcome. The write sits in the `finally` at `:283-291`, which the unreadable- or missing-plan branch never reaches (it returns 1 at `:269`). `docs/reconcile.md:55` says the file is written "whatever the outcome"; the comment at `reconcile-main.ts:286-289` says every outcome of an execute is on record. The two unreadable-plan tests pass in r38 and assert the audit record, not the result file: 'an unreadable plan under execute records one refusal in the audit chain and exits 1' (reconcile-main.test.ts:225); 'an execute whose plan file is missing records one refusal with an unreadable digest and exits 1' (reconcile-main.test.ts:249). No test asserts the result file on that path either way. Also: if the refusal record cannot be written, the CLI prints a line and exits 1, the same exit code as a plain refusal (`:266-269`). Owner item: STATE.md row 78 "Unreadable-plan audit gap and tests" |
| 8 | SC2: corpus delete rules: a bounded total (500 keys), plane deletes confirmed by the plane, rows re-read before a delete, only `corpus:` names | ✓ VERIFIED (kept; citations moved) | `corpus/reconcile.ts` `deleteOrphans` `:115-135`: `corpus:` prefix check `:118`; `activeReferences` re-read `:120` (a failed re-read is reported through reportSilent and that orphan is skipped, not deleted); only ids the plane confirmed are counted `:129-131`. One total bound for missing rows and orphans `:172-176`. r38 pass, no child: 'a delete the plane refused, or did not confirm, is not counted as repaired and the orphan is reported again by the next run' (corpus/reconcile.test.ts:177); 'missing rows and orphans share one bound in total: more drift than RECONCILE_MAX_ITEMS is cut, reported truncated, and execute repairs only what it reported' (corpus/reconcile.test.ts:250) |
| 9 | SC2 (behavior): a counter cut changes the repair digest, so the next execute refuses; plans written before the change do not match | ✓ VERIFIED (kept) | Commit `463f42f4` is an ancestor of HEAD (`git merge-base --is-ancestor`: true). `reconcile-repair.ts` `planDigest` `:103-109` (counter keys as `counter|key`), `scanCounters` `:128-132` (one `substrate:v1:gen*` scan, filtered to class `gen`, `truncated` carried), `planFromReport` `:138-158` (`report_digest` at `:155`). `executePlan` re-reads the counters at `:226`, refuses a truncated scan at `:231`, and compares digests at `:238-244`. `reconcile-main.ts:235-238` pins the counter keys in the plan. `docs/reconcile.md:55` states the re-plan rule. r38 pass, no child: 'a counter cut that removes only a live-graph counter refuses the next execute' (reconcile-repair.test.ts:151) |

**Score:** 8 of 9 truths verified in full; truth 7 partial on its result-file clause (owner item). 0 present, behavior-unverified 0. The four live proofs remain open (Human Verification Required).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### LedgerSkip (adjacent change, not a phase 78 truth; outside this range)

The change is in `f0f3c04e`, which precedes a46d42c3 and so is not in this pass's range. It is in the consistency verifier (`consistency-run.ts`, `consistency-verify.ts`), which is not in this phase's covered list and is not imported by any reconcile file. Those files are not changed in a46d42c3..5e304ef8 except `consistency-verify.ts`, which changed only by export keyword; its anchors below are unchanged.

- `consistency-verify.ts:182-185`: `LedgerReader.memoryWrites` returns `skipped: number` in its page, documented as rows "the reader could not read as an event; they are not in `events`".
- `consistency-verify.ts:1053`: `counts.ledger_events_malformed += page.skipped` once per page. The per-event malformed path (`:1060`) is unchanged.
- `consistency-run.ts:593-630` `ledgerWriteReader`: an accepted-write row that `writeEventOf` cannot read is counted in `skipped` and is not pushed to `events`. The count is deduplicated through `countedSkips`. Read-side only.
- r38 pass, no child, cited by title: 'an unparseable ledger payload is counted as skipped, and no event is invented for it' (consistency-run.test.ts:732); 'a resumed page does not count the same unparseable row twice' (consistency-run.test.ts:754); 'malformed events are counted, not trusted' (consistency-verify.test.ts:681).
- Observation (informational, not a phase 78 finding): a skipped accepted-write row is counted but does not make the consistency run unclean. The test at consistency-run.test.ts:751 pins `ok: true` with the count at 1. Owner or orchestrator may want to confirm that this is the intended reading for the consistency verifier.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile.ts` | comparators, `buildReport`, `first`, `clean` | ✓ VERIFIED | `buildReport` `:186-212`; export keyword only in range |
| `packages/mcp-server/src/reconcile-read.ts` | read-only readers; stored values read as stored | ✓ VERIFIED | `transitionOf` `:116-130` (ledger `session_id` as stored `:124`); `readLedgerMemoryIds` `:196`; `readIndexLeases` `:214-232` (`claim_session` as stored `:226`); payloadOf reports its parse failure and returns null (e62bc17b) |
| `packages/mcp-server/src/reconcile-run.ts` | counts, truncation, cache-off unchecked | ✓ VERIFIED | `runReport` `:49-115`; cache scans `:85-96`; cache-off unchecked `:91-97`; export keyword only in range |
| `packages/mcp-server/src/reconcile-repair.ts` | digest over findings and counter keys, orphan and plan refusals, ordered bounded flush | ✓ VERIFIED | `planDigest` `:103`, `scanCounters` `:128`, `planFromReport` `:138`, `executePlan` `:218-329`, `flushPasses` `:181`, `boundPasses` `:198`; only export keywords changed in range |
| `packages/mcp-server/src/reconcile-main.ts` | plan pins counters; durable check; audit record on every execute; post-flush append; exit codes | ◐ PARTIAL | Plan pin `:235-238`; durable check `:202-213`; refused-plan record `:253-270`; execute and record `:271-295`; result-file write `:283-291` (not reached on the unreadable- or missing-plan branch). Only export keywords changed in range |
| `packages/mcp-server/src/service.ts` (scheduled reconcile only) | interval timer, single-flight tick, read-only run | ✓ VERIFIED | `startReconcile` `:4247`; `stopReconcile` `:4258`; `reconcileTick` `:4264`; `runScheduledReconcile` `:4272-4291` (its catch writes one stderr line at `:4288-4290`). Block identical to a46d42c3 |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | `SUBSTRATE_RECONCILE_INTERVAL_S`, `_WINDOW_HOURS`, clamps and refusals | ✓ VERIFIED | `config.ts:1632` unchanged; export keywords only in range. `flag-registry.ts` export keywords only in range |
| `packages/mcp-server/src/corpus/reconcile.ts` | corpus repair: bound, plane-confirmed deletes | ✓ VERIFIED | `deleteOrphans` `:115-135`; bound `:172-176`; reportSilent in the re-read catch (e62bc17b) |
| `packages/mcp-server/src/index-store.ts` | read-only reconcile readers | ✓ VERIFIED | reconcile readers `:2930-2986`; the only range change near them is a comment on the ping catch (e62bc17b) |
| `packages/mcp-server/src/cache.ts` | `scanKeys` with truncation, `unlinkKeys` with per-batch callback | ✓ VERIFIED | `scanKeys` `:1084-1102`; `unlinkKeys` `:1110-1125`; cooldown refusal class `:342-350` and the `run` guard `:418-422` (f1266a9c) |
| `scripts/reconcile.ts`, `docs/reconcile.md` | CLI wrapper; documented exit codes, audit fields, re-plan rule | ✓ VERIFIED (docs carry the result-file statement that truth 7 disputes) | `docs/reconcile.md:55-57` state the confirmed-execute, audit and re-plan rules; `:68` the exit codes. `scripts/reconcile.ts` unchanged in range |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `reconcile-read.ts` ledger holds | `reconcile.ts` `compareLeases` | `session_id` as stored (`:124`) | WIRED | a session id over 512 units is capped in the ledger by `normalizeKey` (event.ts:436); the index reads `claim_session` as stored (see the identity warning below) |
| `reconcile-read.ts` index holds | `reconcile.ts` `compareLeases` | `claim_session` as stored (`:226`) | WIRED | a session or node id over 512 units differs from the capped ledger string (pre-existing, owner decision) |
| `reconcile-run.ts` | `index-store.ts` reconcile readers | `reconcileHolds`, `reconcileHeldNodes`, `reconcileMemoryIds`, `reconcileGraphIds` (`index-store.ts:2930-2986`) | WIRED | unchanged |
| `service.ts` `startRecall` | `startReconcile` | `service.ts:4233`; `index.ts:203` boot | WIRED | unchanged apart from the index.ts line |
| `reconcileTick` | `runScheduledReconcile` | `??=` single flight (`service.ts:4265`) | WIRED | exercised by the named overlapping-tick test |
| `reconcileMain` (plan) | `scanCounters` then `planFromReport` | `reconcile-main.ts:235-238` | WIRED | counter keys pinned; a truncated scan throws, reported as `reconcile failed:` with exit 1 (`:301-303`). No test names this branch (see Warnings, item 2) |
| `reconcileMain` (execute) | `openRepairAudit` durable check | before any client opens (`reconcile-main.ts:202-213`) | WIRED | exit 2 with nothing flushed |
| `reconcileMain` (unreadable or missing plan) | `recordRepair` | `:253-270`, then exit 1 | WIRED for the audit record; NOT WIRED for `<plan>.result.json` (truth 7) | owner item |
| `executePlan` | `scanCounters` | `reconcile-repair.ts:226`; digest check `:238` | WIRED | live counter keys are pinned into the comparison |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (`reconcile-repair.ts:292-299`) | WIRED | the only caller of `unlinkKeys` (grep) |
| `scanKeys` / `unlinkKeys` | connect-cooldown guard | `cache.ts:418-422` (`run`), reached by `cache.ts:443` (`scan`) and `unlink` | WIRED | a refusal rejects; the scheduled tick logs a stderr failure line and the CLI exits 1. Inferred from code; not exercised by a reconcile test |
| `corpus/reconcile.ts` `deleteOrphans` | `plane.deleteDocuments` | `:115-135`, confirmed ids only (`:129-131`) | WIRED | unchanged |
| `ledgerWriteReader` (LedgerSkip) | `verifyConsistency` | `skipped` added to `counts.ledger_events_malformed` (`consistency-verify.ts:1053`) | WIRED | consistency verifier only; not on the reconcile path |

## Data-Flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs (`index-store.ts:2930-2986`) and cache SCANs (`cache.ts:1084`), combined at `reconcile-run.ts:49-115`. The plan's counter list is a live `substrate:v1:gen*` scan (`reconcile-repair.ts:128-131`), not a stored value. The flush reads live `substrate:v1:*` keys and removes only the classes it names (`reconcile-repair.ts:181-192`, `:292-299`). The audit record's counts come from the `RepairResult` the flush returns. The corpus repair reads live rows and plane listings and acts only on the listed slices (`corpus/reconcile.ts:137-179`). No hardcoded result feeds these values.

## Requirements Coverage (Step 6)

| Requirement | Source plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H2 (REQUIREMENTS.md:125) | none: PLAN 78-01 has no `requirements:` field | Scheduled, bounded, read-only comparison; reports missing, orphaned or mismatched records with evidence and run or window limits; never mutates authoritative data automatically; never treats an unavailable probe as clean | **ORPHANED** (Step 6c). The clauses have implementation evidence: window (`config.ts:1632`), scan caps (`reconcile-run.ts` `DEFAULT_RECONCILE_CAPS`), read-only report path, unclean on unavailable layers (`unchecked_layers`, and a cache-off run is never clean, `reconcile-run.ts:91-97`), repair never automatic (confirmed plan, `--server-stopped`). The checkbox is unticked (`REQUIREMENTS.md:125`) and the table row says `Not started` (`:140`). Both are unchanged at 5e304ef8: the 5041193f edit to REQUIREMENTS.md touched the FLEET, HARD-S1 and HARD-H1 lines only. Owner or orchestrator decision; it is a status-tracking gap, not a code gap in this phase |

## Anti-Patterns (Step 7)

- **Debt-marker gate.** No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the added lines of the range diff for the covered files. The gate does not fire.
- **Stub scan.** No stub, placeholder or no-op in the phase 78 source. The range changes add none.
- **Re-verification evidence gate.** No Blocker is raised in this pass. Truth 7 is a partial verdict tied to an open owner item, not a blocker.
- **Commit-hash gate.** `94f4bc8e` (single-flight test), `463f42f4` (counter-cut digest) and `f1266a9c` (connect cooldown, which the reconcile path reaches) are ancestors of HEAD.
- **Doc-comment drift (minor, carried).** `packages/corpus/src/protocol.ts:263` describes `RECONCILE_MAX_ITEMS` as the most items one list holds. The bound is total per run, as `reconcile-repair.ts:185-192` and `corpus/reconcile.ts:172-176` do. The file is not in the covered list and was not re-read in this pass.

## Behavioral Spot-Checks (Step 7b)

No test was run in this pass (the assignment forbids it). The behavioral evidence is the gate r38 JUnit. Each title was checked by parsing the XML: a testcase with no `failure`, `error` or `skipped` child. The r39 JUnit was not present when this pass wrote.

| Behavior | Evidence | Result | Status |
| -------- | -------- | ------ | ------ |
| Counter-cut digest refusal | 'a counter cut that removes only a live-graph counter refuses the next execute' (reconcile-repair.test.ts:151) | pass in r38, no child | ✓ PASS (named evidence) |
| Scheduled tick, clean writes nothing | 'one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing' (service.test.ts:6448) | pass in r38, no child | ✓ PASS (named evidence) |
| Single-flight tick | 'overlapping scheduled ticks share one run: the second starts nothing and both resolve to its outcome, and a tick after it settles runs again' (service.test.ts:6471) | pass in r38, no child | ✓ PASS (named evidence) |
| Timer lifecycle | 'startReconcile starts no timer at interval 0, and starts one at 60 that stopReconcile clears' (service.test.ts:6437) | pass in r38, no child | ✓ PASS (named evidence) |
| Interval clamps | 'the scheduled reconcile is off when the interval is unset, blank or 0' (config.test.ts:727) | pass in r38, no child | ✓ PASS (named evidence) |
| Dry run, digest, gone orphan | 'a dry run writes nothing' (reconcile-repair.test.ts:118); 'a digest mismatch refuses and writes nothing' (:137); 'an orphan that is gone refuses and writes nothing' (:172) | pass in r38, no child | ✓ PASS (named evidence) |
| Flush order and failure passes | 'execute removes answers, then counters, then the forget mark, and only those' (reconcile-repair.test.ts:201); 'a failure in the answer pass leaves every counter and the mark in place' (:262); 'a failure in the counter pass keeps the forget mark in place' (:281) | pass in r38, no child | ✓ PASS (named evidence) |
| Failed scan removes nothing | 'a scan that cannot be completed removes nothing' (reconcile-repair.test.ts:241); 'a scan that fails removes nothing and reports the failure' (reconcile-repair.test.ts:408, not cited in the truths) | pass in r38, no child | ✓ PASS (named evidence) |
| Unreadable and missing plan (audit record only) | 'an unreadable plan under execute records one refusal in the audit chain and exits 1' (reconcile-main.test.ts:225); 'an execute whose plan file is missing records one refusal with an unreadable digest and exits 1' (reconcile-main.test.ts:249) | pass in r38, no child; neither asserts `<plan>.result.json` | ✓ PASS for the audit record; result file untested |
| Durable chain and audit failures | 'a repair execute with no durable audit chain exits 2 and flushes nothing' (reconcile-main.test.ts:196); 'an unwritable SUBSTRATE_AUDIT_PATH exits 2 and flushes nothing' (reconcile-main.test.ts:294); 'an audit append that throws after the flush exits 1, and the flush and its result file stand' and 'an audit append that reports written: false after the flush exits 1, and the flush and its result file stand' (reconcile-main.test.ts, both labels) | pass in r38, no child | ✓ PASS (named evidence) |
| One audit record per execute | 'one repair execute writes exactly one audit record, carrying the plan digest and the counts' (reconcile-main.test.ts:173) | pass in r38, no child | ✓ PASS (named evidence) |
| Corpus delete rules and bound | 'a delete the plane refused, or did not confirm, is not counted as repaired and the orphan is reported again by the next run' (corpus/reconcile.test.ts:177); 'missing rows and orphans share one bound in total: more drift than RECONCILE_MAX_ITEMS is cut, reported truncated, and execute repairs only what it reported' (corpus/reconcile.test.ts:250) | pass in r38, no child | ✓ PASS (named evidence) |
| Lease lookup without time bound | 'a hold granted before the window is found by its node, with no time bound' (reconcile-read.test.ts:222); 'a lookup whose rows run out before any transition is truncated' (reconcile-read.test.ts:246) | pass in r38, no child | ✓ PASS (named evidence) |
| Capped scan and cache-off run | 'a capped cache scan makes the run unclean' (reconcile-read.test.ts:381); 'with the cache off, a scan is empty and incomplete, and an unlink removes nothing' (reconcile-read.test.ts:274) | pass in r38, no child | ✓ PASS (named evidence) |
| Connect cooldown (get path, shared guard) | 'the connect cooldown is reported and expires; a breaker refusal does not start one' (cache.test.ts:1256) | pass in r38, no child | ✓ PASS (named evidence; not a reconcile test) |
| Live report, scheduled tick and repair against real stores | not run: needs live PG, GreptimeDB, Dragonfly and an audit file | none | ? SKIP, human items 1 to 4 |

Probe execution (Step 7c): no probe is declared in any PLAN or SUMMARY. Skipped.

Postgres: no Postgres-gated file was run in this pass. Gate r38 is the evidence for the named passes.

## Requirements and Warnings (non-blocking)

1. **Counter-cut second run: RESOLVED (verified by named test).** Commit 463f42f4 pins the generation counter keys in the plan digest. Plans written before 463f42f4 do not match and must be re-planned (`docs/reconcile.md:55`, commit message).
2. **Plan counter-scan failure path: INFO, not test-covered.** `reconcile-main.ts:236-237` throws when the counter scan is truncated, so `plan` exits 1 with `reconcile failed: the cache counters could not be read completely`. No test names this branch (no `could not be read completely` assertion in `reconcile-main.test.ts`). The truncated-scan refusal inside `executePlan` is covered (`reconcile-repair.ts:254-261`; 'a scan that cannot be completed removes nothing', reconcile-repair.test.ts:241).
3. **Audit placement (R7, post-flush): RESOLVED, owner-ratified 2026-11-03.** STATE.md:803 ("the 78 post-flush policy kept and documented"); `docs/reconcile.md:79` states it; the code matches.
4. **Refused-plan audit record: RESOLVED. Refused-plan result file: OPEN (truth 7).** The audit record exists and its tests pass in r38. The `<plan>.result.json` clause does not hold on the unreadable- or missing-plan path.
5. **Scheduled tick single-flight: RESOLVED by test** (`service.test.ts:6471`, pass in r38). The live cadence remains human item 1.
6. **HARD-H2 ORPHANED** (`REQUIREMENTS.md:125`, `:140`). Orchestrator decision. WARNING.
7. **Session and node identity over 512 units (carried, pre-existing, owner).** The ledger's stored session id is capped by `normalizeKey` (`event.ts:436`); the index's `claim_session` is read as stored (`reconcile-read.ts:226`). A session id over 512 units therefore compares as drift. Owner decision; no answer recorded.
8. **Node id straddle (carried, pre-existing data class, owner).** [INFERENCE from reading `event.ts:438` (`node_id: normalizeIdentifier`, a 512-unit cut with no dangling-high trim), `service.ts:5602-5612` (`claimNode` passes the caller's id to the index), and `index-store.ts:1191-1194` (`graph_nodes` insert with `node.node_id` as given). The MCP input schemas declare `node_id` as `z.string()` with no length cap (`mcp.ts:1297` for graph_register nodes, `mcp.ts:1400` for graph_claim). So a node id over 512 units may be stored differently in the ledger (cut) and the index (whole), and the lease comparison (`reconcile-read.ts:117-124`, `:226`) then reads it as drift. Not exercised; no live store read.] The 2026-11-04 owner decision (`docs/greptime-ledger.md:389`) covers straddled ledger rows only. The treatment of a node id straddling the cut in graph_register and graph_claim is open (STATE.md:869).
9. **ROADMAP status text is stale (INFO, orchestrator).** ROADMAP.md:1348 was rewritten in 5041193f to the "9 of 9" text, and it still lists the counter-cut test gap, the unwritable-path test gap and the post-flush append-failure test gap as open. Those tests are present and pass in r38 (reconcile-repair.test.ts:151; reconcile-main.test.ts:294; the two post-flush append-failure cases at reconcile-main.test.ts:331). The phase 78 table row (ROADMAP.md:1426) was updated in the same commit.
10. **Corpus tombstone scope (informational).** The phase 78 repair deletes orphans through the plane, not ingest, so the tombstone scope rule of `docs/corpus.md` does not change this phase's repair.
11. **Scheduled corpus reconcile unit (informational, phase 65).** The operator installs and enables the unit; this pass does not.
12. **Duplicate ledger events (informational, carried from 49b9aece).** The comparators take sets, so a duplicate row does not by itself create a finding. [INFERENCE from reading the comparators; not exercised by a test in this pass.]
13. **Ledger skip count does not fail the consistency run (informational, `f0f3c04e`, before this range).** See the LedgerSkip section. The count is reported, and `ok` stays true. Outside phase 78's covered files.
14. **Code-ratchet baseline (informational, 5e304ef8).** `scripts/code-ratchet.baseline.json` now reads `as_unknown_as` 22 and `json_parse_casts` 37 (a46d42c3 had 23 and 37). Not a covered file. The r38 ratchet failure is outside the phase 78 cited titles; r39 decides it.
15. **Cooldown on the reconcile path (new, test gap).** `scanKeys` and `unlinkKeys` go through the connect-cooldown guard in `run()` (f1266a9c). A cooldown refusal rejects the scan (so the report is not clean and the scheduled tick logs a stderr failure line; the CLI exits 1), and rejects an unlink (so the flush records a failure with the keys removed so far). No reconcile test drives a cooldown refusal through the scan or the unlink. The behaviour is inferred from code, not exercised.
16. **Export removals (new, no behaviour change).** 135 `export` keywords removed across the covered files (b8cbdeac, d9d0a401, 4c576e5e, 8ec17832, 66fa97bd, 5e304ef8). A static check found no importer of a removed name, and no barrel re-export of a covered module. Runtime import resolution was not exercised here; the r39 gate decides.
17. **Silent-failure reporting on the reconcile path (new, no count change).** `reconcile-read.ts` payloadOf and `corpus/reconcile.ts` deleteOrphans now write one stderr line per site through `reportSilent` (`silent-failures.ts:29-33`) and keep their result. The reconcile verdicts are unchanged.
18. **Outside this phase (informational).** `service.ts:6421` `manifestCommit` now returns the corpus row (0947001e, phase 63). It is on the docs-search path, not the reconcile path (grep).

## Owner decisions (recorded 2026-11-06)

- **2026-11-06, phase 78.** No owner decision for phase 78 was made on 2026-11-06 that this pass can record. The decisions dated 2026-11-06 apply to other phases only. Every phase 78 owner item below stays open. No `overrides:` entry is recorded for phase 78; no waiver is widened, and no code change is treated as a decision.
- **Earlier owner answers already on record** (quoted, not new):
  - D78-5 (the ordered three-pass flush, amended in ee1c9534) and D78-6 (the mandatory `--server-stopped`) are accepted as the design of record (STATE.md:731, Run 17, 2026-11-02).
  - The bound is total, 500 keys per run (STATE.md:794, Run 18 fourth pass, 2026-11-03).
  - The post-flush audit policy is kept and documented (STATE.md:803, Run 18 fifth pass, 2026-11-03).
  - Straddled ledger rows are left as they are (`docs/greptime-ledger.md:389`, 2026-11-04). This covers ledger rows, not the graph_register and graph_claim write path.
- **Open, no owner answer recorded:**
  - Unreadable-plan audit gap and tests (STATE.md:868; truth 7).
  - node_id straddle in graph_register and graph_claim (STATE.md:869; warning 8).
  - Session and node identity over 512 units (warning 7).
  - HARD-H2 status in REQUIREMENTS.md (STATE.md:870; orchestrator).
  - Operator items 1 to 4 (STATE.md:871; operator).

## Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired on the scheduled path, the repair path or the corpus path. Truth 7 is PARTIAL: the result-file clause does not hold on the unreadable- or missing-plan path. That is an owner item (STATE.md:868), and the code and `docs/reconcile.md:55` disagree on it. Status is `human_needed`: decision tree rule 1 does not fire (no truth FAILED), and the owner items and the four live proofs are open. HARD-H2 remains ORPHANED.

Changed since a46d42c3: the reconcile sources, the scheduled timer block and the counter-cut digest code are unchanged in logic. Line anchors moved for `cache.ts` (scanKeys and unlinkKeys), `reconcile-read.ts`, `corpus/reconcile.ts`, `index-store.ts` and `index.ts`; each is re-cited above. The cooldown refusal (f1266a9c) changed the error class on the shared guard, with the same message and no test on the reconcile path. The reportSilent calls (e62bc17b) add stderr lines only.

If the owner decides the unreadable-plan path must write `<plan>.result.json`, that is a code change in a covered file. It would need a test that asserts the file on that path, and truth 7 would need re-verification. This pass made no such change.

Still open: the four live proofs; HARD-H2's status in REQUIREMENTS.md (orchestrator); the unreadable-plan audit gap (owner); the node_id straddle in graph_register and graph_claim (owner); the pre-existing 512-unit identity item (owner); the stale ROADMAP status text (orchestrator); the r39 gate result (pending).

---

_Verified: 2026-11-06T02:58:51Z_
_Verifier: Claude (gsd-verifier, re-verification pass; draft at backups/records/r39)_
