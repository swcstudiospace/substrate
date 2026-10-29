---
phase: 28-hourly-anchor-job-and-verify
plan: "04"
subsystem: ledger
tags: [proof, fake-chain, tamper, runbook, live-gated]

requires:
  - plan: "01"
    provides: runAnchorJob injected seams
  - plan: "02"
    provides: verify hour report under test
  - plan: "03"
    provides: units and docs the runbook installs
provides:
  - fake-chain tamper proof section in scripts/greptime-smoke.ts with a recorded 47/47 isolated run
  - LIVE-GATED L1-L10 runbook with per-step gates (NOT executed)
  - verification-status entry in docs/greptime-ledger.md
affects: [operator live window (L1-L10)]

actuals:
  tasks: 3
  commits: 1

key-files:
  modified:
    - scripts/greptime-smoke.ts
    - docs/greptime-ledger.md
  created: []

key-decisions:
  - "Tamper mechanism for the recorded 47/47 run is post-anchor append, not dedup-overwrite or duplicate-row: the overwrite needs a non-append-mode scratch table (contradicts the smoke fail-closed gate) and the duplicate breaks the chain too — only the append satisfies both chain-verifies AND root-comparison-proven. Follow-up (pending parent run): supplemental Beat 6 adds the exact existing-leaf alteration in a separate `*_p28alter` namespace via a proof-owned loopback proxy plus the typed dedup fallback; the normal tables stay append-only and the append beat keeps its history"
  - "Anchor ledger events use a recording fake emit: a real emit would land in the anchored hour itself on the real scratch clock and move the root under proof"
  - "Crash is injected exactly (first insertAnchor throws after a real stub-CLI send): memo on chain, no row, next run adopts with adopted:true and no new send"
  - "Scratch name p28anchor --port 17441: port 17410 was held by another rehearsal run; name is a label only"
  - "Live proof DEFERRED in full: L1-L10 recorded below with per-step gates, nothing executed, no devnet packet sent"

requirements-completed: []

coverage:
  - id: D28-20
    description: "isolated tamper proof on a fake chain: emit, anchor past the lag, untouched-verify all anchored, silent re-run, crash-adopt, tamper-mismatch naming the hour with chain intact"
    requirement: "ANCHOR-06"
    verification:
      - kind: scratch
        ref: "bun run rehearsal up --name p28anchor --port 17441 + stores.env + bun run smoke:greptime + down — 47/47, section 8 beats all ok (2026-10-09, ledger greptime/greptimedb:v0.14.4)"
        status: pass
    human_judgment: false
  - id: D28-21
    description: "live proof runbook: timer anchors a closed hour with a fresh proof graph; memo read-back equals recompute and is signer-checked; verify exits 0 all anchored; re-run sends nothing; --period adopt path"
    requirement: "ANCHOR-06"
    verification:
      - kind: gate
        ref: "LIVE-GATED — recorded below, all steps DEFERRED, operator decision pending"
        status: deferred
    human_judgment: true
  - id: status-record
    description: "verification-status entry distinguishes fake-chain-proven from live-proven with no overclaim; rollback noted (proof-additive)"
    requirement: "ANCHOR-06"
    verification:
      - kind: review
        ref: "docs/greptime-ledger.md Hourly anchor (Phase 28) entry plus rollback paragraph"
        status: pass
    human_judgment: false

duration: ~3h
completed: 2026-10-09
status: blocked
live: 0/10 approved — L1-L10 all DEFERRED (historical, 2026-10-09, not a new decision); no phase complete
---

# Phase 28 Plan 04: Fake-chain proof and live runbook Summary

**Slice record: ANCHOR-06 proved isolated on a fake chain (historical 47/47) and specced live behind operator gates that were not opened. Root ANCHOR-03–06 stay Pending; source/fixture proof is not operator goal completion.**

## Accomplishments

- Section 8 of `scripts/greptime-smoke.ts`: stub CLI at an absolute tmp path, loopback JSON-RPC stub (all four calls, devnet genesis hash), injected Runner/Rpc/clock with `now` past the lag, recording fake emit, crash-injecting Greptime proxy — all through typed methods, no SQL, no production key names.
- Recorded isolated run 47/47 on scratch `greptime/greptimedb:v0.14.4`: send-then-crash (exit 1, 1 send, no row), adopt (row with found tx_sig, `adopted: true`, still 1 send), silent re-run, untouched-verify all `anchored`, tamper-append (chain ok, hour `mismatch` naming the hour).
- The run caught and fixed a real bug: the open hour failed verify via digest throw; now `pending` (28-02 fixup + regression test).
- Verification-status entry in `docs/greptime-ledger.md`; `store-lock.test.ts` green (smoke file is the named exemption; no new exemption needed).
- Follow-up proof work implemented but NOT yet run (pending parent execution, no result claimed): `packages/mcp-server/src/anchor-run.test.ts` pins the entry process boundary (missing config exits 2 with usage, no CLI/store/RPC effect), and section 8 of `scripts/greptime-smoke.ts` gains a supplemental Beat 6 that alters an already-anchored existing event (same id/timestamp, recomputed hash) in a separate `*_p28alter` table namespace — proof-owned loopback proxy, typed dedup fallback, retained anchor, real `substrate verify` child exiting 1 naming the hour. The append beat keeps its history; the new scenario is pending until the parent records its run.

