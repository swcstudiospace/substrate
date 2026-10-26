# Runbook — rotate the anchor signing key without invalidating the anchors the old key wrote

| | |
| --- | --- |
| Question | How do I change the key that signs the hourly anchor, and what does verification say about anchors the old key signed before and after the change? |
| Trigger | A scheduled key rotation, or a suspected compromise of the anchor keypair file (see *Emergency rotation*) |
| Who | An operator. **Every step marked OPERATOR ONLY generates or funds a key, writes the ledger as an operator, changes a production unit or sends a transaction. Nothing here runs automatically, no agent runs it, and no CI job does.** |
| Scope | The Solana **devnet** anchor key. Mainnet and testnet are out of scope. This runbook handles public keys and file **paths** only: it never prints, copies or pastes key material. |
| Blast radius | A wrong rotation does not lose data. It makes anchors read `mismatch` or `unverified` until it is corrected. The cutover can be undone by a second rotation. |

## The stance

- **Devnet is evidence of a root, not storage.** The anchor memo carries a period, a Merkle root and an event count. A key signs *that statement*; it protects no data.
- **Devnet may reset and publishes no retention window.** A reset wipes the key's balance too (`docs/runbooks/devnet-reset-and-reanchor.md`). A rotation is not a reset procedure and a reset is not a reason to rotate.
- **Mainnet and testnet are out of scope.** The URL guard and the genesis-hash gate refuse them.

## How the verifier decides who may sign

`packages/ledger/src/signer-set.ts`, `packages/mcp-server/src/anchor-verify-deps.ts`, `packages/mcp-server/src/checkpoint-verify.ts`:

