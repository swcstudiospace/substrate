---
phase: 49-graph-memory
requirements: [SOTA-05]
status: designed on origin/main f2138e1; not yet implemented
---

# 49-CONTEXT: Graph-linked memory and causal recall from Greptime events

## Scope (ROADMAP and 7-SOTA plan, item 5)

Goal: Hindsight memory is graph-structured and built from Greptime events, with causal recall.
Acceptance: `memory_search` returns graph-linked results; recall uses causal.

## State on origin/main f2138e1 (scouted)

- Memory rows (`memory_entries`, `index-store.ts`) carry `id`, `scope`, `kind`, `body`, `subject`, `source_event` (set once), `writer`, `session_id`, `graph_id`, `repo`, `supersedes`, `superseded_by`, `created`. The only links are `supersedes`/`superseded_by` and `source_event`.
- Events (`agent_events`, Greptime) carry `ts`, `id`, `surface`, `session_id`, `graph_id`, `node_id`, `step`, `repo`, `kind`, `summary`, `payload`, `hash`, `prev`. `prev` is the hash of the session's previous event, so each session is a hash chain. `ts` is client-supplied and is not a safe order.
- `GreptimeClient.readEvents(column, value)` returns the rows of a `session_id` or `graph_id`, ordered by `ts`, `id`.
- `memory_search` (`mcp.ts` 385 to 462) merges an index search with a Hindsight recall leg (`service.ts` `searchMemory`, `mergeDerivedHits`). Its output is `{entries, derived, degraded, notice, reason?}`, or a paged shape.
- Hindsight (`planes/hindsight.ts`) stores retained text with `document_id`, `metadata` and tags, and has no graph or link field. `graph_id` and `session_id` are not forwarded on retain (`memory-retain.ts`). Replace-upserts would rewrite existing documents if metadata changed.
- Constraints that bind the design:
  - `CREATE TABLE IF NOT EXISTS` does not add columns to a live `agent_events` table, so a new column needs an operator recreate. No new column is added in this phase.
  - No new Postgres table either: `index-archive-spec.ts` pins the schema hash.
  - `vocabulary-lock.test.ts` closes `EVENT_KINDS` at 12 and `SURFACES` at 27. This phase adds no kind.
  - `store-lock.test.ts` allows only the substrate-mcp service to read the ledger, and memory tables only in `index-store.ts` and `memory-write.ts`. The new read path stays in the service and uses the existing Greptime client read.

## Decisions

- D49-a. No schema change. Causality uses fields that already exist: the session chain (`session_id`, `prev`, `step`, `ts`, `id`) and the memory's `source_event`, `graph_id` and `session_id`.
- D49-b. `memory_search` gains an optional `graph_linked` boolean, default false. With it set, the reply gains `graph_links`: for each distinct `graph_id` among the returned entries, up to 5 of that graph's most recent ledger events, reduced to `id`, `ts`, `kind`, `surface`, `node_id`, `summary` cut to 200 characters, with the untrusted notice. A graph with no events gives an empty list and no error.
- D49-c. `memory_search` gains an optional `causal` boolean, default false. With it set, each returned entry that has a `source_event` gains `causal_chain`: up to 5 events from that event's session that come before it in session order (by `ts`, then `id`), nearest first, reduced as in D49-b. An entry without a `source_event`, or a source event not found, gets an empty chain and no error.
- D49-d. Causal means "the events that preceded this memory in its session". It is not proof of cause, and the reply says so in its notice. No inference is stored.
- D49-e. Limits and budgets: each ledger read runs under 1000 ms, and reads are per distinct graph or session, never per entry more than once. A timeout drops that part and sets `degraded` with a reason, as in phase 46. Results are never delayed past these budgets.
- D49-f. Hindsight metadata is not changed (replace-upserts would rewrite existing documents). Graph and causal context come from the ledger and the index only.
- D49-g. No new event kind, no new tool, no new audit class, no schema change. Writer and kind filters on `memory_search` are out of scope (the parser drops them today; recorded as an open item).
- D49-h. Both options are read-only and default off, so existing `memory_search` replies are byte-identical.

## Acceptance mapping

- `memory_search` returns graph-linked results: with `graph_linked: true`, `graph_links` carries each returned graph's recent events, and a graph with no events is empty (D49-b).
- Recall uses causal: with `causal: true`, each entry with a source event carries `causal_chain` in session order, nearest first (D49-c).

## Open items

- Writer and kind on `memory_search`: the index supports them, `parseMemorySearch` drops them. Out of scope here.
- Hindsight recall by graph: Hindsight has no graph field, so graph-linked recall over Hindsight documents is not attempted.
