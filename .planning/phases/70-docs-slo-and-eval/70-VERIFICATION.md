---
phase: 70-docs-slo-and-eval
verified: 2026-11-05T08:00:11Z
status: human_needed
score: 3/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:7f89b8d527e5c3546fa1fa086fb861b80a2e2e06a9ba88300148088a3857025d"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  digest_refresh: "none. covered_digest is unchanged at 6e5d766e (a6ba22af...); no covered file differs between 42e3cf13 and 6e5d766e. The re-audit finding W-1 is not a regression of a covered file: the held-note reading path (b4bdd0fc, service.ts) is outside the covered list and was added after the prior record."
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
warnings:
  - id: W-1
    truth: "SC3 clause (a): sync lag is a metric series with its SLO threshold in flags"
    finding: "The corpus.sync_lag_seconds series and its gauge are set only for a stored docs.sync note. A note held in the buffer or given up with a dead-letter record sets the fabric_status reading (b4bdd0fc) but not the series, and nothing sets the gauge when the held note later lands. The series therefore disagrees with fabric_status during a ledger outage and stays wrong after the drain."
    status: "UNCERTAIN (WARNING, human decision requested)"
human_verification:
  - test: "Criterion 5 clause 2 on a live plane: on a host with SUBSTRATE_CORPUS=on and the LightRAG backend, ingest this checkout's docs/ under SUBSTRATE_DOCS_EVAL_REPO, then run substrate corpus eval --root /root/src/repos --server \"$SUBSTRATE_URL\" --json."
    expected: "The runbook question and its heading questions are scored; the runbook's key is in the top 5."
    why_human: "Needs a live plane and a real ingest. Nothing in code asserts it."
  - test: "Canary install and first run (operator gate; the timer is staged, not installed)."
    expected: "Journal line golden recall@5 <value> over <n> questions, exit 0, and fabric_status corpus row shows recall5.reading."
    why_human: "Host install and a secret-bearing env file; not in this repository."
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-05T08:00:11Z
**Status:** human_needed
**Re-verification:** Yes. Head 6e5d766e (prior record at 42e3cf13). SC3 re-audited against the buffered path (b4bdd0fc) and the amended canary text (ROADMAP, 2026-11-05). SC1, SC2 and SC4 carried forward: no covered file changed. SC5 unchanged.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `6e5d766e`.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block). The SC3 text is the amended one (`Amended 2026-11-05 by owner decision: fabric_status is the contract for sync lag and the canary judges recall only`). No PLAN files exist for this phase.
- Covered-file fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/70-docs-slo-and-eval <23 covered files>` run at `6e5d766e`. The 23 files are the prior record's list, verbatim, and the output is the same `covered_digest`. `covered_files` and `covered_digest` above are copied from that output (the list includes `70-SUMMARY.md`).
- Drift scope: `git diff 42e3cf13..HEAD -- <23 covered files>` is empty. The prior record's covered list is unchanged, so every SC1, SC2, SC4 and SC5 artifact is byte-identical to 42e3cf13.
- Changes since the prior record, checked against SC3 surfaces:
  - `b4bdd0fc` fix(70): `packages/mcp-server/src/service.ts` `emit` (l.3006) now calls `corpusSlo.recordSyncLag` for `stored`, `buffered` and `deadLettered` results. Audited: this is the held-note path behind W-1. The `corpusFreshness` wiring (l.7531 to 7537) is unchanged.
  - `a4a9a8f0` (the sync-lag SLO commit) is an ancestor of 42e3cf13, so it was already in the prior record. Re-audited anyway, since it is the SC3 surface.
  - `6e5d766e` docs: the ROADMAP SC3 amendment date (2026-11-04 to 2026-11-05) and the record refreshes. No behavior change.
  - `49b9aece` (event-buffer, shutdown record), `d1a5e89b` (cache breaker), `b4fe6bfe` (worktree free space), `bd5c287a` (record refresh), `docs/corpus.md`, `docs/reconcile.md`, the dispatcher `worktree.py`: checked by file list. None is on an SC3 reading, series, row or canary path. The buffered note's reading is set at buffer time, so the shutdown record does not change it.
- Postgres: none. None of the eight test files below references `SUBSTRATE_TEST_PG_URL`. No PG run was made.
- Named evidence, from gate r33 at 6e5d766e (`/root/src/worktrees/backups/gate-r33-junit.xml`, no `<skipped/>` on any SC3 testcase cited):
  - `a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back` (`packages/mcp-server/src/service-event-buffer.test.ts`, l.115, 4 assertions).
  - `a sync lag above its threshold is a breach named sync that degrades the row; a lag on the threshold or under it is not` and `unset, the sync lag is shown with no verdict: no threshold and no breach, whatever the lag, and an unmeasured lag reads null` (`packages/mcp-server/src/fabric/status.test.ts`, the corpus row (phase 70) suite).
  - `breaches only above the threshold: a reading on it holds, and an unset threshold or an unmeasured lag never breaches` and `is not set unless its flag is a whole number of 1 or more, and a fraction is rounded down` (`packages/corpus/src/slo.test.ts`, the sync lag objective suite).
  - `the sync lag is the lag of the newest stored docs.sync note that carries a usable one, and any other note leaves it in place` (`packages/mcp-server/src/corpus/slo.test.ts`, l.63).
  - `the corpus gauges are one row each at their reading, an idle ingest rate of 0 included, and an unset one has none` (`packages/mcp-server/src/metrics-history.test.ts`, l.1086; asserts the `corpus.sync_lag_seconds` row at 120).
  - `\`--check\` passes on the committed files: nothing is missing, stale or unexpected` (`scripts/dashboards.test.ts`, "the committed dashboards are what the generator renders").
  - SC1, SC2, SC4 suites: `scripts/docs-eval.test.ts` (33 tests, 0 failures), `scripts/docs-lint.test.ts` (23, 0), `scripts/planning-integrity.test.ts` (16, 0).
