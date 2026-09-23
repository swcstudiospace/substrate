# Agent Substrate

A four-plane layer — **runtime, memory, skills, ledger** — that lets every agent on the VPS
share one briefing, one event log, one skills library and one task key.

Agent-to-substrate is **MCP**. Client-to-agent is **ACP**. The task key is the **Graph ID**
that `claude-ultrathink` already mints for every uplifted prompt
(`ut-<ts36>-<8hex>`), and which already keys a Notion Task row, one Linear issue per
Graph-of-Thought node and one sub-issue per Chain-of-Thought step.

Notion and Linear are the source of truth. Postgres is an index. Greptime is the event log.

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
```

`substrate-mcp` exposes MCP over streamable HTTP at `/mcp`, and — because agent hooks cannot
call MCP tools — the same briefing and event paths as plain `POST /brief` and `POST /events`.

## Non-negotiables

- **Fail open.** A substrate outage must never block a prompt. Every hook swallows its errors
  and returns empty within its timeout.
- **Redact before emitting.** No credentials ever reach `agent_events`.
- Secrets live in `/etc/substrate/substrate.env`, never in this repo.

Architecture: see [`.planning/PROJECT.md`](.planning/PROJECT.md) and the Notion build plan.
