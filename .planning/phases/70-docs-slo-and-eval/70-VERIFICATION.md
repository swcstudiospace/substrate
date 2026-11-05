---
phase: 70-docs-slo-and-eval
verified: 2026-11-05T08:41:40Z
status: human_needed
score: 4/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:3af0e84cbb7dc3dedc82223c2b4591fa4a2c36be51643504d07320301bd71359"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 3/5 must-haves verified
  gaps_closed: ["W-1: the sync-lag series now follows the same note reading as fabric_status. Substrate.emit reports the lag it recorded through the observer hook syncLag, and the production observer sets corpus.sync_lag_seconds from it, for stored, held and dead-lettered notes, whether they came from REST or MCP (commit 884e0753). The SC3 series clause is verified."]
  gaps_remaining: []
  regressions: []
  digest_refresh: "covered_digest changes from v3:sha256:7f89b8d5... (6e5d766e) to v3:sha256:3af0e84c... (884e0753). This is not a regression. Two covered files changed in 884e0753: docs/corpus-eval.md (4 lines) and packages/mcp-server/src/corpus/slo.ts (8 lines). The prior record's statement that no covered file changed is wrong for this head and is corrected here. The runbook is covered and is net-unchanged against 6e5d766e (bb6b38b7 added a sentence and 884e0753 removed it). aef8a351, on top of 884e0753, changes only the covered_digest lines of 13 other phase records; it touches no covered file and no code."
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
**Verified:** 2026-11-05T08:41:40Z
**Status:** human_needed
**Re-verification:** Yes. Head 884e0753 (prior record at 6e5d766e, status human_needed, 3/5). SC3 re-audited from code and tests after the W-1 fix. SC1, SC2 and SC4 carried forward: their covered files are unchanged, and the one covered-file change (`corpus/slo.ts`, a comment and return value) is on the SC3 path. SC5 unchanged. `aef8a351` is on top of 884e0753 and changes only other records' digest lines.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `884e0753`. Worktree clean at verification time. `aef8a351` (digest refresh, 13 other records, no code, no covered file) sits on top of it.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block). The SC3 text is the amended one (`Amended 2026-11-05 by owner decision: fabric_status is the contract for sync lag and the canary judges recall only`). No PLAN files exist for this phase.
- Covered-file fingerprint: `gsd_run query verification.fingerprint .planning/phases/70-docs-slo-and-eval <23 covered files>` at 884e0753. The 23 files are the prior record's list, verbatim, and the output is `v3:sha256:3af0e84c...`. `covered_files` and `covered_digest` in the frontmatter are copied from that output.
- Drift since the prior record (`git diff 6e5d766e..HEAD -- <23 covered files>`): `docs/corpus-eval.md` (+2 −2, the sync-lag row and paragraph) and `packages/mcp-server/src/corpus/slo.ts` (+6 −2, `recordSyncLag` returns the lag and its comment). The runbook is net-unchanged. The prior record's "drift scope is empty" claim does not hold for this head.
- Changes since the prior record, checked against SC3 surfaces:
  - `884e0753` fix(70): the sync-lag gauge is set where the reading is set.
    - `packages/mcp-server/src/service.ts` `emit` (l.3008 to 3011): for a `stored`, `buffered` or `deadLettered` result it calls `this.corpusSlo.recordSyncLag(result.event.payload)` (l.3009), and when that returns a lag it calls `this.observer.syncLag?.({ seconds })` (l.3010).
    - `packages/mcp-server/src/service.ts` observer interface (l.1058 to 1060): new optional hook `syncLag?(sample: { seconds: number })`.
    - `packages/mcp-server/src/observe.ts` (l.398 to 400): the production observer maps `syncLag` to `instruments.setCorpusSyncLag(sample.seconds)`.
    - `packages/mcp-server/src/corpus/slo.ts` `recordSyncLag` (l.68 to 76): returns the recorded lag, or null.
    - `packages/mcp-server/src/server.ts`: the REST gauge block and its import are deleted. Grep finds no `setCorpusSyncLag`, `syncLagSeconds` or `recordSyncLag` in `server.ts`; `POST /events` calls `substrate.emit` (l.1298 onward).
    - Docs: `docs/corpus-eval.md` l.103 and l.105; `docs/runbooks/docs-rag-operations.md` l.146.
  - `aef8a351` (after 884e0753): digest lines of 13 other records only. Not in this record's scope.
  - `b4bdd0fc` (held-note reading, prior record), `a4a9a8f0` (sync-lag SLO), `49b9aece`, `d1a5e89b`, `b4fe6bfe`, `bd5c287a`, `docs/corpus.md`, `docs/reconcile.md`, the dispatcher `worktree.py`: unchanged in this pass; checked as in the prior record.