- Commands run in this record:
  - (T1) One non-PG `bun test` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000` over eight files: `packages/mcp-server/src/service-event-buffer.test.ts`, `packages/corpus/src/slo.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/metrics-history.test.ts`, `packages/mcp-server/src/docs-freshness.test.ts`, `scripts/dashboards.test.ts`, `packages/mcp-server/src/corpus/sync-event.test.ts`. Result: 214 pass, 0 fail, 2410 expect() calls.
  - Read-only: `git diff`, `git show`, `grep`, `sed`, the fingerprint query, the status query.
  - Not run: full suite, `tsc`, lint, formatters, PG, docker, any database.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Covered files `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts`, `scripts/docs-eval.test.ts` have no diff since 42e3cf13. `scripts/docs-eval.test.ts` 33 tests, 0 failures in r33. Wording note: the live flag is `--live URL`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged; `scripts/docs-eval.test.ts` passes in r33. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ⚠ UNCERTAIN (WARNING, W-1). Contract clauses VERIFIED; series clause not met for held notes | Clause by clause, against the amended text. See the SC3 table below. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 42e3cf13; `docs-lint` 23 tests and `planning-integrity` 16 tests, 0 failures, in r33. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (WARNING, operator-gated) | The runbook has no diff since 42e3cf13 in this run's covered set. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. |

**Score:** 3/5 must-haves verified (SC1, SC2, SC4). SC3 UNCERTAIN (WARNING W-1). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### SC3 re-audit, clause by clause

| Clause (amended text) | Evidence | Status |
| --- | --- | --- |
| (a) Sync lag is a metric series | `corpus.sync_lag_seconds`: `packages/mcp-server/src/metrics-history.ts` l.166 (extended tier, max per step) and l.421 (gauge source); gauge `setCorpusSyncLag` in `packages/observability/src/instruments.ts` l.679 to 681, metric `substrate.corpus.sync_lag_seconds` l.734. Test: `metrics-history.test.ts` l.1086 (row at 120). | ✓ VERIFIED for stored notes |
| (a) Threshold in a flag | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`: `packages/corpus/src/slo.ts` l.49 (`loadSloThresholds`, whole number of 1 or more, no default); flag entry `packages/mcp-server/src/flag-registry.ts` l.898. | ✓ VERIFIED |
| (a) Series and reading agree for every note the server takes | The reading is set at `packages/mcp-server/src/service.ts` l.3006: `if (result.stored \|\| result.buffered === true \|\| result.deadLettered === true) this.corpusSlo.recordSyncLag(...)`. The series is set only at `packages/mcp-server/src/server.ts` l.1361 to 1363: `if (result.stored) { ... setCorpusSyncLag(lag) }`. `setCorpusSyncLag` has no other caller (grep). | ⚠ UNCERTAIN (W-1) |
| (b) `fabric_status` reports a breach | `packages/mcp-server/src/fabric/status.ts` `corpusRow` (l.75 onward): `syncLag` in `detail`; breach `sync` in `breaches`; row `degraded` with `source: "corpus.slo: breached ..."`. Unset: shown with no verdict. Tests: `fabric/status.test.ts` (sync breach; unset, no verdict). | ✓ VERIFIED |
| (b) Held note sets the fabric reading | `service-event-buffer.test.ts` l.115: a held docs.sync note (4000 s) sets `readings.syncLagS` to 4000, and after the drain it lands once and the reading is still 4000. Named pass in r33 and in T1. | ✓ VERIFIED (behavior exercised) |
| (b) Dead-lettered note sets the reading | Same code path (`result.deadLettered`), `service.ts` l.3006. No test names a dead-lettered docs.sync note; the path is covered by the `bufferEvent` and `findPendingKeyed` branches only by code reading. | ✓ VERIFIED by reading; not exercised by a test |
| (b) A note the server did not take leaves the reading | `result.stored` false with neither flag falls through unchanged: `event-buffer.ts` refused branch (`buffered: false, recorded: false`) returns no flag. `service.ts` `bufferEvent` l.3230 to 3233. | ✓ VERIFIED by reading |
| (c) Canary judges recall only | `scripts/docs-golden.ts` has no reference to a sync reading or lag (the case-insensitive `sync` hits are `readFileSync`, `renameSync`, `writeFileSync`, `statSync`, `readdirSync`). It posts `golden_recall5` only (`packages/mcp-server/src/corpus/slo.ts` `recordGolden`). Test: `corpus/slo.test.ts` l.311 and l.322. | ✓ VERIFIED |
| (d) Staged canary timer runs `docs-eval` | `infra/vps/substrate-docs-canary.service` l.33: `ExecStart=... scripts/docs-golden.ts --live --emit`. `scripts/docs-golden.ts` l.62 and l.731 import and call `measureGoldenRecall` from `docs-eval.ts`. Carried from the prior record; see open item 7. | ✓ VERIFIED (through the shared import) |
| (e) Dashboards draw it, regenerated | Panel "Corpus sync lag" at `infra/vps/dashboards/substrate-data-planes.json` l.2890, series `corpus.sync_lag_seconds`, from `scripts/dashboards.ts` l.310. `--check` on the committed files passes (r33 and T1). | ✓ VERIFIED |

