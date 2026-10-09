---
phase: 18-guard-rails-and-shared-redactor
plan: "18-03"
subsystem: security
tags: [redaction, repo-check, bun-test, laneb-06]

# Dependency graph
requires:
  - 18-01-labelled-RULES-table
  - 18-02-skill-engine
provides:
  - redactKnown known-value helper in redact.ts with migrated lessons.ts diagnostics
  - redact-lock.test.ts with four detectors, injected-seam companion and detector self-tests
affects: [18-04-docs-harness, skills_propose-21, docs_ingest-25, collectors-19]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 9800
  tasks: 3
  commits: 3

# Tech tracking
  added: []
  patterns: ["line-anchored import resolution against the importing directory", "pure (path, body) => Offender[] detectors with file:line rule reporting", "Record<RedactionRuleName, RegExp | null> detector map with source-coverage test", "runtime-assembled planted offenders so no literal shape sits in git"]

key-files:
  created: [packages/mcp-server/src/redact-lock.test.ts]
  modified: [packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts, packages/cli/src/lessons.ts]

key-decisions:
  - "openai detector spells the rule's negative lookahead literally (sk- plus (?-ant-) text) because a bare sk- with a left boundary cannot match the rule's own pattern source"
  - "lock walks the glob (tracked plus untracked sources) so a fresh second redactor cannot land uncommitted; extension/shebang filter runs before read so directory symlinks never throw EISDIR"
  - "rules 2-4 skip exactly the three injected-seam paths; rule 1 still applies to them"
  - "secretValues sort/filter kept in lessons.ts; redactKnown re-sorts, so the migration is behavior-identical"

patterns-established:
  - "Detector self-tests: one runtime-assembled offender per non-null DETECTOR entry plus an uncovered-list pin, so deleting a detector body fails the suite"
  - "Offenders reported as file:line rule, never the matched value"

requirements-completed: []  # LANEB-06 stays open: 18-04 still carries it; the orchestrator marks it through verification.

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "redactKnown helper in the shared module with lessons.ts migrated; diagnostics behavior unchanged"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact.test.ts#redactKnown"
        status: pass
      - kind: unit
        ref: "packages/cli/src/lessons.test.ts#lesson transport diagnostics"
        status: pass
    human_judgment: false
  - id: D2
    description: "Four-rule redaction lock green on the tree with injected-seam companion pins"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact-lock.test.ts#redaction lock"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every detector proven against planted offenders and non-offenders; a silent detector fails"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact-lock.test.ts#detector self-tests"
        status: pass
    human_judgment: false

# Metrics
duration: ~14min
completed: 2026-10-09
status: complete
---

# Phase 18 Plan 18-03: Shared Redactor Lock Summary

**Known-value scrubbing moved into the shared module and a four-rule repo lock fails `bun test` on any second redactor, with every detector proven against planted offenders.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-10-08T23:51:03Z
- **Completed:** 2026-10-09T00:05:00Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `redactKnown(text, values)` exported from `redact.ts`: longest value first, empty values ignored, `REDACTED` marker; `lessons.ts` diagnostics call it, keep the diagnosticUrl rewrite and the redact-before-cap return, and drop the `REDACTED` import
- `redact-lock.test.ts` (13 tests) locks the repo: rule 1 resolves every redactor import against the importing directory, rules 2–4 scan definitions/markers/credential-shape detectors, each asserting an offender list equal to `[]` on the tree
- `DETECTOR: Record<RedactionRuleName, RegExp | null>` covers all 30 rule names (20 prefixes, 10 contextual nulls); a coverage test asserts every non-null detector matches its own rule's pattern source, so `tsc` and the test both fail on an undecided new rule
- Injected-seam companion: audit log/record and observability otlp allowlisted with the cycle reason, skipped for rules 2–4 only; `new AuditLog(`/`new OtlpExporter(` sites equal `observe.ts` with the shared `redact` passed; no outside file calls `buildRecord`/`sanitizeField`/`argDigest`
- Self-tests: 5 rule-1 + 5 rule-2 + 2 rule-3 + 20 shape offenders all caught, all planted non-offenders (shared-module imports, Muse placeholder template, seam signatures, smoke decoy, division, comments) all pass; nulling a detector fails the suite (verified live)

## Task Commits

Each task was committed atomically:

1. **Task 1: redactKnown helper and the lessons.ts migration** - `52633cd` (feat)
2. **Task 2: The four lock rules plus the injected-seam companion** - `ea51ed6` (test)
3. **Task 3: Detector self-tests with planted offenders and non-offenders** - `784160b` (test)

## Files Created/Modified