- Postgres: none. None of the test files below references `SUBSTRATE_TEST_PG_URL`. No PG run was made.
- Named evidence, from gate r33 at 6e5d766e (`/root/src/worktrees/backups/gate-r33-junit.xml`), for the SC1, SC2 and SC4 suites: `scripts/docs-eval.test.ts` (33 tests, 0 failures), `scripts/docs-lint.test.ts` (23, 0), `scripts/planning-integrity.test.ts` (16, 0). Also from r33: `scripts/dashboards.test.ts` "the committed dashboards are what the generator renders" (`--check` passes on the committed files). Not rerun in this pass.
- Commands run in this record:
  - (T-A) `cd packages/mcp-server && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 src/corpus/sync-event.test.ts src/service-event-buffer.test.ts src/corpus/slo.test.ts src/docs-freshness.test.ts src/event-idempotency.test.ts`. Result at 884e0753: 142 pass, 0 fail, 679 expect() calls, 5 files. The assignment's figure of "94 + 75" was not reproduced as stated; this run's count is 142 over these same five files.
  - (T-B) The same two sync files with `--test-name-pattern sync`. Result: 7 pass, 0 fail. The seven are the three `syncLagSeconds` tests, the three `POST /events with a docs.sync note` tests and the held-note test. The pattern matches on describe names too.
  - Read-only: `git show`, `git diff`, `git log`, `grep`, `sed`, the fingerprint query, the status query.
  - Not run: full suite, `tsc`, lint, formatters, PG, docker, any database. The commit message reports `tsc` and biome clean and a mutation check (hook call removed: 4 failures; restored: all pass). Those are the author's reported results and were not rerun here.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Covered files `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts`, `scripts/docs-eval.test.ts` have no diff since 6e5d766e. `scripts/docs-eval.test.ts` 33 tests, 0 failures in r33. Wording note: the live flag is `--live URL`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged; `scripts/docs-eval.test.ts` passes in r33. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED (code and tests; W-1 closed) | Clause by clause, against the amended text. See the SC3 table below. The series now follows the same note reading as `fabric_status`, for REST, MCP, stored, held and dead-lettered notes. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 6e5d766e; `docs-lint` 23 tests and `planning-integrity` 16 tests, 0 failures, in r33. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (operator-gated) | The runbook is net-unchanged since 6e5d766e. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. |

**Score:** 4/5 must-haves verified (SC1, SC2, SC3, SC4). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### SC3 re-audit, clause by clause

