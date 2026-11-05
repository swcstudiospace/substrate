---
phase: 70-docs-slo-and-eval
verified: 2026-11-05T00:14:00Z
status: human_needed
score: 3/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:69abc8f069c1ea4012f43f2067cbcb6724b56a8503f279420e485c69732628c6"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "Sync lag is an SLO metric: SUBSTRATE_DOCS_SLO_SYNC_LAG_S threshold, corpus.sync_lag_seconds metrics-history series, a sync reading and a sync breach on the corpus row of fabric_status (a4a9a8f0; dashboard and flag-registry comment db4f98f6)"
  gaps_remaining: []
  regressions: []
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Owner decision on the canary clause of criterion 3: should the docs canary report a sync-lag breach, or is the corpus row of fabric_status the whole contract?"
    expected: "A recorded decision. If the canary must report it, the canary has to read a sync reading (it currently reads golden recall only, scripts/docs-eval.ts l.446)."
    why_human: "Criterion 3 text names the canary; the owner decision of 2026-11-04 (commit a4a9a8f0) scopes the sync breach to the corpus row. Scope is the owner's call, not the code's."
  - test: "Live sync-lag objective: on a host with SUBSTRATE_CORPUS=on, SUBSTRATE_DOCS_SLO_SYNC_LAG_S set and a stored docs.sync note whose lag_s exceeds it, read fabric_status."
    expected: "The corpus row is degraded with source corpus.slo: breached sync, detail.syncLag shows the reading and the threshold; GET /slo/history returns corpus.sync_lag_seconds points when SUBSTRATE_METRICS_HISTORY=on and the extended tier is set."
    why_human: "Needs a live plane, a real sync note and an operator environment. Nothing in this repository runs it."
  - test: "The eval finds the runbook (SC5 clause 2)."
    expected: "The question 'Runbook: docs RAG operations (v1.7 phase 70)' and its heading questions are scored, and the runbook's document key is in the top 5 for them."
    why_human: "Needs a live plane and a real ingest under SUBSTRATE_DOCS_EVAL_REPO. Nothing in code asserts it."
  - test: "Canary install and first run (operator gate)."
    expected: "Journal line golden recall@5 <value> over <n> questions, exit 0, and fabric_status corpus row shows recall5.reading."
    why_human: "Host install and a secret-bearing env file; not in this repository."
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-05T00:14:00Z
**Status:** human_needed
**Re-verification:** Yes, after gap closure. The prior record (`gaps_found`, 3/5, at 504da465) failed criterion 3 on the sync-lag clause. This run is at head c40ffc9a. Criterion 3's sync-lag clauses are implemented and tested (SC3 scope only; the rest is carried forward).

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, lines 1222 to 1226). No PLAN files exist for this phase.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Regression check: `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts` and its test are unchanged since 504da465 (`git diff --stat 504da465 HEAD` lists none of them). Prior evidence stands: `generateGolden` (l.203), `recallAtK` (l.316), `mrr` (l.327), `scoreRun` (l.356). Wording note: the live flag is `--live URL`, not `--execute`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged since 504da465. Prior evidence: `scripts/docs-eval.test.ts` doctored-re-rank tests. Residual caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` and the docs canary report a breach; the staged canary timer runs `docs-eval` | ? UNCERTAIN (WARNING, owner decision requested) | Sync-lag clauses VERIFIED by code and tests. Threshold: `loadSloThresholds` reads `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` (`packages/corpus/src/slo.ts` l.48 to 56); unset means no objective. Breach: `sloBreaches` pushes `sync` when the lag is above the threshold; a reading on the threshold holds (`slo.ts` l.59 to 67). Reading: `CorpusSloState.recordSyncLag` (`packages/mcp-server/src/corpus/slo.ts` l.68 to 72), called on each stored event at `service.ts` l.2961. The CLI posts `{action: "docs.sync", lag_s}` (`packages/cli/src/corpus/events.ts` l.46 to 51), and `syncLagSeconds` reads only that shape (`packages/mcp-server/src/corpus/sync-event.ts`). Series: `corpus.sync_lag_seconds` in the extended tier (`packages/mcp-server/src/metrics-history.ts`, max per step, plus `EXTENDED_GAUGE_SOURCES`). Corpus row: `corpusRow` (`fabric/status.ts` l.84) reports the `syncLag` detail and `corpus.slo: breached sync`. Tests run here: `packages/corpus/src/slo.test.ts` ("the sync lag objective", 3 tests), `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/fabric/status.test.ts` l.76 to 89, `packages/mcp-server/src/metrics-history.test.ts` l.1092 to 1095 (all passed, see Run 1). Dashboard: `scripts/dashboards.ts` draws the series, and `infra/vps/dashboards/substrate-data-planes.json` carries the panel; `scripts/dashboards.test.ts` 21 of 21 pass (Run 2). **Open clause:** the docs canary (`scripts/docs-eval.ts` l.446) judges only golden recall at 5 (`freshness` and `ingest` are null there too). It never reads the sync lag. The owner decision of 2026-11-04 (commit a4a9a8f0) places the sync breach on the corpus row of `fabric_status`, but criterion 3 names the canary as well. Owner decides; see Human Verification item 1. |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 504da465. Prior evidence stands (docs-lint 23 tests passed in the prior record's Run 1). |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (WARNING, operator-gated) | Runbook sections for deploy, first ingest, timers and rollback are unchanged in substance by wave 6. The only runbook edit since 504da465 (a4a9a8f0, around line 146) updates the `corpus` row's `detail` description and the SLO thresholds list to include `syncLag` and `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 3. |

