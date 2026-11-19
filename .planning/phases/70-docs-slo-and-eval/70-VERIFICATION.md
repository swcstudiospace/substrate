---
phase: 70-docs-slo-and-eval
verified: 2026-11-19T00:00:00Z
status: gaps_found
score: 4/5 success criteria hold in the working tree (1, 2, 4 carried from the 2026-11-18 record and not re-run in this pass; 3 now verified; 5 partial)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/phases/70-docs-slo-and-eval/70-CONTEXT.md", ".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/src/eval-lexical.test.ts", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval.test.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.test.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.ts", "scripts/docs-lint.test.ts", "scripts/planning-integrity.test.ts", "scripts/docs-golden.test.ts"]
covered_digest: "v4:sha256:69a709849e87828c01e2a34d0109cd8e22809024e70816b1bf59b627f742e329"
re_verification:
  previous_status: gaps_found
  previous_score: 3 of 5 (2026-11-18, committed HEAD 17b93f58)
  gaps_closed:
    - "Criterion 3: the canary unit runs scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden (working tree, uncommitted); runCanary evaluates freshness, ingest and recall at 5 through sloBreaches and exits 1 on a breach"
  gaps_remaining:
    - "Criterion 5: no test asserts a golden case for docs/runbooks/docs-rag-operations.md or the other new runbooks; the live eval has not run"
  regressions: []
gaps:
  - truth: "SC5: docs/runbooks/docs-rag-operations.md covers deploy, first ingest, timers, rollback and proof commands, and the milestone's documents are in the corpus with a golden case each that the eval finds"
    status: partial
    reason: "The runbook exists. No test asserts a golden case per new runbook; the only test reference to docs-rag-operations.md is packages/mcp-server/src/fabric/optimize.test.ts. Golden coverage is by construction only, and the live eval has not run. Carried from the 2026-11-18 record and not re-run in this pass."
    artifacts:
      - path: "docs/runbooks/docs-rag-operations.md"
        issue: "Golden coverage of this runbook is not asserted by any test"
    missing:
      - "A test that builds the golden set from docs/ and asserts a question for each new runbook, or a recorded live eval that finds them at rank 5 or better"
deferred: []
human_verification:
  - test: "After a first live ingest of this checkout's docs, run `SUBSTRATE_TOKEN=<bearer> bun scripts/docs-eval.ts --live <URL>` and read the golden recall@5 and per-question misses"
    expected: "The runbooks written in this milestone produce questions, and the eval finds them at rank 5 or better"
    why_human: "Needs a live server, a corpus ingested under SUBSTRATE_DOCS_EVAL_REPO, and an operator window"
  - test: "On the host, after the drop-in is installed: run `systemctl start substrate-docs-canary.service` and read the journal"
    expected: "A line `golden recall@5 <value> over <n> questions`, a `corpus freshness` line and an `ingest` line; the unit fails when any of the three is past its objective"
    why_human: "Live production server and host timer; the drop-in must set SUBSTRATE_CORPUS=on, and the omp bearer must be able to read GET /corpus/status (route-policy marks it repo-gated for scoped callers)"
  - test: "Decide whether a canary run with SUBSTRATE_CORPUS unset is acceptable"
    expected: "A recorded decision. Today the freshness, ingest and golden checks are skipped without a stderr line, and the run exits 0 on the fixtures alone"
    why_human: "Operator policy; the code documents the gate but does not warn when it is closed"
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** Measurement and guards: a self-supervised golden set, an offline CI harness, SLO series and thresholds, a docs lint and the operator runbook.
**Verified:** 2026-11-19
**Status:** gaps_found
**Re-verification:** Yes, after gap closure of criterion 3 (working tree). Criteria 1, 2 and 4 are carried from the 2026-11-18 record and were not re-run in this pass.

## Criterion 3 (re-verified)

Criterion (ROADMAP.md phase 70, criterion 3): the timer runs `docs-eval`; the canary checks freshness, ingest and recall at 5 through `sloBreaches`; `fabric_status` and the canary report a breach.

