---
phase: 28-hourly-anchor-job-and-verify
plan: "02"
subsystem: ledger
tags: [verify, anchoring, hour-report, devnet, fail-closed]

requires:
  - phase: 27-ledger-primitives-and-ingest-order
    provides: GreptimeClient.hourLeaves, Substrate.hourDigest, INGEST_LAG_MS, event_ingest first-record rule
  - plan: "01"
    provides: anchorsBetween/anchorForPeriod/insertAnchor/firstIngestMs, getGenesisHash, anchor job seams
provides:
  - Substrate.verifyGraph hour report with anchors-off evidence mode
  - graphIngest typed read with first-record collapse
  - additive POST /verify + events_verify verdicts and per-hour CLI lines
  - SubstrateConfig.verifyTimeoutMs (SUBSTRATE_VERIFY_TIMEOUT_MS)
affects: [28-03 (docs describe these verify states), 28-04 (fake-chain proof exercises them)]

actuals:
  tasks: 4
  commits: 3

key-files:
  modified:
    - packages/mcp-server/src/greptime.ts
    - packages/mcp-server/src/greptime.test.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/mcp.ts
    - packages/cli/src/index.ts
    - packages/mcp-server/src/graph-bind.test.ts
    - packages/mcp-server/src/mcp.test.ts
  created: []

key-decisions:
  - "verifyGraph takes VerifyOptions { anchors, now, rpc }: evidence passes anchors:false and stays chain-only (FEATURES E-D1); tests inject now+rpc, production builds its Rpc from the solana config"
  - "Devnet reads run sequentially (concurrency cap of one) under SUBSTRATE_VERIFY_TIMEOUT_MS; hours never reached read unverified, never anchored"
  - "Empty coverage (firstIngestMs null) makes record-less events legacy, not uncovered: with no coverage start everything predates coverage (D-era, pre-Phase-28 rows, ingest-less stubs)"
  - "Post-fix: the still-open hour reads pending with root null (D28-15), found by the first scratch proof run — hourDigest refuses open hours, so the check happens before the digest"
  - "CLI chain line reports the chain field, not top-level ok: an anchor failure still prints chain intact, and the hour lines carry the failure"
  - "Top-level reason names the first failing hour or the uncovered ids when the chain itself verifies; brokenAt stays the chain's"

requirements-completed: [ANCHOR-05]

coverage:
  - id: D28-13
    description: "one verdict, three doors: verifyGraph hour report; POST /verify, events_verify and substrate verify return it; buildGraphEvidence calls it with anchors off and stays chain-only"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "bun test service/graph-bind/mcp/observe/server — evidence anchors-off test plus chain-only bundle assertions"
        status: pass
    human_judgment: false
  - id: D28-14
    description: "additive response: ok/events/brokenAt/reason keep meaning; chain, hours[], uncovered, legacy added; ok true only when chain verifies, every hour anchored-or-pending, no uncovered post-coverage event"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "service.test.ts verifyGraph hour report block (16 cases: anchored, pending x2, unanchored, mismatch x5, unverified x3, legacy, uncovered, anchors-off, empty)"
        status: pass
    human_judgment: false
  - id: D28-15
    description: "hour statuses anchored/pending/unanchored/mismatch/unverified per the memo triple-check; pending inside 3h or hour open; unverified fail-closed"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "same 16-case block; open-hour pending regression pinned after the scratch run caught the digest-throw"
        status: pass
    human_judgment: false
  - id: D28-16
    description: "graph events read as today; ingest records from typed graphIngest by stored graph_id; each event's hour is its first record's; each distinct hour digested whole then checked once"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "greptime.test.ts graphIngest block (first-record collapse, SQL shape) plus hour-report tests"
        status: pass
    human_judgment: false
  - id: D28-17
    description: "pre-coverage record-less events are legacy (counted, never failing); post-coverage record-less events are uncovered and fail naming ids; empty coverage means all legacy"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "legacy/uncovered tests; graph-bind + mcp ledger stubs updated to the empty-coverage legacy path"
        status: pass
    human_judgment: false
  - id: D28-18
    description: "bounded devnet reads: createRpc per-call timeout + bounded attempts, sequential hours, SUBSTRATE_VERIFY_TIMEOUT_MS whole-verify budget shared by the CLI /verify request"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "config default 30000 with env override; budget-exceeded hours read unverified (code path, unit-pinned via timeoutMs)"
        status: pass
    human_judgment: false
  - id: D28-19
    description: "CLI one chain line plus one per hour; mismatch and unverified lines use the exact wording; exit 0 iff ok, 1 otherwise, 2 on usage"
    requirement: "ANCHOR-05"
    verification:
      - kind: review
        ref: "cmdVerify implementation reviewed against the D28-19 formats; no CLI test harness exists for exit codes (recorded gap, logic is a straight map over hours[])"
        status: pass
    human_judgment: false
  - id: D28-22
    description: "D-era window keeps today's verify behaviour: no verifyGlobalChain; D-era events are pre-coverage legacy"
    requirement: "ANCHOR-05"
    verification:
      - kind: unit
        ref: "no verifyGlobalChain symbol added (grep); D-era note recorded in docs/greptime-ledger.md (28-03)"
        status: pass
    human_judgment: false

