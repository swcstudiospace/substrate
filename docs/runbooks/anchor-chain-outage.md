# Runbook — the anchor chain is unreachable: what degrades, what to check, how it recovers

| | |
| --- | --- |
| Question | Solana devnet (or the endpoint `SOLANA_RPC_URL` names) is not answering. What stops, what keeps working, and what do I do? |
| Trigger | `anchor.failed` warnings with reason `rpc-unreadable`; the hourly job exits 1; `checkpoint_verify` answers `unverified` with *the genesis hash could not be read* or *the RPC did not answer*; `substrate verify` is not ok |
| Who | An operator. **Steps marked OPERATOR ONLY send a transaction or touch production units: nothing here runs automatically, no agent runs it, and no CI job does.** Everything else only reads. |
| Scope | The hourly anchor job, the verify surfaces and local rollback. For a cluster that **answers with a different genesis hash** (a reset), use `docs/runbooks/devnet-reset-and-reanchor.md` instead. |
| Blast radius | None to the ledger, the index or memory. Anchoring is delayed; verification is unverified, not failed. |

## The stance

- **Devnet is evidence of a root, not storage.** The memo carries a period, a Merkle root and an event count. It never carries event content, so an outage withholds a witness and nothing else.
- **Devnet may reset and publishes no retention window.** It can also be down, rate limited or slow. The repo has not verified the public endpoint's rate limits.
- **Mainnet and testnet are out of scope.** A `SOLANA_RPC_URL` naming either is refused before any request, which is a configuration problem, not an outage (below).

## What degrades, and what does not

| Surface | During the outage |
| --- | --- |
| The hourly anchor job (`packages/mcp-server/src/anchor.ts`) | Cannot read the cluster's genesis hash or its recent signatures, so it **sends nothing**. It stops before the first send with `anchor.failed` reason `rpc-unreadable`, exits 1, and the timer retries on the next tick (`Type=oneshot`, no `Restart=`). Nothing is lost: an hour with no row is picked up later. |
| The ledger (`agent_events`, `event_ingest`, `anchors`) | **Unaffected.** Events keep being written and hash-chained; the job only reads the ledger. Rows already in `anchors` stay. |
| `checkpoint_verify`, `memory_verify`, the anchor check inside rollback plans | Answer `unverified`, **never `mismatch`**: *the cluster's genesis hash could not be read* or *the signature could not be looked up (the RPC did not answer), which is not a verdict about the anchor* (`classifyChainEvidence`, `packages/ledger/src/devnet-reset.ts`; `verifyCheckpoint`, `packages/mcp-server/src/checkpoint-verify.ts`). Only a chain read that succeeded and disagrees with the ledger is a `mismatch`. |
| Recent hours | `pending` while the hour is not closed (it closes 5 minutes after it ends) and for up to three hours after it ended. After that, an hour with **no anchors row** reads `unanchored`: *no row yet*, not *lost*. It turns `anchored` after the job catches up. |
| `substrate verify <graph>` and `substrate evidence` | Fail closed: an unreadable cluster never reads as anchored. `evidence` exits 1 when any hour is `unverified`. Read the `chain` field for the hash-chain result, which does not depend on devnet. |
| Local rollback (`substrate session rollback`) | **Still works.** See below. |
| Memory, recall, the index, Hindsight | Unaffected. No part of them reads the chain on the hot path. |

### Rollback with the chain down

`packages/cli/src/session/rollback.ts` and `packages/mcp-server/src/session-rollback.ts`:

- **Server up, devnet down.** The plan's anchor check is bounded (`DEFAULT_ANCHOR_TIMEOUT_MS`, 4 s) and fails open: the plan answers without it, and the client reports the checkpoint's anchor as `unverified` ("the server returned no anchor status"). The rollback proceeds. It refuses on an anchor `mismatch` only (and on drift), never on `unverified`. [INFERENCE for the exact status text: the code path leaves `anchor: null`, which the client reports as `unverified`.]
- **Server unreachable, or `--offline`.** The rollback goes on from the local checkpoint, reports the checkpoint as **UNANCHORED** (`mode: local only`) and queues its ledger commit; the exit is 4 until `substrate session sync` delivers it. Files are restored either way.
- Either way a `pre-restore` checkpoint of the current state is taken first. `substrate session rollback <ckpt|seq|previous> --dry-run` shows what would change and writes nothing.

## What to check (read-only)

