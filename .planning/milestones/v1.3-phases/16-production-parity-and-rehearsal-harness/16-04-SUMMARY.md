---
phase: 16-production-parity-and-rehearsal-harness
plan: 16-04
subsystem: docs
tags: [rehearsal-harness, production-parity, runbook, store-lock, bun-test]

# Dependency graph
requires:
  - phase: 16-production-parity-and-rehearsal-harness (16-02, 16-03)
    provides: as-built rehearsal CLI flags/outputs and parity-check flags/JSON for the docs to match
provides:
  - "docs/rehearsal.md: harness topic doc with the five-key consumer.env contract"
  - "docs/runbooks/production-parity.md: operator runbook with window record, readings table, install, both rollbacks, rh- probes, boundary"
  - "README Running paragraph plus observability cross-reference keeping the two rehearsal meanings apart"
affects: [16-production-parity-and-rehearsal-harness (16-05 fills the evidence slots), phase-17, phase-20, phase-27, phase-28]

# Actuals (#2632)
actuals:
  tokens: 4411
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [flat-topic-doc-in-observability-voice, commands-as-run-runbook, evidence-table-with-proof-slot]

key-files:
  created:
    - docs/rehearsal.md
    - docs/runbooks/production-parity.md
  modified:
    - README.md
    - docs/observability.md

key-decisions:
  - "No connection-string shapes in docs: store locations described by key name and host/port only, so the credential scan has nothing to catch"
  - "Stray-retirement and install/restart/rollback steps framed operator-only with the agent/operator boundary list, per T-16-12"
  - "requirements-completed left empty: FOUND-01/FOUND-03 also depend on 16-05, per orchestrator instruction"

patterns-established:
  - "Docs name secret keys in backticks with no value after them; placeholder-free prose for connection shapes"
  - "Runbook evidence table carries the discuss-time reading plus one empty proof row shaped to receive parity:check --json"

requirements-completed: []

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "docs/rehearsal.md states up/smoke/down/status, the five-key consumer.env contract, stores.env discipline, exit triple, and the harness-vs-CHAOS_REHEARSAL distinction"
    requirement: "FOUND-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts (18 pass, names rehearsal.md in no failure)"
        status: pass
      - kind: other
        ref: "grep: five contract keys in consumer.env table; 0/1/2 triple and CHAOS_REHEARSAL paragraph present"
        status: pass
    human_judgment: false
  - id: D2
    description: "docs/runbooks/production-parity.md records window actor/time and retired pid, both rollbacks, both rh- counts, readings table with proof slot, and the agent/operator boundary"
    requirement: "FOUND-03"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts (18 pass, names production-parity in no failure)"
        status: pass
      - kind: other
        ref: "grep: 3149064/17:14/CONTEXT-source header, dated readings columns, two rh- zero-counts, Agents-never boundary"
        status: pass
    human_judgment: false
  - id: D3
    description: "README Running paragraph links both docs; observability.md carries the disambiguating sentence and no other change"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts (18 pass)"
        status: pass
      - kind: other
        ref: "bunx tsc --noEmit clean; git diff --stat: README +6, observability +1"
        status: pass
    human_judgment: false

# Metrics
duration: 5min
completed: 2026-10-08
status: complete
---

# Phase 16 Plan 04: Harness Doc and Parity Runbook Summary

**Scratch-harness topic doc, operator parity runbook with fillable evidence, and discoverable README entry points — all as-built, all store-lock green**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-10-08T20:55:55Z
- **Completed:** 2026-10-08T20:58:54Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `docs/rehearsal.md` states the Isolation-first contract: loopback scratch stores, allowlisted server env, per-instance 0700 run dir with `state.json`/`server.log`/`consumer.env`/`stores.env`/`tokens/`; the four as-built commands with `--name`/`--port`/`--surfaces`/`--operator`/`--anonymous` and image overrides; the five-key `consumer.env` table with `stores.env` sourced only by store-client proofs; the 0/1/2 exit triple; named-instance plus tmpfs plus `--pull never` rules; and the harness-vs-`CHAOS_REHEARSAL` paragraph
- `docs/runbooks/production-parity.md` records FOUND-03, the operator window (~17:14 UTC 2026-10-08, stray pid 3149064, source CONTEXT Operator answers dated 2026-10-08), last known-good `ab62c91`, scope/untouched; twin-vs-stray identification; the dated readings table (discuss-time row plus empty 16-05 proof row shaped for `--json`); operator unit-install steps; both rollbacks; both `rh-` zero-count probes; the agent/operator boundary list
- README Running paragraph links both docs in the existing voice and relative-link spelling; `docs/observability.md` gains the one disambiguating sentence near the `CHAOS_REHEARSAL` paragraph and nothing else
- Evidence slots stay empty for 16-05 to fill; no `rehearsal up`, `parity:check`, port-7410 or Docker touch, per instruction

