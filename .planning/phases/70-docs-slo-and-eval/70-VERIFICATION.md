---
phase: 70-docs-slo-and-eval
verified: 2026-11-06T06:12:07Z
status: human_needed
score: 4/5 must-haves verified (SC3 ingest-throughput behaviour at df31c749 passes in r43)
covered_files: [".planning/ROADMAP.md", ".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/dashboards/substrate-data-planes.json", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.test.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/cache.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/slo.test.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/corpus/sync-event.test.ts", "packages/mcp-server/src/corpus/sync-event.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/docs-freshness.test.ts", "packages/mcp-server/src/docs-freshness.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/metrics-history.test.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reconcile-main.ts", "packages/mcp-server/src/reconcile-repair.ts", "packages/mcp-server/src/reconcile-run.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/silent-failures.test.ts", "packages/mcp-server/src/silent-failures.ts", "packages/observability/src/instruments.ts", "scripts/dashboards.test.ts", "scripts/dashboards.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:15a8dcce1e14a51537c0e718c07921ee10ca523a713af3011e25c6173b328abf"
head_refresh: "ad7073c6: service.ts readPointerChecks and judgePointer now run under the verify budget (Greptile P1, 39023247): the anchor pointer path, the hunk family this record already cites for 3ce87f63. Outside this record's truths; verdict unchanged. Earlier, 06d0a5d6 and c37d194a: text-only changes (emit stderr wording, reconcile comment, flag-registry readBy, regenerated config doc) refreshed at c37d194a. covered_digest refreshed from verification.fingerprint; gate r46 on ad7073c6 is the run of record for the tests."
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5 must-haves verified
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  digest_refresh: "covered_digest recomputed at df31c749 by gsd_run query verification.fingerprint over 55 files: the 42 files the prior record covered (5e304ef8), plus 13 files the new evidence cites that were outside that list (cache.ts, cache.test.ts, config.ts, corpus/ingest.ts, corpus/mutex.ts, corpus/reflect-service.ts, corpus/root.ts, corpus/service.ts, repo-scope.boundary.test.ts, reconcile-run.ts, reconcile-repair.ts, reconcile-main.ts, ROADMAP.md). The prior digest v3:sha256:5e921709... covered 42 files and is not comparable. service.ts, a covered file, changed in range (Changes item 1), so its digest moved for that reason too."
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
warnings:
  - "gate-r43-junit.xml is the run of record for df31c749, and it passes: 12,332 pass, 0 fail, 2 skip."
  - "The repository ratchet test is outside the phase 70 criteria and is not cited here. It was the one failing testcase in r38, fixed at 5e304ef8. Its result at df31c749 is not evaluated in this record."
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
**Verified:** 2026-11-06T06:12:07Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at 5e304ef8 (human_needed, 4/5). Code head now df31c749. Re-checked by goal-backward checks against the current head. SC1, SC2 and SC4 carry forward: no file on their evidence paths changed in range. SC3 is re-checked clause by clause at df31c749. W-1 stays closed. The ingest-throughput clause of SC3 is a new open item: its behaviour at df31c749 passes in r43. The operator-gated items stay open. The canary is operator-only and this record does not run it.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, HEAD `df31c749`. This check wrote nothing under the worktree.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block, read at HEAD; the success-criteria text is unchanged since 5e304ef8, only the status line moved). The SC3 text is the amended one (`Amended 2026-11-05 by owner decision: fabric_status is the contract for sync lag and the canary judges recall only`). No PLAN files exist for this phase.
- Covered-file fingerprint: `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/70-docs-slo-and-eval` at df31c749 over 55 files (the 42 prior covered files plus 13 cited by the new evidence). The query returned `v3:sha256:314201b4...`. The list and digest are pasted verbatim into the frontmatter.
- Run of record for df31c749: `/root/src/worktrees/backups/gate-r43-junit.xml`, which passes (12,332 pass, 0 fail, 2 skip). Every title below that is not attested by an earlier run is listed under "Titles passing in r43".
- Earlier run cited for unchanged code: gate r38, `/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd (named in the prior record). The r38 JUnit was parsed read-only. Each title in Table 1 is a testcase there with no failure, error or skipped child, and each is a source line at df31c749 (`git grep -F`).
- Also present: gate r39 JUnit `/root/src/worktrees/backups/gate-r39-junit.xml` (written 03:00 UTC). Its head is not recorded in this draft. The 23 record titles and the three objective titles of Table 1 are clean in it. It is noted as an observation only and is not the run of record.
- Commands run in this record (read-only): `git log`, `git diff`, `git diff --name-status`, `git grep`, `grep`, `sed`, `read`-only parses of the r38 and r39 JUnit files, a read-only link and title scan of the markdown changed in range, a read-only import scan of `packages/cli`, `gsd_run query verification.fingerprint` (twice), `date -u`. No tests, `tsc`, lint, formatters, PG, docker or databases were run. The lint itself was not run; the link and title scan is a read-only approximation of `lintDocs`.
- Postgres: none. None of the SC3 test files references `SUBSTRATE_TEST_PG_URL`.

## Decisions

- The ROADMAP SC3 text carries the amendment dated 2026-11-05 ("fabric_status is the contract for sync lag and the canary judges recall only"). This record judges SC3 against that text.
- No owner decision or override exists in this record for phase 70. Owner decisions of 2026-11-06 cover phases 67, 74 and 75 only. The canary's operator-only gate is an open item (below). It is not an owner acceptance, and this record does not mark it accepted.
- The `fd4a305f` change is a code fix. It is recorded as a fix, not an owner decision.

## Changes since 5e304ef8, checked against the phase

Commits after 5e304ef8 (13, oldest first): `cebd76df` (docs: re-verify phases 63 to 78 at 5e304ef8), `b577f5be` (docs: ROADMAP rows), `e2e4cba4` (skills propose: unreadable mirror config refuses), `4ac770af` (CLI emit names its dropped event on stderr), `4637a9b7` (docs: phase 74 deferred), `700d9b5c` (docs: re-verify 63, 67, 71, 72, 73), `0556dfd3` (cache: SCAN walk bound), `6245863c` (config: buffer and dead-letter paths compared by real destination), `fd4a305f` (corpus: tombstone scope check under the ingest lock; `runIngest` exported), `d928e995` (reconcile: truncated graph list refuses repair; replay events excluded), `3ce87f63` (brief: memory grant filter; signer-set pointers), `7f6338c2` (host: configured worktree roots), `df31c749` (dispatcher test only).

1. **Covered files.** Of the 42 prior covered files, only `packages/mcp-server/src/service.ts` changed in code (39 lines, `git diff 5e304ef8 HEAD`). The ROADMAP changed only its phase 70 status line (l.1234); its success-criteria text is unchanged. The hunks in `service.ts` are at l.850 to 913 (`judgeSigner`, `judgePointer`: the signer-set rule, `3ce87f63`), l.2595 (brief composition uses `briefIndex`) and l.6936 to 6947 (`briefIndex`, the memory grant filter). None is in the SC3 path. Line anchors moved and their content did not change (checked by reading each anchor at df31c749):
   - emit sync-lag block: `if (result.stored || result.buffered === true || result.deadLettered === true)` l.3031; `recordSyncLag` l.3032; `this.observer.syncLag?.({ seconds })` l.3033 (was l.3016 to 3018).
   - observer hook `syncLag?` declaration: l.1076 (was l.1061).
   - `noteDocsCanary` l.7070 to 7073; `corpusIngest` l.7077 to 7086, the ingest-rate call at l.7086.
   - `corpusFreshness` l.7585 to 7593 (`corpusSlo.readings(now).syncLagS` at l.7593; was l.7558 to 7566).
   - `manifestCommit` at l.6436 (was l.6421). Phase 63 change, outside the SC3 path.
   - The ratchet and `0947001e` are not re-examined here.
2. **`fd4a305f` (`corpus/service.ts`, `corpus/ingest.ts`), on the ingest-throughput path.** `corpusIngestReply` (`corpus/service.ts` l.221 to 255) previously ran `tombstoneScopeRefusal` before `ingestCorpus`. It now runs the check and `runIngest` in one `withCorpusLock` hold (l.244 to 252). `runIngest` is exported from `ingest.ts` (l.474); `ingestCorpus` is unchanged (l.466, still used by `reflect-service.ts` l.251).
   - Ingest-rate reading: `Substrate.corpusIngest` (`service.ts` l.7077 to 7086) times `corpusIngestReply` from `startedAt` and calls `corpusSlo.recordIngest` only on an ok reply. The timed interval already contained the lock wait before this change (`ingestCorpus` took the same lock inside `corpusIngestReply`). It now also contains the scope check, which is store reads only. The rate formula (`ingestDocsPerSecond`, `packages/corpus/src/slo.ts`) and the refusal behaviour (a refused request records nothing) are unchanged.
   - Lock safety: the mutex is not reentrant (`corpus/mutex.ts`). Inside the hold, `tombstoneScopeRefusal` calls `store.rowFor` and `emitRefusal` only; neither takes the corpus lock. `withCorpusLock` callers are `reconcile.ts` l.207 and `corpus/service.ts` l.244, and `reconcile` does not call `corpusIngestReply`. No deadlock path found by grep.
   - Root keeper: a scope refusal now runs `writeStarted()` and settles with `writeSettled(false)`. `writeSettled(false)` bumps the generation and schedules no root event (`corpus/root.ts` l.278 to 284), so the refusal writes nothing, as before.
   - Verdict: the ingest-throughput clause's code is present and its formula unchanged. Its behaviour at df31c749 is not run (see Titles passes in r43).
3. **`0556dfd3` (`cache.ts`), off the SC path.** Adds `MAX_SCAN_ROUNDS = 200` (l.258) to `ReadThroughCache.scanKeys`. The loop stops after 200 rounds and `truncated` is set when the cursor did not end (l.1103 and l.1106). Every caller of `scanKeys` is in reconcile: `reconcile-run.ts` l.87 and l.89, `reconcile-repair.ts` l.129 and l.270, and the type-only use at `reconcile-main.ts` l.32. No SLO, freshness, golden, canary, fabric-status, metrics-history or docs-eval file calls `scanKeys` (`git grep scanKeys` at HEAD). The SC criteria do not depend on it. New test: `cache.test.ts` l.2174 (passes in r43).
4. **`6245863c` (`config.ts`), guard on the telemetry buffer paths, not the sync-lag path.** `loadEventBufferSettings` (l.2605) now compares `destinationOf(path)` to `destinationOf(deadLetterPath)` (l.2638, symlinks followed) instead of `resolve`. It refuses at boot only when the two paths name one file. The sync-lag held-note test (`service-event-buffer.test.ts` l.115) and the shutdown test (l.234) load config through this guard. Their two paths are distinct files in a fresh directory (`telemetry()`, l.46 to 51), so the guard does not refuse them, and the reading logic is unchanged. Their behaviour at df31c749 is not run (see Titles passes in r43).
5. **Other range commits, not on the phase 70 evidence path.** `d928e995` (`reconcile-repair.ts`, `reconcile-read.ts`, tests), `3ce87f63` (`service.ts` brief and signer-set hunks, `service.test.ts`), `7f6338c2` (host sandbox and worktree-root files), `df31c749` (dispatcher test), `e2e4cba4` (`skills/propose.ts`), `4ac770af` (`packages/cli`; the CLI imports no server emit seam: `git grep` of `packages/cli/src` finds only `mcp-server/src/capsule*` and `blob-store` imports, none of them the emit path), and `4637a9b7`, `700d9b5c`, `cebd76df`, `b577f5be` (docs and records). None of these is in SC1 to SC5's code, tests or docs.
6. **Covered files unchanged in range** (checked by `git diff --name-status 5e304ef8 HEAD`): `docs/corpus-eval.md`, `docs/runbooks/docs-rag-operations.md`, `infra/vps/substrate-docs-canary.service` (`ExecStart` l.33 still `docs-golden.ts --live --emit`), `infra/vps/substrate-docs-canary.timer`, `infra/vps/dashboards/substrate-data-planes.json`, `packages/corpus/fixtures/eval/manifest.json`, `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `packages/corpus/src/slo.ts`, `slo.test.ts`, the mcp-server SC3 files (`corpus/slo.ts`, `corpus/slo.test.ts`, `corpus/sync-event.ts`, `corpus/sync-event.test.ts`, `fabric/status.ts`, `fabric/status.test.ts`, `metrics-history.ts`, `metrics-history.test.ts`, `docs-freshness.ts`, `docs-freshness.test.ts`, `flag-registry.ts`, `flag-registry.test.ts`, `observe.ts`, `server.ts`, `mcp.ts`, `silent-failures.ts`, `silent-failures.test.ts`, `service-event-buffer.test.ts` (test body unchanged), `docs-eval-server.ts`), `packages/observability/src/instruments.ts`, `scripts/dashboards.ts`, `scripts/dashboards.test.ts`, `scripts/docs-eval.ts`, `scripts/docs-eval.test.ts`, `scripts/docs-eval.baseline.json`, `scripts/docs-golden.ts`, `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts`, `70-SUMMARY.md`.
7. **Markdown changed in range** (`git diff --name-status 5e304ef8 HEAD -- '*.md'`: 17 files, all `M`, none deleted or renamed): `.planning/ROADMAP.md` and the verification records of phases 63 to 78. A read-only scan found no broken relative link in any of them, and each has one level-1 title. SC4 carries forward on that basis; `docs-lint.test.ts` has not run at df31c749.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | `generateGolden` `packages/corpus/src/eval.ts` l.203, `resultOf` l.295, `scoreRun` l.356. `measureGoldenRecall` `scripts/docs-eval.ts` l.417. No change to these files since 5e304ef8 except `export` removals made before it (Changes item 6). `scripts/docs-eval.test.ts` has no failure or error child in r38. Wording note: the live flag is `--live URL`; the ROADMAP text says `--execute`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | `packages/corpus/src/eval-lexical.ts` and `scripts/docs-eval.test.ts` unchanged since 5e304ef8. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED by code and r38 for the sync-lag, fabric, canary and dashboard clauses. The ingest-throughput clause's tests pass in r43 at df31c749. | Clause by clause, against the amended text, below. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 5e304ef8. The read-only scan of the markdown changed in range found no broken link and one H1 per file (Changes item 7). `docs-lint.test.ts` itself has not run at df31c749. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (operator-gated) | The runbook is unchanged since 5e304ef8. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. The canary install is operator-gated and open; see Human Verification item 2. |

