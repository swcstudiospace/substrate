---
phase: 28-hourly-anchor-job-and-verify
reviewed: 2026-10-11T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - packages/mcp-server/src/anchor.ts
  - packages/mcp-server/src/anchor-run.ts
  - packages/mcp-server/src/anchor.test.ts
  - packages/mcp-server/src/greptime.ts
  - packages/mcp-server/src/service.ts
  - packages/ledger/src/rpc.ts
  - packages/ledger/src/memo.ts
  - packages/ledger/src/solana.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/observe.ts
  - packages/cli/src/index.ts
  - infra/vps/substrate-anchor.service
  - infra/vps/substrate-anchor.timer
  - infra/vps/substrate-anchor.service.d/10-environment.conf
  - infra/vps/README.md
  - docs/greptime-ledger.md
  - scripts/greptime-smoke.ts
  - .env.example
findings:
  critical: 1
  warning: 0
  info: 4
  total: 5
status: issues_found
---

# Phase 28: Code Review Report

**Reviewed:** 2026-10-11
**Depth:** standard
**Files Reviewed:** 20 (4 plans, CONTEXT, 4 summaries, anchor.ts, anchor-run.ts,
typed Greptime methods, rpc.ts, verify hour report, three entry doors, units,
docs, smoke harness, tests — exactly as declared)
**Status:** issues_found

## Summary

Static review only: no code, test, runtime, CLI, gate, or devnet execution was
performed. All traces below are source-against-source.

What holds up: the 24-hour ascending sweep (`anchor.ts` candidates loop) only
treats closed, non-empty, unanchored hours from the coverage start as candidates;
D28-07 preconditions (absolute keypair path, keygen-pubkey equality, devnet
genesis hash, funded balance) run before the first send; adopt-before-every-send
(`checkAdopt`) requires the `transactionMemo` confirm (memo program, payer
equality, payerSigned, err null, v1 parse, period match, root+count equality);
the listing-hint `[len]` prefix is stripped in the RPC layer (`rpc.ts`
`addressMemos`), not forgotten at the call site; root mismatch writes the row as
found, emits `anchor.failed`/`root-mismatch`, prints the ALARM, and ends the run
with exit 1; the lost-row race is closed by the pre-send `anchorForPeriod`
re-read; `verifyGraph` fail-closes (`unverified`), keeps evidence chain-only via
`anchors: false` (`observe.ts`), and never puts event content on chain. The
`anchor.test.ts` matrix (adopt/alarm/send/exit cases by name) is behavioural,
not wiring-copy. The fake-chain harness carries no `SOLANA_*` names and talks
loopback-only. `28-04-SUMMARY.md` honestly records 47/47 isolated plus L1–L10
all DEFERRED.

The seal blocker is not a code bug: **no live devnet, model, or production
evidence exists** — the 0-lamport send and the memo program id stay
`[UNVERIFIED]`, so Phase 28 must not seal until the L1–L10 window runs or the
operator explicitly defers it as `human_needed`. Below that are 4 info items.
No funding, deploy, or live-pass claim is made anywhere in this report.

An earlier draft of this review carried three warnings (WR-01 alarm telemetry,
WR-02 funding threshold, WR-03 unit timeout). All three were reassessed against
the declared contracts and withdrawn or downgraded — see `## Reassessment`
below. They are recorded there, not as findings, so no post-hoc scope expansion
survives in the verdict.

## Critical Issues

### CR-01: Live proof L1–L10 entirely deferred — phase seal blocked

**File:** `.planning/phases/28-hourly-anchor-job-and-verify/28-04-SUMMARY.md`
(live runbook section, L1–L10 all `DEFERRED`)
**Issue:** ANCHOR-06 has two halves and only the isolated half is proven. The
recorded 47/47 fake-chain run proves crash-adopt, silent re-run, and
tamper-mismatch-naming-the-hour with the chain intact — but no real devnet
packet was sent, no production row written, no unit installed. The
`28-01-SUMMARY.md` 0-lamport send stays `[UNVERIFIED]` and the D27-06 memo
program id stays still-open until L8. Marking Phase 28 complete or ANCHOR-03–06
satisfied on the fake chain alone would be a fake live pass.
**Fix:** Do not seal Phase 28. Either run L1–L10 one gate at a time in an
operator-approved window with a funded key (parent goal-verifies as
`human_needed` after security/source evidence), or record an explicit operator
deferral. No code change satisfies this finding.

## Warnings

None. All warning candidates were withdrawn on reassessment (see below).

## Info

### IN-01: `checkHour` does not validate the row's `signer`/`cluster` fields

