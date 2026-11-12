---
phase: 78-cross-layer-reconciliation
verified: 2026-11-12T07:45:50Z
status: human_needed
score: 1/2 must-haves verified
covered_files: [".planning/phases/78-cross-layer-reconciliation/CONTEXT.md", ".planning/phases/78-cross-layer-reconciliation/PLAN.md", ".planning/phases/78-cross-layer-reconciliation/SUMMARY.md", "docs/greptime-ledger.md", "infra/vps/README.md", "infra/vps/substrate-cross-layer-reconcile.service", "infra/vps/substrate-cross-layer-reconcile.timer", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/cross-layer-reconcile-run.test.ts", "packages/mcp-server/src/cross-layer-reconcile-run.ts", "packages/mcp-server/src/cross-layer-reconcile.test.ts", "packages/mcp-server/src/cross-layer-reconcile.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:32be31edaed442f8fd6d7b71012025b587d8c042be73ba285e789097ad5c26d2"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Install the staged unit pair and drop-in per infra/vps/README.md, run daemon-reload, enable --now substrate-cross-layer-reconcile.timer, then read the first tick in the journal (journalctl -u substrate-cross-layer-reconcile)."
    expected: "The journal shows per-layer counts (ledger, index, cache) and coverage. Exit 0 on a clean run. Before and after the tick, the ledger note count, the index forget markers and the cache forget mark are unchanged."
    why_human: "The unit is staged under infra/vps and not installed on the running host. Installing it is an operator step; this verifier cannot observe the running system."
  - test: "Only if the operator approves a live mismatch: plant one forget whose index row is still in force, let the next tick run, and read the result."
    expected: "The tick exits 3 and its journal line names the first mismatching key (layer index, reason in-force). Nothing is written. Repair happens only through a separate confirmed plan."
    why_human: "It needs a live mismatch on production stores and an operator decision. The unit tests use fakes."
  - test: "Decide whether the memory.forget pair alone satisfies the phase goal, 'the ledger, the index and the cache agree', or whether index-to-ledger and cache-to-index comparisons are required before the phase closes."
    expected: "A recorded decision. Either accept the narrowed scope in writing, or open follow-up work for the remaining pairs."
    why_human: "The narrowing is a documented design decision (CONTEXT D78-01/D78-02), not a code defect. Scope reduction needs an explicit owner decision."
---

# Phase 78: Cross-layer reconciliation - Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-12T07:45:50Z
**Status:** human_needed
**Re-verification:** No. The earlier hand-written VERIFICATION.md was used only as a set of leads and is replaced by this report.

## Scope Verified

Only the memory.forget pair is compared. Ledger to index: each entry a `memory.forget` note names must not still be in force. Ledger to cache: the forget mark is at or after the latest forget that marked rows. Index to ledger and cache to index are not compared. This is the documented decision D78-01/D78-02 in CONTEXT.md, and the ROADMAP itself records the phase as PARTIAL.

## Goal Achievement

### Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run. | ? NOT OBSERVED IN RUNNING SYSTEM | Code and tests observe the behaviour. `runScheduledReconcile` in `packages/mcp-server/src/cross-layer-reconcile.ts` performs reads only (`notesBetween`, `memoryMarkers`, `readForgetMark`). Test `a clean run reports every layer and writes nothing` (`cross-layer-reconcile.test.ts`) asserts exact layer counts and empty ledger, index and cache write lists. Test `a planted in-force entry is reported with its first key and the per-layer counts` asserts the first key `mem_b`. Test `a clean run reads the ledger window and leaves all three layers as they were` and test `a dirty run names the first mismatching key in text and still writes nothing` (`cross-layer-reconcile-run.test.ts`) cover the tick wrapper. **The scheduled run is not observed in the running system.** The unit pair is staged, not installed: `infra/vps/substrate-cross-layer-reconcile.service` and `.timer` (commit a5d6bc03), with a drop-in (a6fbef3d). `infra/vps/README.md` lists copying and `systemctl enable --now` as operator steps. On this host, `systemctl list-unit-files` and `/etc/systemd/system` show no cross-layer units. The verifier cannot inspect the production host, so this criterion is not verified. |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules. | ✓ VERIFIED | `planRepair` writes one `reconcile.plan` ledger note, and its event id is the plan id. `applyRepair` refuses unless `confirm === planId`, checks the stored plan's `itemsSha256`, marks only planned keys still in force (`markMemoryForgotten` is guarded by `superseded_by is null`), and records a `reconcile.applied` note. Named tests that pass: `a planned repair records one plan and changes nothing`; `apply without a confirmed plan id is refused and writes nothing`; `apply with a plan id that is not a stored plan is refused`; `apply refuses a note that is not a plan, and a plan whose items were altered after it was written`; `apply marks the planned entries, leaves unplanned and superseded rows alone, and records what it did`; `a repeat apply marks nothing new`. The delete rules in `cross-layer-reconcile.ts` (scope, never overwrite, never remove, planned keys only) are visible in code and in these tests. |

**Score:** 1/2 roadmap criteria verified. Criterion 1 is pending its running-system observation.

## Verification Runs (this session)

- `bun test packages/mcp-server/src/cross-layer-reconcile.test.ts packages/mcp-server/src/cross-layer-reconcile-run.test.ts` from the repo root: **32 pass, 0 fail, 126 expect() calls**. These are the only two test files run. The full suite, typecheck and lint were not run.
- Debt-marker scan (`TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER`) over the phase's changed implementation and unit files: no matches.
- Probes: none declared for this phase. Probe execution skipped.

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/cross-layer-reconcile.ts` | Ports, forget reader, judgements, report, plan, apply, ledger adapter | ✓ VERIFIED | 613 lines. The read-only path and the confirmed-apply path are both present and both tested. |
| `packages/mcp-server/src/cross-layer-reconcile-run.ts` | Thin tick entry, read-only writer | ✓ VERIFIED | Its `READ_ONLY_WRITER.emit` throws, so any ledger write from the tick would fail loudly. Exit codes 0 clean, 3 mismatch, 1 unreadable layer, 2 usage. |
| `packages/mcp-server/src/greptime.ts` `readEvent` | Read one event by id, with payload | ✓ VERIFIED | Present. Covered only by fakes. |
| `packages/mcp-server/src/index-store.ts` `memoryMarkers` | `superseded_by` per id, bounded | ✓ VERIFIED | Present, bounded by `MAX_FORGET_LOOKUP_IDS` = 500. The reconcile caps keys at 200, so the bound is not exceeded. Covered only by fakes. |
| `packages/mcp-server/src/cache.ts` `readForgetMark` | `disabled`, `absent` or `present`; throws on read failure | ✓ VERIFIED | Present and typed as `ForgetMarkRead`. Covered only by fakes. |
| `infra/vps/substrate-cross-layer-reconcile.{service,timer}` | Staged daily unit, read-only | ⚠️ STAGED | In the tree; not installed on the host. Feeds criterion 1. |
| `docs/greptime-ledger.md` "Cross-layer reconcile (phase 78)" | Accurate description of the shipped behaviour | ⚠️ STALE | Line 976 says "It is a function, not a unit ... No systemd unit or flag is added." That is no longer true after a5d6bc03. |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `cross-layer-reconcile-run.ts` | `runScheduledReconcile` | `runTick` | ✓ WIRED | |
| `cross-layer-reconcile-run.ts` | `GreptimeClient`, `IndexStore`, `createReadThroughCache` | `main` / `scheduledDeps` | ✓ WIRED | |
| `ledgerFromSubstrate` | `Substrate.emit` | `NoteWriter` | ✓ WIRED | Used by `planRepair` and `applyRepair`. The tick uses the read-only writer instead. |
| `planRepair` / `applyRepair` | any operator entry point | — | ⚠️ NOT WIRED | No non-test caller exists. Repair is reachable only as a function call. No CLI, MCP route or unit invokes it. This is consistent with the phase brief but leaves criterion 2 without an operator path. |
| `service.ts` | `forgetMarkTtlS` | `memoryForget` mark TTL | ✓ WIRED | The forget mark TTL is shared between `memoryForget` and the reconcile. |

## Warnings

1. **Scope is narrower than the phase goal.** The goal reads "ledger, index and cache agree". Only the forget pair is judged. The index-to-ledger direction (an index forget with no ledger note) and the cache-to-index direction are not compared. The limits are documented (D78-02, SUMMARY "Limits"). ROADMAP line 148 records the phase as PARTIAL. See human item 3.
2. **Stale documentation.** `docs/greptime-ledger.md` line 976 and `CONTEXT.md` D78-12 both say no unit is added. a5d6bc03 contradicts both. The ROADMAP progress row ("scheduler unwired") is also stale. ROADMAP and STATE are outside this verifier's write scope.
3. **No operator path to repair.** `planRepair` and `applyRepair` are exported and tested, but nothing calls them outside the tests. The "separate confirmed step" exists in code only.
4. **Store methods covered only by fakes.** `readEvent`, `memoryMarkers` and `readForgetMark` have no test against real Greptime, Postgres or Redis. SUMMARY says the same.
5. **Hindsight documents are not deleted by repair** (D78-14). This is a documented limit, not a gap.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `docs/greptime-ledger.md` | 976 | Stale claim: "No systemd unit or flag is added." | ⚠️ Warning | Misleads operators about the shipped unit. |
| `.planning/ROADMAP.md` | Progress row 78 | "scheduler unwired" | ℹ️ Info | Stale against a5d6bc03. Outside this verifier's write scope. |

## Human Verification Required

### 1. Install the unit and read the first live tick

**Test:** Install the staged unit pair and drop-in per `infra/vps/README.md`, run `daemon-reload`, then `systemctl enable --now substrate-cross-layer-reconcile.timer`. Read the first tick with `journalctl -u substrate-cross-layer-reconcile`.
**Expected:** The journal shows per-layer counts and coverage. Exit is 0 on a clean run. Before and after the tick, the ledger note count, the index forget markers and the cache forget mark are unchanged.
**Why human:** The unit is staged and not installed on the running host. Installing it is an operator step.

### 2. Live dirty-run check (only if the operator approves)

**Test:** Plant one forget whose index row is still in force, let the next tick run, then read the result.
**Expected:** Exit 3, and the journal line names the first mismatching key (layer index, reason in-force). Nothing is written.
**Why human:** It needs a live mismatch on production stores and an operator decision.

### 3. Accept or extend the narrowed scope

**Test:** Decide whether the forget pair alone satisfies "the ledger, the index and the cache agree".
**Expected:** A recorded decision. Either accept the narrowed scope in writing, or open follow-up work for index-to-ledger and cache-to-index.
**Why human:** This is a scope decision for the owner.

## Gaps Summary

No BLOCKER. The code and tests for criteria 1 and 2 are present and passing. Criterion 1 is pending a running-system observation because the scheduled unit is staged but not installed. Criterion 2 is verified in code and tests, but it has no operator entry point. The phase is correctly reported as PARTIAL in the ROADMAP, and the verdict is `human_needed`.

---

_Verified: 2026-11-12T07:45:50Z_
_Verifier: Claude (gsd-verifier)_
