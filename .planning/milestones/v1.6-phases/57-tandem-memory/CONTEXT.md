---
phase: 57-tandem-memory
milestone: v1.6
requirements: [SOTA-13]
discussed: 2026-10-26
status: implemented on gsd/v16-int; every new flag defaults off; two items unverified against a live system
---

# 57-CONTEXT: Tandem memory, LightRAG with Hindsight, with provenance and forget

## Goal

Hindsight and LightRAG answer together with shared provenance and join keys; memory written after a point in a session can be superseded or forgotten without hard-deleting the ledger; and the consistency of the stores can be verified. The roadmap block is ROADMAP.md, Phase 57.

## Locked decisions

- **D55-1: rollback marks memory superseded; nothing is hard-deleted.** A forgotten entry keeps its index row with `superseded_by = 'forgotten:<forget_id>'`, so every existing reader (the brief, `memory_search` without `include_superseded`, the write gate, the sweeper, the retain replay) already treats it as not in force. No schema change.
- **Store roles (D55-5).** Hindsight is derived memory, never the store of record; LightRAG is a derived docs index rebuilt from git; the ledger is authoritative (`docs/adr/0004-store-roles.md`).
- **Forget is internal.** `Substrate.memoryForget` has no MCP tool and no route of its own; the rollback commit calls it. One `memory.forget` note per call (`payload.action`, kind `note`), ids and counts only.
- **The tandem leg and the graph scope are opt-in.** `SUBSTRATE_DOCS_TANDEM`, `SUBSTRATE_DOCS_TANDEM_LIMIT`, `SUBSTRATE_DOCS_TANDEM_BUDGET_MS` and `SUBSTRATE_BRIEF_RECALL_SCOPE` default off; with them off behaviour is byte for byte unchanged. No other env var was added.
- **The consistency verifier repairs nothing by default.** `--repair` performs two safe plane-only actions; the index and the ledger are never written.

## Links

- Code: `memory-retain.ts`, `memory-recall.ts`, `memory-forget.ts`, `memory-forget-plane.ts`, `tandem-recall.ts`, `docs-search.ts`, `consistency-verify.ts`, `consistency-run.ts`, `service.ts` (all in `packages/mcp-server/src`); CLI `packages/cli/src/consistency.ts`
- Docs: `docs/runbooks/consistency-verify.md`, `docs/docs-search-ingest.md`, `docs/memory-governance.md`, `docs/data-planes.md` (graph scope), `docs/event-vocabulary.md` (memory forget events)
- ADR: `docs/adr/0004-store-roles.md`
- Discovery: `../55-migration-safety/CONTEXT.md`
