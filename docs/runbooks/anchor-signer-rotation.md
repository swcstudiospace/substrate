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
- The signer set is the **bootstrap set** **plus** every valid `anchor.signer.rotate` note written by an **operator surface**. The bootstrap set is `SUBSTRATE_ANCHOR_SIGNER_SET` when that variable is set (JSON text: entries `{pubkey, valid_from_ms, valid_until_ms or null, label}`, at most 16, parsed by `parseSignerSet`), and otherwise the server's `SOLANA_ANCHOR_PUBKEY` alone, valid from the epoch with no end. When it is set it **replaces** the `SOLANA_ANCHOR_PUBKEY` bootstrap, so the key the anchor job signs with (`SOLANA_ANCHOR_PUBKEY`/`SOLANA_ANCHOR_KEYPAIR`) can change without the verifier forgetting the keys that signed earlier anchors. A value that does not parse is not an empty set and not a crash: `checkpoint_verify` and `memory_verify` answer `unverified` with the fixed reason *SUBSTRATE_ANCHOR_SIGNER_SET is malformed*, and the boot warning names the rule and the field path, never the value. The ledger accepts events from any authenticated caller, so a rotation note from a non-operator surface is ignored: `signerSetFromRotationEvents` fails closed without an `authorize` predicate, and the service passes `operatorSurfaces(config)` (`packages/mcp-server/src/config.ts`: the surfaces whose tokens are in `SUBSTRATE_OPERATOR_TOKENS`, never a swarm surface and never `substrate`). On a bare local run with no surface tokens there are **no** operator surfaces, so no rotation note is ever honoured there (the bootstrap set still is).
- A rotation that names `old_pubkey` closes that key's window at `effective_from_ms` and opens `new_pubkey` from the same instant: no gap, no overlap. The old key must be valid at that instant, the new key must not already be, and the set holds at most 16 entries. A note that cannot be applied is **ignored** (`old-key-not-valid`, `new-key-overlaps`, `set-full`, `effective-time-out-of-bounds`, `invalid-payload`, `unauthorized`, `duplicate-event-id`).
- **The verifier tells you which note it ignored.** Every `checkpoint_verify` and `memory_verify` answer that got as far as judging a signer carries `signer_set`: `{source: "env" | "pubkey", entries, rotation_notes_applied, rotation_issues: [{event_id, reason}], read_gap}`. `source` says which bootstrap was used, `rotation_issues` lists up to ten notes that were ignored and the rule (`old-key-not-valid`, `new-key-overlaps`, ...), and `read_gap` is set when the rotation read hit its page cap, could not advance, or failed (see *Limits*; the answer also carries `signer_set_complete: false` and is never `anchored`). Check it after every rotation (step 7).

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

### 3. OPERATOR ONLY: give the server the signer set, old key until `T` and new key from `T`

The anchor job and `substrate-mcp` read the **same** `/etc/substrate/substrate.env` (`infra/vps/substrate-anchor.service.d/10-environment.conf`). `SOLANA_ANCHOR_PUBKEY` is the key the **job** signs with; the **server's** bootstrap is `SUBSTRATE_ANCHOR_SIGNER_SET` once it is set. Keep the old key in the set with the end of its window, and add the new key from the same instant, **before** anything changes the job's key. One line in `substrate.env` (single quotes, so the double quotes of the JSON survive the file parser; **UNVERIFIED on this host**, the two checks below prove it), public keys only:

```sh
SUBSTRATE_ANCHOR_SIGNER_SET='[{"pubkey":"<OLD_PUBKEY>","valid_from_ms":0,"valid_until_ms":<T_EPOCH_MS>,"label":"old"},{"pubkey":"<NEW_PUBKEY>","valid_from_ms":<T_EPOCH_MS>,"valid_until_ms":null,"label":"new"}]'
```

