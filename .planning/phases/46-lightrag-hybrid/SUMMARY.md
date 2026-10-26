---
phase: 46
name: LightRAG hybrid RAG with Hindsight context and the RAGFlow migration
milestone: v1.5
status: partial
recorded: 2026-10-24
---

# Phase 46 summary (partial, 2026-10-24)

Phase 46 is partial. Criterion 1 is complete in the repository. Criteria 2, 3, 5 and 6 are live steps and wait for per-run operator approval. Criterion 4 is not met: its comparator is deferred and its live gate is a HARD_STOP.

## Changes

- Tests: `packages/mcp-server/src/docs-search.test.ts` lines 1607-1701, four tests in a new describe block. They cover a LightRAG success with `context: true` (Hindsight memories and events), the same success without context, the same success with `context: false`, and the default upstream query mode `hybrid`. Commit `5e3c694`.
- Docs: `docs/docs-plane.md` rewritten for the LightRAG hybrid plane. It states the plane selection, that context is opt-in on every backend, and that a failed LightRAG query falls back to Hindsight recall and does not retry RAGFlow. `docs/docs-search-ingest.md` hybrid and context section rewritten to the same facts. Commit `2a29aed`.
- Planning: `.planning/phases/46-lightrag-hybrid/CONTEXT.md` (decisions D46-1 to D46-5 with all record fields), `.planning/phases/46-lightrag-hybrid/PLAN.md` (criteria 1-6 quoted verbatim, tasks T1-T8), and `.planning/phases/46-ragflow-hybrid/SUPERSEDED.md`. Commit `c30456a`.
- Production code: none changed. The success path already attaches Hindsight context through the service gate (`packages/mcp-server/src/service.ts` around line 4554); the new tests confirm it.

## Verification, this session

- `bun run verify` with live Postgres on the final tree: exit 0. Tests 6222 pass, 2 skip, 0 fail. The four new tests are among the passes.
- Typecheck: 0 errors.
- Docs claims were checked against the code by the author, with file and line recorded in the author's report, not in the docs.

## Criteria

| # | Status | Evidence or blocker |
|---|--------|---------------------|
| 1 | pass in repository | Tests `5e3c694`; docs `2a29aed`; default mode `hybrid` at `packages/mcp-server/src/planes/lightrag.ts` line 40; context opt-in at `service.ts` around line 4554 |
| 2 | blocked: HARD_STOP | Archive the RAGFlow dataset with a verified checksum. Needs operator approval for this run (task T5) |
| 3 | blocked: HARD_STOP | Deploy LightRAG and pass a timed health probe. Needs operator approval for this run (task T6) |
| 4 | not met | T3 sample list drafted: ten queries, match rate 100 percent, fail closed. Sample document content not yet read. T4 comparator deferred. T7 live gate is a HARD_STOP |
| 5 | not met | Cutover needs criteria 1-4 and every RAG-dependent phase. Phase 25 has no artifact folder in this worktree. T8 is a HARD_STOP |
| 6 | standing rule | Every live step needs operator approval for its run. None granted |

## Deviations

- `Skill()` is not a tool in this environment. The discuss and plan artifacts were produced directly from the workflow steps, a recorded fallback.
- The re-scope brief says a failed LightRAG query falls back to RAGFlow. The code falls back to Hindsight recall. The docs describe the code.
- The phrase "phase 46 cutover" in `docs/docs-plane.md` comes from the brief. No document under `docs/` defines it; it needs confirmation before merge.

## Decisions (full records in CONTEXT.md)

- D46-1 hybrid default: selected, review no.
- D46-2 context opt-in on every backend: selected, review no.
- D46-3 successful LightRAG answers carry context when asked: selected, review yes.
- D46-4 ROADMAP re-scope governs; RAG-hybrid CONTEXT and PLAN superseded: selected, review no.
- D46-5 PARITY_GATE rate 100 percent, fail closed: selected, review yes.

## Deferred and blocked, with unblock steps

- T4 comparator: BLOCKED (reclassified from deferred on 2026-10-24). Unblock: the operator approves T5; a read-only RAGFlow export is then captured and the comparator is tested against it.
- T5 to T8 live steps: HARD_STOP. Unblock: operator approval for each run.
- T3 sample content: checked 2026-10-24. 9 of 10 pairings confirmed; Q8 fails, because docs/skills-propose.md has no expected-version concept. Unblock: the operator approves the Q8 amendment recorded in PLAN T3; the check is then re-run and its result recorded.
- Phase 25 artifacts: archived at .planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/ (located 2026-10-24). 25-VERIFICATION read 2026-10-24: the live G1 to G4 RAGFlow gates are operator-gated and never run.
- Criterion 5 RAG-dependent candidates, from the VERIFICATION content read 2026-10-24, to be confirmed in the PLAN before cutover: 25 (live G1 to G4 gates, 25-VERIFICATION line 73); 40 (live RAGFlow health and TCP probe, 40-VERIFICATION lines 29-30); 42 (live fast-forward and agent-skills dataset not run, 42-VERIFICATION lines 36, 40, 83); 51 (live RAGFlow GET probes, 51-VERIFICATION line 61). Not counted: 18 (test pins), 20 (config fields), 34 (states it reads no live RAGFlow).

## Residual risks

- The live LightRAG answer, the parity gate and the cutover are unproven. Criterion 1 is proven at the test level, with fixtures.
- The production wire path for LightRAG context is not exercised live.

## Manual evidence

None. No criterion is passed on manual evidence.

## Commits

- `5e3c694` test: cover LightRAG success-path context and the hybrid default
- `2a29aed` docs: describe the LightRAG hybrid plane, its context and its fallback
- `c30456a` docs(gsd): phase 46 discuss and plan; supersede the RAG-hybrid artifacts

## Run 7 update (2026-10-26, planner graph ut-mvocrh76-02f3c9a9)

- D-14 closed on degraded semantics in `2c82176`. A chunked Hindsight fallback to a failed LightRAG query is now `degraded` with its reason, which matches `docs-search.ts:143-146` and `docs-plane.md:105-106`. An unconfigured LightRAG plane is now answered from Hindsight on `docs_search`, as `docs_lightrag_query` already did. No machine call or breaker logic changed. Fail-before: five new or changed tests fail on `0570e77`; the replay pin passes before and after.
- Presentation differences that are not degraded semantics stay open. They are listed in `2c82176` and in VERIFICATION.md.
- Criteria are unchanged. 1 passes in repository. 2 and 3 are human_needed. 4 and 5 are not met. 6 is the standing rule. See VERIFICATION.md.
- Commands and outcomes this run: `bun run verify` exit 0 with 6086 pass and 0 fail after the Python gate and after D-14; `bun scripts/audit-gate.ts` exit 0 with 0 unlisted high or critical; `bun run check:phase-close` exit 0 in three runs at 2.2 to 2.3 s; the Python suites pass with 321 tests.
- The earlier stale line "the decision brief Q1-Q4 awaits discuss answers" is superseded: decisions D46-1 to D46-5 are recorded in CONTEXT.md, and criterion 1 is in the repository.
