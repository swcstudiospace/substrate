# Coordination: leases, handoffs and drift

Eight agents share this host. The substrate's job is to stop them from
duplicating, overwriting or silently abandoning each other's work. Three
primitives do that, and this is what each of them promises — and what it
deliberately does not.

Telling a running session what to do next, and showing public context about its
repository's other sessions, is a fourth mechanism: [Live Steering](live-steering.md).
Its live identity is an independently server-issued public handle plus a private
binding proof, backed by mandatory PostgreSQL authority and retained tombstones.
Sharing a surface token or discovering a public ID does not grant private access.
Operator-only queue/ack and the public-redacted repository digest are separate.

Historical `session_id` labels used by graph leases, handoffs, checkpoints and
event attribution are **not** live-session credentials. Keep those labels stable;
private docs/brief use explicit `steering_session_id` and transport proof, while
hooks use separate `--steering-session` and selected `--binding-file`. Historical
`session.end` does not close a live handle; heartbeat/close are explicit. None of
this changes node-lease `lease_id` fencing, renewal or reclaim rules below.

The Phase 71 cutover is authored but unverified/not deployed. Legacy registry
rows are not backfilled; clients must open new live identities. Complete native
PostgreSQL recovery must retain binding/tombstone history, not infer it from
presence/cache/ledger. See the [index recovery limits](runbooks/index-archive.md).

## Node leases

`graph_claim` takes a **lease**, not a claim.

| | Phase 0 claim | Lease |
| --- | --- | --- |
| Holder identity | the surface | the pair (surface, `session_id`) |
| Expiry | never | `ttl_seconds`, default 900 |
| Renewal | re-claiming | `graph_heartbeat` |
| Exclusivity | `claimed_by is null or claimed_by = surface` | compare-and-swap on a per-node epoch |
| Release | anyone | fenced on `lease_id` and on the caller's token surface |
| Who sees the `lease_id` | n/a | the holder only |

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

1. Keep the `lease_id` from `graph_claim`. It is shown to you **once**, in the
   reply that grants it, and `graph_heartbeat`, `graph_release` and
   `graph_complete` all need it. Lost it? Re-claim with the same `session_id`,
   from the same token; doing so renews the lease and returns the same id.
2. Heartbeat well inside the TTL for as long as you are working the node.
3. **Stop on a refusal.** `ok: false` from a heartbeat means you no longer hold
   the node: `lost` if someone else does, `expired` if it lapsed — re-claim
   rather than beat — `unheld` if nothing does, and `not-holder` if your token
   is not the holder's surface.
4. A refused claim is not an error. You are told who holds it and until when;
   pick up something else rather than retrying.
5. Beat, release and complete with the **same token** you claimed with. The
   lease belongs to that token's surface.

### Only the holder sees, or uses, a lease

The `lease_id` is the fencing token. Whoever presents it can extend, release
or complete the node. So it reaches its holder and nobody else:

- **Disclosure.** A reply carries `lease_id` only when it grants the lease or
  answers a call that presented it and was accepted. A denied `graph_claim`, a
  refused `graph_heartbeat` / `graph_release` / `graph_complete`, `graph_get`,
  `graph_register`, `coord_drift_scan` and `/drift` all show `lease_id: null`
  beside the holder's surface and session, the epoch and the expiry — which is
  everything another agent needs to pick other work. `coord_reap_leases` names
  the epoch it cleared. The `claim`, `warning` and `note` events a lease writes
  carry `lease_epoch`, never the id, and a handoff packet records only
  `lease_handover: true|false` (absent on packets signed before the field
  existed, which may carry the old `handover_lease_id` instead).
- **Holder check.** `graph_heartbeat`, `graph_release` and `graph_complete`
  refuse a caller whose token surface is not the holder's with `not-holder`,
  even when it presents the right `lease_id`. The check runs before the id is
  compared, so the refusal confirms nothing about the id. It is surface-level:
  two sessions of one surface share a token, and the `lease_id` is what tells
  them apart. Anonymous local runs (no `SUBSTRATE_TOKEN_*` configured) have no
  identity to compare and are not checked; the id still fences them.
- **Renewal is the holder's too.** The holder's surface and session are public,
  and a `graph_claim` naming them renews a live lease (returning its id) or
  re-claims a lapsed one. So a claim that names the current holder from a token
  whose surface is not the holder's is denied `not-holder`: the expiry and epoch
  are unchanged, the reply has no `lease_id`, and no event is written. And a
  non-swarm token cannot name a `swarm-*` surface on `graph_claim` at all — it
  is refused before the index is asked.
- **Claiming for another surface locks you out.** A non-swarm token may still
  name another non-swarm surface on `graph_claim` (collectors rely on
  supplied-first attribution), and that first claim of a free or lapsed node is
  granted — but the lease then belongs to the surface it named. The token that
  took it is refused `not-holder` on every fenced call afterwards, and on every
  attempt to renew it by re-claiming; the lease lapses by TTL, or an operator
  forces it. Claim as yourself.

