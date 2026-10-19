# CLAUDE.md

## Agent Instructions for Agent Substrate

Follow all rules in AGENTS.md (Desk rules, no merge, Greptile gate, draft PR only).
Read `.substrate/BRIEF.md` at the start of your work in this repo. It is the current substrate brief — a record of what other agents did here. Substrate writes this file on a schedule; do not edit it by hand.

## Review Summary (2026-10-19)

**Scope:** Update agent-facing docs (CLAUDE.md primary) for the 7 SOTA enhancements and resource leverage. Grounded reads of AGENTS.md (minimal enhancement coverage, points to 7-SOTA), README.md (strong 4-plane overview + non-negotiables + store lock), docs/data-planes.md (core 5-service wiring, Hindsight banks, RAG datasets, cache flags, fail-open budget, access paths), docs/config-reference.md (exhaustive generated env tables + promotion policies), docs/docs-plane.md, .planning/7-SOTA-ENHANCEMENTS.md, .planning/STATE.md, .planning/ROADMAP.md, UPLIFT_PROPOSAL.md.

**Gaps identified (pre-update):** CLAUDE.md was a minimal stub (New Enhancements section only referenced 7-SOTA without details, mappings or ops notes). AGENTS.md had short 7-SOTA pointer but no resource utilities table or per-enh notes. No consolidated review summary, resource-to-enh mapping, or agent operational guidance for the new SOTA features (Railway orchestrator, advanced RAG, predictive analytics, TailscaleDB proxy, graph memory, pub/sub, unified fabric). Docs were solid on current wiring but not yet tied to enh1–enh7.

**Resolution:** This CLAUDE.md now carries the review summary, full 7 enhancements with SOTA/utility/acceptance, resource mappings table, operational notes, non-negotiables, and dev/PR guidance. Preserves all existing rules. Mirrors AGENTS.md updates. Cross-refs to data-planes.md (expanded per enh), config-reference.md, railway-tailscale.md, observability.md, etc. All changes keep store-lock, fail-open defaults, redact-before-emit, append-only.

**Evidence basis:** Exact excerpts from data-planes (5 services table, wiring, Hindsight banks, RAGFlow datasets, Dragonfly loopback decision, fail-open budget), 7-SOTA (7 detailed enhancements), UPLIFT/STATE (post-v1.3 context), config-reference (env shapes + defaults), AGENTS (desk rules + Cursor specifics).

## The 7 Enhancements (enh1–enh7)

See .planning/7-SOTA-ENHANCEMENTS.md for full details. All production-grade, opt-in/shadow-first via flags, draft PRs only, Greptile 5/5 required. Leverage idle/under-used resources (Railway, RAGflow, Hindsight, TailscaleDB, GreptimeDB, DragonflyDB).

1. **enh1-railway-orchestrator: Railway Resource Orchestrator**
   - SOTA: Cloud resource management with auto-optimization, cost attribution, dynamic scaling.
   - Utility: Direct MCP tools for Railway services (scale, monitor, deploy) using forwarders.
   - Changes: New MCP tools in mcp-server (railway.ts), integration with config and infra.
   - Target: packages/mcp-server/src (new railway.ts), docs/data-planes.md, config-reference.md
   - Acceptance: MCP tool lists Railway resources, basic scale suggestion, cost report in /slo.

2. **enh2-ragflow-advanced: RAGFlow Advanced Hybrid RAG with Hindsight Context**
   - SOTA: Hybrid search, reranking, memory-augmented retrieval.
   - Utility: Context from Hindsight + Greptime events for personalized docs answers.
   - Changes: Extend ragflow.ts retrieval, integrate with hindsight recall in search path.
   - Target: packages/mcp-server/src/planes/ragflow.ts, planes/hindsight.ts, docs/docs-plane.md
   - Acceptance: docs_search returns context-augmented results; tests for hybrid.

