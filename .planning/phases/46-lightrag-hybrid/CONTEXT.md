---
phase: 46-lightrag-hybrid
milestone: v1.5
requirements: [SOTA-02]
rescoped: 2026-10-23
discussed: 2026-10-24
status: decisions recorded; in-repo tasks in progress; live steps operator-gated
supersedes: .planning/phases/46-ragflow-hybrid/ (see SUPERSEDED.md there)
---

# 46-CONTEXT: LightRAG hybrid RAG with Hindsight context and the RAGFlow migration

## Scope

Phase 46 (ROADMAP.md, Phase 46 block, around lines 662-681) makes docs answers come from LightRAG with hybrid search and Hindsight context. It also carries the RAGFlow to LightRAG migration inside the phase: archive, LightRAG deploy, migration job, parity gate, cutover, then RAGFlow removal once the RAG-dependent phases pass.

This phase replaces the RAGFlow hybrid design in `.planning/phases/46-ragflow-hybrid/`. That design targeted RAGFlow and is superseded by the 2026-10-23 re-scope (D46-4).

## Locked inputs

- ROADMAP Phase 46, success criteria 1 to 6 (copied verbatim in PLAN.md).
- ROADMAP criterion 6: every live step (deploy, ingestion, cutover, storage deletion) runs only after the operator approves it for that run. Approval does not carry over to a later run.
- The 2026-10-23 re-scope: the RAGFlow VERIFICATION in `46-ragflow-hybrid/` covers the RAGFlow path and no longer applies to Phase 46 (ROADMAP line 681).
- Code facts used by the decisions below, each checked in this worktree:
  - `packages/mcp-server/src/planes/lightrag.ts:40` `DEFAULT_QUERY_MODE: LightragQueryMode = "hybrid"`.
  - `packages/mcp-server/src/planes/lightrag.ts:273-276` doc comment: graph modes `hybrid` (the default) and `mix`; `/mix` prefix selects `mix`.
  - `packages/mcp-server/src/service.ts:4550` `if (input.context !== true) return chunks;` (context is opt-in per call).
  - `packages/mcp-server/src/service.ts:4551` attaches `context` after the cached chunks, per call.
  - `packages/mcp-server/src/docs-search.ts:195-202` `searchReplyStorable` refuses any reply with a `context` key.
  - `packages/mcp-server/src/docs-search.ts:892-920` `lightragFallback`: Hindsight recall answers when the LightRAG plane fails; with no hit the plain degraded reply stands.
  - `packages/mcp-server/src/planes/ragflow.ts:252-254` wire body carries `vector_similarity_weight` and `rerank_id` only when set (the RAGFlow knobs at `ragflow.ts:99-113`).
  - `packages/mcp-server/src/docs-search.test.ts` exists (T1 target).

## Decision records

Each record has the same ten fields: id, phase, question, options considered, selected option, rubric rationale, reversibility, confidence, status, review flag.

### D46-1 hybrid meaning

- id: D46-1
- phase: 46
- question: What does "hybrid search" mean for the LightRAG query mode?
- options considered: (a) keep LightRAG `hybrid` as the default mode (`lightrag.ts:40`); (b) make `mix` the default (the deeper multi-hop blend, `lightrag.ts:273-276`); (c) map the RAGFlow `vector_similarity_weight` onto LightRAG. Option (c) is excluded: LightRAG has no weight field.
- selected option: (a) `hybrid` stays the default. `mix` remains reachable by the `mode` argument or the `/mix` prefix.
- rubric rationale: The existing default already fuses graph local and global context, which is what criterion 1 means by hybrid. Changing the default changes every consumer's retrieval without a criterion asking for it. Option (c) cannot be built, since LightRAG exposes no weight.
- reversibility: reversible (one constant and one prefix table).
- confidence: high.
- status: auto-selected.
- review flag: no.

### D46-2 context default

- id: D46-2
- phase: 46
- question: Is the `context` block of `docs_search` on by default?
- options considered: (a) opt-in, off on every backend (`service.ts:4550`); (b) on by default for LightRAG; (c) on everywhere. Option (b) is excluded here because it changes the consumer contract. Option (c) is excluded because it breaks byte-identity of the RAGFlow replies.
- selected option: (a) opt-in per call. Without `context: true` the reply has no `context` key.
- rubric rationale: Existing consumers and cache entries stay unchanged. A context reply carries session events, so it must be per call (`searchReplyStorable` at `docs-search.ts:200-202` refuses it).
- reversibility: reversible (one default in the service method).
- confidence: high.
- status: auto-selected (the brief gave no status; set by this record).
- review flag: no.

