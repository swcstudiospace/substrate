---
phase: 21-skills-propose
plan: "01"
subsystem: api
tags: [git, gh, skills, config, bun-test, execFile]

# Dependency graph
requires:
  - phase: 16-rehearsal
    provides: rehearsal-env.ts buildRehearsalEnv and scripts/rehearsal.ts harness this phase's fixture builds on
  - phase: 17-events-audit
    provides: event-sources.ts skills.propose rows and policy.ts FAIL_CLOSED_TOOLS skills_propose entry
  - phase: 18-redaction
    provides: redact.ts redactSkillContent/scanSkillFiles and redact-lock.test.ts the engine imports
provides:
  - skills/propose.ts engine (validate, argv builders, locks, ledger, proposeSkill) with a SkillsLibrary seam
  - skills/frontmatter.ts SKILL.md frontmatter parser
  - SubstrateConfig.skills block with the file:// rule and boot warning
  - service.ts stores.skills seam defaulting to a proposer wired from config.skills
  - 21-BASELINE.md execution-base record
affects: [21-02-service-route-tool, 21-03-cli, 21-04-harness-smoke-docs]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 20327
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns: [pure argv builders plus injected Runner, constructor stores seam for subprocess-backed collaborators]

key-files:
  created:
    - packages/mcp-server/src/skills/propose.ts
    - packages/mcp-server/src/skills/frontmatter.ts
    - packages/mcp-server/src/skills/propose.test.ts
    - packages/mcp-server/src/skills/propose.git.test.ts
    - .planning/phases/21-skills-propose/21-BASELINE.md
  modified:
    - packages/mcp-server/src/config.ts
    - packages/mcp-server/src/config.test.ts
    - packages/mcp-server/src/service.ts

key-decisions:
  - "Service seam committed with Task 3 (config) rather than Task 2: the seam reads config.skills, so it compiles only after the skills block lands"
  - "createSkillProposer binds run, library and stateDir with per-call opts winning, keeping September's SkillProposer shape"
  - "childEnv and childBinary exported as test seams so the allowlist and gh mapping are pinned without stubbing execFile"

patterns-established:
  - "Engine tests use a fake Runner keyed by step name; real-git behavior is proven once in propose.git.test.ts"
  - "Credential-shaped fixtures are assembled at runtime from fragments, never written literally"

