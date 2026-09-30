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

Both halves of the events plane sit behind that one door: `events_emit` appends,
`events_query` reads a window back and `events_verify` recomputes a graph's hash chain.
No tool takes SQL — a query names filters, and the statement is built inside the ledger
client — so no seat needs the credential and no seat can reach past the filters it is given.

`packages/mcp-server/src/store-lock.test.ts` fails the build if that stops being true.
Details in [`docs/greptime-ledger.md`](docs/greptime-ledger.md).

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
redaction, quoting, the hash chain, reading those events back through `events_query`, and that
UPDATE and DELETE are refused. It reads `GREPTIME_*` from the environment and prints no
credential:

```sh
set -a; . /etc/substrate/substrate.env; set +a && bun run smoke:greptime
```

`substrate-mcp` exposes MCP over streamable HTTP at `/mcp`, and — because agent hooks cannot
call MCP tools — the same briefing and event paths as plain `POST /brief`, `POST /events`,
`POST /events/query` and `POST /verify`.

## Non-negotiables

- **Fail open.** A substrate outage must never block a prompt. Every hook swallows its errors
  and returns empty within its timeout.
- **Redact before emitting.** No credentials ever reach `agent_events`. Redaction is on the
  write path inside `substrate-mcp`, not in each collector, so no collector can forget.
- **Append only, fail-closed.** Nothing rewrites or removes an event. The ledger client refuses
  every verb that could, and `agent_events` must be in Greptime's `append_mode` — which stops it
  deduplicating a row away — or the append is refused rather than silently at risk. Refusing is
  safe because the *client* fails open: a hook exits 0 either way, so this costs the trail, never
  the turn.
- Secrets live in `/etc/substrate/substrate.env`, never in this repo.

Architecture: see [`.planning/PROJECT.md`](.planning/PROJECT.md) and the Notion build plan.
