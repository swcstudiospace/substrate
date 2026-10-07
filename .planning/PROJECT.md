# Project: Agent Substrate

**Source of truth for architecture:** [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2)
**Control plane:** Notion "Agent Task Graph" + Linear team Spectrum Web Co
**Repo:** `swcstudiospace/agent-substrate` (private)

## Current Milestone

**v1.1 Swarm correlation, governed memory and orchestrate integrations** (2026-10-07, complete)

Re-grounded on `origin/main` and ADR 0001. v1.1 builds the swarm bridge the accepted ADR specifies: S1 (swarm surfaces, token-names-the-caller, the `correlation_id` to Graph ID binding, the swarm event tee, ultrathink's plan record) and S3 (swarm memory through the governance gate). Postgres stays the index, the ledger stays behind `substrate-mcp` only, every client fails open. The self-improving memory bank from PR #10's research is deferred pending your decision (see REQUIREMENTS.md).

## What this is

Four planes — runtime, memory, skills, ledger — bound by **MCP** for agent-to-substrate and
**ACP** for client-to-agent, so that every agent on this VPS shares one briefing, one event
log, one skills library and one task key.

Agents in scope: Claude Code, Codex, OpenCode, Pi (Lane A, rivet-agentos) · Hermes, Omp,
Muse Code, Grok Build (Lane B, Orca) · Cursor and Grok Bot (Lane C).

## The task key

`claude-ultrathink` already mints a **Graph ID** — `ut-<ts36>-<8hex>` — for every uplifted
prompt, and writes:

- one Notion **Task** row per prompt,
- one Linear **issue** per Graph-of-Thought node (`n1`…`n8`),
- one Linear **sub-issue** per Chain-of-Thought step.

The substrate adopts that key unchanged. Every event, memory entry, claim and session carries
`graph_id`; node-level work also carries `linear_identifier` (`SWC-123`) and `node_id`;
step-level work carries `step`.

Notion and Linear stay the **source of truth**. Postgres is only an index — a cache so the
brief does not call either API on every prompt.

## Components

| Package | Language | Role |
|---|---|---|
| `mcp-server` | TS | `substrate-mcp` on `127.0.0.1:7410` — brief, memory, events, graph, skills, docs, desktop. MCP streamable HTTP **plus** `POST /brief` and `POST /events` for hooks |
| `cli` | TS | `substrate brief \| emit \| run \| verify` |
| `host` | TS | rivet-agentos host; `openTask` keyed by Graph ID |
| `dispatcher` | Py | Linear `dispatch:<surface>` label → session |
| `collectors` | TS | Orca tee, grok tail, muse tail, git post-commit, agentos stream |
| `projector` | TS | `substrate.yaml` → per-agent config, hook appends, symlinks |
| `ledger` | TS | Greptime writer, hourly Merkle anchor, verify |
| `connector-ext` | Py | grok-hermes-connector v0.4 forwarding tools (lands in repo `mcp`) |
| `miner` | Py | Hermes cron job; staged-skill → PR watcher |

## Data

- **Postgres (index)** — `graph_index`, `graph_nodes`, `graph_steps`, memory entries. External.
- **GreptimeDB (events)** — append-only `agent_events` with a `hash`/`prev` chain. External,
  on a separate Railway account.
- **RAGFlow (docs)** — behind `docs.search`. External. Phase 5.
- **Langfuse** keeps LLM traces; Greptime holds the substrate's own log. No duplication.

## Departures from the Notion brief (§11), carried forward

- The Autonogrammer client is out of scope. Dispatch is a **Linear label**; the board is the
  Notion Command Center; ACP's client role is held by `substrate-dispatcher`.
- **No new planning layer.** The ultrathink family already does uplift, graph, tracking and
  idempotency by Graph ID. The substrate adds one fetch and three calls.
- **Orca before herdr.** Orca already runs and already hooks five agents.
- Grok Bot goes through the existing `grok-hermes-connector` (OAuth, redactor, audit log).
- The skills library is `/root/agent-skills`; the three existing miners are redirected, not
  replaced.
- `rivet-agentos` is named that way everywhere, to avoid the Agno `agentos-api` container on
  the same host.
- Solana **devnet**, not testnet. Roots only, never event contents.

## Corrections found on the VPS (2026-09-23)

- `claude-ultrathink` is **enabled**, not disabled — Notion §1 is stale on this point.
- `/root/agent-skills` is **not** a git checkout: 14 real dirs + 26 symlinks pointing into
  `/root/.openclaw/.../docs-scraper/exports/skills/` and `/root/.hermes/skills/`. Phase 4
  vendors the real content.
- RAGFlow and GreptimeDB are on a **Railway account this MCP connection cannot see**. Both are
  consumed as external endpoints via `/etc/substrate/substrate.env`.
- Ports 7410 and 6420 are free. Disk is at 90% (40 GB free) — gates Phase 3.

## Constraints

- **Hooks fail open.** A substrate outage must never block a prompt on any surface.
  `fetchBrief` returns `""` on any error, with a 1.5 s timeout.
- **Hooks cannot call MCP tools**, which is why `/brief` and `/events` are also plain HTTP.
- **Redact before emitting.** Reuse the connector's `redactor.py` patterns. No Linear, Notion,
  Railway or Greptime credentials in `agent_events`.
- **No KVM on this host** — cua runs the Docker path; the QEMU path is out.
- Secrets live in `/etc/substrate/substrate.env` (0600, root), never in the repo.
