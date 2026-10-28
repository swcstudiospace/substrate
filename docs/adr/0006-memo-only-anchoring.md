# ADR 0006: Memo-only anchoring: one fixed memo, hourly roots, inclusion proofs, devnet as evidence

- **Status:** Accepted (verification code is on this branch; **no live anchor has ever been sent**, see "The genesis hash finding" and the operator gates)
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 59 (SOTA-15); phase 62, success criterion 2
- **Deciders:** Spectrum Web Co platform. Decisions D55-2 and D55-6 in `.planning/phases/55-migration-safety/CONTEXT.md`.
- **Affects:** `packages/ledger/src/{memo,merkle,merkle-proof,solana,rpc,signer-set,devnet-reset}.ts`, `packages/mcp-server/src/{anchor,anchor-verify-deps,checkpoint-verify,reanchor-plan}.ts`

## Context

The operator wants tamper-evident "eternal" logging, with every checkpoint and rollback provably inside something external. The planning assumed memo commitments per batch and per checkpoint. The code already anchors one Merkle root per closed UTC hour with a fixed memo, and readers reject anything else. Solana devnet is a test cluster: it may be reset and publishes no retention window for its public RPC (`docs/runbooks/devnet-reset-and-reanchor.md`; the signature-listing limit of 1,000 per call and pruning of old history on public nodes are upstream statements recorded in D55-6, not re-read here).

## Decision

### 1. The memo stays fixed: memo v1, root and count only

The memo is `substrate:v1:<hour start, whole UTC hour>:<64 lowercase hex root>:<count >= 1>` (`packages/ledger/src/memo.ts`, `parseMemo` and `formatMemo`). It commits a period, a Merkle root over that hour's event hashes and the event count, **never event content**. `parseMemo` rejects a `v2` prefix, a trailing suffix, an upper-case root and a zero or zero-padded count (`memo.test.ts`), and `transferMemoArgv` refuses to build a transaction whose memo does not parse as v1 (`solana.ts`). Nothing else goes on chain: no checkpoint digest, no memory record, no capsule, no transcript pointer.

### 2. Checkpoints are anchored indirectly, with inclusion proofs

A `session.checkpoint` note is an ordinary ledger event, so it sits inside the hour's root. `verifyCheckpoint` (`checkpoint-verify.ts`, tool `checkpoint_verify`) resolves a checkpoint id or event id to its hour, rebuilds the hour's leaf list in ingest order exactly as the anchor job does (`hourDigest` in `service.ts`), builds an RFC 6962 audit path (`merkleProofHex`), checks it with `verifyMerkleProofAgainstCommitment` (`merkle-proof.ts`), reads the `anchors` row and the transaction by signature, and answers exactly one of `anchored`, `pending`, `unanchored`, `unverified`, `mismatch`. **The proof is bound to the memo's count**: a root alone does not authenticate the tree size, so the proof's size must equal the anchored `count`. An hour larger than 50,000 leaves is not rebuilt in memory by default and answers `unverified`. The same evidence backs `memory_verify` for the event a memory write cited, and the plan step of a rollback (`session-rollback.ts`, bounded to 4 s, fail-open).

### 3. The pending window

An event is anchored only after its hour closes plus the 5-minute ingest lag (`INGEST_LAG_MS`) and after the timer runs, so a fresh checkpoint is `pending`, truthfully. Verification calls an hour `pending` for 3 hours after it ended (`DEFAULT_ANCHOR_LAG_MS`, `VERIFY_PENDING_MS`) and `unanchored` after that if no `anchors` row exists. `unanchored` means "no root yet", not "lost".

### 4. Devnet resets and signer rotation are first-class cases

- **Reset.** `classifyChainEvidence` (`devnet-reset.ts`) separates `ok`, `reset-suspected` (a different genesis hash answered), `chain-unreachable` and `signature-missing`. The last three are read as **`unverified`, never `mismatch`**: only a chain read that succeeded and disagrees with the ledger's recomputation is a mismatch. The hourly job refuses a different genesis (`wrong-cluster`, nothing sent). `reanchor-plan-run.ts` is a read-only planner with no send path; **re-sending old hours has no implementation yet** (runbook, "Open point": the job skips hours that have a row, the cluster gate is a constant, and whether a second `insertAnchor` replaces or is ignored is UNVERIFIED), and the ADR does not invent one.
- **Rotation.** A key is accepted by the **block time** of the anchor transaction, never by "is it the current key" (`signer-set.ts`, `acceptsSigner`). The signer set is the bootstrap (`SUBSTRATE_ANCHOR_SIGNER_SET`, else `SOLANA_ANCHOR_PUBKEY` alone) plus valid `anchor.signer.rotate` notes written by an **operator** surface, with effective-time bounds of 24 h back and 30 days forward. A note that cannot be applied is ignored and reported in the verdict's `signer_set` field. Procedure: `docs/runbooks/anchor-signer-rotation.md`.
- **Endpoint.** `assertDevnetRpcUrl` refuses mainnet, testnet, non-http(s), userinfo and fragment URLs at configuration load and at `createRpc`. The genesis-hash gate is the authority on which cluster answered.

### 5. What the chain proves, and what it does not