- `packages/mcp-server/src/redact.ts` - `redactKnown` appended after `redactValue`, before the skill section; `redact()`/`redactValue()` untouched
- `packages/cli/src/lessons.ts` - diagnostic scrubber calls `redactKnown`; `REDACTED` import dropped (grep-confirmed unused); `secretValues` sort/filter kept so the migration is behavior-identical
- `packages/mcp-server/src/redact.test.ts` - `redactKnown` import plus three helper tests (longest-first, empty-ignored, idempotent with duplicates)
- `packages/mcp-server/src/redact-lock.test.ts` - new file: walk helpers copied from store-lock (never imported), four `(path, body) => Offender[]` detectors, seam companion, detector self-tests

## Decisions Made

- The research prototype's `openai` detector (`/(?<![A-Za-z0-9])sk-/`) cannot match its own rule's pattern source (`\bsk-(?!ant-)…`, where the character before `sk-` is the literal `b` of the `\b` escape), so the plan-mandated coverage test would fail. The shipped form is `/sk-\(\?!ant-\)|(?<![A-Za-z0-9])sk-/`: the first alternative matches the source spelling, the second catches hand-rolled `sk-` shapes while `task-graph`-style words stay quiet (see Deviations).
- Scope is the `{packages,scripts,infra}/**/*` glob (a superset of tracked sources, per the validated research prototype) so an uncommitted second redactor still fails; the extension/shebang filter runs before `read()` so directory symlinks never throw `EISDIR`.
- `INJECTED_SEAMS` skips rules 2–4 for exactly the three seam paths; rule 1 still scans them (they hold no redactor imports).
- `pk-rk` keeps a non-null detector (`/(?:pk|rk)-/` literal plus a bounded `[pr]k-` alternative): publishable keys are still credential-shaped in pattern position even though the rule itself is contextual.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Research prototype `openai` detector contradicts the plan's coverage test**
- **Found during:** Task 2 implementation (pre-run analysis against the `pattern.source` matching requirement)
- **Issue:** `/(?<![A-Za-z0-9])sk-/` never matches the source string `\bsk-(?!ant-)[A-Za-z0-9]{20,}` because the lookbehind sees the letter `b`
- **Fix:** Shipped `/sk-\(\?!ant-\)|(?<![A-Za-z0-9])sk-/`, which matches both the source spelling and hand-rolled `sk-` offenders
- **Files modified:** packages/mcp-server/src/redact-lock.test.ts
- **Verification:** `every non-null detector matches its own rule pattern source` passes; a hand-rolled `/sk-[A-Za-z0-9]{20,}/` planted offender is caught
- **Committed in:** ea51ed6 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — a research transcription corrected to meet the plan's own test).
**Impact on plan:** No scope change; the lock is stricter than the prototype in exactly the way the plan requires.

## Issues Encountered

- A planted end-to-end offender (scratch file with a bad import, a `redactSecrets` function, a `[REDACTED]` literal and a `ghp_` regex) failed all four rules as required, then was deleted; the tree was never committed with it.
- Assembling planted bodies needed template interpolation, not `+` inside string literals (the `+` stays literal text and the detector cannot fire on split shapes); six bodies were rewritten in that form before the Task 3 commit.
- One `Edit` patch with six hunks was rejected wholesale on tag staleness; re-issued as single-hunk edits. No committed state was ever affected.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 18-04 (docs + harness proof) can render the rule table from `REDACTION_RULES` names vs `SKILL_RULE_NAMES` plus the one exclusion, and document the lock's five rules from the lock header.
- Phases 19/21/22 inherit the lock with no exemptions: the Muse `__REDACT_MODULE__` placeholder template passes rule 1 (proven by a planted non-offender), and per D18-16 no advance exemption exists.
- No blockers. LANEB-06 intentionally left open for 18-04 (the shared-ID gate decides marking).
- Baseline deltas for the operator: targeted files `redact-lock` 13 pass, `redact` + `lessons` 233 pass, four-file acceptance run 263 pass / 1 pre-existing fail (`store-lock` vs `18-PATTERNS.md`, unchanged — the new file contributes zero trigger strings); `bunx tsc --noEmit` clean.

## Self-Check: PASSED

- All four touched files plus the SUMMARY exist on disk.
- Task commits `52633cd`, `ea51ed6`, `784160b` verified in `git log`.
- Targeted suites: `redact-lock` 13 pass; `redact` + `lessons` 233 pass; four-file acceptance run 263 pass / 1 pre-existing fail (`store-lock` vs `18-PATTERNS.md`, offender unchanged); `bunx tsc --noEmit` clean.
- store-lock.test.ts untouched (no diff); negative checks proven live (scratch offender fails all four rules; nulled detector fails the self-test; both reverted byte-clean).
---
*Phase: 18-guard-rails-and-shared-redactor*
*Completed: 2026-10-09*
