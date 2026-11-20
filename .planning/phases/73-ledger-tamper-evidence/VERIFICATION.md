---
phase: 73-ledger-tamper-evidence
verified: 2026-11-20T01:26:17Z
status: passed
score: 2/2 roadmap success criteria verified (0 gaps)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", ".planning/phases/73-ledger-tamper-evidence/73-CONTEXT.md", "docs/corpus-proofs.md", "docs/greptime-ledger.md", "docs/runbooks/devnet-reset-and-reanchor.md", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:3615c3144ff0fffeed635776e90e8c7d9c92afe0a997845a4ba04d69971cac1e"
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
**Verified:** 2026-11-20T01:26:17Z
**Status:** passed
**Re-verification:** Yes — prior verification 2026-11-19 passed 2/2; this pass re-checks recompute-from-rows + anchored head on the current tree (`reconcile/main-2026-11-11`, HEAD 13bdade5; prior HEAD 2cb852d1).

Scope note: code review skipped (Greptile unavailable — not run, per assignment; CI gates apply). Gates/formatters skipped per assignment; behavioral evidence is test-name enumeration + source reads on the current tree, not a fresh suite run. No source edits made. Operator gates (devnet send, production DDL, systemd install, live ingest) never touched — deferred by design (D73-05/D73-06).

## Goal Achievement

### Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Tests save the graph's head before the change, then edit a stored payload, delete a middle event, truncate the last events, and rewrite the whole chain with recalculated `hash` and `prev`. Each is compared with that saved head: the edits and the rewrite report the first differing event id, and truncation reports the first missing event id. | ✓ VERIFIED | `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:399`) walks stored leaves in seq order against recomputed events; `event.ts:388-390` defines `stored-leaves-mismatch` / `first-differing` / `first-missing`; absent leaf → `first-missing` (`event.ts:420`), hash mismatch → `first-differing` (`event.ts:421`). Named tests enumerated in `packages/mcp-server/src/service.test.ts` `describe("heads trust (D73-03, D73-04)")` (line 5526): "an edited payload parts the chain at that event" (5612), "a deleted middle event is first_missing_event_id" (5624), "truncated last events are first_missing_event_id" (5640), "a full rewrite with every hash and prev recalculated parts at the first event" (5653). |
| 2 | The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof. | ✓ VERIFIED | Anchor writer: `buildGraphHeads` (`packages/mcp-server/src/anchor.ts:396`) groups an hour's events by (graph, session), one record per pair (D73-02); `headsRoot` (`packages/ledger/src/heads.ts:60-73`) commits them; `anchorMemo` (`anchor.ts:473`) writes `formatMemoV2` carrying `heads_root` (`packages/ledger/src/memo.ts:11` `substrate:v2:`); `storeAnchor` (`anchor.ts:479-482`) writes `insertGraphChainLeaves` before `insertAnchor`. Trust: `trustHour` (`packages/mcp-server/src/service.ts:8498`) takes `heads_root` only from the signed v2 memo (8518), refuses `trusted` unless stored leaves reproduce it (8543), and never trusts a recomputed head (8492-8496); v1/unanchored hours report explicit untrusted reasons (8512-8516). |

