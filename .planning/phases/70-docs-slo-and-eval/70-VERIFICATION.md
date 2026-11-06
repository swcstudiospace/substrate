---
phase: 70-docs-slo-and-eval
verified: 2026-11-06T02:58:00Z
status: human_needed
score: 4/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/dashboards/substrate-data-planes.json", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.test.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.test.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/corpus/sync-event.test.ts", "packages/mcp-server/src/corpus/sync-event.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/docs-freshness.test.ts", "packages/mcp-server/src/docs-freshness.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/metrics-history.test.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/silent-failures.test.ts", "packages/mcp-server/src/silent-failures.ts", "packages/observability/src/instruments.ts", "scripts/dashboards.test.ts", "scripts/dashboards.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:5e9217091d240dbd04069082d6213bfd1c98fca57470312539f2c074831af5e5"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5 must-haves verified
  gaps_closed: ["W-1 (commit 884e0753): the sync-lag series follows the same note reading as fabric_status, for stored, held and dead-lettered notes, REST or MCP. Still closed at HEAD 5e304ef8: the emit block service.ts l.3016 to 3018 has no content change since a46d42c3."]
  gaps_remaining: []
  regressions: []
  digest_refresh: "covered_digest recomputed at 5e304ef8 by gsd_run query verification.fingerprint over 42 files: the 23 files the prior record covered plus the 19 files this evidence cites that were outside that list. The prior digest v3:sha256:3af0e84c... covered the 23-file list only and is not comparable. Covered-file diff a46d42c3..5e304ef8: 10 of the 23 prior covered files changed, all export-keyword removals (no behaviour change), plus one reportSilent catch in metrics-history.ts (stderr only, same return value) and one comment in eval-live.ts."
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
warnings: []
human_verification:
  - test: "Criterion 5 clause 2 on a live plane: on a host with SUBSTRATE_CORPUS=on and the LightRAG backend, ingest this checkout's docs/ under SUBSTRATE_DOCS_EVAL_REPO, then run substrate corpus eval --root /root/src/repos --server \"$SUBSTRATE_URL\" --json."
    expected: "The runbook question and its heading questions are scored; the runbook's key is in the top 5."
    why_human: "Needs a live plane and a real ingest. Nothing in code asserts it."
  - test: "Canary install and first run (operator-gated; the timer is staged, not installed). Open item; no owner decision or override exists for it."
    expected: "Journal line golden recall@5 <value> over <n> questions, exit 0, and fabric_status corpus row shows recall5.reading."
    why_human: "Host install and a secret-bearing env file; not in this repository. The verifier does not install the units, write the env file or start the service."
  - test: "Live sync-lag reading on a live plane: a real docs.sync note reaches the server, then fabric_status corpus row and GET /slo/history corpus.sync_lag_seconds are read."
    expected: "The row's syncLag reading equals the note's lag_s (rounded), and the series point matches it. A breach is named sync when SUBSTRATE_DOCS_SLO_SYNC_LAG_S is set and exceeded."
    why_human: "Only tests and code have exercised this path. No live run was made."
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-06T02:58:00Z
**Status:** human_needed
**Re-verification:** Yes. Code head 5e304ef8 (prior record at a46d42c3, human_needed, 4/5). Re-verified against the current head by goal-backward checks. SC1, SC2 and SC4 carry forward: their covered files changed only by export-keyword removal (and one comment), and every SC1, SC2 and SC4 evidence anchor below is still present. SC3 is re-checked clause by clause at 5e304ef8. W-1 stays closed. The operator-gated items stay open.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, HEAD `5e304ef8`, clean at check time.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block, read at HEAD). The SC3 text is the amended one (`Amended 2026-11-05 by owner decision: fabric_status is the contract for sync lag and the canary judges recall only`, as written in the ROADMAP). No PLAN files exist for this phase.
- Covered-file fingerprint: `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/70-docs-slo-and-eval` at 5e304ef8, over the 23 prior covered files plus the 19 files cited in this evidence that were outside that list. The query returned 42 files and `v3:sha256:5e921709...`. Both are pasted verbatim into the frontmatter.
- Test evidence: gate r38 JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd. That run contains every commit in this phase's range except 5e304ef8. Its one failing testcase is `repository ratchet` / "the ratchet is tight: no source counter sits below its baseline" (as_unknown_as at 23 against a baseline of 22). 5e304ef8 lowers that baseline in `scripts/code-ratchet.baseline.json`. No testcase cited in this record fails in r38. The r39 JUnit `/root/src/worktrees/backups/gate-r39-junit.xml` was not present at check time. Every title below must be re-checked against r39 when it lands.
- A cited test title counts here only if the r38 JUnit has it as a `testcase` with no `failure`, `error` or `skipped` child. Each title in this record was checked by a script against the JUnit, and each was found in exactly one source file by grep at HEAD. No pass count is claimed.
- Commands run in this record (read-only): `git log`, `git diff`, `git show`, `git grep`, `grep`, `sed`, a read-only parse of the r38 JUnit, a read-only import-graph scan of the TypeScript sources, `gsd_run query verification.fingerprint`, `date -u`. No tests, `tsc`, lint, formatters, PG, docker or databases were run. No file under the worktree was written.
- Postgres: none. None of the SC3 test files references `SUBSTRATE_TEST_PG_URL`.

