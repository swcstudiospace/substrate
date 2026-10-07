# Phase 8: Memory structures - Context

**Gathered:** 2026-10-07
**Status:** Waiting on phases 7 and 10
**Mode:** Auto-accepted (gsd-autonomous). Decisions come from ADR 0001 S3 (SPE-5054).

<domain>
## Phase Boundary

Swarm memory is governed substrate memory. Substrate side: explicit default grants for the 15 swarm surfaces in `memory-policy.ts` (a fail-closed policy change, reviewed here, not swarm config). Swarm side: a thin client mapping `memory.write` / `memory.query` onto the REST `/memory` door and substrate memory tools, with the four outcome handlers.

</domain>

<decisions>
## Implementation Decisions

- Kind map: `decision` to `decision` (versioned, needs `expected_version`), `retro` to `fact`, `pattern` to `fact`. Scope map: `graph:<id>`, `repo:<owner/name>`, `agent:<swarm surface>`, `global`.
- `global` stays require-review, so a swarm-wide pattern is a proposal until a reviewer token releases it. Patterns land at `repo:` scope by default.
- Idempotency key = hash of `(correlation_id, task_id, attempt, content)`; a `verified_persisted: false` reply retries with the SAME key.
- There is no swarm memory store to replace: the swarm's vector memory is design-only today, so this is a new client, and the check that no swarm-side store feeds an agent lives in the swarm repo's own suite.

</decisions>

<code_context>
## Existing Code Insights

- Gate: `memory-write.ts`, `memory-policy.ts` (default grants ~L129-140, `parseGrants` ~L193 reads `SUBSTRATE_MEMORY_GRANTS`), `memory-classify.ts`. REST door `/memory` exists in `server.ts`.
- Depends on phase 7 (surfaces exist) and phase 10 (`swarm/substrate_client.py`).

</code_context>

<deferred>
## Deferred Ideas

Self-improving lessons bank: governed `fact` entries with tags would reuse this path; decision pending.
</deferred>
