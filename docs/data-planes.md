# Data planes — three databases, two applications

**Revised:** 2026-09-30. Supersedes the "Data" section of `.planning/PROJECT.md` and the Phase 5 / 7 / 8 goals in `.planning/ROADMAP.md` where they disagree; those phases are re-planned against this document, not silently edited.  
**Owner decisions carried forward:** 2026-09-26 (Dragonfly is a cache, not a queue), 2026-09-30 (Hindsight replaces Agentmemory; Railway services are reached over Tailscale; the Programming Desk consumes the planes through a gateway on the VPS).

Notion and Linear stay the source of truth for intent. GitHub is the source of truth for the change. Every store below is derived, rebuildable or cache — none of them is where a claim of "done" comes from.

## The five services and where they live

| Railway project | Service | Plane | Placeholder reach |
|---|---|---|---|
| **Ultrathink** | GreptimeDB | ledger / events | `http://<ultrathink-forwarder>:4000` (HTTP SQL) |
| **Ultrathink** | TimescaleDB | index / coordination | `postgresql://…@<ultrathink-forwarder>:5432/<db>` |
| **Ultrathink** | DragonflyDB | hot cache | `redis://…@<ultrathink-forwarder>:6379` |
| **Agent Substrate** | Hindsight | memory / recall | `http://<agent-substrate-forwarder>:8888` |
| **Agent Substrate** | RAGFlow | documents | `http://<agent-substrate-forwarder>:9380` |

The reach column is a placeholder, not a machine name. `docs/railway-tailscale.md` is the cutover note. No service keeps a public TCP proxy or public database domain after the cutover.

## What goes where

| Data class | Store | Writer | Retention | Never |
|---|---|---|---|---|
| **Events**: `agent_events` — every brief, emit, claim, tool call from the Programming Desk gateway, receipt written, dispatch, intake, heartbeat. Append-only with the `hash`/`prev` chain; `packages/ledger` anchors the hourly Merkle root to Solana devnet | GreptimeDB | `substrate-mcp` (`events_emit`, `POST /events`), collectors, desk gateway | 180 days hot, then export | Credentials (redactor first, always), transcripts, file contents |
| **Index**: `graph_index`, `graph_nodes`, `graph_steps`, memory entries index; desk tables `desk_intake` (queue; drained with `FOR UPDATE SKIP LOCKED`), `desk_claims` (Graph-ID claim rows with expiry and heartbeat), `desk_idempotency` (30-day processed keys), `desk_receipts`, `seat_roster`, `tool_pack_state`; hypertables `seat_heartbeat`, `tool_calls_1m` with continuous aggregates | TimescaleDB | `substrate-mcp`, desk gateway, `substrate-dispatcher` | Open Graph IDs + 90 days; aggregates 1 year | Treating a row as proof that work shipped; secrets |
| **Cache**: the brief, memory search and a graph view. Rate counters and an idempotency mirror stay a target, not a current key | DragonflyDB | `substrate-mcp` | Brief 300 s; memory search 600 s; graph view 60 s | Queues, locks, sessions, pub/sub, anything that must survive a restart. A Dragonfly outage returns the same answers, uncached |
| **Memory**: decisions with receipt paths, environment facts, verified commands, gotchas, working preferences | Postgres index inside Timescale, and Hindsight for the desk | `substrate-mcp` writes the index (`memory_write` / `memory_search`). The desk gateway writes and reads Hindsight with its own keys when those are set | Index rows follow the governance gate; Hindsight banks are retained until replaced | Unverified claims, secrets (D-04 redaction), another surface's or seat's bank |
| **Documents**: repo docs, skills, contracts, ADRs; product docs | RAGFlow | The desk gateway, with its own keys. `substrate-mcp` does not call RAGFlow | Re-ingest on merge is the target; it is not implemented here | Secrets, receipts, transcripts |

## Hindsight banks

| Bank | Who writes | Who reads | Holds |
|---|---|---|---|
| `sub-<surface>` (`sub-claude-code`, `sub-hermes`, `sub-omp`, `sub-muse`, `sub-grok-build`, `sub-cursor`) | that surface, through the substrate | that surface; `brief` for any surface reads cross-bank with `agentId: "*"` | Session summaries keyed by Graph ID |
| `pd-desk` | Programming Desk LEAD and QUALITY | every desk seat | Shared environment facts, desk decisions, gate outcomes |
| `pd-<seat>` (`pd-lead`, `pd-systems`, `pd-web`, `pd-android`, `pd-ios`, `pd-infra`, `pd-quality`) | that seat | that seat, LEAD | Seat working memory |
| `pd-lead-reports` | LEAD | LEAD, Ove | Consolidated reports to the operator |