| Clause (amended text) | Evidence | Status |
| --- | --- | --- |
| (a) Sync lag is a metric series | `corpus.sync_lag_seconds`: `packages/mcp-server/src/metrics-history.ts` l.166 (extended tier, max per step) and l.421 (gauge source); gauge `setCorpusSyncLag` in `packages/observability/src/instruments.ts` l.679, metric `substrate.corpus.sync_lag_seconds` l.734. Test: `metrics-history.test.ts` "the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none" (l.1086, row at 120). | ✓ VERIFIED |
| (a) Threshold in a flag | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`: `packages/corpus/src/slo.ts` l.49 (`loadSloThresholds`, whole number of 1 or more, no default); flag entry `packages/mcp-server/src/flag-registry.ts` l.898. | ✓ VERIFIED |
| (a) Series and reading agree for every note the server takes | Single path. `service.ts` `emit` l.3008 to 3010: `stored`, `buffered` or `deadLettered` calls `corpusSlo.recordSyncLag` and then `observer.syncLag`. `observe.ts` l.398 to 400 is the only production caller of `setCorpusSyncLag` (grep). REST: `server.ts` `POST /events` calls `substrate.emit`, and the gauge block is gone. MCP: `mcp.ts` l.1190 calls `substrate.emit`. Tests: see the named tests below. | ✓ VERIFIED |
| (a) REST stored note sets the series | Test "a stored sync note sets the gauge to its lag, and the newest one wins" (`sync-event.test.ts`, under describe "POST /events with a docs.sync note"). Uses `createObservability` and the production observer, then reads `observability.instruments.snapshot()`. | ✓ VERIFIED (exercised, T-B) |
| (a) MCP stored note sets the series | Test "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`sync-event.test.ts`). | ✓ VERIFIED (exercised, T-B) |
| (a) Held note sets the reading and the series path | Test "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts` l.115). Asserts `readings.syncLagS` is 4000 at buffer time; the observer hook records `[4000]` at buffer time; after the drain the reading is still 4000 and the hook has still been called once (`toEqual([4000])`). So the hook is not called again on drain. | ✓ VERIFIED (exercised, T-A and T-B) |
| (a) Held note reaches the gauge value | The test pins the observer hook with a test observer. The hook-to-gauge mapping is the production one in `observe.ts`, exercised for stored notes by the REST and MCP tests. No test reads the gauge value for a held note end to end. | ✓ VERIFIED by code and test together (residual, see Open items 8) |
| (a) Dead-lettered note sets the reading and the series path | Same branch as held (`result.deadLettered` in `service.ts` l.3008). The dead-letter results come from `service.ts` l.3163 and l.3247. No test names a dead-lettered `docs.sync` note. | ✓ VERIFIED by reading; not exercised by a test |
| (a) A note the server did not take leaves the series | REST refused case: `POST /events` answers 503 and the gauge stays null. Test "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" (`sync-event.test.ts`). Code: a refused note has neither `stored`, `buffered` nor `deadLettered`, so the `if` at `service.ts` l.3008 does not run. | ✓ VERIFIED |
| (b) `fabric_status` reports a breach | `packages/mcp-server/src/fabric/status.ts` `corpusRow` (l.75 onward): `syncLag` in `detail` (l.84); breach `sync` in `breaches`; row `degraded` with `source: "corpus.slo: breached ..."`. Unset: shown with no verdict. Tests: "a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not" and "unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null" (`fabric/status.test.ts` l.76 and l.92). Row judged only while `SUBSTRATE_CORPUS` is on (`status.ts` l.78, `enabled`). | ✓ VERIFIED |
| (b) Breach and threshold read in the objective module | `packages/corpus/src/slo.ts` "breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches" (l.92) and "is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down" (l.83). | ✓ VERIFIED |
| (c) Canary judges recall only | `scripts/docs-golden.ts` has no reference to a sync reading or lag (the case-insensitive `sync` hits are `readFileSync`, `renameSync`, `writeFileSync`, `statSync`, `readdirSync`). It posts `golden_recall5` only (`packages/mcp-server/src/corpus/slo.ts` `recordGolden`). Tests: `corpus/slo.test.ts` l.311 "sets the golden recall reading and gauge, and a payload that is not a recall changes nothing" and l.322 "only the canary's own surface and runtime count: the same payload from another surface or runtime is ignored". | ✓ VERIFIED |
| (d) Staged canary timer runs `docs-eval` | `infra/vps/substrate-docs-canary.service` l.33: `ExecStart=... scripts/docs-golden.ts --live --emit`. `scripts/docs-golden.ts` l.62 and l.731 import and call `measureGoldenRecall` from `docs-eval.ts`. Unchanged from the prior record; see Open items 7. | ✓ VERIFIED (through the shared import) |
| (e) Dashboards draw it, regenerated | Panel "Corpus sync lag" at `infra/vps/dashboards/substrate-data-planes.json` l.2890, series `corpus.sync_lag_seconds`, from `scripts/dashboards.ts` l.310. `--check` passes on the committed files (r33). | ✓ VERIFIED (not rerun in this pass) |

### W-1 (closed): the series and the reading disagreed for held and REST/MCP notes

The prior record found that `corpus.sync_lag_seconds` was set only from the REST route, for a stored note, while `fabric_status` took held and dead-lettered notes at buffer time. Commit `884e0753` resolves this at the emit seam:

