# Phase 70: Docs SLO and eval - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
Measurement and guards: a self-supervised golden set, an offline CI harness, SLO series and thresholds, a docs lint and the operator runbook. It does not change ranking itself (phase 66).

## Decisions
- **D70-1:** a golden set exists today as `scripts/docs-golden.ts` and a daily canary timer that is staged and not installed (`infra/vps/substrate-docs-canary.timer`, runs at 04:41 UTC, emits a `docs.canary` warning when the failing set changes). This phase generates queries from the corpus itself (title and heading to document key), so it grows with the corpus and needs no labels.
- **D70-2:** CI cannot call a live RAG, so a lexical retriever over a fixture corpus stands in; it guards the pipeline logic (ranking inputs, de-duplication, re-rank) rather than embedding quality.
- **D70-3:** metrics reuse the existing history path (`metric_samples`, created only when `SUBSTRATE_METRICS_HISTORY=on`, `greptime.ts:2437`) and the freshness settings in `docs-freshness.ts`.
- **D70-4:** the docs lint is a `bun test` file, like `scripts/planning-integrity.test.ts`, so the CI workflow's four commands stay unchanged (`docs/ci.md`); it also repairs the archived roadmap links recorded as broken in Run 13.
- **D70-5:** the operator runbook is the deliverable that turns this milestone's staged units into steps someone can follow: deploy, first ingest, timers, rollback.

## Canonical references
`scripts/docs-golden.ts`, `docs/dashboards.md`, `docs/observability.md`, `docs/ci.md`, `scripts/planning-integrity.test.ts` (legacy archive list)
