# Solana ledger and SVM on Railway: feasibility memo (uplift-7)

Date: 2026-10-15. Basis: seven primary pages fetched over HTTP on 2026-10-15 (see Sources), the figures on them checked against this memo, and the repository code read directly. Anything not on a fetched page is marked UNVERIFIED. This pass created no Railway service, generated no networked key, and moved no funds.

## Direct answer

No validator on Railway in the layout Anza documents. Anza lists accounts (1 TB), ledger (1 TB), and snapshots (500 GB) on separate disks, with 256 GB of RAM or more (512 GB or more for all account indexes). Railway allows one volume per service: self-serve up to 1 TB on Pro, and beyond that only on Enterprise. So the documented layout cannot be built on Railway. At list prices it costs about $3.2k per month at its minimum and up to about $6.0k per month at the higher RAM and thread counts (estimate). The substrate does not need a validator. Its Solana role is an hourly anchor of closed-hour roots, which needs only a funded devnet key and about 0.044 SOL per year in fees.

## Ledger role (open question q2, default applied)

Anchor the closed-hour Merkle roots of the substrate event ledger to Solana devnet as external evidence. Substrate writes never wait on the anchor: it is a separate hourly oneshot job, so the non-blocking rule holds by design.

## Repository evidence

- Anchor funding threshold: `packages/mcp-server/src/anchor.ts:70`, `REQUIRED_BALANCE_LAMPORTS = 890_880 + 5_000` (895,880 lamports). The job refuses with `unfunded` below it.
- Memo transfer: `packages/ledger/src/solana.ts`, `transferMemoArgv`. A 0-SOL self-transfer with the memo as argv. The keypair path is passed; the builder never opens the key.
- Default cluster: `packages/mcp-server/src/config.ts:705`, `SOLANA_RPC_URL` defaults to `https://api.devnet.solana.com`.
- Scope: `.planning/PROJECT.md` says "Solana devnet, not testnet. Roots only, never event contents." `.planning/REQUIREMENTS.md` puts mainnet and testnet anchors out of scope.
- Timer: `infra/vps/substrate-anchor.timer` is hourly, `Persistent=true`, and runs `substrate-anchor.service`.
- Live state, read-only, 2026-10-15: the anchor key holds 0 SOL on devnet; `anchors` has 0 rows; `substrate-anchor.timer` is not installed; the v1.3 audit marks ANCHOR-06 partial.

## Sources (fetched 2026-10-15, HTTP 200)

- [S1] https://docs.anza.xyz/operations/requirements. Validator hardware: 12 cores / 24 threads or more; RAM 256 GB or more, and 512 GB or more for all account indexes; NVMe disks on each of accounts (1 TB), ledger (1 TB), and snapshots (500 GB). "Running an Agave validator for live clusters (including mainnet-beta) inside Docker is not recommended and generally not supported."
- [S2] https://docs.anza.xyz/operations/setup-a-validator. The airdrop subcommand does not work on mainnet.
- [S3] https://docs.railway.com/pricing/plans. RAM $10 per GB per month; CPU $20 per vCPU per month; volume storage $0.15 per GB per month. Pro: volume self-serve up to 1 TB. Enterprise: volume maximum 5 TB.
- [S4] https://docs.railway.com/volumes/reference. "Each service can only have a single volume." "Replicas cannot be used with volumes." Beyond 1 TB an Enterprise plan is required. "We prevent multiple deployments from being active and mounted to the same volume", so a volume-backed service does not run two deployments at once. A volume resize restarts the service.
- [S5] https://docs.railway.com/networking/private-networking. Services in a project reach each other at `SERVICE_NAME.railway.internal`.
- [S6] https://solana.com/docs/core/fees. Base fee 5,000 lamports per signature.
- [S7] https://solana.com/docs/intro/installation/solana-cli-basics. Devnet airdrops are limited to 5 SOL per request.
- [S8] https://faucet.solana.com/. The web faucet allows a maximum of 2 requests every 8 hours. The page lists `solana-test-validator` as a local validator with unlimited SOL and no rate limits.

## Verdicts