1. **The job and its reason.**

   ```sh
   systemctl status substrate-anchor.timer substrate-anchor.service --no-pager
   journalctl -u substrate-anchor.service --since "-6h" --no-pager | grep '\[anchor\]'
   ```

   The reasons are a closed set (`anchor.ts`): `digest-failed`, `root-mismatch`, `unfunded`, `wrong-cluster`, `signer-mismatch`, `rpc-unreadable`, `send-failed`, `store-failed`. An outage is `rpc-unreadable` (or `send-failed` with a read-back error). **`wrong-cluster` is not an outage: the cluster answered with a different genesis hash. Go to the reset runbook.** `unfunded` and `signer-mismatch` are about the key, not the chain.
2. **Is it a configuration problem?** A `SOLANA_RPC_URL` the devnet guard refuses (a mainnet or testnet host, userinfo, a fragment, a non-http scheme) makes the job and the verify read-back refuse **before any request**. The server logs *anchoring and the verify read-back are refused until SOLANA_RPC_URL is fixed* at boot, and the job exits 2. Fix the value; there is nothing to wait for.
3. **Does the endpoint answer?** Without printing its URL:

   ```sh
   ( set -a; . /etc/substrate/substrate.env; set +a
     curl -sS -m 15 -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$SOLANA_RPC_URL" )
   ```

   A JSON answer with a `result` is up (compare it with `DEVNET_GENESIS_HASH` in `anchor.ts`: a different hash is a reset). A timeout, a connection error, an HTTP 429 or 5xx is an outage or rate limiting. Try a second endpoint (`<OTHER_DEVNET_RPC_URL>`) before concluding the cluster is down: a single bad provider is the common case.
4. **How far behind is anchoring?** `substrate ledger coverage --json` reports the anchor's coverage and exits 2 when more eligible hours are uncovered than `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` allows (`docs/greptime-ledger.md`, "Coverage and archive").
5. **The warnings themselves.** `events_query { "kind": "warning", "surface": "substrate", "include_payload": true }` lists the `anchor.failed` events with `payload.reason` and the `anchor:<hour>` session.
6. **Ask the read-only plan.** `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/reanchor-plan-run.ts --max-hours 24` exits **3** while the ledger or the endpoint is unreachable and claims no plan; it sends nothing. If it answers, it tells you whether the genesis matches.

## Recovery

The timer is already installed; the next tick retries. Typically nothing needs doing once the endpoint answers.

1. **Confirm the endpoint is back** (check 3), then **see the backlog**: run `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/anchor-run.ts --dry-run` from `/opt/agent-substrate/current`. It reads the ledger and the anchors window, prints `would anchor <hour> (N events)` for each candidate and **sends and writes nothing**. It does not contact the chain, so it shows the backlog, not that the endpoint answers. (It exits 2 if `SOLANA_ANCHOR_KEYPAIR` and `SOLANA_ANCHOR_PUBKEY` are unset; it never reads the key.)
2. **Catch-up rate.** Each run anchors at most 24 non-empty hours, within a 7-day lookback (`MAX_HOURS_PER_RUN`, `ANCHOR_LOOKBACK_MS`). The timer fires hourly, so a day's backlog clears in one run and a full week's (up to 168 hours) in about seven ticks.
3. **OPERATOR ONLY: start a run now.** `systemctl start substrate-anchor.service` sends transactions (self-transfers of 0 SOL carrying a memo) from the production key. It re-checks the chain for each hour immediately before sending, so two triggers cannot double-anchor. Wait for the timer instead unless the backlog matters.
4. **OPERATOR ONLY: hours older than seven days.** The job never looks that far back. After a long outage, anchor one hour at a time with `anchor-run.ts --period <HOUR_ISO>` (a whole closed UTC hour; each run sends). An hour that already has a row is left alone.
5. **Verify.** `checkpoint_verify` for a checkpoint in a recovered hour answers `anchored`; `pending` clears within about three hours of the anchor landing.
6. **If `anchor.failed` says `unfunded`.** That is the key, not the outage: an outage does not spend lamports, because the job fails before it sends. **OPERATOR ONLY**: fund the key (it must hold at least 895 880 lamports: the rent-exempt minimum plus one fee). The devnet faucet is rate limited and often refuses.

## Abort and rollback

Nothing here changes state except steps 3, 4 and 6 of Recovery. To stop anchoring on purpose: **OPERATOR ONLY** `systemctl stop substrate-anchor.timer`. It touches a production unit, and verification then reads `pending`, then `unanchored`, until the timer is started again. A transaction already sent cannot be taken back.

## What this does not prove

- `unverified` during an outage is not evidence the anchors are fine. It is a statement that the chain could not be asked.
- `anchored` after recovery says a signer in the signer set wrote the root on devnet. It is not storage and is not durable: see the reset runbook.
