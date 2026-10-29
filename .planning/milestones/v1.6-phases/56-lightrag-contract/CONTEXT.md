---
phase: 56-lightrag-contract
milestone: v1.6
requirements: [SOTA-12]
discussed: 2026-10-26
status: implemented on gsd/v16-int (a573641); deploy, ingest and cutover operator-gated (phase 46)
---

# 56-CONTEXT: LightRAG client contract alignment and storage topology

## Goal

The substrate talks to LightRAG v1.5.x correctly and safely before any deploy: the client matches the upstream API, can never emit a clear-all, is contract-tested against a route table, and the hosting topology is decided and written down. Deploy, ingest and cutover stay in Phase 46 (T5 to T8). The full roadmap block is ROADMAP.md, Phase 56.

## Locked decisions

- **There was no previous LightRAG version.** No LightRAG service exists in either Railway project (read through the Railway API, 2026-10-26) and the RAGFlow service was deleted on 2026-10-25. This phase is client alignment to upstream v1.5.7 plus a topology decision, not a version migration (55-CONTEXT correction 4).
- **Evidence is upstream source, not a live server.** The route fixture is derived by hand from the HKUDS/LightRAG tag v1.5.7 and says so in its `provenance` field. Diffing it against a live `/openapi.json` is an operator step.
- **Recommended topology:** Postgres-only LightRAG storage (`PGKVStorage`, `PGDocStatusStorage`, `PGVectorStorage`, `PGTableGraphStorage`) on a dedicated pgvector Postgres service in project "Agent Substrate", reached only through the Tailscale forwarder; a pinned image, never `latest`. DragonflyDB stays cache-only (owner decision 2026-09-26). The Timescale service and a shared Postgres were not chosen. This is a recommendation with a cost; nothing was deployed.
- **No live action.** Deploy, ingest, cutover, RAGFlow code removal and any hosting decision wait for the operator.

## Links

- Runbook: `docs/runbooks/lightrag-storage-topology.md`
- Client: `packages/mcp-server/src/planes/lightrag.ts`; fixture `planes/__fixtures__/lightrag-v1.5.7-routes.json`; tests `planes/lightrag.test.ts`, `planes/lightrag.contract.test.ts`
- Docs: `docs/docs-plane.md`, `docs/data-planes.md` (reconciled 2026-10-26)
- Discovery record: `../55-migration-safety/CONTEXT.md` (findings P0 to P3 for this phase)
- Phase 46: `../46-lightrag-hybrid/`
