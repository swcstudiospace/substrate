# Phase 46 verification

Date: 2026-11-11. Branch: `reconcile/main-2026-11-11`. Scope: the repo-buildable part of ROADMAP "Phase 46" criteria 1 to 6, against `.planning/phases/46-ragflow-hybrid/46-PLAN.md`.

No live step was run in this pass. Nothing contacted production, Railway, `/etc`, or systemd. Every live step stays operator-gated.

## Verification run (this pass)

| Command | Result |
|---|---|
| `bun test packages/mcp-server/src/parity-gate.test.ts packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/docs-archive.test.ts` | 145 pass, 0 fail, 3 files |
| `bunx tsc --noEmit` | no errors |
| `env -u LIGHTRAG_URL bun scripts/parity-gate.ts --part A` (and `--part B`) | exit 2, reason "LIGHTRAG_URL is unset; no socket was opened" |

Not re-run in this pass: `scripts/lightrag-probe.test.ts`. It was last run with commit `0011d77b`, and this pass did not touch the probe.

## Per-criterion status

Status values: `met-in-repo` (the repository shows it), `operator-gated` (repo part done, live part waits on approval), `not met`.

| # | Criterion (ROADMAP, shortened) | Status | Evidence | Operator approval still needed |
|---|---|---|---|---|
| 1 | docs_search answers from LightRAG with hybrid search and Hindsight context, with tests | `met-in-repo`. Hybrid in production: `operator-gated` | `packages/mcp-server/src/planes/lightrag.ts:59` `DEFAULT_QUERY_MODE = "hybrid"`. `packages/mcp-server/src/docs-search.test.ts` describes: "LightRAG search and the RAGFlow plane" (l.597), "LightRAG search retries and the Hindsight fallback" (l.775), "LightRAG context replies are never cached (phase 46 SC1)" (l.1795). All pass in the 145-test run. | D5: approve hybrid in production. Production runs naive, and hybrid needs an LLM route (STATE, Run 11). A live hybrid check needs its own per-run approval. |
| 2 | RAGFlow dataset archived with verified checksum before any deletion | `not met` (operator-gated) | `packages/mcp-server/src/docs-archive.ts` is a writer that reads the live RAGFlow API. That service was deleted 2026-10-25, so the writer cannot run. No CLI is wired and no archive or checksum exists in the repo. `docs-archive.test.ts` tests the writer and checksum logic only. It proves no archive. | D1: (a) volume-level archive, (b) attestation of the 2026-10-25 empty check, or (c) keep as debt and delete `docs-archive.ts`. Default (c), pending. Then C2 for the chosen option, recorded in STATE.md before it runs. |
| 3 | LightRAG deployed to production and passes a timed health probe | `operator-gated`. Deploy met live (Run 11, 2026-10-28). Timed probe not run. | `scripts/lightrag-probe.ts` (OD-5: 20 samples over 60 s, 1000 ms timeout, p95 at most 500 ms). `scripts/lightrag-probe.test.ts` covers the exit 0, exit 1 (non-2xx and p95 over bound), and exit 2 (unset URL) paths. `probe:lightrag` in `package.json`. STATE, Run 11. | C1: `bun run probe:lightrag` with the operator's own `LIGHTRAG_URL` and `LIGHTRAG_API_KEY`, per-run approval. |
| 4 | Migration job and parity comparator pass PARITY_GATE before any ingestion | `operator-gated`. Comparator `met-in-repo`. Live Part A and Part B not run. Migration-job clause not built (see below). | Comparator: `packages/mcp-server/src/parity-gate.ts` (`checkRecordMapping`, `runSample`, `FROZEN_SAMPLE`, `PARITY_THRESHOLD = 1`). CLI: `scripts/parity-gate.ts` (`runParity`), `parity:gate` in `package.json`. Tests in `packages/mcp-server/src/parity-gate.test.ts`: zero-mismatch pass; missing record; changed source URL; changed version; stale extra record; other-door record as unverifiable; truncated listing fails closed; Part B pass at threshold and fail one below; no-URL exit 2 with no socket opened; key sent and not printed; unreachable plane prints no address; frozen sample matches the 46-PLAN.md table. Code commit `0d230e18`. | C3: Part A, read-only, against production. C4: Part B, 10 read-only `/query` calls, and the delta pass. D2: parity source (default: the LightRAG corpus; RAGFlow was empty). D3: threshold (default: 10 queries at 100 percent). Migration job: the plan drops it (stale T8, T12) but ROADMAP criterion 4 still names it. The operator must confirm that waiver. |
| 5 | Cutover logged and reversible with delta pass. RAGFlow code and service removed only after cutover, criteria 1 to 4, and RAG-dependent phases. Storage deletion separately approved. | `not met` (partial) | Cutover logged: `docs/runbooks/lightrag-cutover.md` (Run 11 facts, env key names only, reversal section). Reversal to RAGFlow: not possible, because the service was deleted 2026-10-25, before the cutover. Delta pass: C4, not run. Removal: not started. `packages/mcp-server/src/planes/ragflow.ts` is still present. T6 to T8 are draft-only and wait on D1 to D4 and C5 to C7. | D4: accept the reversal limit and the app-only rollback. D6: waive or re-check RAG-dependent phases 25, 40 and 42; exclude 34; approve removing `ragflow` from `FABRIC_RESOURCES` (a phase 51 contract change). C5: RAG-dependent gate. C6: production env, after the removal draft merges. C7: storage deletion, separately approved. Merge approval for the removal draft. |
| 6 | Every live step (deploy, ingestion, cutover, storage deletion) runs only after per-run operator approval | `operator-gated` (standing rule). No live step run in this pass. | STATE.md records no per-run approval for C1 to C7. | Per-run approval for each of C1 to C7, recorded in STATE.md before it runs. |

## Findings the operator needs before C3

1. **Part A depends on which writer produced each `lightrag::` record.** `ingestDocsLightrag` in `packages/mcp-server/src/docs-ingest.ts` writes records whose plane documents are named by flattened `documentName(path)`. The corpus listing withholds those names, so Part A reports them as `unverifiable-name`, and the gate fails on each one. Corpus-named documents (the bulk path, `corpus:` names) are verified in full. Only a read-only Part A run (C3) shows which kind production holds. Expect a failure if any flattened records exist, and settle D2 with that in mind.
2. **Criterion 4's migration-job clause is unbuilt.** The plan drops the migration job, because the RAGFlow source was empty and the corpus is re-indexed from git. The owner must confirm that waiver. Until then the criterion is not fully met.

## Decisions pending (agent defaults, not decided)

D1 = (c). D2 = PARITY_GATE against LightRAG records. D3 = 10 frozen queries at 100 percent, top-5 citation. D4 = reversal to RAGFlow is impossible, accepted as a limit. D5 = hybrid stays off in production. D6 = waive 25, 40 and 42; exclude 34; remove `ragflow` from `FABRIC_RESOURCES`; keep the folder name. Each is recorded in `46-PLAN.md`, and none is decided.

## Not done in this pass

- T6 to T8 (RAGFlow removal draft): not started. The plan gates it on D1 to D4 and C5 to C7.
- Criterion 2 archive: not built. It waits on D1.
- `SUMMARY.md`: not created. The plan asks for it after the offline sub-plans land, and this pass did not cover that.
