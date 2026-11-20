---
phase: 78-cross-layer-reconciliation
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 2/4 must-haves verified
covered_files: [".planning/phases/78-cross-layer-reconciliation/CONTEXT.md", ".planning/phases/78-cross-layer-reconciliation/PLAN.md", ".planning/phases/78-cross-layer-reconciliation/SUMMARY.md", "docs/greptime-ledger.md", "infra/vps/README.md", "infra/vps/substrate-cross-layer-reconcile.service", "infra/vps/substrate-cross-layer-reconcile.timer", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/cross-layer-reconcile-pairs-run.test.ts", "packages/mcp-server/src/cross-layer-reconcile-pairs.test.ts", "packages/mcp-server/src/cross-layer-reconcile-pairs.ts", "packages/mcp-server/src/cross-layer-reconcile-repair-run.test.ts", "packages/mcp-server/src/cross-layer-reconcile-repair-run.ts", "packages/mcp-server/src/cross-layer-reconcile-run.test.ts", "packages/mcp-server/src/cross-layer-reconcile-run.ts", "packages/mcp-server/src/cross-layer-reconcile.test.ts", "packages/mcp-server/src/cross-layer-reconcile.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:86c675ec769b702cefdbd4148aaaabe98c5ea27635d2064f37933ecd070b9583"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Install the staged unit pair and drop-in per infra/vps/README.md, run daemon-reload, enable --now substrate-cross-layer-reconcile.timer, then read the first tick with journalctl -u substrate-cross-layer-reconcile."
    expected: "The journal shows per-layer counts (ledger forget notes, index forgotten/superseded/absent/in-force, cache state) and coverage, with exit 0 on a clean run. Ledger note count, index forget markers and cache forget mark are unchanged before and after the tick."
    why_human: "The unit is staged under infra/vps and not installed on the running host. Installing it is an operator step; this verifier cannot observe the running system."
  - test: "Set SUBSTRATE_RECONCILE_GRAPHS to the named graphs (or accept the default of judging none) and decide whether the two graph pairs now satisfy the phase goal, 'the ledger, the index and the cache agree', given that index-to-ledger drift is reported with no automatic repair."
    expected: "A recorded decision. Either accept the narrowed scope in writing (forget pair always judged; graph pairs judged only when graphs are named; index-to-ledger report-only), or open follow-up work for default scheduling and an index-to-ledger repair."
    why_human: "Scope and scheduling decisions need an explicit owner decision, not a code defect."
  - test: "Only if the operator approves a live mismatch: plant one forget whose index row is still in force, let the next tick run, and read the result."
    expected: "Exit 3 and the journal names the first mismatching key (layer index, reason in-force). Nothing is written; repair happens only through a separate confirmed plan."
    why_human: "Needs a live mismatch on production stores and an operator decision. Unit tests use fakes."
re_verification:
  previous_status: human_needed
  previous_score: 1/2
  gaps_closed:
    - "index-to-ledger and cache-to-index pairs now exist (cross-layer-reconcile-pairs.ts:239,298,369) with cache-to-index confirmed repair (cross-layer-reconcile-pairs.ts:490)"
  gaps_remaining:
    - "Pairs run only when SUBSTRATE_RECONCILE_GRAPHS names graphs (cross-layer-reconcile-run.ts:268); index-to-ledger has no repair by design (cross-layer-reconcile-pairs.ts:17-24)"
    - "Scheduled unit staged under infra/vps, not installed on the running host"
  regressions: []
---

# Phase 78: Cross-layer reconciliation - Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** Yes — after new pair code landed (8ce3097c, d913bd51) since the prior 1/2 report.

Code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply).

## Pairs compared vs not (file:line)

| Pair | Compared in code? | Scheduled by default? | Repair? | Evidence |
|---|---|---|---|---|
| ledger -> index (forget: named entry must not be in force) | Yes | Yes (scheduled tick) | Yes — confirmed plan (planned keys only) | `packages/mcp-server/src/cross-layer-reconcile.ts:443` (runScheduledReconcile), `packages/mcp-server/src/index-store.ts:2446` (memoryMarkers) |
| ledger -> cache (forget mark at/after latest forget) | Yes | Yes | Yes — via plan (cache-mark item, planned keys only) | `packages/mcp-server/src/cache.ts:878` (readForgetMark), `packages/mcp-server/src/cross-layer-reconcile.ts:443` |
| index -> ledger (forget: unnoted index forget) | Yes, report-only | Yes (inside forget reconcile) | No — no repair item; reported only | `packages/mcp-server/src/cross-layer-reconcile.ts:404-418` (unnoted-forget, reportOnly) |
| cache -> index (forget: mark present, index still in force) | Yes, report-only | Yes (inside forget reconcile) | No — no repair item; reported only | `packages/mcp-server/src/cross-layer-reconcile.ts:404-418` (forget-not-in-index, reportOnly) |
| index -> ledger (graph provenance: source_event must be a ledger event) | Yes, detection only | Only when SUBSTRATE_RECONCILE_GRAPHS names graphs | No — explicitly no automatic repair | `packages/mcp-server/src/cross-layer-reconcile-pairs.ts:239` (reconcileIndexLedger), `packages/mcp-server/src/cross-layer-reconcile-pairs.ts:17-24` (“Only the cache -> index pair has a repair”), `packages/mcp-server/src/cross-layer-reconcile-run.ts:154,268` |
| cache -> index (graph view vs index nodes/versions) | Yes | Only when SUBSTRATE_RECONCILE_GRAPHS names graphs | Yes — confirmed plan (two generation bumps only) | `packages/mcp-server/src/cross-layer-reconcile-pairs.ts:298,369,490`, `packages/mcp-server/src/cross-layer-reconcile-run.ts:212,231,268` |

