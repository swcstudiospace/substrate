# API Coverage — Phase 17 (event vocabulary and audit policy)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

No external API integration: the phase talks only to the project's own scratch
substrate over loopback HTTP (`POST /events`, `POST /events/query` against the
Phase 16 harness) and reads one git object read-only (`git show` of the v1.2
baseline). No third-party API, SDK, dataset, or service is touched — RAGFlow,
Hindsight, Linear, Notion, Solana, and GitHub all belong to later phases.
