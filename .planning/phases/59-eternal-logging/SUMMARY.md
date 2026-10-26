---
phase: 59-eternal-logging
milestone: v1.6
requirements: [SOTA-15]
status: implemented on gsd/v16-int (7b37ea6, 084eb69, a26841d, 2aaa19a, 824ceda, plus ccbfff2, the constant fix); partial; not merged; no live devnet proof
---

# 59-SUMMARY: Eternal logging, verifiable checkpoint and rollback events on Solana devnet

## What was built

- **Merkle inclusion proofs (7b37ea6)** `packages/ledger/src/merkle-proof.ts`: audit path and verification following RFC 6962 section 2.1.1 and RFC 9162 section 2.1.3, with domain digests; the test covers every index of every tree size 1 to 40 and tampering.
- **Devnet-only RPC URL guard (7b37ea6)** `assertDevnetRpcUrl` in `packages/ledger/src/rpc.ts`, called at `createRpc` and at configuration load (`config.ts`): it refuses non-http(s), userinfo, a fragment, and a mainnet or testnet URL, beside the existing genesis-hash gate.
- **Checkpoint verification (084eb69, a26841d)** `checkpoint-verify.ts` and `anchor-verify-deps.ts`, exposed as the read tools `checkpoint_verify` and `memory_verify`: a checkpoint (or any ledger event) resolves to its hour root, an inclusion proof, the `anchors` row and the devnet memo, and the verdict is exactly one of anchored, pending, unanchored, unverified or mismatch. Unconfigured Solana or ledger, a refused URL, or an unreadable chain answers `unverified` with a fixed reason and no network call; no transaction is sent.
- **Signer set (084eb69, 824ceda)** `packages/ledger/src/signer-set.ts`: validity windows, `acceptsSigner` judged by the anchor's block time, rotation payloads and event drafts, a fold over operator-surface `anchor.signer.rotate` notes; `SUBSTRATE_ANCHOR_SIGNER_SET` (JSON, up to 16 entries) replaces `SOLANA_ANCHOR_PUBKEY` as the bootstrap when set.
- **Devnet reset classification (084eb69)** `classifyChainEvidence` in `devnet-reset.ts`: `ok`, `reset-suspected`, `chain-unreachable` and `signature-missing`; the last three are read as `unverified`, never `mismatch`.
- **Re-anchor planner (084eb69, 2aaa19a)** `reanchor-plan.ts` and `reanchor-plan-run.ts`: a read-only plan and dry-run, and the validated `anchor.reanchor` event.
- **Runbooks (2aaa19a, 824ceda):** chain outage, signer rotation, devnet reset and re-anchor.

## Key decisions

- Memo v1 stays; checkpoints anchor through the hourly root (D55-2). Verification is by inclusion proof, not by a per-checkpoint memo.
- The verifier follows the `anchors` row's signature, not the chain at large (`docs/runbooks/devnet-reset-and-reanchor.md`).

## Deviations from the plan

- **Criterion 5 is partial.** Classification and a read-only dry-run exist; the re-anchor send was not built because the anchor job cannot re-send an hour that already has an `anchors` row (the sweep and the adopt path skip it, and a replace-or-ignore behaviour of the row table is UNVERIFIED). The runbook lists the design the owner would have to decide; it does not invent a flag.

## Findings

- **Defect found and fixed (ccbfff2): the devnet genesis hash constant was wrong since phase 28.** `DEVNET_GENESIS_HASH` in `packages/mcp-server/src/anchor.ts` held `...xqaEyCydFLPYGEC`; a live read-only `getGenesisHash` on 2026-10-26 returned `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The anchor job's genesis gate would have refused real devnet, and `checkpoint_verify` would have misreported it. It was never caught because the live proof (phase 41) was never run. The constant is corrected, with 12 test fixtures, in ccbfff2. ADR 0006 records it ("The genesis hash finding").
- **Defect fixed (824ceda):** the verifier's only bootstrap signer was the anchor job's own key (`SOLANA_ANCHOR_PUBKEY`), so rotating the job key would have turned every old anchor into a mismatch.
- **Defect fixed (a26841d, 824ceda):** a refused Solana URL reached MCP callers with its host; the reason is now fixed text and the detail stays in boot warnings.
- Residual: the multi-process and live behaviours are unverified; no devnet transaction was ever sent from this milestone.

## What remains (operator-gated)

Funding the anchor key, installing `substrate-anchor.timer`, any devnet send, the re-anchor send and the live devnet proof (phase 41); the replace-or-ignore check of the `anchors` table; a decision on a re-anchor mode of the job.