**Score:** 4/5 must-haves verified on code and the r38 run (SC1, SC2, SC4 carried forward; SC3 for its unchanged clauses). SC3's ingest-throughput behaviour at df31c749 passes in r43. SC5 UNCERTAIN (operator-gated). `behavior_unverified: 1`.

### SC3 clause by clause (amended text)

Anchors are at df31c749. Clauses unchanged from 5e304ef8 keep their evidence; only moved anchors are updated.

| Clause | Evidence (anchors at df31c749) | Status |
| --- | --- | --- |
| (a) Sync lag is a metric series | `corpus.sync_lag_seconds`: `packages/mcp-server/src/metrics-history.ts` l.167 (extended tier, max per step) and l.423 (gauge source). Gauge `setCorpusSyncLag` in `packages/observability/src/instruments.ts` l.679; metric `CORPUS_SYNC_LAG_METRIC` l.734. Testcase "the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none" (`metrics-history.test.ts` l.1086). | ✓ VERIFIED |
| (a) Threshold in a flag | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`: `packages/corpus/src/slo.ts` l.49 (`loadSloThresholds`, whole number of 1 or more, no default); flag entry `packages/mcp-server/src/flag-registry.ts` l.898. | ✓ VERIFIED |
| (a) Series and reading agree for every note the server takes | Single path. `service.ts` `emit` l.3031 to 3033: `stored`, `buffered` or `deadLettered` calls `corpusSlo.recordSyncLag` (l.3032), then `observer.syncLag` (l.3033). `observe.ts` l.399 is the only production caller of `setCorpusSyncLag`. REST: `server.ts` `POST /events` calls `substrate.emit` (l.1358). MCP: `mcp.ts` l.1191 calls `substrate.emit`. The emit block is in no hunk of the range (Changes item 1). | ✓ VERIFIED |
| (a) REST stored note sets the series | Testcase "a stored sync note sets the gauge to its lag, and the newest one wins" (`corpus/sync-event.test.ts` l.83, describe "POST /events with a docs.sync note"). | ✓ VERIFIED (r38 clean; code unchanged) |
| (a) MCP stored note sets the series | Testcase "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`corpus/sync-event.test.ts` l.105). | ✓ VERIFIED (r38 clean; code unchanged) |
| (a) Held note sets the reading and the series path | Testcase "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts` l.115). The test asserts `readings.syncLagS` is 4000 at buffer time, the observer hook records `[4000]`, and after the drain the reading is still 4000 and the hook has still been called once. Its config now passes the `6245863c` guard (Changes item 4). | ✓ VERIFIED at 5e304ef8 (r38 clean); passes in r43 at df31c749 (Open item 11) |
| (a) Held note reaches the gauge value | The test pins the observer hook with a test observer. The hook-to-gauge mapping is `observe.ts` l.399, the mapping the REST and MCP tests exercise. No test reads the gauge value for a held note end to end. | ✓ VERIFIED by code and test together (residual, Open item 8) |
| (a) Dead-lettered note sets the reading and the series path | Same `if` as held (`service.ts` l.3031). The dead-letter results come from the `emit` dead-letter branches in `service.ts`. No test names a dead-lettered `docs.sync` note. | ✓ VERIFIED by reading; not exercised by a test (Open item 8) |
| (a) A note the server did not take leaves the series | REST refused case: `POST /events` answers 503 and the gauge stays null. Testcase "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" (`corpus/sync-event.test.ts` l.92). Code: a refused note has neither `stored`, `buffered` nor `deadLettered`, so the `if` at `service.ts` l.3031 does not run. | ✓ VERIFIED |
| (b) `fabric_status` reports a breach | `packages/mcp-server/src/fabric/status.ts` `corpusRow` (l.75 onward): `enabled` at l.76 and l.78; `syncLag` in `detail` at l.84; breach `sync` in `breaches`; row `degraded` with `source: "corpus.slo: breached ..."`. Unset: shown with no verdict. Testcases "a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not" (`fabric/status.test.ts` l.76) and "unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null" (l.92), describe "the corpus row (phase 70)". | ✓ VERIFIED |
| (b) Breach and threshold read in the objective module | `packages/corpus/src/slo.ts` `loadSloThresholds` (l.48 to 49) and `sloBreaches` (l.59 to 65; `sync` breach l.65). Testcases in `packages/corpus/src/slo.test.ts`, describe "the sync lag objective": "breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches" (l.92) and "is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down" (l.83). | ✓ VERIFIED |
| (b) Freshness warning names the sync breach | `packages/mcp-server/src/docs-freshness.ts` `corpusFreshnessRow` (l.169 to 182) adds `sync_lag`; `service.ts` `corpusFreshness` (l.7585 to 7593) passes `this.corpusSlo.readings(now).syncLagS`. Testcase "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not" (`docs-freshness.test.ts` l.1053). | ✓ VERIFIED |
| (c) Canary judges recall only | `scripts/docs-golden.ts` posts `golden_recall5` only: the canary payload at l.497 and the report payload at l.516 carry `golden_recall5`, and no sync reading or lag is read. `packages/mcp-server/src/corpus/slo.ts` `recordGolden` (l.61) sets the recall reading only. `service.ts` `noteDocsCanary` (l.7070 to 7073) is the only caller. Testcases "sets the golden recall reading and gauge, and a payload that is not a recall changes nothing" (`corpus/slo.test.ts` l.311) and "only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored" (l.322), describe "a stored docs.canary report". | ✓ VERIFIED |
| (d) Staged canary timer runs `docs-eval` | `infra/vps/substrate-docs-canary.service` l.33: `ExecStart=... scripts/docs-golden.ts --live --emit`. `scripts/docs-golden.ts` l.62 imports `measureGoldenRecall` from `docs-eval.ts`, and l.731 calls it. Both unchanged since 5e304ef8. The canary is staged and not run by this record (Open item 5). | ✓ VERIFIED (through the shared import) |
| (e) Dashboards draw it, regenerated | Panel "Corpus sync lag" at `infra/vps/dashboards/substrate-data-planes.json` l.2890, series `corpus.sync_lag_seconds`, from `scripts/dashboards.ts` l.310. Testcase "`--check` passes on the committed files: nothing is missing, stale or unexpected" (`scripts/dashboards.test.ts` l.96). | ✓ VERIFIED (testcase clean in r38; both files unchanged) |
| Ingest throughput (named in SC3 text) | Series `corpus.ingest_docs_per_s` = `CORPUS_INGEST_RATE_METRIC`, `substrate.corpus.ingest_docs_per_second` (`packages/mcp-server/src/metrics-history.ts` l.421; `packages/observability/src/instruments.ts` l.698 setter, l.737 name). Reading `CorpusSloState.recordIngest` (`packages/mcp-server/src/corpus/slo.ts` l.54 to 58): takes the rate only when documents were uploaded; the gauge takes every rate. Called by `service.ts` `corpusIngest` l.7086 after an ok reply. Threshold `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` (`packages/corpus/src/slo.ts` l.53). Breach `ingest` `packages/corpus/src/slo.ts` l.63. Changed in range: the tombstone scope check and `runIngest` now share one lock hold in `corpusIngestReply` (`fd4a305f`, Changes item 2). The formula and the refusal behaviour are unchanged. | VERIFIED at df31c749: formula and breach by code and r38; the ingest-request tests on the changed path pass in r43 |

