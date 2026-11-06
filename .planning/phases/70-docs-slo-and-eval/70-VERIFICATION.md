---
phase: 70-docs-slo-and-eval
verified: 2026-11-06T00:42:30Z
status: human_needed
score: 4/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:3af0e84cbb7dc3dedc82223c2b4591fa4a2c36be51643504d07320301bd71359"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5 must-haves verified
  gaps_closed: ["W-1 (commit 884e0753): the sync-lag series follows the same note reading as fabric_status, for stored, held and dead-lettered notes, REST or MCP. Still closed at HEAD a46d42c3; no code in the SC3 emit path changed since."]
  gaps_remaining: []
  regressions: []
  digest_refresh: "covered_digest unchanged from the prior record (v3:sha256:3af0e84c...). No covered file changed between 884e0753 and a46d42c3: git diff 884e0753..a46d42c3 over the 23 covered files is empty."
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
warnings: []
human_verification:
  - test: "Criterion 5 clause 2 on a live plane: on a host with SUBSTRATE_CORPUS=on and the LightRAG backend, ingest this checkout's docs/ under SUBSTRATE_DOCS_EVAL_REPO, then run substrate corpus eval --root /root/src/repos --server \"$SUBSTRATE_URL\" --json."
    expected: "The runbook question and its heading questions are scored; the runbook's key is in the top 5."
    why_human: "Needs a live plane and a real ingest. Nothing in code asserts it."
  - test: "Canary install and first run (operator gate; the timer is staged, not installed)."
    expected: "Journal line golden recall@5 <value> over <n> questions, exit 0, and fabric_status corpus row shows recall5.reading."
    why_human: "Host install and a secret-bearing env file; not in this repository."
  - test: "Live sync-lag reading on a live plane: a real docs.sync note reaches the server, then fabric_status corpus row and GET /slo/history corpus.sync_lag_seconds are read."
    expected: "The row's syncLag reading equals the note's lag_s (rounded), and the series point matches it. A breach is named sync when SUBSTRATE_DOCS_SLO_SYNC_LAG_S is set and exceeded."
    why_human: "Only tests and code have exercised this path. No live run was made."
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-06T00:42:30Z
**Status:** human_needed
**Re-verification:** Yes. HEAD a46d42c3 (prior record at 884e0753, human_needed, 4/5). The covered files are unchanged since 884e0753, so SC1, SC2, SC4 and the covered-file parts of SC3 carry forward. The out-of-list files on the SC3 path were re-audited at HEAD: `service.ts` emit-site reporting (f0f3c04e and later), `observe.ts`, `server.ts`, `docs-freshness.ts`. Anchors that moved are updated below. W-1 stays closed. The operator items stay open.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, HEAD `a46d42c3`, clean at check time.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block). The SC3 text is the amended one (`Amended 2026-11-05 by owner decision: fabric_status is the contract for sync lag and the canary judges recall only`). No PLAN files exist for this phase.
- Covered-file fingerprint: `gsd_run query verification.fingerprint .planning/phases/70-docs-slo-and-eval <23 covered files>` at a46d42c3 gives `v3:sha256:3af0e84c...`, the same digest as the prior record. The `covered_files` list is the prior record's list, verbatim.
- Test evidence: gate r36 JUnit `/root/src/worktrees/backups/gate-r36-junit.xml` (12,317 testcases, 0 failures, 0 errors, 2 skipped). The skipped ones are `redact.test.ts` "D-04 fixtures do not survive the write path while counts do" and `cache-conformance.test.ts` (live loopback redis unset). Neither is in SC3. `/root/src/worktrees/backups/gates-int-r36.log` line 5 records `head=a46d42c3`, so the r36 run was at HEAD.
- A cited test title counts here only if the JUnit has it as a `testcase` with no `failure`, `error` or `skipped` child. Describe names are cited for location only. Every title below was checked by a script against the JUnit.
- Commands run in this record (read-only): `git log`, `git diff`, `git show`, `grep`, `sed`, a read-only parse of the JUnit, the fingerprint query, `date -u`. No tests, `tsc`, lint, formatters, PG, docker or databases were run. The prior record's T-A and T-B reruns at 884e0753 are not repeated and are not cited as evidence here.
- Postgres: none. None of the SC3 test files references `SUBSTRATE_TEST_PG_URL`.

## Changes since 884e0753, checked against the phase

