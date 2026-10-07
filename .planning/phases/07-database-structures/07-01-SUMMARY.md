---
phase: 07-database-structures
plan: 01
subsystem: mcp-server
tags: [swarm, identity, graph-bindings, adr-0001, s1, spe-5052]
provides:
  - 15 swarm surfaces swarm-a01-orch..swarm-a15-doc with SUBSTRATE_TOKEN_SWARM_* names and boot warning
  - token-names-the-caller refusal for swarm surfaces on events_emit, graph_claim, REST POST /events
  - graph_bindings table (unique correlation_id, graph_id index, no FK)
  - MCP tool graph_bind (create, forward, reverse)
key-files:
  created:
    - packages/mcp-server/src/graph-bind.test.ts
    - docs/swarm-correlation.md
  modified:
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/index-store.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/index.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/authority.test.ts
    - packages/mcp-server/src/mcp.test.ts
    - packages/mcp-server/src/server.authority.test.ts
    - packages/audit/src/policy.ts
    - packages/audit/src/policy.test.ts
    - docs/mcp-audit.md
    - README.md
    - .env.example
key-decisions:
  - Refusal, not re-attribution, scoped to swarm-* surfaces; other surfaces and anonymous runs keep today's behavior
  - graph_bindings added to the existing idempotent IndexStore.migrate(); no versioned migration runner
  - graph_bind is MCP-only; no POST /graph (ADR 0001)
  - EVENT_KINDS not widened; binding recorded by one fail-open note on create, own session bind:<graph>:<corr>
  - graph_bind explicitly fail-closed in packages/audit policy
completed: 2026-10-07
status: complete
---

# Plan 07-01 Summary

## What shipped
- `SURFACES` gains the 15 swarm surfaces; `.env.example` names their 15 tokens; boot warns about missing swarm tokens on non-anonymous deployments.
- A swarm token claiming another surface is refused on MCP `events_emit`, MCP `graph_claim` and REST `/events` (REST 403, MCP `isError`). Non-swarm behavior unchanged and documented.
- `graph_bindings(correlation_id pk, graph_id, bound_by, created)` + `graph_id` index, no FK, in `IndexStore.migrate()`.
- `graph_bind` create / forward / reverse; concurrent creates yield one winner. One `note` on create under session `bind:<graph>:<corr>`.
- `docs/swarm-correlation.md` new; `docs/mcp-audit.md` and README updated.

## Evidence
- Baseline `origin/main`: 912 pass / 36 skip (no DB), 943 pass (live PG).
- S1 branch: tsc clean, 954 pass / 44 skip / 0 fail (no DB), 992 pass / 0 fail (live PG).
- Live smoke `/tmp/s1-live-smoke.sh` (with agent-swarm S1, real `postgres:16` + `greptime/greptimedb:v0.14.4`): 24/24 checks.

## Delivery
PR agent-substrate #11, branch `feat/s1-swarm-identity-binding`, commits 933f970 + 05f15dd. Greptile review in progress; a fix made from review so far: binding notes got their own session.

## Deviations
None from the plan. Self-improving lessons bank is deferred pending the user's decision (not part of this phase).
