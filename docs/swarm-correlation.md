# Swarm correlation and identity (S1)

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

## The closed enum

`EVENT_KINDS` stays the closed set of 12. A swarm event type maps onto one of those kinds
and carries the specific type in `payload.swarm_type`; the enum is not widened. The
mapping table lives with the swarm's tee, not here.

## Not in S1

- Leases and handoffs for swarm tasks — S2 (SPE-5053).
- Swarm memory through the `memory_write` gate, and grants for the new surfaces — S3 (SPE-5054); see the swarm-surfaces note in [memory-governance.md](memory-governance.md).
- Wiring `substrate-mcp` into swarm workspaces, the projector — S4 (SPE-5055).
- Gate verdicts as substrate events and their verification — S5 (SPE-5056).