Events and packets written before this rule still hold ids in the append-only
ledger. They cannot be scrubbed, and the holder check is what makes them
useless to anybody but the holder's own token.

A lapsed lease reads as **free** everywhere — in the brief, in a drift scan, to
the next claimant. That is why a heartbeat will not revive one: it would be safe
under the epoch CAS, but it would make all three of those readers wrong.

Release and complete are **fenced**. An agent that stalled past its TTL and woke
up cannot release — or close — a node a second agent has since claimed and is
still working on. Two details carry that:

- **Completion is one statement.** The release and the state write go in the
  same guarded `UPDATE`. As two statements, another agent could claim the
  just-freed node in between and the state write would mark *their* live node
  completed.
- **A no-op release is not ownership.** Releasing a node nobody holds succeeds —
  that is right for a release — but it does not license a completion, or any
  caller could close any unheld node without ever holding it. `completed: false`
  with `reason: "unheld"` means claim it first.

`force: true` prises a node loose from a holder that is gone. It is an
**operator** action, not a peer's: every surface token is equally privileged, so
a `force` any agent could use would make every lease advisory again for anyone
who chose. It needs a token listed in `SUBSTRATE_OPERATOR_TOKENS`, and is
refused with `force-requires-operator` rather than quietly downgraded to an
ordinary release — a downgrade would read as success and leave the holder in
place. Force is not held to the holder's surface: taking a node off someone
else is what it is for.

An operator token is a **surface token that is also listed as an operator's**,
not a separate class of credential. That is deliberate. A token that
authenticated while naming no surface would reach the authoring routes with no
identity, and each of those falls back to the request body — so an operator
credential could have signed a handoff as any agent it cared to name. Operator
authority is an attribute of a surface token, so a forced release is always
attributable to whoever used it. Each `SUBSTRATE_TOKEN_*` variable holds a
comma-separated list, so the operator value is one entry among a surface's
others. An operator token that is not also a surface
token can never authenticate, and is reported at boot rather than left to look
configured. A value listed under two surfaces, or a variable naming no surface,
refuses boot with exit 78 rather than silently re-attributing a token.

**No swarm surface is an operator.** A `swarm-*` token listed in
`SUBSTRATE_OPERATOR_TOKENS` is still refused `force` (fail closed), and boot
warns, naming the surface (never the token). The swarm runs agents unattended
against each other's nodes; one of them able to force another is the advisory
lease again.

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

Each payload names the `action` and the `lease_epoch`, never the `lease_id`:
the ledger is readable by every agent through `events_query`.

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

A signature turns attribution into a claim, so everything it covers that the
substrate can know for itself, the substrate decides for itself:

- **The sender is the authenticated caller.** There is no `surface` argument on
  the MCP tool, and the REST route takes the token's surface over the body's. A
  packet naming another agent would carry a valid signature over a false
  identity — a forgery with a seal on it, which is worse than no signature,
  because the receiver has been given a reason to believe it.
- **The anchor is read from the ledger.** `prev_event_hash` cannot be supplied
  by the caller. A hash nothing checked would be signed and then believed: the
  receiver would get `ok: true` on a packet pointing at a trail that never
  happened.

The anchor ties the packet to the trail — the receiver can verify every event
that led here — and the `handoff` event carrying the packet chains from the same
tip, so the packet and the event agree about where the sender had reached.

With `release_lease`, the lease is dropped **after** the packet is durable.
Freeing the node first meant a refused append left it claimable with no packet
to replay: the next agent would find the work abandoned and no account of it.
Keeping the hold on a failed append is the recoverable half — the sender still
holds its node and can retry — and `lease_released` in the reply reports what
actually happened.

Which means the packet's `lease_handover` records that the sender *meant* to
hand its lease over, and no outcome. It cannot honestly record one: the packet
is signed before the release is attempted and is then immutable, while a
lease's state is not — a packet asserting "this node is free" would be stale the
moment another agent claimed it. Nor does it carry the lease id: every agent can
replay the packet, and the id is for the holder alone. The `lease_id` the sender
passes is used for the release (held, like any release, to the sender's token
surface) and is never signed or stored. Packets signed before this change carry
`handover_lease_id` instead; their signature covers it, so they are replayed and
verified exactly as stored. A receiver replaying a handoff does not read the
node's state off the packet. It calls `graph_claim`, which answers
authoritatively and is what it has to do anyway; whether the sender's release
landed is a separate event in the same ledger.

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

Four things it is careful about, three of them because getting them wrong makes
the scan worse than no scan:

- Only the **holder's own** events count as signs of life. Counting any event in
  the repo would hide every dead session on a host where anything else is
  running.
- **A heartbeat is not work.** `lease.idle` measures work inactivity from the
  last work event, with `claimed_at` as the floor — not from `lease_heartbeat_at`.
  Counting renewal as life made the one case this finding exists for — a zombie
  heartbeat loop with nothing happening under it — the one case it could never
  see.
