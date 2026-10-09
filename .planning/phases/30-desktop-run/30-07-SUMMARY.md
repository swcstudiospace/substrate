---
phase: 30-desktop-run
plan: "07"
subsystem: api
tags: [desktop-run, proof, smoke, runbook, live-gated, bun-test]

# Dependency graph
requires:
  - phase: 30-desktop-run
    provides: desktop driver with tool.call events (plan 30-01)
  - phase: 30-desktop-run
    provides: desktopSurfaces allowlist and desktopDir config (plan 30-02)
  - phase: 30-desktop-run
    provides: registered tool with refusal matrix (plan 30-04)
  - phase: 30-desktop-run
    provides: rehearsal --desktop-surfaces flag (plan 30-05)
  - phase: 30-desktop-run
    provides: N1 spike record with NOT-RUN ladder (plan 30-06)
provides:
  - scripts/desktop-smoke.ts with the D30-19 check battery (bun run smoke:desktop)
  - scripts/desktop-smoke.test.ts with 20 green helper tests
  - 30-PROOF.md with hermetic numbers and NOT-RUN live fields
  - README Desktop section, docs/runbooks/desktop.md, desktop_run audit mark
affects: [30-proof-live-run, desktop_run production use]

# Actuals (#2632)
actuals:
  tokens: 45000
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [raw JSON-RPC smoke over fetch, boundary narrowing with in/typeof, audit silence via isAuditRecord]

key-files:
  created:
    - scripts/desktop-smoke.ts
    - scripts/desktop-smoke.test.ts
    - docs/runbooks/desktop.md
    - .planning/phases/30-desktop-run/30-PROOF.md
  modified:
    - package.json
    - README.md
    - docs/mcp-audit.md

key-decisions:
  - "Raw JSON-RPC over fetch instead of the SDK client: bare workspace deps do not resolve from scripts/, and a root dep would churn the lockfile for an already-pinned package"
  - "Live chain NOT-RUN: the smoke drives the shared display, so per the assignment contract it is implemented as code and flagged, never executed or faked"
  - "Audit silence proven on typed records via the project's own isAuditRecord, not string matching alone"

patterns-established:
  - "Boundary readers (readBlock, readShot, readRow, readRunText): one named reader per wire shape using in/typeof/Array.isArray, no casts, no generic record guard"
  - "Hermetic smoke probes: exit-2 refusal paths verified with a fabricated run dir and zero requests sent"

requirements-completed: [DESK-05]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Smoke helpers green: band finder exact on synthetic PNG round trips, marker parses under DesktopRunInput, nonce channel reaches 0xC0, guards refuse production ports and non-loopback (DESK-05)"
    requirement: "DESK-05"
    verification:
      - kind: unit
        ref: "scripts/desktop-smoke.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Live proof chain implemented as code with the D30-19 battery; live verdict fields recorded NOT-RUN, hermetic refusal paths observed exit 2 (DESK-05)"
    requirement: "DESK-05"
    verification:
      - kind: manual
        ref: ".planning/phases/30-desktop-run/30-PROOF.md"
        status: blocked
    human_judgment: true
  - id: D3
    description: "README section plus desktop runbook plus audit mark all name desktop_run; runbook covers allowlist lifecycle auth retention hashing no-secrets and rollback; no kind naming (DESK-05)"
    requirement: "DESK-05"
    verification:
      - kind: unit
        ref: "docs/runbooks/desktop.md"
        status: pass
    human_judgment: false

# Metrics
duration: 3h00min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 07: Smoke, proof, docs Summary

**Scripted headless proof client with the full D30-19 battery, 20 green
helper tests, docs landed, full suite 1735 pass / 0 fail with tsc and
phase-close green — the live chain is implemented as code and recorded
NOT-RUN per the live-gate contract.**

## Performance

- **Duration:** ~3h00 min
- **Tasks:** 3
- **Files created:** 4 (smoke, smoke tests, runbook, proof record)
- **Files modified:** 3 (package.json, README.md, docs/mcp-audit.md)

## Accomplishments

- Task 1: `scripts/desktop-smoke.ts` (side-effect-free module,
  `import.meta.main` mapping `RehearsalRefused` to exit 2) imports
  `refuseSmokeUrl`/`parseShellExports`/`runDirFor` from `scripts/rehearsal.ts`
  (no new consumer key: bearers come from the harness `tokens/<surface>`
  files), takes `--name` (default `p30`), `--surface` (default `omp`),
  `--unlisted` (default `cursor`), and runs the D30-19 battery with the
  tool-call timeout at run timeout plus 60 s. Pure helpers: `nonceRgb` (one
  channel ≥ `0xC0`), `markerText` (`String.raw` backslash sequences plus one
  real trailing newline, parses under `DesktopRunInput`), `findBand`
  (count/rect/solid exact-RGB check). `scripts/desktop-smoke.test.ts`
  proves all of it plus the guard and RPC-envelope parsing: 20 pass.
  `package.json` gains `smoke:desktop`.
- Task 2: `30-PROOF.md` records the observed hermetic numbers (helper
  suite 20/0, full suite 1735/57/0, tsc clean, phase-close exit 0, three
  exit-2 refusal probes with zero requests sent) and every live verdict
  field as `NOT-RUN` with the exact chain procedure and per-check reading
  list. No gap claimed: no live run was attempted (D30-18).
