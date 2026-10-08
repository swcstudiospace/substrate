---
phase: 18-guard-rails-and-shared-redactor
plan: "18-01"
subsystem: security
tags: [redaction, secrets, bun-test, memory-classify, laneb-06]

# Dependency graph
requires: []
provides:
  - Labelled 30-entry RULES table with RedactionRuleName and read-only REDACTION_RULES in redact.ts
  - Per-rule runtime-assembled fixture corpus with coverage, counter-exemption, near-miss and narrowed pk-rk tests in redact.test.ts
  - Widened secret-quarantine tests in memory-classify.test.ts
affects: [18-02-skill-pass, 18-03-redaction-lock, 18-04-docs-harness, memory-classify, redactValue-consumers]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 4376
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: ["labelled rule table with derived name type (as const satisfies + RedactionRuleName)", "Record<RedactionRuleName, fixtures> corpus with runtime-assembled secrets", "per-fixture four-check contract (own-pattern fires, surrounding text intact, idempotent, redactValue reach)"]

key-files:
  created: []
  modified: [packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts, packages/mcp-server/src/memory-classify.test.ts]

key-decisions:
  - "pk-rk ships in the D18-21 narrowed digit-required form, the only D-04 pattern not byte-identical to September"
  - "Fixture check asserts the shared REDACTED substring (markers vary: [REDACTED], [REDACTED_PEM], [REDACTED_TSKEY])"
  - "password-env fixture uses DB_PASSWD (PGPASSWORD is claimed first by the password rule)"

patterns-established:
  - "Labelled RULES: every event-path rule carries a unique stable name; RedactionRuleName is derived from the table so tsc fails on missing fixtures"
  - "Runtime-assembled fixtures (rnd helper, split prefixes) so no literal token shape sits in git"

requirements-completed: []  # LANEB-06 stays open: later phase-18 plans still carry it; the orchestrator marks it through verification.

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Labelled 30-entry RULES table with D-04 entries and narrowed pk-rk in redact.ts; redactValue untouched"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact.test.ts#one fixture per named rule"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fixture corpus, coverage, counter-exemption, near-miss and narrowed pk-rk tests in redact.test.ts"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Secret-quarantine tests for private-tag, D-04 and digit-bearing pk- bodies in memory-classify.test.ts"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/memory-classify.test.ts#secrets"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-10-08
status: complete
---

# Phase 18 Plan 18-01: D-04 Event-Path Merge Summary

**September's 11 D-04 rules merged into main's labelled 30-entry redactor with the counter exemption intact; every rule proven by a runtime-assembled fixture and the widened memory quarantine pinned.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-10-08T22:52Z (approx)
- **Completed:** 2026-10-08T23:27:05Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- All 30 named rules present in September order (private-tag first, api-key-lower after assignment, aws/google/slack/npm/gitlab/digitalocean/openai-proj/pk-rk before jwt); pk-rk in the D18-21 narrowed digit-required form
- `RedactionRuleName` derived from the table and read-only `REDACTION_RULES` exported; `redact()` signature and output unchanged; `redactValue` block byte-untouched
- One runtime-assembled fixture per rule name (two digit-bearing bodies for pk-rk), each with four checks; coverage test fails when a rule name lacks a fixture; name-uniqueness asserted
- Counter exemption extended: counts survive while `{tokens: <D-04 fixture>}` and `api_key: "short"` redact whole
- Near-misses (15-char AKIA, short api_key, unclosed private tag, short pk-, short npm_, KEYBOARD_LAYOUT, MONKEY) survive; word-only `pk-fix-the-bug-in-store` / `rk-release-notes-for-october` survive while a digit-bearing `pk-lf-` key redacts
- Memory quarantine widened and pinned: private-tag, D-04-shaped and digit-bearing pk- bodies classify secret/unreleasable; prose and word-only slugs return null

## Task Commits

Each task was committed atomically:

1. **Task 1: Label RULES and insert the D-04 entries** - `5e984e6` (feat)
2. **Task 2: Fixture corpus, coverage, counter exemption and narrowed pk-rk tests** - `c6345b7` (test)
3. **Task 3: Memory-quarantine tests for the widened rules** - `bbfb7d0` (test)

## Files Created/Modified

- `packages/mcp-server/src/redact.ts` - RULES converted from tuples to labelled entries (name/pattern/replacement); 11 D-04 entries inserted at September positions; `RedactionRuleName` + `REDACTION_RULES` exported; loop destructures entries
- `packages/mcp-server/src/redact.test.ts` - `Record<RedactionRuleName, fixtures>` corpus, four checks per fixture, coverage + uniqueness, D-04 counter, near-miss + D18-21 slug tests; all pre-existing tests unchanged
- `packages/mcp-server/src/memory-classify.test.ts` - private-tag, D-04 AKIA, digit-bearing pk-lf- secret tests; prose + word-only-slug null tests; `memory-classify.ts` unmodified

## Decisions Made

- pk-rk ships in the D18-21 narrowed form (`\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}`), the only D-04 pattern not byte-identical to September — operator decision 2026-10-08, already folded into the plan.
- Fixture check 2 asserts the shared `REDACTED` substring rather than `[REDACTED]`, because pem/tailscale use `[REDACTED_PEM]` / `[REDACTED_TSKEY]` (test-side adjustment, not a redactor change).
- password-env fixture uses `DB_PASSWD=` (per 18-RESEARCH.md: `PGPASSWORD=` is claimed first by the `password` rule, so it cannot prove the password-env entry fires).
- Rule names follow the 18-RESEARCH.md inventory (`linear-api`/`linear-oauth`, `github`/`github-pat`, `password`/`password-env`, single `pk-rk` with two fixtures).

## Deviations from Plan

None - plan executed exactly as written. (The two test-side corrections above — substring assertion and DB_PASSWD choice — are the plan/research working as specified, not deviations: no redactor behavior was altered to satisfy a test.)

## Issues Encountered

- Initial `PUT >$:` append exposed a typo in my own tuple cast (`readonly RuleFixture[]}` missing `]`); fixed with a one-line edit, no plan impact.
- `bun test` on the three acceptance files shows 188 pass / 1 fail where the 1 fail is the pre-existing baseline failure (`no secrets in the repo > no tracked file assigns a substrate token a value`, offender is the phase planning doc `18-PATTERNS.md`, present before this plan). Not fixed per instructions; none of this plan's files offend. `bunx tsc --noEmit` clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 18-02 (skill pass) can build on `RedactionRuleName` and the event table: parity test compares skill `name`s against these 30 names.
- 18-03 (redaction lock) can type its detector prefix map as `Record<RedactionRuleName, …>`.
- No blockers. LANEB-06 intentionally left open for the later plans of this phase.

## Self-Check: PASSED

- `packages/mcp-server/src/redact.ts`, `redact.test.ts`, `memory-classify.test.ts` all present; 30/30 rule names with fixtures.
- Commits `5e984e6`, `c6345b7`, `bbfb7d0` verified in `git log`.
- Targeted suites: `redact.test.ts` 148 pass / 0 fail; `memory-classify.test.ts` 23 pass / 0 fail; three-file acceptance run 188 pass / 1 pre-existing fail; `bunx tsc --noEmit` clean.

---
*Phase: 18-guard-rails-and-shared-redactor*
*Completed: 2026-10-08*