Commits after 884e0753: `aef8a351` and `b1bb49f2` (records only), and code commits `e3914640`, `e958e8b1`, `885e73ce`, `7a1d923a`, `c371cece`, `f0f3c04e`, `9b793653`, `a46d42c3`. None of them changes a covered file.

1. **Emit seam and observer hook: unchanged.** `git diff 884e0753..a46d42c3 -- packages/mcp-server/src/service.ts` has no hunk in the sync-lag block or the observer interface. The block is now at `service.ts` l.3016 to 3018 (`if (result.stored || result.buffered === true || result.deadLettered === true)` at l.3016, `recordSyncLag` at l.3017, `this.observer.syncLag?.({ seconds })` at l.3018). The prior record cited l.3008 to 3010. The observer hook `syncLag?` is at l.1061. The only hunk near the emit is `publishHint` (l.3033), which runs after the sync-lag block and is changed only in how its failure is reported.
2. **Emit-site reporting (f0f3c04e), `service.ts`.** There are 27 `reportSilent(...)` call sites in `service.ts` (l.2253, 2284, 3033, 3500, 3531, 3606, 4902, 5032, 5047, 5056, 5102, 5216, 5272, 5328, 5433, 5514, 5532, 5652, 5761, 5846, 6130, 6142, 6187, 6202, 6927, 7625, 7787). `reportSilent` is introduced by f0f3c04e. Each replaces a `.catch(() => …)` or a `then` rejection handler. The replaced expression and its replacement return the same value: `undefined` for `.catch(() => undefined)`, `null` for `.catch(() => null)`, `false` for the steering `then` handler and the old `publishHint` `.catch(() => false)` (its value is discarded by `void`), and the same `ForwardOutcome` value for the Hindsight forward. `reportSilent` writes one stderr line per site per process, with the site name and a short code, and never the message text (`silent-failures.ts`). It does not throw and does not change the return value of `emit`. The one control-flow change is `trackRetain` (l.3874), which now handles the rejection with `task.then(settle, settle)` instead of `task.finally(...)`. This removes an unhandled rejection and leaves the pending count as it was.
3. **Reply replay.** `emit` returns early for a deduplicated replay at l.2995 to 2996, before the sync-lag block. A replayed `docs.sync` note therefore moves neither the reading nor the series. The two still agree.
4. **Other changed files on the SC3 path.** `observe.ts` (f0f3c04e): `claim.withdrawal` now has a `.catch` that calls `reportSilent`. The `syncLag` mapping at l.399 to 400 is unchanged. `server.ts`: the gauge block is still absent (`grep` finds no `setCorpusSyncLag`, `recordSyncLag` or `syncLagSeconds`), and `POST /events` still calls `substrate.emit` at l.1358 (route at l.1304). None of the five `server.ts` hunks since 884e0753 changes a line that mentions events, emit, sync or gauge. `docs-freshness.ts` (a46d42c3): the two unused constants `DEFAULT_FRESHNESS_MAX_AGE_H` and `DEFAULT_TRIGGER_LAG_MIN` were deleted. `grep` finds no reference to either. `corpusFreshnessRow` (l.169 to 182) and its `sync_lag` breach are unchanged.
5. **Test files on the SC3 path.** `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `fabric/status.test.ts`, `metrics-history.test.ts`, `packages/corpus/src/slo.test.ts`, `docs-freshness.test.ts`, `event-idempotency.test.ts` and `scripts/dashboards.test.ts` are unchanged since 884e0753 (`git diff --stat` empty). `service-event-buffer.test.ts` gained one test in 7a1d923a (the shutdown stderr test, below). The held-note test at l.115 is unchanged.
6. **Corpus SLO test names.** Every title in the SC3 test files is in the r36 JUnit as a clean testcase. The check covered `corpus/slo.test.ts` (27 titles), `packages/corpus/src/slo.test.ts` (13), `corpus/sync-event.test.ts` (6), `service-event-buffer.test.ts` (19), `fabric/status.test.ts` (28), `metrics-history.test.ts` (54), `docs-freshness.test.ts` (48), `event-idempotency.test.ts` (43), `scripts/dashboards.test.ts` (21), `scripts/docs-eval.test.ts` (33), `scripts/docs-lint.test.ts` (23) and `scripts/planning-integrity.test.ts` (16). Result: 0 titles missing, 0 not clean.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Covered files `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts`, `scripts/docs-eval.test.ts` have no diff since 884e0753. `scripts/docs-eval.test.ts` is 33 testcases, 0 failures, 0 errors in r36. Wording note: the live flag is `--live URL`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged; `scripts/docs-eval.test.ts` 33 testcases, 0 failures in r36. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED (code and tests; W-1 closed) | Clause by clause, against the amended text, below. The series follows the same note reading as `fabric_status`, for REST, MCP, stored, held and dead-lettered notes. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 884e0753. r36: `docs-lint` 23 testcases and `planning-integrity` 16 testcases, 0 failures. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (operator-gated) | The runbook is unchanged since 884e0753. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. |

**Score:** 4/5 must-haves verified (SC1, SC2, SC3, SC4). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### SC3 clause by clause (amended text)

| Clause | Evidence (anchors at a46d42c3) | Status |
| --- | --- | --- |
| (a) Sync lag is a metric series | `corpus.sync_lag_seconds`: `packages/mcp-server/src/metrics-history.ts` l.166 (extended tier, max per step) and l.421 (gauge source); gauge `setCorpusSyncLag` in `packages/observability/src/instruments.ts` l.679, metric l.734. Testcase "the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none" (`metrics-history.test.ts` l.1086, JUnit classname "the extended series (uplift-5 S6)"). | ✓ VERIFIED |
| (a) Threshold in a flag | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`: `packages/corpus/src/slo.ts` l.49 (`loadSloThresholds`, whole number of 1 or more, no default); flag entry `packages/mcp-server/src/flag-registry.ts` l.898. `flag-registry.test.ts` 26 testcases, 0 failures in r36. | ✓ VERIFIED |
| (a) Series and reading agree for every note the server takes | Single path. `service.ts` `emit` l.3016 to 3018: `stored`, `buffered` or `deadLettered` calls `corpusSlo.recordSyncLag` (l.3017), then `observer.syncLag` (l.3018). `observe.ts` l.399 to 400 is the only production caller of `setCorpusSyncLag`. REST: `server.ts` `POST /events` calls `substrate.emit` (l.1358); the gauge block is gone. MCP: `mcp.ts` l.1191 calls `substrate.emit`. | ✓ VERIFIED |
| (a) REST stored note sets the series | Testcase "a stored sync note sets the gauge to its lag, and the newest one wins" (`corpus/sync-event.test.ts`, describe "POST /events with a docs.sync note"). | ✓ VERIFIED (JUnit clean) |
| (a) MCP stored note sets the series | Testcase "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`corpus/sync-event.test.ts`). | ✓ VERIFIED (JUnit clean) |
| (a) Held note sets the reading and the series path | Testcase "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts` l.115). The test asserts `readings.syncLagS` is 4000 at buffer time, the observer hook records `[4000]`, and after the drain the reading is still 4000 and the hook has still been called once. | ✓ VERIFIED (JUnit clean; body read at a46d42c3) |
| (a) Held note reaches the gauge value | The test pins the observer hook with a test observer. The hook-to-gauge mapping is `observe.ts` l.399 to 400, the mapping the REST and MCP tests exercise. No test reads the gauge value for a held note end to end. | ✓ VERIFIED by code and test together (residual, Open item 8) |
| (a) Dead-lettered note sets the reading and the series path | Same `if` as held (`service.ts` l.3016). The dead-letter results come from `service.ts` l.3171 and l.3255. No test names a dead-lettered `docs.sync` note. | ✓ VERIFIED by reading; not exercised by a test |
| (a) A note the server did not take leaves the series | REST refused case: `POST /events` answers 503 and the gauge stays null. Testcase "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" (`corpus/sync-event.test.ts`). Code: a refused note has neither `stored`, `buffered` nor `deadLettered`, so the `if` at `service.ts` l.3016 does not run. | ✓ VERIFIED |
| (b) `fabric_status` reports a breach | `packages/mcp-server/src/fabric/status.ts` `corpusRow` (l.75 onward): `enabled` at l.78; `syncLag` in `detail` at l.84; breach `sync` in `breaches`; row `degraded` with `source: "corpus.slo: breached ..."`. Unset: shown with no verdict. Testcases "a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not" (l.76) and "unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null" (l.92), both in `fabric/status.test.ts` (describe "the corpus row (phase 70)"). | ✓ VERIFIED |
| (b) Breach and threshold read in the objective module | `packages/corpus/src/slo.ts` `loadSloThresholds` (l.48 to 49) and `sloBreaches` (l.59 to 65). Testcases in `packages/corpus/src/slo.test.ts`, describe "the sync lag objective": "breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches" (l.92) and "is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down" (l.83). | ✓ VERIFIED |
| (b) Freshness warning names the sync breach | `packages/mcp-server/src/docs-freshness.ts` `corpusFreshnessRow` (l.169 to 182) adds `sync_lag`; `service.ts` `corpusFreshness` (l.7560 to 7566) passes `corpusSlo.readings(now).syncLagS`. Testcase "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not" (`docs-freshness.test.ts`, JUnit clean). | ✓ VERIFIED |
| (c) Canary judges recall only | `scripts/docs-golden.ts` has no reference to a sync reading or lag (the case-insensitive `sync` hits are `readFileSync`, `renameSync`, `writeFileSync`, `statSync`, `readdirSync`). It posts `golden_recall5` only (`packages/mcp-server/src/corpus/slo.ts` `recordGolden`). Testcases "sets the golden recall reading and gauge, and a payload that is not a recall changes nothing" (`corpus/slo.test.ts` l.311) and "only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored" (l.322), describe "a stored docs.canary report". | ✓ VERIFIED |
| (d) Staged canary timer runs `docs-eval` | `infra/vps/substrate-docs-canary.service` l.33: `ExecStart=... scripts/docs-golden.ts --live --emit`. `scripts/docs-golden.ts` l.62 and l.731 import and call `measureGoldenRecall` from `docs-eval.ts`. Unchanged. See Open item 7. | ✓ VERIFIED (through the shared import) |
| (e) Dashboards draw it, regenerated | Panel "Corpus sync lag" at `infra/vps/dashboards/substrate-data-planes.json` l.2890, series `corpus.sync_lag_seconds`, from `scripts/dashboards.ts` l.310. Testcase "`--check` passes on the committed files: nothing is missing, stale or unexpected" (`scripts/dashboards.test.ts`, classname "the committed dashboards are what the generator renders", clean in r36). The `dashboards: drift` lines in `gates-int-r36.log` (l.1651, 1654) are stdout from the drift-case testcases, not a gate failure; the suite is 21 testcases, 0 failures. | ✓ VERIFIED (testcase clean in r36) |