- Option chosen: mirror the reading condition at emit, and not the REST-only widening. `Substrate.emit` owns the decision for every route, so REST, MCP and held notes reach the gauge the same way. The REST gauge block in `server.ts` is removed.
- Held notes: the reading is set at buffer time through `recordSyncLag`, and the series is set at the same point through the `syncLag` hook. The drain does not call the hook again, and the held test pins that.
- The docs describe the code as it is: `docs/corpus-eval.md` l.103 and l.105, and `docs/runbooks/docs-rag-operations.md` l.146.
- The stale "stored note" comment in `recordSyncLag` is updated.
- Residual, not a blocker: the held-note gauge value is pinned through the observer hook and the same production mapping used by the REST test. No single test reads the gauge after a held note. Dead-letter has no test of its own (Open items 8).

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 (earlier) owns the docs.freshness route; it is cited as evidence for SC3 (b), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold (l.49); `sloBreaches` `sync` breach (l.64 to 65); unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag` (l.68 to 76) now returns the recorded lag or null; comment says a note the server took (stored, held or dead-lettered). `readings().syncLagS`. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail (l.84); breach named `sync`. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step (l.166); gauge source (l.421). |
| `packages/observability/src/instruments.ts` | `setCorpusSyncLag` | ✓ VERIFIED | One unlabelled gauge; non-finite and negative dropped. Production caller: `observe.ts` l.399 only, through the observer. |
| `packages/mcp-server/src/service.ts` | emit seam and observer hook | ✓ VERIFIED | `emit` l.3008 to 3010; observer hook `syncLag?` l.1060. Not a covered file; re-audited here. |
| `packages/mcp-server/src/observe.ts` | production observer maps `syncLag` to the gauge | ✓ VERIFIED | l.398 to 400. Not a covered file; re-audited here. |
| `packages/mcp-server/src/server.ts` | REST route | ✓ VERIFIED | Gauge block and import removed; `POST /events` calls `substrate.emit`. Not a covered file. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` adds `sync_lag`; test-covered (`docs-freshness.test.ts`, 0 failures in T-A). Not in the covered list. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Reads `recall5` only; no sync reading. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED | Staged, not installed (operator step). `ExecStart` is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898). `flag-registry.test.ts` 26 tests, 0 failures in r33. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel, regenerated | ✓ VERIFIED | Panel at json l.2890; `--check` passes on the committed files (r33). Not in the covered list. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` (l.3008 to 3010) | `corpus/slo.ts` `recordSyncLag` | stored, buffered or dead-lettered `docs.sync` note | ✓ WIRED |
| `service.ts` `emit` (l.3010) | `observe.ts` `syncLag` to `instruments.setCorpusSyncLag` | observer hook, production observer | ✓ WIRED |
| `server.ts` `POST /events` | `service.ts` `emit` | `substrate.emit` (REST) | ✓ WIRED |
| `mcp.ts` `events_emit` (l.1190) | `service.ts` `emit` | `substrate.emit` (MCP) | ✓ WIRED |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` (l.7536 to 7542) | `docs-freshness.ts` `corpusFreshnessRow` | `docsSlo.syncLagS` and the corpus sync reading | ✓ WIRED |
| `docs-golden.ts` | `docs-eval.ts` `measureGoldenRecall` | import (l.62) | ✓ WIRED |

### Requirements Coverage

No REQUIREMENTS.md row was re-checked beyond the EVAL-01..05 mapping in the ROADMAP phase block. EVAL-03 is the SC3 clause; it is judged against the amended text above.

### Anti-Patterns Found

