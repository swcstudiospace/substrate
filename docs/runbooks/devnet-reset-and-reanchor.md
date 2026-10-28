# Runbook — a Solana devnet reset: recognise it, prove it is not tampering, plan the re-anchor

| | |
| --- | --- |
| Question | Anchors that verified yesterday now read `unverified`. Was devnet reset, or did something change the ledger, and what would it take to witness the old hours on the new cluster? |
| Trigger | `checkpoint_verify` (or `memory_verify`, `substrate verify`) answers `unverified` with a reason naming a different genesis hash or a missing signature, for many hours at once |
| Who | An operator. **Every step marked OPERATOR ONLY sends a transaction, funds a key, changes a release or touches production. Nothing here runs automatically, no agent runs it, and no CI job does.** |
| Scope | The hourly Merkle roots anchored on Solana **devnet**. Mainnet and testnet are out of scope: the URL guard and the genesis-hash gate refuse them. |
| Blast radius | Steps 1 to 4 only read (the ledger's `anchors` table and two JSON-RPC methods). Step 5 and the re-anchor itself are the only steps that can change anything. |

## The stance (read this first)

- **Devnet is evidence of a root, not storage.** The memo carries `substrate:v1:<period_start>:<root>:<count>` and nothing else: a period, a Merkle root over event hashes and an event count. It holds no event, no memory body, no capsule. Given the ledger's events the root proves they existed by that hour; given the root alone nothing can be reconstructed (`docs/adr/0003-memory-nexus-design.md`).
- **Devnet may reset and publishes no retention window.** It is a test cluster with no durability promise. The repo states nothing about its retention (`docs/runbooks/anchor-chain-outage.md` covers the case where it is merely unreachable). A reset loses the witness, not the roots: the roots live in the ledger's `anchors` table (`docs/greptime-ledger.md`).
- **Mainnet and testnet are out of scope.** `SOLANA_RPC_URL` naming either is refused before any request (`assertDevnetRpcUrl`, `packages/ledger/src/rpc.ts`), and the genesis-hash gate (`DEVNET_GENESIS_HASH`, `packages/mcp-server/src/anchor.ts`) is the authority on which cluster answered.

## What a reset looks like

A reset replaces the cluster: new genesis hash, no accounts, no history. From the outside:

- `checkpoint_verify` answers `unverified` (never `mismatch`). The first reason reads: *the cluster reports genesis `<new hash>`, not the expected `<DEVNET_GENESIS_HASH>`: the devnet was probably reset, which says nothing about the anchored root* (`classifyChainEvidence`, `packages/ledger/src/devnet-reset.ts`, verdict `reset-suspected`). The verdict does not depend on what the new cluster says about the signature: a different genesis is a different cluster.
- If an endpoint still reports the **old** genesis but the signature is gone, the reason is *the signature is not found N s after anchoring on the expected cluster* (`signature-missing`). That is **not** a reset. It is history pruning, a different endpoint, or tampering with the `anchors` row, and `planReanchor` refuses to plan it (step 3).
- The anchor key holds 0 lamports on the new cluster: a reset wipes accounts.
- **Anchoring stops.** The hourly job checks the cluster's genesis hash before its first send and refuses a different one: `anchor.failed` with reason `wrong-cluster`, exit 1, nothing sent (`checkPreconditions`, `packages/mcp-server/src/anchor.ts`). Hours since the reset stay unanchored (verify answers `pending`, then `unanchored` after three hours) until the constant is updated, which is a release, not a setting.
- Nothing in the ledger changes: events, hash chains, the `anchors` rows and every local rollback are unaffected.

## What the evidence says, and does not say

- `unverified` with a reset reason says: *the chain could not settle this*. It says nothing about the root. Only a chain read that succeeded and disagreed with the recomputed root is `mismatch`.
- A reset **proves nothing about tampering in either direction**. The roots in `anchors` are the ledger's own records; until they are witnessed again they are unwitnessed, not wrong.
- The plan (step 3) is a **dry run over stored rows**. It cannot tell you a re-anchor will be accepted, and it cannot send.

## 1. Confirm the symptom (read-only)

```sh
# MCP tool, read-only: ckpt_id of any checkpoint in an affected hour
checkpoint_verify { "ckpt_id": "<CKPT_ID>", "session_id": "<SESSION_ID>" }
```

Expect `status: "unverified"` and `reasons[0]` naming a different genesis hash. Do the same for a checkpoint from a **recent, already anchored** hour and from an **older** one. A reset hits every hour anchored before it, uniformly.

## 2. Confirm it is a reset and not tampering (read-only)

Do all of these. One agreeing check is a hint, not a conclusion.

1. **The genesis hash differs, and two independent endpoints agree.** From the host, using the env file's endpoint without printing it:

   ```sh
   ( set -a; . /etc/substrate/substrate.env; set +a
     curl -sS -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$SOLANA_RPC_URL" )
   ```

   Repeat against a second devnet endpoint from a different provider (`<OTHER_DEVNET_RPC_URL>`; if it carries an API key, keep it out of your shell history and transcript). Both must return the same hash, and it must differ from `DEVNET_GENESIS_HASH`. One endpoint answering differently is a bad endpoint, not a reset. If `SOLANA_RPC_URL` is unset the services use the public devnet default.
2. **The key balance is gone.** Inside the same kind of subshell (`set -a; . /etc/substrate/substrate.env; set +a`), run `"${SOLANA_CLI:-<SOLANA_CLI_PATH>}" balance <ANCHOR_PUBKEY> --url "$SOLANA_RPC_URL"`. It prints 0 SOL after a reset; a cluster that has not been reset still holds the key's balance. `<ANCHOR_PUBKEY>` is the public key (`SOLANA_ANCHOR_PUBKEY`), never the keypair file.
3. **The ledger agrees with itself.** In step 1's `reasons`, there must be **no** entry beginning `ledger-side note:`. Those entries are the verifier's own findings from the ledger alone (the recomputed root differs from the anchors row, the row disagrees with its own memo, the hour's leaves do not match the stored count). They are listed even when the chain cannot be read. A `ledger-side note:` entry means the ledger changed after anchoring: **stop and treat it as an integrity incident**, not a reset.
4. **The hash chain verifies.** `events_verify { "graph_id": "<GRAPH_ID>" }` (or `substrate verify <GRAPH_ID>`) reports the per-session chain intact. (`substrate verify` also reports hours as `unverified` while the cluster is wiped; read its `chain` field, not its overall `ok`.)
5. **An outside source says devnet was reset.** Check the Solana validator announcements or status channel yourself. This repo cannot, and the runbook does not name a URL.
6. **The plan classifies the hours as a reset** (step 3): `reset-suspected` for every old hour, and zero `signature-missing-without-reset`.

If (1) fails (the genesis hash equals `DEVNET_GENESIS_HASH`) it is **not a reset**, whatever else looks like one. Go to `docs/runbooks/anchor-chain-outage.md` for an unreachable cluster, and treat a missing signature on the expected cluster as an incident.

## 3. Produce and SAVE the plan (read-only)

`packages/mcp-server/src/reanchor-plan-run.ts` reads the `anchors` rows of a window, asks the configured endpoint for its genesis hash and for each row's signature (`finalized`, then `confirmed`), classifies each hour with `classifyChainEvidence` and prints the plan from `planReanchor` (`packages/mcp-server/src/reanchor-plan.ts`). It sends nothing, signs nothing and never reads a keypair; `reanchor-plan-run.test.ts` pins its import list.

```sh
umask 077; mkdir -p ~/reanchor
cd /opt/agent-substrate/current
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/reanchor-plan-run.ts \
  --since <FIRST_AFFECTED_HOUR_ISO> --until <HOUR_AFTER_THE_LAST_ISO> --json \
  > ~/reanchor/plan-"$(date -u +%Y%m%dT%H%M%SZ)".json; echo "exit $?"
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/reanchor-plan-run.ts --max-hours 48   # the short summary
```

| Flag | Meaning |
| --- | --- |
| `--since ISO` | first hour, a whole UTC hour with a zone (`2026-10-19T00:00:00Z`) |
| `--until ISO` | end of the window, exclusive, a whole UTC hour not later than the current hour |
| `--max-hours N` | hard cap on the window, 1 to 744, default 168 (seven days); a wider window is refused (exit 2) |
| `--json` | the whole report as JSON (default: a short summary) |

Strict grammar: each flag at most once, a value flag takes its value as the next argument (`--since X`, never `--since=X`), no positional argument. Without `--until` the window ends at the start of the current hour; without `--since` it starts `--max-hours` before its end. For a longer history run several windows of at most 744 hours.

**Exit codes**

| Code | Meaning | Do |
| --- | --- | --- |
| 0 | nothing to re-anchor | read the summary anyway: hours listed under `ATTENTION` are skipped and need a human |
| 1 | a plan exists (at least one hour is a reset-suspected hour with its signature `not-found` on the observed cluster) | go on to step 4 |
| 2 | usage or configuration: a bad flag, `GREPTIME_URL` unset, or `SOLANA_RPC_URL` refused (mainnet or testnet host, userinfo, fragment, non-http scheme) | fix the flag or env; **nothing was requested** |
| 3 | the ledger or the chain could not be read, so no plan can be claimed (stdout is empty, stderr says which read) | wait, re-run; see `anchor-chain-outage.md` |

**Environment, names only (none is new):** `GREPTIME_URL`, `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB` for the ledger, and `SOLANA_RPC_URL` for the endpoint. It reads no `SOLANA_ANCHOR_*` variable. The output never prints a URL or a token, but a genesis hash and signatures (public chain data) appear.

> **Save the plan now, and run it before the genesis constant changes.** `planReanchor` documents that the plan must be produced with the OLD expected genesis still configured, so that the wiped cluster reads as a *different* cluster. After the constant is moved to the new genesis the same signatures read as `not-found` on the **expected** cluster, which the plan files under `signature-missing-without-reset` ("investigate, do not re-anchor"). The saved JSON is then the record of what was planned.

## 4. Read the plan

The JSON (`schema: 1`, `dry_run: true`) has `window`, `chain` (`expected_genesis`, `observed_genesis`, `genesis_matches`, `signature_lookups`, `rows_not_looked_up`), `summary` and `plan`. `plan.hours[]` is what would be re-anchored, ascending by hour:

| Field | Meaning |
| --- | --- |
| `period_start` | the hour |
| `memo` | the memo v1 text a new transaction would carry: **the stored row's memo, byte for byte** (same period, same root, same count). It is never recomputed |
| `root`, `event_count` | the stored row's, unchanged |
| `previous_tx_sig`, `previous_signer` | the signature that no longer exists on the observed cluster, and who signed it |
| `target_genesis` | the genesis hash of the cluster the re-anchor would be written to |
| `why` | the classifier's reason, verbatim |

`plan.skipped[]` lists every hour that is not planned, with a code:

| Code | Meaning | Do |
| --- | --- | --- |
| `ok` | the signature is `finalized` or `confirmed` on the expected cluster | nothing |
| `present-on-observed-cluster` | the signature already exists on the observed cluster | nothing |
| `chain-unreachable` | the endpoint did not answer for this hour, or the anchor is inside the 120 s grace window | re-run later |
| `signature-missing-without-reset` | the cluster is the expected one and the signature is missing: pruning or tampering | **investigate; never re-anchor** |
| `invalid-row` | the row's root, count, memo or signature is not sound (the memo must be exactly `formatMemo` of its own period, root and count) | investigate the row; a row is never "repaired" |
| `duplicate-row` | a second row names the hour | resolve the duplicate first |
| `no-evidence` | no chain read was possible for this hour (for example the signature is not base58) | investigate the row |

The `notes` array repeats the fixed reminders: a dry run; the memo is the stored one; the new transaction must be signed by a key in the signer set **at its own block time**, which will be later than the hour it anchors; record each real re-anchor with an `anchor.reanchor` event.

## 5. The re-anchor: what the hourly job cannot do, and the entry that does

Steps 1 to 4 and funding the key need no code beyond what is already here. Re-sending the old hours is done by `packages/mcp-server/src/reanchor-run.ts` (its logic is `reanchor.ts`), an **operator-run** entry point: nothing starts it, no timer, no CI job, no agent. The send itself is an operator step.

### Why the hourly job cannot do it

What `packages/mcp-server/src/anchor.ts` does today (symbols):

1. **The sweep skips any hour that has an `anchors` row.** It reads the window `[max(coverage start, now − 7 days), now)` with `anchorsBetween`, marks every row's `period_start` as anchored and skips those hours. Rows older than seven days are not read at all.
2. **`--period <hour>` on an anchored hour takes the adopt path** (`checkAdopt`). It lists the key's 100 most recent signatures on the cluster and looks for a memo for that hour. On a wiped cluster there is none, so the job prints `already anchored` and **sends nothing**.
3. **Before any send the job re-reads the hour's row** with `anchorForPeriod` and stops if one exists.
4. **The cluster gate is a constant.** `DEVNET_GENESIS_HASH` is compared in `checkPreconditions` and in the adoption path, so after a reset the job refuses even a fresh hour (`wrong-cluster`) until the constant moves (step b).
5. **A row is written at most once.** `GreptimeClient.insertAnchor` documents that the table deduplicates by `period_start`. **Whether a second insert replaces the row or is ignored is UNVERIFIED**: no code or test in this repo exercises it against a live store. For that reason **the re-anchor never writes the `anchors` table**: the row keeps naming the old signature, and the verifier follows the `anchor.reanchor` note (below) to the new one.

### What the re-anchor entry does

`reanchor-run.ts --plan FILE` takes the plan saved in step 3 (`schema: 1`, `dry_run: true`).

- **The default is a DRY RUN.** It prints `would re-anchor <hour>` per planned hour and stops. It opens no configuration, no ledger, no endpoint and no runner, so it needs no environment and can send nothing.
- **`--execute` is explicit and OPERATOR ONLY.** It needs `--confirm-genesis <hash>`: the genesis hash of the cluster you mean to write to. `--max-hours N` (default 1, at most 24) caps the transactions sent per run. `--surface NAME` names the operator surface the note is written as; it is needed when more than one operator surface exists (a single one is used by default). A flag without `--execute` changes nothing: it is still a dry run.
- **Environment, names only (none is new):** `GREPTIME_URL` (and `GREPTIME_USER`, `GREPTIME_PASSWORD`, `GREPTIME_DB`), `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, `SOLANA_CLI`. The keypair is only ever a path on the Solana CLI's argv: do not paste it or print the file.
- **It touches only the ledger, never the running server's state.** The two ledger operations it needs (read an hour's digest and the stored notes, write the note) go through a `Substrate` built with the retain outbox in memory only, no Postgres index and no event bus: it never opens, reads or rewrites the file `SUBSTRATE_RETAIN_OUTBOX_PATH` names (the live server's queue), and it starts no drain timer. Having that variable in the env file is therefore safe.
- **An empty plan is not an error.** When the planner found no anchors row in its window it read no chain, so the saved JSON has `chain.observed_genesis: null` and `plan.hours: []`. `reanchor-run.ts` accepts that (a null genesis is accepted for an empty plan only), prints `the plan has no hour to re-anchor` and exits 0 without any request. A plan with hours still needs its observed genesis.
- **One run at a time.** `--execute` takes a lock file, `substrate-reanchor-<first 12 characters of the signer's public key>.lock`, in `SUBSTRATE_STATE_DIR` when that is set and absolute, else in the OS temp directory (created exclusively, holding the pid and start time), and holds it across discovery, send and recording; it is released on every way out. The lock belongs to the signer, not to the plan file: a copy of the plan in another directory is the same lock. A second `--execute` that finds it refuses with `reanchor-locked`, before it lists or sends anything. The next run breaks a lock **only when its pid is no longer alive on this host** (a lock file that cannot be read is broken only when it is also older than 30 minutes). A live pid is never broken, however old the lock: a degraded `--max-hours 24` run (a 120 s send timeout, read-back retries) can take more than half an hour. If a run was killed, the next run clears its lock by itself; if the OS has handed the dead run's pid to another process, the refusal names the file: confirm no re-anchor run is alive, then remove it.

Gates. Everything read-only, **for every hour of the plan**, finishes **before the first send** (a refusal prints `[reanchor] REFUSED <code>: <reason>` on stderr, exits 1 and sends nothing further). What can still stop a run after a send is only that send's own failure (`send-failed`) and its note (`store-failed`). After `store-failed`, re-run at once: a sent and recorded hour is adopted, never sent again. A `send-failed` that names a signature (its read-back failed or did not match the memo) says to re-run to adopt it. A `send-failed` where the send **exited non-zero, was killed at its timeout (exit `null`) or printed no signature** is different: the transaction **MAY STILL LAND** (a blockhash is valid for about 150 slots), so **wait at least 2 minutes before re-running**; discovery then adopts it if it landed, and the hour is sent again only if it did not. Re-running at once can find nothing yet and send the hour twice (two fees, two memos):

| Code | The gate |
| --- | --- |
| `genesis-unconfirmed` | `--execute` without `--confirm-genesis` |
| `rpc-url-refused` | `SOLANA_RPC_URL` fails the devnet guard (mainnet or testnet host, userinfo, non-http scheme, fragment) |
| `wrong-cluster` | the endpoint reports the **mainnet-beta** or **testnet** genesis hash, even when you confirm it (`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY`: the values in the Anza validator documentation, <https://docs.anza.xyz/clusters/available>) |
| `genesis-mismatch` | the live genesis is not the `--confirm-genesis` you gave, or is not the genesis the plan observed (re-run the plan) |
| `rpc-unreadable` | the genesis, balance, a signature, a recorded note's transaction or a page of the signer's signatures could not be read. A listing that cannot be read is never taken as "nothing was sent" |
| `signer-mismatch` | `solana-keygen pubkey` of the keypair is not `SOLANA_ANCHOR_PUBKEY`, or the keypair path is not absolute |
| `signer-set-incomplete` | the signer set (the configured set folded with the operator's rotation notes, the one `checkpoint_verify` judges against) could not be read, or its rotation read may be incomplete (a note page cap, a read that cannot advance, a failed read, a malformed `SUBSTRATE_ANCHOR_SIGNER_SET`). A missing rotation note could mean the configured key is retired, or that an earlier send was by a key this run does not know, so nothing is sent. Fix the cause named in the message and re-run |
| `signer-not-current` | the configured key (`SOLANA_ANCHOR_PUBKEY`, which must also be the keypair's key) is not accepted by the signer set at the time of the run: its window has ended, or it is not in the set. A replacement it signed would be rejected by `checkpoint_verify`, so nothing is sent. Rotate the job key first (`docs/runbooks/anchor-signer-rotation.md`) |
| `unfunded` | the key holds less than the rent-exempt minimum plus the fees of the sends this run may make (`REQUIRED_BALANCE_LAMPORTS` = 895 880, then 5 000 lamports for each further send) |
| `no-operator-surface` | no operator surface to write the note as (see `--surface`): the verifier ignores a note from any other surface, so nothing is sent that could not be recorded |
| `row-missing`, `store-failed`, `digest-failed` | the stored `anchors` row cannot be read, or the hour cannot be recomputed |
| `root-mismatch` | for **every** plan hour, the stored row, the plan and the digest recomputed from the ledger must agree on root, event count and memo **byte for byte** (the memo must be exactly `formatMemo` of the hour, root and count). A difference is a ledger-integrity question, never repaired. The same refusal applies when the new cluster already holds a memo by the signer for that hour with a different root |
| `present-on-cluster` | the stored signature exists on the cluster: this is not a reset for that hour (checked for every hour before the first send) |
| `reanchor-locked` | another `--execute` run holds the lock (see above); nothing was listed or sent |
| `discovery-incomplete` | the signer's signatures could not be paged back to the earliest hour that has no recorded note within the page cap (100 pages of 100, so 10 000 signatures); an earlier send cannot be ruled out, so nothing is sent. Look at why that key has so many signatures since that hour (it should hold about one per anchored hour) rather than send blind; an hour that already has a recorded `anchor.reanchor` note never needs the listing |
| `notes-incomplete` | the recorded `anchor.reanchor` notes of an hour could not be read, or not completely (the ledger is unreachable, an operator surface hit the note page cap, or its notes could not be read past one instant), so a NEWER bound note than any returned may exist and the pointer the verifier follows is unknown. The verifier leaves such an hour `unverified` for the same reason; the run refuses for every hour before the first send and writes no note, even when another surface holds a valid note. One rule: a failed or incomplete notes read refuses before any send, never counts as "no note". Look at why the read failed (the ledger, or a surface holding so many notes in the hour's `anchor:<hour>` session), then re-run |

Then, with the lock held and still before any send, for **every** hour in ascending order: (1) the stored signature must be absent (`present-on-cluster`); (2) the `anchor.reanchor` notes already recorded for the hour are read through the same trusted-surface read the verifier uses (operator surfaces only); a read that fails or cannot be completed is `notes-incomplete`, never read as "no note"; a note bound to the hour whose transaction is on the new cluster with the same memo and signed by the key means the hour is **done**: it is adopted, not sent, and not recorded twice; (3) for the hours without such a note, one listing of the signer's signatures is **paged backwards** (`getSignaturesForAddress` with the `before` cursor, 100 per page) until a page ends at a block older than the plan's earliest hour or the signer's history ends, so a long plan whose earliest receipts have fallen far down the signer's history is still found. The listing is made at `confirmed` commitment, because the send is read back at `confirmed`: a send that has confirmed but is not yet finalized is found by the very next run instead of being sent a second time. A memo for the hour found there is confirmed by reading its transaction and **adopted** (same root and count; a different root or count is `root-mismatch`), never sent twice. A miss in the newest signatures is never read as proof that nothing was sent: reaching the page cap first is `discovery-incomplete`. Only then, hour by hour in ascending order, the entry sends the stored memo for each hour not adopted with `transferMemoArgv` (the same argv shape as the hourly job) and applies the job's read-back (memo, period, root, count, fee payer and signature, no error). Any failure there is `send-failed` and the run stops before the next hour. An hour whose send was cut short is picked up by running the same command again, **after the 2-minute wait above when the send ended without a signature** (a non-zero exit or a timeout): the transaction is then adopted, not repeated. Adopted hours do not count against `--max-hours`.

Signers. The executor and `substrate verify` judge a transaction's signer the way `checkpoint_verify` does: by the signer set (`SUBSTRATE_ANCHOR_SIGNER_SET` or `SOLANA_ANCHOR_PUBKEY` alone, folded with the operator's `anchor.signer.rotate` notes) at the transaction's **block time**, not by comparing it with the one configured key. So an hour that an earlier key re-anchored before the job key rotated is still adopted by a re-run (from its recorded note or from the discovery listing), never sent again, and `substrate verify` still reports it `anchored`. `substrate verify` is exactly as strict as `checkpoint_verify`, for every payer including the configured key: a rotation read that may be incomplete, a transaction without a block time yet, or a signer set that cannot be built leave the hour `unverified`, never `anchored`. The executor reads the set once per run, before any send; discovery lists the signatures of **every** key in the set (at most 16), not only the configured one, so the cost of discovery grows with the number of keys in the set; and a configured key that the set does not accept **now** (its window has ended, or it is not in the set) is refused before any send. A transaction whose block time the cluster does not report cannot be judged against a window and is refused as `rpc-unreadable` rather than read as "not sent".

The verification caveat: `checkpoint_verify` still compares the cluster's genesis with `DEVNET_GENESIS_HASH`. A re-anchored hour therefore reads `unverified` (reset-suspected) until step b has moved the constant to the new genesis; afterwards it reads `anchored` if, and only if, the replacement transaction verifies like any anchor (memo, root, inclusion proof, and a signer valid at its block time).

### Procedure

| Step | Who | What |
| --- | --- | --- |
| a. Steps 1 to 4 above, plan saved | operator | read-only. Do this first and keep the file |
| b. **OPERATOR ONLY** Decide the genesis update | owner | the expected genesis must move to the new cluster's hash (a code change and a release; `deploy-release.sh`, `docs/runbooks/release-gate.md`). Devnet-only stays true: the URL guard and the genesis gate remain. Step e may run before or after it: it is gated by `--confirm-genesis`, not by the constant |
| c. **OPERATOR ONLY** Fund the key on the new cluster | operator | the key must hold at least `REQUIRED_BALANCE_LAMPORTS` = 895 880 (rent-exempt minimum plus one fee; `anchor.ts`), otherwise the job stops with `unfunded`. Use the devnet faucet. It is rate limited and often refuses, and the repo has not verified its limits. **Do not paste the keypair path or print the file** |
| d. **OPERATOR ONLY** Let fresh hours anchor | timer / operator | after (b) is deployed, `systemctl start substrate-anchor.service` (or wait for the timer). Preview first with `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/anchor-run.ts --dry-run`: it prints `would anchor <hour>` and sends nothing. It anchors at most 24 non-empty hours per run within seven days; an older hour needs `anchor-run.ts --period <HOUR>` (**OPERATOR ONLY**, one hour per run, it sends) |
| e. **OPERATOR ONLY** Re-send the old hours | operator | first the dry run, then one hour, then the rest (commands below). **The send itself is operator-run.** Deleting or overwriting an `anchors` row has no tool, no test and unverified store semantics: never do it by hand |
| f. Record each real re-anchor | the entry | automatic: step e writes one `anchor.reanchor` note per hour as an operator surface (below). Only a `store-failed` refusal after a send needs you: run step e again (it adopts the transaction and records it) |

Step e, from the host, with the plan saved in step 3 (`<PLAN_FILE>`) and the new cluster's genesis hash (`<NEW_GENESIS_HASH>`, the plan's `chain.observed_genesis`):

```sh
cd /opt/agent-substrate/current
# 1. DRY RUN (the default): reads nothing, sends nothing; prints "would re-anchor <hour>" per hour
bun packages/mcp-server/src/reanchor-run.ts --plan <PLAN_FILE>

# 2. OPERATOR ONLY: send ONE hour first (--max-hours defaults to 1). It sends a transaction.
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/reanchor-run.ts \
  --plan <PLAN_FILE> --execute --confirm-genesis <NEW_GENESIS_HASH> [--surface <OPERATOR_SURFACE>]

# 3. Check it (read-only): checkpoint_verify { "ckpt_id": "<CKPT_ID>", "session_id": "<SESSION_ID>" } for a checkpoint in that hour,
#    then the rest, at most 24 sends per run:
bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/reanchor-run.ts \
  --plan <PLAN_FILE> --execute --confirm-genesis <NEW_GENESIS_HASH> --max-hours 24 [--surface <OPERATOR_SURFACE>]
```

Exit codes: `0` the dry run was printed or every hour is done (the last line says how many hours are left in the plan when `--max-hours` cut the run: run it again), `1` a gate refused or a send or record failed (read the `REFUSED` line), `2` usage, an unreadable or invalid plan file, or missing configuration (a bad flag, an unset `GREPTIME_URL`, `SOLANA_ANCHOR_KEYPAIR` or `SOLANA_ANCHOR_PUBKEY`, a refused `SOLANA_RPC_URL`).

The re-anchor transaction is signed at its own, later block time, so its signer must be valid **then** (`docs/runbooks/anchor-signer-rotation.md`: a key is accepted by the block time of the transaction, never by "is it the current key"). The verifier does not require the block time to be near the hour: it uses it only for the signer window.

### The `anchor.reanchor` event (written by step e)

Kind `note`, written by `reanchor-run.ts --execute` as the operator surface it was given (`--surface`, or the single operator surface), in the hour's anchor session (`session_id: anchor:<YYYY-MM-DDTHH>`), no `repo`, built by `buildReanchorEvent` (`reanchor-plan.ts`) with the idempotency key `reanchor:<period_start>:<new_tx_sig>`:

```json
{
  "action": "anchor.reanchor",
  "period_start": "<HOUR_ISO>",
  "root": "<64 lowercase hex>",
  "event_count": <N>,
  "previous_tx_sig": "<OLD_SIGNATURE>",
  "new_tx_sig": "<NEW_SIGNATURE>",
  "genesis": "<NEW_GENESIS_HASH>"
}
```

Unknown keys are refused. The root and count are the stored row's, unchanged. The action is **reserved**: `events_emit` and `POST /events` refuse it from anyone but an operator writing as its own surface (`reserved-actions.ts`). It carries hashes, signatures and a genesis hash only, never event content.

**How the verifier uses it.** For an hour whose stored row names a vanished signature, `checkpoint_verify` / `memory_verify` / `substrate verify` read this hour's anchor session for `anchor.reanchor` notes written by an **operator surface**, and follow the newest one whose root, event count and `previous_tx_sig` equal the stored row's. The session id is predictable and any caller may write ordinary notes into it, so the read asks the ledger **per operator surface** (the author filter is part of the query, so the 500-row page limit counts trusted notes only) and pages (keyset on the note time, at most 20 pages of 500 per surface) until the newest bound note is found. A read that hits that page cap, or cannot advance, leaves the hour `unverified` with the reason *the anchor.reanchor notes of this hour could not be read completely*, never silently the old row. The note is only a pointer: the verifier reads the transaction it names from the chain, **once per verification**, and applies the same checks as for any row to that same read (memo, recomputed root, inclusion proof, fee payer, signer valid at the block time); a failed read is a failed read, never compared with a stale signer. A note from another surface, a malformed note, or one bound to another row is ignored; a note naming a transaction that does not verify leaves the hour `unverified` or `mismatch`, never `anchored`. The `anchors` row is never rewritten.

If step e reports `store-failed` after a send, do **not** send again by hand: run the same command again. It finds the transaction, adopts it and writes the note. Only if the ledger stays unwritable, emit the printed payload yourself with `events_emit` as your own operator surface and `session_id: anchor:<YYYY-MM-DDTHH>` (the verifier reads that session only). The idempotency and repair-key guarantees (a note write that landed but was reported lost is deduplicated on re-run, and a repair note gets its own key) hold when `SUBSTRATE_EVENT_IDEMPOTENCY` is `accept` or `enforce`; with the default `off`, a note write that landed but was reported lost is written again on re-run (a second note naming the same transaction: the verdict does not change).

**Which note counts: the newest bound one, and a stale pointer is repaired by adoption, never by a second send.** An hour's pointer is its newest `anchor.reanchor` note bound to the stored row (same root, event count and `previous_tx_sig`); both the verifier and `reanchor-run.ts` choose it with the same function (`newestBoundNote`, `anchor-verify-deps.ts`), and an older note is never a fallback for a newer one. If that newest note's transaction is on the cluster, memo-exact and signed by the key, the hour is done: adopted, nothing written. If it names a transaction the cluster does not know (or one with another memo, another payer or an error), the hour is **not** recorded even when an older note names a valid transaction, because the verifier would still read the hour as `unverified`. The run then goes through discovery: a valid earlier transaction for the hour, such as the one the older note names, is **adopted** and a **new** note naming it is written, which becomes the newest bound note; only when discovery finds none is one transaction sent. A repair note carries its own idempotency key (`reanchor:<period_start>:r:<40 hex of sha256(new_tx_sig + ":" + the stale note's event id)>`) so that it is stored even when an older note names the same signature under the plain key. A newest note whose transaction cannot be read at all refuses as `rpc-unreadable`.

## Abort and rollback

- Steps 1 to 4 change nothing: abort at any point. Delete the saved plan only when the incident is closed.
- A transaction sent to devnet cannot be taken back, and an `anchor.reanchor` note cannot be deleted (the ledger is append-only). That is why every sending step is gated behind a decision, and why the plan is saved first.
- If step 2 finds a `ledger-side note:` or a `signature-missing-without-reset`, stop: this is not a reset, and nothing here applies.

## What this does not prove

- A plan says which stored rows have no signature on the observed cluster. It does not prove the ledger's roots are right (`checkpoint_verify` recomputes them from the ledger and compares), and it does not prove a re-anchor will verify.
- Devnet can be reset again. A re-anchored root is witnessed until the next reset, no longer. The only durable copies of the roots are the ledger's `anchors` table and its archives (`docs/runbooks/index-archive.md` and `docs/greptime-ledger.md`, "Coverage and archive").
- Nothing in this runbook makes devnet storage.
