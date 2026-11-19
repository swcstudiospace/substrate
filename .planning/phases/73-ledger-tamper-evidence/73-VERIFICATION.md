---
phase: 73-ledger-tamper-evidence
verified: 2026-11-18T12:24:33Z
status: human_needed
score: 2/2 must-haves verified (1 VERIFIED by behavioral test, 1 PASSED by owner override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "packages/cli/src/evidence.test.ts", "packages/cli/src/verify.test.ts", "packages/evidence/src/report.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/graph-bind.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor-run.test.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts"]
covered_digest: "v3:sha256:5beed2b52cfa857ce45ac806ea10187c53ee734f2b4f8ff1dc9a8d85c3b4af1b"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts, heads.ts, anchor.ts). Owner also confirmed memo v2 is in v1.8 scope (REQUIREMENTS.md line 85)."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
human_verification:
  - test: "Send one live devnet v2 memo for a closed hour through the anchor job, read it back from the chain, and compare its heads_root with the value recomputed from the stored graph_chain_leaves rows. Then run substrate verify on that graph."
    expected: "Read-back matches the recomputed heads root, and the verdict reports trusted: true for that hour."
    why_human: "A devnet send is operator-gated (D73-05) and cannot be run from the repository."
  - test: "Exercise the anchor adoption path on a live hour whose v2 memo is already on chain (for example after a lost anchors-row write). Then check whether graph_chain_leaves matches the on-chain heads_root."
    expected: "Adoption writes leaves without comparing heads_root (anchor.ts adoption branch, around line 688-698). Expected result: the mismatch is caught only at verify time, as 'stored leaves do not reproduce the on-chain heads root'. Confirms W2."
    why_human: "Live adoption depends on devnet and store state."
  - test: "On first boot of the live service, check that graph_chain_leaves is created with append_mode = true, and decide whether boot-time DDL is acceptable under D73-05."
    expected: "The table exists in append_mode, and boot output has no 'graph_chain_leaves not created in append_mode' warning. The D73-05 wording is either amended or the DDL moves out of boot."
    why_human: "Production DDL on the live GreptimeDB is operator-gated. The mismatch is a decision. See W3."
  - test: "Run substrate verify <graph_id> against a real graph with one v2-anchored hour and one v1-anchored hour."
    expected: "The v2 hour reports trusted: true. The v1 hour reports trusted: false with reason 'anchored with a v1 memo: no heads commitment on chain'. Overall ok is true for both."
    why_human: "Needs the live GreptimeDB and devnet."
---

# Phase 73: Ledger tamper evidence — Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from the stored rows, and the verified head is anchored.
**Verified:** 2026-11-18T12:24:33Z
**Status:** human_needed
**Re-verification:** Yes — the prior record (2026-11-02, `human_needed`) is stale. Its `covered_digest` no longer matches the current code: the fingerprint is now `v3:sha256:5beed2b5...`, and later phases (72, 74, 76, 77, 78) changed `service.ts`, `greptime.ts`, `event.ts` and related files. This pass re-checks the criteria against the current tree.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Criterion 1. Save the graph's head, then edits to a stored event, a middle deletion, tail truncation and a full rewrite with recalculated `hash` and `prev` each report the first differing event id (edits and rewrite) or the first missing event id (deletion and truncation), compared with that saved head. | ✓ VERIFIED | The comparison is `compareToAnchoredHead` in `packages/mcp-server/src/event.ts` (~line 435). It returns `first-missing` for an absent leaf event and `first-differing` for a hash mismatch, an extra event, or a duplicate id. `headRecordsFromLeaves` and `orderedLeaves` rebuild the head from stored leaves (~lines 378-405). Verdict-level tests in `service.test.ts` (~lines 5246-5322) cover each case. Targeted run this pass (see spot-checks): all 6 named tests pass. |
| 2   | Criterion 2. The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof that criterion 1 compares against. A head recomputed from stored rows is never the proof. | ✓ PASSED (override) | Override accepted by owner on 2026-11-02 (see frontmatter). Present in code: `MEMO_V2_RE` and `formatMemoV2` (`packages/ledger/src/memo.ts` lines 12, 42-46), `parseMemo` accepts v1 and v2 (lines 61-68), `headsRoot` (`packages/ledger/src/heads.ts` line 59), `anchorMemo` (`packages/mcp-server/src/anchor.ts` line 473-475) and the send-path read-back check on `headsRootHex` (anchor.ts ~line 811). The verdict takes `heads_root` only from the parsed on-chain memo (`service.ts` ~lines 8603-8634). |

