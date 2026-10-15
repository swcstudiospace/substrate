# Solana ledger and SVM on Railway: feasibility memo (uplift-7)

Date: 2026-10-15. Basis: repository code read directly; the v1.3 audit; primary-source excerpts retrieved by search on 2026-10-15. Full pages were not fetched, so each excerpt is marked as such. Anything not checked is marked UNVERIFIED.

## Direct answer

No, not as a validator on Railway. An Agave validator needs at least 256 GB of RAM and separate accounts and ledger disks of 1 TB each, plus snapshots. Railway allows one volume per service, capped at 1 TB, so that layout does not fit. At list prices the RAM, CPU, and storage alone come to about $3.2k–3.4k per month before growth (estimate). The substrate does not need a validator. Its Solana role is an hourly anchor, which needs only a funded devnet keypair and a few thousand lamports per hour.

## Ledger role (open question q2, default applied)

Anchor the closed-hour Merkle roots of the substrate event ledger to Solana devnet as external evidence. The substrate's writes never wait on the anchor. The anchor is a separate hourly oneshot job, so the requirement that writes not wait on ledger confirmation is already met by design.

## Repository evidence

- Anchor funding threshold: `packages/mcp-server/src/anchor.ts:70`, `REQUIRED_BALANCE_LAMPORTS = 890_880 + 5_000`. The job refuses with `unfunded` below this.
- Memo transfer: `packages/ledger/src/solana.ts`, `transferMemoArgv`. It builds a 0-SOL self-transfer with a memo as argv. The keypair path is passed; the builder never opens the key.
- Default cluster: `packages/mcp-server/src/config.ts:705`, `SOLANA_RPC_URL` defaults to `https://api.devnet.solana.com`. See also `.env.example` lines 646–649.
- Scope rule: `.planning/PROJECT.md` says "Solana devnet, not testnet. Roots only, never event contents." `.planning/REQUIREMENTS.md` puts mainnet and testnet anchors out of scope.
- Timer: `infra/vps/substrate-anchor.timer` is hourly, `Persistent=true`, and runs `substrate-anchor.service`.
- Live state, read-only, 2026-10-15: the anchor key holds 0 SOL on devnet. `anchors` has 0 rows. `substrate-anchor.timer` is not installed on the host. The v1.3 audit marks ANCHOR-06 partial.

## Verdicts

| Option | Verdict | Basis |
| --- | --- | --- |
| Full validator node on Railway | NOT_FEASIBLE_NOW | Anza minimums: 256 GB RAM, 12 cores / 24 threads, accounts ≥1 TB, ledger ≥1 TB, snapshots ≥500 GB [S1]. The accounts database should be on its own drive [S2]. Railway: one volume per service, self-serve up to 1 TB, no replicas with volumes [S4]. Anza says running a live-cluster validator in Docker is "not recommended and generally not supported" [S1]. Splitting one validator across services is not a layout Anza documents (UNVERIFIED). |
| Single-node test validator service on Railway | UNVERIFIED; not recommended | Resource needs were not fetched. A self-run chain gives outsiders no independent evidence, so it cannot replace the devnet anchor. Use a local test validator for development. |
| Embedded SVM harness, in-process | UNVERIFIED | Not researched in this run. Relevant to tests and simulation only. |
| Managed RPC (provider endpoint) | FEASIBLE_WITH_CONDITIONS | The current default is already the public devnet RPC. Conditions: never send the keypair or substrate content. The memo carries period, root, and count only. Rate limits apply. |
| Defer: keep the GreptimeDB ledger, anchor later | FEASIBLE | The anchor code exists. Only operator steps remain (below). |

## Cost estimate, validator option (list prices; estimate)

- RAM: 256 GB × $10 per GB-month [S3] = $2,560 per month.
- CPU: 12 vCPU × $20 per vCPU-month [S3] = $240 per month. At 24 vCPU it is $480.
- Storage: 2.5 TB (1 TB accounts, 1 TB ledger, 500 GB snapshots) × $0.15 per GB-month [S3] = $375 per month. This ignores the layout problem above.
- Total: about $3.2k–3.4k per month before growth. Assumes steady usage at list prices.

## Devnet anchor funding (arithmetic from cited figures)

- Fee: 5,000 lamports per signature [S5]. One anchor is one signature with a zero transfer amount.
- Hourly cost: 24 × 365 × 5,000 = 43.8 million lamports, which is 0.0438 SOL per year.
- Minimum balance: 895,880 lamports (`anchor.ts:70`). A 1-SOL airdrop covers about 22 years at hourly cadence.
- Faucet limits: the Solana CLI docs say 5 SOL per request [S6]. A third-party guide says 2 SOL per request [S8]. faucet.solana.com allows 2 requests every 8 hours without login [S7]. Our own CLI airdrop attempts today were rate-limited four times.
- Fallbacks: the faucet web page, which needs an operator; or a transfer from a funded devnet wallet.

## Prerequisites, security, failure modes (operator-owned)

- Fund the anchor key. One SOL is ample.
- Install and enable `substrate-anchor.timer` with its drop-in (`infra/vps/README.md`). The doctor reports a missing anchor timer as drift.
- Run the ANCHOR-06 proof: anchor one closed hour, then `substrate verify <graph>`.
- Keep `/etc/substrate/anchor-keypair.json` root-only. It never goes in the repository, logs, or artifacts. Only the production unit uses it (`infra/vps/README.md`).
- Failure modes: an unfunded key refuses before any send. An unreadable RPC returns `rpc-unreadable`. A wrong cluster is refused by the genesis check. A memo that does not match its row raises an alarm, and `verify` exits non-zero. A missing timer shows as drift.

## Sources (accessed 2026-10-15; excerpts via search, full pages not fetched)

- [S1] https://docs.anza.xyz/operations/requirements (Agave validator requirements)
- [S2] https://docs.anza.xyz/operations/setup-a-validator (accounts database on a separate drive)
- [S3] https://docs.railway.com/pricing/plans (plan limits and usage rates)
- [S4] https://docs.railway.com/volumes/reference (volume rules)
- [S5] https://solana.com/docs/core/fees (base fee 5,000 lamports per signature)
- [S6] https://solana.com/docs/intro/installation/solana-cli-basics (devnet airdrop "5 SOL per request")
- [S7] https://faucet.solana.com/ (2 requests every 8 hours without login)
- [S8] https://www.metaplex.com/docs/solana/airdrop-sol-for-development (third-party guide, 2 SOL per request)

## Recommendation

- NO-GO for an SVM validator on Railway.
- CONDITIONAL_GO for the existing devnet anchor. Conditions: the operator steps above, and the ANCHOR-06 proof in an approved window.
- VALIDATION_REQUEST: confirm that devnet remains the target cluster and that the operator steps are approved.

## Not verified in this run

Test-validator resource needs. The embedded SVM harness. Railway behavior for split services. Full Anza and Railway pages, which were read as search excerpts only.