### W-1 (closed at 884e0753, still closed at a46d42c3)

The prior record found that `corpus.sync_lag_seconds` was set only from the REST route, for a stored note, while `fabric_status` took held and dead-lettered notes at buffer time. Commit `884e0753` resolves this at the emit seam:

- Option chosen: mirror the reading condition at emit, and not the REST-only widening. `Substrate.emit` owns the decision for every route, so REST, MCP and held notes reach the gauge the same way. The REST gauge block in `server.ts` is removed.
- Held notes: the reading is set at buffer time through `recordSyncLag`, and the series is set at the same point through the `syncLag` hook. The drain does not call the hook again, and the held test pins that.
- Docs describe the code as it is: `docs/corpus-eval.md` l.103 and l.105, `docs/runbooks/docs-rag-operations.md` l.146. These are covered files and unchanged.
- Since 884e0753 the emit path has not changed. The emit-site reporting changes in f0f3c04e and later (above) do not touch the sync-lag branch or the hook.
- Residual, not a blocker: see Open item 8.

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 owns the docs.freshness route and is cited as evidence for SC3 (b), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold (l.49); `sloBreaches` `sync` breach (l.65); unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag` (l.68 to 76) returns the recorded lag or null. `readings().syncLagS`. Covered, unchanged since 884e0753. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail (l.84); breach named `sync`. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step (l.166); gauge source (l.421). |
| `packages/observability/src/instruments.ts` | `setCorpusSyncLag` | ✓ VERIFIED | One unlabelled gauge; non-finite and negative dropped. |
| `packages/mcp-server/src/service.ts` | emit seam, observer hook, reporting | ✓ VERIFIED | `emit` l.3016 to 3018; observer hook `syncLag?` l.1061. Not a covered file; re-audited at a46d42c3 (Changes item 1 to 3). |
| `packages/mcp-server/src/observe.ts` | production observer maps `syncLag` to the gauge | ✓ VERIFIED | l.399 to 400. Not a covered file; re-audited at a46d42c3. |
| `packages/mcp-server/src/server.ts` | REST route | ✓ VERIFIED | Gauge block and import absent; `POST /events` calls `substrate.emit` (l.1358). Not a covered file. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` l.169 to 182 adds `sync_lag`. Not a covered file. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Reads `recall5` only; no sync reading. Covered, unchanged. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED | Staged, not installed (operator step). `ExecStart` is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898). `flag-registry.test.ts` 26 testcases, 0 failures in r36. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel, regenerated | ✓ VERIFIED | Panel at json l.2890; `--check` testcase clean in r36. Not in the covered list. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` (l.3016 to 3018) | `corpus/slo.ts` `recordSyncLag` | stored, buffered or dead-lettered `docs.sync` note | ✓ WIRED |
| `service.ts` `emit` (l.3018) | `observe.ts` `syncLag` to `instruments.setCorpusSyncLag` | observer hook, production observer | ✓ WIRED |
| `server.ts` `POST /events` (l.1358) | `service.ts` `emit` | `substrate.emit` (REST) | ✓ WIRED |
| `mcp.ts` `events_emit` (l.1191) | `service.ts` `emit` | `substrate.emit` (MCP) | ✓ WIRED |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` (l.7560 to 7566) | `docs-freshness.ts` `corpusFreshnessRow` | `docsSlo.syncLagS` and the corpus sync reading | ✓ WIRED |
| `docs-golden.ts` | `docs-eval.ts` `measureGoldenRecall` | import | ✓ WIRED |