- A key is accepted by the **block time of the anchor transaction**, never by "is it the current key". Each signer has a window `valid_from_ms <= t < valid_until_ms` (half open; `null` is open ended). That is what keeps a rotation from invalidating anchors an earlier key wrote.
- The signer set is the **bootstrap key** (the server's `SOLANA_ANCHOR_PUBKEY`, valid from the epoch with no end) **plus** every valid `anchor.signer.rotate` note written by an **operator surface**. The ledger accepts events from any authenticated caller, so a rotation note from a non-operator surface is ignored: `signerSetFromRotationEvents` fails closed without an `authorize` predicate, and the service passes `operatorSurfaces(config)` (`packages/mcp-server/src/config.ts`: the surfaces whose tokens are in `SUBSTRATE_OPERATOR_TOKENS`, never a swarm surface and never `substrate`). On a bare local run with no surface tokens there are **no** operator surfaces, so no rotation is ever honoured there.
- A rotation that names `old_pubkey` closes that key's window at `effective_from_ms` and opens `new_pubkey` from the same instant: no gap, no overlap. The old key must be valid at that instant, the new key must not already be, and the set holds at most 16 entries. A note that cannot be applied is **ignored** (`old-key-not-valid`, `new-key-overlaps`, `set-full`, `effective-time-out-of-bounds`, `invalid-payload`, `unauthorized`, `duplicate-event-id`).
- **The verifier does not tell you which note it ignored.** `readSignerSet` keeps the derived set and drops the issue list. The only visible effect is that an anchor the ignored note was meant to cover reads `mismatch` (the signer is not in the set) or `unverified` (see *Limits*). Check the effect after every rotation (step 6).

### The effective-time bounds, and why

`effective_from_ms` must lie within **24 hours before** and **30 days after** the note's own timestamp (`ROTATION_MAX_BACKDATE_MS`, `ROTATION_MAX_FUTURE_MS`). The code's reason for each: a rotation may be recorded after the fact (the operator rotates, then writes the note) but not by more than a day, and may be scheduled ahead but not by more than a month. [INFERENCE: the bounds also cap how far a stolen operator token could rewrite which key was valid when; the code states only the first reasons.] A note outside the bounds is ignored, so a late note is a failed rotation, not a late one.

## Procedure (scheduled rotation)

### 0. Prerequisites (read-only)

- You hold a token that maps to an **operator surface** (`SUBSTRATE_OPERATOR_TOKENS` lists tokens; each must also be a surface token). Name the surface `<OPERATOR_SURFACE>`; never paste the token.
- `checkpoint_verify` answers `anchored` for a recent checkpoint **before** you start. If it does not, fix that first: you need a baseline.
- Pick the moment `T` (`<T_ISO>`, `<T_EPOCH_MS>`): **after** the last run signed with the old key finished and **before** the first run signed with the new key. The timer fires on the hour (`OnCalendar=hourly`, `Persistent=true`) and a run signs at about its start time (the anchor's block time), so for example `T` = half past, with the old key's last run finished and the cutover complete before the next hour. An old-key anchor at or after `T`, or a new-key anchor before `T`, reads `mismatch`.

### 1. OPERATOR ONLY: generate and fund the new key

- Generate the keypair on a trusted machine, not on the anchor host, and do not paste it anywhere. `solana-keygen new --outfile <NEW_KEYPAIR_PATH>` (check `solana-keygen new --help` for your installed version's passphrase flags: UNVERIFIED here). Record only the **public key**, `<NEW_PUBKEY>`: `solana-keygen pubkey <NEW_KEYPAIR_PATH>`.
- Fund `<NEW_PUBKEY>` on devnet with at least **895 880 lamports** (`REQUIRED_BALANCE_LAMPORTS` in `anchor.ts`: the rent-exempt minimum plus one fee). Use the devnet faucet; it is rate limited and often refuses, and the repo has not verified its limits.
- Install the keypair on the host as an **absolute path**, owner root, mode 0600, outside the repo (for example next to the existing key under `/etc/substrate/`). The job refuses a relative path (`SOLANA_ANCHOR_KEYPAIR must be an absolute path`). Never `cat` or print the file.
- Prove the pair matches, printing only the public key: `solana-keygen pubkey <NEW_KEYPAIR_PATH>` must print `<NEW_PUBKEY>`. This is the same check the job makes before its first send (`signer-mismatch` otherwise).

### 2. OPERATOR ONLY: pause the timer

`systemctl stop substrate-anchor.timer` after the last old-key run has finished (`journalctl -u substrate-anchor.service --since "-2h" --no-pager | grep '\[anchor\]'`). It touches a production unit. While it is stopped, hours are `pending` and then `unanchored`, and recover when the timer is back (`docs/runbooks/anchor-chain-outage.md`).

### 3. OPERATOR ONLY: record the rotation as an operator

Build and **validate** the payload first. This throws a `SignerSetError` naming the field and rule if it is wrong, and writes nothing:

```sh
cd /opt/agent-substrate/current
OLD=<OLD_PUBKEY> NEW=<NEW_PUBKEY> T=<T_EPOCH_MS> WHY='<REASON, 1 to 200 characters>' bun -e '
import { buildSignerRotateEvent } from "./packages/ledger/src/index.ts";
const draft = buildSignerRotateEvent({ old_pubkey: process.env.OLD, new_pubkey: process.env.NEW, effective_from_ms: Number(process.env.T), reason: process.env.WHY });
console.log(JSON.stringify(draft, null, 2));
'
```

(`date -u -d '<T_ISO>' +%s%3N` gives `<T_EPOCH_MS>` with GNU date.) The output is the exact payload, plus its summary and idempotency key:

```json
{
  "kind": "note",
  "summary": "anchor signer rotation: <NEW_PUBKEY> from <T_ISO>",
  "payload": {
    "action": "anchor.signer.rotate",
    "old_pubkey": "<OLD_PUBKEY>",
    "new_pubkey": "<NEW_PUBKEY>",
    "effective_from_ms": <T_EPOCH_MS>,
    "reason": "<REASON>"
  },
  "idempotency_key": "anchor-rotate:<NEW_PUBKEY>:<T_EPOCH_MS>"
}
```

Unknown keys are refused; `reason` has no control characters; `old_pubkey` must differ from `new_pubkey`; omit `old_pubkey` only to *add* a key without retiring one. Then emit it **once** with the MCP tool `events_emit`, as the operator surface:

```json
{
  "kind": "note",
  "surface": "<OPERATOR_SURFACE>",
  "session_id": "anchor-admin:<YYYYMMDD>",
  "actor": "human",
  "summary": "anchor signer rotation: <NEW_PUBKEY> from <T_ISO>",
  "payload": { "action": "anchor.signer.rotate", "old_pubkey": "<OLD_PUBKEY>", "new_pubkey": "<NEW_PUBKEY>", "effective_from_ms": <T_EPOCH_MS>, "reason": "<REASON>" }
}
```

The reply must say `stored: true`. The CLI alternative is `substrate emit --kind note --surface <OPERATOR_SURFACE> --session anchor-admin:<YYYYMMDD> --actor human --summary '<SUMMARY>' --payload '<PAYLOAD_JSON>'`, with two traps: **it always exits 0, even when the note was not stored**, and it adds `repo` from the current directory's git origin, which puts the note in that repo's brief, so run it from a directory that is not a git checkout. Either way, read the note back before going on:

```json
events_query { "surface": "<OPERATOR_SURFACE>", "kind": "note", "session_id": "anchor-admin:<YYYYMMDD>", "include_payload": true }
```

`events_emit` has no idempotency parameter, so a second emit is a second note (harmless but noisy: the second is ignored as `new-key-overlaps`). The note's own timestamp must fall no later than 24 hours after `T` and no earlier than 30 days before it (see the bounds): emit it close to `T`, not weeks away.

### 4. OPERATOR ONLY: switch the job's signing key, and only the job's

This is the part the code makes awkward, and it is **UNVERIFIED on this host**. The anchor job and `substrate-mcp` read the **same** `/etc/substrate/substrate.env` (`infra/vps/substrate-anchor.service.d/10-environment.conf`), and one variable, `SOLANA_ANCHOR_PUBKEY`, plays two roles:

- in the **job** it is the key that signs (and `solana-keygen pubkey <keypair>` must equal it);
- in the **server** it is the **bootstrap signer**, valid from the epoch with no end.

If you change it to `<NEW_PUBKEY>` in `substrate.env`, the server's bootstrap becomes the **new** key and the old key is no longer in the signer set. The rotation note then fails (`old-key-not-valid`: the old key is not valid at `T` because it is not in the set), and **every anchor the old key wrote reads `mismatch`** (*signer … is not in the signer set*). Do not do that. Leave `substrate.env` as it is (the server keeps the **old** key as bootstrap and the rotation note closes it at `T`), and give the **job alone** the new key through a second `EnvironmentFile=` in a drop-in:

```ini
# /etc/systemd/system/substrate-anchor.service.d/20-signer.conf   (root, mode 0644; holds no secret)
[Service]
EnvironmentFile=/etc/substrate/anchor-signer.env
```

```sh
# /etc/substrate/anchor-signer.env   (root, mode 0600): two lines, a path and a PUBLIC key
SOLANA_ANCHOR_KEYPAIR=<NEW_KEYPAIR_PATH>
SOLANA_ANCHOR_PUBKEY=<NEW_PUBKEY>
```

systemd documents that a later `EnvironmentFile=` overrides an earlier one for the same variable; confirm it on this host before the cutover with a transient unit that prints nothing but a yes or no (UNVERIFIED until you do):

```sh
systemctl daemon-reload
systemd-run --wait --pipe -p EnvironmentFile=/etc/substrate/substrate.env -p EnvironmentFile=/etc/substrate/anchor-signer.env \
  sh -c '[ "$SOLANA_ANCHOR_PUBKEY" = "<NEW_PUBKEY>" ] && echo job-env-ok || echo job-env-WRONG'
```

Do not restart `substrate-mcp`. A safety net exists regardless: if the job's key pair does not match, the job stops with `signer-mismatch` before sending anything.

### 5. OPERATOR ONLY: start the timer

After `T`, and before the next hour: `systemctl start substrate-anchor.timer`. (`Persistent=true` runs a missed tick immediately: that is why `T` must already be in the past.) Preview with `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/anchor-run.ts --dry-run` if you like: it sends nothing.

### 6. Verify (read-only)

- A checkpoint in an hour anchored by the **old** key, with a block time before `T`: `checkpoint_verify` answers `anchored` and `evidence.signer` is `<OLD_PUBKEY>`.
- A checkpoint in an hour anchored after `T`: `anchored` with `evidence.signer` equal to `<NEW_PUBKEY>`.
- `mismatch` with *signer … signed at …, outside its valid window […)* on an anchor you expected to pass means `T` was wrong, or the new key signed before `T`. `mismatch` with *is not in the signer set* means the note was ignored or the server's bootstrap key was changed: re-read step 3 and step 4. `unverified` with `signer_set_complete: false` is the limit below, not tampering.

### 7. Retire the old keypair file (OPERATOR ONLY)

Verification uses public keys only, so the old keypair file can be removed from the host once you have verified step 6 and no run needs it. Keep `<OLD_PUBKEY>` in your records: it stays in the set as `[0, T)` for as long as the server's env names it.

## Emergency rotation (suspected compromise of the old key)

1. **OPERATOR ONLY: stop signing with the old key now.** `systemctl stop substrate-anchor.timer`, and do not trigger the service.
2. Generate and fund the new key (step 1), install it, switch the job (step 4).
3. Record the rotation with `effective_from_ms` = the moment you stopped signing with the old key, or the earliest moment you can justify, **never earlier than 24 hours before the note's own timestamp**: a note that reaches further back is ignored whole, which silently leaves the old key valid. From `T` on, any anchor the old key signs reads `mismatch`.
4. Start the timer (step 5) and verify (step 6).

What this does and does not do:

- It **does** make every old-key transaction with a block time at or after `T` unacceptable, including forgeries.
- It does **not** revoke anchors the old key signed before `T`, and it cannot reach back more than 24 hours. Anchors signed between the real compromise and `T` still pass the signer check.
- It does not matter much for the root. `checkpoint_verify` **recomputes** the hour's root from the ledger and compares it with the memo the row names, so a forged memo whose root differs reads `mismatch` whoever signed it. The signer check protects against a memo that is *right* being attributed to the wrong party, and against an attacker who could also alter the ledger row.
- Re-anchoring suspect hours with the new key has the same open point as the reset runbook: the job does not write an hour that already has a row (`docs/runbooks/devnet-reset-and-reanchor.md`, "Open point"). Do not edit rows by hand.

## Limits

- **The rotation note is found among the newest 500 notes of each operator surface** (`LOOKUP_ROW_LIMIT`; at most 8 surfaces). On a busy operator surface the note falls out of that window. When a page is full, or the read fails, the verifier reports `signer_set_complete: false`, and a `mismatch` that only the signer set explains becomes `unverified` with the gap named. That is safe, not correct: anchors signed by the old key read `unverified` until the note is within the window again. Emit the note from the least busy operator surface, and re-check after a busy day.
- **A note that is ignored is not reported** (above). Step 6 is the check.
- **One variable, two roles** (step 4). The clean fix is a separate setting for the job's signer; that does not exist, and this runbook does not invent one.
- The server's bootstrap key is the one in `substrate.env`. If it is ever changed to a key that was never in the set, old anchors read `mismatch`.

## Abort and rollback

- Before step 3, nothing is committed: remove the keypair file and stop.
- After step 3, the note cannot be deleted (the ledger is append-only). Undo a wrong cutover with a **second** rotation (`old_pubkey` = the key that is wrong, `new_pubkey` = the one to return to) with a new `T` after the first.
- A transaction already sent cannot be taken back.

## What this does not prove

- A valid signer window says a key the operators named wrote the memo at that time. It does not say the key was safe, or that the operator surface that named it was.
- Nothing here makes devnet storage, or a durable witness: a reset ends it (`docs/runbooks/devnet-reset-and-reanchor.md`).
