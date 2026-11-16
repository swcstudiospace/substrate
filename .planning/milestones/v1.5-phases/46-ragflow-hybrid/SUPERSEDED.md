# Superseded: Phase 46 RAGFlow (retired) hybrid design

Status: superseded, not current.

- `CONTEXT.md` and `PLAN.md` in this folder are the RAG-hybrid design. They were written against origin/main 92ef7c2 and target RAGFlow (retired). They are superseded by the 2026-10-23 ROADMAP re-scope of Phase 46 (ROADMAP.md, Phase 46 block) and by `.planning/phases/46-lightrag-hybrid/`, which governs the phase (its D46-4 record).
- `VERIFICATION.md` in this folder describes the RAGFlow (retired) path and is historical. It is not evidence for ROADMAP criterion 1 of the re-scoped Phase 46, which requires docs_search to answer from LightRAG with hybrid search and Hindsight context.
- The RAGFlow (retired) plan unit U1 (hybrid knobs) already exists in code: `packages/mcp-server/src/planes/ragflow (retired).ts` lines 99-113 (knobs) and 252-254 (wire fields), checked 2026-10-24. That is why the RAG-hybrid units are not used as the base.
- No file-line claim from the three files in this folder is repeated in the Phase 46 LightRAG artifacts without being checked against the repository there.

Nothing in this folder is edited by the re-scope. The files are kept for history.
