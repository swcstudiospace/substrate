---
phase: 19-lane-b-collectors
plan: 19-02
subsystem: collectors
tags: [herdr, reconciler, unix-socket, event-vocabulary, redaction]

# Dependency graph
requires:
  - phase: 19-01
    provides: [postEvent, repoSlug/branchFor, reserved counters shape]
  - phase: 17-event-vocabulary
    provides: [herdr EVENT_SOURCES rows and normalizeEvent]
  - phase: 18-guard-rails
    provides: [shared redact() used by the output_matched mapping]
provides:
  - pinned HERDR_AGENT_SURFACES and wire-name normaliser
  - pure snapshot reconciler with version-2 restart-safe state
  - herdr collector loop: one subscribe per connection, debounced snapshot truth
affects: [19-03-muse-writer, 19-04-hooks, 19-05-proof]

# Actuals (#2632)
actuals:
  tokens: 14801
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns: [snapshot-truth herdr reconciler, version-2 state seeded on a non-v2 file, one events.subscribe per unix connection]

key-files:
  created:
    - packages/collectors/src/herdr-map.ts
    - packages/collectors/src/herdr-map.test.ts
    - packages/collectors/src/herdr-state.ts
    - packages/collectors/src/herdr-state.test.ts
    - packages/collectors/src/herdr.ts
    - packages/collectors/src/herdr.test.ts
  modified:
    - packages/mcp-server/src/event-sources.ts
    - docs/event-vocabulary.md

key-decisions:
  - "Pushes never become events. They mark a debounced pass dirty; session.snapshot is the only source of transitions."
  - "An unknown status is stored on raw_status and not emitted. Leaving it compares against the last emitted status, so working → unknown → idle is one note and working → unknown → working is silence."
  - "A failed emit does not advance that identity, and later transitions for the same identity in that pass are skipped so a failed end cannot be followed by a start that the next pass would emit again."
  - "A snapshot outage before the first version-2 file does not write state. An empty version-2 file would make the next pass look like a restart and emit a start per open pane."

patterns-established:
  - "Herdr identity is pane_id plus terminal_id, because pane ids are reused."
  - "State advances on stored or refused, never on failed. The file is written by tmp plus rename."

requirements-completed: [LANEB-01, LANEB-02]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Herdr transitions match the Phase 17 rows, the 17-id enum is fully classified, and output_matched is redacted without repo"
    requirement: "LANEB-01"
    verification:
      - kind: unit
        ref: "packages/collectors/src/herdr-map.test.ts"
        status: pass
      - kind: unit
        ref: "packages/mcp-server/src/event-sources.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reconcile emits start, note and end, seeds a non-v2 file silently, and does not advance on failed"
    requirement: "LANEB-02"
    verification:
      - kind: unit
        ref: "packages/collectors/src/herdr-state.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "One subscribe per connection, a bad pane closes only itself, and two close pushes emit one session.start"
    requirement: "LANEB-01"
    verification:
      - kind: unit
        ref: "packages/collectors/src/herdr.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: ~45min
completed: 2026-10-09
status: complete
---

# Phase 19 Plan 02: herdr collector Summary

**herdr panes now reconcile onto main's vocabulary: one pinned surface table, a version-2 state file, and a collector that trusts the snapshot rather than the push.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3/3 complete, 4 commits (3 task + 1 summary)
- **Completed:** 2026-10-09

## Accomplishments