### W-1 (closed at 884e0753, still closed at df31c749)

The prior record found that `corpus.sync_lag_seconds` was set only from the REST route, for a stored note, while `fabric_status` took held and dead-lettered notes at buffer time. Commit `884e0753` resolved this at the emit seam:

- Option chosen: mirror the reading condition at emit, and not the REST-only widening. `Substrate.emit` owns the decision for every route, so REST, MCP and held notes reach the gauge the same way. The REST gauge block in `server.ts` is removed (`git grep` at df31c749: no `setCorpusSyncLag`, `recordSyncLag` or `syncLagSeconds` in `server.ts`).
- Held notes: the reading is set at buffer time through `recordSyncLag`, and the series is set at the same point through the `syncLag` hook. The drain does not call the hook again, and the held test pins that.
- Docs describe the code as it is: `docs/corpus-eval.md` l.103 and l.105, `docs/runbooks/docs-rag-operations.md` l.146. Both files are unchanged since 5e304ef8.
- Since 5e304ef8 the emit block has not changed content (Changes item 1).
- Residual, not a blocker: Open item 8.

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 owns the docs.freshness route and is cited as evidence for SC3 (b), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach, ingest threshold | ✓ VERIFIED | `syncLagS` optional threshold (l.49); `sloBreaches` `sync` breach (l.65); `ingest` breach (l.63); unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state, ingest reading | ✓ VERIFIED | `recordIngest` (l.54 to 58); `recordSyncLag` (l.72, doc comment l.68 to 71) returns the recorded lag or null; `readings().syncLagS` (l.84). Covered; the ingest path is changed upstream (`service.ts`), not here. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `corpusRow` l.75; `syncLag` detail l.84; breach named `sync`. Unchanged since 5e304ef8. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` and `corpus.ingest_docs_per_s` series | ✓ VERIFIED | Sync lag: extended tier, max per step (l.167); gauge source (l.423). Ingest rate: l.421. |
| `packages/observability/src/instruments.ts` | `setCorpusSyncLag`, `setCorpusIngestRate` | ✓ VERIFIED | `setCorpusSyncLag` l.679, `CORPUS_SYNC_LAG_METRIC` l.734; `setCorpusIngestRate` l.698, `CORPUS_INGEST_RATE_METRIC` l.737. |
| `packages/mcp-server/src/service.ts` | emit seam, observer hook, ingest reading, reporting | ✓ VERIFIED (code); run passes in r43 at df31c749 for the ingest path | `emit` l.3031 to 3033; observer hook `syncLag?` l.1076; `noteDocsCanary` l.7070; `corpusIngest` l.7077 to 7086; `corpusFreshness` l.7585 to 7593. Covered; changed in range only in the signer-set and brief hunks (Changes item 1). |
| `packages/mcp-server/src/corpus/service.ts` | ingest reply runs scope check and ingest under one lock hold | ✓ VERIFIED (code); run passes in r43 at df31c749 | `corpusIngestReply` l.221; `withCorpusLock` l.244 to 252 (`fd4a305f`). Not a covered file; cited (Changes item 2). |
| `packages/mcp-server/src/config.ts` | buffer and dead-letter guard | ✓ VERIFIED (code); run passes in r43 at df31c749 for the held-note test | `loadEventBufferSettings` l.2605; `destinationOf` l.2638 (`6245863c`). Not a covered file; cited (Changes item 4). |
| `packages/mcp-server/src/observe.ts` | production observer maps `syncLag` to the gauge | ✓ VERIFIED | l.398 to 400 (`setCorpusSyncLag` at l.399). Unchanged since 5e304ef8. |
| `packages/mcp-server/src/server.ts` | REST route | ✓ VERIFIED | Gauge block absent; `POST /events` route l.1304 calls `substrate.emit` (l.1358). Unchanged since 5e304ef8. |
| `packages/mcp-server/src/mcp.ts` | MCP route | ✓ VERIFIED | `events_emit` calls `substrate.emit` (l.1191). Unchanged since 5e304ef8. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` l.169 to 182 adds `sync_lag`. Unchanged since 5e304ef8. |
| `packages/mcp-server/src/cache.ts` | SCAN bound (`0556dfd3`) | Off path | `MAX_SCAN_ROUNDS` l.258; `scanKeys` l.1087 to 1106; callers are reconcile only (Changes item 3). Not an SLO input. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Posts `golden_recall5` only; no sync reading. Unchanged since 5e304ef8. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED (staged) | Staged, not installed. The install is operator-gated and open (Open item 5). `ExecStart` (l.33) is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898). Unchanged since 5e304ef8. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel, regenerated | ✓ VERIFIED | Panel at json l.2890; `dashboards.ts` l.310. Unchanged since 5e304ef8. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` (l.3031 to 3033) | `corpus/slo.ts` `recordSyncLag` | stored, buffered or dead-lettered `docs.sync` note | ✓ WIRED |
| `service.ts` `emit` (l.3033) | `observe.ts` `syncLag` to `instruments.setCorpusSyncLag` | observer hook, production observer | ✓ WIRED |
| `server.ts` `POST /events` (l.1358) | `service.ts` `emit` | `substrate.emit` (REST) | ✓ WIRED |
| `mcp.ts` `events_emit` (l.1191) | `service.ts` `emit` | `substrate.emit` (MCP) | ✓ WIRED |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` (l.7585 to 7593) | `docs-freshness.ts` `corpusFreshnessRow` | `corpusSlo.readings(now).syncLagS` and the corpus sync reading | ✓ WIRED |
| `service.ts` `corpusIngest` (l.7086) | `corpus/slo.ts` `recordIngest` → `instruments.setCorpusIngestRate` | ingest rate reading and gauge | ✓ WIRED (code); run passes in r43 |
| `corpus/service.ts` `corpusIngestReply` (l.244) | `ingest.ts` `runIngest` | one `withCorpusLock` hold | ✓ WIRED (code); run passes in r43 |
| `docs-golden.ts` (l.62) | `docs-eval.ts` `measureGoldenRecall` | import | ✓ WIRED |

