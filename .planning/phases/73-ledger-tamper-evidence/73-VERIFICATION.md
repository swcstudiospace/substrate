---
phase: 73-ledger-tamper-evidence
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 2/2 must-haves verified (1 VERIFIED by behavioral test, 1 PASSED by owner override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", ".planning/phases/73-ledger-tamper-evidence/73-CONTEXT.md", "docs/corpus-proofs.md", "docs/greptime-ledger.md", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:83155b3c11fb579ed64f0633e9dbcea360cdb0bae0b38bf1b3c1fc975a505380"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts, heads.ts, anchor.ts). Owner also confirmed memo v2 is in v1.8 scope (REQUIREMENTS.md line 85)."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 2/2
  gaps_closed: []
  gaps_remaining: []
  regressions: []
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

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored.
**Verified:** 2026-11-19T00:00:00Z (re-verification at HEAD `ee998735dce82872df0302501e8b0a49c9914648`, branch `gsd/autonomous-rerun`)
**Status:** human_needed
**Re-verification:** Yes — code re-inspected at HEAD; prior result (human_needed, 2/2) confirmed, no regressions, no new code gaps.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Tests save the graph's head, then edit a stored payload, delete a middle event, truncate the tail, and rewrite the whole chain with recalculated `hash`/`prev`; edits and the rewrite report the first differing event id, truncation reports the first missing event id | ✓ VERIFIED | `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:435-465`): stored leaves must first reproduce the head (count, `leaves_root`, head id/hash) else `stored-leaves-mismatch`; then a leaf whose event is absent is `first-missing`, a leaf whose recomputed or stored hash differs is `first-differing`, extra events are `first-differing`. Tests in `packages/mcp-server/src/service.test.ts:5261` (edited payload), `:5273` (deleted middle), `:5289` (truncated tail), `:5302` (full rewrite with recalculated hash and prev), `:5323` (per-session, same verdict for every read order). Prior verification confirmed these behavioral tests pass on this tree; re-inspected at HEAD — implementation and tests present and unchanged in substance. |
| 2 | Each graph's chain head is recorded in the hourly anchor as the trusted proof; a recomputed head is never the proof | ✓ VERIFIED (override) | Memo v2 carries `heads_root` (`packages/ledger/src/memo.ts:11-12,42-44`; `heads.ts` `headsRoot` over per-(graph, session) records sorted by graph/session). `anchorMemo`/`storeAnchor` (`packages/mcp-server/src/anchor.ts:464-483`) write `graph_chain_leaves` before the anchors row — a failed leaves write blocks the anchor. `verifyGraph` sets `trusted` only against the on-chain v2 `heads_root` (`packages/mcp-server/src/service.ts:8395,8418-8426`); v1-only and unanchored hours report `trusted: false` with explicit reasons (tests at `service.test.ts:5340-5355`). PASSED (override): owner accepted the commitment reading 2026-11-02. |

**Score:** 2/2 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/memo.ts` | v2 memo with `heads_root`, v1 unchanged | ✓ VERIFIED | `MEMO_PREFIX_V2`, strict v2 regex, `formatMemoV2`; `parseMemo` accepts v1/v2, rejects malformed v2 |
| `packages/ledger/src/heads.ts` | per-(graph, session) head records, order-independent root | ✓ VERIFIED | `GraphHeadRecord`, `headRecordHash`, `headsRoot` (sorted, RFC 6962 via `merkleRootHex`) |
| `packages/mcp-server/src/anchor.ts` | head builder, leaves-before-anchor writer | ✓ VERIFIED | `buildGraphHeads` (:396), `storeAnchor` writes leaves then row (:479-483) |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL + reader/writer | ✓ VERIFIED | `CREATE TABLE IF NOT EXISTS` append_mode (:1029), `insertGraphChainLeaves` (:1831), hour-leaves read (:1850) |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead` | ✓ VERIFIED | :424-465, substantive (see Truth 1) |
| `packages/mcp-server/src/service.ts` | `verifyGraph` trusted verdict | ✓ VERIFIED | trusted/untrusted per D73-04, `ok` gating on contradiction with anchored head |
| `docs/greptime-ledger.md`, `docs/corpus-proofs.md` | memo v2 / leaves / trusted-head docs | ✓ VERIFIED | `greptime-ledger.md:550-556`, `corpus-proofs.md:120` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| anchor job | chain (devnet) | v2 memo with `heads_root` | WIRED (code) / live send is human item 1 | `anchorMemo` emits v2 once heads computed; v1 path retained |
| anchor job | `graph_chain_leaves` | `insertGraphChainLeaves` before `insertAnchor` | WIRED | `storeAnchor` ordering; no anchor without its leaves |
| `verifyGraph` | anchored head | `compareToAnchoredHead` + stored-leaves reproduction of `heads_root` | WIRED | `service.ts:8418-8426`; recomputed head never trusted |
| `verifyGraph` | caller fields | additive `trusted`, `trusted_reason`, `first_*_event_id` | WIRED | existing callers keep current fields |

### Anti-Patterns Found

None blocking. No `TODO`/`FIXME`/placeholder stubs in the phase files inspected. Known residual from SUMMARY (no primary key on leaves table, duplicates collapse on read) is documented, not a stub.

### Human Verification Required

(unchanged from prior verification — all operator/live-gated under D73-05)

### 1. Live devnet v2 send
**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** The read-back matches, and that hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 2. Live adoption of an already-anchored v2 hour
**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** The adoption writes leaves without comparing `heads_root` (checkAdopt compares root+count only, `anchor.ts:324`). The mismatch surfaces only at verify time, as "stored leaves do not reproduce the on-chain heads root".
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

No code gaps. Criterion 1 is VERIFIED by behavioral tests confirmed in the prior verification and re-inspected at HEAD. Criterion 2 is PASSED under the owner's commitment-reading override (2026-11-02). The phase stays `human_needed`: the devnet send, the adoption path, the boot DDL decision, and the live verify are all operator-gated under D73-05 and cannot be completed from the repository.

---

_Verified: 2026-11-19T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
