# Coordination: leases, handoffs and drift

Eight agents share this host. The substrate's job is to stop them from
duplicating, overwriting or silently abandoning each other's work. Three
primitives do that, and this is what each of them promises — and what it
deliberately does not.

## Node leases

`graph_claim` takes a **lease**, not a claim.

| | Phase 0 claim | Lease |
| --- | --- | --- |
| Holder identity | the surface | the pair (surface, `session_id`) |
| Expiry | never | `ttl_seconds`, default 900 |
| Renewal | re-claiming | `graph_heartbeat` |
| Exclusivity | `claimed_by is null or claimed_by = surface` | compare-and-swap on a per-node epoch |
| Release | anyone | fenced on `lease_id` |

Two failures made the old claim unusable as a coordination primitive, and both
are gone:

- **Two sessions of one agent were one holder.** `claimed_by = 'hermes'`
  matched both Hermes sessions, so the second was told it held a node the first
  was already editing. Identity is now the pair, so they are two holders.
- **A claim never expired.** A session that was killed held its node until a
  human noticed. A lease lapses, and a dead holder releases its node by doing
  nothing — the only thing a dead holder reliably does.

### What makes it exclusive

Two writes decide who holds a node, and each is a single statement:

- a **change of hold** is guarded on `lease_epoch`, the epoch the decision was
  taken against. Of two agents that both read a free node, the second one's
  `UPDATE` matches no row, and it is told who won instead of overwriting them.
- the same statement **re-checks expiry against Postgres' clock**. A caller
  with a fast clock cannot declare someone else's live lease expired and take
  the node.

The decision rules live in `packages/mcp-server/src/lease.ts`, pure and with no
clock of their own; `IndexStore` is the enforcer. That split is what lets
`lease.test.ts` prove exclusivity by racing claims rather than by asserting that
the SQL looks right — and `index-store.lease.test.ts` then races the same claims
through two connections to a real Postgres.

### The contract an agent has to keep

1. Keep the `lease_id` from `graph_claim`. `graph_heartbeat`, `graph_release`
   and `graph_complete` all need it.
2. Heartbeat well inside the TTL for as long as you are working the node.
3. **Stop on a refusal.** `ok: false` from a heartbeat means you no longer hold
   the node: `lost` if someone else does, `expired` if it lapsed — re-claim
   rather than beat — `unheld` if nothing does.
4. A refused claim is not an error. You are told who holds it and until when;
   pick up something else rather than retrying.

A lapsed lease reads as **free** everywhere — in the brief, in a drift scan, to
the next claimant. That is why a heartbeat will not revive one: it would be safe
under the epoch CAS, but it would make all three of those readers wrong.

Release and complete are **fenced**. An agent that stalled past its TTL and woke
up cannot release — or close — a node a second agent has since claimed and is
still working on. `graph_complete` writes the state only once the release has
been accepted, so `completed: false` means nothing changed. `force: true` is the
operator's lever for a holder that is gone, and is recorded as a forced release
rather than an ordinary one.

Expiry is honoured lazily, so it is already correct without a reaper.
`coord_reap_leases` exists to make it **visible**: rows stop naming holders that
are gone, and each release becomes a warning another agent sees in its brief.

### Events a lease writes

| Action | Kind | Why |
| --- | --- | --- |
| `granted`, `reclaimed` | `claim` | ordinary |
| `stolen` | `warning` | the evicted holder may still believe it holds the node |
| `renewed` | *(none)* | an event per heartbeat would bury the trail under the one thing in it that carries no information |
| `released` | `note` | |
| `forced`, expiry | `warning` | somebody lost a node they did not release |

## Signed handoff packets

A handoff is the moment most likely to lose work: everything the receiver needs
is in the sender's context and none of it is written down. Phase 0's one-line
`handoff` event said that a handoff happened, not what it was.

A packet says what it was:

| Field | |
| --- | --- |
| `goal` | what the receiver is to achieve, in the sender's words |
| `files` | the paths the work touches |
| `dod` | the Definition of Done, as checkable lines |
| `blockers` | what is known to be in the way. Empty is a claim, not an omission |
| `prev_event_hash` | the sender's chain tip at handoff |