3. **enh3-greptime-dragonfly-predictive: GreptimeDB + Dragonfly Predictive Analytics & Cache**
   - SOTA: Time-series forecasting, predictive caching, anomaly detection.
   - Utility: Predict SLO burn, pre-warm Dragonfly from Greptime patterns; activate Railway Dragonfly.
   - Changes: Forecasting in ledger, predictive logic in cache.ts.
   - Target: packages/mcp-server/src/cache.ts, greptime code, observability, data-planes.md
   - Acceptance: /slo has predictive rows; cache preloads based on patterns.

4. **enh4-tailscaledb-secure: TailscaleDB Secure Unified Proxy Layer**
   - SOTA: Zero-trust DB access with RBAC, audit, pooling.
   - Utility: Unified secure access for Greptime, Dragonfly, Timescale via Tailscale.
   - Changes: New proxy layer or enhancements in config/network.
   - Target: docs/railway-tailscale.md, data-planes.md, config for DBs
   - Acceptance: All DBs accessed via secure proxy; audit events for access.

5. **enh5-hindsight-graph: Hindsight Graph Memory with Greptime Events**
   - SOTA: Graph-based long-term memory, causal inference from events.
   - Utility: Build graphs from Greptime ledger for advanced recall in Hindsight.
   - Changes: Graph structures in hindsight, event correlation.
   - Target: packages/mcp-server/src/planes/hindsight.ts, memory code, greptime
   - Acceptance: memory_search returns graph-linked results; recall uses causal.

6. **enh6-dragonfly-pubsub: Dragonfly Pub/Sub for Real-time Events**
   - SOTA: Real-time pub/sub, event-driven cache invalidation.
   - Utility: Pub/sub on Dragonfly for propagating Greptime events to planes in real-time.
   - Changes: Add pub/sub in cache, integration with events.
   - Target: packages/mcp-server/src/cache.ts, event emit code
   - Acceptance: Real-time notifications for events via Dragonfly; tests.

7. **enh7-unified-fabric: Enterprise Unified Resource Fabric**
   - SOTA: Cross-resource control plane for observability, compliance, auto-optimization, cost.
   - Utility: Single MCP interface and dashboards for all 6 resources on Railway + Tailscale.
   - Changes: New fabric module, MCP tools aggregating planes, Railway, DBs.
   - Target: packages/mcp-server/src (new fabric/), observability, docs, config-reference
   - Acceptance: New MCP tools for fabric status, optimization suggestions; compliance report.

## Resource Mappings

Resources (5 planes + infra) are derived/accessed **only via substrate-mcp**. Agents never hold direct plane credentials. See docs/data-planes.md for full wiring, Hindsight banks, RAGFlow datasets, access diagram, and current vs. target (post-private-forwarder) tables. Dragonfly prod on Railway is idle (VPS loopback redis is the active cache).

| Resource / Service | Primary utility | Agent access | Key enh tie | Failure mode |
|--------------------|-----------------|--------------|-------------|--------------|
| GreptimeDB (Ultrathink) | Append-only events + hash chain + anchors (ledger) | Via mcp only (`events_emit`, etc.) | enh3, enh6, enh7 | Lost trail (fail-open for reads) |
| TimescaleDB (Ultrathink) | Index / coordination / graph / memory governance | Via mcp only (`graph_*`, `memory_*`) | enh5, enh7 | No graphs/briefs (fail-open) |
| DragonflyDB (Ultrathink, idle) | Cache (brief, memory search, graph view); potential predictive/pre-warm | Via mcp read-through (loopback preferred) | enh3, enh6, enh7 | Degraded/uncached (fail-open) |
| Hindsight (Agent Substrate) | Memory / recall (sub-*, pd-* banks) | Via mcp (`memory_write`/`search`/`recall`) + direct for desk gateway | enh2, enh5, enh7 | No cross-session recall (degraded) |
| RAGFlow (Agent Substrate) | Documents / cited search + ingest | Via mcp only (`docs_search`, `docs_ingest`) | enh2, enh7 | Degraded/empty results (fail-open) |
| Railway + Tailscale forwarders | Hosting, orchestration, secure private access | Via substrate MCP / forwarders (no direct) | enh1, enh4, enh7 | Resource unreachable (degraded) |

