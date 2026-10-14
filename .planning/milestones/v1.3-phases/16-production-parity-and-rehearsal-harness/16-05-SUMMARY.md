---
phase: 16-production-parity-and-rehearsal-harness
plan: 16-05
subsystem: docs
tags: [rehearsal-harness, production-parity, runbook, parity-check, zero-write-evidence, bun-test]

# Dependency graph
requires:
  - phase: 16-production-parity-and-rehearsal-harness (16-02, 16-03, 16-04)
    provides: as-built parity-check JSON fields, rehearsal CLI outputs, and the runbook evidence slots this plan fills
provides:
  - "docs/runbooks/production-parity.md: filled SC-2 proof row (run tag, smoke, ss loopback, teardown) plus SC-3 proof-run readings and both rh- zero counts"
affects: [16-production-parity-and-rehearsal-harness (phase seal), phase-17, phase-20, phase-27, phase-28]

# Actuals (#2632)
actuals:
  tokens: 3303
  tasks: 3
  commits: 7
  plan_head_before: 33bfeb9ffc57a2c4216866f762c3ff387bcd1b0a

# Tech tracking
tech-stack:
  added: []
  patterns: [evidence-table-with-proof-row, values-free-live-readings, operator-reported-counts]

key-files:
  created: []
  modified:
    - docs/runbooks/production-parity.md

key-decisions:
  - "Discuss-time healthz cell left untouched: the plan only required filling the proof row"
  - "Counts recorded in both the SC-2 proof section and the probes section so each reads standalone"
  - "requirements-completed lists FOUND-01/FOUND-03 (evidence now recorded); REQUIREMENTS.md checkboxes left for the orchestrator verification workflow"

patterns-established:
  - "Live readings recorded values-free: PIDs, epochs, ports, table names and counts only, never environment values"
  - "Operator-run probes attributed explicitly (actor, date, approval) so the evidence chain shows who ran what"

requirements-completed: [FOUND-01, FOUND-03]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "SC-2 isolated harness proof recorded: p16-proof run tag, 4/4 smoke, loopback-only ss peers, scratch index tests, empty teardown listing"
    requirement: "FOUND-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts (18 pass, names production-parity in no failure)"
        status: pass
      - kind: other
        ref: "bun test 1198 pass / 56 skip / 0 fail; bunx tsc --noEmit clean (Task 1 evidence)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SC-3 proof-run parity:check reading recorded: exit 0 PASS, MainPID 1525582 owning :7410, healthz 200, main-verdict, non-failing warnings"
    requirement: "FOUND-03"
    verification: []
    human_judgment: true
    rationale: "Operator-confirmed live production reading; no unit test can touch production (plan verify states MISSING)"
  - id: D3
    description: "SC-2 zero-write evidence recorded: rh-% counts 0 in production Greptime agent_events and production Postgres graph_index/graph_nodes/graph_steps"
    requirement: "FOUND-01"
    verification: []
    human_judgment: true
    rationale: "Operator-run production queries; agents hold no production credentials (plan verify states MISSING)"

# Metrics
duration: 28min
completed: 2026-10-08
status: complete
---

# Phase 16 Plan 05: Isolated Proof Plus Approved Live Evidence Summary

**Harness proven isolated with loopback evidence and clean teardown; operator-approved parity:check PASS and zero rh- counts recorded values-free — SC-2, SC-3, SC-4 evidenced**

## Performance

- **Duration:** ~28 min (Task 1 plus continuation recording Tasks 2–3, summary, tracking)
- **Started:** 2026-10-08T21:00:00Z (approx; first plan commit 21:03:05Z)
- **Completed:** 2026-10-08T21:27:18Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments

- Task 1 (prior executor, `0f947e1`): isolated twin proof from the worktree, instance `p16-proof`, run tag `rh-p16-proof-mv00v314` — 4/4 smoke, loopback-only `ss` peers, scratch index live tests 68/0, targeted harness tests 64/0, full `bun test` 1198/56/0 with clean `tsc`, empty label-filtered container listing and run dir gone
- Task 2 (this continuation): proof-run evidence row filled — 2026-10-08 ~20:40 UTC, MainPID 1525582, NRestarts 0, start 17:14:12 (epoch 1791479652), healthz 200 — plus values-free notes (exit 0 PASS; `:7410` owner/cgroup/entry; HEAD vs origin main verdict; non-failing warnings; orchestrator-under-approval actor)
- Task 3 (this continuation): zero-write evidence recorded — production Greptime `agent_events` `rh-%` = 0; production Postgres `graph_index`/`graph_nodes`/`graph_steps` `rh-%` = 0 — with date, actor, run tag and broader filter; pending bullet replaced; results mirrored in the probes section
- `store-lock` green (18/18) after each doc edit; no secret values, connection strings, or tokens anywhere