requirements-completed: [SKILL-01]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "Execution base holds Phase 16/17/18 deliverables; counts recorded in 21-BASELINE.md"
    requirement: "SKILL-01"
    verification:
      - kind: other
        ref: "test -f scripts/rehearsal.ts && grep -q redactSkillContent packages/mcp-server/src/redact.ts && grep -q buildRehearsalEnv packages/mcp-server/src/rehearsal-env.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Ported propose engine: validate, argv builders, locks, ledger, proposeSkill order, no force/colon-refspec/search argv"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/skills/propose.test.ts (64 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Engine against real git with fake gh: opened, branch present, all-zero-old-sha reflog"
    requirement: "SKILL-01"
    verification:
      - kind: integration
        ref: "packages/mcp-server/src/skills/propose.git.test.ts (2 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Config skills block: September defaults, file:// plus absolute-gh acceptance, invalid-combination problem, boot warning"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/config.test.ts SUBSTRATE_SKILLS_* describe (7 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "service.ts stores.skills seam wired from config.skills, inert until called"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/service.test.ts (95 tests)"
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-10-09
status: complete
---

# Phase 21 Plan 01: Engine Port Summary

**September's skill-proposal git/gh engine ported onto main's config model with a library seam, plus the skills config block and a recorded execution baseline.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-10-09T05:34:00Z
- **Completed:** 2026-10-09T05:48:40Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- 21-BASELINE.md records the execution base: every Phase 16/17/18 file and symbol present (including `skills_propose` already in `FAIL_CLOSED_TOOLS`), `bun test` 1605 pass / 57 skip / 1 fail (the known `log.test.ts` timing test), `tsc` clean.
- `skills/propose.ts` ports the 640-line September engine with only the planned changes: `SkillsLibrary` threading, `CLI_MAX_BYTES` deletion, allowlisted `childEnv` + `childBinary`-mapping `createExecFileRunner`, dropped `Refs SPE-2734` line, mirror-missing `ProposeFailed` with the 04-02 bootstrap text, configured slug in origin/PR-URL checks.
- `skills/frontmatter.ts` ported verbatim; `skills/propose.test.ts` (64 tests) keeps the fake Runner plus step-order and forbidden-flag pins and adds library, env-allowlist and missing-mirror cases; `skills/propose.git.test.ts` (2 tests) runs `proposeSkill` against real git with an in-process fake `gh`.
- `config.ts` gains the `skills` block with September defaults and the file:// rule; `configWarnings` reports the problem before the operator-tokens early return; `service.ts` gains the `stores.skills` seam wired from `config.skills`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Verify the execution base and record baseline numbers** - `44fb162` (docs)
2. **Task 2: Port the propose engine and frontmatter, wire the service seam** - `f52f2c2` (feat; service seam implementation moved to the Task 3 commit, see Deviations)
3. **Task 3: Add the skills block to config with the file:// rule** - `9672237` (feat; includes the service seam wiring)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified

- `packages/mcp-server/src/skills/propose.ts` - ProposeInput/Options/Status/Result, validateProposal, writeTree, argv builders, originMatches, prUrlOf, childEnv/childBinary/createExecFileRunner, locks, ledger, proposeSkill, createSkillProposer
- `packages/mcp-server/src/skills/frontmatter.ts` - parseFrontmatter (verbatim port)
- `packages/mcp-server/src/skills/propose.test.ts` - 64 unit tests over validation, tree, argv pins, ledger idempotence, locks, library, env, mirror, seam
- `packages/mcp-server/src/skills/propose.git.test.ts` - 2 real-git tests (opened + reflog, existing redelivery)
- `packages/mcp-server/src/config.ts` - skills block, DEFAULT_SKILLS_* constants, readSkills, skills boot warning
- `packages/mcp-server/src/config.test.ts` - SUBSTRATE_SKILLS_* describe (defaults, file:// acceptance, https/default-gh/relative-gh refusals, boot warning)
- `packages/mcp-server/src/service.ts` - stores.skills seam
- `.planning/phases/21-skills-propose/21-BASELINE.md` - base prerequisite record plus suite numbers

## Decisions Made

- Service seam committed with Task 3 rather than Task 2: the seam reads `config.skills`, which only exists after the Task 3 config edit, so committing it with Task 2 would have broken `tsc` mid-plan. Behavior is identical to the plan.
- `createSkillProposer({ run, library, stateDir })` binds all three with per-call options winning, keeping September's `SkillProposer` (`propose(input, opts: Omit<ProposeOptions, "run">)`) shape untouched.
- `childEnv` and `childBinary` exported as seams: the plan requires pinning the allowlist and the gh mapping without stubbing `execFile`, which needs named exports.
- Private single-expression `libraryOf` inlined at its two call sites per the project's no-tiny-functions rule.

## Deviations from Plan

### Process deviation (no behavior change)

**1. Service seam file moved from the Task 2 commit to the Task 3 commit**
- **Found during:** Task 2 (engine port)
- **Issue:** The plan lists `service.ts` under Task 2 files, but the seam's default reads `config.skills`, which Task 3 creates. Committing the seam with Task 2 would leave `tsc` red between commits.
- **Fix:** Task 2 commit holds the engine, frontmatter and both test files; the seam (`stores.skills` field, constructor param, `config.skills`-wired default, import) committed with Task 3's config change.
- **Files modified:** packages/mcp-server/src/service.ts
- **Verification:** `bunx tsc --noEmit` clean and `bun test ./packages/mcp-server/src/service.test.ts` 95 pass after the Task 3 commit.
- **Committed in:** 9672237 (Task 3 commit)

**2. [Rule 3 - Blocking] Tuple typing in propose.git.test.ts fixture**
- **Found during:** Task 2 (typecheck after writing the git test)
- **Issue:** `for (const [key, value] of [[...], ...])` infers `string[][]`, so destructured elements are `string | undefined` under `noUncheckedIndexedAccess`; `tsc` failed twice on the `git([...])` call.
- **Fix:** Annotated the literal `as Array<[string, string]>`.
- **Files modified:** packages/mcp-server/src/skills/propose.git.test.ts
- **Verification:** `bunx tsc --noEmit` exit 0.
- **Committed in:** f52f2c2 (Task 2 commit)

---

**Total deviations:** 2 (1 process ordering, 1 Rule 3 blocking fix)
**Impact on plan:** No behavior change; no scope creep. The engine, config and seam match the plan's must-haves.

## Threat Flags

None - every new surface was in the plan's threat model: argv builders carry no force flag, colon refspec or search query (pinned by tests); content scans run before any git call; child env is the four-key allowlist; non-default libraries require file:// plus an absolute non-default gh.

## Known Stubs

None - no stubs, placeholders, mocks in shipped code, or TODOs. (The fake Runner and fake gh live in test files only, as the plan requires; no test calls real `gh`.)

## Issues Encountered

- The `edit` tool's gap-insert anchoring twice split neighboring lines (config.ts audit field, tokenEnvName doc comment); both repaired immediately and verified by read-back plus `tsc`.
- One ported-test edit landed at wrong line numbers and broke the file; repaired and verified by the suite run (64 pass).

## Auth Gates

None - no authentication was required (isolated run: fake Runner, temp bare repos, no live GitHub, no trackers).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 02-04 can build on: `Substrate.skills.propose` seam (injectable via `stores.skills`), `config.skills` (repo, remoteUrl, stateDir, gh, problem), and the `21-BASELINE.md` numbers for comparison.
- Note for plan 02: the service-level `proposeSkill(input, caller)` method, the `config.skills.problem → ProposeFailed` refusal surfacing, route/tool/CLI wiring, and event emission are all still to come; this plan ships the engine and its configuration only.
- The full `bun test` suite was not re-run after the final commit (only targeted files plus `tsc`); the orchestrator runs the full suite after the wave. Base comparison: +84 tests (64 + 2 + 18... 64 includes frontmatter/validation suites; net new files), no regressions in touched neighbors (service 95 pass, both locks green).

---
*Phase: 21-skills-propose*
*Completed: 2026-10-09*

## Self-Check: PASSED

- All 9 created/modified files present on disk.
- All 3 task commits (44fb162, f52f2c2, 9672237) present in history.
- No stubs: the single `placeholder` grep hit is a pre-existing config.ts comment about short token strings.

## Amendment 2026-10-11 (user-selected: Keep current Git isolation)

- The user explicitly selected "Keep current Git isolation": the seven fixed Git controls already on main (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, two-entry `GIT_CONFIG_COUNT` selecting the `gh` credential helper, plus the two no-prompt flags alongside `PATH`/`HOME`) are retained. The "four-key allowlist" wording in this summary's Threat Flags and in 21-01-PLAN/21-CONTEXT now reads as four base forwarded keys plus seven controlled fixed Git values (never secrets); store/token/handoff values remain excluded. This is not permission to disable security or to accept residual supply-chain risk.
- Security-contract resolution: T-21-03 is reconciled by the recorded user decision above, not by removing hardening and not by certifying an exact four-key runtime. No historical proof metrics are replaced by this note (BASELINE/SUMMARY counts stand as historical).