### Test titles relied on

Each title is a testcase in `/root/src/worktrees/backups/gate-r36-junit.xml` with no failure, error or skipped child.

| Title | JUnit file | Classname (describe) |
| --- | --- | --- |
| the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place | `packages/mcp-server/src/corpus/slo.test.ts` | CorpusSloState |
| sets the golden recall reading and gauge, and a payload that is not a recall changes nothing | `packages/mcp-server/src/corpus/slo.test.ts` | a stored docs.canary report |
| only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored | `packages/mcp-server/src/corpus/slo.test.ts` | a stored docs.canary report |
| a stored sync note sets the gauge to its lag, and the newest one wins | `packages/mcp-server/src/corpus/sync-event.test.ts` | POST /events with a docs.sync note |
| a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone | `packages/mcp-server/src/corpus/sync-event.test.ts` | POST /events with a docs.sync note |
| an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored | `packages/mcp-server/src/corpus/sync-event.test.ts` | POST /events with a docs.sync note |
| reads a whole number of seconds from a docs.sync payload, rounding a fraction | `packages/mcp-server/src/corpus/sync-event.test.ts` | syncLagSeconds |
| reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object | `packages/mcp-server/src/corpus/sync-event.test.ts` | syncLagSeconds |
| a lag past a year is clamped to it, so one note cannot make the series meaningless | `packages/mcp-server/src/corpus/sync-event.test.ts` | syncLagSeconds |
| a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back | `packages/mcp-server/src/service-event-buffer.test.ts` | the telemetry buffer |
| a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text | `packages/mcp-server/src/service-event-buffer.test.ts` | the telemetry buffer (new in 7a1d923a) |
| a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not | `packages/mcp-server/src/fabric/status.test.ts` | the corpus row (phase 70) |
| unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null | `packages/mcp-server/src/fabric/status.test.ts` | the corpus row (phase 70) |
| a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not | `packages/mcp-server/src/docs-freshness.test.ts` | the corpus's freshness (v1.7 phase 65) |
| the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none | `packages/mcp-server/src/metrics-history.test.ts` | the extended series (uplift-5 S6) |
| breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches | `packages/corpus/src/slo.test.ts` | the sync lag objective |
| is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down | `packages/corpus/src/slo.test.ts` | the sync lag objective |
| `--check` passes on the committed files: nothing is missing, stale or unexpected | `scripts/dashboards.test.ts` | the committed dashboards are what the generator renders |
| reports a token code once for a site | `packages/mcp-server/src/silent-failures.test.ts` | reportSilent |
| the message text never appears in the output | `packages/mcp-server/src/silent-failures.test.ts` | reportSilent |
| a second call for the same site writes nothing | `packages/mcp-server/src/silent-failures.test.ts` | reportSilent |
| a non-object error reports its typeof | `packages/mcp-server/src/silent-failures.test.ts` | reportSilent |
| a code that is not a short identifier is not reported; the constructor name is | `packages/mcp-server/src/silent-failures.test.ts` | reportSilent |

