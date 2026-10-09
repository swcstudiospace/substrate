---
phase: 30-desktop-run
plan: "01"
subsystem: api
tags: [desktop-run, docker-exec, xwd, png, zod, bun-test]

# Dependency graph
requires:
  - phase: 16-rehearsal
    provides: rehearsal-env.ts buildRehearsalEnv and scripts/rehearsal.ts base (verified present)
  - phase: 17-events
    provides: event-sources.ts desktop.action row and docs/event-vocabulary.md (verified present)
  - phase: 18-redact
    provides: shared redact.ts and redact-lock.test.ts (verified present)
provides:
  - Desktop action vocabulary and fixed argv builders (actions.ts)
  - XWD decode / PNG encode / filter-0 PNG decode codec (png.ts)
  - Desktop driver with child-env allowlist, busy refusal, tool.call events, stop-on-unstored (driver.ts)
  - Three green unit suites (actions, png, driver)
affects: [30-04-substrate-wiring, 30-05-proof, desktop_run tool registration]

# Actuals (#2632)
actuals:
  tokens: 13575
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [fixed-argv plus injected BufferRunner, child-env allowlist, module-scope busy flag, hashes-and-lengths-only event payloads]

key-files:
  created:
    - packages/mcp-server/src/desktop/actions.ts
    - packages/mcp-server/src/desktop/actions.test.ts
    - packages/mcp-server/src/desktop/png.ts
    - packages/mcp-server/src/desktop/png.test.ts
    - packages/mcp-server/src/desktop/driver.ts
    - packages/mcp-server/src/desktop/driver.test.ts
  modified: []

key-decisions:
  - "NAMED_KEYS as Record<string, true> per repo ts-set-map rule (not Set)"
  - "pngChunk exported (needed to rebuild IDAT in the filter-refusal test)"
  - "XWD fixture duplicated in driver.test.ts instead of importing from png.test.ts (avoids double-registering png tests)"
  - "Unstored stop clears result.images and sets result.error, keeping log and screenshot metadata"

patterns-established:
  - "Driver emit passed per call as DesktopEmit returning { stored: boolean }; a throw counts as not stored"
  - "Recording test emit via a recording(events) helper returning { stored: true }"
  - "Sensitive parent keys in tests built with join() so no credential name sits next to a value"

requirements-completed: [DESK-01, DESK-02]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Desktop action vocabulary, limits and fixed argv builders (DESK-01)"
    requirement: "DESK-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/actions.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "XWD decode, PNG encode and filter-0 PNG decode round trip plus refusals (DESK-01)"
    requirement: "DESK-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/png.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Driver with child-env allowlist, busy refusal, tool.call events, stop-on-unstored, budgets and retention (DESK-01, DESK-02)"
    requirement: "DESK-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/driver.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Per-action tool.call payloads carry hashes and lengths only, no text or image bytes (DESK-02)"
    requirement: "DESK-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/driver.test.ts#emits 4 tool.call events"
        status: pass
    human_judgment: false

# Metrics
duration: 40min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 01: Desktop actions, PNG codec and driver port Summary

**Ported September's desktop vocabulary, XWD/PNG codec and driver onto main with the six locked deltas (child-env allowlist, busy refusal, tool.call events, tightened key rule, stop-on-unstored, silent deadline) — 31 tests green, tsc clean.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-10-09T06:00Z
- **Completed:** 2026-10-09T06:40Z
- **Tasks:** 3
- **Files modified:** 6 created

## Accomplishments

- Task 1 verified the base holds all seven Phase 16/17/18 prerequisites (rehearsal.ts, rehearsal-env.ts with buildRehearsalEnv, event-sources.ts with the desktop.action row, event-vocabulary.md, phase-close-check.ts, redact.ts with redact, redact-lock.test.ts) — no BLOCKED, tasks 2–3 ran.
- actions.ts ported verbatim from acc30a8 (header re-pointed D-13 → DESK-01 / D30-05..D30-06): EXEC prefix, CHORD/KEYS/TYPEABLE grammar, strict DesktopRunInput (1..50 actions, timeout 1..120 default 30), DEFAULT_SETTLE_MS, boundsRefusal, all seven argv builders.
- png.ts split from the driver codec: XWD constants, decodeXwd, PNG_SIGNATURE, crc32, pngChunk, encodePng unchanged, plus a new filter-0-only decodePng (node:zlib inflateSync, no new dependency).
- driver.ts ported with the six locked deltas: exported childEnv (PATH/HOME only, standard fallbacks), Buffer execFile with 16 MiB maxBuffer and never a shell, module-scope active run id with DesktopBusy refusal, EventInput tool.call per executed action (surface, agent, desktop:\<run_id\>, D30-11 payload keys, tightened keyFields), per-call emit with stored:false-or-throw stopping the run (no images, D30-12 error), deadline log entry with break before emit, required deps.dir with 0700/0600 storage.
- driver.test.ts adapted: exact payload-key assertions per action kind, verbatim ctrl+alt+t and Return plus hashed shift+a/KP_1/space cases, no-event-for-not-started deadline assertion, stored:false and throwing-emit stop assertions, busy refusal naming the first run id with runner argv proof, poisoned-parent childEnv test, plus keyFields and childEnv unit suites.