## Task Commits

Each task was committed atomically:

1. **Task 1: Isolated harness proof with loopback evidence** - `0f947e1` (docs)
2. **Task 2: Approved read-only parity check run** - `4c22138` (docs)
3. **Task 3: Operator rh- tag counts** - `c51637c` (docs)

**Plan metadata:** summary commit (docs, see below); tracking commit (docs, see below)

## Files Created/Modified

- `docs/runbooks/production-parity.md` - Task 1 proof section; Task 2 readings row plus values-free notes; Task 3 zero counts in SC-2 and probes sections
- `.planning/phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md` - This file
- `.planning/STATE.md`, `.planning/ROADMAP.md` - Position advance and plan progress (tracking commit)

## Decisions Made

- Left the discuss-time row's healthz cell (`pending proof run`) untouched: the plan only demanded filling the proof row, and the discuss-time cell is a historical record of that earlier read
- Recorded Task 3 counts in both the SC-2 proof section (replacing the pending bullet) and the probes section (results paragraph) so each section reads standalone
- `requirements-completed: [FOUND-01, FOUND-03]` in this summary since the evidence is now recorded; REQUIREMENTS.md checkboxes untouched per orchestrator instruction (verification workflow owns them)

## Deviations from Plan

### Auto-fixed Issues

None - plan executed exactly as written, with one structural deviation inherited from the dispatch (documented, not auto-fixed):

**1. [Dispatch-level deviation] Tasks 2 and 3 probes run by the orchestrator, recorded by the executor**
- **Found during:** Tasks 2–3 (both `blocking-human` checkpoints)
- **Issue:** The plan's `<action>` text has the executor run `bun run parity:check` and ask the operator for counts; instead the operator pre-approved both live probes and the orchestrator ran them on 2026-10-08 ~20:40 UTC, passing the values-free results to this continuation agent to record
- **Fix:** No probe executed from this session (no `parity:check`, no port-7410 touch, no production store query); results recorded values-free with explicit actor attribution (`orchestrator under operator approval`)
- **Files modified:** docs/runbooks/production-parity.md
- **Verification:** store-lock 18/18 after each edit; recorded values cross-checked against the dispatch brief
- **Committed in:** 4c22138 (Task 2), c51637c (Task 3)

---

**Total deviations:** 1 dispatch-level (probe actor reassignment, approval intact)
**Impact on plan:** Approval and read-only constraints preserved; evidence chain is stronger (explicit actor/date on every live number). No scope creep.

## Issues Encountered

- One `edit` retry on the probes-section insert: line numbers had shifted after the first Task 3 edit; re-read the section and re-issued with the fresh tag. No content impact.

## Threat Disposition

- T-16-13 (proof targeting production): no harness step pointed at 7410, no non-loopback host, no production store touched from this session — both live numbers arrived via the operator-approved orchestrator path and were recorded, never re-queried
- T-16-14 (evidence repudiation): run tag, dated readings, actor attribution, and operator-reported counts all recorded in the runbook; `rh-%` filter noted as stricter than the single run tag

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 16 seal inputs complete: SC-2 (isolation + zero writes), SC-3 (live parity reading), SC-4 (proof outputs recorded)
- REQUIREMENTS.md marking and any phase transition belong to the orchestrator verification workflow — deliberately not done here
- No blockers

## Self-Check: PASSED

- `docs/runbooks/production-parity.md` exists with proof row (`1525582`, `1791479652`, `200`), values-free notes, and zero-count results in both sections
- Commits `0f947e1`, `257ada0`, `2afb0b9`, `4c22138`, `c51637c` exist on branch `gsd/v1.3-p16-production-parity`
- `bun test packages/mcp-server/src/store-lock.test.ts`: 18 pass / 0 fail at final state
- No `parity:check` run, port-7410 touch, or production query from this session; operator checkout untouched

---
*Phase: 16-production-parity-and-rehearsal-harness*
*Completed: 2026-10-08*