| Check | Evidence | Result |
| --- | --- | --- |
| Timer runs docs-eval with --emit and --fixtures | `infra/vps/substrate-docs-canary.service:33` `ExecStart=… bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden`; `fixtures/docs-golden/` is tracked | VERIFIED (working tree only) |
| Argument parsing selects canary mode | `scripts/docs-eval.ts` `parseArgs`: `--emit` with `--fixtures DIR` and `--live` returns mode `canary` | VERIFIED |
| Canary runs docs-golden's checks with docs-eval's io | `canaryIo` in `scripts/docs-eval.ts` passes fetch, state, the fixture dir and `measureGoldenRecall` / `readSloReadings` into `runCanary` | VERIFIED |
| Freshness, ingest and recall at 5 through sloBreaches | `scripts/docs-golden.ts` `runCanary` builds `sloBreaches({freshnessS, recall5, ingestDocsPerS}, loadSloThresholds(env))` (`packages/corpus/src/slo.ts`) and names each breach on stderr | VERIFIED |
| Exit 1 on any breach | Every return path of `runCanary` returns 1 when a breach or a failing fixture exists; 0 only with neither | VERIFIED (read) |
| Freshness reading matches fabric_status | Canary: `now - lastIngestAt` from `GET /corpus/status`. Server: `corpus/slo.ts` `freshnessS` from `setLastChangeFrom(lastIngestAt)` (`service.ts:6820`), the same field (`store.ts:281`) | VERIFIED (same source) |
| Ingest reading matches fabric_status | Canary reads gauge `substrate.corpus.ingest_docs_per_second` from `GET /metrics`; the gauge is set in `setCorpusIngestRate` (`instruments.ts:700`) from `recordIngest`. The `/metrics` gauge shape (`{kind,name,points:[{value}]}`) matches `GaugeSnapshot` | VERIFIED |
| Unit tests | `bun test --timeout 60000 scripts/docs-eval.test.ts scripts/docs-golden.test.ts`: 79 pass, 0 fail, 2 files | VERIFIED |
| Entry points load and refuse with no network | `bun scripts/docs-eval.ts --live --emit --fixtures fixtures/docs-golden` and `bun scripts/docs-golden.ts --live --emit`, unconfigured: each exits 2 with the refusal; a non-loopback `SUBSTRATE_URL` also exits 2 | VERIFIED |

**Committed state:** the committed unit at HEAD (`17b93f58`) still runs `scripts/docs-golden.ts --live --emit` (line 33). The docs-eval wiring exists only in the uncommitted working tree, so criterion 3 holds once that change is committed.

### Mutual import (`docs-golden.ts` ↔ `docs-eval.ts`)

Safe at call time, as the code stands. `docs-golden.ts` imports `measureGoldenRecall` and a type from `docs-eval.ts`. `docs-eval.ts` imports `runCanary`, `readSloReadings`, `writeStateAtomically`, `DEFAULT_CANARY_STATE`, `CORPUS_DIR` (as `GOLDEN_CORPUS_DIR`) and the `GoldenIo` type from `docs-golden.ts`.

- Top-level code in both files only computes constants from their own `import.meta.dir` or `REPO_ROOT` and declares functions. No imported binding is read during module evaluation.
- Both entry orders were exercised by the refusal runs above. With `docs-eval.ts` as the entry, `docs-golden.ts` evaluates first. With `docs-golden.ts` as the entry, `docs-eval.ts` evaluates first. The cross-module references are read only inside functions called from the `import.meta.main` blocks, which run after both bodies have evaluated.
- Fragility: a future top-level use of an imported binding (for example `const x = DEFAULT_CANARY_STATE`) would throw a TDZ `ReferenceError` on one of the two entry orders. Moving the shared canary helpers into a third module would remove the cycle. This is a recommendation, not a blocker.

## Warnings (not blockers)

- **W1: silent SLO skip.** `measureGolden` and `measureSlo` return `null` without a stderr line unless `SUBSTRATE_CORPUS` is `on`. The canary then exits 0 on the fixtures alone, with no freshness, ingest or recall5 check. The unit comment documents the requirement, but the drop-in that sets it is not in the repository.
- **W2: null readings are not breaches.** Freshness is null before any ingest. Ingest is null after a zero-document request. Recall at 5 is null on a partial `docs/` scan or an unasked or degraded question. Each case prints only a stderr line, and the run can exit 0 with one of the three unmeasured.
- **W3: freshness depends on a route the omp bearer may not have.** `GET /corpus/status` is `repo-gated` in `route-policy.ts` and refused to scoped callers. If the `omp` token is scoped in production, freshness is never read and the only signal is a stderr line. [INFERENCE: the scope of the production `omp` token was not checked.]
- **W4: working tree only.** See the committed-state note above.
- **W5: live run not observed.** The timer is staged, not installed, by design.

## Other Criteria

- **Criteria 1, 2, 4:** carried from the 2026-11-18 record, which verified them at committed HEAD. Not re-run in this pass.
- **Criterion 5:** partial. The runbook exists. No test asserts a golden case for each new runbook (the only test reference to `docs-rag-operations.md` is `packages/mcp-server/src/fabric/optimize.test.ts`), and the live eval has not run.

## Gaps Summary

Criterion 3 is resolved in the working tree and open at committed HEAD until that change is committed. Criterion 5 remains partial, so the phase cannot be marked `passed`. The warnings above need an operator decision before the timer is installed.

Verification was read-only except for this record. One `bun test` invocation covered the two named files. Two refusal-path entry runs and read-only greps covered the rest. No server or canary was started, and no repository file was edited other than this record.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