### W-1: held notes are not on the series

The reading and the series are two stores fed from one note, and they now disagree.

- `fabric_status` (the contract) includes a held or dead-lettered note at buffer time (`b4bdd0fc`). A ledger outage therefore shows the lag and can breach.
- `corpus.sync_lag_seconds` (the series and the dashboard panel) is set only in `server.ts` `POST /events` for `result.stored`. The buffered path never reaches it, and the drain does not set it when the held note lands.
- Result: during an outage the dashboard shows an old or absent lag while `fabric_status` shows the new one; after the drain the series never takes the held value. Nothing in the test set pins the series for a held note (`metrics-history.test.ts` seeds the gauge directly).
- Documentation (corrected 2026-11-05, docs only): `docs/corpus-eval.md` and the runbook now say the gauge is set by a stored note and that the `fabric_status` reading also follows held notes. They describe the split the code has; the W-1 choice in open item 1 decides whether the split stays.
- Scope of this finding: the contract clause says `fabric_status` is the contract for sync lag, so the breach itself is not wrong. The series clause is the remaining divergence, and the docs now state it. Classified as WARNING, not BLOCKER: the phase goal (measured, guarded in CI, operable) is not blocked, and no SC3 breach is missed.
- Not changed in code: the W-1 choice is the owner's (open item 1). The documentation was corrected on 2026-11-05.

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 (earlier) owns the docs.freshness route; it is cited as evidence for SC3 (b), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold (l.49); `sloBreaches` `sync` breach (l.64 to 65); unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED (doc drift, see open item 3) | `recordSyncLag`, `readings().syncLagS`. The `recordSyncLag` comment still says "A stored `docs.sync` note". |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail; breach named `sync`. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ⚠ UNCERTAIN (W-1) | Extended tier, max per step; the gauge is fed by stored notes only. |
| `packages/observability/src/instruments.ts` | `setCorpusSyncLag` | ✓ VERIFIED | One unlabelled gauge; non-finite and negative dropped. Single caller: `server.ts` l.1363 (stored only). |
| `packages/mcp-server/src/service.ts` | reading wiring for held notes | ✓ VERIFIED | l.3006 (b4bdd0fc). Not a covered file; re-audited here. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` adds `sync_lag`; test-covered (`docs-freshness.test.ts`, 48 tests, 0 failures in r33; 0 failures in T1). Not in the covered list. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Reads `recall5` only; no sync reading. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED | Staged, not installed (operator step). `ExecStart` is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898). `flag-registry.test.ts` 26 tests, 0 failures in r33. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel, regenerated | ✓ VERIFIED | Panel at json l.2890; `--check` passes on the committed files (r33 and T1). Not in the covered list. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` (l.3006) | `corpus/slo.ts` `recordSyncLag` | stored, buffered or dead-lettered `docs.sync` note | ✓ WIRED |
| `server.ts` `POST /events` (l.1361 to 1363) | `observability` `setCorpusSyncLag` | stored `docs.sync` note only | ⚠ PARTIAL (W-1): held notes not linked |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` (l.7531 to 7537) | `docs-freshness.ts` `corpusFreshnessRow` | `docsSlo.syncLagS` and the corpus sync reading | ✓ WIRED |
| `docs-golden.ts` | `docs-eval.ts` `measureGoldenRecall` | import (l.62) | ✓ WIRED |

### Requirements Coverage

No REQUIREMENTS.md row was re-checked beyond the EVAL-01..05 mapping in the ROADMAP phase block. EVAL-03 is the SC3 clause; it is judged against the amended text above.

### Anti-Patterns Found

- No stubs or placeholders in the SC3 changed set.
- Stale comment: corrected 2026-11-05. `recordSyncLag` in `packages/mcp-server/src/corpus/slo.ts` now says the note the server took (stored, held, or dead-lettered).
- Doc parity claim: corrected 2026-11-05. The docs describe the split the code has; W-1 stays open for the owner's choice.
- The baseline caveat (self-supervised, reads 1.0) remains a documented limitation, not a stub.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Held docs.sync note sets the reading; lands once after drain with the reading unchanged | `bun test` T1 (service-event-buffer.test.ts) | pass | ✓ PASS |
| SC3 targets (slo, corpus slo, fabric status, metrics history, docs-freshness, dashboards, sync-event) | T1 | 214 pass across the eight files, 0 fail, 2410 expect() calls | ✓ PASS |
| Series for a held note | Not run. Read only: `server.ts` l.1361 to 1363 | Series not set for held notes | ⚠ W-1 |

### Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator gate).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file.

### Gaps Summary

No BLOCKER. SC3 contract clauses are VERIFIED against the amended text. SC3 series clause is UNCERTAIN (WARNING W-1: held and dead-lettered notes set the fabric reading but not the `corpus.sync_lag_seconds` series, and the drain does not set it). SC5 remains UNCERTAIN (WARNING, operator-gated). The phase status is `human_needed`.

### Open Items

1. **W-1 decision (owner).** Either (a) mirror the reading condition at `server.ts` l.1361 (`stored`, `buffered` or `deadLettered`) and set the gauge when a held note lands, with a test that pins the series for a held note; or (b) accept the divergence and reword `docs/corpus-eval.md` and the runbook. Not applied here.
2. **Doc parity.** Resolved 2026-11-05: `docs/corpus-eval.md` and the runbook describe the split as the code has it. They change only if item 1 is decided.
3. **Stale comment.** Resolved 2026-11-05: `recordSyncLag` now says the note the server took.
4. **Criterion 5 clause 2:** live ingest and eval (Human Verification item 1).
5. **Canary install and first run:** operator gate (Human Verification item 2). The timer is staged by design.
6. **Live sync-lag reading not exercised** on a live plane with a real `docs.sync` note; the breach and the held-note reading are verified by tests, not by a live run.
7. **SC3 (d) wording.** The ROADMAP text says the staged canary timer "runs `docs-eval`". Its `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `docs-eval.ts`. Judged met through the shared import; owner to confirm whether the wording must name the file.
8. **Out-of-covered-list files re-audited:** `packages/mcp-server/src/service.ts` (b4bdd0fc), `server.ts` (the gauge path), `docs-freshness.ts`, `docs-freshness.test.ts`, `config.ts`, `fabric/types.ts`, `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`, and the slo, status, metrics-history and sync-event tests. They are not in `covered_files`; they are covered here by the named tests and by reading.

---

_Verified: 2026-11-05T08:00:11Z_
_Verifier: Claude (gsd-verifier)_