## Decisions

- The ROADMAP SC3 text carries the amendment dated 2026-11-05 ("fabric_status is the contract for sync lag and the canary judges recall only"). This record judges SC3 against that text.
- No owner decision or override exists in this record for phase 70. Owner decisions of 2026-11-06 cover phases 67, 74 and 75 only. The canary's operator-only gate is an open item (below). It is not an owner acceptance, and this record does not mark it accepted.

## Changes since a46d42c3, checked against the phase

Commits after a46d42c3 (14): `0947001e` (fix 63, manifest commit), `9b951850` and `5041193f` (records and ROADMAP status only), `f1266a9c` (fail-closed connect cooldown, `cache.ts`), `14ac787a` (REST `/handoff` refuses a `to` outside SURFACES, `server.ts`; CLI handoff exits 1, `cli/src/index.ts`), `a2176f96` (`retainDocumentId` narrowed, `memory-retain.ts`, `index-sweep.ts`), `cf4ea4c1` (ratchet docs), `e62bc17b` (stderr reporting at residual silent catch sites), `b8cbdeac`, `d9d0a401`, `4c576e5e`, `8ec17832`, `66fa97bd` (export keyword removed from self-only declarations; no behaviour change), `5e304ef8` (ratchet baseline 23 to 22). The ROADMAP phase 70 block is unchanged in its success-criteria text at HEAD.

