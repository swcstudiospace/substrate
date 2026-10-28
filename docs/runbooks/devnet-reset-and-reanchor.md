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

## 5. What can be done today, and the open point

Steps 1 to 4 work today. So does **funding the key**, and so will **fresh hours** once the genesis constant is updated. Re-sending the old hours with the anchor job does **not** work today. The reason is below, stated from the code, not guessed.

### Open point: how the job treats an hour that already has a row

What `packages/mcp-server/src/anchor.ts` does today (symbols; line numbers as of this branch):

1. **The sweep skips any hour that has an `anchors` row.** It reads the window `[max(coverage start, now − 7 days), now)` with `anchorsBetween`, marks every row's `period_start` as anchored (about lines 390 to 393) and skips those hours (about line 432). Rows older than seven days are not read at all.
2. **`--period <hour>` on an anchored hour takes the adopt path** (about lines 402 to 414 and `checkAdopt`). It lists the key's 100 most recent signatures on the cluster and looks for a memo for that hour. On a wiped cluster there is none, so the verdict is `none`, the job prints `already anchored` and **sends nothing** (about lines 579 to 584). Even a found memo only writes an `anchor.written` note with `adopted: true`; the stored row is left untouched.
3. **Before any send the job re-reads the hour's row** with `anchorForPeriod` and stops if one exists (about lines 592 to 603).
4. **The cluster gate is a constant.** `DEVNET_GENESIS_HASH` is compared in `checkPreconditions` and in the adoption path, so after a reset the job refuses even a fresh hour (`wrong-cluster`). The verifier uses the same constant as `expectedGenesis` (`packages/mcp-server/src/anchor-verify-deps.ts`, and the `verify` read-back in `service.ts`).
5. **A row is written at most once.** `GreptimeClient.insertAnchor` documents that the table deduplicates by `period_start` and that callers never write an hour twice (`packages/mcp-server/src/greptime.ts`). **Whether a second insert replaces the row or is ignored is UNVERIFIED**: no code or test in this repo exercises it against a live store.
6. **The verifier follows the row, not the chain.** `checkpoint_verify` reads the row for the hour (`anchorForPeriod`) and looks up **its** `tx_sig`. Nothing reads the `anchor.reanchor` event yet: it is defined and validated in `reanchor-plan.ts` and listed in `docs/event-vocabulary.md`, and nothing in the verifier consumes it.

So a re-send needs a change that does not exist, and this runbook does **not** invent a flag for it. What would have to change, for the owner to decide:

- a deliberate **re-anchor mode of the job**, driven by the saved plan: only the plan's hours are candidates, each recomputed from the ledger and refused (as `root-mismatch`) unless root and count equal the stored row, so exactly the same memo v1 content is sent;
- the **row-exists skips bypassed for those hours only**, and the cluster check made against the new genesis;
- a place where the **new signature is recorded that the verifier reads**: either the `anchors` row is replaced (a decision on the table's replace-or-ignore behaviour, which needs a live check) or the verifier learns to follow `anchor.reanchor` events;
- the **expected genesis** moved to the new cluster's hash, or made configurable (a new setting needs its flag-registry and configuration-reference entries);
- the `anchor.reanchor` event emitted on success (`buildReanchorEvent`; idempotency key `reanchor:<period_start>:<new_tx_sig>`).

A manual `solana transfer … --with-memo` of the plan's memo is technically possible (the argv shape is `transferMemoArgv`, `packages/ledger/src/solana.ts`), but it bypasses the job's genesis, balance and read-back checks and leaves `checkpoint_verify` at `unverified`, because the row still names the old signature. This runbook gives no command for it.

### Procedure

| Step | Who | What |
| --- | --- | --- |
| a. Steps 1 to 4 above, plan saved | operator | read-only. Do this first and keep the file |
| b. **OPERATOR ONLY** Decide the genesis update | owner | the expected genesis must move to the new cluster's hash (a code change and a release; `deploy-release.sh`, `docs/runbooks/release-gate.md`). Devnet-only stays true: the URL guard and the genesis gate remain |
| c. **OPERATOR ONLY** Fund the key on the new cluster | operator | the key must hold at least `REQUIRED_BALANCE_LAMPORTS` = 895 880 (rent-exempt minimum plus one fee; `anchor.ts`), otherwise the job stops with `unfunded`. Use the devnet faucet. It is rate limited and often refuses, and the repo has not verified its limits. **Do not paste the keypair path or print the file** |
| d. **OPERATOR ONLY** Let fresh hours anchor | timer / operator | after (b) is deployed, `systemctl start substrate-anchor.service` (or wait for the timer). Preview first with `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/anchor-run.ts --dry-run`: it prints `would anchor <hour>` and sends nothing. It anchors at most 24 non-empty hours per run within seven days; an older hour needs `anchor-run.ts --period <HOUR>` (**OPERATOR ONLY**, one hour per run, it sends) |
| e. **BLOCKED today** Re-send the old hours | — | see the open point. Wait for the change; do not edit rows by hand. Deleting or overwriting an `anchors` row has no tool, no test and unverified store semantics |
| f. Record each real re-anchor | operator | after (e) exists and has sent: an `anchor.reanchor` note from your own surface (below) |

The re-anchor transaction is signed at its own, later block time, so its signer must be valid **then** (`docs/runbooks/anchor-signer-rotation.md`: a key is accepted by the block time of the transaction, never by "is it the current key"). The verifier does not require the block time to be near the hour: it uses it only for the signer window.

### The `anchor.reanchor` event (after a real re-anchor only)

Kind `note`, from the caller's own surface, no `repo`, built by `buildReanchorEvent` (`reanchor-plan.ts`):

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

Unknown keys are refused. The root and count must be the stored row's, unchanged. Emit it once (`events_emit` has no idempotency parameter; check `events_query` before retrying). It carries hashes, signatures and a genesis hash only, never event content.

## Abort and rollback

- Steps 1 to 4 change nothing: abort at any point. Delete the saved plan only when the incident is closed.
- A transaction sent to devnet cannot be taken back, and an `anchor.reanchor` note cannot be deleted (the ledger is append-only). That is why every sending step is gated behind a decision, and why the plan is saved first.
- If step 2 finds a `ledger-side note:` or a `signature-missing-without-reset`, stop: this is not a reset, and nothing here applies.

## What this does not prove

- A plan says which stored rows have no signature on the observed cluster. It does not prove the ledger's roots are right (`checkpoint_verify` recomputes them from the ledger and compares), and it does not prove a re-anchor will verify.
- Devnet can be reset again. A re-anchored root is witnessed until the next reset, no longer. The only durable copies of the roots are the ledger's `anchors` table and its archives (`docs/runbooks/index-archive.md` and `docs/greptime-ledger.md`, "Coverage and archive").
- Nothing in this runbook makes devnet storage.
