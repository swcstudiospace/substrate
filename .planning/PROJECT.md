# Project: Agent Substrate

**Source of truth for architecture:** [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2) + [v0.3 SOTA Addendum](https://app.notion.com/p/3ebbc1a0c7ae81b88166e6d28a671e48) (locked 30 Sep 2026)
**Control plane:** Notion "Agent Task Graph" + Linear team Spectrum Web Co
**Repo:** `swcstudiospace/agent-substrate` (private)

## What this is

Four planes — runtime, memory, skills, ledger — bound by **MCP** for agent-to-substrate and
**ACP** for client-to-agent, so that every agent on this VPS shares one briefing, one event
log, one skills library and one task key. v0.3 SOTA adds governance (memory policy, leases, OTLP/SLOs), A2A Agent Cards for Teachable Moments (reverse skills: session observations/edge cases/learnings tracked on Solana devnet), Dragonfly snapshots, all Railway apps (hindsight, ragflow, dragonfly, timescale etc) on/through the substrate.

Agents in scope: Claude Code, Codex, OpenCode, Pi (Lane A, rivet-agentos) · Hermes, Omp,
Muse Code, Grok Build (Lane B, Orca + herdr) · Cursor and Grok Bot (Lane C). All apps integrate via connectors/proxies.

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
- **Dragonfly (cache/snapshots/outbox)** — Railway, for v0.3 circuit breakers and degraded mode.
- **Hindsight (api/control/llm-bridge/worker)** — Railway observability/evidence, integrated under governance.
- **Langfuse** keeps LLM traces; Greptime holds the substrate's own log. No duplication.
**Railway INFRA-R1 apps (from build plan):** greptimedb, timescale, dragonfly, tailscale-vpn, hindsight-api/control/llm-bridge, ragflow + oauth variants, es/redis/storage/mysql, hindsight-worker. All must use substrate (no direct raw access from seats).

## Departures from the Notion brief (§11), carried forward

- The Autonogrammer client is out of scope. Dispatch is a **Linear label**; the board is the
  Notion Command Center; ACP's client role is held by `substrate-dispatcher`.
- **No new planning layer.** The ultrathink family already does uplift, graph, tracking and
  idempotency by Graph ID. The substrate adds one fetch and three calls.
- **Orca before herdr.** Orca already runs and already hooks five agents.
- Grok Bot goes through the existing `grok-hermes-connector` (OAuth, redactor, audit log).
- The skills library is `/root/agent-skills`; the three existing miners are redirected, not
  replaced.
- A2A Agent Cards (v1.0 Linux Foundation) + Teachable Moments as skills[] (reverse, session-derived) anchored on Solana devnet.
- `rivet-agentos` is named that way everywhere, to avoid the Agno `agentos-api` container on
  the same host.
- Solana **devnet**, not testnet. Roots only, never event contents. Teachable anchors included.

## Corrections found on the VPS (2026-09-23)

- `claude-ultrathink` is **enabled**, not disabled — Notion §1 is stale on this point.
- `/root/agent-skills` is **not** a git checkout: 14 real dirs + 26 symlinks pointing into
  `/root/.openclaw/.../docs-scraper/exports/skills/` and `/root/.hermes/skills/`. Phase 4
  vendors the real content.
- RAGFlow and GreptimeDB are on a **Railway account this MCP connection cannot see**. Both are
  consumed as external endpoints via `/etc/substrate/substrate.env`.
- Ports 7410 and 6420 are free. Disk is at 90% (40 GB free) — gates Phase 3.
- v0.3 locked: full memory governance, leases/signed handoffs/drift, OTLP/SLOs/evidence, Grok Bot production loop.

## Constraints

- **Hooks fail open.** A substrate outage must never block a prompt on any surface.
  `fetchBrief` returns `""` on any error, with a 1.5 s timeout.
- **Hooks cannot call MCP tools**, which is why `/brief` and `/events` are also plain HTTP.
- **Redact before emitting.** Reuse the connector's `redactor.py` patterns. No Linear, Notion,
  Railway or Greptime credentials in `agent_events`.
- **No KVM on this host** — cua runs the Docker path; the QEMU path is out.
- **Enterprise production (v0.3 + user):** per-agent bearer, Dragonfly degraded, multi-tenant (tenant=swc), SLOs (brief p95<800ms, emit≥99.5%), circuit breakers, shared redaction CI, runbooks (red/quarantine/lease), no silos for apps.
- Secrets live in `/etc/substrate/substrate.env` (0600, root), never in the repo.
## Governance Plane (Phase 0.5 / v0.3 SOTA)

See `docs/governance.md` for the full plane (policy YAML example, RBAC, quarantine, Dragonfly snapshots/outbox, leases foundations, cross-app wiring plan, C4 diagram).

ADRs (docs/adr/):
- ADR-0001 Adopt memory governance policy gate with default-deny RBAC and quarantine
- ADR-0002 Integrate DragonflyDB on Railway for brief snapshots, write outbox and circuit breakers
- ADR-0003 Lease model and signed handoff foundations for graph coordination
- ADR-0004 All Railway apps wire through substrate governance (no silos)
- ADR-0005 Produce governance.md and infra/railway configs (additive)

All changes are additive. No breaking changes to v0.2 brief, events, graph, or MCP tool surfaces. Policy gate sits in front of memory_write only. Dragonfly and leases are new optional paths for degraded/coord.

## Constraints (governance additions)
- Policy enforced at substrate-mcp (single writer).
- All Railway apps (hindsight, dragonfly, ragflow, backing) must use substrate paths (bearer or MCP).
- Tenant=swc on all rows.
