---
phase: 70-docs-slo-and-eval
verified: 2026-11-04T22:34:08Z
status: gaps_found
score: 3/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:183fbf239295e7c85e7102cd45c414b7f28a40849ae582413439ea299d617638"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; fabric_status and the docs canary report a breach (ROADMAP phase 70, criterion 3)"
    status: failed
    reason: "Ingest throughput and freshness and retrieval quality are complete. Sync lag is not: the only artifact is the gauge substrate.corpus.sync_lag_seconds. It has no SLO threshold flag, no metrics-history series, and no corpus-row breach check."
    artifacts:
      - path: "packages/mcp-server/src/flag-registry.ts"
        issue: "Only SUBSTRATE_DOCS_SLO_FRESHNESS_S, SUBSTRATE_DOCS_SLO_RECALL5 and SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S exist (lines 895 to 897). No sync-lag threshold."
      - path: "packages/mcp-server/src/metrics-history.ts"
        issue: "Series at lines 161 to 163 and 415 to 417 are freshness, ingest rate and golden recall. No sync-lag series."
      - path: "packages/mcp-server/src/fabric/status.ts"
        issue: "corpusRow (line 75) judges the three SLO readings only. Sync lag is not in the corpus facts (fabric/gather.ts lines 161 to 166)."
      - path: "packages/observability/src/instruments.ts"
        issue: "CORPUS_SYNC_LAG_METRIC (line 734) is emitted at line 681 from event-sources.ts line 1550. It is an OTel gauge, not an SLO series."
    missing:
      - "A sync-lag reading in the corpus facts, an SLO threshold flag, a metrics-history series, and a degraded breach in corpusRow. Or an owner decision that amends criterion 3 (not decided in this record)."

deferred: []
advisory: []
coincidental_reliance_items: []
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-04T22:34:08Z
**Status:** gaps_found
**Re-verification:** No. The prior record `70-VERIFICATION.md` (2026-10-30, verified at 8af55c5e and d4cd350c) carries no `gaps:` block, so this is an initial-mode run at head 504da465.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, lines 1222 to 1226). The SUMMARY adds no PLAN must-haves because no PLAN files exist.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (wording differs) | `packages/corpus/src/eval.ts`: `generateGolden` (l.203), `recallAtK` (l.316), `mrr` (l.327), `percentile` (l.338), `scoreRun` (l.356) with `recall1/5/10`, `mrr`, `p50Ms`, `p95Ms`. `scripts/docs-eval.ts` header l.7 and l.23: the live flag is `--live URL`, not `--execute` as the ROADMAP says. Offline mode scores the lexical and server paths. Run 1 below: `packages/corpus/src/eval.test.ts` (29 tests) passed. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED | `scripts/docs-eval.test.ts` ran in Run 1 (0 fail). Doctored-re-rank tests pass: "a re-rank that puts the best hit last fails the comparison…" (l.165), "a re-rank that drops the leading hit fails it too" (l.174), "the shipped pipeline collapses every group of identical documents to its smallest key" (l.195). Thresholds: `RECALL5_TOLERANCE` 0.02 and `MRR_TOLERANCE` 0.03 (`scripts/docs-eval.ts` l.61, l.63). Residual caveat: `scripts/docs-eval.baseline.json` is unchanged since 8af55c5e and reads 1.0 on every metric (self-supervised). |
| 3 | Ingest throughput, sync lag and retrieval quality are SLO metric series with thresholds in flags; `fabric_status` and the docs canary report a breach; the staged canary timer runs docs-eval | ✗ FAILED (sync lag clause) | Verified: thresholds `SUBSTRATE_DOCS_SLO_FRESHNESS_S` (86400), `_RECALL5` (0.6), `_INGEST_DOCS_PER_S` (0.2), `flag-registry.ts` l.895 to 897; `loadSloThresholds` and `sloBreaches` in `packages/corpus/src/slo.ts`; series in `metrics-history.ts` l.161 to 163 and l.415 to 417; `corpusRow` reports `degraded` with `corpus.slo: breached freshness|recall5|ingest` (`fabric/status.ts` l.86 to 87; `packages/mcp-server/src/fabric/status.test.ts` l.45 to 51 passed in Run 2). Canary: `scripts/docs-golden.ts` l.630 to 645 returns 1 on `goldenBreached`; it posts `golden_recall5` (l.497, l.516). Wording: the canary timer's ExecStart is `scripts/docs-golden.ts --live --emit` (`infra/vps/substrate-docs-canary.service`), which calls `measureGoldenRecall` from `scripts/docs-eval.ts` (`docs-golden.ts` l.62, l.731). It shares docs-eval's code and does not invoke the docs-eval entry point. The unit is staged and not installed. Not verified: sync lag, see gaps. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED | `scripts/docs-lint.test.ts` ran in Run 1 (23 tests, 0 fail). The test "the committed documents ... have no broken relative link and every docs page and live planning file has a level-1 title" (l.163) passes on the committed tree. Archives are linted for links only (`scripts/docs-lint.ts` header l.6 to 8; test l.136). `scripts/planning-integrity.test.ts` passed in Run 2 with the legacy exemption list removed. Not verified: the ROADMAP's count of repaired links (42 and 8) was not reconciled. The test checks that zero broken links remain. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (WARNING, operator-gated) | Runbook part verified: sections 1 (deploy and rollback, `infra/vps/deploy-release.sh` exists), 4 (first ingest, rollback, check), 5 (timers, check, rollback), 10 (rollback table) each name a command and a check. Commands exist: `corpus scan|plan|ingest|eval|watch --once|reconcile` (`packages/cli/src/corpus/index.ts`), `scripts/doctor-units.ts`. Drift from 8af55c5e is resolved at HEAD (sync and reconcile units are in `infra/vps/`; `SUBSTRATE_DOCS_RERANK` is read in `packages/mcp-server/src/config.ts` l.1604). Golden case exists by construction: an offline read-only run of `generateGolden` over the checkout's 83 `docs/` files gave 248 queries, 3 of them for `docs/runbooks/docs-rag-operations.md`. "The eval finds it" was not observed. Nothing asserts it, and it needs a live ingest under `SUBSTRATE_DOCS_EVAL_REPO` with `SUBSTRATE_CORPUS=on`. |

