# Phase 84: E3 unified memory fabric and E6 episodic memory — plan

**Context:** `84-CONTEXT.md` (fabric seam `fabric/memory-fabric.ts`, episodic record on the ledger + retrievable via `session_registry`/`graph_get`, Hindsight bank owner, LightRAG provenance-only, no competing writers). Reuse: `planes/hindsight.ts` retain/recall/forget (`retainMemories:533`, `recallBank:623`, `deleteDocument:723`), `planes/lightrag.ts` provenance (`queryWithGraph:465`, `DocsChunk` `planes/docs-wire.ts:4`), `service.ts` memory surfaces (`writeMemory:3235`, `recallMemories:3610`, `memoryForget:4501`, `queryEvents:3155`, `emit:2888`, `getGraph:4880`), `session-registry.ts` Phase 83 view. DG-1b: reads degrade, never throw (fabric style, `fabric/shared-context.ts` gate pattern). Fake-only tests, no live planes.

## Task 1 — `fabric/memory-fabric.ts`: MemoryFabric routing + provenance join + LightRAG-write rejection

New `packages/mcp-server/src/fabric/memory-fabric.ts` (pure routing over injected ports, like `fabric/shared-context.ts` over `ReadThroughCache` — no fetch in this file):

- Ports: `HindsightPort { retain(bank, items), recall(bank, query), forget(bank, id) }`, `LightragPort { provenance(query) -> ProvenanceChunk[] }` where `ProvenanceChunk` carries **metadata only** (`document_id`, `document_name`, `score?`, `heading_path?`, `source_url?`) — `content` never crosses the fabric. `LedgerAuditPort { audit(kind, summary, payload) }` for the rejection audit event.
- `MemoryFabric` class: `remember({bank, content, document_id, tags?, metadata?})` → Hindsight retain only; `recall({bank, query})` → Hindsight recall + LightRAG provenance, joined by `document_id` (Hindsight hits keep their text; LightRAG adds `provenance` metadata beside them; unmatched LightRAG chunks appear as provenance-only rows with `text: null`); `forget({bank, document_id})` → Hindsight forget only; `summarise` is not a plane op — documented as recall+derive, no new writer.
- `rememberTo(target, ...)` / `writeLightrag(...)`: any LightRAG content write through the fabric is **rejected** (`{ ok: false, reason: "lightrag-write-forbidden" }`) and emits one audit event via `LedgerAuditPort`; no LightRAG write method exists on the port, so the rejection is structural, not just a check.
- Fail-open: a down plane degrades its leg (`{ degraded, reason }`), never throws; an unconfigured plane is an empty leg with a reason.

Acceptance: `fabric/memory-fabric.test.ts` (fakes only) — remember hits Hindsight only (LightRAG fake records zero calls); recall join by `document_id` with LightRAG `content` stripped from the reply; recall with LightRAG down still returns Hindsight hits + `degraded`; LightRAG-write rejection returns the refusal and exactly one audit event, and the LightRAG write fake is never called.

## Task 2 — Episodic record: `fabric/episodic.ts` + `Substrate.recordEpisode/listEpisodes` + registry index

- New `packages/mcp-server/src/fabric/episodic.ts`: `EpisodicRecord { episode_id, session_id, graph_id, outcome, summary, provenance, supersedes_id? }`; `buildEpisodic(payload)` validates/caps; `parseEpisodicEvent(event)` reads a ledger `note` back; `supersessionChain(episodes)` computes `superseded_by`/`supersedes` links; `episodesForSession(episodes, sessionId, graphId?)` and `episodesForGraph(episodes, graphId)` are the retrieval filters `session_registry`/`graph_get` use.
- `service.ts`: `recordEpisode(record, surface)` appends one ledger event (`kind: "note"`, payload `{ episodic: true, episode_id, outcome, supersedes_id?, ... }`, fail-open like `bindGraph`'s note `service.ts:4969`) and returns `{ episode_id, stored }`; `listEpisodes({ session_id?, graph_id? })` reads via `queryEvents`/`readEvents` and returns `supersessionChain` output. No new MCP tool, no admission/route-policy change (E4 consumes these in Phase 85).
- `session-registry.ts`: pure `episodicIndex(episodes)` grouping episodes by `session_id`/`graph_id` with chain links — a view, no `RegistryEntry` shape change (additive export only).

Acceptance: `fabric/episodic.test.ts` (fakes only) — record→list round-trip; supersession visible (`superseded_by` points at the newer episode, chain walks back via `supersedes_id`); session/graph filters isolate; registry index groups without mutating entries.

## Task 3 — Loop harness + `84-SUMMARY.md`

Run `bun test packages/mcp-server/src/fabric/memory-fabric.test.ts packages/mcp-server/src/fabric/episodic.test.ts` (+ touched suites `session-registry.test.ts`), `bunx tsc --noEmit`, `bun run lint`, `bun run check:phase-close`. Write `84-SUMMARY.md` — file:line evidence per acceptance clause + loop results. No commit.
