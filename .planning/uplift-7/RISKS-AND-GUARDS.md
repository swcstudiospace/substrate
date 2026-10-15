# Run risks and guards (uplift-7, node n6)

| ID | Risk | Guard | Owner | Status |
| --- | --- | --- | --- | --- |
| R1 | Production runs release `9231f43`, not `main`. Fixes on `main` are not live. | Operator deploys after the rehearsal gate passes on the release head. Gate receipts: 20/20 on `608926b`, `426ac1b`, `27d2235`, and `6ff8be5` (scratch); 16/16 on `5aa4494` when it was run. | Operator | Open |
| R2 | External effects: Railway provisioning, key generation, funding, pushes to production | None performed by this run. Repo PRs and devnet airdrop attempts were the only external actions, and you approved both. | You | Guarded |
| R3 | The anchor key holds 0 SOL, so the hourly anchor refuses (`unfunded`). | An operator funds the key from the web faucet or a funded wallet. The job refuses before any send (`anchor.ts:70`). | Operator | Open |
| R4 | Anchor private key exposure | The key stays root-only at `/etc/substrate/anchor-keypair.json`. It is not printed, not committed, and not sent to any RPC. Only the production unit reads it. | Operator | Guarded |
| R5 | The Cursor credential needs rotation (disclosed) | The operator rotates it. Nothing in this run used it. | Operator | Open |
| R6 | Agent-scoped memory readable by other agents through search or recall | Fixed in PR #73. One rule (`visibleToSurface`) applies at the index query, at the recall hit filter, and before recall dedupe. Tests fail on the old code. | Closed | Closed |
| R7 | Replies cached before the upgrade could still show other agents' rows for up to 600 s | Cache keys moved to `merged-v2`, and a rule marker went on the paged key (PR #73). | Closed | Closed |
| R8 | Substrate content treated as instructions | The panel renders counts and names only, with control and bidirectional characters stripped. No substrate text reached any prompt in this run. | Closed | Guarded |
| R9 | The root disk is at 96% used | Operator review. The ledger archive refuses low-disk targets (`SUBSTRATE_DEPLOY_MIN_FREE_GB`). Nothing was deleted without confirmation. | Operator | Open |
| R10 | The Omp extension is a symlink, so a running Omp loads the new code on its next start | Remove the symlink to disable it. The extension is read-only and fail-open. | You | Guarded |
| R11 | Greptile findings on each PR | Each finding was fixed in code. Two threads were resolved after their fixes: PR #73 (recall dedupe, covered by a test that fails on the old code) and PR #74 (waiver count). | Me | Closed |
| R12 | PG-gated tests skipped locally | The suites ran against a throwaway Postgres 16 container on loopback, which was removed afterwards. CI runs them too. | Me | Closed |
| R13 | The contract-fix subagent wrote into the main checkout instead of its worktree | The patch was moved, the checkout restored, and the fix re-verified in the worktree. | Me | Closed |
| R14 | The live write-to-footer latency is unproven | An operator makes one substrate write through Omp and checks the footer within 30 s plus the 3 s probe. | Operator | Open |
| R15 | Pre-existing worktrees under `/tmp/pr-merges` and `/tmp/agent-substrate-p15-before-oct08` | Not from this run. Left untouched. | You | Open |
| R16 | The anchor fee assumption | Checked against the Solana fees page: 5,000 lamports per signature. The hourly cost is 0.0438 SOL per year. | Me | Closed |