If the variable is already set from an earlier rotation, **append** the new entry and close the previous key's window instead of replacing the line: every key that ever signed an anchor you still want to verify stays in it. Windows are half open and one key may not have two overlapping windows. Then restart the server so it reads the file (**OPERATOR ONLY**, a production unit: `systemctl restart substrate-mcp`; the timer is already stopped, so no anchor run overlaps). Check, read-only:

- the boot log names no `SUBSTRATE_ANCHOR_SIGNER_SET` warning (`journalctl -u substrate-mcp --since "-5min" --no-pager | grep SUBSTRATE_ANCHOR_SIGNER_SET`; a warning names the rule and the field path, never the value);
- `checkpoint_verify` on the baseline checkpoint from step 0 still answers `anchored`, and its `signer_set` says `source: "env"` and `entries: 2` (more if earlier rotations are in the set).

### 4. OPERATOR ONLY: record the rotation as an operator

The set from step 3 already describes the rotation, so the note is the **audit trail** (who rotated, when, why, in the append-only ledger) and the way a *late* rotation (one the env set does not know yet) takes effect. Build and **validate** the payload first. This throws a `SignerSetError` naming the field and rule if it is wrong, and writes nothing:

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

`events_emit` has no idempotency parameter, so a second emit is a second note (harmless but noisy). The note's own timestamp must fall no later than 24 hours after `T` and no earlier than 30 days before it (see the bounds): emit it close to `T`, not weeks away.

**Expected:** because step 3 already closed the old key's window at `T`, the verifier reports this note in `signer_set.rotation_issues` as `old-key-not-valid` (the old key is not valid *at* `T`: its window ends there). That is the note being redundant with the env set, not a failed rotation. A note that is ignored for any **other** reason, or an anchor that then reads `mismatch`, is the signal to re-read steps 3 and 4.

### 5. OPERATOR ONLY: switch the job's signing key

Now, and only now, change the job's key in `/etc/substrate/substrate.env`: `SOLANA_ANCHOR_KEYPAIR=<NEW_KEYPAIR_PATH>` and `SOLANA_ANCHOR_PUBKEY=<NEW_PUBKEY>` (a path and a **public** key; the file is root, mode 0600, and holds no key material). One file, no drop-in: the server's bootstrap no longer depends on `SOLANA_ANCHOR_PUBKEY` (it is `SUBSTRATE_ANCHOR_SIGNER_SET`), so changing it cannot drop the old key from the set. Keep `SUBSTRATE_ANCHOR_SIGNER_SET` in the file for as long as anchors signed by the old key matter. A safety net exists regardless: if the job's key pair does not match, the job stops with `signer-mismatch` before sending anything.

### 6. OPERATOR ONLY: start the timer

After `T`, and before the next hour: `systemctl start substrate-anchor.timer`. (`Persistent=true` runs a missed tick immediately: that is why `T` must already be in the past.) Preview with `bun --env-file=/etc/substrate/substrate.env packages/mcp-server/src/anchor-run.ts --dry-run` if you like: it sends nothing.

### 7. Verify (read-only)

- A checkpoint in an hour anchored by the **old** key, with a block time before `T`: `checkpoint_verify` answers `anchored` and `evidence.signer` is `<OLD_PUBKEY>`.
- A checkpoint in an hour anchored after `T`: `anchored` with `evidence.signer` equal to `<NEW_PUBKEY>`.
- Read `signer_set` in the answer: `source` is `env`, `entries` is the count you expect, and `rotation_issues` holds nothing you do not expect (step 4 explains the one that is normal).
- `mismatch` with *signer … signed at …, outside its valid window […)* on an anchor you expected to pass means `T` was wrong, or the new key signed before `T`. `mismatch` with *is not in the signer set* means the key is missing from `SUBSTRATE_ANCHOR_SIGNER_SET` (and from any applied note): re-read steps 3 and 4. `unverified` with `signer_set_complete: false` is the limit below, not tampering.

### 8. Retire the old keypair file (OPERATOR ONLY)

Verification uses public keys only, so the old keypair file can be removed from the host once you have verified step 7 and no run needs it. Keep `<OLD_PUBKEY>` in your records and in `SUBSTRATE_ANCHOR_SIGNER_SET`: it stays in the set as `[0, T)`.