1. **Covered files (10 of 23 changed; checked by a diff with the export keyword stripped on both sides, against a46d42c3).**
   - `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `packages/corpus/src/slo.ts`, `packages/mcp-server/src/corpus/slo.ts`, `packages/mcp-server/src/docs-eval-server.ts`, `packages/mcp-server/src/fabric/status.ts`, `packages/mcp-server/src/flag-registry.ts`, `packages/observability/src/instruments.ts`: `export` keyword removed from declarations. The normalised diff is empty for each.
   - `packages/corpus/src/eval-live.ts`: `export` removed from three declarations, and one comment added on a catch at l.74. No code change.
   - `packages/mcp-server/src/metrics-history.ts`: `export` removed from declarations; `reportSilent` imported; the `beforeSample` catch changed from `.catch(() => undefined)` to `.catch((cause) => reportSilent("metrics-history.before-sample", cause))`. The value is still `undefined`; the site writes one stderr line. Two comments added. The sync-lag series is untouched.
   - Covered files with no change since a46d42c3: `docs/corpus-eval.md`, `docs/runbooks/docs-rag-operations.md`, `infra/vps/substrate-docs-canary.service`, `infra/vps/substrate-docs-canary.timer`, `packages/corpus/fixtures/eval/manifest.json`, `scripts/docs-eval.baseline.json`, `scripts/docs-eval.test.ts`, `scripts/docs-eval.ts`, `scripts/docs-golden.ts`, `scripts/docs-lint.test.ts`, `scripts/docs-lint.ts`, `scripts/planning-integrity.test.ts`, `70-SUMMARY.md`, and `infra/vps/dashboards/substrate-data-planes.json`.
2. **Emit seam and observer hook: content unchanged.** `git diff a46d42c3 5e304ef8 -- packages/mcp-server/src/service.ts`: 45 lines changed, all `export` keyword removals, plus one non-export change at l.6421 (`manifestCommit` now returns the row, not its `commit`, matching the `ManifestCommitRecord` type at `docs-search.ts` l.362; this is the phase 63 change in `0947001e`). The sync-lag block is now at l.3016 to 3018 (`if (result.stored || result.buffered === true || result.deadLettered === true)` at l.3016, `recordSyncLag` at l.3017, `this.observer.syncLag?.({ seconds })` at l.3018). The observer hook `syncLag?` is at l.1061. The l.6421 change is outside the SC3 emit path and outside every phase 70 criterion.
3. **Reply replay.** `emit` returns early for a deduplicated replay before the sync-lag block (l.2995 to 2996). Unchanged.
4. **Other SC3-path files.**
   - `observe.ts`: `auditStats` import and re-export removed (no remaining reference in the file). The `syncLag` mapping is at l.398 to 400 (`instruments.setCorpusSyncLag(sample.seconds)` at l.399). Unchanged in content.
   - `server.ts`: a `/handoff` guard was added at l.1507 to 1511 (`14ac787a`: a `to` outside SURFACES is answered 400 before the claim is remembered or the call audited). The route `POST /events` is at l.1304 and calls `substrate.emit` at l.1358. The gauge block is still absent (`git grep` finds no `setCorpusSyncLag`, `recordSyncLag` or `syncLagSeconds` in `server.ts`). The guard is not on the events route and does not touch the sync-lag reading.
   - `mcp.ts`: export keyword removal only. `events_emit` calls `substrate.emit` at l.1191.
   - `docs-freshness.ts`: export keyword removal only. `corpusFreshnessRow` at l.169 to 182 is unchanged. The two unused constants removed in a46d42c3 are not referenced.
   - `observability/src/index.ts` (the barrel): re-export list shrunk by export removal. No importer of a removed name was found in the import-graph scan (see item 6).
   - Test files on the SC3 path (`corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `fabric/status.test.ts`, `metrics-history.test.ts`, `packages/corpus/src/slo.test.ts`, `docs-freshness.test.ts`, `service-event-buffer.test.ts`, `silent-failures.test.ts`, `flag-registry.test.ts`, `scripts/dashboards.test.ts`): `git diff a46d42c3 5e304ef8` is empty for each.
   - `silent-failures.ts`, `scripts/dashboards.ts`: unchanged since a46d42c3.
