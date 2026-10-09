---
phase: 20-production-identity-and-phase-0-uat
plan: "03"
subsystem: auth
tags: [identity-manifest, identity-check, production-runbook, bun-test]

# Dependency graph
requires:
  - phase: 20-production-identity-and-phase-0-uat
    provides: "plan 20-01 tokenConfig (values-mode contradiction check) and plan 20-02 resolver (tokens-dir checks)"
  - phase: 16-production-parity-and-rehearsal-harness
    provides: "parity runbook header shape, rehearsal env-line parser shape"
  - phase: 19-lane-b-collectors
    provides: "collectors.md herdr env section"
provides:
  - "Tracked client manifest (`infra/identity/clients.json`, names only)"
  - "identity:check script (names-only default plus operator --values mode)"
  - "Production-identity runbook with marked client table locked to the manifest"
  - "identity:check and uat:phase0 package script entries"
affects: [20-04-uat-phase0, 20-06-live-window, production-switch-on]

# Actuals — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 6800
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [names-only-parser-dropping-values-at-parse-time, manifest-to-runbook-marked-table-lock, stat-only-tokens-dir-checks]

key-files:
  created: [infra/identity/clients.json, scripts/identity-check.ts, scripts/identity-check.test.ts, docs/runbooks/production-identity.md]
  modified: [package.json, docs/collectors.md]

key-decisions:
  - "Surface membership is a test lock, not a load-time refusal"
  - "Values mode compares sha256 equality in memory and prints match/missing/mismatch only"
  - "herdr env must not define a single-surface token (per-event resolution applies)"

requirements-completed: [FOUND-04]

# Coverage metadata — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "Manifest lists every client with surface, delivery, state and evidence, names only"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "scripts/identity-check.test.ts#the tracked manifest (49/49 ids also in the runbook marked table)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Names-only check reports per-client delivery; values mode prints three verdict words only"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "scripts/identity-check.test.ts (26 pass / 0 fail) plus `bun run identity:check` exit 1 pre-provisioning with stranded live named, no values in output"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runbook holds client table, generation, window, bridge variant, dormant counts, rollback, rotation"
    requirement: "FOUND-04"
    verification:
      - kind: other
        ref: "docs/runbooks/production-identity.md (49/49 manifest ids in marked table; no pipe in cells; token-literal scan clean)"
        status: pass
    human_judgment: false

# Metrics
duration: single-session plus rebase recovery
completed: 2026-10-09
status: complete
---

# Phase 20 plan 03: Identity manifest, check and runbook Summary

**The no-strand guarantee in code and docs: a tracked names-only client manifest, a two-mode check script, and the production-identity runbook locked together by test**

## Performance

- **Duration:** single agent session plus rebase recovery
- **Started:** 2026-10-09
- **Completed:** 2026-10-09
- **Tasks:** 2
- **Files modified:** 6 (4 created, 2 extended) plus this summary

## Accomplishments

- `infra/identity/clients.json`: one row per client (id, surface, delivery, state, evidence), 49 clients; herdr appears per mapped non-swarm surface; no values, no repo-checkout delivery paths
- `scripts/identity-check.ts`: pure core plus main with the `identity-check` prefix; names-only default (variable names, stat-only tokens-dir checks, verdict words) plus operator `--values` mode (in-memory sha256 equality, prints match/missing/mismatch/unchecked only); `--json`, `--manifest`, `--server-env` flags; `tokenConfig` shared for the values-mode contradiction check
- `docs/runbooks/production-identity.md`: parity header shape with agents-may/agents-never/operator sections; marked client table mirroring the manifest; 32-random-byte generation into 0600 files; D20-20 ordered window; D20-10 bridge variant naming no code variable; D20-07 dormant 401 counts with the metrics-counter read; D20-09 rollback; handoff-key plus list-form rotation; D20-06 external clients; swarm as not-installed; parity and lane-b links
- `package.json`: `identity:check` and `uat:phase0` entries, no dependency changes
- `docs/collectors.md`: herdr env rule — no single-surface token, since per-event resolution applies

## Task Commits

