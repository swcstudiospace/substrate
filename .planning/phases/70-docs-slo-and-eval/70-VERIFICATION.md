---
phase: 70-docs-slo-and-eval
verified: 2026-11-05T01:17:25Z
status: human_needed
score: 4/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:74d374bbbc35bef76fbbba992b041cd3030f2b890861d22a35ec7c426e0b49fa"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 3/5
  gaps_closed:
    - "Criterion 3 canary clause: the owner amendment (8e7cdbb1, 2026-11-04) makes fabric_status the contract for sync lag and the canary judges recall only; the shipped canary (scripts/docs-golden.ts) reads golden recall alone and names no sync reading"
    - "Sync-lag breach reaches the docs.freshness warning (42dcb4c6, SC5 of phase 65, owner decision 2026-11-04): docs-freshness.ts corpusFreshnessRow names sync_lag over SUBSTRATE_DOCS_SLO_SYNC_LAG_S; service.ts corpusFreshness passes the threshold"
  gaps_remaining: []
  regressions: []
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
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
**Verified:** 2026-11-05T01:17:25Z
**Status:** human_needed
**Re-verification:** Yes, after the owner amendment of criterion 3 (2026-11-04). Head ca9d02ec. The prior record (human_needed, 3/5, at c40ffc9a) held criterion 3 UNCERTAIN on the canary clause. The criterion text is now the amended one: `fabric_status` is the contract for sync lag and the docs canary judges retrieval recall only.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block). No PLAN files exist for this phase.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Regression check: `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts` and `scripts/docs-eval.test.ts` have no diff between c40ffc9a and ca9d02ec. Prior evidence stands. Wording note: the live flag is `--live URL`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged since c40ffc9a. Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED (amended 2026-11-04, owner decision c) | Clause by clause, against the amended text. (a) Series with flags: `corpus.ingest_docs_per_s` (`SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`, `packages/corpus/src/slo.ts` `loadSloThresholds` l.53 and `sloBreaches` l.63), `corpus.golden_recall5` (`SUBSTRATE_DOCS_SLO_RECALL5`), `corpus.sync_lag_seconds` (`SUBSTRATE_DOCS_SLO_SYNC_LAG_S`, `packages/corpus/src/slo.ts` `loadSloThresholds` l.48 to 56, `sloBreaches` l.59 to 67); series in `packages/mcp-server/src/metrics-history.ts` l.163 to 166 and l.418 to 421, metric names in `packages/observability/src/instruments.ts` l.734 to 738; all four flags in `packages/mcp-server/src/flag-registry.ts` and `docs/config-reference.md`. (b) `fabric_status` is the sync contract: `corpusRow` in `packages/mcp-server/src/fabric/status.ts` reads `readings.syncLagS` and `thresholds.syncLagS`, names `breached sync` and sets `detail.syncLag`; `recordSyncLag` (`corpus/slo.ts` l.69 to 72) is called on each stored `docs.sync` note at `service.ts` l.2961. (c) Canary recall only: `scripts/docs-golden.ts` reads `loadSloThresholds(io.env).recall5` alone (l.629 to 630) and contains no sync reading (no `lag` or `sync` match apart from the import). (d) Staged timer runs docs-eval: `infra/vps/substrate-docs-canary.service` `ExecStart` runs `scripts/docs-golden.ts --live --emit`, which imports `measureGoldenRecall` from `scripts/docs-eval.ts` (`docs-golden.ts` l.62, l.731); the timer `infra/vps/substrate-docs-canary.timer` is staged (`OnCalendar=*-*-* 04:41:00 UTC`, install is an operator step). The unit does not name `docs-eval.ts` in its command line; the clause is judged met by that shared code path. (e) The `docs.freshness` route (42dcb4c6) judges the same sync objective: `corpusFreshnessRow` in `packages/mcp-server/src/docs-freshness.ts` l.175 to 198 adds `sync_lag` when `syncLag > syncLagMaxS`; `service.ts` `corpusFreshness` passes `docsSlo.syncLagS`. Tests run this session (targeted `bun test`, 6 files, 191 pass, 0 fail): `packages/mcp-server/src/fabric/status.test.ts` l.76 to 89 (a lag over 3600 is `breached sync`; on or under is not), `packages/corpus/src/slo.test.ts` l.84 to 95, `packages/mcp-server/src/docs-freshness.test.ts` l.1053 to 1103 (sync over objective raises the warning; age plus sync; sync alone; unset judges no sync), `packages/mcp-server/src/metrics-history.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `scripts/dashboards.test.ts` (panel for `corpus.sync_lag_seconds`). Not exercised: a live plane with a real `docs.sync` note; the row is tested as a pure function. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since c40ffc9a. Prior evidence stands. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (WARNING, operator-gated) | The runbook has no diff since c40ffc9a. Clauses 1 and 2 of the runbook text are unchanged. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. |

**Score:** 4/5 must-haves verified (SC1, SC2, SC3, SC4). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### Deferred Items

None. Step 9b: no phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 (earlier) owns the docs.freshness route; it is cited as evidence for criterion 3 (e), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold; `sloBreaches` `sync` breach; unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag`, `readings().syncLagS`. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail; breach named `sync`. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step; gauge source wired. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` adds `sync_lag`; test-covered (42dcb4c6). Not in the covered list; see Open Items. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Reads `recall5` objective alone; no sync reading. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED | Staged, not installed (operator step). `ExecStart` is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry present. |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel | ✓ VERIFIED | Panel present; not in the covered list. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` | `corpus/slo.ts` `recordSyncLag` | stored `docs.sync` note | ✓ WIRED (l.2961) |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` | `docs-freshness.ts` `corpusFreshnessRow` | `docsSlo.syncLagS` and the corpus sync reading | ✓ WIRED |
| `docs-golden.ts` | `docs-eval.ts` `measureGoldenRecall` | import (l.62) | ✓ WIRED |

### Requirements Coverage

No REQUIREMENTS.md row was re-checked this run beyond the EVAL-01..05 mapping already in the ROADMAP phase block. EVAL-03 is the criterion 3 clause; it is judged against the amended text above.

### Anti-Patterns Found

None in the SC3 changed set. The prior baseline caveat (self-supervised, reads 1.0) remains a documented limitation, not a stub.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| SC3 targeted tests (slo, corpus slo, fabric status, docs-freshness, metrics-history, dashboards) | `bun test` on the six files | 191 pass, 0 fail, 2331 expect() calls | ✓ PASS |

### Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator gate).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file.

### Gaps Summary

No BLOCKER. Criterion 3 is VERIFIED against the amended text: the canary clause was resolved by the owner amendment (8e7cdbb1), and the sync-lag clauses are implemented and tested, including the docs.freshness route (42dcb4c6). Criterion 5 remains UNCERTAIN (WARNING, operator-gated), so the phase status is `human_needed`.

### Open Items

1. Criterion 5 clause 2: live ingest and eval (Human Verification item 1).
2. Canary install and first run: operator gate (item 2). The timer is staged by design.
3. Live sync-lag read is not exercised: the `corpus` row breach is verified by pure-function tests, not on a live plane with a real `docs.sync` note.
4. The covered list is used verbatim per the orchestrator. SC3 changed files outside it, covered by this run's targeted tests and not by `covered_digest`: `packages/mcp-server/src/docs-freshness.ts` (42dcb4c6), `packages/mcp-server/src/docs-freshness.test.ts`, `packages/mcp-server/src/service.ts`, `packages/mcp-server/src/config.ts`, `packages/mcp-server/src/fabric/types.ts`, `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`, `packages/corpus/src/slo.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/metrics-history.test.ts`. Re-run `verification.fingerprint` with them added if the owner wants them in the covered set.
5. The timer's `ExecStart` runs `scripts/docs-golden.ts`, not `scripts/docs-eval.ts` by name. Criterion 3 (d) is judged met through the shared `measureGoldenRecall` import. Owner to confirm if the wording must name the file.
6. The covered digest changed from the prior record (`v3:sha256:69abc8f0...` at c40ffc9a) to `v3:sha256:74d374bb...` at ca9d02ec, because the covered files changed in waves 6 and 7.

---

_Verified: 2026-11-05T01:17:25Z_