**Score:** 3/5 must-haves verified (SC1, SC2, SC4). SC3 UNCERTAIN (canary clause, owner decision), SC5 UNCERTAIN (operator). `behavior_unverified: 0`.

### Deferred Items

None. Step 9b: no phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names sync lag, the canary, the golden set or the runbook.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold; `sloBreaches` `sync` breach; unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag`, `readings().syncLagS`. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail; breach named `sync`. |
| `packages/mcp-server/src/fabric/types.ts` | `SloLine.threshold` nullable | ✓ VERIFIED | Not in covered list; see Gaps Summary. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step; gauge source wired. |
| `packages/mcp-server/src/flag-registry.ts` | flag entry | ✓ VERIFIED | Comment counts four objectives (db4f98f6). |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel | ✓ VERIFIED | Panel present; `dashboards.test.ts` 21 of 21 pass. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` emit | `CorpusSloState.recordSyncLag` | stored `docs.sync` event | ✓ WIRED | `service.ts` l.2961. |
| CLI `docs.sync` note | `syncLagSeconds` | `payload.lag_s` | ✓ WIRED | `packages/cli/src/corpus/events.ts` l.46 to 51. |
| `loadSloThresholds` | `corpusRow` | `config.docsSlo` through `fabric/gather.ts` l.164 | ✓ WIRED | Threshold reaches the row. |
| `server.ts` sync note | `setCorpusSyncLag` gauge | `syncLagSeconds` | ✓ WIRED | `packages/mcp-server/src/server.ts` l.1362 (gauge, pre-existing). |
| canary (`scripts/docs-eval.ts`) | sync breach | `sloBreaches` with no sync reading | ✗ NOT_WIRED | Canary has no sync reading. Owner decision (criterion 3 canary clause). |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpusRow` `syncLag` | `readings.syncLagS` | `CorpusSloState.syncLag`, set from stored `docs.sync` notes | Yes (set only by a stored note; null until one) | ✓ FLOWING |
| `corpus.sync_lag_seconds` series | gauge `CORPUS_SYNC_LAG_METRIC` | `server.ts` l.1362 | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Sync-lag objective: parse, breach on threshold, unset = no verdict, last objective named; corpus row; series | `bun test packages/corpus/src/slo.test.ts packages/mcp-server/src/corpus/slo.test.ts packages/mcp-server/src/fabric/status.test.ts packages/mcp-server/src/metrics-history.test.ts scripts/dashboards.test.ts` | 143 pass, 0 fail, 5 files | ✓ PASS |
| Dashboards: four files up to date, sync panel built | `bun test scripts/dashboards.test.ts` | 21 pass, 0 fail | ✓ PASS |

Run 1 covered the five files above in one command (143 tests). Run 2 re-ran `scripts/dashboards.test.ts` alone (21 tests). Non-PG targeted runs; two commands in total. No `SUBSTRATE_TEST_PG_URL` was set (database: none for this item).

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

Not re-mapped in this run. The requirement IDs (EVAL-01 to EVAL-05) are listed in `70-SUMMARY.md` and the ROADMAP; criterion 3 status is as above.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (SC3 added lines in a4a9a8f0, db4f98f6) | - | grep of TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER | - | None found. |
| `scripts/docs-eval.baseline.json` | - | self-supervised baseline at 1.0 | ℹ️ Info | Known, unchanged. |

### Human Verification Required

1. **Owner decision: canary clause of criterion 3.**
   - Test: Decide whether the docs canary must report a sync-lag breach, or whether the corpus row of `fabric_status` is the contract (as the 2026-11-04 owner decision states).
   - Expected: A recorded decision. If the canary must report it, the canary must read a sync reading.
   - Why human: Scope of a success criterion is the owner's call.
2. **Live sync-lag objective.**
   - Test: On a host with `SUBSTRATE_CORPUS=on`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` set, and a stored `docs.sync` note with `lag_s` above it, read `fabric_status`.
   - Expected: The `corpus` row is `degraded`, source `corpus.slo: breached sync`, `detail.syncLag` shows reading and threshold. With `SUBSTRATE_METRICS_HISTORY=on` and the extended tier, `GET /slo/history` returns `corpus.sync_lag_seconds`.
   - Why human: Needs a live plane and a real sync note.
3. **The eval finds the runbook (SC5 clause 2).**
   - Test: On a host with `SUBSTRATE_CORPUS=on` and the LightRAG backend, ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO`, then run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`.
   - Expected: the runbook question and its heading questions are scored; the runbook's key is in the top 5.
   - Why human: needs a live plane and a real ingest.
4. **Canary install and first run (operator gate).**
   - Test: Install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, then `systemctl start substrate-docs-canary.service`.
   - Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and `fabric_status` `corpus` row shows `recall5.reading`.
   - Why human: host install and a secret-bearing env file.

### Gaps Summary

No BLOCKER. The sync-lag gap from the prior record is closed: the threshold flag, the series, the reading, the corpus-row breach and the dashboard panel exist and pass their tests. Two items are open and routed to human decision rather than counted as gaps:

- The canary clause of criterion 3 (owner decision, item 1).
- SC5 operator items (items 3 and 4).

Covered-list note: the covered list is the record's list, used verbatim per the orchestrator. SC3 changed files outside that list: `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`, `packages/mcp-server/src/config.ts`, `packages/mcp-server/src/fabric/types.ts`, `packages/mcp-server/src/service.ts`, `packages/corpus/src/slo.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/metrics-history.test.ts`. They are covered by the test runs in this record, not by `covered_digest`. Re-run `verification.fingerprint` with them added to refresh the digest if the owner wants them in the covered set.

---

_Verified: 2026-11-05T00:14:00Z_
_Verifier: Claude (gsd-verifier)_
