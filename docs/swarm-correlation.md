# Swarm correlation, identity and leases (S1, S2)

What the substrate provides so that Agent Swarm can run on it
([ADR 0001](adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md), phase S1, SPE-5052):
one `correlation_id` is one Graph ID, and every call is attributed to the agent that
actually made it.

## Surfaces and tokens

The 15 swarm agents are surfaces, A01..A15 in this order:

| Agent | Surface | Server-side token variable |
| --- | --- | --- |
| A01 | `swarm-a01-orch` | `SUBSTRATE_TOKEN_SWARM_A01_ORCH` |
| A02 | `swarm-a02-req` | `SUBSTRATE_TOKEN_SWARM_A02_REQ` |
| A03 | `swarm-a03-arch` | `SUBSTRATE_TOKEN_SWARM_A03_ARCH` |
| A04 | `swarm-a04-uxd` | `SUBSTRATE_TOKEN_SWARM_A04_UXD` |
| A05 | `swarm-a05-be` | `SUBSTRATE_TOKEN_SWARM_A05_BE` |
| A06 | `swarm-a06-fe` | `SUBSTRATE_TOKEN_SWARM_A06_FE` |
| A07 | `swarm-a07-data` | `SUBSTRATE_TOKEN_SWARM_A07_DATA` |
| A08 | `swarm-a08-qa` | `SUBSTRATE_TOKEN_SWARM_A08_QA` |
| A09 | `swarm-a09-rev` | `SUBSTRATE_TOKEN_SWARM_A09_REV` |
| A10 | `swarm-a10-sec` | `SUBSTRATE_TOKEN_SWARM_A10_SEC` |
| A11 | `swarm-a11-devops` | `SUBSTRATE_TOKEN_SWARM_A11_DEVOPS` |
| A12 | `swarm-a12-rel` | `SUBSTRATE_TOKEN_SWARM_A12_REL` |
| A13 | `swarm-a13-obs` | `SUBSTRATE_TOKEN_SWARM_A13_OBS` |
| A14 | `swarm-a14-maint` | `SUBSTRATE_TOKEN_SWARM_A14_MAINT` |
| A15 | `swarm-a15-doc` | `SUBSTRATE_TOKEN_SWARM_A15_DOC` |

They are real surfaces, not one shared `swarm` surface: memory RBAC is default-deny per
surface and a lease holder is (surface, `session_id`), so a shared surface would make all
15 agents one memory writer and one lease holder. Fifteen surfaces means fifteen tokens.

The variable name is the **server's** convention (`SUBSTRATE_TOKEN_<SURFACE>`, `-` → `_`,
uppercased). A swarm client process holds exactly one token, in `SUBSTRATE_TOKEN`, and
sends it as `Authorization: Bearer <token>`. The names are listed, blank, in
`.env.example`; values live only in `/etc/substrate/substrate.env`.

**Boot report.** When the deployment has any `SUBSTRATE_TOKEN_*` set, boot prints one
warning naming every swarm surface that has none (`swarmTokenWarnings` in `config.ts`). A
swarm agent without its own token is answered 401 — it is never accepted anonymously. A
bare local run with no tokens at all stays silent.

## The token names the caller

On exactly these three paths a swarm token **is** its surface:

- MCP `events_emit`
- MCP `graph_claim`
- REST `POST /events`

If the authenticated caller is a `swarm-*` surface and the request supplies a `surface`
that differs from it, the request is **refused** — REST answers `403 {"error": …}`, MCP
answers a tool result with `isError: true` and `{"error": …}`. Nothing is written and the
index is never asked. It is not silently re-attributed: a quiet rewrite would hide the
bug or compromise that sent it. If `surface` is absent or equal, the token's own surface
is used. Because the surface half of a lease holder is now the token's, one agent can no
longer hold or renew a lease as another.

**This is a deliberate boundary.** Every other authenticated surface, and an anonymous
local run, keeps the long-standing behaviour on those paths: a supplied `surface` is
attribution and wins over the token's, then the token's, then `claude-code`. Collectors
and hooks rely on that — one token legitimately emits for the surfaces it observes.
One exception, on `graph_claim` only: an authenticated non-swarm token naming a
`swarm-*` surface is refused the same way (`this token is hermes and cannot claim as
swarm-a05-be`), before the index is asked. A swarm holder's session is public, so
without this a `hermes` token could name A05's surface and session and renew A05's
lease. An anonymous local run may still claim as a swarm surface.
`memory_write` and `coord_handoff` were already token-only and are unchanged; other tools
that take an optional `surface` (`memory_brief`, `graph_register`) are unchanged too.

## `graph_bind`

Binds a swarm `correlation_id` to exactly one Graph ID. The Graph ID format is unchanged:
`ut-<ts36>-<8hex>`.

Input `{ correlation_id?, graph_id? }`, at least one required (otherwise a tool error).
`correlation_id` is 1..200 characters of `[A-Za-z0-9._:-]`; `graph_id` must match
`^ut-[a-z0-9]+-[0-9a-f]{8}$`.

| Given | Result |
| --- | --- |
| both | atomic insert-or-get on the unique `correlation_id` → `{ status: "created" \| "existing", correlation_id, graph_id, conflict }` |
| `correlation_id` only | forward lookup → `{ status: "existing" \| "unbound", correlation_id, graph_id: string \| null }` |
| `graph_id` only | reverse lookup → `{ graph_id, correlation_ids: string[] }` |

