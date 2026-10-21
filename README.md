# Agent Substrate

A four-plane layer — **runtime, memory, skills, ledger** — that lets every agent on the VPS
share one briefing, one event log, one skills library and one task key.

Agent-to-substrate is **MCP**. Client-to-agent is **ACP**. The task key is the **Graph ID**
that `claude-ultrathink` already mints for every uplifted prompt
(`ut-<ts36>-<8hex>`), and which already keys a Notion Task row, one Linear issue per
Graph-of-Thought node and one sub-issue per Chain-of-Thought step.

Notion and Linear are the source of truth. TimescaleDB is the index and queue, GreptimeDB is the
event log, DragonflyDB is a cache, Hindsight is memory and RAGFlow is documents — five Railway
services in two projects, reached over Tailscale. See [`docs/data-planes.md`](docs/data-planes.md)
and [`docs/railway-tailscale.md`](docs/railway-tailscale.md).

## Store lock

**Greptime is the append-only events ledger and nothing else** — not the source of record
for memory, which lives in the Postgres/Timescale index. Every write and every read goes
through `substrate-mcp`: no collector, CLI, hook or projector holds its own Greptime client,
and no agent gets Greptime as an MCP server of its own. Redaction and the hash chain live on
that one write path, so a second door would be an unredacted, unchained one.

Both halves of the events plane sit behind that one door: `events_emit` appends,
`events_query` reads a window back and `events_verify` recomputes a graph's hash chain.
No tool takes SQL — a query names filters, and the statement is built inside the ledger
client — so no seat needs the credential and no seat can reach past the filters it is given.

The same holds for memory in the Postgres index: there is no ungoverned write path, so the
governance gate cannot be skipped by writing around it.

`packages/mcp-server/src/store-lock.test.ts` fails the build if either stops being true.
Details in [`docs/greptime-ledger.md`](docs/greptime-ledger.md) and
[`docs/memory-governance.md`](docs/memory-governance.md).

## Why

Eight agents run on this host and none of them knows what the others just did. The substrate
adds the two things the Notion and Linear rows do not hold: a **per-node lease** with a TTL,
and the **action-level trail** — which files, which commands, which commits.

## Coordination

A node has at most one holder. `graph_claim` takes a **lease**, keyed on the pair
(surface, `session_id`) so two sessions of one agent are two holders, expiring after a TTL
so a killed session releases its node by doing nothing, and granted by a compare-and-swap on
a per-node epoch so of two agents racing for a free node exactly one wins. `graph_heartbeat`
extends a lease; `graph_release` and `graph_complete` are fenced on its id, so an agent that
stalled past its TTL cannot close a node someone else has since claimed. The `lease_id` is
shown only to its holder, and only the holder's token surface may renew, beat, release or
complete (`not-holder` otherwise).

`coord_handoff` writes a **signed packet** — goal, files, Definition of Done, blockers and
the sender's chain tip — redacted and fitted and *then* signed, so a receiving agent can
replay the handoff out of the append-only ledger alone and check it was not altered.

`coord_drift_scan` compares the three records of what is happening in a repo — git's HEAD,
the event trail, the leases held — and names where they disagree. It reports; it changes
nothing.

Details, and what each primitive deliberately does not promise, in
[`docs/coordination.md`](docs/coordination.md).

## Layout

```
packages/mcp-server/     substrate-mcp on 127.0.0.1:7410      (TS)
packages/cli/            substrate brief|emit|run|verify|evidence|lessons (TS)
packages/host/           rivet-agentos host, openTask         (TS)
packages/dispatcher/     Linear label → session               (Py)
packages/collectors/     grok, herdr and muse collectors, cursor stop hook, git hook  (TS)
packages/projector/      substrate.yaml → per-agent config    (TS)
packages/ledger/         pure Merkle root, memo and Solana    (TS)
packages/observability/  OTLP metrics and traces, the SLOs    (TS)
packages/audit/          hash-chained MCP audit, claim policy (TS)
packages/evidence/       per-graph evidence bundle, JSON/HTML (TS)
packages/connector-ext/  grok-hermes-connector v0.4 tools     (Py)
packages/miner/          Hermes cron, skill → PR watcher      (Py)
```