**Score:** 2/2 criteria verified (0 present-behavior-unverified).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/heads.ts` | `headRecordHash`, `headsRoot` over (graph, session) records | ✓ VERIFIED | Substantive: 73-line module, input validation, order-independent sort (byGraphThenSession :55-59). Wired: imported by `anchor.ts`, `service.ts` (`headsRoot` check :8543). |
| `packages/ledger/src/memo.ts` | v2 memo format + parser | ✓ VERIFIED | `formatMemoV2` (:42), `MEMO_V2_RE` (:12), `parseMemo` accepts v1 and v2, rejects other prefixes. Wired by `anchorMemo` (`anchor.ts:473-477`). |
| `packages/mcp-server/src/anchor.ts` | head builder + anchor writer | ✓ VERIFIED | `buildGraphHeads` (:396), `readHourHeads` (:452), `anchorMemo` (:473), `storeAnchor` leaves-before-row (:479). Wired into `runAnchorJob` (:670, :693, :822). |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead` (D73-03) | ✓ VERIFIED | :399-426, walks committed order, reports first differing/missing. Wired by `trustHour` (:8571-8574). |
| `packages/mcp-server/src/service.ts` | `trustHour` / `trusted` verdict (D73-04) | ✓ VERIFIED | :8498-8588, only on-chain v2 `heads_root` trusted; stored leaves must reproduce it. Wired into `verifyGraph` (:8450) and verdict `trusted` (:8478). |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL + accessors | ✓ VERIFIED | DDL `CREATE TABLE IF NOT EXISTS` + `insertGraphChainLeaves` / `hourChainLeaves` (called from `anchor.ts:480`, `service.ts:8530`). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `anchor.ts` `storeAnchor` | `greptime.insertGraphChainLeaves` | leaves written before `insertAnchor` (:480-481) | WIRED | No anchor row without its leaves (D73-02). |
| `anchor.ts` `anchorMemo` | on-chain memo v2 | `formatMemoV2` with `headsRootHex` (:473-477) | WIRED | Per-hour `heads_root` commitment on chain. |
| `service.ts` `trustHour` | `event.ts compareToAnchoredHead` | per (graph, session) pair (:8571-8574) | WIRED | Result kind maps to `first_differing_event_id` / `first_missing_event_id` pair fields. |
| `service.test.ts` | criterion-1 mutations | named tests :5612/:5624/:5640/:5653 | WIRED | Each asserts the expected id and verdict failure, against the saved anchored head. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `trustHour` (`service.ts:8498`) | `leaves` | `greptime.hourChainLeaves(hour)` (:8530) | Yes — stored `graph_chain_leaves` rows | ✓ FLOWING |
| `compareToAnchoredHead` (`event.ts:399`) | `events[].hash` | recomputed `eventHash(content)` at :8563-8566 | Yes — content hash recomputed from stored row, not the stored column | ✓ FLOWING |
| `buildGraphHeads` (`anchor.ts:396`) | `chain` | `inChainOrder(members)` (:412) | Yes — ordered from `prev` links | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 4 mutation tests exist (edit, delete, truncate, rewrite) | grep `service.test.ts` | 5612, 5624, 5640, 5653 + describe at 5526 | ✓ PASS (enumeration) |
| Trust tests exist (unanchored, v1-only, stored-leaves-mismatch) | same enumeration | 5690, 5698, 5708 | ✓ PASS (enumeration) |
| Suite execution | assignment SKIPS gates | not run; prior verification recorded named tests passing | ? SKIP per assignment |

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| HARD-S3 | Phase 73 | Chain canonical checksums; detect modified/deleted/gapped/reordered; report first bad position; name the trusted earlier proof; never claim recomputed hashes prove missing history | ✓ SATISFIED | `compareToAnchoredHead` reports first differing/missing id; `trustHour` trusts only the on-chain v2 `heads_root`, never recomputed heads (D73-04). REQUIREMENTS.md line 114. |

73-01-PLAN.md declares no `requirements` field; HARD-S3 is the phase-mapped requirement per REQUIREMENTS.md table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | - |

`TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` scan over `memo.ts`, `heads.ts`, `anchor.ts`, `event.ts`: no matches (2026-11-20). No stub patterns observed in the verified paths.

### Observations (non-blocking, carried from prior pass)

1. Criterion 2 "each graph's chain head is recorded in the hourly anchor" is satisfied via one `heads_root` commitment per hour plus `graph_chain_leaves` head values verified against it (locked decision D73-01). Per-graph values are not directly readable from the memo.
2. Live devnet sends and production DDL were not exercised, by design (D73-05/D73-06). Operator-gated; not success criteria.
3. Residuals from SUMMARY stand: `graph_chain_leaves` has no primary key (duplicates collapse on read); a failed leaves write after a send can resend next run; events with no `graph_id` get no head and stay covered only by the hour root.

### Gaps Summary

None. Both roadmap criteria are observed in the current code and backed by enumerated named tests. The trusted-proof invariant (never trust a head recomputed from stored rows) holds in `trustHour`.

---

_Verified: 2026-11-20_
_Verifier: Claude (gsd-verifier)_