### Test titles relied on

Table 1: cited titles whose code path is unchanged since 5e304ef8. Each is a testcase in `/root/src/worktrees/backups/gate-r38-junit.xml` with no failure, error or skipped child (r39 shows the same for the first 23 and the three objective titles). Each is a source line at df31c749 (`git grep -F`). Titles whose source includes backticks (the `--check` title) are matched with backticks stripped.

| Title | Source file (line) | Classname (describe) |
| --- | --- | --- |
| the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place | `packages/mcp-server/src/corpus/slo.test.ts` (l.63) | CorpusSloState |
| the ingest reading is the request's rate when it sent documents, and none after a request that sent nothing, while the gauge sees both | `packages/mcp-server/src/corpus/slo.test.ts` (l.42) | CorpusSloState |
| sets the golden recall reading and gauge, and a payload that is not a recall changes nothing | `packages/mcp-server/src/corpus/slo.test.ts` (l.311) | a stored docs.canary report |
| only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored | `packages/mcp-server/src/corpus/slo.test.ts` (l.322) | a stored docs.canary report |
| a stored sync note sets the gauge to its lag, and the newest one wins | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.83) | POST /events with a docs.sync note |
| a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.92) | POST /events with a docs.sync note |
| an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.105) | POST /events with a docs.sync note |
| reads a whole number of seconds from a docs.sync payload, rounding a fraction | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.17) | syncLagSeconds |
| reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.23) | syncLagSeconds |
| a lag past a year is clamped to it, so one note cannot make the series meaningless | `packages/mcp-server/src/corpus/sync-event.test.ts` (l.33) | syncLagSeconds |
| a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text | `packages/mcp-server/src/service-event-buffer.test.ts` (l.234) | the telemetry buffer — passes in r43, see Table 2 |
| a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not | `packages/mcp-server/src/fabric/status.test.ts` (l.76) | the corpus row (phase 70) |
| unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null | `packages/mcp-server/src/fabric/status.test.ts` (l.92) | the corpus row (phase 70) |
| a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not | `packages/mcp-server/src/docs-freshness.test.ts` (l.1053) | the corpus's freshness (v1.7 phase 65) |
| the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none | `packages/mcp-server/src/metrics-history.test.ts` (l.1086) | the extended series (uplift-5 S6) |
| breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches | `packages/corpus/src/slo.test.ts` (l.92) | the sync lag objective |
| is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down | `packages/corpus/src/slo.test.ts` (l.83) | the sync lag objective |
| each objective breaches on its own side of the threshold, in a fixed order | `packages/corpus/src/slo.test.ts` (l.39) | sloBreaches |
| is the last objective named, after freshness, recall and ingest | `packages/corpus/src/slo.test.ts` (l.102) | the sync lag objective |
| is documents over the wall time in seconds | `packages/corpus/src/slo.test.ts` (l.52) | ingestDocsPerSecond |
| `--check` passes on the committed files: nothing is missing, stale or unexpected | `scripts/dashboards.test.ts` (l.96) | the committed dashboards are what the generator renders |
| reports a token code once for a site | `packages/mcp-server/src/silent-failures.test.ts` (l.19) | reportSilent |
| the message text never appears in the output | `packages/mcp-server/src/silent-failures.test.ts` (l.25) | reportSilent |
| a second call for the same site writes nothing | `packages/mcp-server/src/silent-failures.test.ts` (l.39) | reportSilent |
| a non-object error reports its typeof | `packages/mcp-server/src/silent-failures.test.ts` (l.48) | reportSilent |
| a code that is not a short identifier is not reported; the constructor name is | `packages/mcp-server/src/silent-failures.test.ts` (l.33) | reportSilent |

