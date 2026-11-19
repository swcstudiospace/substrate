---
phase: 46-lightrag-hybrid
verified: 2026-11-18T12:22:05Z
status: human_needed
score: 1/6 success criteria verified in the repository (criterion 1). Criterion 3 was performed live in naive mode in Run 11 (2026-10-28) and is not re-checked here. Criteria 2, 4 and 5 are NOT MET; their remaining work is live and per-run operator-gated. Criterion 6 is a standing rule with no approval recorded for T6 to T8.
behavior_unverified: 0
overrides_applied: 0
covered_files:
  - .planning/milestones/v1.5-phases/46-lightrag-hybrid/CONTEXT.md
  - .planning/milestones/v1.5-phases/46-lightrag-hybrid/PLAN.md
  - .planning/milestones/v1.5-phases/46-lightrag-hybrid/SUMMARY.md
  - docs/docs-plane.md
  - docs/docs-search-ingest.md
  - packages/mcp-server/src/docs-search.test.ts
  - packages/mcp-server/src/docs-search.ts
  - packages/mcp-server/src/planes/lightrag.ts
  - packages/mcp-server/src/planes/ragflow.ts
  - packages/mcp-server/src/service.ts
covered_digest: "v3:sha256:3c721e974bf725f5961634afbefc36373b444e74cd1fd9a2a30c96bbe7ff4127"
re_verification:
  previous_status: human_needed
  previous_score: 1 of 6 (verified 2026-10-28 against main 31a9bb36)
  gaps_closed: []
  gaps_remaining:
    - "Criterion 2: RAGFlow dataset archive with verified checksum (T5) not recorded"
    - "Criterion 4: PARITY_GATE comparator not built; T4 blocked on T5 export"
    - "Criterion 5: cutover done; RAGFlow code still present in packages/mcp-server/src/planes/ragflow.ts; removal gated"
  regressions: []
  notes: "Criterion 1 re-run this session: `bun test packages/mcp-server/src/docs-search.test.ts -t \"docs_search context uses issued live authority\"` gave 24 pass, 0 fail (covers the lightrag and ragflow backends). The phase-46 commits cited in SUMMARY.md (5e3c694, 2a29aed, c30456a) are not ancestors of the current HEAD (357d6b15, branch gsd/autonomous-rerun); 5e3c694 lives on gsd/autonomous-run-2026-10-24. The test describe block named in SUMMARY.md is not on this branch; the equivalent context tests are in the describe block `docs_search context uses issued live authority`."
human_verification:
  - test: "Run T5: archive the RAGFlow dataset and record its checksum, with RAGFLOW_API_KEY, RAGFLOW_URL and RAGFLOW_DATASET_ID supplied in the environment (never in a file)."
    expected: "An archive with a recorded SHA-256 checksum, matched on re-read, before any deletion."
    why_human: "Live step against RAGFlow; approval is per run (STATE.md, 'Approved: T5 archive only, subject to RAGFlow access'). Access was not set in the shell that wrote the last record."
  - test: "Build the PARITY_GATE comparator (PLAN T4) against a read-only export of the RAGFlow dataset after T5, then run the migration job and gate (T7) with the approved sample (ten queries, Q8 amended per PLAN T3)."
    expected: "Zero dataset, source URL and version mismatches; all ten sampled queries return citations from the same source documents (rate 100 percent, fail closed)."
    why_human: "Comparator design depends on the live export (PLAN T4 blocked on T5). The live gate needs per-run approval."
  - test: "Re-run the timed health probe against production LightRAG (`lightrag-smoke-run --confirm-live`) and confirm `/healthz` lists the lightrag plane."
    expected: "Six checks pass in naive mode, probe timing recorded."
    why_human: "Live production probe. Run 11 recorded a pass on 2026-10-28; this record does not re-check it."
  - test: "Choose the LLM route for LightRAG graph and hybrid retrieval (`shunt login xai` or `hermes auth add xai-oauth --type oauth`, plus a network path from Railway), then run one hybrid query."
    expected: "A hybrid or graph answer with citations, not the naive fallback."
    why_human: "Operator decision on an LLM provider. Production currently runs naive mode on the bypass LLM (infra/railway/lightrag-llm-bypass.ts)."
  - test: "Confirm the RAG-dependent phase list before cutover removal: 25, 40, 42 and 51 (candidates from SUMMARY.md), plus any other phase whose VERIFICATION names a live RAGFlow call. Phase 25 has no folder in this worktree."
    expected: "Each listed phase's VERIFICATION passes, or the operator accepts its status as debt."
    why_human: "Depends on other phases' live evidence outside this repository."
  - test: "Approve each per-run live step (T5 archive, T6 deploy, T7 ingestion, T8 cutover and RAGFlow code removal, storage deletion) in writing before it runs."
    expected: "A recorded approval per run; none carries over."
    why_human: "Criterion 6 is an operator control. No approval for T6 to T8 is recorded."
