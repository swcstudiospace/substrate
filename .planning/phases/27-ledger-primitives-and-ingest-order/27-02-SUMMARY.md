---
phase: 27-ledger-primitives-and-ingest-order
plan: "02"
subsystem: database
tags: [greptime, anchoring, ingest-order, append-only, ddl, anchoring-ledger]

# Dependency graph
requires:
  - phase: 27-ledger-primitives-and-ingest-order plan 01
    provides: byte-identical ledger primitives (hourStart, hourEnd, isClosed) plus workspace wiring that greptime.ts imports
provides:
  - event_ingest append-only DDL with no plain-CREATE fallback in migrate()
  - canonical 11-column period-keyed anchors DDL replacing the 5-column root-keyed shape
  - silent-when-unanswerable anchors shape warning via information_schema
  - two-attempt ingest record write in insertEvent with IngestNotRecorded and INGEST_LAG_MS
  - 11 new greptime.test.ts cases pinning each behavior
affects: [27-03 (hourLeaves read over event_ingest), 27-04 (scratch proof), phase-28 (first anchors writer, adopt-before-write)]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 6100    # chars/4 over the realized code diff (15459) plus this summary
  tasks: 3        # tasks completed
  commits: 3      # 2 task commits + 1 summary commit

# Tech tracking
tech-stack:
  added: []
  patterns: [warn-dont-fail boot DDL, silent-when-unanswerable shape check, fresh-stamp retry]

key-files:
  created: [.planning/phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md]
  modified: [packages/mcp-server/src/greptime.ts, packages/mcp-server/src/greptime.test.ts]

key-decisions:
  - "APPROVED branch: production probe confirmed the 11-column anchors shape exactly, so no [UNVERIFIED against live] marker and no D27-18 deferral"
  - "Constructor clock seam (clock: () => number = Date.now) following the RESEARCH/PATTERNS injectable-now precedent, keeping new GreptimeClient(config) call sites valid"
  - "Tasks 1 and 2 share one commit (b31f0c4): both touch only greptime.ts in non-overlapping regions"
  - "Inlined the two-use stub helper per the repo ts-no-tiny-functions rule instead of keeping a one-expression wrapper"

patterns-established:
  - "Shape check: information_schema with table_schema filter through this.q, name plus lowercased data_type plus semantic_type, warn only on definite mismatch"
  - "Ingest write: event INSERT first, fresh clock stamp per attempt, two attempts, then IngestNotRecorded; late-record stderr line names event id and hour only"

requirements-completed: [ANCHOR-01]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "migrate() creates event_ingest append-only with no plain-CREATE fallback and the canonical 11-column anchors DDL with a definite-mismatch-only shape warning"
    requirement: "ANCHOR-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/greptime.test.ts — migrate event_ingest and anchors (6 new cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "insertEvent writes the ingest record after the event row with quoted values, NULL graph_id, one retry, IngestNotRecorded on double failure, and a late-record stderr line"
    requirement: "ANCHOR-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/greptime.test.ts — insertEvent ingest record (5 new cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "agent_events untouched, store lock green unedited, tsc clean"
    requirement: "ANCHOR-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/store-lock.test.ts (18 pass) and bunx tsc --noEmit (exit 0)"
        status: pass
    human_judgment: false

# Metrics
duration: ~20min
completed: 2026-10-09
status: complete
---

# Phase 27 Plan 02: Ingest record and anchors DDL Summary

**migrate() gains the append-only event_ingest table and the production-verified 11-column anchors shape with a silent-when-unanswerable drift warning; insertEvent records every event's ingest order with retry-then-IngestNotRecorded semantics — 70 greptime tests green, locks green, tsc clean**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-10-09T05:25Z (approximate)
- **Completed:** 2026-10-09T05:45Z
- **Tasks:** 3
- **Files modified:** 2 code files + this summary

## Accomplishments

- `event_ingest` DDL (`ingested_at TIME INDEX`, `event_id`, `event_ts`, nullable `graph_id`, `append_mode`, no PK) created after `agent_events`; failure warns and never falls back to a deduplicating plain CREATE (T-27-04 mitigation)
- Canonical 11-column period-keyed `anchors` DDL replaces the 5-column root-keyed block; no ALTER/DROP path ported (D27-19)
- `anchors` shape check reads `information_schema.columns` with the `table_schema` filter through `this.q`, compares name plus type plus semantic type, warns only on a definite mismatch, silent on empty/failed reads (T-27-05 mitigation)
- `insertEvent` writes the ingest record after the event row with a fresh clock stamp per attempt, quoted values, `NULL` graph_id, one retry, `IngestNotRecorded` on double failure; a record landing after its hour closed writes one `[substrate]`-prefixed stderr line naming the event id and the hour (D27-08/09/16)
- `INGEST_LAG_MS = 300_000` exported from `greptime.ts` (keeps `period.ts` byte-identical); `agent_events`, `APPEND_ONLY_VERBS`, `assertAppendOnly` untouched (D27-11)
- 11 new `greptime.test.ts` cases; zero existing tests edited; `store-lock.test.ts` unedited and green

## Task Commits

Each task was committed atomically (tasks 1 and 2 share one commit: both touch only `greptime.ts` in non-overlapping regions):

