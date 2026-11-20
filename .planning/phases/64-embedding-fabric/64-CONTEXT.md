# Phase 64: Embedding fabric - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
A TEI client and its cache, health and fabric row, and one consumer: near-duplicate detection for the corpus planner. It does not re-embed LightRAG's index and does not change LightRAG's embedding binding.

## Decisions
- **D64-1:** Substrate has no TEI client today. The only mentions are the legacy RAG-backend constant `DATASET_EMBEDDING_MODEL = "tei-bge-small"` (`planes/RAG-backend.ts:140`) and the topology runbook, which says a TEI cpu-1.8 service exists in the Railway project and was reused for LightRAG (`docs/runbooks/lightrag-storage-topology.md:21-22`); the caller is LightRAG inside Railway.
- **D64-2:** model and dimension are pinned by flag (`SUBSTRATE_TEI_MODEL`, `SUBSTRATE_TEI_DIM`) and checked against `/info`; a mismatch is refused, because vectors of two models are not comparable.
- **D64-3:** the cache is Dragonfly in its cache-only role: a new class `emb` in `CACHE_TTL` and `CACHE_CLASSES` (`cache.ts:48`, `:69`), every key with a TTL (the production instance is loopback redis with `volatile-lru`, 256 MB, `infra/vps/redis-substrate.conf`), no new redis command (`cache-conformance.test.ts`).
- **D64-4:** TEI becomes the eighth fabric resource; adding one touches `fabric/types.ts:10-18`, `gather.ts`, `status.ts`, `compliance.ts`, `service.ts` `fabricSources()`, the fixtures and the order tests (`fabric-mcp.test.ts`). The endpoint must be loopback or an allowed proxy (`db-endpoints.ts`, `SUBSTRATE_DB_ENDPOINT_POLICY`).
- **D64-5:** near-duplicates are reported, never dropped on this signal alone.

## Open facts (UNVERIFIED in the repository)
The TEI base URL as seen from this host, its model and dimension, and its batch limit. The client reads them from `/info`; the operator supplies `TEI_URL`.

## Canonical references
`packages/mcp-server/src/cache.ts`, `planes/lightrag.ts` (client pattern: result values that never reject, `gatedFetch`), `fabric/*`, `flag-registry.ts`, `docs/data-planes.md`
