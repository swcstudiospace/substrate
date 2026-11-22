---
phase: 70-docs-slo-and-eval
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 4/5 success criteria hold in code (1, 2, 4 carried from the 2026-11-18 record; 3 and 5 re-verified this pass by read-only inspection at HEAD ffacc938; 5 partial: golden case verified at the canary cap, "the eval finds it" is live-only)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/phases/70-docs-slo-and-eval/70-CONTEXT.md", ".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/src/eval-lexical.test.ts", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval.test.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.test.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.test.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:402147ab65e2f983e153245e47fa6eb40cd9486c40361efb667d057e98a62e77"
re_verification:
  previous_status: human_needed
  previous_score: 4/5 in the 2026-11-19 record at 94607f93; criterion 5 partial, W-cap and W1 open
  gaps_closed:
    - "W-cap: a7cab351 changes scripts/docs-golden.test.ts to generate the runbook golden set with CANARY_GOLDEN_MAX_QUERIES (200, scripts/docs-eval.ts:80) instead of LIVE_MAX_QUERIES (500), with the comment 'the same generator, the same cap as the canary sample'. The test now certifies the exact question set the canary measures (measureGoldenRecall calls askLive with CANARY_GOLDEN_MAX_QUERIES)."
    - "W1 (staged-unit silent skip): a7cab351 adds Environment=SUBSTRATE_CORPUS=on to infra/vps/substrate-docs-canary.service, so the staged timer unit no longer runs fixtures-only with exit 0. measureSlo/measureGolden still return null when SUBSTRATE_CORPUS is off (tested: 'nothing is read with SUBSTRATE_CORPUS off'), which is the intended design for standalone invocations."
  gaps_remaining:
    - "Criterion 5, 'the eval finds it' clause: no offline run and no recorded live run shows each new runbook question at rank 5 or better. Live-only; listed under human_verification."
  regressions: []
human_verification:
  - test: "After a first live ingest of this checkout's docs under SUBSTRATE_DOCS_EVAL_REPO, run `SUBSTRATE_TOKEN=<bearer> bun scripts/docs-eval.ts --live <URL>` and read the rank of each runbook question."
    expected: "The questions for docs/runbooks/corpus-ingest.md, corpus-sync.md and docs-rag-operations.md appear in the run and the eval finds each at rank 5 or better."
    why_human: "Needs a live server, an ingested corpus and an operator window. This closes the 'the eval finds it' clause of criterion 5."
  - test: "On the host, after the drop-in is installed (SUBSTRATE_CORPUS=on, SUBSTRATE_DOCS_CANARY=1, the attested manifest, and an omp token that may read GET /corpus/status): run `systemctl start substrate-docs-canary.service` and read the journal."
    expected: "Lines `golden recall@5 <v> over <n> questions`, `corpus freshness <s> s` and `ingest <r> documents per second`. The unit fails when any of the three is past its objective."
    why_human: "Live production server and host timer. /corpus/status is repo-gated and refused to scoped callers (route-policy.ts), so the omp token scope decides whether freshness is read at all (W3, unchanged)."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 70: Docs SLO and eval - Verification Report

**Phase Goal:** Measurement and guards: a self-supervised golden set, an offline CI harness, SLO series and thresholds, a docs lint and the operator runbook.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** Yes. Re-run after commits 5ad894ec (canary runs docs-eval --live --emit with fixtures; freshness and ingest breaches) and a7cab351 (canary sets SUBSTRATE_CORPUS=on; golden test uses the canary cap). Worktree `/root/src/worktrees/as-autonomous` (branch `gsd/autonomous-rerun`), HEAD `ffacc938`.

## Method

Read-only inspection only this pass: no tests, tsc, biome, knip or formatters were run (per assignment), and no server, canary, timer or generator was started. The previous pass ran `bun test scripts/docs-eval.test.ts scripts/docs-golden.test.ts` (83 pass, 0 fail) at 94607f93; the only code changes since are the two commits above, both read in full. Test assertions cited below are therefore present in the tree but not re-executed this pass.

## Goal Achievement

### Success criteria (ROADMAP Phase 70)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `generateGolden` derives queries from titles and headings; `scoreRun` computes recall at k, MRR, latency; `docs-eval` runs live with `--execute`-era flags and offline otherwise | ✓ CARRIED | 2026-11-18 record. Not re-run this pass (out of 3-5 scope). |
| 2 | Offline harness (lexical retriever over a fixture corpus) runs in `bun test` and fails on ranking, de-dup or re-rank regressions | ✓ CARRIED | 2026-11-18 record; offline tests in `scripts/docs-eval.test.ts` unchanged since 5ad894ec except the added canary-entry block. |
| 3 | SLO metric series and thresholds; `fabric_status` and the canary report a breach; the staged canary timer runs `docs-eval` | ✓ VERIFIED IN CODE (live run not observed) | See "Criterion 3" below. |
| 4 | Docs lint: relative links and level-1 titles in `docs/` and `.planning/` | ✓ CARRIED | 2026-11-18 record. `scripts/docs-lint.test.ts` (brokenRelativeLinks, missingTitle suites) present and unchanged; not re-run this pass. |
| 5 | Operator runbook covers deploy, first ingest, timers, rollback, proof commands; this milestone's documents are in the corpus with a golden case each, and the eval finds it | ⚠️ PARTIAL | Golden case at the canary cap: ✓ VERIFIED IN CODE. Runbook: ✓ sections present. "The eval finds it": live-only, not observed. See "Criterion 5" below. |

**Score:** 4/5 criteria hold in code. Criterion 5 is partial on its live clause only.

## Criterion 3: verified in code