What each collector emits, which variables it reads, and where it keeps state:
Details in [`docs/collectors.md`](docs/collectors.md).

## Running

```sh
bun install
cp .env.example /etc/substrate/substrate.env   # then fill it in; chmod 0600
bun run mcp                                    # substrate-mcp on :7410
bun test
bun run check                                  # tsc --noEmit
```

Against a live Greptime, `bun run smoke:greptime` proves the ledger end to end — append_mode,
redaction, quoting, the hash chain, reading those events back through `events_query`, and that
UPDATE and DELETE are refused. It reads `GREPTIME_*` from the environment and prints no
credential:

```sh
set -a; . /etc/substrate/substrate.env; set +a && bun run smoke:greptime
```

`bun run rehearsal up|smoke|down` stands up a scratch twin of the server on loopback —
scratch Postgres and ledger in local containers, nothing production — and drives the
brief/emit/register/claim wire proof over it. Details in [`docs/rehearsal.md`](docs/rehearsal.md).
`bun run parity:check` is the read-only production check that the unit owns `127.0.0.1:7410`
and serves `main`; the procedure around it lives in [`docs/runbooks/production-parity.md`](docs/runbooks/production-parity.md).
`bun run verify` runs the whole verification gate (frozen install, `tsc`, the full suite, the repo locks); the CI workflow
runs the same commands once the organisation can run Actions. See [`docs/ci.md`](docs/ci.md).

`substrate-mcp` exposes MCP over streamable HTTP at `/mcp`, and — because agent hooks cannot
call MCP tools — the same briefing, event and memory paths as plain `POST /brief`,
`POST /events`, `POST /events/query`, `POST /memory` and `POST /verify`.

## Memory governance

**Memory is the one plane that fails closed.** A lost event costs the trail; a memory that
lands wrong sends the next four sessions down a road that does not exist. So every
`memory.write` passes one gate: default-deny RBAC over surface × scope × kind, a quarantine
pass for secrets, PII and speculation, an idempotency key claimed before anything is written,
and a conflict strategy per target — last-write-wins for todos, versioned with optimistic
concurrency for decisions, review for anything global. The reply is
`accepted | conflict | quarantined | denied` plus a remedy, and `verified_persisted` is a
separate claim read back from the index: **anything other agents act on requires both.**

`events.emit` still fails open. Details in [`docs/memory-governance.md`](docs/memory-governance.md).

The lessons bank is built on the same gate rather than beside it: a lesson from a finished
phase is one governed `fact` with subject `lesson:<milestone>/<phase>/<slug>`, recalled at
discuss time by `substrate lessons recall`, cited by entry id in the plan, scored on read
from outcome facts and rolled up into milestone digests, with no table, kind or write path
of its own. Details in [`docs/lessons-bank.md`](docs/lessons-bank.md).

## Observability and audit

Two more planes, both reached only through `substrate-mcp` and neither of them in Greptime:

- **OTLP metrics and traces** — latency, errors and tokens/cost per `surface` and `graph_id`,
  pushed as OTLP/HTTP JSON. Four SLOs are stated over them: brief p95 ≤ 800 ms, emit success
  ≥ 99.5 %, and ceilings on the lease-steal and quarantine rates. `GET /metrics` and
  `GET /slo` serve them with no collector configured. SPE-4793 words the first one
  `< 800 ms`; 800 ms is an inclusive bucket edge, so `≤` is what the histogram can actually
  decide and what `/slo` reports — [`docs/observability.md`](docs/observability.md) has the
  reasoning.
- **A hash-chained MCP audit** of what agents asked for and whether it was allowed, in its own
  local append-only file. Separate from `agent_events` on purpose: an audit has to survive an
  outage of the store it audits, and `agent_events` is writable by the agents being audited.

`substrate evidence --graph ut-… [--out evidence.html]` puts both chains' verdicts, each hour's devnet
anchor (with its transaction and explorer link), the graph's teachable moments, the SLO results and the
allowed/denied tally into one self-contained document. It exits 1 when an hour devnet cannot verify. It is
a stub and says so: Phase 2's Linear/Notion cross-check and the reconciliation of model spend are named in
its own `pending` list rather than left to read as nothing to report.