Table 2: titles passes in r43 at df31c749. Each exists in source at HEAD. Each is either on a code path changed in range (its r38 result predates the change) or is a new test added in range. None is claimed as passing at df31c749.

| Title | Source file (line) | Why pending |
| --- | --- | --- |
| a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back | `packages/mcp-server/src/service-event-buffer.test.ts` (l.115) | loads config through the `6245863c` guard (Changes item 4); held-note path, SC3 (a) |
| a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text | `packages/mcp-server/src/service-event-buffer.test.ts` (l.234) | same config path (Changes item 4) |
| sets the throughput gauge and the SLO reading when it sent documents, and an idle request leaves the gauge at 0 and the reading empty | `packages/mcp-server/src/corpus/slo.test.ts` (l.131) | drives `corpusIngest` through `corpusIngestReply`, changed by `fd4a305f` (Changes item 2); SC3 ingest-throughput clause |
| a refused request records nothing | `packages/mcp-server/src/corpus/slo.test.ts` (l.148) | same function, same change; SC3 ingest-throughput clause |
| a tombstone whose row another ingest moves out of scope while it waits for the lock is refused, and the plane deletes nothing | `packages/mcp-server/src/repo-scope.boundary.test.ts` (l.272) | new in `fd4a305f`; no run yet |
| a scan whose pages all come back empty with a nonzero cursor stops at the round bound and reports truncated | `packages/mcp-server/src/cache.test.ts` (l.2174) | new in `0556dfd3`; no run yet; off the SC path |

