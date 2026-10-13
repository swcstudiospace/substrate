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
| **Events**: `agent_events` — every brief, emit, claim, tool call from the Programming Desk gateway, receipt written, dispatch, intake, heartbeat. Append-only with the `hash`/`prev` chain; `packages/ledger` anchors the hourly Merkle root to Solana devnet | GreptimeDB | `substrate-mcp` (`events_emit`, `POST /events`), collectors, desk gateway | 180 days hot, then export — applied by `SUBSTRATE_LEDGER_TTL=180d` after the export step in `docs/greptime-ledger.md` § Retention; unset alters nothing | Credentials (redactor first, always), transcripts, file contents |
| **Index**: plain Postgres tables, no hypertables, continuous aggregates or Timescale policies (0 hypertables measured 2026-10-13). Graph tables `graph_index`, `graph_nodes` (leases live here: `claimed_by`, `lease_id`, `lease_expires_at`, `lease_epoch`), `graph_edges`, `graph_steps`, `graph_bindings`; governance tables `memory_entries`, `memory_writes` (idempotency ledger), `memory_reviews`, `memory_quarantine`. The desk's own tables (intake, claims, receipts, roster) are not in this repo | TimescaleDB | `substrate-mcp` only (`graph_register`, claims, `memory_write`, the governance gate); migrated on boot by `index-store.ts` | Applied by `substrate index sweep` / `substrate-index-sweep.timer` (`index-sweep.ts`; dry-run unless `SUBSTRATE_INDEX_SWEEP=apply`): terminal graphs + 90 days with their nodes/edges/steps/bindings — never while any node holds a live lease (claims do not refuse a finished graph), re-checked per node inside the delete; superseded memory versions 90 days; spent derived idempotency keys 7 days, explicit keys 30 days (exactly-once holds that long); decided reviews 30 days; quarantine rows whose content later landed 30 days. Counted but never deleted: pending reviews, unresolved quarantine, `ttl=30d`/`ttl=graph` entries (the reads do not filter on `ttl` yet). Pool: `SUBSTRATE_PG_POOL_MAX` 8, `statement_timeout` 5 s, `application_name=substrate-mcp` | Treating a row as proof that work shipped; secrets |
| **Cache**: the brief, memory search, a graph view, and the last complete brief per surface and arguments (`brief-snapshot`, served with a dated banner only while a live source is down). Rate counters are the admission buckets (uplift-3 N3): key class `budget:<surface>:<class>`, one hash per authenticated surface and class (`read`, `write`, `coordination`; untokened bridge callers share `anonymous`), stepped by one Lua `EVAL`, always with a TTL. An idempotency mirror stays a target, not a current key | DragonflyDB | `substrate-mcp` | Brief 300 s; memory search 600 s; graph view 60 s; brief snapshot `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (3600 s, `0` = off); budget bucket: the burst's refill time, never under 1 s | Queues, locks, sessions, pub/sub, anything that must survive a restart. A Dragonfly outage returns the same answers, uncached, and admits every caller (`bypass`) |
| **Memory**: decisions with receipt paths, environment facts, verified commands, gotchas, working preferences | Postgres index inside Timescale, and Hindsight for the desk | `substrate-mcp` writes the index (`memory_write` / `memory_search`). The desk gateway writes and reads Hindsight with its own keys when those are set | Index rows follow the governance gate; Hindsight banks are retained until replaced | Unverified claims, secrets (D-04 redaction), another surface's or seat's bank |
| **Documents**: repo docs, skills, contracts, ADRs; product docs | RAGFlow | `substrate-mcp` (`docs_ingest`, `POST /docs/ingest`, `POST /docs/merge-trigger`); the desk gateway with its own keys for its own paths | Re-ingest on merge via the asynchronous merge trigger (202, one background job per dataset); the last five versions per dataset are a bookkeeping list in the docs state file (pins for citations, trigger idempotency), not a plane-side policy; a superseded document is deleted only with `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1` (default off) | Secrets, receipts, transcripts |

## Hindsight banks

| Bank | Who writes | Who reads | Holds |
|---|---|---|---|
| `sub-<surface>` (`sub-claude-code`, `sub-hermes`, `sub-omp`, `sub-muse`, `sub-grok-build`, `sub-cursor`) | that surface, through the substrate | that surface; any surface's `memory_recall` / `memory_search` fans out over the configured `sub-*` banks with per-bank queries | Session summaries keyed by Graph ID |
| `pd-desk` | Programming Desk LEAD and QUALITY | every desk seat | Shared environment facts, desk decisions, gate outcomes |
| `pd-<seat>` (`pd-lead`, `pd-systems`, `pd-web`, `pd-android`, `pd-ios`, `pd-infra`, `pd-quality`) | that seat | that seat, LEAD | Seat working memory |
| `pd-lead-reports` | LEAD | LEAD, Ove | Consolidated reports to the operator |

Rules: the desk gateway holds the Hindsight key and calls Hindsight directly when that key is set. `substrate-mcp` reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` in `planes/hindsight.ts` since Phase 26 (the gateway keeps its own keys for its own paths). Its `memory_write` accepts into the Postgres index and forwards gate-accepted memories to the writer's bank; `memory_search` merges the index with derived-marked plane hits. The gateway still calls substrate `memory_search` when its Hindsight client is unset, and it calls substrate `memory_write` alongside a Hindsight retain. Hindsight's own Postgres is its private store and is not read by anything else.

