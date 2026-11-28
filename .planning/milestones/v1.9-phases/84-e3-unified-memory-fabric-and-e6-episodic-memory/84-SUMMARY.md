# Phase 84: E3 unified memory fabric and E6 episodic memory — summary

**Context:** `84-CONTEXT.md` (fabric seam `fabric/memory-fabric.ts`, episodic record on the ledger + retrievable via `session_registry`/`graph_get`, Hindsight bank owner, LightRAG provenance-only, no competing writers). Done: MemoryFabric routing, episodic record + supersession, LightRAG-write rejection with audit, fake-only tests. No commit.

## What shipped

- **MemoryFabric routing** — `packages/mcp-server/src/fabric/memory-fabric.ts:1` (pure routing over injected ports): `remember` → Hindsight retain only (`memory-fabric.ts:104`), `recall` → Hindsight + LightRAG provenance join (`memory-fabric.ts:128`, join by `document_id`, Hindsight text kept, LightRAG contributes metadata only), `forget` → Hindsight forget only (`memory-fabric.ts:173`). `ProvenanceChunk` (`memory-fabric.ts:32`) carries identity/score, never `content`. `productionPorts` (`memory-fabric.ts:202`) wires the env readers (`hindsightFromEnv`, `lightragFromEnv` in `config.ts:87`) to the plane clients (`retainMemories`, `recallBank`, `deleteDocument` in `planes/hindsight.ts`, `queryWithGraph` in `planes/lightrag.ts:465`).
- **LightRAG-write rejection (structural)** — `writeLightragContent`/`rememberTo` (`memory-fabric.ts:179`): rejected with `lightrag-write-forbidden`, exactly one audit event through `LedgerAuditPort`, no LightRAG write call — the `LightragPort` (`memory-fabric.ts:40`) has no write method, so the rejection is not just a checked gate.
- **Episodic record** — `packages/mcp-server/src/fabric/episodic.ts:1`: `EpisodicRecord` (`episodic.ts:23`) `{ session_id, graph_id, outcome, summary, provenance, supersedes_id? }`, payload builder (`episodic.ts:48`), ledger back-parse (`episodic.ts:61`), `supersessionChain` resolving `superseded_by` both ways (`episodic.ts:107`), session/graph filters (`episodic.ts:121/126`), registry grouping (`episodic.ts:137`).
- **Service + registry wiring** — `Substrate.recordEpisode` appends one ledger `note` (`packages/mcp-server/src/service.ts:3209`, fail-open like `bindGraph`'s note at `service.ts:4969`); `listEpisodes` reads via `queryEvents` (`service.ts:3227`) with chains resolved. `session-registry.ts` re-exports `episodicIndex` (`session-registry.ts:433`) — no `RegistryEntry` shape change. No new MCP tool, no admission/route-policy change (E4/Phase 85 consumes these).

## Verification (fake-only; no planes, no ledger, no network)

- `bun test packages/mcp-server/src/fabric/memory-fabric.test.ts packages/mcp-server/src/fabric/episodic.test.ts` — **15 pass, 0 fail** (45 expects): remember→Hindsight-only with zero LightRAG calls; recall join with `content` absent from the reply; LightRAG-only provenance rows carry `text: null`; down LightRAG degrades with Hindsight hits intact; rejection returns `lightrag-write-forbidden` with one audit event and no plane call; episodic round-trip; supersession chain ep-3→ep-2→ep-1; session/graph/registry filters.
- `bun test packages/mcp-server/src/fabric/` — **131 pass, 0 fail** (whole fabric dir, regression).
- `bun test … session-registry.test.ts service-forget.test.ts` (touched suites) — **172 pass, 0 fail**.
- `bunx tsc --noEmit` — clean. `bun run lint` — clean (1895 files).
- `bun run check:phase-close` — **pass** (239 pass, 4 lock files; EVENT_KINDS unchanged at 12).

## Deferred (out of scope, per CONTEXT)

RAG hybrid tuning (LightRAG graph mode) belongs to Phase 46 debt, not here. E4 orchestration (Phase 85) consumes the fabric routes.

## Loop harness

As above; no commit, per assignment.
