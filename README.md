# Agent Substrate

A four-plane layer — **runtime, memory, skills, ledger** — that lets every agent on the VPS
share one briefing, one event log, one skills library and one task key.

Agent-to-substrate is **MCP**. Client-to-agent is **ACP**. The task key is the **Graph ID**
that `claude-ultrathink` already mints for every uplifted prompt
(`ut-<ts36>-<8hex>`), and which already keys a Notion Task row, one Linear issue per
Graph-of-Thought node and one sub-issue per Chain-of-Thought step.

Notion and Linear are the source of truth. Postgres is an index. Greptime is the event log.

## Store lock

**Greptime is the append-only events ledger and nothing else** — not the source of record
for memory, which lives in the Postgres/Timescale index. Every write and every read goes
through `substrate-mcp`: no collector, CLI, hook or projector holds its own Greptime client,
and no agent gets Greptime as an MCP server of its own. Redaction and the hash chain live on
that one write path, so a second door would be an unredacted, unchained one.

The same holds for memory in the Postgres index: there is no ungoverned write path, so the
governance gate cannot be skipped by writing around it.

`packages/mcp-server/src/store-lock.test.ts` fails the build if either stops being true.
Details in [`docs/greptime-ledger.md`](docs/greptime-ledger.md) and
[`docs/memory-governance.md`](docs/memory-governance.md).

## Why

Eight agents run on this host and none of them knows what the others just did. The substrate
adds the two things the Notion and Linear rows do not hold: a **per-node claim** with a
timestamp, and the **action-level trail** — which files, which commands, which commits.

## Layout

```
packages/mcp-server/     substrate-mcp on 127.0.0.1:7410     (TS)
packages/cli/            substrate brief | emit | run | verify (TS)
packages/host/           rivet-agentos host, openTask         (TS)
packages/dispatcher/     Linear label → session               (Py)
packages/collectors/     Orca tee, grok/muse tails, git hook  (TS)
packages/projector/      substrate.yaml → per-agent config    (TS)
packages/ledger/         Greptime writer, Merkle anchor       (TS)
packages/connector-ext/  grok-hermes-connector v0.4 tools     (Py)
packages/miner/          Hermes cron, skill → PR watcher      (Py)
```

## Running

```sh
bun install
cp .env.example /etc/substrate/substrate.env   # then fill it in; chmod 0600
bun run mcp                                    # substrate-mcp on :7410
bun test
bun run check                                  # tsc --noEmit
```

Against a live Greptime, `bun run smoke:greptime` proves the ledger end to end — append_mode,
redaction, quoting, the hash chain and that UPDATE and DELETE are refused. It reads
`GREPTIME_*` from the environment and prints no credential:

```sh
set -a; . /etc/substrate/substrate.env; set +a && bun run smoke:greptime
```

`substrate-mcp` exposes MCP over streamable HTTP at `/mcp`, and — because agent hooks cannot
call MCP tools — the same briefing, event and memory paths as plain `POST /brief`,
`POST /events` and `POST /memory`.

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
