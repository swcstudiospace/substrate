---
phase: 16-production-parity-and-rehearsal-harness
plan: 16-02
subsystem: infra
tags: [systemd, parity-check, bun, ss, procfs, production-parity]

# Dependency graph
requires:
  - phase: 16-production-parity-and-rehearsal-harness (16-CONTEXT / 16-RESEARCH / 16-PATTERNS)
    provides: [SC-3 criterion definitions, RESEARCH section 8 verbatim fixtures, store-lock spelling rules]
provides:
  - "scripts/parity-check.ts: read-only SC-3 parity verdict (parsers + CLI main)"
  - "scripts/parity-check.test.ts: 23-test fixture table proving the verdict"
  - "infra/vps/substrate-mcp.service with ConditionPathExists guard (dormant until operator install)"
affects: [16-04 (runbook consumes --json readings), 16-05 (operator proof runs parity:check), phase-20 (identity runbook in docs/runbooks)]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 6839
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-parsers-plus-verdict-table, fixed-argv-bounded-spawn, warnings-as-notes-never-fail]

key-files:
  created: [scripts/parity-check.ts, scripts/parity-check.test.ts]
  modified: [package.json, infra/vps/substrate-mcp.service]

key-decisions:
  - "startEpoch comes from ExecMainStartTimestamp (@unix); /proc start is a disagree-warning only"
  - "originShaKnown null (unaskable, e.g. ls-remote down) fails closed as its own reason, distinct from sha-absent"
  - "healthz null (unreachable) is a criterion failure (exit 1); only unreadable host preconditions exit 2"

patterns-established:
  - "Parity verdict is a pure function over a facts record; main only gathers"
  - "Every git argv routes through gitWork with a --no-optional-locks prefix; ls-remote only, never state-changing verbs"

