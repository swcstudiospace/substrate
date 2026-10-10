---
phase: 28-hourly-anchor-job-and-verify
plan: "01"
subsystem: ledger
tags: [anchoring, solana, devnet, adopt, alarm, append-only]

requires:
  - phase: 27-ledger-primitives-and-ingest-order
    provides: GreptimeClient.hourLeaves, Substrate.hourDigest, INGEST_LAG_MS, canonical anchors DDL, event_ingest
provides:
  - GreptimeClient anchorsBetween/anchorForPeriod/insertAnchor/firstIngestMs, four typed statements through the existing SQL door
  - Rpc.getGenesisHash, the only edit to a ported ledger file
  - anchor.ts runAnchorJob, pure orchestration over injected greptime/substrate/runner/rpc/clock/env
  - anchor-run.ts thin entry with --period/--dry-run, exit 2 on missing SOLANA_* config
  - SubstrateConfig.solana plus the four .env.example names
affects: [28-02 (verify hour report), 28-03 (units run anchor-run.ts), 28-04 (fake-chain proof)]

actuals:
  tasks: 4
  commits: 3

key-files:
  modified:
    - packages/mcp-server/src/greptime.ts
    - packages/mcp-server/src/greptime.test.ts
    - packages/ledger/src/rpc.ts
    - packages/ledger/src/rpc.test.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/config.test.ts
    - .env.example
  created:
    - packages/mcp-server/src/anchor.ts
    - packages/mcp-server/src/anchor.test.ts
    - packages/mcp-server/src/anchor-run.ts

key-decisions:
  - "Base gate passed before any anchors write: hourLeaves, hourDigest, INGEST_LAG_MS, event_ingest and the canonical anchors DDL are all on origin/main (Phase 27 #29 merged); no BLOCKED-for-Phase-27-merge"
  - "NewAnchor.cluster is typed 'devnet': mainnet is forbidden at the type level, not just by convention"
  - "Preconditions run lazily before the first send (D28-07 order: absolute path, keygen equality, devnet genesis, funded balance), so an all-adopt run never touches the key or the RPC gates"
  - "--period bypasses the dedup skip so an anchored hour takes the adopt path (row unchanged, adopted:true emitted, nothing sent); an anchored hour with no confirmable memo is left alone rather than double-sent"
  - "DEVNET_GENESIS_HASH lives in anchor.ts, not the ledger package, keeping the rpc.ts diff to exactly the getGenesisHash addition"
  - "The job never opens the keypair: solana-keygen pubkey <path> is the CLI reading it; keypair-as-non-absolute maps to send-failed (anchor-run.ts already exits 2 on it)"

requirements-completed: [ANCHOR-03, ANCHOR-04]

coverage:
  - id: D28-01
    description: "anchor.ts holds pure orchestration over injected ports; anchor-run.ts builds them from loadConfig() and SOLANA_* env"
    requirement: "ANCHOR-03"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/anchor.test.ts — 23 cases, all injected stubs, no real CLI/RPC/store"
        status: pass
    human_judgment: false
  - id: D28-05
    description: "candidates are closed, non-empty, unanchored hours from coverage start ascending, cap 24, 7-day lookback; empty hours never written"
    requirement: "ANCHOR-03"
    verification:
      - kind: unit
        ref: "anchor.test.ts candidates-and-exits block (nothing-to-do, empty skip, pre-coverage exclusion, dedup, cap-24-ascending, coverage-unreachable)"
        status: pass
    human_judgment: false
  - id: D28-06
    description: "per-hour digest failures continue; systemic failures (wrong cluster, signer mismatch, unfunded, rpc-unreadable, CLI/store failure) stop; exit 0 only when all anchored/adopted or nothing to do"
    requirement: "ANCHOR-03"
    verification:
      - kind: unit
        ref: "anchor.test.ts failures block (8 cases) plus digest-continues case"
        status: pass
    human_judgment: false
  - id: D28-07
    description: "send is transferMemoArgv unchanged (absolute CLI, self-transfer, --with-memo, --url, --keypair/--fee-payer path, confirmed, json via Runner, no shell); preconditions in order; 0-lamport, no amount retry"
    requirement: "ANCHOR-04"
    verification:
      - kind: unit
        ref: "anchor.test.ts send-path block pins the argv flags and AMOUNT_ZERO single-amount flow"
        status: pass
    human_judgment: false
  - id: D28-08
    description: "adopt-before-send with transactionMemo confirm; same root+count adopts (adopted:true, nothing sent); different root+count alarms (row as found, root-mismatch, ALARM line, exit 1)"
    requirement: "ANCHOR-03"
    verification:
      - kind: unit
        ref: "anchor.test.ts adopt-and-alarm block (adopt, alarm, unconfirmed-hint-sends, --period re-run adopt without row write)"
        status: pass
    human_judgment: false
  - id: D28-09
    description: "anchors row is the production 11-column shape with stale_hashes NULL, cluster devnet, dedup by period_start"
    requirement: "ANCHOR-04"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/greptime.test.ts — anchors block (window read, single-period read, 11-column insert, coverage start)"
        status: pass
    human_judgment: false
  - id: D28-10
    description: "anchor.written (note) and anchor.failed (warning) exactly as EVENT_SOURCES samples them, emitted in-process; CLI/RPC output in reason passes through redact(); closed reason set"
    requirement: "ANCHOR-04"
    verification:
      - kind: unit
        ref: "anchor.test.ts asserts session_id anchor:<YYYY-MM-DDTHH>, action/runtime anchor, no repo, plus AnchorFailReason closed union"
        status: pass
    human_judgment: false
  - id: D28-11
    description: "SOLANA_RPC_URL default, SOLANA_ANCHOR_KEYPAIR/PUBKEY required, SOLANA_CLI default; stale .env.example names replaced; missing config exits 2 with usage, sends nothing"
    requirement: "ANCHOR-04"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/config.test.ts — SOLANA_* block (defaults, four names, trim); parseAnchorArgs usage errors"
        status: pass
    human_judgment: false

