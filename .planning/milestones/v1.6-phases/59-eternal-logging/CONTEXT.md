---
phase: 59-eternal-logging
milestone: v1.6
requirements: [SOTA-15]
discussed: 2026-10-26
status: implemented on gsd/v16-int; partial (criterion 5: no re-anchor send); no live devnet proof (operator-gated)
---

# 59-CONTEXT: Eternal logging, verifiable checkpoint and rollback events on Solana devnet

## Goal

Every checkpoint and rollback is a ledger event that is provably inside an hourly root anchored on Solana devnet, verifiable without trusting the substrate; devnet resets and signer changes are detected and recoverable. Roots only, devnet only. The roadmap block is ROADMAP.md, Phase 59.

## Locked decisions

- **D55-2: memo-only anchoring behind the existing hourly job; no custom Solana program and no memo v2.** Memo v1 is fixed (`substrate:v1:<hour>:<root>:<count>`, `packages/ledger/src/memo.ts`), so a checkpoint is anchored indirectly: its event sits inside the hour's Merkle root, and the phase adds inclusion proofs instead of per-checkpoint memos.
- **D55-6: devnet is evidence, not storage.** Devnet may be reset and publishes no retention window; the durable proof is the ledger row, its inclusion proof and the `anchors` row. A failed chain lookup is `unverified`, never tampering; only a read that succeeded and disagrees is `mismatch`.
- **Roots only, devnet only.** No event content goes on chain. The RPC URL guard refuses mainnet and testnet in addition to the genesis-hash gate.
- **No transaction is sent by this phase's code.** Funding the anchor key, installing the timer, any devnet send and the re-anchor send are operator steps (phase 41, accepted debt).
- **Rotation is a ledger event.** The verifier's signer set is a bootstrap set plus operator-surface `anchor.signer.rotate` notes; `SUBSTRATE_ANCHOR_SIGNER_SET` lets the anchor job's key rotate without turning old anchors into mismatches.

## Links

- Code: `packages/ledger/src/{merkle-proof,signer-set,devnet-reset,rpc}.ts`; `packages/mcp-server/src/{checkpoint-verify,anchor-verify-deps,reanchor-plan,reanchor-plan-run,anchor,config}.ts`
- Tools: `checkpoint_verify`, `memory_verify` (`mcp.ts`)
- Runbooks: `docs/runbooks/anchor-chain-outage.md`, `anchor-signer-rotation.md`, `devnet-reset-and-reanchor.md`
- ADR: `docs/adr/0006-memo-only-anchoring.md`
- Discovery: `../55-migration-safety/CONTEXT.md`; earlier phase: `../41-anchor/`
