# Milestones

## v1.1 Swarm correlation, governed memory and orchestrate integrations (Shipped: 2026-10-07)

**Phases completed:** 5 phases, 5 plans, 0 tasks

**Key accomplishments:**

- Swarm agents get their own substrate identities: 15 swarm surfaces whose tokens cannot act as another agent, and a race-safe binding of a swarm correlation id to one Graph ID (graph_bindings + MCP graph_bind).
- Swarm memory goes through the substrate's governed memory_write: one client with kind and scope maps, idempotency keys and a handler for every gate outcome, with default-deny proven from outside.
- Version conflicts on decisions report the version in force, so a swarm rewrite works however many newer entries share the decision's scope.
- A planned ultrathink prompt records its Graph ID in the substrate ledger, with no prompt text, inside the planning budget and without ever changing the hook's result.
- The swarm's run log reaches the substrate ledger under one Graph ID per run, attributed to the emitting agent, deduped and fail-open; orch_plan mints, binds and registers the graph.

**Close-out:** override closeout. Known verification overrides: 1 newly acknowledged, 0 carried forward from a prior close (see STATE.md Deferred Items): the v1.0 Phase 0 UAT (`phases/00-brief/0-UAT.md`, partial, 8 scenarios pending) was acknowledged as deferred at this close on the user's decision.

---
