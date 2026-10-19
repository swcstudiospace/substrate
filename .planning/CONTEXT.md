# Context: 7 SOTA Enhancements for Agent Substrate

**Date:** 2026-10-19
**Scope:** Review of Agent Substrate and its integrations with Railway resources, RAGflow, Hindsight, TailscaleDB, GreptimeDB, DragonflyDB. Identify gaps for additional utility. Code implementation of the 7 enhancements is complete in this PR; enhancements are described in docs.

## Review Findings (from repository evidence)

### Current Architecture and Resource Mappings
From docs/data-planes.md:
- 5 services on 2 Railway projects, reached over Tailscale private forwarders (no public proxies after cutover).
- Ultrathink project: GreptimeDB (ledger/events - append-only with hash chain, anchors on Solana), TimescaleDB (index/coordination for graphs, memory governance, leases), DragonflyDB (cache - idle on Railway; production uses VPS loopback redis).
- Agent Substrate project: Hindsight (memory/recall - sub-<surface> banks for agents, pd-* for desk), RAGFlow (documents - search/ingest with citations, redaction, datasets for programming-desk, agent-substrate, agent-skills, products).
- Access path: agents via loopback MCP to substrate-mcp -> forwarders. Desk/gateway has own keys for Hindsight/RAGFlow. Agents never receive direct creds.
- What goes where:
  - Events: GreptimeDB (writer: substrate-mcp only).
  - Index: TimescaleDB (writer: substrate-mcp).
  - Cache: DragonflyDB (read-through only; no queues/pubsub per decision).
  - Memory: Index + Hindsight (retained until replaced; governance gate).
  - Documents: RAGFlow (ingest on merge or skills-sync; last 5 versions bookkeeping).
- Hindsight banks: sub-*, pd-*.
- RAGFlow datasets: listed, refresh on merge/sync.
- Current wiring: substrate-mcp reads GREPTIME_*, SUBSTRATE_PG_URL, DRAGONFLY_URL (loopback), HINDSIGHT_*/RAGFLOW_* (gateway separate).
- Fail-open budget: cache miss, plane error falls through to empty or last-good. Writes to Greptime/Timescale fail-closed for durability.
- Dragonfly prod on Railway is idle (VPS loopback is active; operator decision to keep/repurpose).

From docs/config-reference.md:
- Env for resources:
  - Greptime: GREPTIME_URL, USER, PASSWORD, DB; SUBSTRATE_LEDGER_* for TTL, archive, etc.
  - Index: SUBSTRATE_PG_URL; memory expiry, sweep, etc.
  - Cache: DRAGONFLY_URL; SUBSTRATE_CACHE, SWR, etc.
  - Hindsight: HINDSIGHT_URL, API_KEY, BANKS, etc.
  - RAGFlow: RAGFLOW_URL, API_KEY; SUBSTRATE_DOCS_* for roots, prune, etc.
  - Railway/Tailscale: referenced in railway-tailscale.md for forwarders, ACLs (tag:vps, admin); no direct in config-reference but in data-planes and railway docs.
- Promotion policies, defaults preserve or report/shadow.

From README.md and AGENTS.md (updated state):
- 4-plane layer: runtime, memory, skills, ledger.
- Non-negotiables: fail-open except memory; redact before emit; append-only fail-closed; secrets in env only.
- Resources reached only through substrate-mcp (store lock).
- The 7 SOTA enhancements (as documented):
  1. Railway Resource Orchestrator: leverage Railway for dynamic orchestration, scaling, cost.
  2. RAGFlow Advanced Hybrid RAG with Hindsight Context: enhance with hybrid, rerank, memory augment.
  3. GreptimeDB + Dragonfly Predictive Analytics & Cache: predictive on Greptime, cache.
  4. TailscaleDB Secure Unified Proxy Layer: secure access layer.
  5. Hindsight Graph Memory with Greptime Events: graph memory using events.
  6. Dragonfly Pub/Sub for Real-time Events: pub/sub for realtime.
  7. Enterprise Unified Resource Fabric: unified control for all 6.
- Resource mappings table in docs (Railway hosting/forwarders, RAGFlow docs, Hindsight memory, Greptime ledger, Dragonfly cache, Tailscale secure).
- Gaps noted: idle resources (e.g. Railway Dragonfly), limited cross-integration, no advanced SOTA (predictive, graph, pub/sub, unified), basic access, degraded paths.

### Usage Patterns
- All via substrate-mcp (MCP tools: memory_*, docs_*, events, graph).
- Operators: env (0600), Railway console, Tailscale admin.
- Failure modes: lost trail (Greptime), stale (Dragonfly), RBAC deny (memory).
- From code (greps): references in config.ts (env parsing for RAGFLOW, HINDSIGHT, GREPTIME, DRAGONFLY, railway in recent), planes (ragflow.ts, hindsight.ts), greptime.ts, cache.ts, service.ts, etc.
- No direct client access; derived planes.

### Gaps for Additional Utility
From .planning/7-SOTA-ENHANCEMENTS.md and review:
- Idle resources (Dragonfly on Railway unused due to RTT; basic use of others).
- Limited cross-integration (no predictive analytics combining Greptime + Dragonfly; no graph memory in Hindsight from events; no pub/sub; no unified fabric for all 6; no advanced RAG with memory context; basic Tailscale proxy without full secure layer; Railway used for hosting but not orchestrated via MCP for scale/cost).
- No advanced SOTA features (forecasting, causal graphs, realtime events, enterprise control plane).
- Degraded paths not fully leveraged for utility.
- The 7 enhancements address these by extending use of the resources for more utility (e.g., predictive, graph, pub/sub, orchestrator, secure, hybrid, fabric).

Evidence basis: data-planes.md (full wiring, tables, gaps), config-reference.md (env, defaults), README/AGENTS (7 listed with mappings), greps for code refs, 7-SOTA doc.

## The 7 Enhancements (as per plan)
See .planning/7-SOTA-ENHANCEMENTS.md for details. All production-grade, follow Desk rules (draft PRs, Greptile 5/5, opt-in flags, preserve non-negotiables).

1. Railway Resource Orchestrator (leverage Railway)
2. RAGFlow Advanced Hybrid RAG with Hindsight Context (RAGFlow + Hindsight)
3. GreptimeDB + Dragonfly Predictive Analytics & Cache (Greptime + Dragonfly)
4. TailscaleDB Secure Unified Proxy Layer (Tailscale + DBs)
5. Hindsight Graph Memory with Greptime Events (Hindsight + Greptime)
6. Dragonfly Pub/Sub for Real-time Events (Dragonfly + events)
7. Enterprise Unified Resource Fabric (all 6 + cross)

## Next per plan
Wave 2: document in AGENTS/CLAUDE/README (already present in current state from commit).
Wave 3: update planning.

All changes preserve store-lock, fail-open except memory, redact, append-only.

(Review complete; evidence from repo reads/greps. No invented facts.)