## Emergency rotation (suspected compromise of the old key)

1. **OPERATOR ONLY: stop signing with the old key now.** `systemctl stop substrate-anchor.timer`, and do not trigger the service.
2. Generate and fund the new key (step 1), install it, then set the signer set with the old key ending at `T` (step 3), record the note (step 4) and switch the job (step 5).
3. Use `T` = the moment you stopped signing with the old key, or the earliest moment you can justify, in the signer set (step 3) and as the note's `effective_from_ms` (step 4), **never earlier than 24 hours before the note's own timestamp**: a note that reaches further back is ignored whole. The signer set has no such bound, which is why the set comes first: from `T` on, any anchor the old key signs reads `mismatch`.
4. Start the timer (step 6) and verify (step 7).

What this does and does not do:

- It **does** make every old-key transaction with a block time at or after `T` unacceptable, including forgeries.
- It does **not** revoke anchors the old key signed before `T`, and it cannot reach back more than 24 hours. Anchors signed between the real compromise and `T` still pass the signer check.
- It does not matter much for the root. `checkpoint_verify` **recomputes** the hour's root from the ledger and compares it with the memo the row names, so a forged memo whose root differs reads `mismatch` whoever signed it. The signer check protects against a memo that is *right* being attributed to the wrong party, and against an attacker who could also alter the ledger row.
- Re-anchoring suspect hours with the new key has the same open point as the reset runbook: the job does not write an hour that already has a row (`docs/runbooks/devnet-reset-and-reanchor.md`, "Open point"). Do not edit rows by hand.

## Limits

- **The rotation note is found by paging the operator surface's notes** (pages of 500, at most 50 pages per surface, at most 8 surfaces; `ROTATION_READ_MAX_PAGES`), keeping only the `anchor.signer.rotate` ones, so unrelated notes no longer hide it. If the read is still cut by that cap, cannot advance, or fails, the answer carries `signer_set_complete: false` and `signer_set.read_gap` names why, and the verdict is never `anchored`: an anchor that would verify, and a `mismatch` that only the signer set explains, become `unverified` with reason `rotation-read-incomplete` (a missed note may have retired the signer). That is safe, not correct. A signer whose window closed at or before the anchored hour started reads `mismatch` with reason `signer-retired`: the read was complete, so this is a known bad signature, not an unknown one, and a rollback refuses on it unless `--force`. Only `rotation-read-incomplete` stays `unverified`. With `SUBSTRATE_ANCHOR_SIGNER_SET` the keys that matter do not depend on the read at all, which is why step 3 comes first.
- **A note that is ignored is reported** in `signer_set.rotation_issues` (at most ten, event id and rule only). A note from a non-operator surface is never read and so never listed.
- **`SUBSTRATE_ANCHOR_SIGNER_SET` is read at boot.** A change takes a restart of `substrate-mcp`. Unset, the bootstrap is `SOLANA_ANCHOR_PUBKEY` alone, which reproduces the old single-key behaviour (and the old trap: changing that variable then drops the old key from the set).

## Abort and rollback

- Before step 3, nothing is committed: remove the keypair file and stop. Steps 3 and 5 are edits of `/etc/substrate/substrate.env` (and a restart of `substrate-mcp`), so they can be edited back.
- After step 4, the note cannot be deleted (the ledger is append-only). Undo a wrong cutover with a **second** rotation (`old_pubkey` = the key that is wrong, `new_pubkey` = the one to return to) with a new `T` after the first, and the same change in `SUBSTRATE_ANCHOR_SIGNER_SET`: append the entry and close the wrong key's window at the new `T`.
- A transaction already sent cannot be taken back.

## What this does not prove

- A valid signer window says a key the operators named wrote the memo at that time. It does not say the key was safe, or that the operator surface that named it was.
- Nothing here makes devnet storage, or a durable witness: a reset ends it (`docs/runbooks/devnet-reset-and-reanchor.md`).
