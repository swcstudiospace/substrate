# 7 State-of-the-Art Enhancements for Agent Substrate

**Date:** 2026-10-19
**Goal:** Leverage existing resources (Railway, RAGflow, Hindsight, TailscaleDB, GreptimeDB, DragonflyDB) for more utility. Production-grade, enterprise-ready.

From investigation:
- Current usage: RAGFlow for docs (search/ingest), Hindsight for recall, Dragonfly for cache (VPS loopback, Railway idle), Greptime for ledger, Railway for hosting, Tailscale for private forwarders.
- Gaps: Idle resources, limited cross-integration, no advanced SOTA (predictive, graph, pub/sub, unified fabric), degraded paths, basic access.

## The 7 Enhancements

1. **Railway Resource Orchestrator**
   - SOTA: Cloud resource management with auto-optimization, cost attribution, dynamic scaling.
   - Utility: Direct MCP tools for Railway services (scale, monitor, deploy) using forwarders.
   - Changes: New MCP tools in mcp-server, integration with config and infra.
   - Target files: packages/mcp-server/src (new railway.ts), docs/data-planes.md, config-reference.md
   - Acceptance: MCP tool lists Railway resources, basic scale suggestion, cost report in /slo.

2. **RAGFlow Advanced Hybrid RAG with Hindsight Context**
   - SOTA: Hybrid search, reranking, memory-augmented retrieval.
   - Utility: Context from Hindsight + Greptime events for personalized docs answers.
   - Changes: Extend ragflow.ts retrieval, integrate with hindsight recall in search path.
   - Target files: packages/mcp-server/src/planes/ragflow.ts, planes/hindsight.ts, docs/docs-plane.md
   - Acceptance: docs_search returns context-augmented results; tests for hybrid.

3. **GreptimeDB + Dragonfly Predictive Analytics & Cache**
   - SOTA: Time-series forecasting, predictive caching, anomaly detection.
   - Utility: Predict SLO burn, pre-warm Dragonfly from Greptime patterns; activate Railway Dragonfly.
   - Changes: Forecasting in ledger, predictive logic in cache.ts.
   - Target files: packages/mcp-server/src/cache.ts, greptime code, observability, data-planes.md
   - Acceptance: /slo has predictive rows; cache preloads based on patterns.

4. **TailscaleDB Secure Unified Proxy Layer**
   - SOTA: Zero-trust DB access with RBAC, audit, pooling.
   - Utility: Unified secure access for Greptime, Dragonfly, Timescale via Tailscale.
   - Changes: New proxy layer or enhancements in config/network.
   - Target files: docs/railway-tailscale.md, data-planes.md, config for DBs
   - Acceptance: All DBs accessed via secure proxy; audit events for access.

5. **Hindsight Graph Memory with Greptime Events**
   - SOTA: Graph-based long-term memory, causal inference from events.
   - Utility: Build graphs from Greptime ledger for advanced recall in Hindsight.
   - Changes: Graph structures in hindsight, event correlation.
   - Target files: packages/mcp-server/src/planes/hindsight.ts, memory code, greptime
   - Acceptance: memory_search returns graph-linked results; recall uses causal.

6. **Dragonfly Pub/Sub for Real-time Events**
   - SOTA: Real-time pub/sub, event-driven cache invalidation.
   - Utility: Pub/sub on Dragonfly for propagating Greptime events to planes in real-time.
   - Changes: Add pub/sub in cache, integration with events.
   - Target files: packages/mcp-server/src/cache.ts, event emit code
   - Acceptance: Real-time notifications for events via Dragonfly; tests.

7. **Enterprise Unified Resource Fabric**
   - SOTA: Cross-resource control plane for observability, compliance, auto-optimization, cost.
   - Utility: Single MCP interface and dashboards for all 6 resources on Railway + Tailscale.
   - Changes: New fabric module, MCP tools aggregating planes, Railway, DBs.
   - Target files: packages/mcp-server/src (new fabric/), observability, docs, config-reference
   - Acceptance: New MCP tools for fabric status, optimization suggestions; compliance report.

## Implementation Approach
- Each as draft PR following AGENTS.md (Greptile 5/5 required).
- Update docs with new sections.
- Use flags for opt-in (shadow first).
- Verify with existing gates.

## Doc Updates Needed
- AGENTS.md: Add section on new enhancements and resource utility.
- Create CLAUDE.md: Mirror AGENTS + enhancement guidelines.
- README.md: Add section on the 7 enhancements and resource leverage.
- docs/data-planes.md, docs-plane.md, config-reference.md: Expand with new features.
- New runbooks for fabric and TailscaleDB.

Current PR baseline (from gh): PR #83 for 7 SOTA, Greptile review in progress with fixes applied for P1/P2 (bookkeeping, tests, filters, exports, deadlines, auth, mTLS, etc.). Per AGENTS.md: Draft only, no self-merge, Greptile 5/5 gate required. This PR #83 covers the 7.

This introduces the enhancements. Code changes included in branch commits.