- **Thresholds.** `packages/corpus/src/slo.ts`: `SLO_DEFAULTS` = freshness 86 400 s, recall5 0.6, ingest 0.2 docs/s, read from `SUBSTRATE_DOCS_SLO_FRESHNESS_S` / `SUBSTRATE_DOCS_SLO_RECALL5` / `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`; `sloBreaches` treats a `null` reading as no breach. `packages/corpus/src/slo.test.ts` covers defaults, flag parsing and each breach incl. exact-on-threshold.
- **fabric_status.** `packages/mcp-server/src/fabric/status.ts:79-88` runs the same `sloBreaches` over the readings and reports `degraded` naming the breached objectives — the metric series and the canary cannot disagree about a breach.
- **Timer.** `infra/vps/substrate-docs-canary.timer` fires daily at 04:41 UTC (staged, not installed; `Persistent=true`).
- **Service command.** `infra/vps/substrate-docs-canary.service` ExecStart is `bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden`, with `Environment=SUBSTRATE_CORPUS=on` (a7cab351; W1 closed for the staged unit) and `ConditionPathExists` on `scripts/docs-eval.ts`.
- **Entry parsing.** `scripts/docs-eval.ts` `parseArgs`: `--live --emit [--fixtures DIR]` yields `{ mode: "canary", fixtures }`; every other `--emit` combination is a usage error. `docs-eval.test.ts` "the canary entry (--live --emit)" covers this plus the exit-2 refusals (unconfigured, non-loopback `SUBSTRATE_URL`) and exit-3 unreadable manifest (added in 5ad894ec).
- **Wiring.** `canaryIo` in `docs-eval.ts` wires `goldenRecall` (`measureGoldenRecall`, which asks at `CANARY_GOLDEN_MAX_QUERIES` = 200) and `sloReadings` (`readSloReadings`) into `runCanary` in `scripts/docs-golden.ts`.
- **Readings.** `readSloReadings` reads `GET /corpus/status` `lastIngestAt` → `freshnessS` and the `CORPUS_INGEST_RATE_METRIC` gauge from `GET /metrics` → `ingestDocsPerS` (0/absent → null). `docs-golden.test.ts` "the SLO readings" exercises busy/idle/unsent/unreadable cases against a fake fetch with exact URLs, bearer and values.
- **Breaches.** `runCanary` computes `sloBreaches({ freshnessS, recall5, ingestDocsPerS }, thresholds)`, prints `golden recall@5 …`, `corpus freshness … s`, `ingest … documents per second` lines with objectives, and returns 1 on any breach (0 when clean). `docs-golden.test.ts` "a freshness or ingest breach fails the run by name…" covers stale→1, slow→1, lenient thresholds→0, failed read→0, and `SUBSTRATE_CORPUS` off→no read, exit 0.
- **Not observed:** no canary run, no drop-in installed, no timer enabled. The drop-in itself is an operator step by design.

## Criterion 5: golden case verified at the canary cap; "the eval finds it" not

- **Runbook.** `docs/runbooks/docs-rag-operations.md` has numbered sections: 1 Deploy, 2 Turn the corpus on, 3 First inventory and plan, 4 First ingest, 5 Sync and canary timers, 6 Re-rank, 7 Read the objectives, 8 What each alert means, 9 CI and the baseline, 10 Roll back step by step — with proof commands (`bun test`, `corpus eval`, `systemctl`, `deploy-release.sh rollback`) in each.
- **Real scan, at the canary cap.** `scripts/docs-golden.test.ts` describe "the golden set the eval asks about the milestone's runbooks" calls `collectLocalDocuments(REPO_ROOT, DEFAULT_EVAL_REPO)` over the real `docs/` tree, asserts `scan.incomplete` is empty, and — since a7cab351 — builds the question set with `generateGolden(scan.docs, { maxQueries: CANARY_GOLDEN_MAX_QUERIES })`, the exact cap `measureGoldenRecall` uses. For each of `docs/runbooks/corpus-ingest.md`, `corpus-sync.md`, `docs-rag-operations.md` it asserts the path is scanned and a question's `expected`/`alsoExpected` is `swcstudiospace/agent-substrate:<runbook>`. **W-cap is closed**: the old comment claiming the live (500) and canary caps matched is replaced by a true statement.
- **"The eval finds it" (not verified).** No offline run covers the runbooks (the offline harness uses the fixture corpus) and no live run has happened. This clause is human_needed.

## Other items

- **W2 null readings (unchanged).** Freshness null before any ingest, ingest null after a zero-document request, recall null on a partial scan; none is a breach. Each prints a stderr line only. Covered by the "the SLO readings" tests.
- **W3 freshness route scope (unchanged, live-only).** `GET /corpus/status` is `GATED` in `packages/mcp-server/src/route-policy.ts` and refused to scoped callers. If the production `omp` token is scoped, freshness is never read. Kept in human_verification item 2.
- **Committed state.** 5ad894ec and a7cab351 are ancestors of HEAD ffacc938; the tree was clean at inspection.

## Human Verification Required

See the frontmatter `human_verification` list: the live ingest and rank check (criterion 5 "the eval finds it") and the host canary run with the `omp` token scope (criterion 3, W3). The previous cap-decision and silent-skip operator items are closed by a7cab351 and removed.

## Gaps Summary

No blocking gap in code. Criterion 3 holds in code end-to-end (thresholds → fabric_status → canary → staged timer). Criterion 5's golden-case clause holds, now asserted at the exact cap the canary samples, and its runbook clause holds in the document. Only the live clauses remain, so the status is `human_needed`, not `passed`.

Verification was read-only except for this record. No test, script or server was run this pass; test assertions are cited from the tree.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
