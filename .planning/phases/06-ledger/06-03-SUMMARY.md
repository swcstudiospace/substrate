---
phase: 06-ledger
plan: 03
subsystem: ledger-identity
tags: [wave-1, devnet, keypair, substrate-env, airdrop, owner-skip, d-04, d-05, d-06, t-06-03-01, t-06-03-02, t-06-03-03]

requires:
  - phase: 06-ledger
    provides: 06-01 baseline (ledger-key-present=false, solana-env-lines=0, solana-id-json-stat=1789532431 235) and the RESTORE.md index
provides:
  - /etc/substrate/ledger-devnet.json (host, 600 root). It is a dedicated devnet key with pubkey Fku22yAXxRWc3o5Yp35vaXgrbLvH2WAPPiThNPKPjivq. It is unfunded and unused.
  - /etc/substrate/substrate.env gained SOLANA_RPC_URL, SOLANA_ANCHOR_KEYPAIR and SOLANA_ANCHOR_PUBKEY. The lines are present but unused.
  - /var/lib/substrate/phase6-baseline/06-03/20260927T064241Z/substrate.env (0600 snapshot) and RESTORE.d/06-03.md with routes (a) to (e)
  - 06-03-SPIKE.md. It records the Task 1 key, env and airdrop evidence, the funding gaps and the owner-skip decision. There is no memo spike evidence.
affects: [06-06, 06-07, 06-08]

actuals:
  tasks: 2           # Task 1 done; Task 2 skipped by owner decision
  commits: 4         # 844ab55, 8dc426b, f69cdec + this SUMMARY

key-files:
  created:
    - .planning/phases/06-ledger/06-03-SPIKE.md
    - /etc/substrate/ledger-devnet.json (host, 600 root)
    - /var/lib/substrate/phase6-baseline/RESTORE.d/06-03.md (host, 600 root)
    - /var/lib/substrate/phase6-baseline/06-03/20260927T064241Z/substrate.env (host, 600 root)
  modified:
    - /etc/substrate/substrate.env (host; three SOLANA_ lines appended, still 600 root)

key-decisions:
  - "Owner, at the Task 2 funding checkpoint (verbatim): \"Skip Phase 6 anchoring\". No devnet memo was sent (spike_result=skipped-owner)."
  - "The key and the three env lines are kept in place, unused. Removal is documented in RESTORE.d/06-03.md routes (a) and (c)."

requirements-completed: []
---

# 06-03 Summary: devnet anchor identity (created, never funded; anchoring skipped by the owner)

## Outcome

Task 1 completed. Task 2, the devnet memo spike, did not run. The owner stopped Phase 6 anchoring at the
funding checkpoint with this answer (verbatim): **"Skip Phase 6 anchoring"**.

**As a result, Phase 6 anchoring will not run:**
- 06-06 will not run. It covers the anchor job and the tracer anchors.
- 06-08 will not run. It covers the substrate-ledger-anchor timer.
- The on-chain signature checks in 06-07 will not run. These checks are the signer, memo-program and memo verification of anchors against devnet.

The facts 06-06 was going to take from this spike stay unobserved: `spike_amount`,
`spike_output_json_keys` and `spike_memo_program`.

## Task 1: key, env lines, airdrop (committed 844ab55)

- The snapshot was taken and RESTORE.d/06-03.md was written before any live edit. The snapshot sha256 is ace7bfef…2a06 and the file is 0600.
- `solana-keygen new --no-bip39-passphrase --silent -o /etc/substrate/ledger-devnet.json` was run with the key absent beforehand. It printed one line, and the key file is 600 root. No key contents or seed phrase were ever printed.
- substrate.env gained exactly three SOLANA_ lines, each added behind a per-name guard. The file is still 600 root, and diff against the snapshot shows only those three lines.
- The Solana CLI config RPC is still http://127.0.0.1:8899. The id.json stat is unchanged (1789532431 235). `solana config set` was never run.
- The plan's Task 1 `<automated>` verify ran verbatim and exited 0.
- The RPC airdrop was attempted 3 times, 20 s apart. All 3 were refused ("airdrop request failed. This can happen when the rate limit is reached."). Balance: 0 lamports.

## Funding attempts and deviations

1. Checkpoint 1 (precondition unmet, blocking-human) asked the owner to fund the pubkey.
2. Owner direction (verbatim): "There's a method for seeding your first amounts needed for free, can you
   search the web for it". The agent tried the proof-of-work devnet faucet `devnet-pow`. It never built:
   - with `--locked`, the old wasm-bindgen pin fails on the current Rust toolchain;
   - the unlocked build ran for more than 40 min and was stopped.

   No binary was installed and no mining transaction was sent. RESTORE route (e), `cargo uninstall devnet-pow`, has nothing to undo. This was recorded as `pow_faucet=build-failed` (committed 8dc426b).
3. A second RPC airdrop (0.5 and 0.2 SOL, about 09:40Z) was refused (`airdrop_retry=refused`).
4. The owner answered "funded" twice, but the key still showed 0 lamports and no devnet transaction.
   The owner then answered "Skip Phase 6 anchoring". The balance was re-checked just before closing: 0 lamports.
   The spike_sig count is 0, and no memo was sent (committed f69cdec).

## Live state left behind

| Item | State | Undo |
|---|---|---|
| /etc/substrate/ledger-devnet.json | present, 600 root, 0 lamports, unused | RESTORE.d/06-03.md (c) `sudo rm` (no timer exists, since 06-08 will not run) |
| substrate.env SOLANA_* (3 lines) | present, unused; substrate-mcp not restarted by 06-03 | RESTORE.d/06-03.md (a) targeted sed, or (b) full restore from the snapshot |
| devnet transactions | none sent | — |
| devnet-pow binary | never installed | — |

## Verification

- Task 1 automated verify: exit 0.
- Task 2 verify: not applicable, because the spike was skipped by the owner and no spike_* read-back keys exist. `owner_funding=owner-skip` and
  `spike_result=skipped-owner` are recorded instead of the plan's `not_needed|owner`.
- Token-shape and keypair-array scans of 06-03-SPIKE.md found 0 matches.

## Deviations

- The PoW-faucet attempt was owner-directed and outside the plan. It failed and made no host change.
- Task 2 was not executed, by owner decision, and the plan's Task 2 acceptance criteria are unmet.
- The owner_funding value `owner-skip` falls outside the plan's enum.

Refs SPE-3576, SPE-3970.