Reads used (no schema change, per PLAN Task 1): `packages/mcp-server/src/greptime.ts:1347` (readEvent),
`packages/mcp-server/src/index-store.ts:2446` (memoryMarkers), `packages/mcp-server/src/cache.ts:878` (readForgetMark — throws on failed read, never reports a failed read as absent).

## Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Scheduled reconcile reads all three layers, reports per-layer counts and the first mismatching key, and writes nothing | ✓ VERIFIED (code; running-system observation pending) | `runScheduledReconcile` at `packages/mcp-server/src/cross-layer-reconcile.ts:443` calls `observe` (ledger window via `ledgerFromSubstrate`, `index.memoryMarkers`, `cache.readForgetMark`) and returns only a report. `runTick` at `packages/mcp-server/src/cross-layer-reconcile-run.ts:117` renders it via `renderReport` at `packages/mcp-server/src/cross-layer-reconcile-run.ts:101`: ledger forget-notes/with-marks/named-entries, index forgotten/superseded/absent/in-force, cache state, coverage, mismatch count and `first` key. `READ_ONLY_WRITER` at `packages/mcp-server/src/cross-layer-reconcile-run.ts:74` throws on any emit; `scheduledDeps` at `:82` wires it into the tick; `main` at `:253-274` runs the tick read-only. Exit 3 (mismatch) still writes nothing. |
| 2 | Repair is via confirmed plan only (forget pair) | ✓ VERIFIED | `planRepair` at `packages/mcp-server/src/cross-layer-reconcile.ts:474` writes ONE `reconcile.plan` ledger note (event id = plan id) and returns that id; writes nothing on clean or incomplete reads. `applyRepair` at `:628` refuses unless `confirm === planId` (`:629-631`, returns `not-confirmed`, writes nothing), validates the stored plan’s `itemsSha256` digest (`:635-638`), and marks only planned, still-in-force entries (`:639-652`, guarded `markMemoryForgotten`), recording `reconcile.applied`. Named tests at `packages/mcp-server/src/cross-layer-reconcile.test.ts:208,230,427-491` cover clean/no-write, first key, and confirm/digest/planned-keys-only. |
| 3 | Index-to-ledger pair is judged with per-layer counts and first key | ? PRESENT — needs human decision | `reconcileIndexLedger` at `packages/mcp-server/src/cross-layer-reconcile-pairs.ts:239` reports ledger events, index rows, settling/unsourced/session-refs/judged/matched/mismatched and first mismatch; `runPairReconcile` at `:369` is read-only. But the scheduled tick runs it only when `SUBSTRATE_RECONCILE_GRAPHS` names graphs: `graphIdsFrom` at `packages/mcp-server/src/cross-layer-reconcile-run.ts:132,142-143`, `pairs === null` when unset at `:268-271` (“pairs not run”). And a mismatch has no automatic repair by design (`cross-layer-reconcile-pairs.ts:17-24`). Whether “judged when env set, report-only” satisfies the goal needs owner sign-off. |
| 4 | Cache-to-index pair is judged and repairable only via confirmed plan | ? PRESENT — needs human decision | `reconcileCacheIndex` at `packages/mcp-server/src/cross-layer-reconcile-pairs.ts:298` compares every `PAIR_SURFACES` cached view to index nodes/versions; `planCacheIndexRepair` at `:456` writes ONE `reconcile.plan.cache-index` note and `applyCacheIndexRepair` at `:490` refuses unless `confirm === planId` (`:491-492`), then re-reads state and bumps only the two planned generation keys. Same scheduling gate as #3 (`cross-layer-reconcile-run.ts:268`). Operator entry points: `runCacheIndexPlan` at `cross-layer-reconcile-run.ts:212` and `runCacheIndexApply` at `:231`, driven by `cross-layer-reconcile-repair-run.ts`. |