## Task Commits

Each task was committed atomically:

1. **Task 1: Harness topic doc** - `1bbdeb4` (docs)
2. **Task 2: Production parity runbook** - `fd4a075` (docs)
3. **Task 3: README pointers and naming cross-reference** - `1e8e7f4` (docs)

**Plan metadata:** this summary commit (docs, see below)

## Files Created/Modified

- `docs/rehearsal.md` - Harness topic doc: isolation, commands/flags, consumer.env contract, exits, instance/tmpfs/no-pull rules, naming distinction
- `docs/runbooks/production-parity.md` - Operator runbook: header record, twin-vs-stray, readings table, unit install, both rollbacks, rh- probes, boundary list
- `README.md` - Running paragraph with relative links to both docs (+6 lines)
- `docs/observability.md` - One cross-reference sentence (+1 line)

## Decisions Made

- Connection shapes described without connection strings (key names in backticks, hosts/ports only), so the CREDENTIAL/RAILWAY scans stay green by construction rather than by luck
- All production-mutating steps (stray retirement, unit install, restarts, rollbacks) framed as operator-only with the explicit Agents-may/Agents-never/Operator boundary, per threat T-16-12
- `requirements-completed: []` left empty on purpose: FOUND-01/FOUND-03 also depend on plan 16-05 (operator checkpoints pending), and REQUIREMENTS.md checkboxes were left unchanged per orchestrator instruction

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reverted misrouted edits from the operator checkout**
- **Found during:** Task 3 (README pointers)
- **Issue:** The first two `edit` calls used a shortened `[README.md#TAG]` patch header, which the tool resolved against the operator checkout (`/root/src/repos/agent-substrate`) instead of the worktree — landing 6 README lines and 1 observability line where they must never be
- **Fix:** Reverted both files in the operator checkout (`git checkout --`, verified clean), re-read the worktree files for full-path headers, and re-applied the identical edits in the worktree
- **Files modified:** `/root/src/repos/agent-substrate/README.md`, `/root/src/repos/agent-substrate/docs/observability.md` (reverted, net zero); worktree `README.md`, `docs/observability.md` (applied)
- **Verification:** Operator checkout `git status` clean; worktree diff exactly +6/+1; committed as `1e8e7f4`
- **Committed in:** 1e8e7f4 (recovery inside the task commit)

**2. [Rule 3 - Blocking] Skipped the plan's full `bun test` in task-3 verify**
- **Found during:** Task 3 (verify step names full `bun test`)
- **Issue:** Wave testing rules forbid the full suite here; the orchestrator runs it after the wave
- **Fix:** Ran targeted store-lock (18 pass) plus `bunx tsc --noEmit` (clean); baseline hold left to the post-wave run
- **Files modified:** none
- **Verification:** store-lock 18/18, tsc clean
- **Committed in:** N/A (verify scope, not code)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both necessary for checkout hygiene and wave discipline. No scope creep.

## Issues Encountered

- The `edit`-header path resolution caught above: a shortened patch header resolves relative to the tool's default checkout, not the `path` parameter. Future edits in this wave must use the full header path exactly as the `read` result shows. No plan impact beyond the revert.

## Threat Disposition

- T-16-11 (docs values): key names in backticks only, no values or connection strings; store-lock CREDENTIAL/RAILWAY scans green on both new docs (18/18, neither doc named in any failure).
- T-16-12 (production DoS): operator-only framing on install/restart/rollback steps; never-start-from-session warning in both rollback paths; agent/operator boundary list present in the runbook.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 16-05 fills the evidence slots: the dated readings row (`--json` fields map 1:1 to table columns) and the two `rh-` zero-count results beside the proof row
- Later phases (17, 20, 27, 28) can follow `docs/rehearsal.md`'s consumer contract blindly per SC-1
- No blockers

## Self-Check: PASSED

- `docs/rehearsal.md`, `docs/runbooks/production-parity.md` exist on disk; README links resolve to created files
- Commits `1bbdeb4`, `fd4a075`, `1e8e7f4` exist on branch `gsd/v1.3-p16-production-parity`
- `bun test packages/mcp-server/src/store-lock.test.ts`: 18 pass / 0 fail at final state
- `bunx tsc --noEmit`: clean
- Acceptance greps pass: five contract keys, exit triple, harness/CHAOS distinction, window actor/time/pid with CONTEXT source, both rollbacks, both rh- counts, boundary list, relative README links, single-sentence observability change

---
*Phase: 16-production-parity-and-rehearsal-harness*
*Completed: 2026-10-08*