Rules: the desk gateway holds the Hindsight key and calls Hindsight directly when that key is set. `substrate-mcp` does not read `HINDSIGHT_*`. Its `memory_write` and `memory_search` are the Postgres index. The gateway still calls substrate `memory_search` when its Hindsight client is unset, and it calls substrate `memory_write` alongside a Hindsight retain. Hindsight's own Postgres is its private store and is not read by anything else.

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
        │ MCP / hooks (loopback)                                     │ HTTPS
        ▼                                                            ▼
  substrate-mcp 127.0.0.1:7410  ◀── loopback ───  desk gateway
        │ private forwarders                                         │ its own Hindsight and RAGFlow keys
        ▼                                                            ▼
  <ultrathink-forwarder> ── Greptime · Timescale · Dragonfly     Hindsight · RAGFlow
```

Only the VPS and the operator's admin machines hold access to the forwarders (`docs/railway-tailscale.md`). Agents never receive database credentials. Grok Bots never receive the Hindsight or RAGFlow keys.

## Current wiring

What `substrate-mcp` reads today. Hindsight and RAGFlow are the desk gateway's clients.

| Store | Reader | Env var | Status |
|---|---|---|---|
| GreptimeDB | `substrate-mcp` | `GREPTIME_URL`, `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB` | read |
| TimescaleDB | `substrate-mcp` | `SUBSTRATE_PG_URL` | read |
| DragonflyDB | `substrate-mcp` read-through cache | `DRAGONFLY_URL`; `SUBSTRATE_CACHE=0` disables | read when set; fail-open when unset, refused or `0` |
| Hindsight | desk gateway | gateway `HINDSIGHT_URL`, `HINDSIGHT_API_KEY` | not read by `substrate-mcp` (`HINDSIGHT_*` in `.env.example` is unused here) |
| RAGFlow | desk gateway | gateway `RAGFLOW_URL`, `RAGFLOW_API_KEY` | not read by `substrate-mcp` (`RAGFLOW_*` in `.env.example` is unused here) |

The cache covers `POST /brief`, `memory_brief`, `memory_search` and `graph_get`. It does not cover writes, `events_*` or leases. Keys are `substrate:v1` plus a hash of the normalized arguments, the caller surface and a generation. An accepted memory write, and a write whose commit is uncertain, bumps the memory generation. A graph write bumps that graph's generation and a shared graphs generation, so a brief that lists other graphs refreshes too. A stored answer expires at its class TTL or at the next lease or reverify deadline, whichever is sooner. `GET /healthz` adds `{enabled, connected, mode, hits, misses, bypasses, errors}` with `mode` of `off`, `on` or `degraded`. The status code does not depend on the cache. The same counters are the `substrate.cache.operations` metric.

## Target after the private-forwarder cutover

| Store | Reader | Env var | Reach |
|---|---|---|---|
| GreptimeDB | `substrate-mcp` | `GREPTIME_URL` | `http://<ultrathink-forwarder>:4000` |
| TimescaleDB | `substrate-mcp` | `SUBSTRATE_PG_URL` | `postgresql://…@<ultrathink-forwarder>:5432/<db>` |
| DragonflyDB | `substrate-mcp` | `DRAGONFLY_URL` | `redis://…@<ultrathink-forwarder>:6379` |
| Hindsight | desk gateway | gateway `HINDSIGHT_URL` | `http://<agent-substrate-forwarder>:8888` |
| RAGFlow | desk gateway | gateway `RAGFLOW_URL` | `http://<agent-substrate-forwarder>:9380` |

## Environment keys

See `.env.example`. `substrate-mcp` reads `GREPTIME_*`, `SUBSTRATE_PG_URL`, `DRAGONFLY_URL` and `SUBSTRATE_CACHE`. `HINDSIGHT_*` and `RAGFLOW_*` in that file are unused by this process; the gateway holds its own. `AGENTMEMORY_URL` and `AGENTMEMORY_SECRET` are removed.

## Fail-open budget (unchanged)

A substrate outage never blocks a prompt. `fetchBrief` returns `""` within 1.5 s. Every cache miss and every Dragonfly, Hindsight or RAGFlow error falls through to the next source or to an empty result with a logged reason. Writes to Greptime and Timescale are the only calls allowed to fail closed, and only for the caller that asked for durability.