**Score:** 2/2 truths (1 VERIFIED, 1 PASSED override; 0 behavior-unverified)

**Criterion 2 reading applied.** Commitment reading, as the owner accepted it. The literal reading ("a head value for each graph is recorded in the anchor") is not met: the anchors row and memo carry one hour-wide `heads_root`, and heads are per (graph, session). That gap is accepted under the override and is not narrowed here. If the owner later rejects the commitment reading, the override must be removed and criterion 2 becomes UNCERTAIN/FAILED again.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/heads.ts` | Head records and `headsRoot` | ✓ VERIFIED | `headRecordHash` (line 25), `headsRoot` (line 59). Used by `anchor.ts` and `service.ts`. |
| `packages/ledger/src/memo.ts` | v2 memo format and parser | ✓ VERIFIED | `MEMO_V2_RE` (line 12), `formatMemoV2` (line 42), `parseMemo` (line 61). |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead`, `orderedLeaves`, `headRecordsFromLeaves` | ✓ VERIFIED | Lines 378, 395, 435. |
| `packages/mcp-server/src/anchor.ts` | Head builder, leaves writer, v2 send path | ✓ VERIFIED (with W2) | `readHourHeads` (line 455), `anchorMemo` (line 473). The adoption branch (~688-698) stores leaves without the heads-root check (W2). |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL, writer, readers | ✓ VERIFIED (with W3) | DDL in `migrate`, `CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ... WITH ('append_mode' = 'true')` (~lines 1022-1028). |
| `packages/mcp-server/src/service.ts` | `verifyGraph` trust and verdict | ✓ VERIFIED | `trustHour` (~line 8353) calls the per-pair comparison; `head_failed` set at ~8364 and ~8439. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `trustHour` | stored leaves | `hourChainLeaves` | ✓ WIRED | `greptime.ts` SELECT over `graph_chain_leaves` |
| `trustHour` | per-pair comparison | `compareToAnchoredHead` | ✓ WIRED | `event.ts` ~line 435 |
| `heads_root` source | devnet memo only | `parsed.headsRootHex` from `transactionMemo` | ✓ WIRED | `service.ts` ~lines 8603-8634 |
| Boot | `graph_chain_leaves` DDL | `index.ts:121` → `substrate.migrate()` → `greptime.migrate()` → DDL | ✓ WIRED (see W3) | `index.ts` is not changed by this phase; the DDL it reaches is. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `trustHour` | `leaves` | `hourChainLeaves`, a SQL SELECT over `graph_chain_leaves` | Yes | ✓ FLOWING |
| `trustHour` | `links` | Event rows from `readEvents`, rehashed with `eventHash` | Yes | ✓ FLOWING |
| `anchorMemo` | `headsRootHex` | `readHourHeads` over event rows | Yes | ✓ FLOWING |

## Behavioral Spot-Checks

Run as one targeted command under bubblewrap, with `/etc/substrate` masked and HOME and TMPDIR in owned storage, per the bun-worktree-credential-isolation skill. Files checked to exist first.

