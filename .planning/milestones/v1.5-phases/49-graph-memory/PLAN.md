---
phase: 49-graph-memory
requirements: [SOTA-05]
status: planned; U1 and U2 are sequential in effect (U2 imports U1's exports), U3 follows
---

# 49-PLAN: Graph-linked memory and causal recall

## Units

### U1 — pure helpers (new module, no I/O)

Files: `packages/mcp-server/src/memory-graph.ts` (new), `packages/mcp-server/src/memory-graph.test.ts` (new).

- `reduceEvent(row)`: reduces a ledger row to `{id, ts, kind, surface, node_id, summary}`, with `summary` cut to 200 characters. Reuse the existing redaction used for ledger summaries when one exists; otherwise follow what the phase 46 context path does.
- `graphLinks(entriesByGraph, eventsByGraph)`: returns, for each distinct graph id in the input, the most recent 5 events in `ts`, `id` order, newest first.
- `causalChain(sessionEvents, sourceEventId)`: given a session's events in `ts`, `id` order and a source event id, returns up to 5 events before the source, nearest first. Returns an empty list when the source is not found.
- Tests: the reduction cuts summaries at 200 characters; graph links keep the newest five and handle a graph with no events; the causal chain is nearest first, excludes the source and later events, caps at five, and is empty for an unknown source.

Acceptance: the helper tests pass when the orchestrator runs them.

### U2 — wiring on memory_search

Files: `packages/mcp-server/src/mcp.ts` (the `memory_search` block only), `packages/mcp-server/src/service.ts` (the memory search function only, plus a private helper for the ledger reads), the existing memory search test file(s) (find by grepping for `memory_search` in `packages/mcp-server/src/*.test.ts`).

- `memory_search` gains optional booleans `graph_linked` and `causal`, default false. The service passes them through.
- Ledger reads use `GreptimeClient.readEvents`, normalizing ids as the ledger write path does (`normalizeIdentifier(id) ?? id`), each under a 1000 ms budget. One read per distinct graph and one read per distinct session, never per entry.
- With `graph_linked`, the reply gains `graph_links` built from `graphLinks`. With `causal`, each entry with a `source_event` gains `causal_chain` built from `causalChain` over that session's events. Both carry an untrusted notice, and the causal notice says the chain is what preceded the memory, not proof of cause.
- A timeout or error drops that part and sets `degraded` with a reason. Replies without the options are unchanged.
- Tests: no new keys without the options; with `graph_linked`, a returned graph's events appear and a graph with none is empty; with `causal`, an entry with a source event gets its preceding events in order; an entry without a source event gets an empty chain; a hanging ledger read returns within its budget with a reason.

Acceptance: the wiring tests pass when the orchestrator runs them; replies without the options are unchanged.

### U3 — documentation

Files: `docs/memory-governance.md` or the memory section of the most relevant existing doc (find it by grepping for `memory_search` under `/root/pr-fix/v149-graph/docs`), and `docs/event-vocabulary.md` only if a field is documented there (it is not expected to change).

- Document the two options, their sources, the budgets, the causal caveat, and that no schema or event kind changed.

Acceptance: the docs describe exactly what the tests pin.

## Orchestrator gates

- `bunx tsc --noEmit` exit 0.
- Full `bun test` against a phase-49 verification database, plus `bun run check:phase-close`.
- Records: CONTEXT, PLAN, SUMMARY, VERIFICATION under `.planning/phases/49-graph-memory/`.
