---
phase: 59-eternal-logging
verified: 2026-10-26
status: gaps_found
score: 5 of 6 success criteria MET offline, 1 PARTIAL (criterion 5); no live devnet proof exists (OPERATOR-GATED)
verified_on: gsd/v16-int at 979b5e2 plus the uncommitted devnet genesis constant correction (phase commits 7b37ea6, 084eb69, a26841d, 2aaa19a, 824ceda)
---

# 59-VERIFICATION: Eternal logging, verifiable checkpoint and rollback events on Solana devnet

## Gates

Not run by the author of this record. Orchestrator figures for `gsd/v16-int` at 979b5e2: 7480 pass, 2 skip, 0 fail; audit gate 0 unlisted; `check:phase-close` pass; config-reference check pass. The genesis constant correction and its fixtures were uncommitted at that count. Every statement below is offline: no Solana transaction was sent by this milestone.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A Merkle inclusion proof verifies against the hourly root for every tree size and index, and any tampering fails | MET | `packages/ledger/src/merkle-proof.test.ts`: `"every index of every size 1..40 verifies against merkleRootHex, with the RFC path length"` and the tamper cases under `describe("merkleAuditPath / verifyAuditPath ...")`; `packages/mcp-server/src/checkpoint-verify.test.ts` `describe("anchored: a proof for every tree size 1..17 at every index")`. Commit 7b37ea6. |
| 2 | A verification command resolves a checkpoint to its hour root, proof, `anchors` row and devnet transaction and reports exactly one of anchored, pending, unanchored, unverified or mismatch | MET (offline, with fakes) | `checkpoint-verify.test.ts` (`pending and unanchored`, `unverified: the chain could not settle it, which is never mismatch`, `mismatch: a chain read that succeeded disagrees with the ledger`, `rotated signers`, `caller errors are typed errors`, `verifyEventAnchor: any ledger event`); `anchor-verify-deps.test.ts` (`anchored through the adapters`, `not configured: a status, decided before any read`, `checkpoint ids are found by a bounded search`); `mcp-verify-tools.test.ts` (the `checkpoint_verify` and `memory_verify` tools, the hour's leaves read at most `maxLeaves + 1`). No live run. |
| 3 | A devnet RPC URL naming mainnet or testnet is refused at configuration load and at RPC construction, beside the genesis-hash gate | MET | `assertDevnetRpcUrl` at `packages/ledger/src/rpc.ts:32`, called at `rpc.ts:133` (construction) and `packages/mcp-server/src/config.ts:758` (load); `packages/ledger/src/rpc.test.ts` `describe("assertDevnetRpcUrl (defence in depth beside the genesis-hash gate)")`. |
| 4 | A signer set with validity windows lets the verifier accept anchors signed by a rotated key and reject any other, and a rotation is itself a ledger event | MET | `packages/ledger/src/signer-set.test.ts` (`parseSignerSet`, `acceptsSigner`, `rotation payloads and event drafts`, `signerSetFromRotationEvents`); `checkpoint-verify.test.ts` `describe("rotated signers: accepted by the anchor's block time, not by who is current")`; `anchor-verify-deps.test.ts` (`the signer set: the configured key plus operator rotations`, `SUBSTRATE_ANCHOR_SIGNER_SET is the bootstrap when set`); `config-anchor-signer-set.test.ts`; the `anchor.signer.rotate` row in `event-sources.ts` and `docs/event-vocabulary.md`; the flag in `docs/config-reference.md`. The rotation note is posted by an operator through `events_emit` (`docs/runbooks/anchor-signer-rotation.md`). |
| 5 | A devnet reset is classified apart from tampering, a re-anchor procedure with a dry-run exists, and the chain is documented as evidence and not as storage | PARTIAL | Classification: `packages/ledger/src/devnet-reset.test.ts` (`describe("classifyChainEvidence")`). Dry-run: `reanchor-plan.test.ts`, `reanchor-plan-run.test.ts` (read-only by construction; its import list is pinned by test). Documentation: `docs/runbooks/devnet-reset-and-reanchor.md`, ADR 0006. Not met: there is no re-anchor send. The anchor job skips any hour that already has an `anchors` row, and the verifier follows the row, not the chain, so a re-send needs a change that does not exist; the runbook lists the design and invents no flag. |
| 6 | No transaction is sent by this phase's code outside operator-run steps; the runbook for those steps exists | MET | `checkpoint-verify.ts`, `anchor-verify-deps.ts`, `reanchor-plan.ts` and `reanchor-plan-run.ts` make no send (the planner's only chain calls are `getGenesisHash` and `getTransaction`, header of `reanchor-plan-run.ts`); runbooks `docs/runbooks/anchor-chain-outage.md`, `anchor-signer-rotation.md`, `devnet-reset-and-reanchor.md` mark each live step operator-run. |

## Defect found by this verification

- The devnet genesis hash constant was wrong since phase 28. Current repository value `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (`packages/mcp-server/src/anchor.ts:54`, uncommitted at the time of writing) matches the live read-only `getGenesisHash` result the orchestrator took on 2026-10-26. The old value `...xqaEyCydFLPYGEC` would have made the anchor job refuse real devnet and `checkpoint_verify` misreport it. This verifier did not call the network; the live reading is the orchestrator's.

## Residual risks

- No live proof of any kind: no anchor transaction was sent, the key holds 0 SOL, the timer is not installed (phase 41, accepted debt). Everything here runs against fakes.
- Re-anchor after a reset is not possible with the current job (criterion 5).
- Whether a second `anchors` insert for an hour replaces or is ignored is UNVERIFIED.
- Devnet may be reset and public RPC nodes prune history; the durable proof is the ledger row plus its inclusion proof, and a failed chain lookup reads `unverified`.
- A checkpoint `verified` status proves the hash and an anchored cited event, not that the event concerns the entry.
- The `anchor.reanchor` event is defined and validated but nothing in the verifier reads it.
- The verifier's signer set depends on `SUBSTRATE_ANCHOR_SIGNER_SET` being kept current by an operator when the anchor key rotates.

## Operator-gated

Funding the anchor key; installing `substrate-anchor.timer`; any devnet send; the re-anchor send; the live devnet proof (phase 41); any decision on a re-anchor mode or memo v2.
