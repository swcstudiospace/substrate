---
phase: 30-desktop-run
plan: "04"
subsystem: api
tags: [desktop-run, mcp-tool, allowlist-gate, refusal-matrix, audit, bun-test]

# Dependency graph
requires:
  - phase: 30-desktop-run
    provides: desktop driver with tool.call events (plan 30-01)
  - phase: 30-desktop-run
    provides: desktopSurfaces allowlist and desktopDir config (plan 30-02)
provides:
  - Substrate.runDesktop six-step gate with nothing-was-run refusals
  - desktop_run MCP registration with strict schema and image-block replies
  - desktop_run in KNOWN_TOOLS plus production driver wiring in index.ts
  - MCP and HTTP refusal/schema/ledger-stop/audit-silence proof suites
  - Corrected desktop.action sample and payload-field doc
affects: [30-05-harness-flag, 30-07-proof, desktop_run production use]

# Actuals (#2632)
actuals:
  tokens: 28000
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [refused-failed-result union for tool outcomes, strict ZodObject registration rejecting self-attribution, bufferRunner confinement lock test]

key-files:
  created:
    - packages/mcp-server/src/desktop/tool.test.ts
  modified:
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/observe.ts
    - packages/mcp-server/src/index.ts
    - packages/mcp-server/src/observe.test.ts
    - packages/mcp-server/src/http.test.ts
    - packages/mcp-server/src/event-sources.ts
    - docs/event-vocabulary.md

key-decisions:
  - "runDesktop returns refused/failed/result union; driver throws (parse, bounds, geometry) propagate to the redacted 400-char catch, started-but-unstored returns failed with no images"
  - "Busy maps to refused via instanceof DesktopBusy; isOperator never consulted in the gate or handler"
  - "bufferRunner confinement pinned by a git-tracked-files grep test housed in tool.test.ts with a Record allowlist"
  - "No policy.ts edit: the Phase 17 base already pins desktop_run fail-closed (policy.test.ts:12)"

patterns-established:
  - "callFull helper returning the whole content array for image-block tools (call reads only content zero)"
  - "HTTP toolResult parser reading the SSE data line with a raw-JSON fallback for gate refusals"
  - "XWD fixture duplicated per test file, never imported across test files (avoids double registration)"

requirements-completed: [DESK-01, DESK-02, DESK-03]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Six-step refusal order with nothing-was-run refusals, strict schema, image-block success (DESK-01, DESK-03)"
    requirement: "DESK-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/tool.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "VM-guest 401s precede runner and audit; self-attribution rejected; unwritable audit denies; audit record keys-plus-digest only in fail-closed mode (DESK-02, DESK-03)"
    requirement: "DESK-03"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/http.test.ts#desktop_run at the HTTP gate"
        status: pass
    human_judgment: false
  - id: D3
    description: "desktop.action sample in production form; vocabulary doc field lists; fail-closed pin (DESK-02)"
    requirement: "DESK-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/event-sources.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: 2h10min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 04: MCP registration and refusal matrix Summary

**`desktop_run` registered behind the six-step allowlist gate with strict-schema self-attribution rejection, image-block replies, ledger-stop failures and a keys-plus-digest audit trail — 16 new tests green, full verification chain plus phase-close green.**

## Performance

- **Duration:** ~2h10 min
- **Started:** 2026-10-09T13:45Z
- **Completed:** 2026-10-09T15:55Z
- **Tasks:** 3
- **Files modified:** 9 (1 created, 8 modified)

## Accomplishments

- Task 1: `Substrate.runDesktop` enforces anonymous → unlisted → unwired-driver → no-ledger → busy → run, passing per-call `emit` reading `stored`; `mcp.ts` registers the strict `DesktopRunInput` object (not `.shape`) with refused/failed/image-block mapping and a redacted 400-char throw mapping; `observe.ts` labels `desktop_run`; `index.ts` wires `createDesktopDriver({ run: bufferRunner, dir: config.desktopDir })` as the only production wiring; `observe.test.ts` pins the label. tsc clean.
- Task 2: `desktop/tool.test.ts` (10 tests) proves unlisted/anonymous refusals with zero runner calls and zero events, strict-schema rejection of a `surface` argument, no-ledger refusal, unwired-driver refusal, busy naming the active run, sha-equal text-plus-image success with matching stored file and one hash-only tool.call event, ledger-stop isError with run_id and no image blocks, tool listing with `additionalProperties: false`, and the `bufferRunner` confinement lock. `http.test.ts` (+6 tests) proves no-token and bogus-bearer 401s precede runner and audit, live unlisted-token refusal, header-plus-argument self-attribution rejection, unwritable-audit `-32000`, and the D30-13 audit silence (`arg_keys` ⊆ actions/timeout, `mode: fail-closed`, no typed text, no `iVBOR`).
- Task 3: `desktop.action` sample corrected to production form (`desktop screenshot ok`, `desktop:dr-…` session, `dr-…` run id; kind/surface/tool/action values byte-identical); vocabulary doc gains the per-action hash-only field lists without naming a kind; `policy.ts` untouched (Phase 17 already lists `desktop_run` fail-closed, pinned at `policy.test.ts:12`).
- Verification chain: observe 56, tool 10, http 62, event-sources 73, policy 14 — all pass; `bunx tsc --noEmit` clean; `bun run check:phase-close` pass (4 lock files green, EVENT_KINDS 12, SURFACES 27).

