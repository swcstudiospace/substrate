# Data planes — three databases, two applications

**Revised:** 2026-09-30. Supersedes the "Data" section of `.planning/PROJECT.md` and the Phase 5 / 7 / 8 goals in `.planning/ROADMAP.md` where they disagree; those phases are re-planned against this document, not silently edited.  
**Owner decisions carried forward:** 2026-09-26 (Dragonfly is a cache, not a queue), 2026-09-30 (Hindsight replaces Agentmemory; Railway services are reached over Tailscale; the Programming Desk consumes the planes through a gateway on the VPS).

Notion and Linear stay the source of truth for intent. GitHub is the source of truth for the change. Every store below is derived, rebuildable or cache — none of them is where a claim of "done" comes from.

## The five services and where they live

| Railway project | Service | Plane | Reached from the VPS as |
|---|---|---|---|
| **Ultrathink** | GreptimeDB | ledger / events | `http://ultrathink-production-tailscale-forwarder:4000` (HTTP SQL) |
| **Ultrathink** | TimescaleDB | index / coordination | `postgresql://…@ultrathink-production-tailscale-forwarder:5432/railway` |
| **Ultrathink** | DragonflyDB | hot cache | `redis://…@ultrathink-production-tailscale-forwarder:6379` |
| **Agent Substrate** | Hindsight (`hindsight-api`, `hindsight-ui`, own pg17+pgvector) | memory / recall | `http://agent-substrate-production-tailscale-forwarder:8888` (REST + MCP at `/mcp/<bank>/`) |
| **Agent Substrate** | RAGFlow | documents | `http://agent-substrate-production-tailscale-forwarder:9380` (API) |

Names are the Tailscale Forwarder machine names Railway derives (`<project>-<environment>-<service>`); the exact Railway service names and ports are confirmed in `docs/railway-tailscale.md` when the forwarders are deployed. No service keeps a public TCP proxy or public database domain after the cutover.

## What goes where

| Data class | Store | Writer | Retention | Never |
|---|---|---|---|---|
| **Events**: `agent_events` — every brief, emit, claim, tool call from the Programming Desk gateway, receipt written, dispatch, intake, heartbeat. Append-only with the `hash`/`prev` chain; `packages/ledger` anchors the hourly Merkle root to Solana devnet | GreptimeDB | `substrate-mcp` (`events_emit`, `POST /events`), collectors, desk gateway | 180 days hot, then export | Credentials (redactor first, always), transcripts, file contents |
| **Index**: `graph_index`, `graph_nodes`, `graph_steps`, memory entries index; desk tables `desk_intake` (queue; drained with `FOR UPDATE SKIP LOCKED`), `desk_claims` (Graph-ID claim rows with expiry and heartbeat), `desk_idempotency` (30-day processed keys), `desk_receipts`, `seat_roster`, `tool_pack_state`; hypertables `seat_heartbeat`, `tool_calls_1m` with continuous aggregates | TimescaleDB | `substrate-mcp`, desk gateway, `substrate-dispatcher` | Open Graph IDs + 90 days; aggregates 1 year | Treating a row as proof that work shipped; secrets |
| **Cache**: the brief, `docs_search` and `recall` results, per-surface and per-seat rate counters, a 24-hour mirror of idempotency keys for fast rejects | DragonflyDB | `substrate-mcp`, desk gateway | Brief 5 min; search and recall 10 min; counters 1 h; mirror 24 h | Queues, locks, sessions, pub/sub, anything that must survive a restart. A Dragonfly outage returns the same answers, uncached (`GET /healthz` reports hit/miss/bypass) |
| **Memory**: decisions with receipt paths, environment facts, verified commands, gotchas, working preferences; weekly `reflect` into mental models | Hindsight | `substrate-mcp` only (`memory_write` → `retain`, `memory_search` → `recall`); the desk gateway calls the substrate, not Hindsight directly | Retain indefinitely; mental models replace stale detail | Unverified claims (a retain needs a `receipt_path` or a `source` URL), secrets (D-04 redaction), another surface's or seat's bank |
| **Documents**: repo docs, skills, contracts, ADRs; product docs for KanbanOS, Desk Lanes, ClippyOS, Auctioning | RAGFlow | `substrate docs ingest` on merge to `main` (GitHub Action → `POST /docs/ingest`) | Re-ingest on merge; keep the last five dataset versions | Secrets, receipts, transcripts |