```
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /etc/substrate --bind $OWN $OWN -- \
  env -i HOME=$OWN/home TMPDIR=$OWN/tmp PATH=$PATH bun --no-env-file test packages/mcp-server/src/service.test.ts \
  -t "honest v2 hour|edited payload|deleted middle event|truncated last events|full rewrite"
```

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Criterion 1: honest v2 hour trusted; edit, deletion, truncation and full rewrite each report the first differing or missing event id | command above | 6 pass, 0 fail, 21 expect() calls (includes "ok is false for an edited payload") | ✓ PASS |

The full suite was not re-run in this pass. The previous record's full-suite result (2026-11-01) is not evidence for the current tree.

## Probe Execution

Step 7c skipped. The phase is not a migration or tooling phase, its success criteria do not mention probes, and the PLAN and SUMMARY declare none.

## Requirements Coverage

The PLAN has no `requirements:` field, and `.planning/REQUIREMENTS.md` has no rows for phase 73. Nothing mapped, nothing ORPHANED. REQUIREMENTS.md:85 excludes "a new on-chain memo format" from the earlier milestone. The owner confirmed on 2026-11-02 that memo v2 is in v1.8 scope.

## Anti-Patterns Found

Debt-marker gate (TBD, FIXME, XXX) over the covered code files: not re-scanned in this pass. The prior record reported no matches.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/anchor.ts` | ~688-698 | Adoption writes leaves and the row without the heads-root check | ⚠️ Warning | W2. Verification still fails closed: the mismatch is caught at verify time. |
| `packages/mcp-server/src/greptime.ts` | ~1022-1028 | Leaves DDL runs on every boot via `migrate`, which contradicts the D73-05 wording | ⚠️ Warning | W3. Decision in human item 3. |
| `packages/mcp-server/src/service.test.ts` | ~5261-5271 | Test named "an edited payload" edits `summary`, not `payload` | ⚠️ Warning | W4. Verdict-level payload-column coverage is missing. This does not change criterion 1's status. |

## Other Notes

- **I1.** The fixture builds the honest memo and leaves before any override. There is no separate save step, and the override changes only what is read back. This meets criterion 1 in effect, and D73-07 accepts this harness.
- **I2.** `ok` is true for v1-only anchored hours. Trust, not `ok`, is the proof gate (D73-04).
- **I3.** Callers of `verifyGraph` (`mcp.ts`, `observe.ts`, `server.ts`) see additive fields only. Not tested individually here.

## Human Verification Required

### 1. Live devnet v2 send
**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** The read-back matches, and that hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 2. Live adoption of an already-anchored v2 hour
**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** The adoption writes leaves without comparing `heads_root`. The mismatch surfaces only at verify time, as "stored leaves do not reproduce the on-chain heads root".
**Why human:** Depends on live devnet and store state.

### 3. Boot-time leaves DDL on the live store
**Test:** On first boot of the live service, confirm `graph_chain_leaves` exists with `append_mode = true` and that boot output has no "not created in append_mode" warning. Decide whether boot-time DDL is acceptable under D73-05.
**Expected:** Table present in append_mode. The D73-05 wording is amended, or the DDL moves out of boot.
**Why human:** Production DDL is operator-gated, and the mismatch is a decision.

### 4. Mixed-version verify on a real graph
**Test:** Run `substrate verify <graph_id>` against a real graph with one v2-anchored hour and one v1-anchored hour.
**Expected:** The v2 hour is `trusted: true`. The v1 hour is `trusted: false` with the reason "anchored with a v1 memo: no heads commitment on chain". Overall `ok` is true for both.
**Why human:** Needs live GreptimeDB and devnet.

## Gaps Summary

No gaps. Criterion 1 is VERIFIED by behavioral tests on the current tree. Criterion 2 is PASSED under the owner's commitment-reading override, carried forward from 2026-11-02. The phase stays `human_needed` because the devnet send, the adoption path, the boot DDL decision and the live verify are operator-gated.

---

_Verified: 2026-11-18T12:24:33Z_
_Verifier: Claude (gsd-verifier)_