Suite counts from r36 (all `failures="0"`, `skipped="0"`): `scripts/docs-eval.test.ts` 33, `scripts/docs-lint.test.ts` 23, `scripts/planning-integrity.test.ts` 16, `scripts/dashboards.test.ts` 21, `packages/mcp-server/src/flag-registry.test.ts` 26, `packages/mcp-server/src/corpus/sync-event.test.ts` 6, `packages/mcp-server/src/corpus/slo.test.ts` 27, `packages/corpus/src/slo.test.ts` 13, `packages/mcp-server/src/fabric/status.test.ts` 28, `packages/mcp-server/src/service-event-buffer.test.ts` 19.

### Requirements Coverage

No REQUIREMENTS.md row was re-checked beyond the EVAL-01..05 mapping in the ROADMAP phase block. EVAL-03 is the SC3 clause; it is judged against the amended text above.

### Anti-Patterns Found

- No stubs or placeholders in the SC3 changed set.
- Stale comment and stale test title: resolved in `884e0753`; the title is in JUnit (see table).
- The baseline caveat (self-supervised, reads 1.0) is a documented limitation, not a stub.
- Dead-letter branch and held-gauge read have no test (Open item 8). Not a stub; a test gap.

### Behavioral Spot-Checks

Not run in this pass. The behaviours below rest on the r36 JUnit testcases above, which are reported as passing with no failure child. No live behaviour was observed.