`prev_event_hash` is filled by the substrate from the sender's own session,
because it is a fact about the ledger and the ledger is here — a caller that had
to supply it would be free to supply the wrong one. It anchors the packet to the
trail: the receiver can verify every event that led here, and a packet quoting a
hash the ledger does not have is a packet from a session that did not happen as
described. The `handoff` event carrying the packet chains from the same tip, so
the packet and the event agree about where the sender had reached.

**Signed** because the packet is acted on by an agent that did not see it
written. The order is the point: the packet is redacted, capped, size-fitted and
*then* signed, so the bytes signed are the bytes stored. A signature that only
held before storage would be worse than none — and `normalizeEvent` redacts and
caps the payload on ingest, so this is a real hazard, with a round-trip test
against it.

- HMAC-SHA256, key from `SUBSTRATE_HANDOFF_KEY`, never from the repo.
- The signature covers the whole packet *including* `alg`, `key_id` and
  `signed_at`, so a packet cannot be back-dated or re-pointed at another key.
- `key_id` makes rotation safe: move the live key to `SUBSTRATE_HANDOFF_KEY_PREV`
  and give the new one a new id, and the packets already in the append-only
  ledger keep verifying.
- No key configured means the packet is recorded **unsigned and says so**. Fail
  open: a handoff refused for want of a key is context lost outright, which is
  worse than context that cannot be authenticated.

`coord_handoff_list` replays a graph's packets out of the ledger, each with its
own verdict. A packet that fails verification is still listed, with the reason —
hiding it would leave a gap in the history with no explanation for it.

The reply's `gaps` names what a receiver will find missing (no DoD, no files, no
anchor). Reported, not enforced: a thin handoff that was written down beats a
complete one that was refused and so never written at all.

## coord.drift_scan

The substrate keeps three records of what is happening in a repo and nothing
compared them:

1. **the tree** — git's HEAD;
2. **the trail** — the events the ledger holds;
3. **the claims** — the leases the index holds.

Each can be right while the others are wrong, and every interesting failure of a
multi-agent host is a disagreement between two of them.

| Finding | What it means |
| --- | --- |
| `git.tip_unlogged` | a commit happened outside the substrate — a collector is down or an agent is unwired |
| `ledger.commit_unknown_to_git` | the trail names a commit this checkout has not fetched, or that history was rewritten |
| `ledger.silent` | the repo has commits and no events at all |
| `lease.expired` | a lease lapsed and the row still names its holder |
| `lease.idle` | a live, heartbeating lease with no work behind it — the lease is alive, the work may not be |
| `lease.orphaned` | a lease held by a session that has already ended |
| `work.unclaimed` | work landed on a node nothing holds; a second agent could take it mid-flight |
| `edge.requires_incomplete` / `edge.gate_open` | a held node whose dependency is not done |

Two things it is careful about. Only the **holder's own** events count as signs
of life — counting any event in the repo would hide every dead session on a host
where anything else is running. And a record it could not read is listed in
`unavailable`, so empty findings is never mistaken for agreement.

It reports; it changes nothing. Deciding what to do about a disagreement is the
agent's.

Either supply `git_tip` — a hook has just run in the checkout, so it knows it —
or a `path` for the substrate to read. With neither, the tree is simply not
compared. When a path is given, `git` is spawned with a fixed argv and no shell,
the path must be absolute (so nothing in it can become a `git` option), and
every call is timed out.

## Graph edges

`graph_register` takes `edges` of kind `requires`, `blocks` or `gated_by`,
mirroring the Linear sub-issue relations the same nodes carry. They are held in
the index so a scan can check a claim against them without a Linear round-trip
on the critical path; Linear remains the source of truth.

`graph_claim` does **not** enforce them. A dependency that is merely recorded
should not be able to block an agent that knows better, and the index is a cache
— refusing a claim on a stale edge would be the worst of both. `drift_scan`
reports a held node whose dependency is not complete, and the agent decides.

**Not done:** mirroring these edges *into* Linear. There is no Linear client in
this repo yet — `LINEAR_API_KEY` is read by config and used by nothing — so it
is neither cheap nor already patterned, which is what the work order made it
conditional on. The index side is here and the write-back is a separate piece of
work.

## Running the proofs

```sh
bun test                                  # the pure algebra, raced
SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.lease
```

The live tests skip without a URL, and say so in their own output. Skipping
rather than mocking is deliberate: a mock of Postgres' concurrency would be a
mock of the one thing under test, and a green suite that proved nothing would be
worse than a skipped one that admits it.
