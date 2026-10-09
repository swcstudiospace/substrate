---
phase: 20-production-identity-and-phase-0-uat
plan: "01"
subsystem: auth
tags: [surface-tokens, boot-refusal, EX_CONFIG, systemd, bun-test]

# Dependency graph
requires:
  - phase: 17-host-job-surface
    provides: "`substrate` surface in SURFACES and its token binding, which tokenConfig validates against"
provides:
  - "List-form `SUBSTRATE_TOKEN_*` parsing (`tokenConfig`) with names-only `ConfigError`"
  - "Boot refusal in `index.ts` (exit 78) plus `RestartPreventExitStatus=78` in the unit"
  - "Subprocess proof (`boot-refusal.test.ts`) that refusal precedes stores and leaks no value"
  - "Corrected `.env.example` and doc token-variable names (only the grok-bot variable)"
affects: [20-02-client-bearer, 20-identity-check, production-identity-runbook, phase-16-parity]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 6200
  tasks: 3
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-env-validator-throwing-names-only-ConfigError, allowlisted-env-subprocess-boot-test]

key-files:
  created: [packages/mcp-server/src/boot-refusal.test.ts]
  modified: [packages/mcp-server/src/config.ts, packages/mcp-server/src/index.ts, packages/mcp-server/src/authority.test.ts, packages/mcp-server/src/server.authority.test.ts, .env.example, infra/vps/substrate-mcp.service]

key-decisions:
  - "tokenConfig splits on commas AND whitespace with no minimum-length filter, so short fixtures keep working"
  - "Refusal is exit 78 (EX_CONFIG) with one `[substrate] refused — …` stderr line naming variables only"
  - "Swarm token variables stay single-valued; only multi-client non-swarm surfaces hold lists"

patterns-established:
  - "Boot-test spawning uses the no-env-file server argv with an allowlisted env (PATH, HOME, BUN_* plus case vars), never inheriting the developer process env"
  - "Every names-only error/message in this area is covered by a value-absent assertion on combined output"

requirements-completed: [FOUND-04]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "tokenConfig(env) and ConfigError exported from config.ts; loadConfig calls tokenConfig once; readTokens gone"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/authority.test.ts#a surface token variable holds a list"
        status: pass
    human_judgment: false
  - id: D2
    description: "Each list entry resolves to its surface over HTTP; the whole comma-joined string as one bearer is 401"
    requirement: "FOUND-04"
    verification:
      - kind: integration
        ref: "packages/mcp-server/src/server.authority.test.ts#a list entry authenticates over the wire"
        status: pass
    human_judgment: false
  - id: D3
    description: "Contradictory identity config refuses boot with exit 78 and names-only stderr before any store is touched"
    requirement: "FOUND-04"
    verification:
      - kind: integration
        ref: "packages/mcp-server/src/boot-refusal.test.ts#a contradictory identity config refuses boot"
        status: pass
    human_judgment: false
  - id: D4
    description: "RestartPreventExitStatus=78 in the unit so a refused config stops instead of crash-looping"
    requirement: "FOUND-04"
    verification:
      - kind: other
        ref: "infra/vps/substrate-mcp.service#RestartPreventExitStatus=78 (verified present post-edit; bun test store-lock green)"
        status: pass
    human_judgment: false
  - id: D5
    description: ".env.example in list form with blank codex/opencode/pi entries, no gateway variable; docs name only the grok-bot variable"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/authority.test.ts#.env.example lists a blank SUBSTRATE_TOKEN_* line for every one"
        status: pass
    human_judgment: false

# Metrics
duration: single-session
completed: 2026-10-09
status: complete
---

# Phase 20 plan 01: Production identity boot refusal Summary

**List-form surface tokens with a names-only boot refusal: `tokenConfig` plus `ConfigError` in config.ts, exit-78 refusal in index.ts, subprocess proof, and corrected env/docs**

## Performance

- **Duration:** single agent session
- **Started:** 2026-10-09
- **Completed:** 2026-10-09
- **Tasks:** 3
- **Files modified:** 12 (5 code/test, 7 env/unit/docs, plus this summary)

## Accomplishments

- `tokenConfig(env)` parses every `SUBSTRATE_TOKEN_*` variable as a comma/whitespace-separated list, validates each suffix against `SURFACES`, and throws `ConfigError` naming variables only on cross-surface duplicates or unknown suffixes
- Boot refuses contradictory identity with one `[substrate] refused — …` stderr line and exit 78, before any store is touched; the unit carries `RestartPreventExitStatus=78`
- `boot-refusal.test.ts` proves exit 78, both variable names on stderr, and the fixture value absent from combined output, with an allowlisted env and the no-env-file server argv
- `.env.example` is list-form with blank codex/opencode/pi entries and no gateway variable; docs name only the grok-bot variable

## Task Commits