---

## Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator gate).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file.
3. **Live sync-lag reading (operator gate).** Test: with `SUBSTRATE_CORPUS=on`, `SUBSTRATE_METRICS_HISTORY=on` and `SUBSTRATE_METRICS_HISTORY_SERIES=extended`, send a real `docs.sync` note with a `lag_s`; read `fabric_status` (the `corpus` row, `detail.syncLag`) and `GET /slo/history` (`corpus.sync_lag_seconds`). Expected: both show the note's lag. Why human: no live run was made; tests and code only.

## Gaps Summary

No BLOCKER. SC3 is VERIFIED against the amended text. The series and the reading come from one emit seam for REST, MCP, stored, held and dead-lettered notes. SC5 remains UNCERTAIN (operator-gated). The phase status is `human_needed` because the operator items remain.

## Open Items

1. **W-1: closed (commit 884e0753).** Option chosen: mirror the reading condition at emit (`stored`, `buffered` or `deadLettered`), with the gauge set through the observer hook. Still closed at a46d42c3.
2. **Doc parity: confirmed against code.** `docs/corpus-eval.md` l.103 and l.105 and `docs/runbooks/docs-rag-operations.md` l.146 match `service.ts` l.3016 to 3018 and `status.ts` l.78.
3. **Stale comment and test title: resolved** in `884e0753`.
4. **Criterion 5 clause 2:** live ingest and eval (Human Verification item 1). Still open.
5. **Canary install and first run:** operator gate (Human Verification item 2). Still open; the timer is staged by design.
6. **Live sync-lag reading not exercised** on a live plane (Human Verification item 3). Still open; verified by tests and code only.
7. **SC3 (d) wording.** The ROADMAP text says the staged canary timer "runs `docs-eval`". Its `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `docs-eval.ts`. Judged met through the shared import; owner to confirm whether the wording must name the file. Still open.
8. **Residual test gaps (not blockers).** (a) No test reads the `corpus.sync_lag_seconds` gauge value after a held note; the held test pins the observer hook, and the hook-to-gauge mapping is the production one exercised by the REST and MCP tests. (b) No test names a dead-lettered `docs.sync` note; that branch is verified by reading only. Both checked again at a46d42c3 by grep and by reading the test bodies.
9. **Out-of-covered-list files re-audited at a46d42c3:** `service.ts` (emit l.3016 to 3018, hook l.1061, `reportSilent` sites, `trackRetain` l.3874), `observe.ts` (l.399 to 400), `server.ts` (gauge block absent; `POST /events` l.1358), `docs-freshness.ts` (l.169 to 182; two unused constants removed in `a46d42c3`), `mcp.ts` (l.1191), `service-event-buffer.test.ts` (held test l.115 unchanged; new shutdown stderr test in 7a1d923a), `silent-failures.test.ts`, `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`.

---

_Verified: 2026-11-06T00:42:30Z_
_Verifier: Claude (gsd-verifier)_
