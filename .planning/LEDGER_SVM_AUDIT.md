# Ledger / SVM / Solana Testnet audit (n4, SPE-39362) — 2026-11-28

## Verdict: **BUILT_NOT_DEPLOYED** (confidence: high)

No local SVM/validator/VM is deployed anywhere on this VPS. No custom Solana program exists.

## Evidence

- Public RPC only: `SOLANA_RPC_URL=https://api.devnet.solana.com` (`.env.example`); local piece = `solana` CLI at `/root/.local/share/solana/install/active_release/bin/solana` + keypair **path** (`packages/ledger/src/solana.ts`).
- Design: hourly Merkle root of `agent_events` → fixed devnet memo `substrate:v1:<hour>:<root>:<count>` (ADR-0006; `packages/ledger/src/{memo,merkle,rpc,signer-set,devnet-reset}.ts`); custom program explicitly rejected.
- Anchor transaction: none sent per v1.7 audit (2026-10-26: key funding + anchor timer operator-gated). No live `anchors`-table or signer-history check run this pass — statement is historical, not a live assertion.
- Devnet reachable (public RPC configured); chain state not queried this pass.

## If deployed: Testnet-only readiness (approval-gated)

1. Fund the anchor keypair on devnet (airdrop/devnet faucet; REQUIRED_BALANCE_LAMPORTS = 895,880).
2. Confirm RPC identity (`getHealth`/`getVersion` → devnet cluster) before any send.
3. Enable the hourly anchor timer; verify first memo tx by signature read-back.
4. Rollback: disable timer; anchors table retains durable copy regardless of devnet resets.

**No deployment performed. Explicit user approval required before any send.**
No mainnet configuration or key material found.

## Verification gates (n6)

- Migrate/contract/archive/rollback suites: 94/94 green 2026-11-28 (test PG substrate-test-pg:55434); tsc clean.
- Full `bun run verify`: 12872 pass / 16 fail / 5 errors (pre-existing dirty-tree suites: REST RAG-breaker timeouts, Railway-env fabric, memory_search, grok-bot harness, doc links). Gap recorded, not a pass.
- Secrets: Biome errors on any/non-null; keypair path only for anchors; no private-key material in repo.
- Devnet (Testnet) only: RPC getHealth/getVersion before any send (readiness plan above); anchoring emits memo-only tx (0 SOL / 1 lamport); no mainnet use.
- Rollback: pg_dump in ~/backups (chmod 700) taken pre-apply; protocol in docs/runbooks/.

## Execution waves (n7)

- Wave 1 (done): discovery inventory (STATE.md appended section) + this audit + quality baseline.
- Wave 2 (done): decomposition (`.planning/audit/phase-decomposition.md`) + SVM audit (this file).
- Wave 3 (done): issue specs (pre-existing `.planning/issue-programming/` + planner-created rows in Linear/Notion); decision defaults recorded.
- Wave 4 (done): verification gates (above).
- Remaining work (owner-gated): 10 quarantined autonogrammer files; 4,142 dup-row cleanup decision; Wave-7 STATE/ROADMAP close (human verify for 8 phases). Production v50-52 already applied (prod boots at schema v52, 2026-11-28).
