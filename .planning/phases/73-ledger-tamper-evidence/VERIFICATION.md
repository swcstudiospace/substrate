---
phase: 73-ledger-tamper-evidence
verified: 2026-11-12T00:00:00Z
status: passed
score: 2/2 roadmap success criteria verified (0 gaps)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", ".planning/phases/73-ledger-tamper-evidence/73-CONTEXT.md", "docs/corpus-proofs.md", "docs/greptime-ledger.md", "docs/runbooks/devnet-reset-and-reanchor.md", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:599b58bd2d31f9958520de80dc68a7f16a245faf603f88c00e034f06de655ae9"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from the stored rows, and the verified head is anchored.
**Verified:** 2026-11-12
**Status:** passed
**Re-verification:** No — initial verification (no prior VERIFICATION.md existed)

Scope: code on branch `reconcile/main-2026-11-11` in this checkout. The SUMMARY's claims were checked against the source and the named tests, not taken as evidence.

## Goal Achievement

### Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Tests save the head before the change, then edit a stored payload, delete a middle event, truncate the tail, and rewrite the whole chain with recalculated `hash` and `prev`. Edits and the rewrite report `first_differing_event_id`; truncation reports `first_missing_event_id`. | ✓ VERIFIED | `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:399`) walks the stored leaves in seq order against the recomputed events. The saved head is the on-chain v2 memo plus its stored leaves, built by the `v2World` fixture (`service.test.ts` ~5280). Named tests in `service.test.ts` `describe("heads trust (D73-03, D73-04)")`: "an edited payload parts the chain at that event: first_differing_event_id" (5347); "a deleted middle event is first_missing_event_id, and the verdict fails" (5359); "truncated last events are first_missing_event_id at the first one gone, and the verdict fails" (5375); "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails" (5388). All four pass (see Spot-checks). |
| 2 | The chain head for each graph is recorded in the hourly anchor. The recorded head is the trusted proof criterion 1 compares against; a head recomputed from stored rows is never the proof. | ✓ VERIFIED | Anchor writer: `anchor.ts` `buildGraphHeads` (~396) builds one record per (graph, session); `headsRoot` (`packages/ledger/src/heads.ts:59`) commits them; `anchorMemo` (~472) writes `formatMemoV2` carrying `heads_root`; `storeAnchor` writes leaves before the row. Trust: `service.ts` `trustHour` (~8190) takes `heads_root` only from the parsed on-chain memo of a session-signed hour (`service.ts` ~8474, ~8503); `report.heads_root === undefined` yields `trusted: false`, so recomputed heads are never used. Tests: anchor.test.ts "an hour with events anchors a v2 memo carrying the heads root" and "a leaves write failure stops the anchor: no row is written"; service.test.ts "an honest v2 hour is trusted, and each session matches its own head", "an unanchored hour is untrusted, with the reason", "a v1-only anchored hour is untrusted with its reason", "stored leaves that no longer reproduce the on-chain heads root are a stored-leaves-mismatch for the whole hour". All pass. |

**Score:** 2/2 criteria verified.

### Plan Acceptance (73-01-PLAN.md U1-U4)

