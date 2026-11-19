---
phase: 27-ledger-primitives-and-ingest-order
verified: 2026-11-19T00:00:00Z
status: passed
score: 4/4 truths verified (SC2 evidence carried forward from the 357d6b15 run; its code paths are unchanged at the candidate)
covered_files: [".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v3:sha256:5f5385d959eff9c7dabc70cd881936dd087a8844868fa05d268d48ae28f154f3"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "SC1b: store-lock.test.ts stays green. 'no tracked file assigns a substrate token a value' passes. The phase 74 fixture at packages/mcp-server/src/cross-repo.routes.test.ts:65 no longer carries a literal token; the candidate file is byte-identical to the post-image of 0e17f457 (the same change also sits in HEAD as 136c599d)."
  gaps_remaining: []
  regressions: []
---

# Phase 27: Ledger Primitives and Ingest Order Verification Report

**Phase Goal:** Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`.
**Verified:** 2026-11-19T00:00:00Z
**Status:** passed
**Re-verification:** Yes. The prior record (gaps_found, 3/4, at HEAD `357d6b15`) is replaced by this one. The phase 27 code is unchanged since that record. The blocking gap was the store-lock guard flagging the phase 74 fixture, and that fixture is now fixed.

**Phase directory note:** The phase's plans, summaries and the archived 2026-10-11 record live under `.planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/`. This record is written to the expected phase path. No source was changed by this verification.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1a: an event's hour and position come from server ingest order, recorded append-only; `agent_events` is unchanged | ✓ VERIFIED | `GreptimeClient.recordIngest` (`packages/mcp-server/src/greptime.ts:1329`) writes `event_ingest` after the event row, stamped with the server clock. `event_ingest` is created in `append_mode` (`greptime.ts:1014`). `hourLeaves` (`greptime.ts:1717`) reads membership and rank from it. `greptime.ts` has no commits and no uncommitted edits since `357d6b15`, so the prior code check still holds. |
| 2 | SC1b: reads go through typed methods and `store-lock.test.ts` stays green | ✓ VERIFIED | `bun test packages/mcp-server/src/store-lock.test.ts` at the candidate: 36 pass, 0 fail, 36 declared tests. This includes `no tracked file assigns a substrate token a value` and `no caller reaches the ledger with SQL`. The `SELECT` grep hit in `service.ts` is the identifier `ROLLBACK_SELECTION_LIMIT`, not a statement. |
| 3 | SC2a: a closed hour yields an RFC 6962 root over event hashes in ingest order and memo `substrate:v1:<period_start>:<root>:<count>` | ✓ VERIFIED | `Substrate.hourDigest` (`packages/mcp-server/src/service.ts:7862`) takes leaves from `greptime.hourLeaves`, roots them with `merkleRootHex`, and formats the memo with `formatMemo`. `MEMO_RE` (`packages/ledger/src/memo.ts:10`) matches `substrate:v1:<ISO hour>:<64-hex>:<count>`. Carried forward from the `357d6b15` run: `bun test packages/ledger/` 155 pass; `service.test.ts -t hourDigest` 12 pass. No commits touch these paths since `357d6b15`. The only uncommitted `service.ts` hunks are at lines 6298–6900, outside `hourDigest`. |
| 4 | SC2b: recomputing the hour gives the same root and memo | ✓ VERIFIED | `hourDigest` is a pure function of the stored leaves. `hourLeaves` sorts by ingest position and collapses duplicates, so server row order cannot move the root. Carried forward from the `357d6b15` run: `greptime.test.ts -t "hourLeaves|ingest"` 32 pass; `service.test.ts -t hourDigest` 12 pass. |

**Score:** 4/4 truths verified (0 present-behavior-unverified)

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/greptime.ts` | ingest-order write and hour leaves | ✓ VERIFIED | `recordIngest`, `event_ingest` append_mode DDL, `hourLeaves` present; unchanged since `357d6b15` |
| `packages/mcp-server/src/service.ts` | `hourDigest` and typed reads | ✓ VERIFIED | `hourDigest` at line 7862; uncommitted hunks are outside it |
| `packages/mcp-server/src/store-lock.test.ts` | guard suite | ✓ VERIFIED | 36/36 pass at the candidate |
| `packages/ledger/src/memo.ts` | `MEMO_RE` and `formatMemo` | ✓ VERIFIED | `MEMO_RE` at line 10; carried forward from the prior run |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `Substrate.hourDigest` | `GreptimeClient.hourLeaves` | `this.greptime.hourLeaves` (`service.ts:7884`) | WIRED | |
| `hourDigest` | `merkleRootHex` / `formatMemo` | leaf hashes → root → memo | WIRED | Carried forward from the prior run |
| `store-lock.test.ts` | ledger and service source files | file scan of tracked sources | WIRED | Scan covers the fixed fixture |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `hourDigest` | `leaves` | `greptime.hourLeaves` over `event_ingest` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Guard suite is green | `bun test packages/mcp-server/src/store-lock.test.ts --timeout 60000` | 36 pass, 0 fail | ✓ PASS |
| Ledger root and memo | `bun test packages/ledger/` (carried forward, `357d6b15`) | 155 pass, 0 fail | ✓ PASS (carried forward) |
| Hour-leaf ordering | `bun test packages/mcp-server/src/greptime.test.ts -t "hourLeaves|event_ingest|ingest"` (carried forward) | 32 pass, 0 fail | ✓ PASS (carried forward) |
| Hour digest | `bun test packages/mcp-server/src/service.test.ts -t hourDigest` (carried forward) | 12 pass, 0 fail | ✓ PASS (carried forward) |

The SC2 and SC1a checks were not re-run in this pass. Only `store-lock.test.ts` was run here, as assigned. Their code paths are unchanged since the run that produced them.

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

No REQ-IDs are mapped to this phase in the plans reviewed.

### Anti-Patterns Found

None blocking. No new debt markers in the phase's covered source files.

### Human Verification Required

None.

### Gaps Summary

None. The single blocking gap from the prior record is closed. The phase 74 fixture that the secret-literal guard flagged is fixed in the candidate, and the guard now passes. The guard itself was not weakened.

---

_Verified: 2026-11-19T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
