---
phase: 06-ledger
plan: 02
subsystem: ledger-core
tags: [wave-1, rfc6962, merkle, memo-v1, hour-buckets, solana-cli, json-rpc, d-06, d-09, d-10, t-06-02-01, t-06-02-02, t-06-02-03, t-06-02-04, t-06-02-05]

requires:
  - phase: 06-ledger
    provides: 06-BASELINE.md (534/0/29, tsc clean) from 06-01
provides:
  - packages/ledger/src/merkle.ts — merkleRoot, merkleRootHex, hexToBytes, bytesToHex (RFC 6962, pinned by the eight Trillian/CT roots)
  - packages/ledger/src/memo.ts — MEMO_PREFIX, MEMO_RE, formatMemo, parseMemo, MEMO_PROGRAM_IDS (v4/v3/v1), stripListingPrefix, type Memo
  - packages/ledger/src/period.ts — HOUR_MS, hourStart, hourEnd, hourIso, isClosed, closedHours
  - packages/ledger/src/solana.ts — SOLANA_CLI_DEFAULT, keygenPath, AMOUNT_ZERO, AMOUNT_ONE_LAMPORT, transferMemoArgv, pubkeyArgv, parseSignature, RunResult, Runner, execFileRunner
  - packages/ledger/src/rpc.ts — createRpc → Rpc { transactionMemo, addressMemos, balance }, RpcError, bs58decode, types TransactionMemo/AddressMemo/RpcOptions/Commitment
affects: [06-06, 06-07]

actuals:
  tasks: 3
  commits: 4         # 993669e, 57d82e8, fe031f1 + this SUMMARY
plan_head_before: c300d9d

tech-stack:
  added: []
  patterns:
    - "Credential-spending code as pure argv builders plus an injected execFile Runner (shape copied from host/hostfns.ts, not imported)"
    - "JSON-RPC client with injectable fetch and sleep; transport/HTTP/non-JSON failures retry, JSON-RPC error objects do not"

key-files:
  created:
    - packages/ledger/src/merkle.ts
    - packages/ledger/src/merkle.test.ts
    - packages/ledger/src/memo.ts
    - packages/ledger/src/memo.test.ts
    - packages/ledger/src/period.ts
    - packages/ledger/src/period.test.ts
    - packages/ledger/src/solana.ts
    - packages/ledger/src/solana.test.ts
    - packages/ledger/src/rpc.ts
    - packages/ledger/src/rpc.test.ts
  modified: []

key-decisions:
  - "JSON-RPC error objects throw RpcError immediately (deterministic); only fetch rejections, non-2xx HTTP and non-JSON bodies consume retry attempts"
  - "transferMemoArgv also refuses a relative CLI path (the plan requires the absolute path)"
  - "A memo instruction whose base58 data does not decode yields memo null instead of throwing (untrusted endpoint; verify treats it as no memo)"
  - "Rpc is a named exported interface (not ReturnType<typeof createRpc>) so 06-06/06-07 import the contract by name"

requirements-completed: []
---

# Phase 6 Plan 02: Ledger core — Summary

The anchor job (06-06) and verify (06-07) now share one tested definition of the tree, the memo
text, the hour, the only signable transaction and the devnet read-back. No live change: nothing
here talked to Greptime, ran `solana` or opened a socket outside test fakes (no RESTORE.d file,
by design — RESTORE.md lists no 06-02 live change).

## Task 1 — RFC 6962 Merkle root (commit 993669e)

- `merkleRoot`: leaf SHA256(0x00‖b), node SHA256(0x01‖L‖R), split at the largest power of two
  below n, empty input throws; `Bun.CryptoHasher`, one `update()` per part.
- Tests: all eight reference roots n=1…8, empty throws, one-leaf ≠ plain SHA-256, swapped leaves
  change the root, hex round-trip and rejects, `merkleRootHex` equivalence and entry validation.

