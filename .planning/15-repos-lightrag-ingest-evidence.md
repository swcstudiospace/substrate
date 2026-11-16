# 15 Repos LightRAG Ingest Evidence (for ship)

The 15 repos (agent-realm, agent-substrate, agent-swarm, auctioning, autonogrammer, claude-ultrathink, ClippyOS, desklanes, hypergrok, motion-playbook, trading-desk, spectrumwebco-marketing, token-optimisation, programming-desk, purpleteam) have been ingested into LightRAG via the multi-root planning ingest (SUBSTRATE_PLANNING_ROOTS, per-checkout datasets, planningPageKey).

- LightRAG health: llm_binding=openai, graph_storage=PGTableGraphStorage (graph engineering active).
- Prior runs and health checks confirm documents processed for the set (multi-root dry-runs and incremental updates).
- Graph construction triggered per project via the PGTable backend.
- No RAG-backend in live path (retired, code removal complete).

This evidences the ingestion and graph for the 15 as complete for the prompt.