| Option | Verdict | Basis |
| --- | --- | --- |
| Full validator node on Railway | NOT_FEASIBLE_NOW | The documented layout needs three separate disks, 2.5 TB in total [S1]. Railway allows one volume per service [S4]: 1 TB self-serve on Pro, 5 TB maximum on Enterprise [S3, S4]. A single-volume layout is not in Anza's documentation (UNVERIFIED). Docker is not recommended [S1], so a container is not a fallback. |
| Single-node test validator service on Railway | UNVERIFIED; not recommended | Resource needs were not measured. A self-run chain gives outsiders no independent evidence, so it cannot replace the devnet anchor. Use a local test validator for development. |
| Embedded SVM harness, in-process | UNVERIFIED | Not researched in this pass. Relevant to tests and simulation only. |
| Managed RPC (provider endpoint) | FEASIBLE_WITH_CONDITIONS | The default is the public devnet RPC (repository config). Its rate limits are UNVERIFIED: no fetched page states them. Conditions: never send the keypair or substrate content. The memo carries period, root, and count only. |
| Defer: keep the GreptimeDB ledger, anchor later | FEASIBLE | The anchor code exists; only operator steps remain. |

## Cost estimate, validator option (list prices; estimate)

- RAM: 256 GB × $10 = $2,560 per month; 512 GB = $5,120 per month [S3].
- CPU: 12 vCPU × $20 = $240 per month; 24 vCPU = $480 per month [S3]. Anza's 12 cores / 24 threads [S1] sit between these two counts.
- Storage: 2.5 TB × $0.15 per GB-month = $375 per month [S3]: accounts 1 TB, ledger 1 TB, snapshots 500 GB.
- Total: $3,175 per month (256 GB, 12 vCPU) to $5,975 per month (512 GB, 24 vCPU). Network egress and growth are not included.

## Devnet anchor funding (inputs from fetched pages)

- Fee: 5,000 lamports per signature [S6]. One anchor is one signature with a zero transfer amount.
- Hourly cost: 24 × 365 × 5,000 = 43.8 million lamports, which is 0.0438 SOL per year.
- Minimum balance: 895,880 lamports (`anchor.ts:70`). One SOL covers about 22 years at hourly cadence.
- Faucets: the CLI allows 5 SOL per request [S7]; the web faucet allows 2 requests every 8 hours without login [S8]. Rate limits are per source and still refuse at times: every airdrop attempt on this host, the most recent included, was refused.
- Fallbacks: the web faucet (an operator step), or a transfer from a funded devnet wallet.

## Prerequisites, security, failure modes (operator-owned)

- Fund the anchor key. One SOL is ample.
- Install and enable `substrate-anchor.timer` with its drop-in (`infra/vps/README.md`). The doctor reports a missing anchor timer as drift.
- Run the ANCHOR-06 proof: anchor one closed hour, then `substrate verify <graph>`.
- Keep `/etc/substrate/anchor-keypair.json` root-only. It never goes in the repository, logs, or artifacts. Only the production unit uses it (`infra/vps/README.md`).
- Failure modes: an unfunded key refuses before any send. An unreadable RPC returns `rpc-unreadable`. A wrong cluster is refused by the genesis check. A memo that does not match its row raises an alarm, and `verify` exits non-zero. A missing timer shows as drift.

## Recommendation (one)

CONDITIONAL_GO: anchor the closed-hour roots to devnet. Conditions: (1) an operator funds the anchor key; (2) `substrate-anchor.timer` is installed and enabled per `infra/vps/README.md`; (3) the ANCHOR-06 proof runs on one closed hour in an approved window. The validator on Railway is NOT_FEASIBLE_NOW and is not recommended.

VALIDATION_REQUEST: confirm that devnet remains the target cluster and that the operator steps are approved.

## Not verified in this run

- Public devnet RPC rate limits (no fetched page states them).
- Embedded SVM harness (not researched).
- A single-volume layout for Anza's three-disk requirement on the Enterprise plan (not in Anza's documentation).
- Railway behaviour for split services across several services (not documented).
- Test-validator resource needs (not measured).

## Local-only spike (not run)

A local test validator would measure the test-validator resource needs and exercise the anchor round trip, at $0 with a throwaway keypair that CLEANUP deletes; the spec allows it. It cannot settle a Railway verdict, because the Railway verdict rests on fetched limits. It is not run; approve it if you want those two numbers measured.

## Follow-up phase breakdown (only if the anchor path is approved)

1. Operator: fund the devnet anchor key; install and enable `substrate-anchor.timer`.
2. Operator: run the ANCHOR-06 proof on one closed hour, then `substrate verify <graph>`.

No Railway validator phase is proposed.
