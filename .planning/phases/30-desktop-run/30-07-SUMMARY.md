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
    provides: measured N1 spike with three fresh-as-ported real pixel repeats (plan 30-06)
provides:
  - scripts/desktop-smoke.ts with the D30-19 check battery (bun run smoke:desktop)
  - scripts/desktop-smoke.test.ts with behavior and fail-closed snapshot cases exercised by the final parent full suite
  - 30-PROOF.md with corrected real-runtime 20/20 plus preserved historical 18/20 failure
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
  - "Initial 2026-10-09 execution was code-only; parent later executed the approved isolated real desktop chain on 2026-10-11 and observed 20/20 without a model turn"
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
    description: "Actual isolated MCP pixel, image/file/event hash, audit, token refusal and unchanged-desktop proof passed 20/20"
    requirement: "DESK-05"
    verification:
      - kind: manual
        ref: ".planning/phases/30-desktop-run/30-PROOF.md"
        status: pass
    human_judgment: false
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
completed: 2026-10-11
status: complete
---

# Phase 30 Plan 07: Smoke, proof, docs Summary

**Corrected real-runtime proof passed 20/20 on 2026-10-11.** Parent observed
9120 solid480×19 nonce pixels with baseline0, matching block/file/event hashes,
five hash-only action events, both401 checks, fail-closed audit and authoritative
unrelated-desktop absence before/after. The first18/20 remains a separate FAIL.
Final parent source union:2719pass/58skip/0fail, types0, locks108pass/0fail;
no separate child run is claimed. Phase20 operator checkpoints remain pending.

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
- Task 2 historical initial record: `30-PROOF.md` originally held hermetic
  numbers (20/0,1735/57/0, types clean and exit-2 guards) with no live verdict.
  Current corrected proof is recorded separately:20/20, parent-owned real
  execution and complete named-twin teardown, without overwriting that history.
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
- Parent later exercised the corrected real chain separately:20/20 with
  full owned teardown. The initial18/20 remains FAIL. Shared final source
  gates are2719pass/58skip/0fail, types0 and locks108pass/0fail; child
  tasks ran no checks. No production service/store, model or main merge.

## Live follow-up — initial failure and separate corrected pass

- The §2 chain ran once (twin `p21-a6a927a5`, rev `4df30a0`): exit 1,
  18/20. Both failures are the `recruitment-desktop` inspect checks — the
  unrelated desktop is absent on this host and the old null-on-error
  inspect conflated absence with probe failure. Pixel, event, audit,
  refusal, 401 and status checks all passed (see `30-PROOF.md` §3 for the
  observed numbers). The FAIL stands; nothing here rewords it.
- The fail-closed snapshot now distinguishes present/absent/error using
  authoritative inventory plus conditional inspect. Pure consumer-state
  tests passed in the final suite; mock-echo/wiring cases and their unused
  exported seam were removed rather than repinned. No capture-path change;
  no threshold or check-count change (the battery remains20).
- Corrected parent twin `v13-proof-230c1bd0` separately passed20/20:
  9120 solid480×19 pixels/baseline0, matching image/file/event hashes,
  five hash-only action rows, unlisted5→5, both401s, two fail-closed
  audit records and authoritative unrelated-desktop absence before/after.
  Up/down exited0 and removed two owned stores; every own terminal closed.

## User Setup Required

- No first-run or corrected-runtime verdict is pending. Production
  identity/allowlist/client installation and their approved windows remain
  operator-owned under Phase20; local proof is not production approval.

## Next Phase Readiness

- The live run needs no code changes: `bun run smoke:desktop --name p30`
  runs the full battery once the harness twin and the labelled container
  are up.
- If the N1 ladder later changes the screenshot capture path, only the
  driver's argv changes; the smoke's band assertion stays valid.

---
*Phase: 30-desktop-run*
*Initial implementation: 2026-10-09; corrected real proof: 2026-10-11*