requirements-completed: []

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Parsers and SC-3 verdict table proven against RESEARCH section 8 fixtures"
    requirement: "FOUND-03"
    verification:
      - kind: unit
        ref: "scripts/parity-check.test.ts (23 pass)"
        status: pass
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts (18 pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Read-only CLI main gathering every SC-3 fact with --json / --expect-restarts / --expect-start"
    requirement: "FOUND-03"
    verification:
      - kind: unit
        ref: "scripts/parity-check.test.ts (23 pass)"
        status: pass
      - kind: other
        ref: "bunx tsc --noEmit clean"
        status: pass
    human_judgment: false
  - id: D3
    description: "Unit file ConditionPathExists guard, StartLimitIntervalSec=0 and StateDirectory kept"
    requirement: "FOUND-03"
    verification:
      - kind: other
        ref: "systemd-analyze verify infra/vps/substrate-mcp.service (exit 0)"
        status: pass
    human_judgment: false

# Metrics
duration: 9min
completed: 2026-10-08
status: complete
---

# Phase 16 Plan 02: Production Parity Check Summary

**Read-only `parity:check` proving the SC-3 verdict from host facts, plus the approved `ConditionPathExists` unit guard**

## Performance

- **Duration:** 9 min
- **Started:** 2026-10-08T20:29:44Z
- **Completed:** 2026-10-08T20:38:30Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `scripts/parity-check.ts` exports pure parsers (`parseSystemctlShow`, `parseSsListeners`, `parseCgroup`, `procStartSeconds`, `parseReflogTime`) and `parityVerdict` over a facts record; pass needs MainPID-owns-:7410, system.slice cgroup, active/running, healthz 200, cwd=WorkingDirectory, start>HEAD-move, clean paths, zero origin diff, known sha, with optional expect-restarts/expect-start comparisons; warnings ride along and never flip the verdict
- Read-only CLI `main` gathers systemctl show, ss listeners, /proc identity, one healthz GET (caller bearer only, 401 reported as auth-configured), and --no-optional-locks git reads (reflog, status, ls-remote, cat-file gate, path diff); exits 0/1/2 with `--json`, `--expect-restarts`, `--expect-start` flags; `bun run parity:check` script entry added
- `infra/vps/substrate-mcp.service` gains `ConditionPathExists` on the server entry point with a file-voice comment; `StartLimitIntervalSec=0` and the StateDirectory block unchanged; `systemd-analyze verify` exits 0; dormant until the operator installs it

## Task Commits

Each task was committed atomically:

1. **Task 1: Parity parsers and verdict table** - `795b9cb` (feat)
2. **Task 2: Read-only CLI main with healthz and git probes** - `cc287a4` (feat)
3. **Task 3: Unit file ConditionPathExists guard** - `cf6b108` (feat)

## Files Created/Modified

- `scripts/parity-check.ts` - Pure parsers, SC-3 verdict, read-only CLI main under `import.meta.main`
- `scripts/parity-check.test.ts` - 23 tests: RESEARCH section 8 fixture table, one test per verdict rule, parser unit tests
- `package.json` - Added `parity:check` script entry (same style as smoke entries)
- `infra/vps/substrate-mcp.service` - Added ConditionPathExists guard + comment; nothing else touched

## Decisions Made

- startEpoch comes from `ExecMainStartTimestamp` (@unix form); the /proc-computed start is only a disagree-warning (>2s). Rationale: the unit timestamp is authoritative for "stable start", procfs corroborates.
- `originShaKnown: null` (ls-remote failed, unaskable) fails closed with its own reason, distinct from sha-absent. Rationale: RESEARCH tri-state ("could not ask" ≠ "no").
- Healthz unreachable (null) is a criterion failure (exit 1); exit 2 is reserved for usage errors and unreadable host preconditions (systemctl/ss spawn failure, vanished pid, unreadable tree). Rationale: a silent port means production is not serving, which is a failed check, not a broken check.
- `requirements-completed: []` left empty on purpose: FOUND-03 also depends on plan 16-05 (operator checkpoints pending), so the requirement stays open per orchestrator instruction.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed off-by-one stat fixture (field 21 vs 22)**
- **Found during:** Task 1 (Parity parsers and verdict table)
- **Issue:** The `procStartSeconds` fixture placed `77973817` at stat field 21, so both tests failed (got btime+0.18 instead of the discuss-time start instant)
- **Fix:** Added the missing field so the ticks sit at field 22 (index 19 after the last paren) in both fixtures
- **Files modified:** scripts/parity-check.test.ts
- **Verification:** `bun test scripts/parity-check.test.ts` 23 pass / 0 fail
- **Committed in:** 795b9cb (part of task commit)

**2. [Rule 3 - Blocking] Added `parity:check` package.json script entry (unlisted file)**
- **Found during:** Task 2 (Read-only CLI main)
- **Issue:** Plan `files_modified` omits package.json, but CONTEXT requires the check to run as `bun run parity:check`; without the entry the documented invocation does not exist
- **Fix:** Added `"parity:check": "bun scripts/parity-check.ts"` in the existing scripts style (PATTERNS exact analog)
- **Files modified:** package.json
- **Verification:** package.json parses; `bunx tsc --noEmit` clean
- **Committed in:** cc287a4 (part of task commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both necessary for correctness and the documented invocation. No scope creep.

## Issues Encountered

- `Edit` with a guessed line number damaged the test file mid-task (stray line + trailing comma); repaired by re-reading the region and re-issuing anchored edits. No plan impact.
- Task 3's plan verify asked for full `bun test`; per wave testing rules only targeted tests plus tsc were run (parity 23 pass, store-lock 18 pass, tsc clean). The orchestrator runs the full suite after the wave.

## Flagged Assumption (per plan must_haves)

FOUND-03 unclassified probe, unresolved by design: no further edge predicate could be derived for production parity beyond the five explicit criteria; the operator-confirmed window (~17:14 UTC 2026-10-08, stray pid 3149064 retired) is recorded in the runbook as the parity baseline (runbook lands in plan 16-04; the live proof runs in 16-05).

## Threat Disposition

- T-16-04 (git tampering): every git argv routes through `gitWork` with `--no-optional-locks` first; `ls-remote` only; `cat-file` presence gate before diff; verified by grep (5 call sites, no fetch/pull/checkout verbs).
- T-16-05 (bearer disclosure): token read from caller `process.env.SUBSTRATE_TOKEN` only, sent as a header, never printed; output limited to PIDs, states, commits; no `Environment` property requested from systemctl (verified by grep).
- T-16-06 (unit edit): additive `ConditionPathExists` only; `StartLimitIntervalSec=0` and StateDirectory kept byte-identical; `systemd-analyze verify` exit 0; no effect until operator install.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `bun run parity:check` is ready for the 16-05 operator-approved proof (note: the production GET /healthz on :7410 was deliberately never run during development; unit tests use fixtures only).
- `--json` output feeds the 16-04 runbook evidence table (`NRestarts`, start epoch, HEAD/origin shas).
- Full `bun test` baseline (1129 pass / 56 skip) left for the orchestrator's post-wave run.

## Self-Check: PASSED

- `scripts/parity-check.ts`, `scripts/parity-check.test.ts` exist on disk
- Commits `795b9cb`, `cc287a4`, `cf6b108` exist on branch `gsd/v1.3-p16-production-parity`
- `bun test scripts/parity-check.test.ts`: 23 pass / 0 fail
- `bun test packages/mcp-server/src/store-lock.test.ts`: 18 pass / 0 fail
- `bunx tsc --noEmit`: clean
- `systemd-analyze verify infra/vps/substrate-mcp.service`: exit 0

---
*Phase: 16-production-parity-and-rehearsal-harness*
*Completed: 2026-10-08*
