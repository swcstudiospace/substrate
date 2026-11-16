# 05 — N5: docs retrieval fan-out, outcome metrics, offline golden harness

**Problem** (CONTEXT.md RAGFlow (retired) row, BASELINES.md): `searchDocs` retrieved the datasets one after another, each under its own 4 s timeout (3 datasets = up to 12 s), the only signal was the per-call plane histogram, and no offline relevance/provenance/redaction harness existed (C12).

## What / where

1. **Fan-out under one budget** — `packages/mcp-server/src/docs-search.ts`: `Promise.allSettled` over one retrieval per resolved dataset (≤ 3), each raced against a shared deadline from the new `deadline.ts` (the brief's `sharedDeadline`, extracted; `brief.ts` now imports it). Per-dataset isolation: a failed/timed-out dataset lands in `reply.degraded_datasets[{dataset, reason}]` (reason redacted, ≤ 200 chars); `degraded: true` only when no dataset answered. Score sort, 10-cap, provenance, `dataset_commit`, cache rule and events unchanged (the `note` additionally carries `degraded_datasets` when non-empty). New dep `budgetMs` ← `config.docsSearchBudgetMs` ← `SUBSTRATE_DOCS_SEARCH_BUDGET_MS` (default 4000; 0 = per-call timeout only). `searchReplyStorable` is the cache `store` rule in `service.ts` (partial replies never stored).
2. **Fake** — `ragflow (retired)-fake.ts`: optional `answer(datasetId, question)` hook (sync or async; default behaviour unchanged) and `inFlight`/`maxInFlight`.
3. **Metrics** — `packages/observability/src/instruments.ts`: `substrate.docs.search{surface,outcome,cached}`, `substrate.docs.citations{provenance}`, `substrate.docs.duration{surface,cached}` with its own bucket edges (`DOCS_LATENCY_BUCKETS_MS`, includes 2000 and 4000). `recordDocsSearch(sample)`; `observe.ts` hook `docsSearch`; `service.ts` records around the cache wrapper using the brief's `loaded` flag pattern. `citationProvenanceCounts` in `docs-search.ts` reads the `dataset-pin:` markers.
4. **SLO** — `slo.ts`: `docsSearchObjective` / `evaluateDocsSlos` (sibling of the catalogue, like burn/planes, because the catalogue is pinned to SPE-4793's four and three tests assert it); `GET /slo` gains a `docs` array with the row `docs.search.p95` (≤ 2000 ms, insufficient-data below `minSamples`); env `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS`.
5. **Golden harness** — `scripts/docs-golden.ts` (fixtures loader, corpus manifest, pure scorer, CLI with offline/`--live`/`--manifest`), `packages/mcp-server/src/docs-golden.ts` (corpus → question-aware fake → real `searchDocs`; inside the package because of the store lock), `fixtures/docs-golden/{README.md,*.json,corpus/}`, `scripts/docs-golden.test.ts`.

## Flags and defaults

- `SUBSTRATE_DOCS_SEARCH_BUDGET_MS=4000` — concurrency itself is not flagged (it is strictly faster with the same reply shape); `0` restores per-call timeouts only.
- `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS=2000` — a verdict row, reports only.

## Tests

- `docs-search.test.ts`: slow dataset degraded alone within budget; failed dataset isolated / all failed → `degraded: true`; storable rule; concurrency (`maxInFlight === 3` via a gate, no sleeps); budget 0 waits; service-level not-cached + config parse; observer sample outcomes/cached/provenance.
- `instruments.test.ts`, `slo.test.ts`, `config.test.ts`, `http.test.ts` (`docs` row on `/slo`).
- `scripts/docs-golden.test.ts`: every fixture passes offline through the real `searchDocs` with scope isolation; the planted placeholder is redacted; scorer fails a wrong URL / wrong commit / leak / degraded; `--live` without env exits 2 and never fetches; stale manifest / unattested pin / foreign pin refuse with exit 3.