All three tasks plus this summary in one atomic commit:

1. **Task 1: List-form token validator in config.ts** — commit `feat(20-01)` (below)
2. **Task 2: Authority test coverage plus boot-refusal test** — same commit
3. **Task 3: Boot refusal wiring, unit guard, env example and doc corrections** — same commit

## Files Created/Modified

- `packages/mcp-server/src/config.ts` — `ConfigError` plus pure `tokenConfig`; `loadConfig` calls it once; `readTokens` gone
- `packages/mcp-server/src/index.ts` — try/catch around `loadConfig`: `ConfigError` writes the refused line and exits 78, anything else rethrown; header comment gains the one exception
- `packages/mcp-server/src/authority.test.ts` — appended list-form describe (7 tests); env-example lock extended to every surface in `SURFACES`
- `packages/mcp-server/src/server.authority.test.ts` — hermes fixture holds a two-value list; new describe proves the second value gets 202 as hermes and the joined string gets 401
- `packages/mcp-server/src/boot-refusal.test.ts` — new subprocess refusal proof plus valid-boot guard
- `.env.example` — list-form comment, gateway line dropped with meaning moved onto the grok-bot variable, blank codex/opencode/pi, swarm single-valued note, operator extra claude-code entry note
- `infra/vps/substrate-mcp.service` — `RestartPreventExitStatus=78` after `RestartSec` with file-style comment; Phase 16 guard untouched
- `docs/coordination.md`, `docs/grok-bot.md`, `docs/swarm-workspace.md`, `docs/memory-governance.md`, `.planning/PROJECT.md` — one-line-scale corrections each

## Decisions Made

- No minimum-length filter in `tokenConfig` (unlike `readReviewTokens`): fixtures use short values, and length is not this validator's job
- Duplicate detection keys on the value with a first-variable index, so the error names both variables while the value itself never appears
- `docs/lessons-bank.md` intentionally unchanged: it names no wrong variable, and its CLI sentence belongs to sibling slice 20-02

## Deviations from Plan

### Auto-fixed Issues

**1. [Project rule ts-no-tiny-functions] Inlined the single-use suffix helper**
- **Found during:** Task 1 (tokenConfig implementation)
- **Issue:** Keeping `envSuffixToSurface` as a one-expression wrapper with a single call site violates the repo rule
- **Fix:** Inlined the lowercase/underscore mapping into `tokenConfig`; the `SURFACES` membership throw is the validation, the single `as Surface` cast sits at the map insert
- **Files modified:** packages/mcp-server/src/config.ts
- **Verification:** `bunx tsc --noEmit` clean, authority suite green
- **Committed in:** feat(20-01) commit (below)

**2. [20-PATTERNS.md lock precedent] Extended the .env.example lock to every surface**
- **Found during:** Task 3 (env example)
- **Issue:** The existing lock only pinned swarm plus substrate, leaving the new codex/opencode/pi lines unguarded
- **Fix:** Loop target changed from `[...SWARM_SURFACES, "substrate"]` to `SURFACES`; no count pin touched
- **Files modified:** packages/mcp-server/src/authority.test.ts
- **Verification:** lock test passes against the reworked example (27 blank lines)
- **Committed in:** feat(20-01) commit (below)

---

**Total deviations:** 2 auto-fixed (1 repo-rule compliance, 1 pattern-directed guard)
**Impact on plan:** Both tighten the change with no scope creep; PLAN remains the authority and is fully executed.

## Issues Encountered

- An edit range slip dropped `SUBSTRATE_TOKEN_CURSOR` from the server.authority fixture; the existing operator tests failed immediately, the line was restored, suite green. No plan impact.
- A doc edit duplicated three paragraph lines in coordination.md; caught in `git diff` review before verification, restored plus the new sentence. No plan impact.

## Evidence

- `bun test packages/mcp-server/src/authority.test.ts packages/mcp-server/src/server.authority.test.ts packages/mcp-server/src/boot-refusal.test.ts packages/mcp-server/src/store-lock.test.ts` → **87 pass, 0 fail, 310 expect() calls**
- `bunx tsc --noEmit` → clean
- `git grep SUBSTRATE_TOKEN_DESK_GATEWAY` outside planning history → only test fixtures exercising the refusal plus pattern/research records (no live config, example, or doc names it)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Server side of FOUND-04 is done: any plan can rely on `tokenConfig` lists, the exit-78 refusal, and the grok-bot-only variable naming
- Operator live steps (token provisioning, restart, evidence) stay operator-approved and untouched — no production switch-on was run
- Sibling slice files (`packages/cli/**`, `packages/collectors/**`, `scripts/parity-check.ts`) untouched; branch HEAD already holds sibling `feat(20-02)` commit, no conflicts with this slice's files

---
*Phase: 20-production-identity-and-phase-0-uat, plan 01*
*Completed: 2026-10-09*