**Score:** 3/5 truths verified (SC1, SC2, SC4). SC3 FAILED on sync lag. SC5 UNCERTAIN on "the eval finds it".

### Deferred Items

None. Step 9b: no phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names sync lag, the canary, the golden set or the runbook. The sync-lag gauge comes from phase 65, which is earlier and does not defer this gap.

### Advisory (New Scope, Unevidenced)

Not a re-verification. No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/eval.ts` | golden generator and scorer | ✓ VERIFIED | Exists, substantive, unchanged since 8af55c5e, exercised by Run 1. |
| `packages/corpus/src/eval-lexical.ts` | BM25 retriever with rerank hook | ✓ VERIFIED | Exercised by Run 1 (`eval-lexical.test.ts`). |
| `packages/corpus/src/eval-live.ts` | live runner | ✓ VERIFIED | Exists, unchanged since 8af55c5e. Live path not run (no plane). |
| `packages/corpus/src/slo.ts` | SLO thresholds and breach logic | ✓ VERIFIED | `slo.test.ts` passed in Run 1. |
| `packages/mcp-server/src/corpus/slo.ts` | server SLO state | ✓ VERIFIED | `corpus/slo.test.ts` passed in Run 2. |
| `packages/mcp-server/src/docs-eval-server.ts` | server search under test | ✓ VERIFIED | Exercised by the `server` baseline in `docs-eval.test.ts`. |
| `scripts/docs-eval.ts` + baseline + test | offline harness | ✓ VERIFIED | Run 1 (`docs-eval.test.ts`). |
| `scripts/docs-lint.ts` + test | docs lint | ✓ VERIFIED | Run 1 (`docs-lint.test.ts`). |
| `scripts/docs-golden.ts` | canary, `measureGolden` gated on `SUBSTRATE_CORPUS` | ✓ VERIFIED | Code read at l.627 to 666 and l.630 to 645. No test run. `docs-golden.test.ts` not run in this pass. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary unit | ✓ VERIFIED (staged) | Present. `ConditionPathExists` on the release's `scripts/docs-golden.ts`. Not installed, which is an operator step. |
| `packages/mcp-server/src/flag-registry.ts` | SLO flags | ✓ VERIFIED (3 flags) | No sync-lag flag. |
| `packages/mcp-server/src/metrics-history.ts` | corpus series | ✓ VERIFIED (3 series) | No sync-lag series. |
| `packages/mcp-server/src/fabric/status.ts` | `corpusRow` | ✓ VERIFIED | Breach tests pass (Run 2). |
| `packages/observability/src/instruments.ts` | corpus gauges | ✓ VERIFIED (4 gauges) | `CORPUS_SYNC_LAG_METRIC` is a gauge without an SLO. |
| `docs/runbooks/docs-rag-operations.md` | operator runbook | ✓ VERIFIED | 177 lines, sections 1 to 10, `Check.` lines in sections 1 to 6. Sections 7 and 9 give a command but no labelled check. Changed since 8af55c5e (+21 −14). |
| `docs/corpus-eval.md` | operator reference | ✓ VERIFIED | Present; links resolve (lint passed). |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/docs-golden.ts` | `scripts/docs-eval.ts` | `measureGoldenRecall` import (l.62), called l.731 | ✓ WIRED | Canary shares the docs-eval code path. |
| `scripts/docs-golden.ts` | `SUBSTRATE_CORPUS` | `measureGolden` gate (l.664 to 666) | ✓ WIRED | Matches `flag-registry.ts` `SUBSTRATE_CORPUS` text. |
| `fabric/gather.ts` | `fabric/status.ts` `corpusRow` | `facts.corpus` readings (gather.ts l.161 to 166) | ✓ WIRED | Readings come from `sources.corpus` behind `corpusEnabled`. |
| `infra/vps/substrate-docs-canary.service` | `scripts/docs-golden.ts` | `ExecStart` | ✓ WIRED | Path resolves inside the release. |
| `scripts/docs-lint.test.ts` | `scripts/docs-lint.ts` `lintDocs` | direct import | ✓ WIRED | Test run passed. |
| sync-lag gauge | SLO threshold, series, fabric row | none | ✗ NOT_WIRED | Emitted (`event-sources.ts` l.1550, `instruments.ts` l.681) and consumed by nothing else. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpusRow` | `readings.freshnessS`, `recall5`, `ingestDocsPerS` | `sources.corpus` (manifest read, canary `golden_recall5` note) | Yes when corpus on and measured | ✓ FLOWING. Null until measured, by design. |
| canary `golden_recall5` | `report.recall5` | `measureGoldenRecall` over this checkout's `docs/` | Yes at runtime | ✓ FLOWING in code. Not run live. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Eval, harness, lint, SLO unit tests | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 scripts/docs-eval.test.ts scripts/docs-lint.test.ts packages/corpus/src/eval.test.ts packages/corpus/src/eval-lexical.test.ts packages/corpus/src/slo.test.ts` (Run 1) | 103 pass, 0 fail, 587 expect() | ✓ PASS |
| SLO server, fabric status, metrics history, planning integrity | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/slo.test.ts packages/mcp-server/src/fabric/status.test.ts packages/mcp-server/src/metrics-history.test.ts scripts/planning-integrity.test.ts` (Run 2) | 118 pass, 0 fail, 862 expect() | ✓ PASS |
| Golden generator covers the runbook | read-only `bun` snippet calling `generateGolden` over `docs/**/*.md` (temp file removed) | 83 docs, 248 queries, 3 for the runbook | ✓ PASS |
| Canary live run, `--live URL`, `fabric_status` after ingest | not run: no plane, no ingest, no install | n/a | ? SKIP (operator) |

Both targeted runs are the two permitted for this pass. No full suite, tsc, lint or formatter was run.

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists and none is declared by the phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| EVAL-01 | 70-SUMMARY | Self-supervised golden set scored for recall at k, MRR and latency | ✓ SATISFIED | `eval.ts` generator and scorer; Run 1. |
| EVAL-02 | 70-SUMMARY | Offline harness guards ranking, dedupe and re-rank in CI | ✓ SATISFIED | `docs-eval.test.ts` in `bun test`; Run 1. The baseline is self-supervised (caveat). |
| EVAL-03 | 70-SUMMARY | Freshness, ingest throughput and retrieval quality are metrics with SLO thresholds in `fabric_status` and the canary | ✓ SATISFIED | Requirement text does not name sync lag. The three named readings are complete. The ROADMAP's sync-lag clause is the gap above. |
| EVAL-04 | 70-SUMMARY | Broken relative link or missing level-1 title fails a test | ✓ SATISFIED | `docs-lint.test.ts`; Run 1. |
| EVAL-05 | 70-SUMMARY | Runbook covers deploy, first ingest, timers, rollback and the check for each | ✓ SATISFIED | Runbook sections 1, 4, 5 and 10; commands exist. The ROADMAP's golden-case clause is not in EVAL-05 and is UNCERTAIN above. |

ORPHANED: none. All five EVAL requirements map to phase 70. Bookkeeping: `.planning/REQUIREMENTS.md` still shows `[ ]` on EVAL-01 to EVAL-05 (lines 74 to 78). Not changed here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (phase files, grep of TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) | - | none | - | No debt markers in the phase's files. |
| `scripts/docs-eval.baseline.json` | - | self-supervised baseline at 1.0 | ℹ️ Info | Known; the harness is guarded by doctored-re-rank tests, not by the baseline. |

### Human Verification Required

1. **The eval finds the runbook (SC5 clause 2).**
   - Test: On a host with `SUBSTRATE_CORPUS=on` and the LightRAG backend, ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO`, then run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`.
   - Expected: the question "Runbook: docs RAG operations (v1.7 phase 70)" and its heading questions are scored, and the runbook's document key is in the top 5 for them.
   - Why human: needs a live plane and a real ingest. Nothing in code asserts it.
2. **Canary install and first run (operator gate).**
   - Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, then `systemctl start substrate-docs-canary.service`.
   - Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and `fabric_status` `corpus` row shows `recall5.reading`.
   - Why human: host install and secret-bearing env file; not in this repository.

### Gaps Summary

One ROADMAP criterion is unmet. Criterion 3 requires sync lag to be an SLO metric with a threshold in flags, visible to `fabric_status` and the canary. At head 504da465 there is a sync-lag gauge (`substrate.corpus.sync_lag_seconds`, phase 65) and nothing that judges it. Either it gets a threshold, a series and a breach check, or the owner amends criterion 3. This record does not decide which.

Everything else the phase delivered is present and passing its tests. Between the prior record and head 504da465, the runbook drift is fixed (the sync, reconcile and canary units are in `infra/vps/`, `substrate corpus reconcile` exists, and the re-rank is wired). The eval code, the baseline and the lint are unchanged since 8af55c5e.

---

_Verified: 2026-11-04T22:34:08Z_
_Verifier: Claude (gsd-verifier)_