## Task 2 — memo v1 and hour buckets (commit 57d82e8)

- `formatMemo` → `substrate:v1:2026-09-26T10:00:00.000Z:<64 hex>:79` (105 chars); throws on
  non-hour period, non-lowercase/short root, count 0/negative/non-integer.
- `parseMemo` uses the anchored regex `^substrate:v1:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*)$`;
  null for uppercase hex, minutes ≠ 00, count 0, "079", trailing text, v2, extra segment, "".
- `MEMO_PROGRAM_IDS` = {Memo4c2p…, MemoSq4…, Memo1Uhk…}; `stripListingPrefix` drops `[len] `.
- Hours half-open UTC: 10:00:00.000 and 10:59:59.999 → 10:00, 11:00:00.000 → 11:00;
  `closedHours(from, 11:04:59.999, 5 min)` excludes 10:00, at 11:05:00.000 includes it; ascending.

## Task 3 — solana argv/runner and devnet RPC reader (commit fe031f1)

- `transferMemoArgv` produces exactly
  `[cli, transfer, <pubkey>, 0|0.000000001, --with-memo, <v1 memo>, --url, <rpc>, --keypair, <path>, --fee-payer, <path>, --commitment, confirmed, --allow-unfunded-recipient, --output, json]`;
  refuses other amounts, non-v1 memos, non-base58 pubkeys, relative keypair paths, non-http(s)
  URLs; a nonexistent keypair path is accepted (never opened). `execFileRunner`: execFile argv,
  120 s, 4 MiB, HOME=/root, no shell (tested with `/bin/echo "$HOME;id"` passing through verbatim).
- `parseSignature` reads `{"signature":"<base58 64-88>"}`; errors quote ≤ 200 chars of output.
- `createRpc({ url, timeoutMs, attempts, backoffMs, fetchImpl?, sleep? })`: `AbortSignal.timeout`
  per call; `transactionMemo` (getTransaction jsonParsed, maxSupportedTransactionVersion 0) returns
  `{ memo, payer, payerSigned, err, fee, slot, blockTime }`, memo from `parsed` or base58 `data`
  of an instruction under any memo program id; `addressMemos` (getSignaturesForAddress, limit,
  prefix stripped); `balance` (getBalance value). Retries: one rejection → exactly one
  `sleep(backoffMs)`; `attempts` rejections → RpcError; JSON-RPC error → RpcError naming the code,
  ≤ 200 chars. `bs58decode("2NEpo7TZRRrLZSi2U")` = "Hello World!", leading "1" → zero byte.
- All rpc tests use a fake fetch against `https://rpc.test.invalid`; no network.

## Gates (two-sided vs 06-BASELINE.md)

| Gate | Result |
|---|---|
| Task 1 verify | exit 0 — root suite 561 pass / 0 fail / 32 files, tsc-exit=0 (Task 2 files already present, uncommitted) |
| Task 2 verify | exit 0 — root suite 579 pass / 0 fail / 34 files, tsc-exit=0 |
| Task 3 verify | exit 0 — root suite 579 pass / 0 fail / 34 files, tsc-exit=0, failing-id set identical (empty), last rpc.ts commit carries `Refs SPE-3576` |
| mcp-server imports in packages/ledger/src | 0 in all ten files |
| package.json / packages/ledger/package.json vs c31f820 | unchanged (no npm, pip or cargo change) |

Pass count 579 > agent-substrate-pass 534 (+45 tests: merkle 15, memo+period 12, solana+rpc 18).
Dispatcher untouched (no Python change), so pytest was not in this plan's gates.

## Deviations

- None from the plan's behavior list. Additions noted under key-decisions (relative CLI path
  refused; undecodable memo data → null; named `Rpc` interface).
- `packages/ledger/package.json` still points `main` at `src/index.ts`, which does not exist;
  not in this plan's file list, left for the plan that adds the entry point.

## Self-Check: PASSED