- Task 3: README `## Desktop` prose section (tool, allowlist, hash-only
  events, runbook link); `docs/runbooks/desktop.md` in the parity-runbook
  shape (header table, proof section, fenced chain with exit semantics,
  allowlist with the Phase 20 production note, lifecycle, auth file by path
  only, retention with the September-PNG note, hashing rule with the
  never-type-secrets residual, egress and timeout residuals, rollback,
  ownership); `docs/mcp-audit.md` fail-closed row gains `desktop_run` and
  the planned row reads landed. `desktop_run` grep counts 1/6/2;
  the September kind string appears in none of the three files.
- Verification: full `bun test` 1735 pass / 57 skip / 0 fail (61 files),
  `bunx tsc --noEmit` clean, `bun run check:phase-close` exit 0
  (EVENT_KINDS 12, SURFACES 27), lock suites green individually
  (store 18, redact-lock 15, redact-contract 7, vocabulary 2).

## Task Commits

Each task was committed atomically:

1. **Task 1: Build the scripted smoke client with tested pure helpers** - `2b83195` (feat)
2. **Task 2: Record the isolated proof with NOT-RUN live fields** - `docs(30-07)` commit below (the record; the live chain itself is NOT-RUN, so no code commit)
3. **Task 3: Land the README section, desktop runbook and audit-doc mark** - `cbccd4b` (docs)

**Plan metadata:** `docs(30-07)` commit below (30-PROOF.md plus this SUMMARY)

## Files Created/Modified

- `scripts/desktop-smoke.ts` - proof session: guards, token files, marker run, D30-19 battery, hash-only output, exit 0/1/2
- `scripts/desktop-smoke.test.ts` - args, digest, nonce, marker, band, guard and envelope tests (20 pass)
- `package.json` - `smoke:desktop` script
- `README.md` - `## Desktop` prose section linking the runbook
- `docs/runbooks/desktop.md` - allowlist, lifecycle, auth, retention, hashing, residuals, rollback, ownership
- `docs/mcp-audit.md` - `desktop_run` in the fail-closed row, planned row marked landed
- `.planning/phases/30-desktop-run/30-PROOF.md` - hermetic numbers plus NOT-RUN live fields and chain procedure

## Decisions Made

- Raw JSON-RPC over fetch (the `vocabulary-smoke.ts` precedent) instead of
  the SDK `Client`: probed that bare `@modelcontextprotocol/sdk` and `zod`
  imports fail from `scripts/` (workspace isolation), and a root dependency
  would churn `bun.lock` for an already-pinned package against the plan's
  no-new-package disposition. Timeout rule kept (run + 60 s).
- Wire reads go through one named reader per shape (`readBlock`,
  `readShot`, `readRow`, `readRunText`) with `in`/`typeof`/`Array.isArray`
  narrowing; the audit file goes through the project's own
  `isAuditRecord` plus `arg_keys` ⊆ actions/timeout. No local generic
  record guard, no inline-cast member access, no identifier starting with
  `redact`.
- The live chain (rehearsal up, smoke against the shared display, teardown)
  is NOT-RUN per the assignment live-gate contract; `30-PROOF.md` records
  NOT-RUN fields with the procedure, following the 30-06 precedent. A gap
  verdict would require ladder evidence, which does not exist.

## Deviations from Plan

- Analog C (SDK `StreamableHTTPClientTransport`) replaced as above; the
  plan's key link on `refuseSmokeUrl`/`parseShellExports`/`runDirFor`
  imports holds exactly.
- Two project-rule reminders during execution reshaped the code before
  commit (tiny-function and cast-access rules); the final tree complies
  (redact-lock, store-lock and tsc all green).
- `package.json` was edited via a scripted JSON round-trip after the
  structural edit tool rejected the relative path; the diff is the one
  added script line. Absolute paths used for structural edits thereafter.

## Issues Encountered

- `edit` with a repo-relative path reported "File not found"; absolute
  `PATH#TAG` headers work in this worktree setup.
- Bare SDK/zod imports unresolvable from `scripts/` (verified by probe);
  resolved by the raw-JSON-RPC design, no lockfile change.

## Self-Check: PASSED

- All seven plan artifacts exist; `smoke:desktop` resolves; helper suite
  20/0; full suite green; tsc clean; phase-close exit 0.
- Repo locks respected: no `GREPTIME_` outside the MCP package, no token
  literals (bearers read from files, short fixture-free code), no second
  redactor or credential regex, no new `EVENT_KINDS`/`SURFACES` entries,
  no secret material in any new file (verified by scan).
- Live-gated steps implemented as code, flagged NOT-RUN, never executed or
  faked; no production service, store, or container touched (only hermetic
  reads: file scan, unit tests, type-check, phase-close).

## User Setup Required

- **Live run (operator):** an environment with the labelled
  `substrate-desktop` container up on `127.0.0.1:6081`, then the chain in
  `30-PROOF.md` §2 (`rehearsal up --name p30 --surfaces omp,cursor
  --desktop-surfaces omp`, `smoke:desktop --name p30`, `check:phase-close`,
  `rehearsal down --name p30`) and fill the NOT-RUN verdict fields with the
  observed numbers — or a stated gap per D30-18 if the band is stale.

## Next Phase Readiness

- The live run needs no code changes: `bun run smoke:desktop --name p30`
  runs the full battery once the harness twin and the labelled container
  are up.
- If the N1 ladder later changes the screenshot capture path, only the
  driver's argv changes; the smoke's band assertion stays valid.

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