**File:** `packages/mcp-server/src/service.ts:2977-3015`
**Issue:** Verify re-checks the devnet memo (payer, signature, err, v1 parse,
period, root+count) and the row-vs-memo agreement on root/count/memo, but never
compares `row.signer` to `SOLANA_ANCHOR_PUBKEY` or `row.cluster` to `"devnet"`.
Trust correctly comes from the read-back, so a tampered attribution column
cannot forge `anchored` — this is defense-in-depth only.
**Fix:** Add a row-attribution check before the memo checks, reporting
`mismatch` when `row.signer !== pubkey || row.cluster !== "devnet"`.

### IN-02: `--period --dry-run` preview ignores the adopt path

**File:** `packages/mcp-server/src/anchor.ts:476-490`
**Issue:** The dry-run block prints `would anchor` from the peeked digest
without consulting `checkAdopt`. For an already-anchored hour (the D28-21
`--period <H>` re-run case) it previews `would anchor`, while the real path
would adopt-without-write or print `already anchored`. Misleading preview for
the exact operator command the runbook prescribes.
**Fix:** In the `only`-plus-`dryRun` case, note the row state, e.g.
`would adopt <period> (<tx_sig>)` when `anchorForPeriod` hits.

### IN-03: Null devnet slot is stored as `0`

**File:** `packages/mcp-server/src/anchor.ts:318`, `:680`
**Issue:** `confirmed.slot ?? hint.slot ?? 0` and `readBack.slot ?? 0` persist
slot `0` when the RPC returns no slot. Slot 0 is a real (genesis-adjacent) slot
value, so a future reader cannot distinguish "RPC gave no slot" from "slot
zero". Verify never compares slots, so no verdict impact today.
**Fix:** Document the sentinel at the call sites, or store the row's slot as
nullable if the DDL permits.

### IN-04: Funding gate covers one fee while a run may send up to 24

**File:** `packages/mcp-server/src/anchor.ts:57`, `:70`, `:255`
**Issue:** `REQUIRED_BALANCE_LAMPORTS` (rent-exempt minimum + one 5,000-lamport
fee) is checked once before the first send, exactly as D28-07 declares. A
catch-up run with a marginally funded key can therefore anchor its first hour
and then stop `send-failed` on the second. This is bounded, by-design partial
progress (D28-06 systemic stop, next tick retries) — recorded here as an
observation only, not a defect: raising the threshold to the full 24-send
budget would expand the declared D28-07 contract without consumer evidence of
harm.
**Fix (only if the operator observes repeated partial catch-ups):** require
rent plus `MAX_HOURS_PER_RUN` fees, or re-check balance before each send.

## Reassessment

Three warning candidates from the first draft were challenged and re-examined
against the source contracts. Verdicts:

- **Ex-WR-01 (alarm omits conflicting tx_sig) — WITHDRAWN.** The premise was
  factually wrong: the alarm path writes the anchors row *as found* with the
  conflicting memo's signature (`anchor.ts:540`,
  `anchorRow(digest, verdict.signature, …)`), and the row retains `tx_sig`,
  `slot`, `memo`, root, and count. The conflicting transaction is recoverable
  from the row the D28-08 contract already mandates. Further, the proposed fix
  (extra `tx_sig` in the `anchor.failed` payload) would expand the closed
  reason/telemetry set that D28-10 pins exactly to the `EVENT_SOURCES` samples.
  The declared stderr line (period + root comparison) matches the contract
  verbatim. No finding remains.
- **Ex-WR-02 (funding threshold) — DOWNGRADED to IN-04 above.** The code
  implements D28-07 exactly ("balance covers the rent-exempt minimum plus
  fees", before the first send). No incorrect behavior and no evidenced
  consumer harm; partial-run-then-retry is the specified D28-06 semantics.
- **Ex-WR-03 (missing TimeoutStartSec kills catch-up runs) — WITHDRAWN.** The
  90-second kill mechanism assumed the generic `DefaultTimeoutStartSec` applies
  to oneshot start; per `systemd.service(5)`, the start timeout is disabled by
  default for `Type=oneshot`. The premise was never verified against the
  primary source, so the finding is retracted in full rather than salvaged.

## Coverage G1–G5

Per parent direction, actual consumer/proof gaps G1–G5 will be closed
separately. Nothing in this review approves, schedules, or executes any live
step.

---

_Findings exclude L-step execution, funding, deploys, and any live
devnet/production claim by design — static verdict only, no fake live pass._
_Reviewed: 2026-10-11_
_Reviewer: Claude (gsd-code-reviewer, Phase28NativeReview)_
_Depth: standard_
