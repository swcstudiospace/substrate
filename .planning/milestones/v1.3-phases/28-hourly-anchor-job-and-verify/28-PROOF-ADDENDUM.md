# Phase 28 — Late Proof Addendum (current-main correction, 2026-10-12)

**Scope:** owned late-28 PROOF / summary / validation / evidence only. The
existing v1.3 milestone archive is already done and is unchanged by this
file: no unarchive, no recreated active plans, no re-completion, no new
milestone. `28-04-SUMMARY.md`, `28-VERIFICATION.md`, and
`docs/greptime-ledger.md` keep their recorded wording; this file only points
at them and records what moved since.

## Standing record (history, not re-decided)

- Milestone v1.3 archived at 18/18 phases, 68 requirements, with **43
  `behavior_unverified` live-tail items** across 11 phases — historical and
  unverified, each with proof + rollback in its phase runbook/validation map.
- Phase 28 verification stands at 20/20 truths with `behavior_unverified: 2`
  (live devnet proof L1–L10; production v1.1.4 anchors cadence).
- The original convention — PASS with gated remainders — stays historical.
  It is not a waiver of the current bar.
- Archived implementation is not full end-to-end completion. The user
  explicitly selected **Keep real-proof criteria**, so full completion stays
  **operator-blocked**, not silently waived.
- No 7-of-18 local checkpoint is current-main status; source-complete 18/18
  stays historical.

## Late scope proved on the current baseline

1. **Supplemental Beat 6** in `scripts/greptime-smoke.ts` (section 8): the
   exact G5 existing-leaf alteration — same id and timestamp, hash
   recomputed with the existing `eventHash` helper — inside a separate
   `*_p28alter` table namespace on the same scratch server. A proof-owned
   loopback proxy serves the typed `migrate()` an `agent_events` table
   without `append_mode` so the real store's last-write-wins overwrite
   applies (taken through the existing
   `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` typed fallback, the approved
   28-04 plan's preferred dedup fixture). Normal ledger tables stay
   append-only; beats 1–5 keep their history; a real `substrate verify`
   child process is asserted to exit 1 naming the altered hour against the
   retained anchor, chain still verifying. Guarded like section 8: loopback
   ledger only, no production key names, no devnet packet.
2. **`packages/mcp-server/src/anchor-run.test.ts`** (new, wholly owned):
   the real entry process exits 2 for missing configuration, prints usage
   and performs no CLI/store/RPC action. No incidental HOME-entry list is
   pinned; Bun's own cache is not an anchor side effect.
3. **Current parent run:** `ab0dff1` plus the owned source corrections,
   named rehearsal `v13-final-e61ab196`, scratch GreptimeDB v0.14.4:
   **68/68** ledger checks passed (28 ingest + 19 earlier fake-chain
   + 21 exact existing-leaf checks). The retained root and signature were
   left unchanged; bounded store readback confirmed one row per event
   after the same-id/timestamp/series overwrite. The new root differed,
   the event chain still verified, and the real CLI exited **1** naming
   `2026-10-11T22:00:00.000Z` while reporting **chain intact**. The anchor
   stub was invoked once, not again after tampering.
4. **Cleanup:** up and down both exited 0; down stopped the owned server
   and removed its two owned store containers. No production store,
   live devnet transaction, key, service configuration or systemd step.

## Coverage map — P28 G1–G5 proved locally

| Gap | Current evidence | Result |
| --- | --- | --- |
| G1 entry exit-2 boundary | Real anchor-run subprocess and trap CLI/store/RPC | pass |
| G2 CLI verify exits/streams | Actual CLI over computed hour reports | pass |
| G3 MCP/HTTP hour reports | Actual verifier behind both served transports, nonempty anchored/mismatch/uncovered hours | pass |
| G4 anchored prefix + bounded stall | Three closed hours: anchored first, stalled second, third never begun | pass |
| G5 existing-leaf alteration + CLI exit 1 | Real scratch dedup namespace, retained anchor, intact chain, named mismatch | 68/68 complete smoke |

The five explicit test files passed **385/385** after each was checked to
exist; the final complete current suite passed **3,199 / 58 skip / 0 fail**
across 126 files. Python passed 246; types, shell syntax and shellcheck
exited 0; phase-close passed all 119 tests in the four lock files
(EVENT_KINDS 12, SURFACES 27). Real current proposal, desktop and vocabulary
smokes passed 47/47, 20/20 and 29/29 respectively. These replace old-base
numbers only as current-source proof, not as production acceptance.

## Live gates L1–L10 (unchanged, no new decision)

All ten steps stay DEFERRED as historical outcomes with per-step gates, each
needing separate operator approval in an approved window with a funded key —
**including the read-only steps** (read-only is not an exemption). The
source runbook wording is preserved verbatim in `28-04-SUMMARY.md`; no new
DEFERRED decision is made here.

The binding plan requires each step's own approval. In particular, the old
summary's L9 line ("none beyond L8") and L10 line are not permission:
separate L9 and L10 approval must be recorded before their execution.
`docs/greptime-ledger.md` now makes that precedence explicit. No live
approval or new deferral decision has been fabricated.

## Proof + rollback pointers

- Isolated fake-chain proof: `scripts/greptime-smoke.ts` section 8;
  historical 47/47 retained, current complete 68/68 proved above.
- Live runbook + gates: `28-04-SUMMARY.md` LIVE-GATED section.
- Verification-status + rollback (proof-additive): `docs/greptime-ledger.md`
  Hourly anchor entry.
- Current-main hold: `.planning/VALIDATION.md` late addendum.

## Operator prerequisites still held

The isolated scratch prerequisite is satisfied and cleaned up. L1–L10 and
production v1.1.4 cadence remain unproved here. Follow the existing live
runbook only in a separately approved window; provide real receipts before
calling the milestone end-to-end complete. The disclosed Cursor credential
requires operator rotation as a separate incident; it is not done here.
Only private operator commands may read credential values. No value or
private hostname belongs in this record.
