---
phase: 70-docs-slo-and-eval
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 4/5 success criteria hold in code (1, 4 carried from the 2026-11-18 record; 2 re-run this pass; 3 verified this pass; 5 partial: golden case verified, "the eval finds it" is live-only)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/phases/70-docs-slo-and-eval/70-CONTEXT.md", ".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/src/eval-lexical.test.ts", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval.test.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.test.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.test.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v4:sha256:b86a7fcfb8cf0407870629c404dc5c25fc1a4e0a6b4eb7fe6f4f322114578f42"
re_verification:
  previous_status: gaps_found
  previous_score: 4/5 in the working tree (2026-11-19 earlier pass); criterion 5 partial
  gaps_closed:
    - "Criterion 5, golden-case clause: scripts/docs-golden.test.ts, describe 'the golden set the eval asks about the milestone's runbooks', builds the question set from a real filesystem scan of docs/ (collectLocalDocuments on the repo root) and asserts a question whose expected key is swcstudiospace/agent-substrate:<runbook> for docs/runbooks/corpus-ingest.md, corpus-sync.md and docs-rag-operations.md. Passes in the run below."
    - "Criterion 3: the canary service (committed in 5ad894ec) runs bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden; runCanary checks freshness, ingest and recall at 5 through sloBreaches and exits 1 on a breach."
  gaps_remaining:
    - "Criterion 5, 'the eval finds it' clause: no offline run and no recorded live run shows each new runbook question at rank 5 or better. Live-only; listed under human_verification."
  regressions: []
human_verification:
  - test: "After a first live ingest of this checkout's docs under SUBSTRATE_DOCS_EVAL_REPO, run `SUBSTRATE_TOKEN=<bearer> bun scripts/docs-eval.ts --live <URL>` and read the rank of each runbook question."
    expected: "The questions for docs/runbooks/corpus-ingest.md, corpus-sync.md and docs-rag-operations.md appear in the run and the eval finds each at rank 5 or better."
    why_human: "Needs a live server, an ingested corpus and an operator window. This closes the 'the eval finds it' clause of criterion 5."
  - test: "On the host, after the drop-in is installed (SUBSTRATE_CORPUS=on, SUBSTRATE_DOCS_CANARY=1, the attested manifest, and an omp token that may read GET /corpus/status): run `systemctl start substrate-docs-canary.service` and read the journal."
    expected: "Lines `golden recall@5 <v> over <n> questions`, `corpus freshness <s> s` and `ingest <r> documents per second`. The unit fails when any of the three is past its objective."
    why_human: "Live production server and host timer. /corpus/status is repo-gated and refused to scoped callers (route-policy.ts), so the omp token scope decides whether freshness is read at all."
  - test: "Decide whether the canary's recall@5 should measure the same question set the golden test asserts over."
    expected: "Either CANARY_GOLDEN_MAX_QUERIES (200, scripts/docs-eval.ts:80) is set to LIVE_MAX_QUERIES (500), or the golden test also asserts a question for each runbook in the 200-question sample the canary asks."
    why_human: "A cost-versus-coverage choice for the operator. The test's comment that the canary and the test share 'the same cap' is wrong today."
  - test: "Decide whether a canary run with SUBSTRATE_CORPUS unset should stay silent (exit 0 on fixtures alone) or fail loudly."
    expected: "An explicit choice recorded in the runbook, with the drop-in setting SUBSTRATE_CORPUS=on."
    why_human: "Operator policy. measureSlo and measureGolden return null without a stderr line when the variable is off (W1)."
---

# Phase 70: Docs SLO and eval - Verification Report

**Phase Goal:** Measurement and guards: a self-supervised golden set, an offline CI harness, SLO series and thresholds, a docs lint and the operator runbook.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** Yes. Re-run after the golden-set test and the canary timer commits. Worktree `/root/src/worktrees/as-autonomous` (branch `gsd/autonomous-rerun`), HEAD `94607f93`, working tree clean.