5. **Behaviour changes made in this session, against this record.** `f1266a9c` (`cache.ts`), `a2176f96` (`memory-retain.ts`, `index-sweep.ts`) and the CLI handoff exit code (`cli/src/index.ts`) are not on any phase 70 evidence path. `e62bc17b` touches one covered site (`metrics-history.ts`, item 1) and changes no value.
6. **Import check.** A read-only scan of every TypeScript source at 5e304ef8 for named imports from each module whose `export` was removed in a46d42c3..5e304ef8 found two candidates: `BriefProfile` and `BriefProfileMode` imported by `service.ts`. Both are `type` imports at l.40 to 41 of `service.ts`, and `brief-profile.ts` still exports them through `export type { BriefProfile, BriefProfileMode }` (l.27). Neither is a break. No other removed name is imported. `tsc` was not run (rule), so this is a textual check only; the r38 run covers runtime imports.
7. **Test titles.** Each title in the table below is a testcase in `gate-r38-junit.xml` with no failure, error or skipped child. Each title is also a source line at HEAD (`git grep -F`): found in exactly one file, at the line given in the table.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | `generateGolden` `packages/corpus/src/eval.ts` l.203, `resultOf` l.295, `scoreRun` l.356 (all still exported at HEAD). `measureGoldenRecall` `scripts/docs-eval.ts` l.417. The only changes to the eval files since a46d42c3 are `export` removals on `GOLDEN_*` constants and types, which are not in the SC1 chain. `scripts/docs-eval.test.ts` has no failure or error child in r38. Wording note: the live flag is `--live URL`; the ROADMAP text says `--execute`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | `packages/corpus/src/eval-lexical.ts` changed only by `export` removal on `BM25_K1`, `BM25_B`, `TITLE_EXTRA_WEIGHT` and two interfaces, which the lexical index uses internally. `scripts/docs-eval.test.ts` unchanged; no failure or error child in r38. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED (code and tests; W-1 closed) | Clause by clause, against the amended text, below. The series follows the same note reading as `fabric_status`, for REST, MCP, stored, held and dead-lettered notes. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` have no diff since a46d42c3 (not in the changed set). None has a failure or error child in r38. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (operator-gated) | The runbook is unchanged since a46d42c3. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. The canary install is operator-gated and open; see Human Verification item 2. |

**Score:** 4/5 must-haves verified (SC1, SC2, SC3, SC4). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### SC3 clause by clause (amended text)

Anchors are at 5e304ef8.

| Clause | Evidence (anchors at 5e304ef8) | Status |
| --- | --- | --- |
| (a) Sync lag is a metric series | `corpus.sync_lag_seconds`: `packages/mcp-server/src/metrics-history.ts` l.167 (extended tier, max per step) and l.423 (gauge source). Gauge `setCorpusSyncLag` in `packages/observability/src/instruments.ts` l.679, metric `CORPUS_SYNC_LAG_METRIC` l.734. Testcase "the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none" (`metrics-history.test.ts` l.1086). | ✓ VERIFIED |
| (a) Threshold in a flag | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`: `packages/corpus/src/slo.ts` l.49 (`loadSloThresholds`, whole number of 1 or more, no default); flag entry `packages/mcp-server/src/flag-registry.ts` l.898. | ✓ VERIFIED |
| (a) Series and reading agree for every note the server takes | Single path. `service.ts` `emit` l.3016 to 3018: `stored`, `buffered` or `deadLettered` calls `corpusSlo.recordSyncLag` (l.3017), then `observer.syncLag` (l.3018). `observe.ts` l.399 is the only production caller of `setCorpusSyncLag`. REST: `server.ts` `POST /events` calls `substrate.emit` (l.1358). MCP: `mcp.ts` l.1191 calls `substrate.emit`. | ✓ VERIFIED |
| (a) REST stored note sets the series | Testcase "a stored sync note sets the gauge to its lag, and the newest one wins" (`corpus/sync-event.test.ts` l.83, describe "POST /events with a docs.sync note"). | ✓ VERIFIED (r38 clean) |
| (a) MCP stored note sets the series | Testcase "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`corpus/sync-event.test.ts` l.105). | ✓ VERIFIED (r38 clean) |
| (a) Held note sets the reading and the series path | Testcase "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts` l.115). The test asserts `readings.syncLagS` is 4000 at buffer time, the observer hook records `[4000]`, and after the drain the reading is still 4000 and the hook has still been called once. | ✓ VERIFIED (r38 clean; body read at 5e304ef8; Open item 8) |
| (a) Held note reaches the gauge value | The test pins the observer hook with a test observer. The hook-to-gauge mapping is `observe.ts` l.399, the mapping the REST and MCP tests exercise. No test reads the gauge value for a held note end to end. | ✓ VERIFIED by code and test together (residual, Open item 8) |
| (a) Dead-lettered note sets the reading and the series path | Same `if` as held (`service.ts` l.3016). The dead-letter results come from the `emit` dead-letter branches in `service.ts`. No test names a dead-lettered `docs.sync` note. | ✓ VERIFIED by reading; not exercised by a test |
| (a) A note the server did not take leaves the series | REST refused case: `POST /events` answers 503 and the gauge stays null. Testcase "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" (`corpus/sync-event.test.ts` l.92). Code: a refused note has neither `stored`, `buffered` nor `deadLettered`, so the `if` at `service.ts` l.3016 does not run. | ✓ VERIFIED |
| (b) `fabric_status` reports a breach | `packages/mcp-server/src/fabric/status.ts` `corpusRow` (l.75 onward): `enabled` at l.76 and l.78; `syncLag` in `detail` at l.84; breach `sync` in `breaches`; row `degraded` with `source: "corpus.slo: breached ..."`. Unset: shown with no verdict. Testcases "a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not" (`fabric/status.test.ts` l.76) and "unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null" (l.92), describe "the corpus row (phase 70)". | ✓ VERIFIED |
| (b) Breach and threshold read in the objective module | `packages/corpus/src/slo.ts` `loadSloThresholds` (l.48 to 49) and `sloBreaches` (l.59 to 65; `sync` breach l.65). Testcases in `packages/corpus/src/slo.test.ts`, describe "the sync lag objective": "breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches" (l.92) and "is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down" (l.83). | ✓ VERIFIED |
| (b) Freshness warning names the sync breach | `packages/mcp-server/src/docs-freshness.ts` `corpusFreshnessRow` (l.169 to 182) adds `sync_lag`; `service.ts` `corpusFreshness` (l.7558 to 7566) passes `this.corpusSlo.readings(now).syncLagS`. Testcase "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not" (`docs-freshness.test.ts` l.1053). | ✓ VERIFIED |
| (c) Canary judges recall only | `scripts/docs-golden.ts` posts `golden_recall5` only: the canary payload at l.497 and the report payload at l.516 carry `golden_recall5`, and no sync reading or lag is read. `packages/mcp-server/src/corpus/slo.ts` `recordGolden` (l.61) sets the recall reading only. Testcases "sets the golden recall reading and gauge, and a payload that is not a recall changes nothing" (`corpus/slo.test.ts` l.311) and "only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored" (l.322), describe "a stored docs.canary report". | ✓ VERIFIED |
| (d) Staged canary timer runs `docs-eval` | `infra/vps/substrate-docs-canary.service` l.33: `ExecStart=... scripts/docs-golden.ts --live --emit`. `scripts/docs-golden.ts` l.62 imports `measureGoldenRecall` from `docs-eval.ts`, and l.731 calls it. Both unchanged since a46d42c3. See Open item 7. | ✓ VERIFIED (through the shared import) |
| (e) Dashboards draw it, regenerated | Panel "Corpus sync lag" at `infra/vps/dashboards/substrate-data-planes.json` l.2890, series `corpus.sync_lag_seconds`, from `scripts/dashboards.ts` l.310. Testcase "`--check` passes on the committed files: nothing is missing, stale or unexpected" (`scripts/dashboards.test.ts` l.96). | ✓ VERIFIED (testcase clean in r38) |

