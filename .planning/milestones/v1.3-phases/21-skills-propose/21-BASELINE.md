# Phase 21 execution baseline (plan 21-01, Task 1)

**Recorded:** 2026-10-09
**Checkout:** worktree `agent-substrate-v13-p21` at `8174d8c`
**Status:** READY — every named prerequisite is present; no BLOCKED condition.

## Prerequisite files (all present)

| File | Present |
|------|---------|
| `scripts/rehearsal.ts` (Phase 16) | yes |
| `packages/mcp-server/src/rehearsal-env.ts` (Phase 16) | yes |
| `packages/mcp-server/src/event-sources.ts` (Phase 17) | yes |
| `packages/mcp-server/src/redact.ts` (Phase 18) | yes |
| `packages/mcp-server/src/redact-lock.test.ts` (Phase 18) | yes |
| `packages/audit/src/policy.ts` (Phase 17) | yes |
| `docs/event-vocabulary.md` (Phase 17) | yes |
| `docs/rehearsal.md` (Phase 16) | yes |

## Prerequisite symbols (all present)

| Symbol | Where | Present |
|--------|-------|---------|
| `buildRehearsalEnv` | `packages/mcp-server/src/rehearsal-env.ts` | yes (exported function) |
| `EVENT_SOURCES` with `skills.propose` row (id at event-sources.ts:137) | `packages/mcp-server/src/event-sources.ts` | yes |
| `EVENT_SOURCES` with `skills.propose.refused` row (id at event-sources.ts:160) | `packages/mcp-server/src/event-sources.ts` | yes |
| `redactSkillContent` | `packages/mcp-server/src/redact.ts` | yes (exported function) |
| `scanSkillFiles` | `packages/mcp-server/src/redact.ts` | yes (exported function) |
| `SkillDocExampleRule` (`"pem" \| "jwt"`) | `packages/mcp-server/src/redact.ts` | yes |
| `SkillFileHit` (`{ file, line, rule }`) | `packages/mcp-server/src/redact.ts` | yes |
| `skills_propose` in `FAIL_CLOSED_TOOLS` | `packages/audit/src/policy.ts` | yes (already listed; per D21-18 the route/registration plan adds it only if absent, so nothing to do) |
| `skills.propose` / `skills.propose.refused` rows | `docs/event-vocabulary.md` | yes (lines 61-62) |

`bun test: 1605 pass, 57 skip, 1 fail (the 1 fail is the known packages/audit/src/log.test.ts timing test); tsc: clean (exit 0).`

## Base suite numbers (re-measured at HEAD `8174d8c`)

- `bun test`: **1605 pass / 57 skip / 1 fail** across 54 files, 1663 tests (92 s)
  - The single failure is the known pre-existing timing test in `packages/audit/src/log.test.ts`
    ("the scan does not go quadratic once the window is full", 5 s timeout at 78485 ms).
    Recorded, not fixed, per D21-23.
- `bunx tsc --noEmit`: **clean (exit 0)**.

## Decision

No prerequisite file or symbol is missing: **no BLOCKED state**. Tasks 2-3 proceed on this base.