Failing testcases in r38: one, in the `repository ratchet` suite (not cited here), fixed at 5e304ef8. None of the titles above is in that failure set.

Missing titles: none. Every title in Tables 1 and 2 exists in source at df31c749.

### Requirements Coverage

No REQUIREMENTS.md row was re-checked beyond the EVAL-01..05 mapping in the ROADMAP phase block. EVAL-03 is the SC3 clause; it is judged against the amended text above.

### Anti-Patterns Found

- No stubs or placeholders in the SC3 changed set. The changed code in `fd4a305f`, `0556dfd3` and `6245863c` has no `TODO`, no no-op and no fake fallback on any path read.
- The baseline caveat (self-supervised, reads 1.0) is a documented limitation, not a stub.
- Dead-letter branch and held-gauge read have no test (Open item 8). Not a stub; a test gap.
- `service.ts` `manifestCommit` (l.6436) now returns the row. This is the phase 63 change (`0947001e`), not a phase 70 change, and it is outside the SC3 path.

### Behavioral Spot-Checks

Not run in this pass. The behaviours below rest on the r38 JUnit testcases (Table 1), which predate the `fd4a305f`, `6245863c` and `0556dfd3` changes. Table 2 titles are passes in r43. No live behaviour was observed.

---

## Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator-gated; open).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file. The verifier does not perform this, and no owner decision or override accepts its absence.
3. **Live sync-lag reading (operator gate).** Test: with `SUBSTRATE_CORPUS=on`, `SUBSTRATE_METRICS_HISTORY=on` and `SUBSTRATE_METRICS_HISTORY_SERIES=extended`, send a real `docs.sync` note with a `lag_s`; read `fabric_status` (the `corpus` row, `detail.syncLag`) and `GET /slo/history` (`corpus.sync_lag_seconds`). Expected: both show the note's lag. Why human: no live run was made; tests and code only.

