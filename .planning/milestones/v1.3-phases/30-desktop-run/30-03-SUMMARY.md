---
phase: 30-desktop-run
plan: "03"
subsystem: infra
tags: [desktop-run, lifecycle-script, path-stub, bash, shellcheck, bun-test]

# Dependency graph
requires:
  - phase: 30-desktop-run
    provides: ported substrate-desktop.sh with env-file seam (plan 30-03 task 1)
provides:
  - PATH-stub gate and argv proof for substrate-desktop.sh without Docker
  - bash -n plus shellcheck 0.10.0 checks pinned in-suite
affects: [30-07-proof, substrate-desktop.sh status check]

# Actuals (#2632)
actuals:
  tokens: 12000
  tasks: 1
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns: [PATH-injected stub dir for shell scripts, explicit spawn env never spreading process.env, brace-free stub bash under String.raw]

key-files:
  created:
    - scripts/substrate-desktop.test.ts
  modified: []

key-decisions:
  - "Rig named as an interface per the ts-no-return-type rule; baseEnv takes Rig, not ReturnType"
  - "Stub bash avoids ${...} entirely (String.raw still interpolates it); defaults via -z tests"
  - "docker stub matches exec* (the script passes -e DISPLAY=:1 as $2)"
  - "Root-gated cases use test.if(IS_ROOT) from id -u; non-root refusal drops privilege via setpriv on a world-readable script copy"

patterns-established:
  - "assertCleanArgv per scenario: strip --pull never, then forbid whole-word rm|stop|kill|pull plus recruitment"
  - "Env-file silence asserted by extracting PASSWORD from the file and proving stdout/stderr lack it"

requirements-completed: [DESK-04]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Locked docker run argv and up/startainment behavior without Docker (DESK-04)"
    requirement: "DESK-04"
    verification:
      - kind: unit
        ref: "scripts/substrate-desktop.test.ts#creates the container with the locked run argv"
        status: pass
    human_judgment: false
  - id: D2
    description: "Disk, label and image refusals with no touch/no pull/no docker call (DESK-04)"
    requirement: "DESK-04"
    verification:
      - kind: unit
        ref: "scripts/substrate-desktop.test.ts#refuses below 10 GiB free before any docker call"
        status: pass
    human_judgment: false
  - id: D3
    description: "Env file generated once, mode 600, never echoed; non-root refused; bash -n and shellcheck clean (DESK-04)"
    requirement: "DESK-04"
    verification:
      - kind: unit
        ref: "scripts/substrate-desktop.test.ts#generates the env file once, mode 600, never echoed"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 03: Lifecycle script gates proved with PATH stubs Summary

**`scripts/substrate-desktop.test.ts` proves every D30-15 gate and the locked `docker run` argv with PATH-injected `docker`/`df`/`openssl` stubs — 15 tests green, `bash -n` and `shellcheck` 0.10.0 exit 0, tsc clean, store-lock and redact-lock green.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-10-09T13:00Z
- **Completed:** 2026-10-09T13:45Z
- **Tasks:** 1 (task 1 pre-committed as `ca0165c` by the prior unit)
- **Files modified:** 1 created

## Accomplishments

- Task 1 verified pre-done: `infra/desktop/substrate-desktop.sh` is executable, `bash -n` exits 0, diff against `acc30a8` is exactly 3 hunks (runbook pointer, `SUBSTRATE_DESKTOP_ENV_FILE` seam, SC2016 directive), no redact name or marker literal.
- Created `scripts/substrate-desktop.test.ts` (15 tests, 147 expects): stub dir with executable `docker`/`df`/`openssl` bash stubs logging argv to `$STUB_LOG` and answering from `STUB_DF_AVAIL`/`STUB_IMAGE`/`STUB_CONTAINER` knobs plus `1280 800` geometry; every spawn uses an explicit env (stub PATH, knobs, temp env-file path), never spreading `process.env`.
- Pinned: `--pull never`, `-p 127.0.0.1:6081:3000`, role label, named volume, `--shm-size 1g`, and absence of `--privileged`, `docker.sock`, `--network host`, host `-v /` binds; disk refusal below 10737418240 bytes with zero docker calls and acceptance at exactly the gate; foreign-container and missing-image refusals with no run/start/pull; env file byte-exact `CUSTOM_USER`/`PASSWORD` at mode 600 absent from all output plus generated-once (pre-existing file untouched, no openssl call); status key=value lines; usage exit 2; per-scenario clean-argv scan; in-suite `bash -n` and conditional `shellcheck` checks.
- Verification chain: `bun test ./scripts/substrate-desktop.test.ts` 15 pass / 0 fail; `bash -n` exit 0; `shellcheck` 0.10.0 exit 0 with empty output; `bunx tsc --noEmit` clean; `store-lock.test.ts` 18 pass; `redact-lock.test.ts` 15 pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Port substrate-desktop.sh with the env-file seam, lint directive and runbook pointer** - `ca0165c` (feat, prior unit)
2. **Task 2: Prove script gates and argv with PATH-stub tests, bash -n and shellcheck** - `d7ca211` (test)

**Plan metadata:** `docs(30-03)` commit below (this SUMMARY)

## Files Created/Modified

- `scripts/substrate-desktop.test.ts` - PATH-stub gate/argv/env-file/root/lint tests (15 pass)

## Decisions Made

- `Rig` named interface instead of `ReturnType<typeof makeRig>` (repo `ts-no-return-type` rule).
- Stub scripts written brace-free (`$VAR`, `-z` defaults) because `String.raw` still interpolates `${...}`.
- Docker stub matches `exec*` since the script passes `-e DISPLAY=:1` as `$2` (first version matched bare `exec` and every geometry wait looped into the 5 s test timeout).
- Root-gated tests via `test.if(IS_ROOT)` from `id -u`; non-root refusal via `setpriv` on a 0755-dir/0644 script copy (stdin-feed unnecessary once the copy is world-readable).
- `STUB_PASSWORD` hardcoded as the deterministic tr/head product of the stub alphabet; silence proven by file extraction, never by printing.

## Deviations from Plan

None - plan executed exactly as written. (Two self-inflicted mistakes during execution — `${...}` interpolation inside `String.raw` stubs, and an edit that ate the `RunResult` line — were corrected before commit; final committed content matches the plan.)

## Issues Encountered

- First run: 7 failures, all from the `exec)` stub mismatch (geometry empty, `up` looped to the test timeout, status reported `geometry=unknown`). One-pattern fix (`exec*`), full suite green in 426 ms.
- `tsc` caught the eaten `RunResult` type; restored as a named type beside `Rig`.

## Self-Check: PASSED

- `scripts/substrate-desktop.test.ts` exists, committed as `d7ca211`, 354 insertions, no deletions.
- No stubs-as-in-unfinished-work (no TODO/FIXME/placeholder); no new dependencies; no `/etc` writes (env file always temp).
- Repo locks respected: no `SUBSTRATE_TOKEN*=16+` or `GREPTIME_*` credential literals; no `redact*` binding or `[REDACTED` literal; no credential-shape regex; no new `EVENT_KINDS`/`SURFACES` entries.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 30-07 can rely on `substrate-desktop.sh up|status` gates plus the in-suite lint checks; the script itself is unchanged by this plan.
- Residual risks for the runbook (plan 30-07): none new; disk gate constant 10737418240 is pinned at its exact boundary.

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