| Unit | Acceptance | Status | Evidence |
|------|-----------|--------|----------|
| U1 memo v2 | v1 parses unchanged; v2 round-trips; malformed v2 refused; `headsRoot` order-independent | ✓ | `memo.ts` `formatMemoV2`, `parseMemo`; `memo.test.ts` "formats the v2 memo and round-trips it through parseMemo", "parseMemo returns null for anything but an exact v2 memo"; `heads.test.ts` "is identical for every input order" |
| U2 head builder, leaves, writer | Deterministic heads; read-order independent; leaves before anchor; failed leaves blocks anchor; v1 hours still verify | ✓ | anchor.test.ts "the same hour gives the same heads and leaves every time", "a permuted read order gives identical heads and leaves, forks included", "a leaves write failure stops the anchor: no row is written", "an hour no graph owns anchors the v1 memo and writes no leaves" |
| U3 verifier | Named mutations give expected id; no recomputed head trusted; existing callers keep fields | ✓ | service.test.ts tests listed above; "ok is false when the stored leaves are edited against an unchanged on-chain root"; "a graph with no events is untrusted: no events" |
| U4 docs | Memo v2, `graph_chain_leaves`, trusted-head rule, v1 compatibility documented | ✓ | `docs/greptime-ledger.md` (trust rule and v1 section, ~563-567), `docs/corpus-proofs.md`, `docs/runbooks/devnet-reset-and-reanchor.md` |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/memo.ts` | v1 unchanged, v2 format and parser | ✓ VERIFIED | `MEMO_V2_RE`, `formatMemoV2`, dual `parseMemo` |
| `packages/ledger/src/heads.ts` | `headRecordHash`, `headsRoot` | ✓ VERIFIED | Sorted by (graphId, sessionId); duplicate pair and empty input refused |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead`, `orderedLeaves`, `headRecordsFromLeaves`, generic `inChainOrder` | ✓ VERIFIED | Lines 283, 342, 359, 399 |
| `packages/mcp-server/src/anchor.ts` | `buildGraphHeads`, v2 memo, leaves before row | ✓ VERIFIED | `storeAnchor` writes leaves, then the row |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL and writer, `hourChainLeaves` reader | ✓ VERIFIED | `CREATE TABLE IF NOT EXISTS "graph_chain_leaves"` (~1031); `insertGraphChainLeaves` (~1830) |
| `packages/mcp-server/src/service.ts` | `trustHour`, per-hour `trusted`, `ok` gating | ✓ VERIFIED | `trustHour` ~8190; `hourReport` trust fields ~8203 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `anchor.ts` `anchorMemo` | `memo.ts` `formatMemoV2` | heads root | ✓ WIRED | anchor.ts:475 |
| `anchor.ts` `storeAnchor` | `greptime.ts` `insertGraphChainLeaves` | leaves before row | ✓ WIRED | anchor.ts:480-481 |
| `anchor.ts` read-back | `parseMemo` `headsRootHex` | `back.headsRootHex !== heads?.headsRootHex` → send-failed | ✓ WIRED | anchor.ts ~811 |
| `service.ts` `trustHour` | `event.ts` `compareToAnchoredHead` | per-session pair | ✓ WIRED | service.ts ~8290 |
| `service.ts` `verifyGraph` memo parse | `heads_root` source | `parseMemo(memo.memo)` on the signed transaction | ✓ WIRED | service.ts ~8474 |

### Data-Flow Trace (Level 4)

Not applicable beyond the verifier path: the verdict's pairs flow from `greptime.hourChainLeaves` through `compareToAnchoredHead` against the on-chain `heads_root`, and the tests exercise that flow with fakes.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Memo v1/v2 parse, format, refusal; head record hashing and order independence | `bun test packages/ledger/src/memo.test.ts packages/ledger/src/heads.test.ts` (run in packages/ledger root of this repo) | 29 pass, 0 fail | ✓ PASS |
| Criterion 1 tamper cases and trust verdicts | `bun test src/service.test.ts -t "heads trust"` (in packages/mcp-server) | 23 pass, 0 fail (263 filtered) | ✓ PASS |
| Anchor head builder, leaves-before-row, v2 anchoring | `bun test src/anchor.test.ts -t "anchor heads"` (in packages/mcp-server) | 9 pass, 0 fail (39 filtered) | ✓ PASS |

Full suite not run here, per the verifier scope. The SUMMARY's gate claims were not re-run.

### Probe Execution

No probes are declared for this phase. Skipped.

### Requirements Coverage

No requirement IDs are declared in 73-01-PLAN.md. Not applicable.

### Anti-Patterns Found

Debt-marker scan (`TBD|FIXME|XXX`) over the phase-touched source and docs: none. `TODO|HACK|PLACEHOLDER` over the core head/memo/anchor/event files: none.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | - |

### Observations (non-blocking)

1. **Criterion 2 reads "each graph's chain head is recorded in the hourly anchor".** The on-chain memo carries one `heads_root` commitment per hour, not each graph's head value. The head values live in `graph_chain_leaves` and the verifier accepts them only after they reproduce the on-chain root. This is the locked decision D73-01, and `heads_root` covers `headEventId` and `headHashHex` through `headRecordHash`. I read this as satisfying criterion 2. If the owner means per-graph head values to be readable from the memo itself, that is a scope change and needs a decision.
2. **Criterion 1's "saved head" is a test fixture.** The `v2World` fixture builds the honest hour, its memo and its stored leaves with the same functions the anchor job uses. It does not run a live anchor send. This is the test harness D73-07 specifies.
3. **Middle deletion** is not named in the criterion's expected-id list. It is tested and reports `first_missing_event_id`, which is consistent with truncation.
4. **Live devnet sends and production DDL were not exercised**, by design (D73-05). They are operator-gated and are not success criteria.
5. **Residuals from the SUMMARY, all accepted in the plan:** `graph_chain_leaves` has no primary key, so duplicate rows collapse on read; a failed leaves write after a send can lead to a resend on the next run, which is the same exposure `insertAnchor` already has; events with no `graph_id` get no head and stay covered only by the hour root; the leaves read is bounded to the hour but covers all graphs in that hour.

### Gaps Summary

None. Both roadmap success criteria are observed in code, and each is backed by a named test that passes. The residuals in observation 5 are documented by the phase and do not block either criterion.

---

_Verified: 2026-11-12_
_Verifier: Claude (gsd-verifier)_