1. **Task 1: Manifest plus identity-check script and tests** — commit `e6669c4 feat(20-03)` / `70c5021 test(20-03)` (pre-rebase; type fixes in `4ae5665`, see Deviations)
2. **Task 2: Runbook, script entries and collector note** — commit `ef13c54 feat(20-03)`

## Files Created/Modified

- `infra/identity/clients.json` (new, 49 clients)
- `scripts/identity-check.ts` (new, 718 lines), `scripts/identity-check.test.ts` (new, 26 pass — parser safety, verdicts, manifest→runbook→env-example locks)
- `docs/runbooks/production-identity.md` (new)
- `package.json` — two script entries
- `docs/collectors.md` — herdr env rule appended to the herdr section

## Decisions Made

- Surface membership stays a test lock, not a load-time refusal: an unknown surface still yields its deterministic variable name so the report shows it as missing instead of silently dropping the client
- The runbook states client paths in prose; the generation command writes 32 random bytes straight into 0600 files with no repo script touching system paths
- `docs/lessons-bank.md` untouched (names no wrong variable — same call as 20-01)

## Deviations from Plan

### Auto-fixed Issues
**1. [tsc] Narrowed Surface-typed call sites the branch never gated**
- **Found during:** post-rebase `bunx tsc --noEmit` (4 errors in the Task 1 files; the plan's verify ran the unit suite only)
- **Issue:** `client.surface` is typed `string`, but `tokenEnvName` takes `Surface` and bun's `toContain` overloads reject a `string` arg against a `Surface[]`
- **Fix:** `as Surface` casts at the four call sites, mirroring `config.ts`'s own membership-cast precedent with a justification comment; runtime behavior unchanged, membership still enforced by the manifest-shape lock test
- **Files modified:** scripts/identity-check.ts, scripts/identity-check.test.ts
- **Verification:** `bunx tsc --noEmit` clean, identity-check suite 26 pass
- **Committed in:** `4ae5665 fix(20-01,20-02)`

**2. [Tooling] Whole-file package.json write after edit-tool hash rejection**
- **Found during:** Task 2 (subagent execution)
- **Issue:** the surgical-edit tool rejected every package.json patch with a contradictory session-tag error
- **Fix:** whole-file write preserving exact 2-space formatting; final diff is the same 2 added lines; reported via `xd://report_issue`
- **Files modified:** package.json
- **Verification:** `git diff package.json` is the 2-line entry add; no dependency changes
- **Committed in:** `ef13c54 feat(20-03)`

---
**Total deviations:** 2 auto-fixed (1 type-gate tightening, 1 tooling workaround)
**Impact on plan:** PLAN remains the authority and is fully executed.

## Issues Encountered

- Task 2 was blocked pre-rebase (`docs/collectors.md` absent on the branch); the rebase onto a main holding Phase 19 supplied the precondition, verified present before editing
- `bun run identity:check` exits 1 pre-provisioning with 5 stranded live clients named (`cursor-hooks`, `substrate-cli`, `connector`, `collector-grok`, `operator`) — the expected pre-window state, not a failure; values/hashes confirmed absent from output

## Evidence

- `bun test scripts/identity-check.test.ts` → **26 pass, 0 fail, 450 expect() calls**
- `bun run identity:check` → exit 1, `FAIL — 5 live client(s) stranded: ...` (server `/etc/substrate/substrate.env`: 19/29 names present), no values or hashes in output
- Runbook self-checks: 49/49 manifest ids in the marked table, no pipe inside cells, token-literal scan clean, bridge variant names no code variable
- `bunx tsc --noEmit` → clean

## User Setup Required

- Operator provisioning plus the 20-06 live window (token files, server variables, single restart, post-switch evidence) — human-gated, NOT done here

## Next Phase Readiness

- 20-04's UAT runner can rely on the manifest, both check modes, and the `uat:phase0` package entry (the script itself lands in 20-04)
- The 20-06 live window procedure is fully documented; `identity:check` names-only runs from the package script today

---
*Phase: 20-production-identity-and-phase-0-uat, plan 03*
*Completed: 2026-10-09*