`emit` fails open and `claimNode` fails **closed**: a claim whose event never reached the
ledger is withdrawn, because a lock the substrate cannot tell another agent about is worse
than no lock. `bun run smoke:chaos` proves it against a live deployment with the ledger
blackholed for 60 s; `packages/audit/src/chaos.test.ts` proves the same decisions in CI.

Details in [`docs/observability.md`](docs/observability.md) and
[`docs/mcp-audit.md`](docs/mcp-audit.md).

## Desktop

`desktop_run` drives the dedicated `substrate-desktop` webtop with a closed
vocabulary — click, type, key, screenshot — and answers each screenshot as an
MCP image block. Only surfaces on the operator allowlist
(`SUBSTRATE_DESKTOP_SURFACES`) may call it; everyone else is refused before
anything runs. Each executed action leaves one `tool.call` event carrying
hashes and lengths only — never typed text or image bytes — and the audit
chain records the call fail-closed the same way. Details in
[`docs/runbooks/desktop.md`](docs/runbooks/desktop.md).

## Agent Swarm runs on this through substrate-mcp

[`swcstudiospace/agent-swarm`](https://github.com/swcstudiospace/agent-swarm) is a 15-agent
SDLC mesh — A01 `ORCH` through A15 `DOC`, single-writer artifact ownership, fail-closed
quality/review/security gates. It is a mesh of **roles**; the substrate is the **platform** it
will run on. Under the accepted architecture the swarm keeps its roster, its DAG and its gates;
the substrate is the source of record for events, governed memory, leases and handoffs, and the
swarm reaches all of it through `substrate-mcp` and nothing else — one `correlation_id` to one
Graph ID.

The swarm client calls this server when `SUBSTRATE_URL` is set: the event tee, task leases,
signed handoffs and governed memory. A cloud agent still does not call `substrate-mcp` directly
and does not receive `SUBSTRATE_TOKEN`. The Cursor host that plans a prompt and passes the Graph
ID is the remaining gap; it reaches this server through the same HTTP MCP entry, with the token
named and never written. The integration is phased across S1–S5 (SPE-5052 … SPE-5056). S1 closes
one gap in this repo first: for the 15 `swarm-*` surfaces the token now names the caller —
`events_emit`, `graph_claim` and `POST /events` refuse (REST 403, MCP tool error) a `surface`
that differs from the token's. Every other surface keeps the old behaviour, where a
caller-supplied `surface` wins over the token's, because a collector legitimately emits for the
surfaces it observes. S2's server half adds swarm leases: a swarm claim's session is
`<AGENT>@<replica>:<graph_id>`, a `lease_id` reaches only its holder, and no swarm token is an
operator. See [`docs/swarm-correlation.md`](docs/swarm-correlation.md).

[ADR 0001](docs/adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md) has the plane mapping, the
non-goals (no second Greptime door, no memory-gate bypass, no NATS replacement, no big-bang
delete of the swarm Task Store) and the per-phase acceptance criteria. Decisions live in
[`docs/adr/`](docs/adr/).

## Non-negotiables

- **Fail open — except memory.** A substrate outage must never block a prompt: every hook
  swallows its errors and returns empty within its timeout. Memory is the exception, and it
  is an exception at the *server*, not the hook: a write the gate cannot authorise, decide and
  verify comes back refused rather than as something the next agent will act on. The client
  still exits 0.
- **Redact before emitting.** No credentials ever reach `agent_events`. Redaction is on the
  write path inside `substrate-mcp`, not in each collector, so no collector can forget.
- **Append only, fail-closed.** Nothing rewrites or removes an event. The ledger client refuses
  every verb that could, and `agent_events` must be in Greptime's `append_mode` — which stops it
  deduplicating a row away — or the append is refused rather than silently at risk. Refusing is
  safe because the *client* fails open: a hook exits 0 either way, so this costs the trail, never
  the turn.
- Secrets live in `/etc/substrate/substrate.env`, never in this repo.

Architecture: see [`.planning/PROJECT.md`](.planning/PROJECT.md) and the Notion build plan.
Lane A proof: written by a dispatched Claude Code session in an agentOS VM (graph ut-muhk8v3p-47ae5f1a).