### W-1 (closed at 884e0753, still closed at 5e304ef8)

The prior record found that `corpus.sync_lag_seconds` was set only from the REST route, for a stored note, while `fabric_status` took held and dead-lettered notes at buffer time. Commit `884e0753` resolves this at the emit seam:

- Option chosen: mirror the reading condition at emit, and not the REST-only widening. `Substrate.emit` owns the decision for every route, so REST, MCP and held notes reach the gauge the same way. The REST gauge block in `server.ts` is removed.
- Held notes: the reading is set at buffer time through `recordSyncLag`, and the series is set at the same point through the `syncLag` hook. The drain does not call the hook again, and the held test pins that.
- Docs describe the code as it is: `docs/corpus-eval.md` l.103 and l.105, `docs/runbooks/docs-rag-operations.md` l.146. Both files are unchanged since a46d42c3.
- Since a46d42c3 the emit path has not changed content. The `service.ts` diff is export removals plus the phase 63 `manifestCommit` line (Changes item 2).
- Residual, not a blocker: see Open item 8.

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 owns the docs.freshness route and is cited as evidence for SC3 (b), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold (l.49); `sloBreaches` `sync` breach (l.65); unset = no verdict. `SLO_BREACHES` is no longer exported (export removal only). |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag` (l.72, doc comment l.68 to 71) returns the recorded lag or null. `readings().syncLagS` (l.84). Covered, changed only by `export` removal. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `corpusRow` l.75; `syncLag` detail l.84; breach named `sync`. Covered, changed only by `export` removal. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step (l.167); gauge source (l.423). Covered; changed by `export` removal, the `reportSilent` catch at `beforeSample`, and comments. |
| `packages/observability/src/instruments.ts` | `setCorpusSyncLag` | ✓ VERIFIED | One unlabelled gauge (l.679); `CORPUS_SYNC_LAG_METRIC` (l.734); non-finite and negative dropped. Covered; changed by `export` removal only. |
| `packages/mcp-server/src/service.ts` | emit seam, observer hook, reporting | ✓ VERIFIED | `emit` l.3016 to 3018; observer hook `syncLag?` l.1061. Not a covered file; re-audited at 5e304ef8 (Changes item 2). |
| `packages/mcp-server/src/observe.ts` | production observer maps `syncLag` to the gauge | ✓ VERIFIED | l.398 to 400 (`setCorpusSyncLag` at l.399). Not a covered file; re-audited at 5e304ef8. |
| `packages/mcp-server/src/server.ts` | REST route | ✓ VERIFIED | Gauge block absent; `POST /events` route l.1304 calls `substrate.emit` (l.1358). Not a covered file; re-audited at 5e304ef8. |
| `packages/mcp-server/src/mcp.ts` | MCP route | ✓ VERIFIED | `events_emit` calls `substrate.emit` (l.1191). Not a covered file; export removal only. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` l.169 to 182 adds `sync_lag`. Not a covered file; export removal only. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Posts `golden_recall5` only; no sync reading. Covered, unchanged since a46d42c3. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED (staged) | Staged, not installed. The install is operator-gated and open (Open item 5). `ExecStart` (l.33) is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898). Covered; changed by `export` removal only. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel, regenerated | ✓ VERIFIED | Panel at json l.2890; `dashboards.ts` l.310. `--check` testcase clean in r38. The json is in the covered list and unchanged since a46d42c3; `dashboards.ts` is in the covered list and unchanged. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` (l.3016 to 3018) | `corpus/slo.ts` `recordSyncLag` | stored, buffered or dead-lettered `docs.sync` note | ✓ WIRED |
| `service.ts` `emit` (l.3018) | `observe.ts` `syncLag` to `instruments.setCorpusSyncLag` | observer hook, production observer | ✓ WIRED |
| `server.ts` `POST /events` (l.1358) | `service.ts` `emit` | `substrate.emit` (REST) | ✓ WIRED |
| `mcp.ts` `events_emit` (l.1191) | `service.ts` `emit` | `substrate.emit` (MCP) | ✓ WIRED |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` (l.7558 to 7566) | `docs-freshness.ts` `corpusFreshnessRow` | `corpusSlo.readings(now).syncLagS` and the corpus sync reading | ✓ WIRED |
| `docs-golden.ts` (l.62) | `docs-eval.ts` `measureGoldenRecall` | import | ✓ WIRED |