## Task Commits

1. `e67aed6` feat(28-04): fake-chain tamper proof harness plus verification-status record

## Verification

- Isolated: `bun run rehearsal up --name p28anchor --port 17441` + sourced `stores.env` + `bun run smoke:greptime` (47/47, zero FAIL) + `bun run rehearsal down --name p28anchor`. Full output archived in the session transcript.
- `bun test packages/mcp-server/src/store-lock.test.ts` green.
- Live: L1–L10 below, all DEFERRED (historical); no live action taken.
- Pending parent execution (no pass claimed): `bun test packages/mcp-server/src/anchor-run.test.ts` and the extended `bun run smoke:greptime` (section 8 Beat 6). Counts from the 2026-10-09 run above stay historical; the new scenario's result is recorded only when the parent runs it.

## Deviations from Plan

- Scratch name/port (`p28anchor --port 17441` instead of `p28`): port 17410 was held by another rehearsal run; label-only difference.
- Tamper mechanism is post-anchor append (reason above); the plan's preferred dedup-overwrite is unreachable on an append-mode scratch table, and its fallback breaks the chain the beat requires intact.
- Anchor events use a recording fake emit (reason above); the adopt `adopted: true` payload is asserted on the recording.

## LIVE-GATED live proof runbook L1–L10 (operator-approved window, funded key)

**Status: all steps DEFERRED — nothing below was executed. No devnet packet left this session, no production row was written, no host or systemd step was taken. Each step needs its own separate operator approval in an operator-approved window — including the read-only steps L1, L2, L9 and L10; read-only is not an exemption. The executor stops at each gate. These DEFERRED outcomes are historical (2026-10-09), not a new deferral decision.**

- **L1 — env and key identity (read-only).** `grep -c '^SOLANA_RPC_URL='`, `grep -c '^SOLANA_ANCHOR_KEYPAIR='`, `grep -c '^SOLANA_ANCHOR_PUBKEY=' /etc/substrate/substrate.env` (one exact name per check — `'^SOLANA_*='` only repeats the underscore — names only), `stat` owner/mode of the keypair path (never contents), `solana --version`, `solana-keygen pubkey <path>` equality with `SOLANA_ANCHOR_PUBKEY`. Gate: all names present, key root-owned mode 0600, versions sane. Outcome: **DEFERRED**.
- **L2 — devnet balance (read-only).** `getBalance` on the key. Gate: decide funding need. Outcome: **DEFERRED**.
- **L3 — fund the key (operator, write/devnet).** ~1 devnet SOL (covers years at 24 sends/day; key held 0 SOL). Gate: explicit funding approval. Outcome: **DEFERRED**.
- **L4 — missing SOLANA_* lines (write/host config).** Add any missing line to `substrate.env`. Gate: per-line approval. Outcome: **DEFERRED**.
- **L5 — deploy release holding Phases 27+28 (write/production service).** `deploy-release.sh`; coverage starts at this restart (`migrate()` creates `event_ingest`). Gate: deploy window approval. Outcome: **DEFERRED**.
- **L6 — install units/drop-in (write/systemd).** Install `substrate-anchor.service`/`.timer` + drop-in, `daemon-reload`, `enable --now substrate-anchor.timer`; read-only doctor after. Gate: systemd approval. Outcome: **DEFERRED**.
- **L7 — fresh proof-graph events (write/production ledger).** Emit a proof graph's events into production. Gate: production-write approval. Outcome: **DEFERRED**.
- **L8 — first real anchor (write/devnet + row + event).** Timer tick (recorded `systemctl start` fallback). Settles the 0-lamport question and the memo program id (D27-06). Gate: send approval. Outcome: **DEFERRED** — 0-lamport and program id stay **[UNVERIFIED]**.
- **L9 — read-back and verify (read-only).** Memo read back by `tx_sig` equals recomputed root+count, signed by the pubkey; `substrate verify <proof graph>` exits 0 every hour anchored. Gate: separate approval required — read-only is not an exemption. Outcome: **DEFERRED** (historical).
- **L10 — re-run adopts (read-only on devnet).** Second `systemctl start` sends nothing (signature list and balance unchanged); `anchor-run.ts --period <H>` takes the adopt path (row unchanged, one `anchor.written` `adopted: true`). Reproducing crash-adoption live would mean deleting a production row, which the client refuses — proven on the fake chain only. Gate: separate approval required — read-only is not an exemption. Outcome: **DEFERRED** (historical).

Memo program id observation: still-open (settles at L8). No secret value recorded anywhere: names, modes, balances, tx_sigs only when the window runs.

## Rollback note (Task 3)

Proof is additive: reverting deletes section 8 plus the runtime tmp stub; production rows from a future L7–L8, if approved, are append-only and stay, tagged proof-graph ids.

## Threat notes

- **T-28-14 (credentials):** `stores.env` sourced never printed; summary records names, modes, balances, tx_sigs only.
- **T-28-15 (alarm poisoning):** fake chain never signs with the production key and never carries the production key names (D28-12).
- **T-28-16 (overclaim):** status entry separates fake-chain-proven from live-proven; deferred L-steps are explicit DEFERRED, never a silent pass.

## Self-Check: PASSED

Isolated proof recorded 47/47; live steps explicitly deferred with gates; no live action taken; store lock green.