## Task Commits

Each task was committed atomically:

1. **Task 1: Verify the execution base holds Phase 16/17/18 deliverables** — no commit (verification only, no files)
2. **Task 2: Port actions.ts verbatim and split png.ts** - `e2842f0` (feat)
3. **Task 3: Port driver.ts with the six locked deltas** - `f639bf2` (feat)

**Plan metadata:** `docs(30-01)` commit (this SUMMARY)

## Files Created/Modified

- `packages/mcp-server/src/desktop/actions.ts` - Closed vocabulary, DesktopRunInput, seven argv builders
- `packages/mcp-server/src/desktop/actions.test.ts` - Schema, grammar, argv-table, no-shell, settle, bounds tests (10 pass)
- `packages/mcp-server/src/desktop/png.ts` - decodeXwd, encodePng, crc32, pngChunk, PNG_SIGNATURE, decodePng
- `packages/mcp-server/src/desktop/png.test.ts` - XWD decode, PNG encode, decodePng round-trip and refusals (6 pass)
- `packages/mcp-server/src/desktop/driver.ts` - childEnv, bufferRunner, DesktopBusy, keyFields, prune, createDesktopDriver
- `packages/mcp-server/src/desktop/driver.test.ts` - Ported plus changed tests for events, busy, unstored-stop, deadline silence, childEnv (15 pass)

## Decisions Made

- NAMED_KEYS as `Record<string, true>` instead of `Set` (repo ts-set-map rule: static string-keyed lookup tables are Records).
- `pngChunk` exported from png.ts (the filter-refusal test rebuilds IDAT with it); plan artifact list already names it.
- XWD synthetic fixture duplicated in driver.test.ts rather than imported from png.test.ts: importing a .test file would double-register the png describes under the driver run.
- Unstored stop keeps `log` and `screenshots` metadata but clears `images` and sets `error`, matching the D30-12 tool reply shape `{run_id, log, error}` with no image blocks.
- `result.error` left `undefined` on success (asserted in the 4-event test) so plan 30-04 can branch success/failed.

## Deviations from Plan

None - plan executed exactly as written. (Repair of two self-inflicted edit mistakes during execution — a mis-ranged patch that briefly broke driver.ts, and a `void x && y` emit one-liner that would have returned undefined — was corrected before any commit; final committed content matches the plan.)

## Issues Encountered

- Edit-tool range mistake inserted the NAMED_KEYS Record inside `call()`, deleting the call body and execute head; restored verbatim from the September source and verified with tsc plus the full driver suite.
- `async (e) => void events.push(e) && { stored: true }` short-circuits to undefined; replaced with a `recording(events)` helper returning `{ stored: true }` in all four recording tests.

## Self-Check: PASSED

- All six files exist on disk.
- Commits `e2842f0` and `f639bf2` present in `git log`.
- No file deletions in either commit; no stubs (no TODO/FIXME/placeholder); no new dependencies (node:zlib and node:child_process only).
- Repo locks respected: redact imported only from `../redact.ts`, nothing named `redact*` defined; no `GREPTIME_*` literal next to a value (keys built with `join()`); no new EVENT_KINDS/SURFACES entries; token-like test values are single characters.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 30-04 through 30-07 can build on `createDesktopDriver({ run: bufferRunner, dir })` and `run(input, { surface, emit })`; the driver is unwired (no Substrate integration yet — that is plan 30-04's scope).
- Residual risks for the runbook (plan 30-07): unsalted sha256 of short typed values is brute-forceable by ledger readers; a timed-out docker exec may leave its container process running; 50 screenshots ≈ 35 MB per MCP reply (no cap in the locked vocabulary).

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