### Test titles relied on

Each title is a testcase in `/root/src/worktrees/backups/gate-r38-junit.xml` with no failure, error or skipped child, and each is a source line at 5e304ef8. Re-check against gate-r39-junit.xml when it lands.

| Title | Source file (line) | Classname (describe) |
| --- | --- | --- |
| the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place | `packages/mcp-server/src/corpus/slo.test.ts` (l.63) | CorpusSloState |
| sets the golden recall reading and gauge, and a payload that is not a recall changes nothing | `packages/mcp-server/src/corpus/slo.test.ts` (l.311) | a stored docs.canary report |
| only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored | `packages/mcp-server/src/corpus/slo.test.ts` (l.322) | a stored docs.canary report |
| a stored sync note sets the gauge to its lag, and the newest one wins | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.83) | POST /events with a docs.sync note |
| a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.92) | POST /events with a docs.sync note |
| an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.105) | POST /events with a docs.sync note |
| reads a whole number of seconds from a docs.sync payload, rounding a fraction | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.17) | syncLagSeconds |
| reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.23) | syncLagSeconds |
| a lag past a year is clamped to it, so one note cannot make the series meaningless | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.33) | syncLagSeconds |
| a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back | `packages/mcp-server/src/service-event-buffer.test.ts` (l.115) | the telemetry buffer |
| a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text | `packages/mcp-server/src/service-event-buffer.test.ts` (l.234) | the telemetry buffer (new in 7a1d923a) |
| a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not | `packages/mcp-server/src/fabric/status.test.ts` (l.76) | the corpus row (phase 70) |
| unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null | `packages/mcp-server/src/fabric/status.test.ts` (l.92) | the corpus row (phase 70) |
| a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not | `packages/mcp-server/src/docs-freshness.test.ts` (l.1053) | the corpus's freshness (v1.7 phase 65) |
| the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none | `packages/mcp-server/src/metrics-history.test.ts` (l.1086) | the extended series (uplift-5 S6) |
| breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches | `packages/corpus/src/slo.test.ts` (l.92) | the sync lag objective |
| is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down | `packages/corpus/src/slo.test.ts` (l.83) | the sync lag objective |
| `--check` passes on the committed files: nothing is missing, stale or unexpected | `scripts/dashboards.test.ts` (l.96) | the committed dashboards are what the generator renders |
| reports a token code once for a site | `packages/mcp-server/src/silent-failures.test.ts` (l.19) | reportSilent |
| the message text never appears in the output | `packages/mcp-server/src/silent-failures.test.ts` (l.25) | reportSilent |
| a second call for the same site writes nothing | `packages/mcp-server/src/silent-failures.test.ts` (l.39) | reportSilent |
| a non-object error reports its typeof | `packages/mcp-server/src/silent-failures.test.ts` (l.48) | reportSilent |
| a code that is not a short identifier is not reported; the constructor name is | `packages/mcp-server/src/silent-failures.test.ts` (l.33) | reportSilent |