- No stubs or placeholders in the SC3 changed set.
- Stale comment: resolved. `recordSyncLag` (`corpus/slo.ts`) and the observer hook comment (`service.ts` l.1058 to 1060) say the note the server took.
- Stale test title: resolved in `884e0753`. The `corpus/slo.test.ts` sync title reads "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place" (l.63).
- Doc parity: confirmed against code (see Open items 2).
- The baseline caveat (self-supervised, reads 1.0) remains a documented limitation, not a stub.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Held `docs.sync` note sets the reading; lands once after drain with the reading unchanged; hook called once | T-A and T-B (`service-event-buffer.test.ts`, "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back") | pass | ✓ PASS |
| REST stored note sets the gauge; newest wins | T-B (`sync-event.test.ts`, "a stored sync note sets the gauge to its lag, and the newest one wins") | pass | ✓ PASS |
| REST refused note leaves the gauge alone | T-B (`sync-event.test.ts`, "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone") | pass | ✓ PASS |
| MCP stored note sets the same gauge | T-B (`sync-event.test.ts`, "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored") | pass | ✓ PASS |
| `syncLagSeconds` reading rules | T-B (`sync-event.test.ts`, describe "syncLagSeconds", three tests) | pass | ✓ PASS |
| Five-file SC3 set | T-A: `sync-event`, `service-event-buffer`, `corpus/slo`, `docs-freshness`, `event-idempotency` | 142 pass, 0 fail, 679 expect() | ✓ PASS |
| Series for a held note, read as a gauge value | Not run end to end. Hook pinned by test; mapping read in `observe.ts` | Same mapping as the REST test | ✓ PASS by code and test |

### Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator gate).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file.
3. **Live sync-lag reading (operator gate).** Test: with `SUBSTRATE_CORPUS=on`, `SUBSTRATE_METRICS_HISTORY=on` and `SUBSTRATE_METRICS_HISTORY_SERIES=extended`, send a real `docs.sync` note with a `lag_s`; read `fabric_status` (the `corpus` row, `detail.syncLag`) and `GET /slo/history` (`corpus.sync_lag_seconds`). Expected: both show the note's lag. Why human: no live run was made; tests and code only.

### Gaps Summary

No BLOCKER. SC3 is VERIFIED against the amended text: the series and the reading now come from one emit seam for REST, MCP, stored, held and dead-lettered notes. SC5 remains UNCERTAIN (operator-gated). The phase status is `human_needed` because the operator items remain.

### Open Items

1. **W-1: closed (commit 884e0753).** Option chosen: mirror the reading condition at emit (`stored`, `buffered` or `deadLettered`), with the gauge set through the observer hook. The REST-only widening was not taken.
2. **Doc parity: confirmed against code.** `docs/corpus-eval.md` l.103 and l.105 and `docs/runbooks/docs-rag-operations.md` l.146 say the gauge is set by each `docs.sync` note the server took (stored, held or dead-lettered), whatever `SUBSTRATE_CORPUS` says, and that the row judges it only while the corpus is on. This matches `service.ts` l.3008 to 3010 and `status.ts` l.78.
3. **Stale comment and test title: resolved** in `884e0753`.
4. **Criterion 5 clause 2:** live ingest and eval (Human Verification item 1). Still open.
5. **Canary install and first run:** operator gate (Human Verification item 2). Still open; the timer is staged by design.
6. **Live sync-lag reading not exercised** on a live plane with a real `docs.sync` note (Human Verification item 3). Still open; verified by tests and code only.
7. **SC3 (d) wording.** The ROADMAP text says the staged canary timer "runs `docs-eval`". Its `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `docs-eval.ts`. Judged met through the shared import; owner to confirm whether the wording must name the file. Still open.
8. **Residual test gaps (not blockers).** (a) No test reads the `corpus.sync_lag_seconds` gauge value after a held note; the held test pins the observer hook, and the hook-to-gauge mapping is the production one exercised by the REST and MCP tests. (b) No test names a dead-lettered `docs.sync` note; that branch is verified by reading only.
9. **Out-of-covered-list files re-audited:** `packages/mcp-server/src/service.ts` (emit l.3008 to 3010, hook l.1060), `packages/mcp-server/src/observe.ts` (l.398 to 400), `packages/mcp-server/src/server.ts` (gauge block removed), `packages/mcp-server/src/docs-freshness.ts`, `docs-freshness.test.ts`, `service-event-buffer.test.ts`, `sync-event.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/metrics-history.test.ts`, `packages/mcp-server/src/mcp.ts` (l.1190), `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`. They are not in `covered_files`; they are covered here by the named tests and by reading.

---

_Verified: 2026-11-05T08:41:40Z_
_Verifier: Claude (gsd-verifier)_