---

# 46-VERIFICATION: LightRAG hybrid RAG and the RAGFlow migration

**Phase Goal:** Docs answers come from LightRAG with hybrid search and Hindsight context. The RAGFlow to LightRAG migration runs inside this phase: archive, LightRAG deploy, migration job, parity gate, cutover, then RAGFlow removal after the RAG-dependent phases pass. Each live step needs the operator's approval for that run.
**Verified:** 2026-11-18T12:22:05Z
**Status:** human_needed
**Re-verification:** Yes, after the 2026-10-28 record (human_needed, 1 of 6)
**Checked against:** branch `gsd/autonomous-rerun`, HEAD `357d6b15`

## Method and classification

- Source of criteria: ROADMAP.md Phase 46 block (verbatim in PLAN.md). The phase directory is `milestones/v1.5-phases/46-lightrag-hybrid/`; `46-ragflow-hybrid/` is superseded (SUPERSEDED.md) and not evidence.
- SUMMARY.md and the prior VERIFICATION.md were not treated as evidence. Each criterion was checked against code, tests, docs and STATE.md records.
- Criteria 2, 4 and 5 are not met. Each remaining piece of work is a live step that the phase reserves for per-run operator approval (T5 archive, T6 deploy, T7 ingestion, T8 cutover and removal). The comparator (T4) is blocked on the T5 export (PLAN.md T4). They are recorded as human_needed, not as repository gaps. If the operator reads the comparator as in-repo work that can proceed now, criterion 4 becomes a gap.
- The owner's 2026-10-28 acceptance of phase 46 as debt (STATE.md) states that accepting an item does not mark it passed. No `overrides:` entry was added.
- No live step was run. The only command run against the test suite is the targeted check listed under criterion 1.

## Success criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | docs_search answers from LightRAG with hybrid search and Hindsight context, with tests | ✓ VERIFIED | `packages/mcp-server/src/planes/lightrag.ts:59` `DEFAULT_QUERY_MODE: LightragQueryMode = "hybrid"`. `packages/mcp-server/src/service.ts:6294` `input.context === true ? { ...chunks, context: ... } : chunks` (context is opt-in per call). `packages/mcp-server/src/docs-search.ts:242` `searchReplyStorable` (refuses a reply with a context key) and `:1005` `lightragFallback`. Tests: `packages/mcp-server/src/docs-search.test.ts` describe `docs_search context uses issued live authority`, run for both `ragflow` and `lightrag` backends (the lightrag arm asserts `reply.backend === "lightrag"`, the context memories and events, and `mode === "hybrid"` on the upstream query, lines ~1378-1480). Targeted run this session: 24 pass, 0 fail. Docs: `docs/docs-plane.md` line 1 and "Hybrid retrieval and context" section (line 120) and `docs/docs-search-ingest.md`. |
| 2 | The RAGFlow dataset is archived, with a verified checksum, before any deletion | ✗ NOT MET (operator-gated) | No archive file and no checksum is recorded in the repository. STATE.md line 465: T5 "BLOCKED on access (P2). RAGFLOW_API_KEY, RAGFLOW_URL and RAGFLOW_DATASET_ID are not set in this shell." The T5 approval (STATE.md line 464) covers the archive only, subject to access. The `ragflow` Railway service was deleted 2026-10-25 (ROADMAP Phase 46 re-scope note). |
| 3 | LightRAG is deployed to Agent Substrate production and passes a timed health probe | ⚠ PARTIAL, live part not re-checked (human_needed) | Repository: `packages/mcp-server/src/lightrag-smoke-run.test.ts` exists; `infra/railway/lightrag-llm-bypass.ts` and its test exist. STATE.md Run 11 (2026-10-28): `lightrag` v1.5.7 deployed, `lightrag-smoke-run --confirm-live` passed all six checks in naive mode, production on release `5cf930a0` with `SUBSTRATE_DOCS_BACKEND=lightrag`. Graph and hybrid retrieval need a real LLM route (not in place). Not re-run in this record. |
| 4 | Migration job and parity comparator pass PARITY_GATE before any ingestion | ✗ NOT MET (operator-gated) | No comparator exists: `grep -rn "PARITY_GATE\|comparator" packages scripts infra` returns no match. The only `parity` hits are the unrelated host `parity:check` (`scripts/parity-check.ts`). PLAN T3 (sample): ten queries, rate 100 percent, fail closed, Q8 amended 2026-10-25 (STATE.md line 464). T3 content confirmation "not yet read" (SUMMARY.md). T4 comparator BLOCKED on T5 (PLAN.md). T7 HARD_STOP. Migration job absent. |
| 5 | Cutover is a logged, reversible switch with a delta pass; RAGFlow code and service removed only after 1-4, the RAG-dependent phases, and storage approval | ✗ NOT MET (partial; removal operator-gated) | Cutover done in Run 11: production serves docs from LightRAG (`SUBSTRATE_DOCS_BACKEND=lightrag`, STATE.md). RAGFlow code still present: `packages/mcp-server/src/planes/ragflow.ts` (21.0K) and `ragflow.test.ts`, with about 226 files still naming RAGFlow in the repository. RAG-dependent phase list not confirmed (candidates: 25, 40, 42, 51 per SUMMARY.md; phase 25 has no folder in this worktree). Storage services (`elasticsearch`, `mysql`, `storage`, `redis`) need their own approval. |
| 6 | Every live step (deploy, ingestion, cutover, storage deletion) runs only after operator approval for that run | ⚠ STANDING RULE, no approval for T6-T8 recorded | Approvals on record: T5 archive only, subject to access (STATE.md line 464). No approval for T6 deploy, T7 ingestion, T8 cutover or storage deletion. Run 11 deploy was performed by the operator per STATE.md. |

