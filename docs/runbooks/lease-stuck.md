# Runbook — a node lease is stuck

| | |
| --- | --- |
| Symptom | `graph_claim` answers `claimed: false` naming a holder that is no longer working; the brief lists the node as held; `coord_drift_scan` reports a held node with no activity |
| Scope | One row of `graph_nodes` in the Postgres index; the ledger notes around it |
| Blast radius | The one node. A release never touches Linear state (`force` closes nothing, D23-16) |
| Untouched | Other nodes, the graph row, memory tables, the ledger chain |

## What a lease looks like

A lease is five columns on the node row in `graph_nodes`
(`packages/mcp-server/src/index-store.ts`, decisions in `lease.ts`):

| Column | Meaning |
| --- | --- |
| `claimed_by`, `claim_session` | The holder: surface **and** session id. Two sessions of one agent are two holders |
| `lease_id` | The fencing token the holder was granted. Never shown to anyone else; a refusal names the holder and the expiry, not this |
| `lease_expires_at` | When the lease lapses. Every reader treats a lapsed lease as **free already**; a stuck lease is one that keeps being renewed, or one that lapsed and nobody has claimed since |
| `lease_heartbeat_at` | Last `graph_heartbeat` |
| `lease_epoch` | Monotonic per node, bumped on every change of hold. Every write is a compare-and-swap on it, so a stale holder cannot take a node back |

Rows written before leases existed have `lease_expires_at` null; expiry is then
`claimed_at + SUBSTRATE_LEASE_TTL_SECONDS`.

**TTL.** `SUBSTRATE_LEASE_TTL_SECONDS` (default 900, clamped to 30..86400 by
`normalizeTtlSeconds`) is the default a claim or heartbeat gets when it passes no
`ttl_seconds`. A DoD-gated completion extends the lease by the TTL plus the gate
timeout plus a minute (`reviewNode`), so a node at `started_review` can
legitimately hold for ~20 minutes with no heartbeat.

**Expiry is lazy.** Nothing has to run for a lapsed lease to be free: `claimNode`
re-checks expiry against **Postgres' clock** inside the UPDATE, so the next
claimant takes it over. `coord_reap_leases` (MCP; `Substrate.reapExpiredLeases`)
is housekeeping that makes that visible — it clears the holder columns of every
lapsed lease, emits one `warning` per node naming who was evicted and mirrors
`expire` to the trackers. Nothing schedules it; an agent or an operator calls it.

## Triage (read-only)

From an operator session with an authenticated `psql`, never from an agent:

```sql
select graph_id, node_id, state, claimed_by, claim_session, lease_epoch,
       lease_expires_at, lease_heartbeat_at, lease_expires_at <= now() as lapsed
from graph_nodes
where claimed_by is not null
order by lease_expires_at nulls first;
```

Then decide which of three cases it is:

1. **Lapsed, nobody claims it.** `lapsed = true`. It is already free. Run
   `coord_reap_leases` (optionally `repo`) so the row stops naming the holder and
   the ledger records the eviction. Done.
2. **Live, holder is gone.** `lapsed = false`, the session named in
   `claim_session` is dead (its collector shows no activity; no `graph_heartbeat`
   in the ledger since `lease_heartbeat_at`), and the expiry is far out (a
   long `ttl_seconds` or a gate-length review lease). Go to the release path.
3. **Live, holder keeps heartbeating.** It is not stuck; someone is working it.
   Talk to that surface's owner. Do not force.

Check the ledger before acting: `substrate evidence --graph <graph_id>` or
`events_query` for `session_id = <claim_session>` shows the last heartbeat,
the claim note and any `handoff`.

## Release path (operator)

Two levers, both leaving the holder's name in the record. Prefer the first.

**Expire it, then reap.** `IndexStore.expireLease` sets `lease_expires_at =
now()` on a held node and nothing else. No tool exposes it; the operator
equivalent is the same single-row statement from an authenticated session:

```sql
update graph_nodes set lease_expires_at = now()
where graph_id = '<graph_id>' and node_id = '<node_id>' and claimed_by is not null;
```

Then call `coord_reap_leases` with the graph's `repo`. The node goes through the
normal expiry path: the reaper clears it, emits the `lease … expired and was
released (held by <surface>)` warning, and mirrors `expire`. The epoch stays, so
the dead session's `lease_id` can never land a late heartbeat.

**Force it.** `graph_release` with `force: true` and a bearer listed in
`SUBSTRATE_OPERATOR_TOKENS` (which must also be a `SUBSTRATE_TOKEN_<SURFACE>`
token; swarm and `substrate` surfaces are never operators). The reply records
`action: "forced"` and `evicted`, the ledger gets a `warning` (`forced the lease
off <identifier>, held by <surface>`), and the mirror runs `force` (labels off,
Linear state untouched). Without an operator token the tool answers
`force-requires-operator` and writes nothing. Use this when the node must move
now and a reap cannot wait.

`graph_complete` with `force` exists for the same reason and additionally sets the
state; it never moves Linear to Done from this repo.

## What to record

- The row before (the triage SELECT), the decision (case 1/2/3) and the lever used.
- The ledger event id the release or reap produced (`events_query`,
  `session_id = <claim_session>` or `graph_id`).
- If case 2 recurs for the same surface, the collector or hook that stopped
  heartbeating — a stuck lease is a symptom; the fix is upstream.

## Rollback

A release is not reversible in place: the lease id is gone and the epoch has
moved. If the holder was in fact alive, it re-claims with `graph_claim` (a fresh
lease on the next epoch) and continues; its old `lease_id` is correctly refused
`lost`. Nothing in Linear or Notion changed, so there is nothing to restore
there. If the wrong node was expired, the same holder re-claims it the same way.

## Evidence

| Date (UTC) | graph / node | Case | Lever | Ledger event | Operator |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Add one row per intervention. Never paste a `lease_id` or a token here.