The returned `graph_id` is **always the stored winner**. `conflict` is `true` when it
differs from the one offered; the caller must adopt the returned one. Two concurrent binds
of one `correlation_id` yield exactly one `created` and one `existing` — the arbiter is the
primary key, via `insert … on conflict (correlation_id) do nothing` and a read of the
stored row.

Storage is the Postgres table `graph_bindings(correlation_id text primary key, graph_id
text not null, bound_by text, created timestamptz not null default now())` with an index
on `graph_id`, created idempotently by `IndexStore.migrate()`. There is deliberately no
foreign key to `graph_index`: a run binds before it registers its nodes. Without
`SUBSTRATE_PG_URL` the tool answers with an error, like the other graph tools.

On `created` one `note` event is emitted with `graph_id` set and payload
`{ correlation_id, bound_by }` (`bound_by` is the caller's surface, or `null` anonymous).
It is the tamper-evident *record* of the binding; the table row is the *lookup*, because
`events_query` filters on columns and never on `payload`. The emit is fail-open: a ledger
that is down costs the note, never the bind. `bound_by` and the event's surface come from
the token, never from an argument.

Over HTTP the tool is reached like any other: `POST /mcp`, JSON-RPC 2.0 `tools/call`,
`Content-Type: application/json`, `Accept: application/json, text/event-stream`, plus the
bearer token. The server is stateless, so no session handshake is needed; the reply is
plain JSON or an SSE body whose `data:` line holds the JSON-RPC response, and the tool's
JSON is `result.content[0].text`.

`graph_bind` is named in the fail-closed audit list, explicitly rather than by the
unknown-tool default (see `mcp-audit.md`).

## Swarm leases

What the substrate enforces so that a swarm agent can hold a node and nobody else can
use the hold (ADR 0001 S2, SPE-5053, requirements LEASE-01..04). The general lease
contract is in [coordination.md](coordination.md); this is what is specific to swarm
surfaces.

**Session shape.** A `graph_claim` whose holder surface is a swarm surface must carry
`session_id` = `<AGENT>@<replica>:<graph_id>`, for example `A05@r1:ut-mg3k2p-1a2b3c4d`:

- `<AGENT>` is the `Axx` of the surface (`swarm-a05-be` → `A05`), read off the surface
  itself, uppercase;
- `<replica>` is 1..64 characters of `[A-Za-z0-9._-]`, so it can never hold the `@` or
  `:` that delimit the session;
- `<graph_id>` equals the claim's own `graph_id`, compared by equality, not by pattern.

Anything else is refused with MCP `isError: true` and `{"error": …}` naming what was
wrong, and never rewritten. The index is not asked. The rule follows the holder, not
the caller: an anonymous caller that names a swarm `surface` on `graph_claim` is held
to it too, so every swarm hold reads the same way. Non-swarm surfaces claim with any
`session_id`, as before. Two replicas of one agent are two holders, because their
sessions differ.

**Holder-only ids.** The `lease_id` is shown only in the reply that grants it (or a
call that presented it and was accepted). A denied claim, any refused heartbeat,
release or complete, `graph_get`, `graph_register`, `coord_drift_scan` and `/drift`
show the holder's surface and session, the epoch and the expiry, with `lease_id: null`.
`coord_reap_leases` omits the id and reports `lease_epoch` and `expired_at` instead.
Lease events carry `lease_epoch`, and handoff packets carry
`lease_handover: true|false`, never the id (packets signed before that field existed
lack it, and may carry the old `handover_lease_id`). An A05 replica that lost its id
re-claims with its own token and session and gets it back.

**`not-holder`.** `graph_heartbeat`, `graph_release` and `graph_complete` refuse a
token whose surface is not the holder's with reason `not-holder`, even when the
`lease_id` is right. So A09's token cannot beat, release or complete A05's node with an
id it found in an old event. `graph_claim` holds a renewal to the same rule: a claim that
names the holder's surface and session, live or lapsed, from another surface's token is
refused `not-holder` — no expiry change, no `lease_id`, no event. The check is per
surface; between replicas of one agent, which share a token, the `lease_id` is the fence.

**No swarm operators.** A swarm token is never an operator. Listed in
`SUBSTRATE_OPERATOR_TOKENS` by mistake, it is still refused `force`
(`force-requires-operator`), and boot warns, naming the surface. Taking a node off a
dead swarm replica is a human operator's call, or the TTL's.

## The closed enum

`EVENT_KINDS` stays the closed set of 12. A swarm event type maps onto one of those kinds
and carries the specific type in `payload.swarm_type`; the enum is not widened. The
mapping table lives with the swarm's tee, not here. The lease rules above add no kind.

## Not here

- The swarm runner claiming, heartbeating and completing nodes, and its handoffs — S2's
  agent-swarm half (SPE-5053).
- Swarm memory client wiring — S3 (SPE-5054). The new surfaces already inherit the default `graph-any`, `repo-working`, `agent-self`, and `global-standing` grants; global memories still require review. What a swarm surface may and may not write is pinned by tests and described in [memory-governance.md](memory-governance.md).
- Wiring `substrate-mcp` into swarm workspaces, the projector — S4 (SPE-5055).
- Gate verdicts as substrate events and their verification — S5 (SPE-5056).