**Score:** 2/4 truths verified (2 present, awaiting human-needed scope/operator decisions).

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/cross-layer-reconcile.ts` | ports, forget judgements, report, runScheduledReconcile/planRepair/applyRepair | ✓ VERIFIED | Read-only scheduled run (:443), read-only writer never wired into tick; confirmed-plan repair (:474, :628) |
| `packages/mcp-server/src/cross-layer-reconcile-pairs.ts` | index-ledger + cache-index detection, cache-index confirmed repair | ✓ VERIFIED | Detection at :239, :298, :369; repair at :456, :490; index-ledger repair intentionally absent (:17-24) |
| `packages/mcp-server/src/cross-layer-reconcile-run.ts` | scheduled tick builder, journal lines, pair scheduling | ✓ VERIFIED | runTick :117, renderReport :101, runPairsTick :154, env gate :132 + :268, READ_ONLY_WRITER :74 |
| `packages/mcp-server/src/cross-layer-reconcile-repair-run.ts` | operator plan/apply entry | ✓ VERIFIED | Invokes planRepair/applyRepair (forget) and runCacheIndexPlan/Apply (graph) — checked against plan ids, never auto-applies |
| `packages/mcp-server/src/cache.ts` | readForgetMark | ✓ VERIFIED | :878, returns disabled/absent/present; failed reads throw |
| `packages/mcp-server/src/greptime.ts` | readEvent by id with payload | ✓ VERIFIED | :1347 |
| `packages/mcp-server/src/index-store.ts` | memoryMarkers (+ forgetMarksBetween) | ✓ VERIFIED | :2446, bounded by MAX_FORGET_LOOKUP_IDS |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| scheduled/deps + runTick | runScheduledReconcile | `scheduledDeps` wires greptime reads, index, cache + READ_ONLY_WRITER | WIRED | `cross-layer-reconcile-run.ts:82` |
| runTick | journal (counts + first key) | `renderReport` | WIRED | `cross-layer-reconcile-run.ts:101,117` |
| main | pairs tick | `runPairsTick` only when graphs named, else pairs skipped with warning | WIRED (gated) | `cross-layer-reconcile-run.ts:253,268-271` |
| repair run | planRepair / applyRepair | plan id re-passed as confirm; digest checked | WIRED | `cross-layer-reconcile.ts:474,628-638` |
| repair run | runCacheIndexPlan / Apply | cache-index plan note, fresh-state digest | WIRED | `cross-layer-reconcile-run.ts:212,231`; `cross-layer-reconcile-pairs.ts:490-492` |

## Notes / Limits

- No source edits made by this verification (read-only inspection).
- The ROADMAP row for phase 78 (`.planning/ROADMAP.md:148,1375`) still says “PARTIAL … pairs are not compared yet”; that predates d913bd51/8ce3097c and is stale against `cross-layer-reconcile-pairs.ts` — but the row is outside this verifier’s write scope; the phase stays PARTIAL until the human decisions above are recorded.

## Human Verification Required

### 1. Install the unit and read the first live tick

**Test:** Install the staged unit pair and drop-in per `infra/vps/README.md`, run `daemon-reload`, enable `--now substrate-cross-layer-reconcile.timer`, then `journalctl -u substrate-cross-layer-reconcile`.
**Expected:** Journal shows per-layer counts and coverage; exit 0 on a clean run; ledger note count, index forget markers and cache forget mark unchanged before and after.
**Why human:** Operator gate; unit staged under `infra/vps`, not installed on the running host.

### 2. Pair scheduling scope decision

**Test:** Decide whether pairs running only when `SUBSTRATE_RECONCILE_GRAPHS` names graphs (and index-to-ledger being report-only forever) satisfies “the ledger, the index and the cache agree”.
**Expected:** A recorded decision — accept the narrowed scope in writing, or open follow-up work for default scheduling and an index-to-ledger repair.
**Why human:** Scope decision for the owner; code already implements detection + cache-index repair.

### 3. Live dirty-run check (only if the operator approves)

**Test:** Plant one forget whose index row is still in force, let the next tick run, read the result.
**Expected:** Exit 3, journal names the first mismatching key (layer index, reason in-force). Nothing written; repair only via separate confirmed plan.
**Why human:** Needs a live mismatch on production stores and an operator decision.

## Gaps Summary

No BLOCKER. Forget-pair scheduled read-only reconcile + confirmed-plan repair are verified in code. The two graph pairs now exist (previously missing), but default scheduling judges no graphs and index-to-ledger has no repair by design. The scheduled unit is staged, not installed. Status is `human_needed` on these scope/operator items — see `78-UAT.md`.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
