---
phase: 30-desktop-run
plan: "02"
subsystem: api
tags: [desktop-run, config, allowlist, boot-warnings, bun-test]

# Dependency graph
requires:
  - phase: 30-desktop-run
    provides: Desktop driver with config.desktopDir storage (plan 30-01)
provides:
  - config.desktopSurfaces allowlist with fail-closed empty default (D30-01)
  - config.desktopDir with absolute-only override (D30-09)
  - desktopConfigWarnings sibling wired in the index.ts boot loop
  - SUBSTRATE_DESKTOP_SURFACES / SUBSTRATE_DESKTOP_DIR in .env.example
affects: [30-04-substrate-wiring, 30-05-harness-flag, desktop_run tool registration]

# Actuals (#2632)
actuals:
  tokens: 2649
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [config sibling warnings (desktopConfigWarnings beside swarmTokenWarnings), comma-split trim-filter allowlist parsing with dropped-name capture]

key-files:
  created:
    - packages/mcp-server/src/desktop/config.test.ts
  modified:
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/index.ts
    - .env.example

key-decisions:
  - "desktopDirRejected: string | null holds the rejected relative dir so the sibling can warn from config alone (a path, not a credential, safe to quote)"
  - "isKnownDesktopSurface as a local type-guard in config.ts mirroring the event.ts/memory-policy.ts precedent (SURFACES membership, no new SURFACES entries)"
  - "desktopConfigWarnings returns one line per gap (unknown names, relative dir) and [] for empty or fully valid allowlists; configWarnings untouched"

patterns-established:
  - "Dropped allowlist names captured in desktopIgnored (names only) at parse time; warnings derived from config, never re-parsed from env"
  - "Relative SUBSTRATE_DESKTOP_DIR keeps DEFAULT_DESKTOP_DIR and records the rejection; loadConfig never throws over desktop env"

requirements-completed: [DESK-03]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Allowlist parses with fail-closed empty default; unknown names dropped and warned by name"
    requirement: "DESK-03"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/config.test.ts#an unknown name is dropped, warned by name, and never leaks a token value"
        status: pass
    human_judgment: false
  - id: D2
    description: "Desktop dir absolute-only; relative keeps the default with a boot warning"
    requirement: "DESK-03"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/desktop/config.test.ts#a relative desktop dir keeps the default with one warning"
        status: pass
    human_judgment: false
  - id: D3
    description: "Sibling wired in the index.ts boot warnings loop; configWarnings untouched; env names documented"
    requirement: "DESK-03"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/authority.test.ts (36 pass, configWarnings expectations unmodified)"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-10-09
status: complete
---

# Phase 30 Plan 02: Desktop allowlist and directory config Summary

**Operator allowlist `SUBSTRATE_DESKTOP_SURFACES` parsed into `config.desktopSurfaces` with fail-closed empty default, unknown names dropped to `desktopIgnored` and warned by name via the `desktopConfigWarnings` sibling, plus absolute-only `config.desktopDir` — 6 config tests green, authority and store-lock suites green, tsc clean.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-10-09T07:00Z
- **Completed:** 2026-10-09T07:25Z
- **Tasks:** 2
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `SubstrateConfig` gains `desktopSurfaces: ReadonlySet<Surface>`, `desktopDir: string`, `desktopIgnored: readonly string[]` and `desktopDirRejected: string | null`, each with an audit-field-style doc comment.
- `loadConfig` parses `SUBSTRATE_DESKTOP_SURFACES` with the existing operatorTokens comma-split trim-filter idiom, keeping only `SURFACES` members and recording the rest in `desktopIgnored`; `SUBSTRATE_DESKTOP_DIR` overrides `DEFAULT_DESKTOP_DIR` (`/var/lib/substrate/desktop`) only when absolute, otherwise keeping the default and recording the rejection — never throwing.
- `desktopConfigWarnings(config)` sibling (modelled on `swarmTokenWarnings`) returns `[]` for empty or fully valid allowlists, otherwise one line per gap; `configWarnings` untouched.
- `index.ts` boot loop concatenates `desktopConfigWarnings(config)` beside the two existing siblings.
- `.env.example` gains a desktop section naming both variables with runbook-pointer comments.
- `packages/mcp-server/src/desktop/config.test.ts` covers all six cases (empty, valid-with-spaces, unknown-name with token-leak assertion, relative dir, absolute dir, `configWarnings` untouched).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add desktopSurfaces and desktopDir to config with the warnings sibling** - `f195906` (feat)
2. **Task 2: Cover allowlist parsing, warning names and the absolute-dir rule** - `ed16f67` (test)

**Plan metadata:** docs commit below (this SUMMARY)

## Files Created/Modified

- `packages/mcp-server/src/config.ts` - Desktop fields, parsing, `DEFAULT_DESKTOP_DIR`, `isKnownDesktopSurface`, `desktopConfigWarnings`
- `packages/mcp-server/src/index.ts` - Boot warnings loop gains the desktop sibling
- `packages/mcp-server/src/desktop/config.test.ts` - Six allowlist/dir/warning cases (6 pass)
- `.env.example` - Desktop section with both variables

## Decisions Made

- `desktopDirRejected: string | null` holds the rejected relative value so `desktopConfigWarnings` can warn from config alone without re-reading env; a path is not a credential, so quoting it in the warning is safe (T-30-02 covers token values only).
- `isKnownDesktopSurface` is a module-local type guard (`value is Surface`, mirroring `event.ts:38-40` and `memory-policy.ts:78-80`), which both preserves narrowing into the `Set<Surface>` and serves three call sites.
- Warning wording: one line per gap; the unknown-name line joins all dropped names; the dir line quotes the rejected value and names the default in effect.
- No driver wiring in `index.ts` — that is plan 30-04's scope; this plan touches only the warnings loop.

## Deviations from Plan

None - plan executed exactly as written. (Two self-inflicted edit-tool range mistakes during Task 1 — an eaten interface brace/`requireRecordedClaims` field and a mangled `parseGrants` closer — were corrected before any commit; final committed content matches the plan.)

## Issues Encountered

- The repo `ts-set-map` and `ts-no-tiny-functions` rules fired as reminders during execution: `new Set(...)` for `desktopSurfaces` is plan-mandated dynamic membership (compliant), and `isKnownDesktopSurface` is an allowed type guard with three call sites (compliant). No changes needed.

## Self-Check: PASSED

- All four files exist on disk.
- Commits `f195906` and `ed16f67` present in `git log`.
- No file deletions in either commit; no stubs (no TODO/FIXME/placeholder); no new dependencies.
- Repo locks respected: no new `EVENT_KINDS`/`SURFACES` entries; no second redactor; test token value `tok-omp` kept short per the store-lock `TOKEN_LITERAL` rule; no `GREPTIME_*` literal next to a value; `.env.example` additions are blank/default-path only.
- `isOperator` never consulted by the new code (it appears nowhere in the diff).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 30-04 can read `config.desktopSurfaces` for the `runDesktop` gate and `config.desktopDir` for driver wiring; the boot loop already reports misconfiguration.
- Plan 30-05 can round-trip `SUBSTRATE_DESKTOP_SURFACES`/`SUBSTRATE_DESKTOP_DIR` through `loadConfig` with zero-warning assertions for valid allowlists.

---
*Phase: 30-desktop-run*
*Completed: 2026-10-09*
