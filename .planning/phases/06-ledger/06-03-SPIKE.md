# 06-03 devnet key and memo spike evidence

Recorded from observed output only. Measured 2026-09-27 (UTC) by plan 06-03, Task 1. The key file's
contents and any seed phrase were never printed, copied or logged; only keygen's line count is
recorded (its single line named the output path).

## Commands (Task 1)

```
S=/var/lib/substrate/phase6-baseline/06-03/20260927T064241Z
sudo install -d -m 0700 $S
sudo install -m 0600 /etc/substrate/substrate.env $S/substrate.env
sudo sha256sum $S/substrate.env
# RESTORE route written first: /var/lib/substrate/phase6-baseline/RESTORE.d/06-03.md
test ! -e /etc/substrate/ledger-devnet.json
sudo /root/.local/share/solana/install/active_release/bin/solana-keygen new --no-bip39-passphrase --silent -o /etc/substrate/ledger-devnet.json   # stdout+stderr line count only
sudo chown root:root /etc/substrate/ledger-devnet.json && sudo chmod 600 /etc/substrate/ledger-devnet.json
sudo stat -c '%a %U' /etc/substrate/ledger-devnet.json
sudo /root/.local/share/solana/install/active_release/bin/solana-keygen pubkey /etc/substrate/ledger-devnet.json
sudo tail -c1 /etc/substrate/substrate.env   # already a newline; nothing appended
# per name, only when `sudo grep -c '^<NAME>=' /etc/substrate/substrate.env` printed 0:
printf '%s\n' "SOLANA_RPC_URL=https://api.devnet.solana.com" | sudo tee -a /etc/substrate/substrate.env > /dev/null
printf '%s\n' "SOLANA_ANCHOR_KEYPAIR=/etc/substrate/ledger-devnet.json" | sudo tee -a /etc/substrate/substrate.env > /dev/null
printf '%s\n' "SOLANA_ANCHOR_PUBKEY=Fku22yAXxRWc3o5Yp35vaXgrbLvH2WAPPiThNPKPjivq" | sudo tee -a /etc/substrate/substrate.env > /dev/null
sudo grep -c '^SOLANA_' /etc/substrate/substrate.env
sudo stat -c '%a %U' /etc/substrate/substrate.env
/root/.local/share/solana/install/active_release/bin/solana balance Fku22yAXxRWc3o5Yp35vaXgrbLvH2WAPPiThNPKPjivq --url https://api.devnet.solana.com --lamports
/root/.local/share/solana/install/active_release/bin/solana airdrop 1 Fku22yAXxRWc3o5Yp35vaXgrbLvH2WAPPiThNPKPjivq --url https://api.devnet.solana.com --keypair /etc/substrate/ledger-devnet.json   # 3 attempts, 20 s apart
/root/.local/share/solana/install/active_release/bin/solana config get
stat -c '%Y %s' /root/.config/solana/id.json
```

`sudo diff $S/substrate.env /etc/substrate/substrate.env` shows only the three added `SOLANA_` lines.
No `solana config set` ran; every devnet command passed `--url` (and `--keypair` where it signs).

## Machine-readable (Task 1)

snapshot_dir=/var/lib/substrate/phase6-baseline/06-03/20260927T064241Z
env_snapshot_sha256=ace7bfef01e7ec54fd8ab9071d23772f7b176995b66be2d0074da93bbcf52a06
key_absent_before=true
keygen_output_lines=1
key_mode=600 root
pubkey=Fku22yAXxRWc3o5Yp35vaXgrbLvH2WAPPiThNPKPjivq
solana_env_lines=3
env_mode=600 root
airdrop_attempts=3
airdrop_result=refused
airdrop_error=Error: airdrop request failed. This can happen when the rate limit is reached.
balance_lamports=0
solana_config_rpc_after=http://127.0.0.1:8899
id_json_stat_unchanged=true

## Gaps

- The devnet RPC airdrop was refused on all 3 attempts (rate limit), so the key holds 0 lamports.
  Task 2's funding precondition (balance ≥ 100000000 lamports) is unmet; per D-05 the owner funds
  the pubkey above (user_setup step) before the memo spike runs. The agent did not use
  faucet.solana.com.