## Task Commits

Each task was committed atomically:

1. **Task 1: Gate runDesktop in service.ts, register the strict tool in mcp.ts, wire index.ts and observe.ts** - `65395a4` (feat)
2. **Task 2: Prove refusals, strict schema, image blocks, ledger-stop and audit silence over MCP and HTTP** - `6674c8f` (test)
3. **Task 3: Correct the EVENT_SOURCES desktop.action sample and vocabulary doc, verify the audit entry** - `3126c35` (fix)

**Plan metadata:** `docs(30-04)` commit below (this SUMMARY)

## Files Created/Modified

- `packages/mcp-server/src/service.ts` - `stores.desktop` seam defaulting null, `runDesktop` six-step gate
- `packages/mcp-server/src/mcp.ts` - `desktop_run` strict registration, outcome mapping, redacted throw mapping
- `packages/mcp-server/src/observe.ts` - `desktop_run` in `KNOWN_TOOLS`
- `packages/mcp-server/src/index.ts` - production driver wiring (only `bufferRunner` site outside the driver)
- `packages/mcp-server/src/observe.test.ts` - `toolLabel("desktop_run")` pin
- `packages/mcp-server/src/desktop/tool.test.ts` - MCP-level refusal/schema/image/ledger-stop/listing/confinement tests (10 pass)
- `packages/mcp-server/src/http.test.ts` - HTTP-gate 401/self-attribution/audit-denial/silence tests (+6 pass)
- `packages/mcp-server/src/event-sources.ts` - corrected `desktop.action` sample
- `docs/event-vocabulary.md` - desktop payload field lists

## Decisions Made

- `failed` carries `{run_id, log, error}` split out of the driver result in `runDesktop` (not in the driver), so the MCP mapping is a direct union branch and the driver keeps its single result shape.
- Pre-run throws (zod parse, bounds, geometry) propagate to the handler catch → redacted 400-char `refusal` (T-30-21), rather than inventing run ids for runs that never started.
- `x-substrate-propose-key` needs no code: Phase 21 dropped the header, so the HTTP test sends it only to prove it changes nothing.
- XWD/record fixtures duplicated across `tool.test.ts`/`http.test.ts`/`driver.test.ts` per the 30-01 no-cross-test-import precedent.
- Static `allowed` table in the confinement test is a `Record<string, true>` (repo `ts-set-map` rule); indexed test access uses `!` (repo precedent).

## Deviations from Plan

None - plan executed exactly as written. (Three self-inflicted edit mistakes during execution — a duplicated KNOWN_TOOLS line that proved already correct on re-read, a mis-anchored Record patch that landed mid-test and was restored, and a ROOT depth plus screenshot-filename assumption in the new tests — were corrected before commit; final committed content matches the plan.)

## Issues Encountered

- Docker stub `exec)` case never matched `exec -e` (same class of bug as 30-03, in test fixtures): matched `exec*`.
- `git ls-files` from `src/desktop/` needed one more `..` for repo ROOT; screenshot filename comes from the reply `path`, not an assumed `0.png`.
- SDK 1.30.1 maps both validation failures and handler throws to `isError` results, which is what makes the strict-schema `isError` assertion hold.

## Self-Check: PASSED

- All nine files exist, committed as `65395a4`, task-2 commit, `3126c35`; no deletions; no stubs; no new dependencies.
- Repo locks respected: `bufferRunner` referenced only in `desktop/driver.ts`, `index.ts` and the lock test itself (which excludes itself); no `SUBSTRATE_TOKEN*=16+` or `GREPTIME_*` credential literals (short `tok-omp`/`tok-cursor` only); no `redact*` binding or `[REDACTED` literal; no new `EVENT_KINDS`/`SURFACES` entries (phase-close confirms 12/27).
- `isOperator` appears nowhere in the new gate or handler code.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 30-05 (harness flag) and 30-07 (proof) can call `desktop_run` through MCP/HTTP against `SUBSTRATE_DESKTOP_SURFACES=omp` with the recorder or the live container behind the driver.
- Plan 30-06 (N1 spike) touches only the screenshot capture path, which this plan never executes (recorder runner) — no ordering edge, as the plan coupling note states.
- Residual risks for the runbook (plan 30-07): unsalted sha256 of short typed values is brute-forceable by ledger readers (documented in the new vocab prose by omission rule, full warning belongs in the runbook).

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