### D46-3 Hindsight on LightRAG success

- id: D46-3
- phase: 46
- question: Where does Hindsight context appear on a LightRAG answer?
- options considered: (a) only as a fallback when LightRAG fails (`docs-search.ts:892-920`, the current behaviour); (b) successful LightRAG answers carry Hindsight context when the caller asks for it; (c) both.
- selected option: (b). Successful LightRAG answers carry a `context` block with recalled memories when `context: true` is passed. The fallback stays as it is.
- rubric rationale: Criterion 1 describes a success path ("answers from LightRAG ... and Hindsight context"). The fallback alone does not satisfy it. Option (c) adds fallback counting on top, which the criterion does not need.
- reversibility: reversible (the `context` block is per call).
- confidence: medium (the criterion wording supports (b), but the decision depends on reading "context" as the per-call block).
- status: auto-selected.
- review flag: YES. The operator should confirm that criterion 1 means the success path, not only the fallback.

### D46-4 governing plan

- id: D46-4
- phase: 46
- question: Which plan governs Phase 46?
- options considered: (a) the ROADMAP re-scope governs, and the RAG-hybrid CONTEXT and PLAN in `46-ragflow-hybrid/` are superseded; (b) keep the RAG-hybrid PLAN units as the base. Option (b) is excluded: unit U1 already exists in code (`ragflow.ts:99-113` knobs, `ragflow.ts:252-254` wire fields), so the units assume work that is partly done and point at the wrong backend.
- selected option: (a).
- rubric rationale: The ROADMAP re-scope is dated later and names the migration. The RAG-hybrid design targets RAGFlow, which this phase removes.
- reversibility: reversible (the old folder is kept, marked superseded).
- confidence: high.
- status: auto-selected (the brief gave no status; set by this record).
- review flag: no.

### D46-5 PARITY_GATE match rate (criterion 4)

- id: D46-5
- phase: 46
- question: What match rate does the fixed query sample need before any ingestion?
- options considered: a lower rate (for example 80 percent) allowing some drift; a 100 percent rate with fail-closed behaviour.
- selected option: every sampled query must return citations from the same source documents, rate 100 percent, fail closed. The sample is the ten queries in PLAN.md T3. The user may lower the rate later, but only by a recorded decision.
- rubric rationale: Ingestion is live and not easily reversed once it replaces RAGFlow. A lower rate would let a silent retrieval regression through. Ten queries are a small sample, so a single miss is informative. The rate is set now, before any run, as criterion 4 requires.
- reversibility: reversible (the rate is a PLAN value and can be lowered by recorded decision before a run).
- confidence: medium.
- status: auto-selected.
- review flag: YES. The operator should confirm the rate and the sample.

## Live steps (not decisions)

Criteria 2, 3, 5 and 6 cover archive, deploy, ingestion, cutover and storage deletion. These are not decisions to auto-select. They are HARD_STOP tasks in PLAN.md (T5 to T8). Each waits for the operator's explicit approval for that run. Nothing in this phase runs them.

## In-repo versus live split, per criterion

| # | Criterion (short) | In-repo part (this run) | Live part (operator-gated) |
|---|---|---|---|
| 1 | docs_search answers from LightRAG with hybrid search and Hindsight context, with tests | T1 tests (`docs-search.test.ts`), T2 docs; the default mode is already `hybrid` (`lightrag.ts:40`) | none required for the in-repo proof; a live answer needs T6 |
| 2 | RAGFlow dataset archived with a verified checksum before deletion | none in repo | T5 |
| 3 | LightRAG deployed to production, timed health probe | none in repo | T6 |
| 4 | Migration job and parity comparator pass PARITY_GATE before ingestion | T3 sample list and rate (D46-5) | T4 comparator deferred; T7 runs it live |
| 5 | Cutover logged and reversible; RAGFlow removed only after 1 to 4 and the RAG-dependent phases | none in repo | T8 |
| 6 | Each live step runs only after operator approval for that run | the HARD_STOP gates in PLAN.md | every live step (T5 to T8) |

## Fallbacks

- The `Skill()` commands (the GSD workflow skills) were not available in this run. These artifacts were produced directly from the workflow steps in the brief, not through the Skill tools. This is recorded here per the workflow's fallback rule.
- The `46-ragflow-hybrid/` folder was read for reference only and is not edited. Its superseded status is recorded in `SUPERSEDED.md` in that folder.
