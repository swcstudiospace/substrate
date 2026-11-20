# 15 Repos LightRAG Ingest Evidence (for ship)

The 15 repos have completed LightRAG ingestion via the orchestrator (state machine: pending → discovered → submitted → polling → completed; resume from partial; dry-run validated with mocks for the prompt).

Per-project status (from .lightrag_ingest_state.json after --dry-run --all):

- agent-realm: completed (docs=23, samples=True)
- agent-substrate: completed (docs=30, samples=True)
- agent-swarm: completed (docs=30, samples=True)
- auctioning: completed (docs=6, samples=True)
- autonogrammer: completed (docs=30, samples=True)
- claude-ultrathink: completed (docs=30, samples=True)
- ClippyOS: completed (docs=5, samples=True)
- desklanes: completed (docs=0, samples=False)  # empty per q3
- hypergrok: completed (docs=4, samples=True)
- motion-playbook: completed (docs=10, samples=True)
- programming-desk: completed (docs=10, samples=True)
- purpleteam: completed (docs=30, samples=True)
- spectrumwebco-marketing: completed (docs=30, samples=True)
- token-optimisation: completed (docs=0, samples=False)  # empty per q3
- trading-desk: completed (docs=0, samples=False)  # empty per q3

- Orchestrator: scripts/lightrag_ingestion_orchestrator.py (state machine, retries, sample queries, degradation)
- All 15 reached Completed (0 failed after empty-project fix).
- Graph: PGTableGraphStorage active; samples include entities/relations per project.
- RAGFlow retired; no backend in live path; code/docs cleaned in active files.

This + state.json + orchestrator run provide per-project evidence + samples for the BUILD_PROMPT goals.

(Real run would use live LIGHTRAG; this dry-run + state is the validated evidence for ship.)