Failing testcases in r38: one, in the `repository ratchet` suite (not cited here), fixed at 5e304ef8. None of the titles above is in that failure set.

### Requirements Coverage

No REQUIREMENTS.md row was re-checked beyond the EVAL-01..05 mapping in the ROADMAP phase block. EVAL-03 is the SC3 clause; it is judged against the amended text above.

### Anti-Patterns Found

- No stubs or placeholders in the SC3 changed set.
- The baseline caveat (self-supervised, reads 1.0) is a documented limitation, not a stub.
- Dead-letter branch and held-gauge read have no test (Open item 8). Not a stub; a test gap.
- `service.ts` l.6421 `manifestCommit` now returns the row. This is the phase 63 change (`0947001e`), not a phase 70 change, and it is outside the SC3 path. It is recorded here for the phase 63 record only.

### Behavioral Spot-Checks

Not run in this pass. The behaviours below rest on the r38 JUnit testcases above, which are reported as passing with no failure child. No live behaviour was observed.

---

## Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator-gated; open).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file. The verifier does not perform this, and no owner decision or override accepts its absence.
3. **Live sync-lag reading (operator gate).** Test: with `SUBSTRATE_CORPUS=on`, `SUBSTRATE_METRICS_HISTORY=on` and `SUBSTRATE_METRICS_HISTORY_SERIES=extended`, send a real `docs.sync` note with a `lag_s`; read `fabric_status` (the `corpus` row, `detail.syncLag`) and `GET /slo/history` (`corpus.sync_lag_seconds`). Expected: both show the note's lag. Why human: no live run was made; tests and code only.

## Gaps Summary

No BLOCKER. SC3 is VERIFIED against the amended text. The series and the reading come from one emit seam for REST, MCP, stored, held and dead-lettered notes. SC5 remains UNCERTAIN (operator-gated). The phase status is `human_needed` because the operator-gated items remain open. No override is applied.

## Open Items

1. **W-1: closed (commit 884e0753).** Option chosen: mirror the reading condition at emit (`stored`, `buffered` or `deadLettered`), with the gauge set through the observer hook. Still closed at 5e304ef8.
2. **Doc parity: confirmed against code.** `docs/corpus-eval.md` l.103 and l.105 and `docs/runbooks/docs-rag-operations.md` l.146 match `service.ts` l.3016 to 3018 and `status.ts` l.78. Both doc files are unchanged since a46d42c3.
3. **Stale comment and test title: resolved** in `884e0753`.
4. **Criterion 5 clause 2:** live ingest and eval (Human Verification item 1). Still open.
5. **Canary install and first run: operator-gated, open.** The assignment's open item is that the canary is operator-only. The timer is staged by design and is not installed by this record. No owner decision or override accepts the absence of a canary run. Still open until an operator runs it (Human Verification item 2).
6. **Live sync-lag reading not exercised** on a live plane (Human Verification item 3). Still open; verified by tests and code only.
7. **SC3 (d) wording.** The ROADMAP text says the staged canary timer "runs `docs-eval`". Its `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `docs-eval.ts`. Judged met through the shared import. Owner to confirm whether the wording must name the file. Still open for the owner; no decision recorded.
8. **Residual test gaps (not blockers).** (a) No test reads the `corpus.sync_lag_seconds` gauge value after a held note; the held test pins the observer hook, and the hook-to-gauge mapping is the production one exercised by the REST and MCP tests. (b) No test names a dead-lettered `docs.sync` note; that branch is verified by reading only. Both checked again at 5e304ef8 by grep and by reading the test bodies.
9. **Out-of-covered-list files re-audited at 5e304ef8:** `service.ts` (emit l.3016 to 3018, hook l.1061, `manifestCommit` l.6421 belongs to phase 63), `observe.ts` (l.398 to 400), `server.ts` (gauge block absent; `POST /events` l.1304 and l.1358; `/handoff` guard l.1507 to 1511), `docs-freshness.ts` (l.169 to 182), `mcp.ts` (l.1191), `service-event-buffer.test.ts` (held test l.115; shutdown stderr test l.234), `silent-failures.ts` and its test, `scripts/dashboards.ts`, `observability/src/index.ts` (barrel; no importer of a removed name found).

---

_Verified: 2026-11-06T02:58:00Z_
_Verifier: Claude (gsd-verifier)_
