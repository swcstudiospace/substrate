---
phase: 46-ragflow-hybrid
requirements: [SOTA-02]
status: designed on origin/main 92ef7c2; not yet implemented
---

# 46-CONTEXT: RAGFlow (retired, superseded by LightRAG) hybrid retrieval with Hindsight and Greptime context

## Scope (ROADMAP and 7-SOTA plan, item 2)

Goal: docs answers use hybrid search with reranking, augmented by Hindsight and Greptime event context.
Acceptance: `docs_search` returns context-augmented results; tests for hybrid.

## State on origin/main 92ef7c2 (scouted)

- Entry: `mcp.ts` tool `docs_search` (args `question`, `datasets?`, `session_id?`) → `service.ts` `searchDocs` → `searchDocsUnmeasured` → `docs-search.ts` `searchDocs`.
- Retrieval: one `retrieveChunks` per dataset, concurrent under one shared deadline. The wire body in `planes/ragflow.ts` carries `question`, `dataset_ids`, `page`, `page_size` (min(request, 10)), `similarity_threshold`, `vector_similarity_weight` (default 0.3), `top_k`. There is no rerank field and no keyword field.
- Merge: a global score sort, then the top 10. The reply is `SearchReply`: `chunks`, `untrusted` (the notice), optional `degraded`, `reason`, `degraded_datasets`.
- Cache: class `docs-search`, TTL 300 s, keyed by the normalised question, datasets, pins and degraded set. `searchReplyStorable` refuses partial or degraded replies.
- Hindsight recall: `planes/memory-recall.ts` `recallMemories({query, ...})` returns `{results, degraded, notice, reason?}`; a hit is `{bank, id, text, derived, document_id?, type?, scope?, repo?, tags, score?}`. Its budget is `searchRecallBudgetMs` (1500 ms default).
- Ledger read: `GreptimeClient.readEvents(column: "session_id" | "graph_id", value)` (`greptime.ts`) returns the rows of a session in time order. `Substrate.queryEvents` is the service-level path and is not needed.
- Locks that constrain this phase (scouted): `store-lock.test.ts` keeps `planes/ragflow` imports inside `packages/mcp-server/src` and forbids `RAGFLOW`/`HINDSIGHT` names outside it; `vocabulary-lock.test.ts` closes `EVENT_KINDS` at 12, so this phase adds no kind; `flag-registry.test.ts` requires one row per env read and a `NAME=` line in `.env.example`; `policy.test.ts` requires every tool to have a class and an audit set.
- The deployed RAGFlow (retired, superseded by LightRAG) version is unattested (comment at `ragflow.ts:12`).

## Decisions

- D46-a. Hybrid retrieval is RAGFlow (retired, superseded by LightRAG)'s own vector and keyword blend, tuned by `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT` (0 to 1, default 0.3, which is today's behaviour). Only the existing wire field is used by default, because the deployed version is unattested.
- D46-b. Reranking is opt-in: `SUBSTRATE_RAGFLOW_RERANK_ID` names a reranker model. Unset, the wire body carries no `rerank_id`. An unknown id on an older RAGFlow (retired, superseded by LightRAG) can fail the whole retrieval, so it is never sent by default.
- D46-c. Context augmentation is opt-in per call: `docs_search` gains `context?: boolean`, default false. Unset, the reply has no `context` key and is byte-identical to today, so existing consumers and cache entries are unaffected.
- D46-d. With `context: true`, the reply gains `context: {memories, events, degraded?}`.
  - `memories`: up to 3 Hindsight recall hits for the question, across the banks the caller can read, with `text` cut to 400 characters.
  - `events`: up to 5 of the most recent ledger events for the `session_id` the caller passed, reduced to `id`, `ts`, `kind`, `surface`, and `summary` cut to 200 characters. No `session_id` yields `events: []` and `degraded: 'no-session'`.
- D46-e. Context text is untrusted evidence. Every `context` block carries the same notice string as `untrusted`, and no context text is ever used as an instruction.
- D46-f. Context never changes the chunks, and it never removes them. The chunks are finished before any context leg starts, and the cache stores chunks only. The reply returns after the context legs finish, which is bounded: memory recall runs under `searchRecallBudgetMs` (HINDSIGHT_SEARCH_RECALL_BUDGET_MS) and the ledger read under its own 1000 ms budget. A timeout or error drops that source and sets `degraded`, and the chunk path is returned as before.
- D46-g. Context replies are not cached. `searchReplyStorable` refuses any reply with a `context` key, so an event context cannot be served stale for 300 s, and a session's events are never served to another session.
- D46-h. No new event kind, no new tool, no new audit class. The `docs_search` input schema gains two optional fields only.
- D46-i. Out of scope: attesting the RAGFlow (retired, superseded by LightRAG) version, keyword flags beyond the weight, pagination, and correcting `docs-plane.md` for the unsupported `limit` argument (recorded as an open item, not changed here).

## Acceptance mapping

- `docs_search` returns context-augmented results: `context: true` returns memories and session events from the fakes, and degrades cleanly when either source fails or no session is given (D46-d, D46-f).
- Tests for hybrid: the wire body carries the configured vector weight, carries `rerank_id` only when configured, and is unchanged by default (D46-a, D46-b).
