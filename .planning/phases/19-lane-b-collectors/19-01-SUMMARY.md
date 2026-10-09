---
phase: 19-lane-b-collectors
plan: 19-01
subsystem: collectors
tags: [emit, fail-open, refused-emits, collectors-status, grok, git-attribution]

# Dependency graph
requires:
  - phase: 18-guard-rails
    provides: [merged redact.ts plus redact-lock.test.ts the new modules import against]
  - phase: 17-event-vocabulary
    provides: [EVENT_SOURCES row ids used as refused-line source values]
provides:
  - shared postEvent/recordRefusal client every later Phase 19 collector stands on
  - repoSlug/branchFor attribution module
  - collectors:status read-only reporter the LANEB-07 proof asserts through
  - grok counting refusals through the shared emit
affects: [19-02-herdr, 19-03-muse-writer, 19-04-hooks, 19-05-proof]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 12200
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns: [fail-open shared emit with stored/refused/failed outcomes, reserved counters key in collector state files, pure summarize plus thin main for read-only CLIs]

key-files:
  created:
    - packages/collectors/src/emit.ts
    - packages/collectors/src/emit.test.ts
    - packages/collectors/src/git-context.ts
    - packages/collectors/src/git-context.test.ts
    - packages/collectors/src/status.ts
    - packages/collectors/src/status.test.ts
  modified:
    - packages/collectors/src/grok.ts
    - packages/collectors/src/grok.test.ts
    - package.json

key-decisions:
  - "grok refused lines carry source grok: Phase 17 merged no grok EVENT_SOURCES row, so the collector name is the source value"
  - "postEvent records refusals itself; collectors only count outcomes and keep their rate-limited journal summary"
  - "grok keeps its logEmitRefusal rate limiter beside recordRefusal: one captures the file plus immediate journal line, the other the at-most-once-a-minute summary D19-05 requires"

patterns-established:
  - "Shared emit: postEvent classifies, recordRefusal records, countOutcome counts — one convention for every collector and hook"
  - "Reserved counters key: state files stay backward compatible by keeping flat offsets and nesting counters under one key"

requirements-completed: [LANEB-05]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "postEvent classifies 202/refused/failed, never throws, reads env at call time, records redacted refused lines"
    requirement: "LANEB-05"
    verification:
      - kind: unit
        ref: "packages/collectors/src/emit.test.ts"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/git-context.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "collectors:status summarizes counters and refused lines since --since, read-only, exits 0"
    requirement: "LANEB-05"
    verification:
      - kind: unit
        ref: "packages/collectors/src/status.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "grok posts through the shared emit, counts outcomes under the reserved key, existing mapper tests unchanged"
    requirement: "LANEB-05"
    verification:
      - kind: unit
        ref: "packages/collectors/src/grok.test.ts"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/grok-map.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: ~40min
completed: 2026-10-09
status: complete
---

# Phase 19 Plan 01: Shared emit spine Summary

**Fail-open emit, git attribution, and refusal visibility are in: one client every collector shares, with grok already on it and counting.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3/3 complete, 4 commits (3 task + 1 summary)

## Accomplishments

