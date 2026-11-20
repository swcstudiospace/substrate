# API Coverage — Phase 16

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

No external API integration: the phase drives the local Docker CLI, read-only systemd / ss / procfs / git host probes, and the repo's own substrate-mcp HTTP API over loopback. RAGFlow (retired, superseded by LightRAG), Hindsight, Dragonfly, Linear, Notion and Solana appear only as forbidden names in the harness env allowlist, never as clients.