1. **Task 1: Add event_ingest and canonical anchors DDL plus the shape warning to migrate()** - `b31f0c4` (feat, shared with task 2)
2. **Task 2: Write the ingest record in insertEvent with retry and IngestNotRecorded** - `b31f0c4` (feat, shared with task 1)
3. **Task 3: Cover migrate, insertEvent and the shape check in greptime.test.ts** - `9e6ba79` (test)

**Plan metadata:** summary commit recorded below after self-check.

## Files Created/Modified

- `packages/mcp-server/src/greptime.ts` - `IngestNotRecorded`, `INGEST_LAG_MS`, constructor `clock` seam, `event_ingest` + canonical `anchors` DDL, information_schema shape check, two-attempt ingest write (+91/-2)
- `packages/mcp-server/src/greptime.test.ts` - imports plus `migrate event_ingest and anchors` (6 tests) and `insertEvent ingest record` (5 tests) describes (+220/-0)
- `.planning/phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md` - this file

## Decisions Made

- **APPROVED branch, not the D27-18 deferral.** The operator-approved production probe (27-CONTEXT.md "Production schema probe", 2026-10-08) confirmed the 11-column anchors shape exactly — column list, order, types, no tag, no PK, no `append_mode`, 0 rows — plus `event_ingest` name free and the D-era `agent_events.ingested_at` present. Per the dispatch instruction, the DDL stands as written with no `[UNVERIFIED against live]` marker, and Phase 28 needs no pre-write re-check (though the D27-19 boot warning still guards later drift).
- **Constructor `clock` seam** (`private readonly clock: () => number = Date.now`) instead of a hardwired `Date.now`, following the RESEARCH Pitfall 12 and PATTERNS test-seam guidance the plan's read-first cites. `new GreptimeClient(config)` and `new GreptimeClient(config.greptime)` stay valid, so no caller changes.
- **Old-shape test uses `root string TAG`** for the 5-column fixture, exercising the semantic-type comparison (a name/type-only check would miss a TAG drift).
- **Stub helper inlined** per the repo `ts-no-tiny-functions` rule: the one-expression `healthyStub()` wrapper became inline `stubFetch` blocks at its two call sites.

## Deviations from Plan

None - plan executed exactly as written. (The clock seam and the helper inlining follow plan-referenced context and repo rules, not plan changes; tasks 1+2 sharing one single-file commit is recorded above.)

## Issues Encountered

None. First `bun test` after tasks 1-2 held all 59 pre-existing tests green, confirming the positional `sql[0]`/`sql[1]` migrate constraints and the `insertStatement` picker survived the new statements.

## Threat notes (per plan threat_model)

- **T-27-03 (ingest INSERT tampering):** every ingest value goes through `this.q` (dialect-aware); `graph_id` null renders as `NULL` via `quote(null)` with no branch; ids are server-minted `evt_<hex>` or read back. `assertAppendOnly` still gates every statement.
- **T-27-04 (ingest dedup loss):** no plain-CREATE fallback for `event_ingest`, pinned by the "warns without a plain-CREATE fallback" test.
- **T-27-05 (anchors drift):** read-only shape check, silent when unanswerable; verified-against-live shape recorded in D1 (see APPROVED branch above).
- **New surface introduced:** the `INSERT INTO "event_ingest"` statement and the `information_schema` read, both composed only in `greptime.ts` (the `MAY_SEND_SQL` file). No new network, auth, or schema-at-trust-boundary surface beyond the plan.

## Stub scan

No stubs introduced. The one `placeholder` grep hit in `greptime.ts:187` is pre-existing `withoutLiterals` commentary, untouched by this plan. The memo never carries event content; `agent_events` rows, hashes and columns unaltered; no ingest record precedes its event row.

## Verification (plan §verification, each on its own invocation)

- `bun test packages/mcp-server/src/greptime.test.ts` — 70 pass / 0 fail (59 pre-existing unedited + 11 new)
- `bun test packages/mcp-server/src/store-lock.test.ts` — 18 pass / 0 fail, file unedited
- `bunx tsc --noEmit` — clean (exit 0), run after tasks 1-2 and after task 3
- Test-file diff is pure addition (+220/-0); `greptime.ts` diff touches only post-`agent_events` migrate lines, the import/error/constant/constructor seams, and post-event-INSERT code
- Out of scope per dispatch (orchestrator runs the full suite): the known flaky `packages/audit/src/log.test.ts` timing test was not exercised

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 27-03 can build `hourLeaves(startMs)` on `event_ingest` and import `INGEST_LAG_MS`, `IngestNotRecorded`, `hourStart`/`hourEnd`/`isClosed` as designed; the `hourEnd` import in `greptime.ts` is already in place for it.
- 27-04 transcribes the CONTEXT production-probe section into its summary (outcome already APPROVED); the D27-18 branch stays untaken.
- Phase 28 inherits: `Substrate.append` still needs the `IngestNotRecorded → stored:true + warning` mapping (27-03 per the plan split), and the adopt-before-write rule for `anchors` (D27-20).
- No blockers. STATE.md / ROADMAP.md deliberately untouched per dispatch (orchestrator owns them).

---
*Phase: 27-ledger-primitives-and-ingest-order, plan 02*
*Completed: 2026-10-09*

## Self-Check: PASSED

- Summary file exists at `.planning/phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md`.
- Task commits exist: `b31f0c4` (feat, tasks 1+2), `9e6ba79` (test, task 3).
- `bun test packages/mcp-server/src/greptime.test.ts` 70/70 and `store-lock.test.ts` 18/18 re-verified at commit time; tsc exit 0.