- **`work.unclaimed` only fires on work that could still be in flight**: inside
  the idle window, on a node that is not completed or canceled. Comparing every
  event in the window against the leases held *now* reported every node an agent
  had legitimately finished and released.
- **A truncated window's silence is not evidence.** Whether the git tip was
  logged is asked of the whole ledger, not inferred from the newest N events — a
  busy repo pushes a well-logged commit out of that window, and inferring
  "unlogged" invented drift on exactly the repos with the most activity. When
  neither record can answer, it says so in `unavailable` rather than guessing.

And a record it could not read is listed in `unavailable`, so empty findings is
never mistaken for agreement.

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

Registering edges also writes them to Linear as `blocks` relations. The blocking issue is the source, so the waiting issue shows as blocked by it: `requires` and `gated_by` make the node that declares them wait on the other, and `blocks` makes the node it points at wait on its declarer. A relation already present in that direction is read and not written again, so re-registering a graph repeats nothing. An edge whose node has no tracker issue is skipped. A created or failed relation leaves one outcome on the waiting node, so it appears in that node's evidence. A Linear failure never fails the registration.

Edges **replace** rather than accumulate: `edges` present is the authoritative
set for that graph, `edges` absent leaves them untouched, and `edges: []` clears
them. Nodes and steps upsert field by field, because a partial register should
not erase what it does not mention — but an edge has no fields to merge, it
either holds or it does not. Insert-only meant a dependency removed upstream
could never be removed here, and every later scan went on reporting a held node
as blocked by a relation that no longer existed. The replacement runs in one
transaction, so a concurrent scan sees the old set or the new one and never an
empty moment in between.

`graph_claim` does **not** enforce them. A dependency that is merely recorded
should not be able to block an agent that knows better, and the index is a cache
— refusing a claim on a stale edge would be the worst of both. `drift_scan`
reports a held node whose dependency is not complete, and the agent decides.

## Tracker mirror

Linear and Notion show who holds each node as its lease changes, and only
hermes-linear-connector's Definition-of-Done gate can mark an issue Done.
The mirror is told each final lease decision — it never decides ownership —
runs awaited inside the tool call, serializes per node, never throws, and a
failure becomes one `mirror.failed` warning per failed target without
rolling the lease back. It never sees a lease id. A successful mirror writes one
`mirror.ok` note per target that landed; the Linear comment is its trail.

**The node artifact.** `POST /evidence` with `node_id` (JSON reply; `format: "html"`
ignores it) adds `node`: that node's `claim`, `linear`, `notion` and `dod` steps, in
time order. `claim` is every lease decision the ledger recorded for the node, whether
or not a tracker was bound. `linear` also carries the relation outcomes, with the
blocker and the edge kind. The steps are read from the graph's whole ledger, not a
browse window, and only events carrying the node's id count. An unreadable ledger is
`node.error`, never an empty artifact.

Claims move the issue to the team's first `started` state, set
`agent:<surface>`, remove every `dispatch:*` and every other `agent:*`, and
post one exact-text `Claimed by` comment per session; a steal moves the
label to the new holder. Releases, expiries and forces set the first
`unstarted` state and remove every `agent:*` with no comment — Linear's own
history shows the change. Heartbeats never reach a tracker. Notion sets
`Agent` and mirrors `Linear State` only when the Linear step succeeded.

`graph_complete` on a Linear-linked node needs `dod` evidence (`summary`,
`tests_pass`): without it the node parks at `started_review` with the lease
held (`dod-required`), and the connector is never called. With it the node
is fenced to `started_review`, mirrored to In Review, and `POSTed` to the
connector's `/v1/complete-issue`; only its explicit `completed: true`
approves, and the release note carries `payload.dod` (`tests_pass`,
`review_pass`, `summary_chars` — never the summary text). Only the
connector ever moves an issue to Done: `force` and other-state completions
clear the mirror (`close`) and leave Linear's state alone. A swarm holder's
completion is not gated and leaves only the `Completed by` comment — and a
swarm surface taking over a lapsed non-swarm lease posts only its comment,
so the evicted holder's label stays (pinned by test).

`graph_find` resolves a Linear issue to its one registered node (ambiguity
reported, never guessed) with the lease id nulled; `issue_get` returns the
redacted, capped issue text framed as untrusted. Both are read-only, silent
MCP tools. Rehearse every transition with `bun run smoke:mirror` against
loopback fakes; the operator-gated live proof is
`docs/runbooks/mirror-proof.md`.

## Running the proofs

```sh
bun test                                  # the pure algebra, raced
SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.lease
```

The live tests skip without a URL, and say so in their own output. Skipping
rather than mocking is deliberate: a mock of Postgres' concurrency would be a
mock of the one thing under test, and a green suite that proved nothing would be
worse than a skipped one that admits it.