- **Mapper and vocabulary (937f06d).** `herdr-map.ts` exports `HERDR_AGENT_SURFACES` (eight enum rows plus `muse`), the explicit unmapped set, `normalizeWireName`, `isRelease`, `transitionToEvent` and `mapHerdrEvent`. Starts, notes and exits carry `runtime: "herdr"`, `actor: "agent"` and the detected surface. `herdr.pane_exited` now `carriesRepo: true` with `repo` on its sample, and `docs/event-vocabulary.md` replaces the unverified herdr table with the pinned one. `output_matched` is redacted through the shared `redact()` and never carries `repo`. The collector does not subscribe to it.
- **Reconciler and state (cc0dd34).** `reconcile` keys panes by `pane_id|terminal_id`. An agent appearing emits `session.start`, a known status change emits `note`, a gone pane or agent emits `session.end` that reuses the stored repo. Unknown gaps are recorded on `raw_status`. A missing file or September's `lastSignature` shape seeds silently. `saveHerdrState` writes by tmp + rename.
- **Transport (834881d).** One global `events.subscribe` for `pane.created`, `pane.closed`, `pane.exited` and `pane.agent_detected`. Each pane gets its own connection subscribed only to `pane.agent_status_changed`. Pushes debounce (~150 ms) into a single-flight snapshot pass. CLI flags `--once`, `--watch` and `--session` keep the September resolution order, with `HOME` falling back to `/root`. The loop is behind `import.meta.main`.

## Verification

- `bun test ./packages/collectors/src/herdr-map.test.ts` — 7 pass
- `bun test ./packages/collectors/src/herdr-state.test.ts` — 9 pass
- `bun test ./packages/collectors/src/herdr.test.ts` — 3 pass
- `bun test ./packages/mcp-server/src/event-sources.test.ts` — included in the phase-close lock run, green
- `bunx tsc --noEmit` — clean
- `bun test ./packages/mcp-server/src/redact-lock.test.ts` — 15 pass
- `bun run check:phase-close` — pass (4 lock files, EVENT_KINDS 12, SURFACES 27)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] A failed end must not be followed by a start in the same pass**
- **Found during:** Task 2 design of `commitReconcile`
- **Issue:** Posting the start after a failed end would store a start the next pass emits again, because the failed end leaves the old identity in place.
- **Fix:** After a failed outcome the collector skips later transitions for that identity. `commitReconcile` does not apply or count those skips.
- **Files modified:** `packages/collectors/src/herdr-state.ts`, `packages/collectors/src/herdr.ts`

**2. [Rule 2 - Correctness] An outage before the first state file must not create version 2**
- **Found during:** Task 3 outage path
- **Issue:** Writing an empty version-2 file on a failed snapshot would make the next successful pass treat every open pane as new and emit a `session.start` burst, which D19-09 forbids.
- **Fix:** `noteOutage` journals and returns without writing when `loadHerdrState` reports a first run. Once version 2 exists, the failed counter increments and pane records stay put.
- **Files modified:** `packages/collectors/src/herdr.ts`

### Plan assumption that did not hold

None. The Phase 17 rows were present on this branch, and `herdr.pane_exited` was still `carriesRepo: false`, as the plan predicted.

## Decisions Made

- `seen_unmapped` is persisted beside the pane map so an unmapped agent id is counted once per identity, not on every 5 s pass.
- Repo and branch are computed by an injected `attribute` function. The collector passes `repoSlug` / `branchFor`. The reconciler stays pure and does not spawn git.
- `session_id` is `herdr:<terminal_id>:<started_at>` and is stored, so a restart reuses it and does not mint a new run.

## Known Stubs

None. The mapper, reconciler and socket loop are wired. `pane.output_matched` is mapped and tested, and deliberately not subscribed, which is the plan rather than a stub.

## Threat Flags

None beyond the plan's register. T-19-05 is the debounced snapshot pass. T-19-06 is `redact()` on matched text, asserted by the mapper test (the secret string is absent from the summary and payload). T-19-07 is per-pane sockets, asserted by the bad-pane test. T-19-08 is the `carriesRepo` amendment, gated by `event-sources.test.ts` and `check:phase-close`.

## Self-Check: PASSED

- Files: `herdr-map.ts`, `herdr-map.test.ts`, `herdr-state.ts`, `herdr-state.test.ts`, `herdr.ts`, `herdr.test.ts` present; `event-sources.ts` and `docs/event-vocabulary.md` modified as committed
- Commits: `937f06d`, `cc0dd34`, `834881d` resolve in `git log`
- Verification rerun at summary time: herdr-map 7 pass, herdr-state 9 pass, herdr 3 pass, tsc clean, redact-lock 15 pass, check:phase-close pass
