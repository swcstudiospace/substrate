---
phase: 18-guard-rails-and-shared-redactor
plan: "18-02"
subsystem: security
tags: [redaction, skill-scan, parity, bun-test, laneb-06]

# Dependency graph
requires:
  - 18-01-labelled-RULES-table
provides:
  - Skill engine (SKILL_RULES, redactSkillContent, scanSkillFiles, SKILL_EXCLUSIONS, SKILL_RULE_NAMES) in redact.ts
  - September skill suite plus placeholder, D18-21 skill and parity tests in redact.test.ts
affects: [18-03-redaction-lock, 18-04-docs-harness, skills_propose-21, docs_ingest-25]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 5200
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: ["skill entries carry name (RedactionRuleName, for parity) beside rule (reported family)", "namespace-import scan test pinning scanSkillFiles as the only exported scan"]

key-files:
  created: []
  modified: [packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts]

key-decisions:
  - "pk-rk is a contextual skill redaction (not a finding): digit-bearing pk-lf- keys redact as pk-rk, word-only slugs are kept"
  - "api-key-lower skill entry uses a 3-group pattern (value index 3) with [ \\t] line-local whitespace"
  - "Skill test fixtures reuse the file's rnd() assembly (September's repeat-literals converted) so no literal token shape sits in git"

patterns-established:
  - "Parity: REDACTION_RULES names minus SKILL_RULE_NAMES minus SKILL_EXCLUSIONS keys equals []; exclusions typed Partial<Record<RedactionRuleName, string>>"
  - "Export-surface scan test: Object.keys(redactModule).filter(/^scan/i) equals [scanSkillFiles]"

requirements-completed: []  # LANEB-06 stays open: later phase-18 plans still carry it; the orchestrator marks it through verification.

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Skill engine in the shared module: 29 named SKILL_RULES entries, 16 high-confidence rules, exclusions and skill-name exports"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact.test.ts#event/skill parity"
        status: pass
    human_judgment: false
  - id: D2
    description: "September skill suite ported with six new finding samples; placeholder, D18-21 skill and liberal-event tests"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/redact.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: ~40min
completed: 2026-10-08
status: complete
---

# Phase 18 Plan 18-02: Skill Engine Port Summary

**September's skill-content engine lives in the shared redactor with the 9 D-04 skill entries, placeholder handling intact, and a parity test that fails the build when the two passes drift.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-10-08
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `SKILL_HIGH_CONFIDENCE_RULES` holds aws plus google, slack, npm, gitlab, digitalocean and openai-proj (16 rules); all six new shapes report findings
- All 29 `SKILL_RULES` entries carry `name` (a `RedactionRuleName`) beside the reported `rule` family, so `github` still covers both GitHub shapes, `assignment` three and `password` two — hit output byte-identical to September
- New entries at the specified positions: six high-confidence plus private-tag and pk-rk immediately after aws; api-key-lower immediately after the third assignment entry; pk-rk in the D18-21 narrowed digit-required form with `dg` flags
- `SKILL_EXCLUSIONS` holds exactly one key, keypair-array, with a reason string; `SKILL_RULE_NAMES` exported read-only
- Placeholder values survive with nothing reported (`api_key: $OPENAI_API_KEY`, `apiKey: <your-key>`, `api_key: your-api-key-goes-here`); a real api_key value redacts as api-key-lower; a private-tag block holding a GitHub token reports the github finding with the rest of the block intact
- Word-only `pk-fix-the-bug-in-store` / `rk-release-notes-for-october` produce no hit in `redactSkillContent` and `scanSkillFiles`; a digit-bearing `pk-lf-` key redacts as pk-rk
- Event redactor stays liberal (`Authorization: Bearer $PARALLEL_API_KEY` rewritten by `redact()`, kept by the skill pass)
- Parity test fails on any event rule name without a same-name skill rule or exclusion; namespace test pins `scanSkillFiles` as the only exported scan
- `redact()` and `redactValue()` bodies unchanged (Task 1 diff: 202 insertions, 0 deletions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Port the skill engine and add the 9 D-04 skill entries** - `4bd44f0` (feat)
2. **Task 2: Skill tests, placeholder behaviour and the parity test** - `49b0c05` (test)

## Files Created/Modified

- `packages/mcp-server/src/redact.ts` - skill engine appended after `redactValue`: `SkillRedactionRule` (+9 members), `SKILL_HIGH_CONFIDENCE_RULES` (+6), hit/option types, named `SkillRule` interface, 29-entry `SKILL_RULES`, `SKILL_EXCLUSIONS`, `SKILL_RULE_NAMES`, placeholder logic, `redactSkillContent`, `scanSkillFiles`
- `packages/mcp-server/src/redact.test.ts` - all September skill describes ported with `rnd()`-assembled fixtures, extended high-confidence sample map, doc-example / line-number / scan tests, api-key-lower placeholder tests, private-tag-over-github test, D18-21 skill tests, parity tests, exported-scan test, liberal-event test

## Decisions Made

- pk-rk is a contextual skill **redaction**, not a finding: the plan's "a digit-bearing pk-lf- key is redacted" means the `redactions` bucket (my first test draft asserted `findings` and failed; the engine was right per D18-08).
- api-key-lower skill entry uses the research-recommended 3-group form (`\b(api[_-]?key)([ \t]*[:=][ \t]*["']?)([…]{16,})`, value index 3) so only the value span is replaced and the key plus separator survive.
- September's repeat-literal fixtures (`"A1b2".repeat(10)`, `"Q9w8".repeat(12)`) kept where already runtime-assembled; literal shapes (`GITHUB`, `PEM`, `JWT`, `abcdef123456`, `DB_TOKEN=abc123def456`) converted to `rnd()` assembly per the no-literal-shapes rule; behavior-neutral.
- The dropped `bun:test` import in my first import edit broke `tsc` (166 diagnostics); restored immediately — test-side slip, no redactor impact.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] pk-rk skill test asserted the wrong bucket**
- **Found during:** Task 2 verification run (169 pass / 1 fail)
- **Issue:** Test expected the digit-bearing `pk-lf-` key in `findings`; the engine reports it in `redactions` because pk-rk is contextual, not high-confidence
- **Fix:** Corrected the test to expect `redactions: [{ line: 1, rule: "pk-rk" }]`; renamed the test from "finding" to "redaction"
- **Files modified:** packages/mcp-server/src/redact.test.ts
- **Commit:** 49b0c05

