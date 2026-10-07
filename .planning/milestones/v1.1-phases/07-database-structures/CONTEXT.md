# Phase 7: Database structures - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted (gsd-autonomous). Decisions come from the accepted ADR, not from discussion.

<domain>
## Phase Boundary

agent-substrate server side of ADR 0001 S1 (SPE-5052): the swarm surfaces and tokens, "the token names the caller", and the durable `correlation_id` to Graph ID binding. Code goes on `feat/v1.1-schema-memory`, cut from `origin/main`, because the checked-out PR #10 branch predates merged PRs #5-#9.

</domain>

<decisions>
## Implementation Decisions

- 15 surfaces `swarm-a01-orch` ... `swarm-a15-doc`; token env `SUBSTRATE_TOKEN_<SURFACE>` (existing `envSuffixToSurface` convention).
- Token wins by refusal, scoped to `swarm-*` surfaces on MCP `events_emit`, MCP `graph_claim` and REST `/events`. Other authenticated surfaces and anonymous runs keep today's behavior because collectors rely on it; this boundary is documented.
- Binding: table `graph_bindings(correlation_id pk, graph_id, bound_by, created)` + index on `graph_id`, added to the existing idempotent `IndexStore.migrate()`. A separate versioned migration runner was considered and dropped: no requirement needs it and it would be a second DDL convention.
- MCP tool `graph_bind` (create / forward / reverse). No REST door: ADR 0001 fixes the REST doors and says graph tools stay MCP-only.
- `EVENT_KINDS` is not widened. Binding is recorded by a fail-open `note` event; the table row is the lookup.

</decisions>

<code_context>
## Existing Code Insights

- `types.ts` SURFACES (11) and EVENT_KINDS (12); `config.ts` `readTokens` / `envSuffixToSurface` / `allowAnonymous`; `mcp.ts` events_emit ~L229 and graph_claim ~L393 take a caller `surface` first; `server.ts` `/events` ~L336 does too, while `memoryWriter` and the handoff sender already use the token's surface.
- 912 tests pass on `origin/main`, 36 skipped (live-store tests); typecheck clean.

</code_context>

<specifics>
## Specific Ideas

Live-store tests run against a throwaway `postgres:16` container; the ledger side against `greptime/greptimedb:v0.14.4` (both images are already on the host).

</specifics>

<deferred>
## Deferred Ideas

Lease bridge (S2), projector (S4), gate verdict events (S5), self-improving memory bank (needs your decision, see REQUIREMENTS.md).
</deferred>