duration: ~4h
completed: 2026-10-09
status: complete
---

# Phase 28 Plan 02: Verify hour report Summary

**verifyGraph returns the additive hour verdict through all three doors, fail-closed on unverified, with evidence pinned chain-only.**

## Accomplishments

- `GreptimeClient.graphIngest` typed read by stored graph id with TypeScript first-record collapse (Task 1, committed `3cb19f7` pre-handoff).
- `verifyGraph(graphId, { anchors, now, rpc })` keeps the per-session chain check as `chain` and adds `hours[]`, `uncovered`, `legacy`; `ok` conjoins all three.
- Three doors carry the verdict unchanged: `POST /verify` passthrough, `events_verify` with the hour-report description, CLI per-hour lines with the D28-19 wording and the shared verify budget.
- `buildGraphEvidence` passes `anchors: false`; `SUBSTRATE_VERIFY_TIMEOUT_MS` (default 30000) caps the hour loop and the CLI request.
- Scratch proof caught one real bug (open hour failed verify via digest throw); fixed to `pending`, regression-pinned.

## Task Commits

1. `f59b6ed` (rebase of `3cb19f7`) feat(28-02): graphIngest typed read with first-record collapse
2. `63c5426` feat(28-02): verifyGraph hour report, three doors, anchors-off evidence
3. `72f9965` fix(28-02): open hours pending, empty coverage legacy, stub updates

## Verification

- `bun test` full suite green (2228 pass, 0 fail at seal; 2285 tests incl. 57 skips).
- `bunx tsc --noEmit` clean.
- `store-lock.test.ts` green, diff empty (graphIngest lives in greptime.ts; verify composes no SQL).
- No live devnet call in this slice (injected Rpc stubs only).

## Deviations from Plan

- Empty-coverage-ledger rule added (record-less events are legacy when `firstIngestMs` is null): the plan's D28-17 split assumes coverage exists; without it every event would be uncovered, failing pre-Phase-28 ledgers and ingest-less stubs. Fail-closed preserved wherever coverage exists.
- Open-hour pending instead of digest-throw: the plan lists "hour not closed yet" under pending, but the digest-first order made it a mismatch; the check now precedes the digest.
- CLI chain line uses the `chain` field so anchor failures don't print a, at best confusing, `chain BROKEN` line.

## Rollback and lock (Task 4)

- No store-lock edit; `store-lock.test.ts` diff is empty.
- Rollback: reverting this slice restores the four-field verifyGraph response and the old CLI lines; the additive fields are consumed by no other caller, and the anchor job never calls verifyGraph.

## Threat notes

- **T-28-06 (memo attribution):** payer, payerSigned, memo-program, v1 parse, period match all required; signer mismatch is mismatch, never anchored.
- **T-28-07 (altered event):** whole-hour recompute vs memo root+count; proven by the 28-04 tamper beat.
- **T-28-08 (injected row):** post-coverage record-less events are uncovered and fail; pre-coverage legacy counted, never passed as anchored.
- **T-28-09 (verify output):** hours[] carries roots, counts, tx_sigs only; no event content.
- **T-28-10 (unbounded reads):** per-call timeout, bounded attempts, sequential hours, whole-verify budget.

## Self-Check: PASSED

Commits above exist; the suites pass as listed; no live step was taken in this slice.
