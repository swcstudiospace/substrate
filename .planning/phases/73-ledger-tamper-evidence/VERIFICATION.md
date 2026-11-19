---
phase: 73-ledger-tamper-evidence
verified: 2026-11-19T14:06:21Z
status: passed
score: 2/2 roadmap success criteria verified (0 gaps)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", ".planning/phases/73-ledger-tamper-evidence/73-CONTEXT.md", "docs/corpus-proofs.md", "docs/greptime-ledger.md", "docs/runbooks/devnet-reset-and-reanchor.md", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:3101326b2b71c97862e33c2c5dfa452bdd35eca01057d117a6ff2f55831e36d9"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 2/2
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from the stored rows, and the verified head is anchored.
**Verified:** 2026-11-19
**Status:** passed
**Re-verification:** Yes — prior verification 2026-11-12 passed 2/2; this pass re-checks recompute + anchored head on the current tree (`reconcile/main-2026-11-11`, HEAD 2cb852d1).

Scope note: code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply). Gates/formatters skipped per assignment; behavioral evidence is test enumeration + source reads on the current tree, not a fresh suite run. No source edits made.

## Goal Achievement

### Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Tests save the graph's head before the change, then edit a stored payload, delete a middle event, truncate the last events, and rewrite the whole chain with recalculated `hash` and `prev`. Each is compared with that saved head: the edits and the rewrite report the first differing event id, and truncation reports the first missing event id. | ✓ VERIFIED | `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:399`) walks stored leaves in seq order against recomputed events; `event.ts:388-399` defines `stored-leaves-mismatch` / `first-differing` / `first-missing`. Named tests in `packages/mcp-server/src/service.test.ts` `describe("heads trust (D73-03, D73-04)")` (line 5512), enumerated 2026-11-19: "an edited payload parts the chain at that event: first_differing_event_id" (line 5598); "a deleted middle event is first_missing_event_id, and the verdict fails" (5610); "truncated last events are first_missing_event_id at the first one gone, and the verdict fails" (5626); "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails" (5639). Fixture `v2World` (line 5519) saves memo + stored leaves before mutation. |
| 2 | The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof. | ✓ VERIFIED | Anchor writer: `anchor.ts:396` `buildGraphHeads` builds one record per (graph, session); `headsRoot` (`packages/ledger/src/heads.ts:34-58`) commits them; `anchor.ts:475` `anchorMemo` writes `formatMemoV2` carrying `heads_root`; `anchor.ts:480` `storeAnchor` writes `insertGraphChainLeaves` before `insertAnchor`. DDL `greptime.ts:1078` (`graph_chain_leaves`, `CREATE TABLE IF NOT EXISTS`), `insertGraphChainLeaves` (`greptime.ts:1890`). Trust: `service.ts:8741-8750` takes `heads_root` only from `parseMemo` of the session-signed on-chain memo (`service.ts:8779`); `trustHour` (`service.ts:8498-8583`) returns `trusted: false` when `report.heads_root === undefined` (`service.ts:8513`), and verifies stored leaves reproduce the on-chain root before any comparison (`service.ts:8550-8554`). Memo v2: `packages/ledger/src/memo.ts:14-18,34-53` (`formatMemoV2`, `parseMemo` accepts v1 and v2, rejects others). |

**Score:** 2/2 criteria verified (0 present-behavior-unverified).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/memo.ts` | v2 memo format + parser | ✓ VERIFIED | `formatMemoV2`, `parseMemo` v1/v2, malformed rejected (line 34-53). |
| `packages/ledger/src/heads.ts` | head records + root | ✓ VERIFIED | `GraphHeadRecord`, `headRecordHash`, `headsRoot` sorted by (graph, session) (line 59-66 in heads.ts). |
| `packages/mcp-server/src/anchor.ts` | head builder + anchor writer | ✓ VERIFIED | `buildGraphHeads` (396), `anchorMemo` v2 (464-475), `storeAnchor` leaves-before-row (478-481). |
| `packages/mcp-server/src/event.ts` | verifier | ✓ VERIFIED | `compareToAnchoredHead` (399), `orderedLeaves`, `headRecordsFromLeaves` (340-380). |
| `packages/mcp-server/src/greptime.ts` | leaves table | ✓ VERIFIED | DDL (1078), insert (1890), hour read (`hourChainLeaves`). |
| `packages/mcp-server/src/service.ts` | trust verdict | ✓ VERIFIED | `trustHour` (8498), `heads_root` from on-chain memo only (8741-8779), `trusted` fields (744-761). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `anchor.ts` `buildGraphHeads` | `packages/ledger` `headsRoot` | `headsRoot(records)` | WIRED | `readHourHeads` calls `headsRoot(records)` (anchor.ts:467). |
| `anchor.ts` `anchorMemo` | on-chain memo | `formatMemoV2` with `headsRootHex` | WIRED | anchor.ts:475. |
| `service.ts` `checkHour` | `packages/ledger` `parseMemo` | parses signed memo | WIRED | service.ts:8741. |
| `service.ts` `trustHour` | `compareToAnchoredHead` | stored leaves + on-chain root | WIRED | service.ts:8550-8577; `import { compareToAnchoredHead }` at service.ts:115. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `trustHour` | `onChainHeadsRoot` | `report.heads_root` from parsed signed memo | Yes — never recomputed from rows | ✓ FLOWING |
| `compareToAnchoredHead` | recomputed `eventHash` | row content (stored hash kept separately) | Yes — edited payload parts at the edited event | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Tamper tests exist (edit/delete/truncate/rewrite) | `grep -n "test(\"" packages/mcp-server/src/service.test.ts` filtered to lines 5595-5780 | 4 named tests enumerated at lines 5598, 5610, 5626, 5639 | ✓ PASS (enumeration) |
| Trust tests exist (unanchored, v1-only, stored-leaves-mismatch) | same enumeration | tests at lines 5676, 5684, 5694 | ✓ PASS (enumeration) |
| Suite execution | assignment SKIPPED gates | not run; prior verification recorded named tests passing | ? SKIP per assignment |

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| HARD-S3 | Phase 73 | Chain canonical checksums; detect modified/deleted/gapped/reordered; report first bad position; name the trusted earlier proof; never claim recomputed hashes prove missing history | ✓ SATISFIED | `compareToAnchoredHead` reports first differing/missing id; `trustHour` trusts only the on-chain v2 `heads_root`, never recomputed heads (D73-04). REQUIREMENTS.md line 114. |

73-01-PLAN.md declares no `requirements` field; HARD-S3 is the phase-mapped requirement per REQUIREMENTS.md table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | - |

`TBD|FIXME|XXX` scan over `memo.ts`, `heads.ts`, `anchor.ts`, `event.ts`: no matches (2026-11-19). No stub patterns observed in the verified paths.

### Observations (non-blocking, carried from prior pass)

1. Criterion 2 "each graph's chain head is recorded in the hourly anchor" is satisfied via one `heads_root` commitment per hour plus `graph_chain_leaves` head values verified against it (locked decision D73-01). Per-graph values are not directly readable from the memo.
2. Live devnet sends and production DDL were not exercised, by design (D73-05/D73-06). Operator-gated; not success criteria.
3. Residuals from SUMMARY stand: `graph_chain_leaves` has no primary key (duplicates collapse on read); a failed leaves write after a send can resend next run; events with no `graph_id` get no head and stay covered only by the hour root.

### Gaps Summary

None. Both roadmap criteria are observed in the current code and backed by enumerated named tests. The trusted-proof invariant (never trust a head recomputed from stored rows) holds in `trustHour`.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