| It proves | It does not prove |
| --- | --- |
| a signer in the signer set, at that block time, published this root and count for this hour | that any particular event was true or good |
| given the events, the root recomputes, so they existed by that hour | anything about an event if only the root survives: nothing is reconstructable from it |
| a checkpoint note was in the ledger by that hour (with the inclusion proof) | what the checkpoint's files held, or that a restore matched (the client reports that) |
| nothing, when `pending`, `unanchored` or `unverified` | tampering: those three are never verdicts of tampering |
| | that devnet will keep the memo. The chain is a witness that can disappear; the durable copy of every root is the ledger's `anchors` table and its archives |

### 6. Rejected

- **A custom Solana program.** More surface, a deploy, an upgrade authority, no gain for a root that a memo carries.
- **Memo v2** (a per-checkpoint or per-capsule digest, e.g. `substrate:v2:<kind>:<ref>:<digest>`). It requires a reader change, a second verification path, a new table (the `anchors` table is keyed and deduplicated by `period_start` and never ALTERed) and a size check against the Memo program limit that this repository has not made (UNVERIFIED; agent-realm records 566 bytes as its own constant). The indirect route above already gives a checkpoint a cryptographic path to a published root. Taking v2 remains a separate owner decision (CONTEXT, "Operator decisions requested", item 3) and is **not taken**.
- **Mainnet or testnet.** Out of scope by owner decision (`.planning/PROJECT.md` line 115, "Solana devnet, not testnet. Roots only, never event contents"; `.planning/REQUIREMENTS.md` SOTA-15 requires mainnet and testnet RPC URLs to be refused). The URL guard and genesis gate refuse them. "Eternal" is not a property devnet can deliver; moving to a durable cluster would be a new, explicit decision.

### 7. Cost and retention facts

- Fee: 5,000 lamports per signature (`.planning/uplift-7/SOLANA-FEASIBILITY.md`), about 0.0438 SOL a year at one anchor per hour, per that memo. The job refuses to send below `REQUIRED_BALANCE_LAMPORTS` = 895,880 (the rent-exempt minimum plus one fee) and reports `unfunded` (`anchor.ts`).
- Devnet airdrops and the web faucet are rate limited and often refuse; the public RPC's rate limits are UNVERIFIED (`SOLANA-FEASIBILITY.md`, "Not verified"). The key held 0 SOL and the timer was not installed when last read, 2026-10-15; both are 11 days old and **UNVERIFIED now**.
- Devnet publishes no retention window. Treat the chain as **evidence, not storage**; the roots live in the ledger.

## The genesis hash finding (verified, corrected in this milestone)

The anchor job, `checkpoint_verify` and the reset classifier all gate on the constant `DEVNET_GENESIS_HASH` in `packages/mcp-server/src/anchor.ts`. Since phase 28 it held `EtWTRABZaYq6iMfeYKouRu166VU2xqaEyCydFLPYGEC`, and so did the test fixtures. On **2026-10-26** the orchestrator ran a read-only JSON-RPC `getGenesisHash` against the public devnet endpoint (reported to this record's author; not re-run by it). It returned **`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`**, which is also the value `agent-realm`'s `src/audit/anchor.ts` carries. The old value was wrong, so the live job would have refused real devnet (`wrong-cluster`) and `checkpoint_verify` would have reported a healthy devnet as `reset-suspected`. Nothing caught it because the live proof (phase 28, steps L1 to L10; phase 41) was never run: the key was unfunded, the timer not installed and no anchor ever sent. The constant and every fixture were corrected in this milestone. The lesson is a gate: **a constant that decides every verdict must be compared with the live cluster before any funding or timer step.**

## What an operator must do for any live step (all HARD_STOP)

Nothing below is run by an agent, a CI job or this milestone's code. Each needs the operator's explicit approval.

1. **Preflight, read-only, before anything else.** Compare the live genesis hash with the constant:
   - `curl -sS -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$SOLANA_RPC_URL"` (the variable's value is not printed here and is not a secret on the public endpoint, but do not paste endpoints that carry credentials);
   - `grep -n 'DEVNET_GENESIS_HASH =' packages/mcp-server/src/anchor.ts`;
   - the two strings must be equal. **`anchor-run.ts --dry-run` is not a genesis check**: in `runAnchorJob` the dry-run branch returns before `checkPreconditions`, which holds the genesis gate, so a dry run would not have caught the wrong constant. Use it only to preview which hours would be anchored.
2. Generate and place the keypair; fund the key on devnet (the faucet is rate limited). Never paste or print the key file.
3. Set `SOLANA_*` in the service environment file, deploy the release, install and enable the anchor timer.
4. The first send (a proof anchor, gate G3 in `docs/agent-cards.md`), then `checkpoint_verify` on a checkpoint in that hour.
5. Any re-anchor after a reset, any signer rotation, and any move off devnet.

Runbooks: `docs/runbooks/{devnet-reset-and-reanchor,anchor-signer-rotation,anchor-chain-outage}.md`.

## Consequences

- The ledger remains the durable store; the chain adds a public witness for roots.
- Verification answers are honest about what they could not settle; an operator reading `unverified` for many hours at once is told to suspect a reset or an outage, not tampering.
- A per-checkpoint digest on chain is impossible without changing this decision.

## References

- `docs/runbooks/devnet-reset-and-reanchor.md`, `anchor-signer-rotation.md`, `anchor-chain-outage.md`, `docs/greptime-ledger.md`
- ADR 0003 (the limits of immutability), ADR 0004, ADR 0005