**Access path (agents vs. desk):** Agents → loopback MCP (substrate-mcp) → private forwarders. Grok Bots/Desk → HTTPS gateway (own keys for Hindsight/RAGFlow). See data-planes.md §Access path and §Current wiring.

**Non-negotiables (README + data-planes):** Fail-open except memory (write must pass governance gate + verified_persisted). Redact before emit. Append-only ledger (Greptime only). Store lock: no second doors. Agents never receive DB creds or keys.

## Operational Notes

- **Always start here:** Read `.substrate/BRIEF.md` (immutable; substrate-written). Then relevant docs (data-planes.md, config-reference.md, docs-plane.md, railway-tailscale.md, observability.md, grok-bot.md).
- **Desk rules (AGENTS.md):** Draft PR only into default branch. No merge, no auto-merge, no force-push, no branch delete. No secrets (env names only; never tailnets, internal hostnames, tokens, keys). Greptile gate via Desk Quality: every PR must pass with addressed findings; FAILED/SKIPPED/unavailable review is blocker, never pass.
- **Cursor Cloud specifics (AGENTS.md):** Bun 1.4.0 + Python 3.12. Checks: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun test` (with `SUBSTRATE_TEST_PG_URL`), `python3 -m pytest packages/miner/tests packages/dispatcher/tests`, `bun run check:phase-close` / `verify`. `commit.gpgsign=false`. Scratch PG + rehearsal details apply.
- **Enhancements implementation:** All via draft PRs. Use flags for opt-in (shadow first). Update docs (this file, AGENTS.md, README, data-planes.md, config-reference.md, runbooks) when adding features. Follow existing plane patterns (ragflow.ts, hindsight.ts, cache.ts, event.ts). New MCP tools: register in packages/mcp-server/src/mcp.ts following types. Verify with existing gates (no new shortcuts).
- **Resource access & security:** All 5 services + Railway reached only through substrate. Never direct creds in agent sessions. Use Tailscale forwarders for private access (see railway-tailscale.md). Audit via ledger/events. Fail-closed for writes to ledger/index where durability required.
- **Config & flags:** See full tables in docs/config-reference.md (generated from flag-registry.ts; run `bun run config:reference -- --check` after flag changes). Promotion via docs/runbooks/flag-promotion.md. Defaults preserve behavior or are report/shadow.
- **Planes & cache specifics:** Dragonfly is read-through cache only (no queues/locks/pubsub yet; see enh6). Hindsight banks: sub-<surface> for agents, pd-* for desk. RAGFlow datasets: agent-substrate (on merge), agent-skills (post-sync), programming-desk, products. Recall in brief: `SUBSTRATE_BRIEF_RECALL` (off/shadow/enforce). Cache bump/narrow per uplift.
- **Observability:** /healthz, /slo, breakers, budgets, metrics history (opt-in). Predictive/enh3 will extend /slo. Always count refusals, degraded paths.
- **PR Process:** Draft only. Greptile 5/5 with addressed comments required before claiming ready. No self-merge. Update CLAUDE.md + AGENTS.md on rule/feature changes.
- **No deviation:** Preserve store-lock, redact, append-only, fail-open budget. Enhancements must not create direct access paths or bypass governance.

See .planning/7-SOTA-ENHANCEMENTS.md for the originating research report and .planning/ for context. Cross-reference docs/data-planes.md §Enhancements (enh1–enh7) and resource utilities for agent view. 

## Development

- Read relevant docs first (data-planes.md, config-reference.md, docs-plane.md).
- Use existing patterns for planes (ragflow, hindsight, cache, events).
- For new MCP tools, follow mcp.ts registration and types.ts (SURFACES etc.).
- No secrets in repo or transcripts.
- For enhancements: map to enhN, update resource table + operational notes here.

## PR Process

- Draft only.
- Greptile 5/5 with addressed comments required before claiming ready.
- No self merge.

All changes via draft PRs. Maintain fail-open except memory, redact, append-only, etc.
