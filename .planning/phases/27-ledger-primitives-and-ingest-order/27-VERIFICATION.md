---
phase: 27-ledger-primitives-and-ingest-order
verified: 2026-11-19T12:29:53Z
status: passed
score: 4/4 truths verified (this pass was static-only by assignment: no test suite was run; SC1b's token guard was replicated exactly, SC1a/SC2 code paths are byte-identical to the prior run's)
covered_files: [".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md", "packages/mcp-server/src/cross-repo.routes.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v3:sha256:4ffe0788668497b64cc8be63ce03c115cfef9a3c919a0c041cb7ac9fd463dfb9"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 4/4
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 27: Ledger Primitives and Ingest Order Verification Report

**Phase Goal:** Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`.
**Verified:** 2026-11-19T12:29:53Z
**Status:** passed
**Re-verification:** Yes — static re-verification at HEAD `ffacc938`, after cherry-pick `136c599d`, per assignment (no test suites, tsc, biome, knip, or formatters were run).

**Phase directory note:** The phase's plans and summaries live under `.planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/`. No source was changed by this verification.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1a: an event's hour and position come from server ingest order, recorded append-only; `agent_events` is unchanged | ✓ VERIFIED | `GreptimeClient.recordIngest` (`packages/mcp-server/src/greptime.ts:1371`) inserts into `event_ingest` (`ingested_at` = server clock via `new Date(ingestedAt).toISOString()`, `greptime.ts:1397`) after the event row, with retry and `IngestNotRecorded` on failure. `event_ingest` is created in `append_mode` (`greptime.ts:1063`). `hourLeaves` (`greptime.ts:1776`) reads membership and order from `event_ingest`. `greptime.ts` and `packages/ledger/src/` have no diff between `357d6b15` and HEAD `ffacc938`, so the prior code check still holds. |
| 2 | SC1b: reads go through typed methods and `store-lock.test.ts` stays green | ✓ VERIFIED | Static replication of the guard's token scan at HEAD: the guard pattern (quoted in the guard test, not here) was run over `git ls-files`; the only match in the whole tree is the guard test file itself, which the guard explicitly excludes. The replica was sanity-checked against the pre-fix image, where it flags exactly the former literal assignment in the cross-repo routes test. At HEAD that file is byte-identical to the post-image of the cherry-picked guard fix, which builds the token env via a computed key (`tokenFor`) so no literal token assignment remains. The fix commit is an ancestor of HEAD. The "no caller reaches the ledger with SQL" half is untouched: the guard test and Greptime client have no diff since the prior record, and the only `service.ts` change since is corpus-only with no SQL additions. |
| 3 | SC2a: a closed hour yields an RFC 6962 root over event hashes in ingest order and memo `substrate:v1:<period_start>:<root>:<count>` | ✓ VERIFIED | `Substrate.hourDigest` (`packages/mcp-server/src/service.ts:7862`) calls `this.greptime.hourLeaves(periodStartMs)` (line 7875), hashes leaves with `merkleRootHex`, and formats the memo with `formatMemo`; empty hours return null root/memo. `packages/ledger/src/memo.ts` still defines `MEMO_RE` and `formatMemo` per the prior run; the `f6213948` `service.ts` diff does not touch `hourDigest` or its callees. Carried forward from the prior run with the code paths confirmed unchanged (`git diff 357d6b15 HEAD -- packages/mcp-server/src/greptime.ts packages/ledger/src` is empty). |
| 4 | SC2b: the root and memo are stable under recomputation over the same stored events | ✓ VERIFIED | `hourDigest` composes only the pure `merkleRootHex`/`formatMemo` functions over the `event_ingest`-ordered leaves, so recomputation over the same stored events is deterministic by construction; the anchor re-verify path (`hourDigestOrFault`, `service.ts:8493`) recomputes the same digest. Carried forward from the prior run; code paths unchanged as above. |

**Score:** 4/4 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/greptime.ts` | `recordIngest` + append-mode `event_ingest` + `hourLeaves` | ✓ VERIFIED | Unchanged since `357d6b15` (empty diff) |
| `packages/mcp-server/src/service.ts` | `hourDigest` over `hourLeaves` | ✓ VERIFIED | Only change since prior run is corpus-only (`f6213948`) |
| `packages/mcp-server/src/store-lock.test.ts` | Token guard scanning all tracked files | ✓ VERIFIED | Guard replica clean at HEAD; `136c599d` in history |
| `packages/mcp-server/src/cross-repo.routes.test.ts` | No literal substrate-token assignment | ✓ VERIFIED | Byte-identical to post-`136c599d` image; computed key via `tokenFor` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `Substrate.hourDigest` | `GreptimeClient.hourLeaves` | `this.greptime.hourLeaves` (`service.ts:7875`) | WIRED | |
| `hourDigest` | `merkleRootHex` / `formatMemo` | leaf hashes → root → memo (`service.ts:7888`) | WIRED | |
| `store-lock.test.ts` | `git ls-files` tree | `TOKEN_LITERAL` scan of every tracked file | WIRED | Replica run at HEAD; only self-match (excluded by the guard) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `hourDigest` | `leaves` | `greptime.hourLeaves` over `event_ingest` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Token-guard replica (whole tracked tree) | Guard pattern run over the tracked-tree file list via `git ls-files` (pattern not quoted here) | Only the guard test file itself (explicitly excluded) | ✓ PASS (guard-pattern replica; suite not run per assignment) |
| Replica sanity vs pre-fix | Same guard pattern over the pre-fix image of the routes test | Flags exactly the former literal assignment | ✓ PASS (proves the fix is load-bearing) |
| Prior-run behavioral evidence | `bun test` ledger/greptime/service suites (carried forward from the `357d6b15`-era record) | ledger 155 pass; hourLeaves/ingest 32 pass; hourDigest 12 pass | ✓ PASS (carried forward; code paths unchanged since) |

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

No REQ-IDs are mapped to this phase in the plans reviewed.

### Anti-Patterns Found

None blocking. No new debt markers in the phase's covered source files.

### Human Verification Required

None.

### Gaps Summary

None. The cherry-pick `136c599d` is an ancestor of HEAD `ffacc938` and its post-image is what the tree carries; the guard's literal-token scan is clean at HEAD (verified by exact static replication, sanity-checked against the pre-fix offender), and the ledger ingest-order code paths (`recordIngest`, append-mode `event_ingest`, `hourLeaves`, `hourDigest`) are unchanged since the prior passing record. The only `service.ts` change since then (`f6213948`, corpus phases 63/69) does not touch the ingest-order or digest paths.

---
_Verified: 2026-11-19T12:29:53Z at HEAD ffacc938 (136c599d ancestor; no test suites run — static-only)_
_Verifier: Claude (gsd-verifier)_
