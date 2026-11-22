# Phase 69: Doc Proofs - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
A Merkle root over the corpus manifest, recorded so the existing hourly anchor covers it, with proofs and verification. It does not send a transaction and does not change the memo format.

## Decisions
- **D69-1:** the memo is fixed: `substrate:v1:<period_start_iso>:<root_hex64>:<count>` for a whole UTC hour, and readers accept memo programs v1, v3 and v4 (`packages/ledger/src/memo.ts:1-15`). The hourly root is an RFC 6962 Merkle root over the hour's event hashes in ingest order (`merkle.ts`, `checkpoint-verify.ts:25-29`). Session checkpoints are anchored the same way, "through the hourly root", without a per-checkpoint memo (STATE.md:570). The corpus follows that precedent: it emits a ledger event carrying the corpus root, and the hour's anchor covers it.
- **D69-2:** the leaves are `(repo, path, sha256)` sorted; the leaf encoding is fixed in `packages/corpus/src/protocol.ts` and tested against known vectors.
- **D69-3:** verification reuses `merkleProofHex`, `verifyMerkleProofAgainstCommitment` and the chain-evidence classification in `checkpoint-verify.ts`; with no anchor row the answer is `unanchored`, not an error.
- **D69-4:** the anchor job, the funded key and the timer are operator-gated: the hourly job is gated by `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, the devnet URL guard, the genesis hash check and a balance check (`anchor.ts:57,274`, `anchor-run.ts:41-42`); no `systemctl list-timers` entry exists for it on this host.

## Canonical references
`packages/ledger/src` (`merkle.ts`, `merkle-proof.ts`, `memo.ts`, `solana.ts`), `packages/mcp-server/src/anchor.ts`, `checkpoint-verify.ts`, `docs/greptime-ledger.md`, `docs/runbooks` (chain outage, signer rotation)