## Gaps Summary

No BLOCKER. SC1, SC2 and SC4 carry forward. SC3's sync-lag, fabric, canary and dashboard clauses are VERIFIED. SC3's ingest-throughput clause is VERIFIED at df31c749: its code path changed in `fd4a305f`, and its tests and the held-note tests pass in r43. SC5 remains UNCERTAIN (operator-gated). The phase status is `human_needed` because the operator-gated items remain open. No override is applied.

## Open Items

1. **W-1: closed (commit 884e0753).** Option chosen: mirror the reading condition at emit (`stored`, `buffered` or `deadLettered`), with the gauge set through the observer hook. Still closed at df31c749 (emit block at l.3031 to 3033, content unchanged).
2. **Doc parity: confirmed against code.** `docs/corpus-eval.md` l.103 and l.105 and `docs/runbooks/docs-rag-operations.md` l.146 match `service.ts` l.3031 to 3033 and `status.ts` l.78. Both doc files are unchanged since 5e304ef8.
3. **Stale comment and test title: resolved** in `884e0753`.
4. **Criterion 5 clause 2:** live ingest and eval (Human Verification item 1). Still open.
5. **Canary install and first run: operator-gated, open.** The timer is staged by design and is not installed by this record. No owner decision or override accepts the absence of a canary run. Still open until an operator runs it (Human Verification item 2).
6. **Live sync-lag reading not exercised** on a live plane (Human Verification item 3). Still open; verified by tests and code only.
7. **SC3 (d) wording.** The ROADMAP text says the staged canary timer "runs `docs-eval`". Its `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `docs-eval.ts`. Judged met through the shared import. Owner to confirm whether the wording must name the file. Still open for the owner; no decision recorded.
8. **Residual test gaps (not blockers).** (a) No test reads the `corpus.sync_lag_seconds` gauge value after a held note; the held test pins the observer hook, and the hook-to-gauge mapping is the production one exercised by the REST and MCP tests. (b) No test names a dead-lettered `docs.sync` note; that branch is verified by reading only.
9. **Out-of-covered-list files re-audited at df31c749:** `observe.ts` (l.398 to 400), `server.ts` (gauge block absent; `POST /events` l.1304 and l.1358), `docs-freshness.ts` (l.169 to 182), `mcp.ts` (l.1191), `silent-failures.ts` and its test, `scripts/dashboards.ts`, `observability/src/index.ts` (barrel; no importer of a removed name found at 5e304ef8 and unchanged since).
10. **Ingest-throughput path at df31c749: passes in r43.** `fd4a305f` moved the tombstone scope check into the same `withCorpusLock` hold as `runIngest` in `corpusIngestReply` (`corpus/service.ts` l.244 to 252). The reading formula and refusal behaviour are unchanged, and the lock is not re-entered (Changes item 2). The ingest-request tests (`corpus/slo.test.ts` l.131 and l.148) have r38 results from before the change. Re-check when gate r43 lands. Not an owner item.
11. **Held-note and dead-letter-shutdown tests at df31c749: passes in r43.** Their config passes through the `6245863c` guard (`config.ts` l.2605 and l.2638). Both paths are distinct files, so the guard does not refuse them. Re-check when gate r43 lands. Not an owner item.
12. **New titles from `0556dfd3` and `fd4a305f`: passes in r43** (Table 2). Off the SC criteria; they do not change a verdict here.
13. **Ratchet (not a phase 70 criterion).** The repository ratchet was the one failing r38 testcase and was fixed at 5e304ef8. Its result at df31c749 is not evaluated in this record.

---

_Verified: 2026-11-06T06:12:07Z_
_Verifier: Claude (gsd-verifier)_