duration: ~3h
completed: 2026-10-09
status: complete
---

# Phase 28 Plan 01: Hourly anchor job Summary

**The one-shot anchor job anchors closed, non-empty, unanchored hours via send-or-adopt with an alarm on root mismatch, over injected ports that keep every test off the real chain.**

## Accomplishments

- `GreptimeClient` gains four typed methods, all composed in `greptime.ts` with values never syntax: `anchorsBetween` (window read ascending), `anchorForPeriod` (single-period read), `insertAnchor` (11-column insert, `stale_hashes` NULL, `cluster` typed `"devnet"`), `firstIngestMs` (coverage start, ordered-limit read, null on empty store). Timestamps parse from millis or text.
- `Rpc.getGenesisHash` is the only edit to a ported ledger file (interface + `createRpc` + test); the devnet hash constant lives in `anchor.ts`.
- `anchor.ts runAnchorJob` implements D28-05…D28-10: coverage-start candidates ascending with cap 24 and 7-day lookback, lazy D28-07 preconditions, adopt-before-send with confirm, alarm-and-exit-1 on mismatch, systemic-stop on wrong-cluster/signer-mismatch/unfunded/rpc-unreadable/send-failed/store-failed, `--period` re-run adopt without row write, `--dry-run` preview.
- `anchor-run.ts` parses `--period/--dry-run` (pure `parseAnchorArgs`, usage errors exit 2), requires `GREPTIME_URL` and both anchor identity vars, shares one `GreptimeClient` between job and substrate, and exits with the job code.
- `SubstrateConfig.solana` plus `.env.example` naming exactly `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, `SOLANA_CLI`; stale `SOLANA_CLUSTER`/`SOLANA_KEYPAIR_PATH` gone.

## Task Commits

1. `5c392df` feat(28-01): anchors typed storage on GreptimeClient plus getGenesisHash on rpc
2. `4d773f8` feat(28-01): anchor job orchestration with adopt/send/alarm and exit matrix
3. `ad3e920` feat(28-01): anchor-run entry, SOLANA_* config, .env.example names

## Verification

- `bun test packages/ledger/src/rpc.test.ts` 15 pass. `bun test packages/mcp-server/src/greptime.test.ts` 89 pass. `bun test packages/mcp-server/src/anchor.test.ts` 23 pass. `bun test packages/mcp-server/src/config.test.ts` all pass. `store-lock.test.ts` 18 pass, diff empty.
- `bunx tsc --noEmit` clean.
- No live devnet call in this slice (stubs only); the 0-lamport send stays [UNVERIFIED] until the 28-04 live window.

## Deviations from Plan

- Two additions from the contract text: `--dry-run` preview flag and the `--period`-over-anchored-hour adopt-without-write path (D28-21 needs the latter for the live re-run proof). Both are additive options on `runAnchorJob`, covered by tests.
- `parseAnchorArgs`/`ANCHOR_USAGE`/`UsageError` live in `anchor.ts` rather than the entry point so tests pin them without spawning (the entry stays thin per D28-01).

## Rollback and lock (Task 4)

- No new store-lock exemption: `anchor.ts`/`anchor-run.ts` compose no SQL (no `.sql(` reaches the client outside `greptime.ts`); `store-lock.test.ts` diff is empty and green.
- Rollback is file-deletion: remove `anchor.ts`/`anchor-run.ts`/`anchor.test.ts`, the Task-1 methods, the `solana` config block and the `.env.example` lines; no other caller exists (verify in 28-02 reads but never requires the job).
- Phase-27-merge gate: PASSED — `hourLeaves`, `Substrate.hourDigest`, `INGEST_LAG_MS`, canonical anchors DDL and `event_ingest` all present on `origin/main`; no anchors write was attempted before the check.

## Threat notes

- **T-28-01 (candidate digest):** `hourDigest` recomputes whole per hour; digest throws name the event and fail only that hour.
- **T-28-02 (adopt path):** listing is hint-only; adoption requires `transactionMemo` confirm (memo program via the Rpc reader, payer equality, payerSigned, err null, v1 parse, period match, root+count equality); mismatch alarms and exits 1.
- **T-28-03 (signing path):** keypair path-only on argv, no shell, devnet genesis gate, pubkey equality gate; no loopback POST /anchor exists.
- **T-28-04 (disclosure):** memo carries period_start, root, count only; keypair never opened or logged; CLI/RPC output in reasons passes through `redact()`.
- **T-28-05 (double-anchor):** adopt-before-every-send plus dedup-by-period_start plus the already-anchored no-send guard.

## Self-Check: PASSED

Commits above exist; the test files pass as listed; the branch holds only 28-01 work on top of origin/main.
