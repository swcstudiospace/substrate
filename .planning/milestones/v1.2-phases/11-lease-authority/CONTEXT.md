# Phase 11: Lease authority - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted (gsd-autonomous). Decisions come from ADR 0001 S2, REQUIREMENTS.md LEASE-01..04 and the v1.2 lease-disclosure research, not from discussion.

<domain>
## Phase Boundary

agent-substrate server side of ADR 0001 S2 (SPE-5053): a swarm claim's session names its agent, replica and graph; a `lease_id` reaches only its holder; only the holder's token surface can beat, release or complete; no swarm token is an operator. Code goes on `feat/v1.2-p11-lease-authority`. The swarm runner that uses these leases is Phase 12 (agent-swarm). No caller outside agent-substrate uses `graph_claim` / `graph_heartbeat` / `graph_release` / `graph_complete` today, so the behaviour changes break nobody downstream.

</domain>

<decisions>
## Implementation Decisions

- **LEASE-01 session shape.** A `graph_claim` whose attributed surface is a swarm surface must carry `session_id` = `<AGENT>@<replica>:<graph_id>`. Checked in `mcp.ts` (`swarmSessionRefusal`, beside `attributedSurface`) after attribution and before the index is asked; refused with MCP `isError`, never rewritten.
- **LEASE-02 disclosure.** `leaseView` becomes the public view (`lease_id: null`); `holderLeaseView` is used only where the reply proves the hold (a grant, an accepted heartbeat). Node rows leave the service with `lease_id: null` (`graph_get`, `graph_register`, `graph_claim`'s `node`). `decideClaim` denials carry `lease_id: null`. The reaper returns `lease_epoch`, not `lease_id`. Claim / warning / note payloads carry `lease_epoch` instead of `lease_id`.
- **LEASE-02 handoff.** The signed packet drops `handover_lease_id` and gains `lease_handover: boolean` (intent only). The id stays a request-only input used for the release. Old packets keep verifying because verification recomputes over the packet as stored.
- **LEASE-03 holder check.** New refusal `not-holder` in `decideHeartbeat` and `decideRelease`, checked before the `lease_id` compare, skipped for a null caller and for `force`. `caller: Surface | null` is threaded through `mcp.ts` → `Substrate` → `IndexStore` → `lease.ts` as a required parameter.
- **LEASE-04.** `isOperator` returns false for any token whose surface is a swarm surface; `configWarnings` names the surface (never the token). Wired at boot through the existing `index.ts` loop.
- `EVENT_KINDS` is not widened; no new tool, no REST lease route (ADR 0001 keeps graph tools MCP-only).

### Claude's Discretion

- **Agent derived from the surface, no table:** `swarm-a05-be` → `A05` by `surface.split("-")[1].toUpperCase()`; `SWARM_SURFACES` stays the one roster.
- **Replica `^[A-Za-z0-9._-]{1,64}$`, exported as `SWARM_REPLICA_PATTERN`:** the charset cannot contain the `@`/`:` delimiters, so parsing at the first `@` and the next `:` is unambiguous, and the graph part may still contain either.
- **Graph by equality with the `graph_id` argument, not `GRAPH_ID_PATTERN`:** a session naming another graph is a replay or a bug; a pattern would also break legitimate fixtures like `ut-1`.
- **The session rule follows the holder, not the caller:** a non-swarm or anonymous caller naming a swarm `surface` is held to it too, so every swarm hold has the same shape and a forged swarm hold cannot carry a free-form session.
- **Uppercase agent required (`A05`, not `a05`):** agent-swarm writes `f"{agent}@{replica}:{graph_id}"` with the uppercase id; accepting both would mean two spellings of one holder.
- **Redaction is "disclose only on proof", not viewer-matching:** a reply shows the id only when its own request minted or presented it. A viewer-based view would leak between replicas of one agent, which share a surface and a token.
- **Reads never show the id to anyone, the holder included:** the holder already has it from its grant; a holder that lost it re-claims with the same session, which renews and returns the same id.
- **A non-grant claim reply (denied, withdrawn) carries `lease_id: null`:** a withdrawn hold is not a hold, and re-reading why is not worth a query on a degraded path.
- **`lease_epoch` replaces `lease_id` in lease event payloads:** it keeps the ordering information a reader needs; the ledger is readable by every agent, so the id cannot go there. Old events with ids cannot be scrubbed; LEASE-03 makes them useless to other surfaces.
- **Handoff: record intent (`lease_handover`), not the id:** request-only id for the release; `HANDOFF_VERSION` stays 1 because verification does not depend on the field list and no consumer reads the old field. `HandoffPacket.handover_lease_id?` is kept as an optional legacy read type for replayed old packets.
- **Holder check before the id compare:** a stranger gets the same `not-holder` whatever id it sends, so the refusal is not an oracle.
- **Check against the observed snapshot only; no `claimed_by` predicate in SQL:** a change of holder always mints a new lease id, so the existing `lease_id` fence already pins the holder the decision saw.
- **Surface-level, not session-level, holder check:** fenced calls carry no session today, and replicas of one agent share a token; between them the `lease_id` is the fence (LEASE-08 is Phase 12's).
- **Null caller is never checked:** only anonymous local runs have a null caller (a configured deployment 401s a token with no surface), matching `isOperator`'s local-run rule.
- **Internal callers pass their own surface:** the claim withdrawal passes the claimant's surface; the handoff release passes `from.surface`, or null when `config.allowAnonymous` (an anonymous run's `from` is body- or default-supplied and identifies nobody).
- **`force` skips the holder check:** taking a node off someone else is what force is for, and `mcp.ts` already gates it on `isOperator`. Behaviour otherwise unchanged (an explicit wrong `lease_id` with force still answers `stale-lease`).
- **Non-swarm "claim as another surface" is accepted and documented, not blocked:** LEASE-01 requires non-swarm claims to behave as before. Such a lease belongs to the named surface, so the claiming token is refused `not-holder` afterwards; the lease lapses by TTL or an operator forces it. Documented in `coordination.md` ("Claim as yourself").
- **`graph_register`'s reply is redacted too:** re-registering a graph echoes held nodes, a disclosure path the research table did not list.
- **Swarm operator: fail closed in `isOperator`, warn in `configWarnings`:** the list is configuration someone can get wrong; refusing in code means a mistake costs a warning, not an eviction.

</decisions>

<code_context>
## Existing Code Insights

- `lease.ts`: pure `decideClaim` / `decideHeartbeat` / `decideRelease` / `leaseView`. `index-store.ts`: `claimNode` / `heartbeatNode` / `releaseNode` / `reapExpiredLeases`, fenced by `lease_epoch` + `lease_id`. `service.ts`: telling + ledger events + fail-closed claim; `handoff` releases after the append. `mcp.ts`: `attributedSurface`, `McpCaller {surface, isOperator}`, `FORCE_REFUSED`. `config.ts`: `isOperator`, `configWarnings`.
- Disclosure paths (research): denied claim, refused heartbeat/release/complete, `graph_get`, drift (MCP + REST), reaper, claim/note/warning payloads, handoff packet. Found here as well: `graph_register`'s echo.
- No caller of the four lease tools outside this repo (agent-swarm only tees events and calls `graph_bind`; claude-ultrathink only `/brief`, `/events`, `graph_register`).

</code_context>

<specifics>
## Specific Ideas

Live proof: `/tmp/p11-lease-proof/run.sh` boots the worktree's server on 7499 against the smoke Postgres (55432) and GreptimeDB (54000) with tokens for `swarm-a05-be`, `swarm-a09-rev` and an operator `cursor`, with A09's token listed as an operator by mistake.

</specifics>

<deferred>
## Deferred Ideas

- Session-level holder check (a caller session on fenced calls): needs a request field the tools do not take; Phase 12 decides whether replicas need it.
- Operator-gating `coord_reap_leases`: not a lease-authority requirement; it only clears lapsed leases.
- Scrubbing ids from events and packets written before this phase: the ledger is append-only.
</deferred>