## Test Run (one invocation)

`bun test scripts/docs-eval.test.ts scripts/docs-golden.test.ts --timeout 60000`: **83 pass, 0 fail**, 645 expect() calls, 7.9 s.

No other test, script or server was run. The docs lint (`scripts/docs-lint.test.ts`) is not re-run in this pass.

## Goal Achievement

### Success criteria (ROADMAP Phase 70)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `generateGolden` derives queries from titles and headings; `scoreRun` computes recall at k, MRR, latency; `docs-eval` runs live with `--execute`-era flags and offline otherwise | ✓ CARRIED | 2026-11-18 record, committed HEAD. Not re-run this pass. |
| 2 | Offline harness (lexical retriever over a fixture corpus) runs in `bun test` and fails on ranking, de-dup or re-rank regressions | ✓ VERIFIED | The offline tests in `scripts/docs-eval.test.ts` (the committed harness, and "what the harness catches") pass in the run above. |
| 3 | SLO metric series and thresholds; `fabric_status` and the canary report a breach; the staged canary timer runs `docs-eval` | ✓ VERIFIED IN CODE (live run not observed) | See "Criterion 3" below. |
| 4 | Docs lint: relative links and level-1 titles in `docs/` and `.planning/` | ✓ CARRIED | 2026-11-18 record. `scripts/docs-lint.test.ts` not re-run this pass. |
| 5 | Operator runbook covers deploy, first ingest, timers, rollback, proof commands; this milestone's documents are in the corpus with a golden case each, and the eval finds each | ⚠️ PARTIAL | Golden case: ✓ VERIFIED. "The eval finds it": live-only, not observed. See "Criterion 5" below. |

**Score:** 4/5 criteria hold in code. Criterion 5 is partial.

## Criterion 3: verified in code

- **Timer.** `infra/vps/substrate-docs-canary.timer` fires daily at 04:41 UTC and starts `substrate-docs-canary.service`.
- **Service command.** `infra/vps/substrate-docs-canary.service:36` is `ExecStart=/root/.local/share/reflex/bun/bin/bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden`. `fixtures/docs-golden/` exists with `corpus/` and five fixture JSON files.
- **Argument parsing.** `scripts/docs-eval.ts` `parseArgs` (lines 307-315): `--emit` with `--live` alone and `--fixtures DIR` yields `{ mode: "canary", fixtures }`. Any other combination is a usage error.
- **Wiring.** `canaryIo` (`scripts/docs-eval.ts:426-449`) points the canary at `fixtures/docs-golden/corpus` and wires `measureGoldenRecall` and `readSloReadings`. `runCanary` (`scripts/docs-golden.ts:547`) then runs.
- **Freshness.** `readSloReadings` reads `GET /corpus/status` `lastIngestAt` and computes `freshnessS`.
- **Ingest.** `readSloReadings` reads the `CORPUS_INGEST_RATE_METRIC` gauge from `GET /metrics` and sets `ingestDocsPerS`.
- **Recall at 5.** `measureGoldenRecall` (`scripts/docs-eval.ts:466`) calls `askLive` with `CANARY_GOLDEN_MAX_QUERIES` (200) and returns `recall5`.
- **Breaches.** `sloBreaches({ freshnessS, recall5, ingestDocsPerS }, thresholds)` (`scripts/docs-golden.ts` near line 646). A breach prints a stderr line. Every exit path with no fixture failure returns `sloFailed ? 1 : 0`, and the paths that post or dedupe return 1.
- **Gate.** `measureSlo` and `measureGolden` return `null` unless `SUBSTRATE_CORPUS=on` (`scripts/docs-golden.ts` near lines 706 and 720). This is the operator-decision item (W1).
- **Tests.** The canary-entry tests (`scripts/docs-golden.test.ts`, around lines 571-660) drive recall through a fake `goldenRecall` and assert the stdout line and the posted note. They pass. The freshness and ingest branches were read, not separately exercised.

