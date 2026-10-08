# Milestones

## v1.2 v1.2 (Shipped: 2026-10-08)

**Phases completed:** 5 phases, 5 plans, 0 tasks

**Key accomplishments:**
- The substrate refuses any lease action a swarm agent is not entitled to: swarm sessions must name their own agent, a valid replica and the graph; a lease_id is shown only to its holder; only the holder's surface can beat, release or complete; and a swarm token is never an operator.
- The swarm runner works every task's node under a substrate lease it holds for the executing agent: claim before dispatch, heartbeat while the agent runs, complete on DONE, release and re-claim on rework, release on failure; two replicas never work one node and a dead replica's node frees itself.
- Context that crosses an accountable-agent boundary is written down by its sender as a signed coord_handoff packet and can be rebuilt from the ledger alone; a killed replica's node is taken over within one TTL with no two holders, and a failed gate handed to A14 is reconstructed with no bus or Task Store read.
- A fresh swarm workspace is wired to substrate-mcp by the install alone: one substrate MCP entry per runtime that names the token variable and never a value, a 0600 token file per agent outside every checkout, and a runner that gives each child only its own SUBSTRATE_TOKEN and leases and tees with that same agent's token.
- Lessons from finished phases become governed, citable memory: substrate lessons add/recall/digest/outcome over fact entries written through memory_write, with recall paging every lesson by subject prefix and a keyset cursor, scores computed at read time and digests that retire lessons without deleting them.

---

## v1.1 Swarm correlation, governed memory and orchestrate integrations (Shipped: 2026-10-07)

**Phases completed:** 5 phases, 5 plans, 22 tasks

**Key accomplishments:**

- Swarm agents get their own substrate identities: 15 swarm surfaces whose tokens cannot act as another agent, and a race-safe binding of a swarm correlation id to one Graph ID (graph_bindings + MCP graph_bind).
- Swarm memory goes through the substrate's governed memory_write: one client with kind and scope maps, idempotency keys and a handler for every gate outcome, with default-deny proven from outside.
- Version conflicts on decisions report the version in force, so a swarm rewrite works however many newer entries share the decision's scope.
- A planned ultrathink prompt records its Graph ID in the substrate ledger, with no prompt text, inside the planning budget and without ever changing the hook's result.
- The swarm's run log reaches the substrate ledger under one Graph ID per run, attributed to the emitting agent, deduped and fail-open; orch_plan mints, binds and registers the graph.

**Close-out:** override closeout. Known verification overrides: 1 newly acknowledged, 0 carried forward from a prior close (see STATE.md Deferred Items): the v1.0 Phase 0 UAT (`milestones/v1.0-phases/00-brief/0-UAT.md`, partial, 8 scenarios pending) was acknowledged as deferred at this close on the user's decision.

---

## v1.0 Agent Substrate build plan (phases 0-6, 0.5 inserted) (Closed: 2026-10-01)

**Phases completed:** 8 phases (0, 0.5 and 1-6) marked complete; only Phase 0 is complete and live. Closed on 2026-10-01 by an autonomous run in a working checkout; archived on main by PR #10.

**Key accomplishments:**

- Phase 0 (Brief) is complete and live: `substrate-mcp` runs under systemd and briefs Claude Code from a real event store and index.
- Phases 0.5 and 1-6 were marked complete, but several were built on stubs; the archived roadmap itself lists a dispatcher stub, an anchor stub, a RAGFlow proxy stub and an evidence export stub.
- The production versions landed separately on main: the Greptime events ledger in PRs #3 and #4, memory governance in #5 and #9, leases, signed handoffs and drift in #6, and OTLP, SLOs, the hash-chained MCP audit and the evidence bundle in #7.
- Never landed: the dispatcher, the docs/anchor CLI, the Solana memo, Agent Cards and herdr.

**Close-out:** the archived audit says `passed` (2026-10-01). An earlier audit on 2026-09-28 was `gaps_found`, and the PR #10 review disputes the `passed` result. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md) · phase folders: [milestones/v1.0-phases/](milestones/v1.0-phases/)

**Deferred:** Phase 0 UAT, 8 scenarios (`milestones/v1.0-phases/00-brief/0-UAT.md`), acknowledged as deferred at the v1.1 close.

---