**2. [Rule 1 - Bug] Import edit dropped the `bun:test` import**
- **Found during:** Task 2 verification (`bunx tsc --noEmit` exit 2, 166 diagnostics)
- **Issue:** Replacing the import block removed `import { describe, expect, test } from "bun:test"`
- **Fix:** Re-added the import on line 1
- **Files modified:** packages/mcp-server/src/redact.test.ts
- **Commit:** 49b0c05

## Issues Encountered

- First `Edit` append to `redact.ts` doubled the `+` patch prefix and no longer parsed; removed the whole appended block (verified via re-read ranges) and re-appended in three smaller chunks with the correct single-`+` format. No redactor behavior was at risk: the bad block never compiled and was cut before any commit.
- `bun test packages/mcp-server/src/store-lock.test.ts` shows 17 pass / 1 fail where the 1 fail is the pre-existing baseline failure (`no tracked file assigns a substrate token a value`, sole offender the phase planning doc `18-PATTERNS.md`). Not fixed per instructions; none of this plan's files offend. `bunx tsc --noEmit` clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 18-03 (redaction lock) can type its detector prefix map as `Record<RedactionRuleName, …>` and rely on `scanSkillFiles` being the only exported scan.
- 18-04 (docs) can render the two-column rule table from `REDACTION_RULES` names vs `SKILL_RULE_NAMES` plus the one exclusion.
- No blockers. LANEB-06 intentionally left open for the later plans of this phase.

## Self-Check: PASSED

- `packages/mcp-server/src/redact.ts` (340 lines, 29 skill entries, 16 high-confidence rules, 1 exclusion) and `redact.test.ts` (545 lines) present.
- Commits `4bd44f0`, `49b0c05` verified in `git log`.
- Targeted suites: `redact.test.ts` 170 pass / 0 fail; `redact.test.ts` + `memory-classify.test.ts` 193 pass / 0 fail; `store-lock.test.ts` 17 pass / 1 pre-existing fail (18-PATTERNS.md only); `bunx tsc --noEmit` clean.
- Parity negative-checked both ways: removing the npm entry reports `["npm"]`; dropping the exclusion reports `["keypair-array"]`.

---
*Phase: 18-guard-rails-and-shared-redactor*
*Completed: 2026-10-08*
