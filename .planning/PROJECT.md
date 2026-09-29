# Project: Agent Substrate

**Source of truth for architecture:** [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2)
**Control plane:** Notion "Agent Task Graph" + Linear team Spectrum Web Co
**Repo:** `swcstudiospace/agent-substrate` (private)

## Current Milestone: v1.2 Swarm leases, workspace install and lessons bank

**Goal:** Swarm agents work nodes under substrate leases with signed handoffs, every swarm workspace is wired to `substrate-mcp` with one token per agent process, and lessons from finished phases become governed, citable memory.

**Target features:**
- ADR 0001 S2 (SPE-5053): lease authority on the server (swarm session shape, holder-only `lease_id` and fenced calls, no swarm operator), then the swarm runner claiming, heartbeating and completing each task's node, with signed `coord_handoff` packets at accountable-agent boundaries.
- ADR 0001 S4 (SPE-5055): the projector writes the `substrate-mcp` entry into every swarm workspace runtime, each agent gets its own 0600 token file, and the runner gives each child only its own `SUBSTRATE_TOKEN`.
- Lessons bank Tier 1 (SPE-5830): lessons as governed `fact` entries through `memory_write`, with a `substrate lessons` CLI to add, recall (with citation ids) and digest them.

Shipped before: **v1.1 Swarm correlation, governed memory and orchestrate integrations** (2026-10-07; 5 phases: 7, 8, 8.1 inserted, 9, 10; 18/18 requirements).

## Current State

Shipped **v1.1** (2026-10-07): ADR 0001 slices S1 (SPE-5052) and S3 (SPE-5054), re-grounded on `origin/main` and ADR 0001. Postgres stays the index, the ledger stays behind `substrate-mcp` only, every client fails open.

- **Swarm identity and binding:** 15 swarm surfaces `swarm-a01-orch`..`swarm-a15-doc` with per-surface tokens; a swarm token cannot emit or claim as another surface (refusal, never re-attribution); MCP-only `graph_bind` binds correlation id to Graph ID race-safely (one winner). agent-substrate #11.
- **Swarm orchestrate tee:** the swarm run log is teed under one Graph ID per run, attributed per agent, 13 swarm types mapped to existing `EVENT_KINDS`, deduped, fail-open; `orch_plan` mints/binds/registers the Graph ID. agent-swarm #5.
- **Governed swarm memory:** `swarm/memory.py` writes through the governance gate with no grant change; versioned conflicts carry `current_version` so the client re-submits without searching (Phase 8.1). agent-substrate #12, #13; agent-swarm #6, #7, #8.
- **ultrathink plan record:** one fail-open `note` event carrying the Graph ID (no prompt text) after planning. claude-ultrathink #19.
- **Proof:** live end-to-end on real Postgres + GreptimeDB against the three merged mains: 24/24 integration, 7/7 governed swarm memory, and the 8.1 regression (2 POSTs, 0 searches).

## Next Milestone Goals

Candidates only, not commitments:

- ADR S5 gate verdicts as events (SPE-5056).
- Lessons bank Tier 2: phase lifecycle events, realtime delivery, an outbox and automatic injection at the GSD discuss step.
- Carried: v1.0 Phase 0 UAT (8 scenarios pending, acknowledged as deferred at the v1.1 close).

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

Revised 2026-09-30 — policy in `docs/data-planes.md`, network in `docs/railway-tailscale.md`.

- **Railway project "Ultrathink"** — **TimescaleDB (index and coordination)**: `graph_index`,
  `graph_nodes`, `graph_steps`, memory index, and the Programming Desk tables (`desk_intake`
  queue, `desk_claims`, `desk_idempotency`, `desk_receipts`, `seat_roster`, `tool_pack_state`,
  hypertables). **GreptimeDB (events)**: append-only `agent_events` with a `hash`/`prev` chain.
  **DragonflyDB (cache only)**: brief, search and recall caches, rate counters; falls through on
  outage (owner decision 2026-09-26 stands).
- **Railway project "Agent Substrate"** — **Hindsight (memory)**: banks `sub-<surface>` and
  `pd-<seat>`; replaces Agentmemory (Phase 7) and the local Claude Code `hindsight` stdio server.
  **RAGFlow (docs)**: behind `docs_search`; datasets per repo (Phase 5 docs half re-opened).
- All five are reached from the VPS over a Tailscale Forwarder deployed inside each project; no
  public TCP proxy or public database domain after cutover.
- **Langfuse** keeps LLM traces; Greptime holds the substrate's own log. No duplication.
- The Programming Desk consumes these planes through its own gateway on the VPS
  (`desk.swcstudio.space`, loopback `:8791`), which calls `substrate-mcp` over loopback with
  `SUBSTRATE_TOKEN_DESK_GATEWAY`; Grok Bots never hold plane credentials.

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

## Validated

- ✓ Swarm identity: 15 per-surface swarm tokens; cross-surface emit/claim refused (REST 403 / MCP `isError`), other surfaces unchanged — v1.1
- ✓ Binding: `graph_bind` (MCP-only) binds correlation id ↔ Graph ID, race-safe with one winner; binding notes in their own session keep `events_verify` green — v1.1
- ✓ Tee: swarm run log teed per agent, 13 swarm types mapped to existing `EVENT_KINDS`, deduped, fail-open; hardened transport (no redirects, deadline, proxies, dry runs never tee) — v1.1
- ✓ Graph ID: `orch_plan` mints, binds and registers one Graph ID per run — v1.1
- ✓ Memory: swarm memory through the governance gate (kind/scope maps, idempotency key, every gate outcome handled, ok only when accepted and verified_persisted); versioned conflicts carry `current_version` — v1.1
- ✓ ultrathink: one fail-open `note` event with the Graph ID after planning, session `<host session>:<graph id>` — v1.1
- ✓ Proof: live end-to-end 24/24 and 7/7 on real Postgres + GreptimeDB, plus the 8.1 regression — v1.1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| A swarm token emitting or claiming as another swarm surface is refused, never re-attributed | Token names the caller; silent re-attribution would corrupt attribution | ✓ Good |
| `graph_bind` is MCP-only; no new event kinds, no `POST /graph` door | ADR 0001 forbids a single agent-swarm surface, new event kinds and a `POST /graph` door | ✓ Good |
| Versioned conflicts report `current_version` instead of adding a subject search filter | `memory_search` matches bodies only and returns the newest 100 per scope; the re-read stays only as the older-server fallback | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-07 at the start of milestone v1.2*