## RAGFlow datasets

| Dataset | Source | Ingest trigger |
|---|---|---|
| `programming-desk` | `docs/`, `skills/`, `contracts/`, `ARCHITECTURE.md`, `prompts-assembled/` of `swcstudiospace/programming-desk` | merge to `main` |
| `agent-substrate` | `README.md`, `docs/`, `.planning/PROJECT.md` of this repo | merge to `main` → `POST /docs/merge-trigger` (202; the ingest runs in the background, `?wait=1` for the synchronous answer) |
| `agent-skills` | every `SKILL.md` and `references/` in `swcstudiospace/agent-skills` | `substrate-skills-sync` after a fast-forward (degrades with pin-aged serve until the first trigger reaches the server) |
| `<product>` (`kanbanos`, `desklanes`, `clippyos`, `auctioning`) | that repo's docs | merge to `main` (refresh via `docs_ingest`) |

"Last five versions kept" is the per-dataset version list `{dataset, version, commit, content_sha256, ingested_at}` the refresh records — a bookkeeping bound in the docs state file (`SUBSTRATE_DOCS_STATE_FILE`, survives restarts), which gives citations their commit pin and the merge trigger its idempotency key. It deletes nothing on the plane: a changed page uploads a new document and reports the superseded id; only the opt-in prune (`SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1`) deletes the superseded document after the replacement parsed. Embedding: TEI `bge-small` as already decided at 05-02; no chat model is registered; retrieval only. The dataset list is held 60 s in process and `docs_search` answers 300 s in the cache under `gen:docs`, bumped by every ingest and refresh. `docs_search` returns chunk, heading path, source URL and commit; callers cite the source, not the chunk. See `docs/docs-search-ingest.md` for the documented RAGFlow API shapes the client speaks (live-unattested).

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

What `substrate-mcp` reads today. Hindsight is read by `substrate-mcp` `planes/hindsight.ts` since Phase 26 (the desk gateway keeps its own keys for its own paths); RAGFlow is read by `substrate-mcp` since Phase 25 (the gateway keeps its own keys for its own paths).

| Store | Reader | Env var | Status |
|---|---|---|---|
| GreptimeDB | `substrate-mcp` | `GREPTIME_URL`, `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB` | read |
| TimescaleDB | `substrate-mcp` | `SUBSTRATE_PG_URL` | read |
| DragonflyDB | `substrate-mcp` read-through cache | `DRAGONFLY_URL`; `SUBSTRATE_CACHE=0` disables; `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` / `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS` (250 ms each) bound every connect and command | read when set; fail-open when unset, refused or `0`. Production points at co-located loopback redis after a measured 180–310 ms tailnet RTT made the Railway hop unusable (Greptile P1 disposition recorded); the 250 ms budgets are sized for that loopback hop |
| Hindsight | `substrate-mcp` `planes/hindsight.ts` (gateway keeps its own keys for its own paths) | server env `HINDSIGHT_URL`, `HINDSIGHT_API_KEY` | read by `substrate-mcp` since Phase 26; the desk's `pd-*` banks are never named here |
| RAGFlow | `substrate-mcp` `planes/ragflow.ts` (gateway keeps its own keys for its own paths) | server env `RAGFLOW_URL`, `RAGFLOW_API_KEY` | read by `substrate-mcp` since Phase 25; `RAGFLOW_MCP_URL` is never read |

