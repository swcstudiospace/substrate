---
phase: 20-production-identity-and-phase-0-uat
plan: "05"
subsystem: cross-repo
tags: [ultrathink-kickoff, graph-register, mcp-entry, token-resolution, local-only-branch]

# Dependency graph
requires:
  - phase: 20-production-identity-and-phase-0-uat
    provides: "plan 20-02 client-side bearer order (env, token-file, tokens-dir) mirrored in the clone"
provides:
  - "Deterministic graph registration (`registerGraph`) wired through ultrathink-kickoff"
  - "Opt-in user-scope substrate MCP entry writer (`--substrate`) with headers helper"
  - "Shared token resolution in `brief.ts` matching the agent-substrate order"
affects: [20-06-live-window, production-uat-scenario-5]

# Actuals — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 5800
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-args-builder-plus-fail-open-caller, stdout-only-headers-helper]

:key-files:
  created: [/root/src/worktrees/claude-ultrathink-p20/src/substrate/register.ts]
  modified: [/root/src/worktrees/claude-ultrathink-p20/src/substrate/brief.ts, /root/src/worktrees/claude-ultrathink-p20/src/mcp/cli.ts, /root/src/worktrees/claude-ultrathink-p20/scripts/mcp-register.ts]

:key-decisions:
  - "Fresh clone cut from upstream origin/main ed3243e; operator checkout never written"
  - "Branch committed locally only; push and PR wait for operator approval (D20-20)"
  - "Only server-schema fields are sent; prime-agent omits surface"

requirements-completed: [UAT-03]

# Coverage metadata — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "register.ts pure args builder plus fail-open registerGraph; brief.ts shared resolver"
    requirement: "UAT-03"
    verification:
      - kind: unit
        ref: "/root/src/worktrees/claude-ultrathink-p20/src/substrate/register.test.ts plus brief.test.ts (45 pass / 0 fail)"
        status: pass
    human_judgment: false
  - id: D2
    description: "substrate register/headers subcommands plus --substrate entry writer, skill and docs"
    requirement: "UAT-03"
    verification:
      - kind: unit
        ref: "/root/src/worktrees/claude-ultrathink-p20/src/mcp/cli.test.ts plus scripts/mcp-register.test.ts (114 pass / 0 fail)"
        status: pass
    human_judgment: false

# Metrics
duration: single-session
completed: 2026-10-09
status: complete
---

# Phase 20 plan 05: claude-ultrathink registration and MCP entry Summary

**Deterministic graph registration through `graph_register`, shared token resolution, and the opt-in Claude Code substrate entry — built in a fresh clone on a local-only branch**

## Performance

- **Duration:** single agent session
- **Started:** 2026-10-09
- **Completed:** 2026-10-09
- **Tasks:** 2
- **Files modified:** 10 (clone-local) plus this summary (agent-substrate worktree)

## Accomplishments

- `src/substrate/register.ts` in the fresh clone: pure `buildRegisterArgs` restricted to `graph_register` schema fields (surface only for substrate hosts, so prime-agent is omitted) plus fail-open `registerGraph` over plain HTTP MCP with both accept types, JSON-or-last-SSE-frame parse, tool-error as failed, redacted status-words-only detail
- `src/substrate/brief.ts` shares the resolution order (env, token-file variable, tokens-dir per-surface file; unsafe surfaces never read) with both callers passing the input surface
- `substrate register` / `substrate headers` subcommands in `src/mcp/cli.ts` (usage errors stay exit 2; skipped/failed paths exit 0; headers stdout-only always 0), seam-wired so `trackComplete` registers after the write when status is not failed
- `--substrate` flag in `scripts/mcp-register.ts` (Claude host only, never default; remove-plus-add-json user-scope http entry with static token-variable header and `<clone>/bin/ultrathink-mcp substrate headers` helper; helper-suffix ownership; backup/dry-run reuse)
- Rewritten `skills/ultrathink-kickoff/SKILL.md` step 3 (command first, schema-only MCP fallback) and doc updates (configuration, privacy, register-mcp-gateway, README, CHANGELOG Unreleased)

## Task Commits

Clone-local branch `gsd/v1.3-p20-identity-uat` in `/root/src/worktrees/claude-ultrathink-p20` (from upstream `origin/main` `ed3243e`); no remote write, no PR:

1. **Task 1: Clone plus registration module and token resolution** — commit `978ce72 feat(20-05)`
2. **Task 2: CLI commands, entry writer, skill and docs** — commit `9006476 test(20-05)`

## Files Created/Modified (all clone-local)