**Score:** 1/6 success criteria verified in the repository. Criterion 3 is partly live (naive mode, Run 11), not re-checked here.

## Required artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/planes/lightrag.ts` | Default hybrid mode | ✓ VERIFIED | Line 59 `DEFAULT_QUERY_MODE = "hybrid"`. |
| `packages/mcp-server/src/docs-search.test.ts` | Success-path context tests | ✓ VERIFIED | describe `docs_search context uses issued live authority`; 24 pass. |
| `docs/docs-plane.md`, `docs/docs-search-ingest.md` | LightRAG hybrid and context docs | ✓ VERIFIED | Present; describe the plane, opt-in context and fallback. |
| `packages/mcp-server/src/planes/ragflow.ts` | Removed only after criterion 5 | ✗ PRESENT | Still in tree, as Run 11 records. Removal is gated. |
| PARITY_GATE comparator and migration job | Built and run before ingestion | ✗ MISSING | Not in repository; blocked on T5 export (PLAN T4). |
| Archive file with SHA-256 checksum (T5) | Recorded before deletion | ✗ MISSING | Not in repository; T5 blocked on access (STATE.md line 465). |

## Key link verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `service.ts` searchDocs | `docs-search.ts` context path | `input.context === true` (line 6294) | ✓ WIRED | Context attached only when the caller opts in. |
| `docs-search.ts` `lightragFallback` | Hindsight recall | fallback when LightRAG plane fails | ✓ WIRED | Line 1005; covered by context tests. |
| LightRAG query | `hybrid` mode | `DEFAULT_QUERY_MODE` used in query (`lightrag.ts:148`) | ✓ WIRED | Test asserts upstream `mode === "hybrid"`. |
| Comparator | Migration gate | PARITY_GATE | ✗ NOT_WIRED | Comparator absent. |

## Requirements coverage

| Requirement | Source | Status | Evidence |
|-------------|--------|--------|----------|
| SOTA-02 | ROADMAP Phase 46 | ✗ UNSATISFIED | Criteria 2, 4, 5 not met; criterion 3 graph and hybrid modes and criterion 6 open. The owner accepted these as debt on 2026-10-28; that acceptance does not mark them passed (STATE.md). |

## Anti-patterns

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/mcp-server/src/planes/ragflow.ts` | whole file | Legacy RAGFlow backend still in tree | ℹ️ Info | Expected until criterion 5 removal is approved. |

## Human verification required

See the frontmatter `human_verification` list. Summary:

1. T5 archive with a recorded SHA-256 checksum (criterion 2), with access supplied in the environment.
2. PARITY_GATE comparator and T7 ingestion gate after T5 (criterion 4).
3. Re-run of the timed production health probe (criterion 3).
4. LLM route for LightRAG graph and hybrid modes (criterion 3 remainder).
5. RAG-dependent phase list confirmed before removal (criterion 5).
6. Per-run approvals for T6 to T8 and storage deletion (criterion 6).

## Residual risks

- Naive mode only: no graph is built, and hybrid and graph modes are unproven live.
- Rollback to `702ed32e` is app-only and leaves docs search without a backend, since the RAGFlow service is deleted (STATE.md Run 11 addendum).
- Recalled memories improving answers is unproven; only the plumbing and caps are tested.
- Branch mismatch: the commits cited in SUMMARY.md are not ancestors of HEAD `357d6b15`. Their content is present in the tree in rewritten form; the test names differ.

---

_Verified: 2026-11-18T12:22:05Z_
_Verifier: Claude (gsd-verifier)_
