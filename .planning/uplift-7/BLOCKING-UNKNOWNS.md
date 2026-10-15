# Blocking unknowns (uplift-7, node n3)

Each unknown from the planning spec, with its status after this run. "Answered" means you decided it in this run. "Resolved" means evidence settles it. "Default" means a documented default applied and is still open for your confirmation. "Open" means no decision yet. "Operator" means an operator step is needed.

| # | Unknown | Status | Basis |
| --- | --- | --- | --- |
| 1 | Where the substrate lives, and whether one shared access layer exists | Resolved | `packages/mcp-server` (`class Substrate` in `service.ts`). Baseline in `SUBSTRATE-HEALTH.md` (PR #71). |
| 2 | Whether the shared layer can emit attributed events without a redesign | Resolved | Counters carry the surface on every point (`substrate.request.total`, `substrate.emit.total`, `substrate.tool.calls`). The panel reads them, so no emitter changed. |
| 3 | Event retention, and who may view it | Default | Inherits the substrate's controls. The panel shows counts and names, never record content. Confirm. |
| 4 | Whether Claude Code is a verified client | Resolved by evidence | Surface `claude-code` is counted in the live `/metrics`: 9 requests and 2 emits since 2026-10-13. |
| 5 | Whether other CLI agents and Grok-based bots emit, or stay NOT_INSTRUMENTED | Resolved by evidence | `grok-bot`, `cursor`, `hermes`, and `muse` have counted requests. `codex`, `grok-build`, `opencode`, and `pi` are known from their token files and show NOT_INSTRUMENTED. |
| 6 | Whether Railway and Solana documentation can be fetched | Resolved | Seven primary pages fetched on 2026-10-15 (HTTP 200). See `SOLANA-FEASIBILITY.md`. The public devnet RPC rate limit is still UNVERIFIED. |
| 7 | The Solana Ledger role and target network | Default | Role: anchor closed-hour roots. Network: devnet, never mainnet or testnet. Confirm with the VALIDATION_REQUEST. |
| 8 | The Railway budget ceiling | Default | $50 per month at test scale. Confirm. |
| 9 | Which host shows the panel | Answered | The Omp TUI, at the GREY_AREA pause. |
| 10 | Whether to add a per-surface last-seen value to `/metrics` | Answered | No. Keep the viewer's poll clock, at closeout. |
| 11 | Whether the STALE state can be shown | Open | It needs an event time, and `/metrics` carries none. `POST /events/query` returns server timestamps, so reading it is an option you have not decided. |
| 12 | Cross-agent memory visibility | Answered and fixed | Agent scope is private; shared scopes are visible. PR #73, merged as `33b4677`. |
| 13 | Routine and category gaps | Default | Reported, not built. |
| 14 | The known-client list source | Default | The ten token files in `SUBSTRATE_TOKENS_DIR`, with `omp` always included. Confirm. |
| 15 | Remaining substrate gaps: invalid-write round trip; expected-version for skills and docs; degraded-mode queue | Open | No date set. |
| 16 | Whether the devnet anchor key can be funded from here | Operator | Every airdrop attempt is rate-limited, and the key holds 0 SOL. |
| 17 | Whether the three uncovered workstreams need ROADMAP phases | Default | Recorded as uplift-7 records, not phases. This is a SCOPE_CHANGE. Confirm. |