- **Tracer — shared emit plus git attribution (b0acf9d).** `emit.ts` exports `EmitOutcome`, `postEvent`, `recordRefusal`, `COUNTERS_KEY`, `EmitCounters`/`emptyCounters`/`countOutcome`. 202 is stored, 400–499 refused (recorded to `refused-emits.jsonl` with exactly `ts, collector, source, kind, surface, status, error`, error redacted and truncated to 200 chars, plus one stderr line), 5xx/network/timeout failed. Env (`SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_STATE_DIR`) read at call time; bearer sent only when set; 3 s default timeout. `git-context.ts` exports `repoSlug`/`branchFor` with the CLI/grok origin regex, slug cached, branch never cached, unborn HEAD yields undefined. 8 + 8 tests green against a real loopback stub and real repos.
- **Status reporter plus script entry (739dc70).** `status.ts` exports pure `summarize(states, refusedLines, since)` aggregating `stored/refused/failed` plus extras (`unmapped`, `fetch_failed`, `no_slug`) from each state file's reserved counters key, filtering refused lines on `ts >= since`, skipping garbled lines. Thin main handles `--since`, `--state-dir`, `--json`, writes nothing, exits 0. `package.json` gains `collectors:status`. 5 tests green including a spawned `--json` run asserting read-only output.
- **grok on the shared emit (4193aa1).** Local `emitToSubstrate`/`emit`, the `SUBSTRATE_URL` module const, and the second origin-regex copy are gone; `pass()` calls `postEvent` with 3 s timeout and counts outcomes under the reserved `counters` key, keeps its rate-limited journal summary, advances offsets fail-open either way. `loadOffsets` skips non-number values so the live flat map loads intact. `grok-map.test.ts` untouched and green (12 pass); `grok.test.ts` re-seamed around `pass()` with stored/refused/failed/accumulation coverage (7 pass).
- **Gates:** `bunx tsc --noEmit` clean; `redact-lock.test.ts` 15 pass; `store-lock.test.ts` 18 pass (short test tokens only, runtime-assembled decoy, no new redact helper, no `GREPTIME_` outside the server).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] emit.test.ts helper threw when no refusals were written**
- **Found during:** Task 1 verification
- **Issue:** `refusedLines()` read the file unconditionally; stored/failed cases write none, so 4 tests failed with ENOENT
- **Fix:** return `[]` when the file is absent (absent file is zero refusals)
- **Files modified:** `packages/collectors/src/emit.test.ts`

**2. [Rule 1 - Bug] grok.test.ts pass test wrote refusals to the live state dir**
- **Found during:** Task 3 re-seaming
- **Issue:** the pre-existing pass test never set `SUBSTRATE_STATE_DIR`, so the new `recordRefusal` path would have appended to `/var/lib/substrate/refused-emits.jsonl`
- **Fix:** test seam sets `SUBSTRATE_STATE_DIR` (plus URL/token isolation) per fixture with save/restore, and captures stderr
- **Files modified:** `packages/collectors/src/grok.test.ts`

None of the deviations change plan scope; both are test-seam correctness.

### Plan assumption that did not hold

- The plan names "the grok EVENT_SOURCES row id" for the refused-line `source`. Phase 17 merged no grok row (grok predates the v1.3 table), so grok passes `source: "grok"`. Later collectors with real rows pass their row ids. No plan change needed; recorded here so the proof wave does not go hunting for the row.

## Decisions Made

- `postEvent` calls `recordRefusal` internally on every 4xx; collectors never call it directly. One call site means no collector can forget.
- Failed outcomes carry the parsed server error in memory only; only refused lines reach disk, always through `redact()`.
- Network/timeout errors map to fixed strings (`unreachable`/`timeout`) so transport details (host, port, errno) never reach logs.
- `status.ts` lists exactly herdr/muse/grok state files; missing or malformed files read as zeros rather than failing.

## Known Stubs

None. All new code paths are wired: every outcome classifies, every refusal records, every counter aggregates. A file scan for stub markers across the touched sources returns nothing.

## Threat Flags

None beyond the plan's register. T-19-01..T-19-04 mitigations are implemented as specified: exact refused-line key set asserted in two test files, bearer-only-when-set asserted, timeouts bounded per call, counters under an inert reserved key.

## Self-Check: PASSED

- Files: `emit.ts`, `emit.test.ts`, `git-context.ts`, `git-context.test.ts`, `status.ts`, `status.test.ts` present; `grok.ts`, `grok.test.ts`, `package.json` modified as committed
- Commits: `b0acf9d`, `739dc70`, `4193aa1` all resolve in `git log`
- Verification rerun at summary time: emit 8 pass, git-context 8 pass, status 5 pass, grok 7 pass, grok-map 12 pass, tsc clean, both lock suites green
