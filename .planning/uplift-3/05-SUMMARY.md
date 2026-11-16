# 05 — N5 summary: docs retrieval fan-out, outcome metrics, offline golden harness

## What changed

| Area | Files | Change |
|---|---|---|
| Shared deadline | `packages/mcp-server/src/deadline.ts` (new), `brief.ts` | The brief's `sharedDeadline`/`BriefDeadline` extracted as `sharedDeadline(budgetMs, label)` + `DeadlineError`; the brief's message (`deadline (N ms brief budget)`) is unchanged. |
| Fan-out | `packages/mcp-server/src/docs-search.ts` | `searchDocs` fires one `retrieveChunks` per resolved dataset at once (`Promise.allSettled`), each raced against the shared deadline (`deps.budgetMs`). A failed or timed-out dataset → `reply.degraded_datasets[{dataset, reason}]` (redacted, ≤ 200 chars); `degraded: true` + `reason` (first failure) only when no dataset answered. Walk order = scope order, so ties sort as before; global score sort and 10-cap unchanged; `note` event unchanged except an added `degraded_datasets` when non-empty; the all-failed `warning` carries it too. New exports `searchReplyStorable`, `citationProvenanceCounts`, `DegradedDataset`. |
| Config | `packages/mcp-server/src/config.ts` | `docsSearchBudgetMs` ← `SUBSTRATE_DOCS_SEARCH_BUDGET_MS` via `nonNegativeOr(…, 4000)`. |
| Service | `packages/mcp-server/src/service.ts` | `searchDocs` passes `budgetMs`, stores only `searchReplyStorable` replies, and records `observer.docsSearch` in `finally` around the cache wrapper (`cached = !loaded`, the brief's pattern; outcome `hit|empty|degraded`; provenance counts of the returned citations). |
| Fake | `packages/mcp-server/src/ragflow (retired)-fake.ts` | `answer(datasetId, question)` hook (default null → unchanged behaviour), `inFlight`/`maxInFlight`; `retrieval` is async. |
| Instruments | `packages/observability/src/instruments.ts`, `index.ts` | `substrate.docs.search{surface,outcome,cached}`, `substrate.docs.citations{provenance}`, `substrate.docs.duration{surface,cached}` (own edges `DOCS_LATENCY_BUCKETS_MS` incl. 2000/4000), `recordDocsSearch`, `DocsSearchSample`, closed sets `DOCS_SEARCH_OUTCOMES`, `CITATION_PROVENANCES`. |
| SLO | `packages/observability/src/slo.ts`, `config.ts`, `packages/mcp-server/src/observe.ts`, `server.ts` | `docsSearchObjective`/`evaluateDocsSlos` beside the catalogue; `SloThresholds.docsSearchP95Ms` (default 2000, env `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS`); `Observability.evaluateDocs()`; `GET /slo` gains `docs: [docs.search.p95]`, never folded into `breached`. |
| Golden harness | `scripts/docs-golden.ts`, `scripts/docs-golden.test.ts`, `packages/mcp-server/src/docs-golden.ts`, `fixtures/docs-golden/{README.md, substrate-door.json, review-gate.json, credentials-redacted.json, unanswerable.json, corpus/**}` | Pure scorer (precision@k, recall, NDCG, provenance coverage, commit match, redaction check), fixture loader with shape checks, corpus manifest hash, CLI (offline asserts; `--live` prints; `--manifest`). Offline runner = corpus-seeded question-aware fake + real `searchDocs`. |
| Docs | `docs/docs-search-ingest.md`, `docs/observability.md`, `fixtures/docs-golden/README.md` | Fan-out/budget/`degraded_datasets`, cache rule, metrics, `/slo` row, harness usage. |
| Tests | `docs-search.test.ts`, `instruments.test.ts`, `slo.test.ts`, `observability/config.test.ts`, `http.test.ts` | See 05-PLAN.md. No existing assertion was weakened; `http.test.ts` only gains the `docs` row. |

## Flags and defaults

- `SUBSTRATE_DOCS_SEARCH_BUDGET_MS` — default **4000**; `0` = no shared deadline (per-call 4 s timeouts only, the pre-N5 wait). Concurrency is unconditional: same reply shape, strictly no slower.
- `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS` — default **2000**; reports only.

## Decision: partially degraded replies are not cached

R6's rule "a degraded reply is never stored" is kept and extended to `degraded_datasets ≠ []`: caching a hole for 300 s would hide one dataset's outage from every caller behind the same question. The reply is still `degraded: undefined` — its citations are real — and callers see exactly which dataset is missing and why.

## How it is measured

- `GET /metrics`: `substrate.docs.duration` (p95 end to end, by `cached`), `substrate.docs.search` (zero-hit and degraded rates per surface — the grok-bot visibility C12 asked for), `substrate.docs.citations` (`unrecorded / total`).
- `GET /slo` → `docs[0]` (`docs.search.p95`): `insufficient-data` until 20 searches, then `ok`/`breached` at the exact 2,000 ms edge.
- Ledger: the `note` event's `degraded_datasets` names a partially served search; the `warning` carries them all when nothing answered.
- Offline: `bun run docs:golden` / `bun test scripts/docs-golden.test.ts`. Live (operator): `bun run docs:golden -- --live`.

## Rollback

`SUBSTRATE_DOCS_SEARCH_BUDGET_MS=0` restores per-call timeouts; the reply shape only gains an optional field. Metrics/SLO row are additive. Reverting the branch removes everything; no state, schema or unit changes.

## Greptile round 1 (PR #61)

**P2 — "Recovery searches drop healthy docs"** (`docs-search.ts` fan-out vs the breaker's half-open single probe). Fixed: `SearchDeps.breakerState?: () => BreakerState` (service passes `this.planes.gate("ragflow (retired)").breaker?.state() ?? "closed"`); when it reads `half-open` and more than one dataset is resolved, the first dataset is retrieved alone as the probe and the siblings fan out only after it settles, every retrieval still raced against the one shared deadline. Closed/open breakers and the omitted dep behave exactly as before. Tests (`docs-search.test.ts`, real `CircuitBreaker` + `gatedFetch` over the fake, dataset list from a cached source so the list does not consume the probe): half-open → one retrieval in flight until the probe is released, then the two siblings run (`maxInFlight` 2), breaker closes, 6 citations, no `degraded_datasets`; a stalled probe costs one budget — all three datasets carry the deadline reason, one retrieval reached the fake, breaker still half-open; a closed breaker with `breakerState` supplied still fans out all three at once. Docs: `docs/docs-search-ingest.md` fan-out section.

## Gates

At the branch head after both waves merged (orchestrator-run, 2026-10-13): `bunx tsc --noEmit` clean · `bun test` with `SUBSTRATE_TEST_PG_URL` (scratch Postgres 16) **3845 pass / 1 skip / 1 fail** — the one failure is the recorded F-01 (`scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2", identical on `main`) · `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27, 4 lock files) · `bun run test:py` 298 pass. `bun scripts/docs-golden.ts` offline: 4/4 fixtures pass, exit 0.