## Hindsight banks

| Bank | Who writes | Who reads | Holds |
|---|---|---|---|
| `sub-<surface>` (`sub-claude-code`, `sub-hermes`, `sub-omp`, `sub-muse`, `sub-grok-build`, `sub-cursor`) | that surface, through the substrate | that surface; `brief` for any surface reads cross-bank with `agentId: "*"` | Session summaries keyed by Graph ID |
| `pd-desk` | Programming Desk LEAD and QUALITY | every desk seat | Shared environment facts, desk decisions, gate outcomes |
| `pd-<seat>` (`pd-lead`, `pd-systems`, `pd-web`, `pd-android`, `pd-ios`, `pd-infra`, `pd-quality`) | that seat | that seat, LEAD | Seat working memory |
| `pd-lead-reports` | LEAD | LEAD, Ove | Consolidated reports to the operator |

Rules: one tenant key, held by the substrate in `/etc/substrate/substrate.env`; the gateway on the VPS calls `memory_write` / `memory_search` over loopback. `reflect` runs weekly per bank from a systemd timer. Hindsight's own Postgres is its private store and is not read by anything else. The local Claude Code `hindsight` stdio server (`/root/.hindsight/coding-agents`) and Hermes `memory.provider: supermemory` are retired once `sub-*` banks answer the brief (backup and restore route recorded first, as Phase 7 D-09 / D-10 already require).

## RAGFlow datasets

| Dataset | Source | Ingest trigger |
|---|---|---|
| `programming-desk` | `docs/`, `skills/`, `contracts/`, `ARCHITECTURE.md`, `prompts-assembled/` of `swcstudiospace/programming-desk` | merge to `main` |
| `agent-substrate` | `README.md`, `docs/`, `.planning/PROJECT.md` of this repo | merge to `main` |
| `agent-skills` | every `SKILL.md` and `references/` in `swcstudiospace/agent-skills` | `substrate-skills-sync` after a fast-forward |
| `<product>` (`kanbanos`, `desklanes`, `clippyos`, `auctioning`) | that repo's docs | merge to `main` |

Embedding: TEI `bge-small` as already decided at 05-02; no chat model is registered; retrieval only. `docs_search` returns chunk, heading path, source URL and commit; callers cite the source, not the chunk.

## Access path

```
Claude Code · Hermes · Omp · Muse · Grok Build · Cursor      Programming Desk seats (Grok Bots)
        │ MCP / hooks (loopback)                                     │ HTTPS + OAuth
        ▼                                                            ▼
  substrate-mcp 127.0.0.1:7410  ◀── loopback ───  desk-gateway 127.0.0.1:8791 (desk.swcstudio.space)
        │ tailnet (MagicDNS)
        ▼
  Ultrathink forwarder ── Greptime · Timescale · Dragonfly
  Agent Substrate forwarder ── Hindsight · RAGFlow
```

Only the VPS and the operator's admin machines hold tailnet access to the forwarders (`docs/railway-tailscale.md`). Agents never receive database credentials; Grok Bots never receive the Hindsight or RAGFlow keys.

## Environment keys

See `.env.example`. Renamed or added: `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX`, `DRAGONFLY_URL`; `AGENTMEMORY_URL` and `AGENTMEMORY_SECRET` are removed; `GREPTIME_URL`, `SUBSTRATE_PG_URL` and `RAGFLOW_URL` point at forwarder names.

## Fail-open budget (unchanged)

A substrate outage never blocks a prompt. `fetchBrief` returns `""` within 1.5 s. Every cache miss and every Dragonfly, Hindsight or RAGFlow error falls through to the next source or to an empty result with a logged reason. Writes to Greptime and Timescale are the only calls allowed to fail closed, and only for the caller that asked for durability.