- `src/substrate/register.ts` (new) plus `src/substrate/register.test.ts` (new)
- `src/substrate/brief.ts`, `src/substrate/brief.test.ts` — shared resolver
- `src/mcp/cli.ts`, `src/mcp/cli.test.ts` — both subcommands plus seam
- `scripts/mcp-register.ts`, `scripts/mcp-register.test.ts` — `--substrate` entry writer
- `skills/ultrathink-kickoff/SKILL.md`, `docs/configuration.md`, `docs/privacy.md`, `docs/how-to/register-mcp-gateway.md`, `README.md`, `CHANGELOG.md`

## Decisions Made

- Clone cut at the plan-pinned upstream commit `ed3243e`, never writing the operator checkout
- `bun install` run inside the clone (gitignored `node_modules`) to satisfy tsc's bun types; no dependency changes
- Branch carries no upstream tracking reference (`git status -sb` shows the bare branch name), proving local-only; push and PR explicitly left for the operator per D20-20

## Deviations from Plan

None. Tasks 1–2 executed exactly as specified.

## Issues Encountered

None blocking. All clone-local suites green on first verification pass after implementation.

## Evidence

- `bun test src/substrate/register.test.ts src/substrate/brief.test.ts` (run from the clone dir) → **45 pass, 0 fail**
- `bun test src/mcp/cli.test.ts scripts/mcp-register.test.ts` (run from the clone dir) → **114 pass, 0 fail**
- `bun run check` (tsc --noEmit) in the clone → clean
- `git status -sb` in the clone → `## gsd/v1.3-p20-identity-uat` with no upstream, no remote write
- Agent-substrate worktree files never written by this slice (read-only refs to `mcp.ts` and `token.ts` only)

## Recovery evidence recorded 2026-10-11

The original 2026-10-09 implementation, commits and verification counts
above are historical and unchanged. The parent restored the cross-repo
worktree `/root/src/worktrees/claude-ultrathink-p20` on local branch
`gsd/v1.3-p20-identity-uat` at **`9006476`** and supplied
`local://v13-phase20-recovered-client-evidence.json`:

- Frozen dependency installation exited **0**.
- The four targeted files (`src/substrate/register.test.ts`,
  `src/substrate/brief.test.ts`, `src/mcp/cli.test.ts`,
  `scripts/mcp-register.test.ts`) reported **159 pass / 0 fail**, exit 0,
  with the production token directory masked; typecheck exited **0**.
- **Actual scratch MCP**, not mocked fetch: registration ran twice,
  both exit 0, then graph `ut-p20-295d4559` read back with surface
  `claude-code`, node `n1` and step `n1/1`, with no duplicate nodes/steps.
- A wrong bearer returned **HTTP 401** while the fail-open register CLI
  still exited 0. Disabled integration reported skipped. Acceptance must
  therefore require the actual `substrate: registered <graphId>` line
  **and** graph readback, not the CLI exit alone.

This recovery is source/scratch evidence only. Remote push, draft PR,
reviewed main landing, stable checkout update and installed-plugin refresh
are **not done**. No host config, hook installation, production token
provisioning/rotation or production UAT was performed by this recovery.
The summary's historical `requirements-completed: [UAT-03]` records the
20-05 implementation slice, not 20-06 production acceptance or Phase 20
completion.

The new operator packet is in
[production identity](../../../docs/runbooks/production-identity.md).
The three human actions in
[20-06](20-06-SUMMARY.md) remain **operator-blocked, completed 0/3**.
An unsafe pre-existing CLI test previously exposed the actual Cursor
substrate credential; fixture isolation is not production revocation.
The operator must rotate/revoke it in an approved two-restart list-form
window. An earlier decision declining rotation does not cover this new
incident. No credential value is reproduced here.

This documentation slice read source/evidence only and ran no tests,
scripts, formatters, network calls or runtime checks; verification above
is the parent's observed recovery evidence, not a new child run.

## User Setup Required

- Operator approval for cross-repo branch delivery and a **draft** upstream PR; Desk Quality / Programming Lead Greptile gate and human-approved main landing precede stable checkout/plugin refresh (20-06 Task 2 — NOT done). FAILED, SKIPPED or unavailable review is a blocker, never merge-ready. No agent merge, auto-merge or main push is authorized.

## Next Phase Readiness

- Scenario 5 kickoff registration path is implemented and unit-proven; production proof (real kickoff, entry writer run, plugin refresh) waits for the operator-approved 20-06 live window
- No production switch-on was run; no live-system action taken

---
*Phase: 20-production-identity-and-phase-0-uat, plan 05*
*Completed: 2026-10-09*
