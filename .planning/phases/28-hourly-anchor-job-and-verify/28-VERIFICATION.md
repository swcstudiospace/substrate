---
phase: 28-hourly-anchor-job-and-verify
verified: 2026-11-18T12:00:00Z
status: human_needed
score: 3/4 roadmap success criteria verified in code; criterion 4 requires the operator devnet window
covered_files: ["infra/vps/substrate-anchor.service", "infra/vps/substrate-anchor.service.d/10-environment.conf", "infra/vps/substrate-anchor.timer", "packages/cli/src/index.ts", "packages/ledger/src/rpc.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/src/anchor-run.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "scripts/greptime-smoke.ts"]
covered_digest: "v3:sha256:6eb4fbfb536b3f7d9cd8587b02063deb954d529cd8ad8bb9c64b3043eb55001e"
behavior_unverified: 2
overrides_applied: 0
prior_record: ".planning/milestones/v1.3-phases/28-hourly-anchor-job-and-verify/28-VERIFICATION.md (archived, verified at 2026-10-10/11 on a different HEAD; not reused as evidence)"
behavior_unverified_items:
  - truth: "A closed hour is anchored on devnet with a memo root equal to the recomputed root, and re-running the timer adopts the existing memo (criterion 4, live half)"
    test: "Operator window: fund the devnet anchor key, install and enable substrate-anchor.timer, emit a proof graph, let an hour close, run the anchor job, then re-run it"
    expected: "One anchors row per closed hour; the re-run prints adopted and sends nothing; verify reports anchored for every hour"
    why_human: "Requires a live devnet send with a real funded key and the production stack; not runnable from this checkout"
  - truth: "Altering one event on a scratch ledger makes verify exit 1 naming that hour (criterion 4, tamper half, end-to-end run)"
    test: "Run scripts/greptime-smoke.ts against the rehearsal scratch stores (loopback only); beat 5 appends one event after anchoring"
    expected: "verify exits 1 with hours[0].status mismatch naming the hour; chain still intact; no send"
    why_human: "The harness refuses to run from this checkout (rehearsal UNIT_WORKING_DIRECTORY guard) and needs live loopback GreptimeDB; not re-run here"
human_verification:
  - test: "Devnet anchor end to end (criterion 4, first half)"
    expected: "Closed hour anchored on devnet; anchors row written with cluster devnet; memo root equals the recomputed root; verify reports anchored; re-run adopts the existing memo and sends nothing"
    why_human: "Live devnet send from the operator-approved window with a funded key; the record must never print the key value"
  - test: "Live anchors table matches the canonical shape (criterion 2)"
    expected: "Production anchors table has the same 11 columns as CREATE TABLE in greptime.ts (period_start..anchored_at plus stale_hashes); no startup warning 'anchors does not match production's period-keyed shape'"
    why_human: "Only the live production store can show it; the code only encodes the canonical shape and warns on mismatch"
  - test: "Tamper by in-place alteration (criterion 4, second half)"
    expected: "Editing one stored event hash or payload on a scratch ledger makes `substrate verify <graph>` exit 1 and print a line naming that hour"
    why_human: "The scratch harness and unit tests prove an appended event moves the root (mismatch) and that a changed digest changes the root; no test drives an in-place alteration through verifyGraph end to end"
gaps: []
---

# Phase 28: Hourly Anchor Job and Verify Verification Report

**Phase Goal:** Each closed hour is anchored exactly once on Solana devnet, and anyone can check a graph's events against those anchors.
**Verified:** 2026-11-18 (HEAD `357d6b15` on branch `gsd/autonomous-rerun`)
**Status:** human_needed
**Re-verification:** No for this directory. The phase directory `.planning/phases/28-hourly-anchor-job-and-verify/` did not exist before this record; the v1.3 record in `.planning/milestones/` was read for context only and is not evidence.

## Goal Achievement

### Observable Truths

Source of truth: the four Success Criteria in `.planning/ROADMAP.md` (Phase 28). Each criterion is treated as a truth.

| # | Truth (roadmap success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Hourly timer anchors the previous hour idempotently; re-run adopts an existing signer-checked memo; root mismatch alarms and exits 1 | ✓ VERIFIED | Timer: `infra/vps/substrate-anchor.timer` has `OnCalendar=hourly` and `Persistent=true`; service `infra/vps/substrate-anchor.service` is `Type=oneshot` with no `Restart=`, `ExecStart` runs `packages/mcp-server/src/anchor-run.ts`. Job: `packages/mcp-server/src/anchor.ts` `checkAdopt` (~L269-330) adopts only a memo whose `transactionMemo` confirm has payer = pubkey, `payerSigned`, `err === null`, v1 parse and this period, with same root and count; a different root or count returns `alarm`, which writes `root-mismatch`, prints `ALARM` to stderr, and sets exit 1 (~L676-677; result code at L485-487). Targeted run: `bun test src/anchor.test.ts src/anchor-run.test.ts` gives 52 pass, 0 fail. Note: the job anchors every closed, non-empty, unanchored hour in a 7-day lookback (cap 24), not only the literal previous hour. The hourly tick makes the two the same in steady state. |
| 2 | Anchor sent through solana CLI with only the keypair path on argv, devnet only, writes an `anchors` row with ten fields; DDL matches production | ✓ VERIFIED (code). Live-match part is a human item. | argv: `packages/ledger/src/solana.ts` `transferMemoArgv` builds `cli transfer <pubkey> <0|1-lamport> --with-memo <memo> --url --keypair <path> --fee-payer <path> --commitment confirmed --allow-unfunded-recipient --output json`, no shell (`execFileRunner`). Keypair is passed as a path only. Devnet: `anchor.ts` `assertDevnetCluster` compares `getGenesisHash` to `DEVNET_GENESIS_HASH` (L59) before adopt (L305) and before send; `packages/ledger/src/rpc.ts` refuses mainnet or testnet hostnames (L22, L48); `anchorRow` sets `cluster: "devnet"` (anchor.ts L350). Row: `greptime.ts` `insertAnchor` writes ten populated fields (period_start, period_end, root, event_count, memo, tx_sig, signer, cluster, slot, anchored_at) plus `stale_hashes` NULL, which is the 11-column production shape. DDL: `greptime.ts` `CREATE TABLE IF NOT EXISTS "anchors"` matches the canonical shape guard (`canonicalShape`, ~L1080); a live mismatch only raises a startup warning, and nothing here reads the live table. |
| 3 | `substrate verify <graph_id>` and `POST /verify` check the chain and per hour compare recomputed root with memo read by `tx_sig`; `pending` up to 3 h after close; `unverified` when devnet cannot be read | ✓ VERIFIED | Route: `packages/mcp-server/src/server.ts` L1615 `POST /verify` calls `substrate.verifyGraph`. CLI: `packages/cli/src/index.ts` posts to `/verify` and prints per-hour lines; exits `body.ok ? 0 : 1`. Hour logic: `service.ts` `checkHour` (~L8515-8580) returns `pending` while the hour is open or `now < hourEnd + VERIFY_PENDING_MS` (`VERIFY_PENDING_MS = 3 * HOUR_MS`, L792); `unverified` for missing pubkey, genesis-read failure, non-devnet genesis, unreadable or missing tx, and `ReanchorReadIncomplete`; `mismatch` for a missing memo or a bad signer; `unanchored` after 3 h. `ok` is false on any hour not `anchored` or `pending` (service.ts ~L8308). Targeted run: `bun test src/service.test.ts -t "pending|unverified|unanchored past|mismatch"` gives 23 pass, 0 fail. |
| 4 | Closed hour anchored on devnet with memo root equal to recomputed root; altering one event on scratch ledger makes verify exit 1 naming that hour; untouched graph verifies with every hour anchored; re-run adopts | ? UNCERTAIN (human). Partly proven in code. | Devnet anchor: needs the live operator window, so it is human_needed by the verification rules. Re-run adopts: `anchor.test.ts` adopt block (passes in the targeted run); `scripts/greptime-smoke.ts` beat 4 (crash between send and row write, next run adopts) and beat 2 (untouched graph, every hour anchored). Tamper: `scripts/greptime-smoke.ts` beat 5 appends one event after anchoring and asserts `verify` fails with `hours[0].status === "mismatch"` naming the hour, with `chain.ok` still true and no send. **Deviation:** the criterion says *altering* one event; the proof *appends* one. Append moves the root, so the mismatch logic is the same, but an in-place alteration of a stored event is not driven end to end through `verifyGraph` anywhere in the repo. `service.test.ts` ~L2600 covers only the digest-level root change. The smoke harness was not re-run here. |

**Score:** 3/4 criteria verified in code; criterion 4 needs the operator devnet window and an in-place tamper run. No criterion is FAILED.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `infra/vps/substrate-anchor.timer` | OnCalendar=hourly, Persistent=true | ✓ VERIFIED | Literal values present |
| `infra/vps/substrate-anchor.service` | Oneshot anchor job, no Restart= | ✓ VERIFIED | Type=oneshot; ExecStart anchor-run.ts |
| `infra/vps/substrate-anchor.service.d/10-environment.conf` | EnvironmentFile for SOLANA_* | ✓ VERIFIED | EnvironmentFile=/etc/substrate/substrate.env |
| `packages/mcp-server/src/anchor.ts` | Adopt/send/alarm orchestration, devnet gate, row write | ✓ VERIFIED | 845 lines; the paths above |
| `packages/mcp-server/src/anchor-run.ts` | Entry point, exit code | ✓ VERIFIED | `process.exit(result.code)` |
| `packages/ledger/src/solana.ts` | transferMemoArgv, keypair path only | ✓ VERIFIED | Absolute CLI and keypair checks |
| `packages/ledger/src/rpc.ts` | getGenesisHash, devnet host guard | ✓ VERIFIED | NON_DEVNET_HOST_RE |
| `packages/mcp-server/src/greptime.ts` | anchors DDL, insertAnchor, anchorForPeriod | ✓ VERIFIED (code) | 11-column DDL; live match is human |
| `packages/mcp-server/src/service.ts` | verifyGraph hour report, checkHour, VERIFY_PENDING_MS | ✓ VERIFIED | pending, unverified, mismatch, unanchored |
| `packages/mcp-server/src/server.ts` | POST /verify | ✓ VERIFIED | L1615 |
| `packages/cli/src/index.ts` | `substrate verify` prints hours, exit 1 on failure | ✓ VERIFIED | `return body.ok ? 0 : 1` |
| `scripts/greptime-smoke.ts` | Scratch six-beat proof (send, untouched, re-run, crash, tamper) | ⚠️ PARTIAL | Exists; tamper is an append; not re-run (needs loopback stack) |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| timer | service | `Unit=substrate-anchor.service` | ✓ WIRED | Timer names its unit |
| service | anchor job | `ExecStart=... anchor-run.ts` | ✓ WIRED | anchor-run imports runAnchorJob |
| anchor job | solana CLI | `transferMemoArgv` through `execFileRunner` | ✓ WIRED | argv, no shell |
| anchor job | anchors row | `storeAnchor` to `greptime.insertAnchor` | ✓ WIRED | after the read-back check |
| verify (CLI) | POST /verify | `post("/verify", ...)` | ✓ WIRED | server.ts L1615 |
| POST /verify | verifyGraph | `substrate.verifyGraph` | ✓ WIRED | |
| verifyGraph | devnet read-back | `checkHour` uses `readRpc().transactionMemo` | ✓ WIRED | with genesis check |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| anchors row | root, count, tx_sig | recomputed hour digest plus the confirmed transaction | Yes (code) | ✓ FLOWING (code); live devnet data is a human item |
| verify hour report | status | `greptime.anchorForPeriod` plus devnet `transactionMemo` | Yes (code) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Anchor job adopt, alarm, send, candidates, exits | `cd packages/mcp-server && bun test src/anchor.test.ts src/anchor-run.test.ts` | 52 pass, 0 fail | ✓ PASS |
| Verify hour verdicts: pending, unverified, unanchored, mismatch | `cd packages/mcp-server && bun test src/service.test.ts -t "pending\|unverified\|unanchored past\|mismatch"` | 23 pass, 0 fail | ✓ PASS |
| Scratch six-beat proof (tamper by append) | `scripts/greptime-smoke.ts` | Not run | ? SKIP (needs loopback GreptimeDB; harness refuses this checkout) |
| Live devnet anchor | none | Not run | ? SKIP (operator window, funded key) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared for this phase. Skipped.

### Requirements Coverage

ANCHOR-03, ANCHOR-04, ANCHOR-05, ANCHOR-06 are the roadmap requirements for Phase 28. `.planning/REQUIREMENTS.md` was not re-read for this record; the roadmap success criteria map to them 1:1 (criterion 1 to ANCHOR-03, 2 to ANCHOR-04, 3 to ANCHOR-05, 4 to ANCHOR-06). Criteria 1 to 3 are SATISFIED by the evidence above. ANCHOR-06 is SATISFIED for the scratch tamper with append, and the devnet and in-place alteration parts remain human items.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `scripts/greptime-smoke.ts` | 553-572 | Tamper is an append, not an alteration | ⚠️ Warning | Proof text differs from the roadmap wording (criterion 4) |

No `TBD`, `FIXME`, `XXX`, or `TODO` markers were found in the covered implementation files.

### Human Verification Required

### 1. Devnet anchor end to end (criterion 4, first half)

**Test:** In the operator window, fund the devnet anchor key, install and enable `substrate-anchor.timer`, emit a proof graph, wait for the hour to close, run the job, then run it again.
**Expected:** A closed hour is anchored on devnet with the memo root equal to the recomputed root. The `anchors` row has `cluster=devnet`. The re-run prints `adopted` and sends nothing. `substrate verify <graph>` reports `anchored` for every hour.
**Why human:** A live devnet send needs a funded key and the production stack. The record must not print the key value.

### 2. Live `anchors` table matches the canonical shape (criterion 2)

**Test:** Compare the production `anchors` table column list with `CREATE TABLE "anchors"` in `packages/mcp-server/src/greptime.ts`. Check that no startup warning about the period-keyed shape is logged.
**Expected:** Same 11 columns and types (`stale_hashes` BIGINT, NULL on every job-written row).
**Why human:** Only the live production store can show it.

### 3. In-place alteration tamper (criterion 4, second half)

**Test:** On a scratch loopback ledger, alter the stored hash or payload of one event in an anchored hour and run `substrate verify <graph>`.
**Expected:** Exit 1, with a line naming that hour (`hour <ISO> does not match its anchor`) or a chain-broken line naming the event, and `ok` false.
**Why human:** The existing proofs append an event (beat 5 of `scripts/greptime-smoke.ts`) or check the digest directly (`service.test.ts` ~L2600). No test drives an in-place alteration through `verifyGraph` end to end, and the smoke harness needs the rehearsal stack.

## Gap Summary

No BLOCKER gaps. Criteria 1 to 3 hold in code and in the targeted tests run above. Criterion 4 is `human_needed`: the devnet half needs the operator window, and the tamper half is proven only for appended events in the scratch harness, which was not re-run here.

**Notes on scope:** This record checks HEAD `357d6b15` on `gsd/autonomous-rerun`. The v1.3 record in `.planning/milestones/` (verified at `35c8f5b` and `ed696ef`) is a different HEAD and was not used as evidence. No live stack was run, no test suite beyond the two targeted runs, and no code or commits were changed.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
