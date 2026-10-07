---
phase: 11-lease-authority
plan: 01
one-liner: "The substrate refuses any lease action a swarm agent is not entitled to: swarm sessions must name their own agent, a valid replica and the graph; a lease_id is shown only to its holder; only the holder's surface can beat, release or complete; and a swarm token is never an operator."
subsystem: mcp-server
tags: [swarm, leases, authority, adr-0001, s2, spe-5053]
provides:
  - swarm graph_claim session shape <AGENT>@<replica>:<graph_id>, checked against the token's surface and graph_id (MCP isError, never rewritten)
  - holder-only lease_id - public leaseView without the id, holderLeaseView only on a grant or an accepted heartbeat
  - not-holder refusal on graph_heartbeat, graph_release and graph_complete, checked before the lease_id compare
  - claim, warning, note and reaper payloads carry lease_epoch, never lease_id; coord_handoff packets record lease_handover instead of the id
  - swarm tokens are never operators, even when listed in SUBSTRATE_OPERATOR_TOKENS, with a boot warning naming the surface
  - claim replies carry ttl_seconds, the TTL the hold was granted for after clamping (null when no hold stands), so a holder paces its heartbeats by what was granted
key-files:
  modified:
    - packages/mcp-server/src/lease.ts
    - packages/mcp-server/src/index-store.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/handoff.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/lease.test.ts
    - packages/mcp-server/src/index-store.lease.test.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/authority.test.ts
    - packages/mcp-server/src/server.authority.test.ts
    - packages/mcp-server/src/mcp.test.ts
    - packages/mcp-server/src/drift.test.ts
    - packages/mcp-server/src/handoff.test.ts
    - docs/coordination.md
    - docs/swarm-correlation.md
    - README.md
key-decisions:
  - A lease_id is disclosed only on proof of holding it (a grant or an accepted heartbeat), not by matching the viewer, because two replicas of one agent share a surface and a token
  - not-holder is checked before the lease_id compare, so the refusal is the same whatever id is sent and is no oracle for ids
  - The caller surface is threaded through Substrate and IndexStore; the SQL fences are unchanged, since every change of holder mints a new lease_id
  - The session rule applies whenever the attributed holder is a swarm surface; non-swarm attribution keeps today's supplied-first behavior, and a token that claims as another surface is then refused not-holder on its fenced calls (documented)
  - handover_lease_id stays a request field only; signed packets record lease_handover, and legacy packets that carry the id still verify
  - Historic ledger events written before this change still hold ids; they cannot be scrubbed from an append-only ledger, and the not-holder check makes them useless to other surfaces
completed: 2026-10-07
status: complete
---

# Plan 11-01 Summary

## What shipped
- `graph_claim` from a swarm surface requires session `<AGENT>@<replica>:<graph_id>`: `AGENT` is the `Axx` of the token's surface, the replica matches `[A-Za-z0-9._-]{1,64}`, and the graph equals `graph_id`. Anything else is refused with MCP `isError` before the index is asked.
- No reply shows another holder's live `lease_id`: denied claims, refused heartbeats, releases and completions, `graph_get`, `graph_register`, `coord_drift_scan`, `/drift`, `coord_reap_leases`, event payloads and handoff packets. Holder surface, session, epoch and expiry still show.
- `graph_heartbeat`, `graph_release` and `graph_complete` refuse a caller whose token surface is not the holder's with `not-holder`, even with the right id. Anonymous local runs are not checked; operator `force` is unchanged.
- `isOperator` is false for any swarm surface's token; boot warns, naming the surface and never the token.
- `docs/coordination.md` and `docs/swarm-correlation.md` (new "Swarm leases" section) and the README describe the contract.

## Evidence
- Baseline (planning branch, identical to `origin/main` code): 965 pass / 46 skip (no DB), 1004 pass / 0 fail (live PG).
- Phase 11 branch: `bunx tsc --noEmit` clean; 994 pass / 48 skip / 0 fail (no DB); 1035 pass / 0 fail (live PG, `SUBSTRATE_TEST_PG_URL`).
- Live proof `/tmp/p11-lease-proof/run.sh` (worktree server on 127.0.0.1:7499, real Postgres and GreptimeDB, fresh tokens for `swarm-a05-be`, `swarm-a09-rev` and an operator, A09 deliberately listed as an operator): 42/42 checks, ALL PASS. These include four refused A05 session shapes and the granted `A05@r1:<graph>`; A09 sees no `lease_id` through 15 disclosing replies, `events_query` and `POST /events/query` payloads included; A09 is refused `not-holder` on heartbeat, release and complete with A05's id, and refused `force`; A05 still holds and then completes the node.

## Deviations
- `graph_register` also echoed held nodes' ids; it is redacted too (an extra leak path found while planning).