**Not observed:** no canary run, no drop-in, no timer installed. The drop-in that sets `SUBSTRATE_CORPUS=on` is not in the repository, by design.

## Criterion 5: golden case verified; "the eval finds it" not

- **Real scan.** `scripts/docs-golden.test.ts` describe "the golden set the eval asks about the milestone's runbooks" calls `collectLocalDocuments(REPO_ROOT, DEFAULT_EVAL_REPO)`, which walks `docs/` on disk (83 Markdown files, `scripts/docs-eval.ts:191`). It is not a constant.
- **Completeness.** `scan.incomplete` must be empty. Passes.
- **Per runbook.** For each of `docs/runbooks/corpus-ingest.md`, `corpus-sync.md` and `docs-rag-operations.md`, the test asserts the path is in the scan and that `generateGolden` (at `LIVE_MAX_QUERIES` = 500) produces a question whose `expected` or `alsoExpected` is `swcstudiospace/agent-substrate:<runbook>`. Passes.
- **Mutual import.** `docs-golden.ts` imports `measureGoldenRecall` from `docs-eval.ts`, and `docs-eval.ts` imports from `docs-golden.ts`. Both modules' top-level code uses only their own constants (`docs-golden.ts` 66-67, 133, 283, 415-421; `docs-eval.ts` 64-81). Cross-imports are used only inside functions (`docs-golden.ts:817`, `docs-eval.ts:426`). Both files load and pass. Safe.

**Warning W-cap (not a blocker).** The test comment at `scripts/docs-golden.test.ts:85` says the questions "`docs-eval --live` asks and the canary's recall measures: the same generator, the same cap." That is wrong. The canary caps at `CANARY_GOLDEN_MAX_QUERIES` = 200 (`scripts/docs-eval.ts:80`), and the test uses `LIVE_MAX_QUERIES` = 500. When unambiguous candidates exceed the cap, `generateGolden` samples with a seeded RNG (`packages/corpus/src/eval.ts`, the tail of `generateGolden`). The candidate count is at most about 249 (83 files × 3 per document), so the 200 cap can sample. [INFERENCE: the count is not measured here, since running the generator at 200 is outside this pass's permitted runs.] If it does, the canary may not ask a runbook question, and the test does not catch it. The live `docs-eval --live` path uses 500 and is covered.

**"The eval finds it" (not verified).** No offline run covers the runbooks: the offline harness uses the fixture corpus. The live run has not happened. This clause is human_needed.

## Other items

- **W1 silent skip.** With `SUBSTRATE_CORPUS` unset, the canary runs the fixtures only and exits 0 with no freshness, ingest or recall line.
- **W2 null readings.** Freshness is null before any ingest, ingest is null after a zero-document request, and recall is null on a partial scan. None is a breach. Each prints a stderr line only.
- **W3 freshness route scope.** `GET /corpus/status` is `GATED` in `packages/mcp-server/src/route-policy.ts:31` and refused to scoped callers. If the production `omp` token is scoped, freshness is never read. [INFERENCE: the token's scope was not checked.]
- **Committed state.** The canary and runCanary changes are committed (`5ad894ec`). The tree is clean.

## Human Verification Required

See the frontmatter `human_verification` list: the live ingest and rank check (criterion 5), the host canary run and the `omp` token scope (criterion 3, W3), the canary cap decision (W-cap), and the `SUBSTRATE_CORPUS` silent-skip policy (W1).

## Gaps Summary

No blocking gap in code. Criterion 3 holds in code and is confirmed by the canary path above. Criterion 5's golden-case clause holds and is asserted by a test that reads the real `docs/` tree. Its "the eval finds it" clause needs a live run. The status is `human_needed`, not `passed`, because human items remain. The cap mismatch in W-cap is a warning: the test certifies the 500-question set the live eval asks, not the 200-question set the canary measures.

Verification was read-only except for this record. One `bun test` invocation covered the two named files. Read-only greps covered the rest. No server, canary, timer or generator was started, and no repository source was edited.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
