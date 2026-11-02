---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T16:01:46Z
status: human_needed
score: 2/2 must-haves verified in code; 4 live proofs human_needed
tree: /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 7382ad10
criteria_source: origin/main .planning/ROADMAP.md, Phase 78 section (criteria text identical to this tree's ROADMAP)
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
covered_digest: "v3:sha256:6fe00755b7a2c274bf4208c67e58c6652d9ef66b05d70570e0221a2187d66cd7"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md on branch gsd/v18-p78-reconcile (seventh pass, HEAD 0d896577), status human_needed, 2/2"
  reason: "Re-verification on the integration tree. This tree carries commit 634b6171 (live-session facade built on first use; settle() in wall time) and the merged 71/72/74/77 work, so service.ts line numbers moved: the reconcile block is now service.ts:4011-4058 (was 3810-3854). Every citation below is re-read on this tree."
  gaps_closed:
    - "docs/reconcile.md:26 now says the scheduled line carries unchecked_layers (the previous WARNING 1). Commit c1367953 is on this tree."
  gaps_remaining:
    - "WARNING 1: the repair result sets listed (plan item count) against repaired (keys removed), so the two are in different units (reconcile-repair.ts:139, :192-196, :51)."
    - "WARNING 2: the flush removes every answer, counter and the mark under substrate:v1:*, not only the keys of the orphan graphs the plan names (reconcile-repair.ts:15, :94, :212-220). Recorded as D78-5; kept open."
    - "WARNING 3: no tick test runs a cache-off fixture; the cache-off line is covered by runReport test reconcile-read.test.ts:391 only."
    - "Live-only checks: interval firing and single-flight, Dragonfly SCAN and UNLINK at production counts, GreptimeDB queryEvents in a busy window, and a live CLI run."
  regressions: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval cadence is real-time and no test fires the interval. The single-flight guard (service.ts:4031-4036, reconcilePass ??=) has no test. The tick body is covered by service.test.ts:5786"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run), then repair --plan <file> --execute --server-stopped"
    expected: "The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps budget: and emb: keys. A prefix above 1000000 keys refuses with nothing removed. <plan>.result.json shows repaired against listed"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores: report; repair --plan <file> --execute without --server-stopped; a dry run; repair --plan <file> --execute --server-stopped"
    expected: "Exit codes match docs/reconcile.md: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing --server-stopped exits 2 before any connection. The result file holds executed, refused, repaired, listed and error"
    why_human: "Needs live PG, GreptimeDB and Dragonfly"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T16:01:46Z
**Status:** human_needed
**Scope:** the integration tree at `7382ad10`. Procedure: gsd-verifier, goal-backward. Criteria: origin/main ROADMAP Phase 78 (two success criteria, verbatim in 78-CONTEXT.md). Live proofs are operator items and stay human_needed.

## Criteria and conflicts

- Criteria text in this tree's ROADMAP and origin/main are identical. The status lines differ: origin/main says `Not started` and `Plans: none written`; this tree's uncommitted ROADMAP says `human_needed`. The phase directory holds a plan and a summary, so the origin/main status is stale. Reported; not chosen.
- 78-CONTEXT.md D78-6 names the plan record `{schema, created_at, window, report_digest, items}`. The code writes `window_hours` (reconcile-repair.ts:39-45). Deviation in naming only; not a criterion failure.
- 78-CONTEXT.md D78-5 specifies a whole-prefix delete. The code runs three ordered passes. The amendment is recorded in STATE.md Run 17 and 78-SUMMARY.md, and CONTEXT is not edited. Judged as the recorded design, see Open decisions.

## Must-haves

| # | Criterion (origin/main) | Verdict | Evidence on this tree |
| - | ----------------------- | ------- | --------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code; live cadence human_needed | Counts: reconcile-run.ts:55-90 (ledger 56, 60; index 64, 75, 80; cache 93-94). First key: reconcile.ts:193-194 and :205-209. Scheduled line: service.ts:4053-4054 carries `schema`, `generated_at`, `clean`, `counts`, `truncated`, `unchecked_layers`, `first`. Writes: the tick writes only its stdout line (service.ts:4054); the only stderr writes are the skip and failure lines (:4041, :4056). Timer: `startReconcile` service.ts:4014-4022 (`setInterval` :4017, `unref` :4018), off at 0 (config.ts:1619). Single flight: service.ts:4031-4036. Started from startup via `startRecall` (index.ts:196, service.ts:4000) and stopped in `stopRecall` (index.ts:234, service.ts:4006) |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | VERIFIED in code, with WARNINGs 1 and 2 | Separate step: `plan` writes only its `--out` file with flag `wx` (reconcile-main.ts:187-193, :190). `repair` without `--execute` is a dry run that writes nothing (reconcile-repair.ts:167-176). `--execute` without `--server-stopped` is a usage error, exit 2, before config or any client (reconcile-main.ts:93-94, :150-158). Refused without the flag before any removal (reconcile-repair.ts:177-186). Plan record: `planFromReport` reconcile-repair.ts:86-106 (schema :100, `report_digest` :103); `parsePlan` reconcile-main.ts:130-138. Digest recheck :141-150, orphan recheck :151-161, plan gating `planRefusal` :112-123 and call :162-165. Corpus analogues, from origin/main ROADMAP phase 63 criteria 2 and 5 and the corpus code: dry run until `--execute` (packages/corpus/src/protocol.ts:264-267); a tombstone or delete only when the scan covered the whole scope, and a truncated scan removes nothing (reconcile-repair.ts:199-209 refuses on a truncated scan; corpus criterion 5); removals ordered before inserts (corpus `ingest.ts:136-156`, answers before counters at reconcile-repair.ts:218-220). `<plan>.result.json` is written after every execute (reconcile-main.ts:212-220) |

Must-haves: 2 of 2 verified in code. No truth FAILED. Human items are non-empty, so status is `human_needed`.

## Sub-checks, by test (run this pass; see Targeted tests)

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Scheduled tick on a clean fixture logs one clean line and writes nothing | PASS | service.test.ts:5786 (2 pass with 5775 in the describe block). Read-only proxies record any non-read call (5789-5798). The live cache scan is empty and complete, so the run is clean, not off |
| Interval 0 starts no timer; 60 starts one; stop clears it | PASS | service.test.ts:5775-5784 |
| Dirty fixture reports the first mismatching key per comparison | PASS | reconcile-read.test.ts:362 |
| Clean fixture is clean, `unchecked_layers` empty, nothing written | PASS | reconcile-read.test.ts:343 |
| Cache off: layer unchecked, absent from counts, classes truncated, run not clean | PASS | reconcile-read.test.ts:391; reconcile.test.ts:188 |
| Lease identity only (surface, session, epoch) | PASS by reading | reconcile.ts:82-119 compares `surface`, `session_id`, `epoch` only |
| A newest release frees the key even when an older grant exists | PASS | reconcile-read.test.ts:236; reader keeps newest, reconcile-read.ts:171-178 |
| A hold granted before the window is found by node, with no time bound | PASS | reconcile-read.test.ts:222; reconcile-run.ts:67-72 |
| A lookup past its cap or running out of rows is truncated, so the run is not clean | Code read; NOT RUN this pass | reconcile-read.test.ts:231 and :246 are not in the targeted filter. Reader at reconcile-read.ts:161-186 (truncation at :162, :184) |
| A capped cache scan is unclean | PASS | reconcile-read.test.ts:381; cache.ts:1071-1078 |
| Dry run writes nothing; digest mismatch refuses; other-match plan item refuses | PASS | reconcile-repair.test.ts:106, :116, :288 (run this pass). Orphan-gone (:130) and other-action (:300) are NOT in the filter and were NOT run this pass; code read at reconcile-repair.ts:151-161 and :112-123 |

Note: only the rows marked PASS were run this pass. Rows marked NOT RUN have code evidence and no test result on this tree. Nothing in them is reported as a test pass.

## Repair sub-checks

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Execute removes answers, then counters, then the mark; budget and emb untouched | PASS | reconcile-repair.test.ts:157 ("execute removes answers, then counters, then the forget mark, and only those"); groups :212-217 |
| Second execute is a no-op | PASS | reconcile-repair.test.ts:176 |
| Truncated scan removes nothing | PASS | reconcile-repair.test.ts:188; :199-209 |
| Failure in the answer pass, counter pass or mark pass keeps the later keys in place | PASS | reconcile-repair.test.ts:209, :228, :250 |
| Failed batch keeps the count of earlier batches; failing scan reports the failure | PASS | reconcile-repair.test.ts:330, :351; cache.ts:1087-1102 |
| Execute without `--server-stopped` refuses and removes nothing | PASS | reconcile-repair.test.ts:270; reconcile-main.test.ts:104 (exit 2, no client) |
| `--server-stopped` with another command exits 2 | PASS | reconcile-main.test.ts:113 |
| Failed flush exits 1 and writes the result file with the error | PASS | reconcile-main.test.ts:52; reconcile-main.ts:212-224 |
| The only destructive call on this path is `unlinkKeys` | PASS by reading | The only caller is reconcile-repair.ts:193, reached after the server-stopped gate (:177-186). `runReport` and the readers call `queryEvents`, index SELECTs and `scanKeys` only (reconcile-run.ts header; reconcile-read.ts:105, :165; index-store.ts:2924-2981; cache.ts:1061-1079) |

## Known-defect check (cache off makes the report read clean)

Not reproduced on this tree.

- `scanKeys` returns `{keys: [], truncated: true}` when the cache is off (cache.ts:1064).
- `runReport` detects an off cache when every class scan and the generation scan is empty and truncated (reconcile-run.ts:91). A live empty scan is never truncated, because a truncated live scan holds keys past its cap (cache.ts:1071-1078).
- The counts guard omits every `cache.*` count when off (reconcile-run.ts:93-96). `uncheckedLayers` names `cache` (:97) and reaches the report (:112). `buildReport` is unclean while any `truncated` flag is set (reconcile.ts:210).
- The CLI refuses a cache-off config before reading (reconcile-main.ts:106, :163-167).

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile.ts` | VERIFIED | Comparators :82-174; `buildReport` :186-212 |
| `packages/mcp-server/src/reconcile-run.ts` | VERIFIED | `runReport` :49-115; caps :32 |
| `packages/mcp-server/src/reconcile-read.ts` | VERIFIED | Ledger readers :135-206; index readers :212-241; latest-lease lookup :157-188 |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED | Plan :86-106; gating :112-123; execute :134-235 |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED | Args :55-98; `missingConfig` :101-108; `reconcileMain` :144-232 |
| `packages/mcp-server/src/service.ts` | VERIFIED | Timer :4011-4022; stop :4024-4028; tick :4030-4036; run :4038-4058 |
| `packages/mcp-server/src/cache.ts` | VERIFIED | `scanKeys` :1056-1079; `unlinkKeys` :1081-1102 |
| `packages/mcp-server/src/index-store.ts` | VERIFIED | Reconcile SELECTs only :2920-2981 |
| `packages/mcp-server/src/config.ts` | VERIFIED | `loadReconcileSettings` :1615-1621 |
| `scripts/reconcile.ts` | VERIFIED | Thin wrapper, explicit exit (:9-14). `package.json:44` script `reconcile` |
| `docs/reconcile.md` | VERIFIED | Line 26 now names `unchecked_layers` on the scheduled line (the earlier WARNING is closed) |
| Test files | VERIFIED | Named tests in the targeted runs below |

## Key links

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, exit with the code | WIRED |
| `reconcileMain` | `parseReconcileArgs` | before `loadConfig` (reconcile-main.ts:150, :158) | WIRED |
| `reconcileMain` (repair) | `executePlan` | with `serverStopped` (reconcile-main.ts:204) | WIRED |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (reconcile-repair.ts:190-197) | WIRED |
| `executePlan` | `runReport` | re-run before any write (reconcile-repair.ts:140) | WIRED |
| `startRecall` | `startReconcile` | service.ts:4000, called from index.ts:196 | WIRED |
| `stopRecall` | `stopReconcile` | service.ts:4006, called from index.ts:234 | WIRED |
| `startReconcile` | `reconcileTick` | `setInterval` (service.ts:4017) | WIRED; interval firing untested |
| `reconcileTick` | `runScheduledReconcile` | single flight (service.ts:4031-4036) | WIRED; single flight untested |
| `runScheduledReconcile` | `runReport` | `DEFAULT_RECONCILE_CAPS` (service.ts:4045-4052) | WIRED |
| `runReport` | `cache.scanKeys` | class and generation scans (reconcile-run.ts:86-90) | WIRED |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents`, index SELECTs and cache SCANs (reconcile-run.ts:55-90). Off cache renders no count. The flush reads the live `substrate:v1:*` keys and removes only those it classifies (reconcile-repair.ts:198-220). No hardcoded result feeds these values.

## Integration facts judged on this tree

- **Lazy live-session facade (634b6171).** The scheduled-tick test depends on it. The test's index is a read-only proxy that records and throws on any non-read property (service.test.ts:5789-5798). The pre-fix constructor called `this.index?.liveSessions(...)` (`git show 634b6171^:packages/mcp-server/src/service.ts`, line 1879), which would reach the proxy and throw. The fix moves that read to first use (service.ts:1654-1659, :1886-1888). The reconcile path never reads `liveSessions`, so the change is neutral to the reconcile. Judged: the test passes on this tree; the change is a production-code change made to satisfy a test, and the owner should know it.
- **`settle()` wall-clock change (634b6171).** Not used by any phase 78 test. No effect on this phase.

## Targeted tests (run this pass)

Each command ran once, serially, with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, with `SUBSTRATE_TEST_PG_URL` unset, from `packages/mcp-server`. No Postgres. Three commands in total.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test service.test.ts -t "scheduled reconcile timer"` | 2 pass, 332 filtered out, 0 fail, 9 expect calls. Covers service.test.ts:5775 and :5786 |
| 2 | `bun test reconcile.test.ts reconcile-read.test.ts reconcile-repair.test.ts reconcile-main.test.ts -t "a dirty fixture reports the first mismatching key|a clean fixture reports clean|with the cache off|unchecked layers are reported|a capped cache scan makes|first is the first finding|a newest release frees|a hold granted before the window|execute removes answers|a second execute|a failure in the answer pass|a failure in the counter pass|a failure in the mark pass|a dry run writes nothing|a scan that cannot be completed|a digest mismatch|execute without the server stopped|a plan item that names another match|a flush that fails after one batch|a scan that fails removes nothing|a failed flush exits 1|execute without --server-stopped|--server-stopped with a command|report with no configured index|an unknown subcommand"` | 26 pass, 66 filtered out, 0 fail, 129 expect calls |
| 3 | `bun test config.test.ts -t "SUBSTRATE_RECONCILE"` | 9 pass, 96 filtered out, 0 fail, 36 expect calls |

Totals: 37 pass, 0 fail. No PG-gated test was in these filters, so nothing skipped for want of Postgres.

Not run this pass: the full suite, tsc, lint, formatters, and the gate. Gate evidence from the brief: the full gate on this tree is green (`/root/src/worktrees/backups/gates-int-r5.log`). Not re-read here.

## Warnings (non-blocking)

1. **Repair result units differ.** `listed` is `plan.items.length` (reconcile-repair.ts:139, reported at :51), which is 1 for any repair with orphans. `repaired` counts keys removed (:192-196). D78-6 and the result file ask for `repaired` against `listed`, but the two are in different units, so the file cannot show that every listed item was removed. Owner decision: count the listed items by the keys the dry run would remove, or accept the mismatch. Human item 2 expects this comparison; it reads as a count pair, not as a verdict.
2. **Flush scope is the whole prefix.** The plan names `match: substrate:v1:*` and the orphans (reconcile-repair.ts:91-97). The flush selects by class, not by the orphan graph (:212-217). Answer keys carry no graph id (D78-5), so this is the recorded design, not a defect. Under the corpus reading "act only on what the plan names", it is a deliberate divergence. Kept open; see Open decisions.
3. **No tick test runs a cache-off fixture.** The cache-off line is covered by runReport (reconcile-read.test.ts:391), and the scheduled line copies `unchecked_layers` (service.ts:4053). Low risk, since the line copies the report field.
4. **Advisory: index read cost.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a 500-key batch and filters in JS (index-store.ts:2924-2933). Correct, but O(rows of those graphs). H5 covers scan cost; this is the index-side analogue [INFERENCE from the SQL; not measured].
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report.** A truncated report can still produce a plan (reconcile-run.ts:88-90). The flush is fail-closed on its own 1000000-key scan (reconcile-repair.ts:198-209). Recorded as D78-6 reading.

## Open decisions (kept open)

- **Cache layer reported as unchecked, not zero.** Recorded: 78-SUMMARY.md "Decisions carried from the context" (decided in 0d896577, delegated by the owner); STATE.md Run 17 owner decision (2). The code matches the decision (reconcile-run.ts:91-97). This pass checked that the code does what is recorded, not that the choice is right. Stays open for the owner.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; docs/reconcile.md:67; STATE.md Run 17 owner decision (3). The report's memory check is the ledger-to-index window comparison (reconcile-run.ts:59-61, :74-77; compareMemory reconcile.ts:129-153). Stays open for the owner.
- **Whole-prefix flush and the ordered three passes (D78-5, amended in ee1c9534).** Recorded in STATE.md Run 17 and 78-SUMMARY.md. Warning 2 above. Stays open for the owner to ratify.
- **`--server-stopped` as an operator assertion (D78-6, amended).** The code cannot check the server is stopped (reconcile-main.ts:93-94; reconcile-repair.ts:177-186). Same convention as `consistency-run`. Stays open.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard (service.ts:4031-4036) have no test.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts: `repair --plan <file>` (dry run), then `repair --plan <file> --execute --server-stopped`. Expected as in the frontmatter. Why human: H5 cost and behaviour at scale.
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores.** Expected: exit codes per docs/reconcile.md; missing `--server-stopped` exits 2 before any connection; the result file holds `executed`, `refused`, `repaired`, `listed`, `error`. Why human: needs live PG, GreptimeDB and Dragonfly.

## Gaps Summary

**Blocking gaps: none.** Both criteria are met in code on this tree, and every test row marked PASS passed in the targeted runs. No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED. A line-by-line debt-marker grep (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) over the phase's added lines in the reconcile files, service.ts, cache.ts, index-store.ts, config.ts and scripts/reconcile.ts found nothing.

**Status:** `human_needed`, from the four human items. Warnings 1 to 5 do not change the status.

## Summary claims checked (78-SUMMARY.md)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| Lease comparison is identity only | TRUE | reconcile.ts:82-119 |
| Memory compared both ways over the window | TRUE | reconcile.ts:129-153 |
| Generation orphans compare `gen:graph:<id>` with `graph_index` | TRUE | reconcile.ts:162-174; reconcile-run.ts:89-103 |
| Caps `ledgerRows` 500, `ledgerLookups` 200, `indexRows` 5000, `cacheKeys` 10000 | TRUE | reconcile-run.ts:32 |
| Cache off: layer listed in `unchecked_layers`, counts omitted, classes truncated, never clean | TRUE | reconcile-run.ts:91-97, :112; reconcile-read.test.ts:391 |
| `scanKeys` reports `truncated` when off; `unlinkKeys(keys, onBatch?)` | TRUE | cache.ts:1064; cache.ts:1087 |
| Timer off by default; each tick one read-only report and one line with `counts`, `truncated`, `unchecked_layers`, `first`, `clean` | TRUE | service.ts:4017-4018; config.ts:1619; service.ts:4053-4054 |
| Flush: `substrate:v1:*` scanned once, refused when incomplete, three ordered passes, budget and emb never removed | TRUE | reconcile-repair.ts:15, :18, :21-28, :198-220 |
| Execute needs `--server-stopped`; dry run is default | TRUE | reconcile-main.ts:93-94; reconcile-repair.ts:167-186 |
| Tick test exists and passes | TRUE | service.test.ts:5786; run 1 |
| The scheduled-line doc correction is in | TRUE | docs/reconcile.md:26 |
| "Gate runs were voided once by a full root filesystem" | Not checked; no artifact read | [INFERENCE] from the summary text |
| Gate results (11506 pass, 2 skip, 0 fail) | Not re-run this pass | Brief |

---

_Verified: 2026-11-02T16:01:46Z_
_Verifier: Claude (gsd-verifier, integration re-verification)_