The cache covers `POST /brief`, `memory_brief`, `memory_search`, `memory_recall` and `graph_get`. It does not cover writes, `events_*` or leases. Keys are `substrate:v1` plus a hash of the normalized arguments, the caller surface and a generation; the generation keys are read in one `MGET` before the entry is read. An accepted memory write, and a write whose commit is uncertain, bumps the memory generation. A graph write — a claim, release, completion or registration — bumps that graph's generation and a shared graphs generation, so a brief that lists other graphs refreshes too. A heartbeat bumps only the graph's own generation: a renewed lease changes no text a repo brief shows before its refresh deadline, and bumping the shared key on every heartbeat is what held the hit ratio at 1 %. A stored answer expires at its class TTL or at the next lease or reverify deadline, whichever is sooner. A brief composed while any source failed or missed its budget is never stored. The `brief-snapshot` class is the exception to the generation rule: keyed by surface and arguments only, written when a brief is composed complete, read only when the live compose came back degraded, and served with a first line `_(substrate brief snapshot from <time>; live sources degraded: <sources>)_` — see `docs/observability.md` for the headers that mark it. `GET /healthz` adds `{enabled, connected, mode, hits, misses, bypasses, errors, cooldownUntil}` with `mode` of `off`, `on` or `degraded`. The status code does not depend on the cache. The same counters are the `substrate.cache.operations` metric.

Admission budgets (uplift-3 N3) are the one key class that is not a cached answer. `substrate:v1:budget:<surface>:<class>` is a hash `{t, at}` — the tokens left and the epoch ms of the last step — written by one `EVAL` (`BUDGET_SCRIPT` in `packages/mcp-server/src/admission.ts`) that refills at the class rate, checks, debits and `PEXPIRE`s the key to the burst's refill time (≥ 1 s), so an idle surface costs no key and a counter never outlives the state it carries. The identity is the bearer's surface, never a body-claimed one; accepted untokened bridge callers share `anonymous`. The call goes through the cache's plane gate like every other command (`op=eval`), so a timeout, an open breaker or the connect cooldown admits the caller and counts a `bypass` rather than refusing: the budgets bound load on the planes and must not make the cache a way to fail them. `SUBSTRATE_BUDGETS=off|shadow|enforce` (default `shadow`: decide and count, never refuse) and `SUBSTRATE_BUDGET_<CLASS>_RPS` / `_BURST` with per-surface `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_*` overrides are in `.env.example`; `docs/observability.md` has the metric and the `/slo` row, `docs/grok-bot.md` what a refused caller sees.

## Target after the private-forwarder cutover

| Store | Reader | Env var | Reach |
|---|---|---|---|
| GreptimeDB | `substrate-mcp` | `GREPTIME_URL` | `http://<ultrathink-forwarder>:4000` |
| TimescaleDB | `substrate-mcp` | `SUBSTRATE_PG_URL` | `postgresql://…@<ultrathink-forwarder>:5432/<db>` |
| DragonflyDB | `substrate-mcp` | `DRAGONFLY_URL` | `redis://…@<ultrathink-forwarder>:6379` |
| Hindsight | desk gateway | gateway `HINDSIGHT_URL` | `http://<agent-substrate-forwarder>:8888` |
| RAGFlow | desk gateway | gateway `RAGFLOW_URL` | `http://<agent-substrate-forwarder>:9380` |

## Environment keys

See `.env.example`. `substrate-mcp` reads `GREPTIME_*`, `SUBSTRATE_PG_URL`, `DRAGONFLY_URL`, `SUBSTRATE_CACHE`, `HINDSIGHT_URL`/`HINDSIGHT_API_KEY` and `RAGFLOW_URL`/`RAGFLOW_API_KEY`. The desk gateway holds its own plane keys for its own paths. `AGENTMEMORY_URL` and `AGENTMEMORY_SECRET` are removed.

## Fail-open budget (unchanged)

A substrate outage never blocks a prompt. `fetchBrief` returns `""` within 1.5 s. Every cache miss and every Dragonfly, Hindsight or RAGFlow error falls through to the next source or to an empty result with a logged reason. Writes to Greptime and Timescale are the only calls allowed to fail closed, and only for the caller that asked for durability.
