# 27-01 Baseline — execution base record

**Recorded:** 2026-10-09
**Branch:** `gsd/v1.3-p27-ledger-primitives` (PR cut from `main` after Phases 16 and 18 merge; HEAD history includes `Merge branch 'gsd/v1.3-p18-guard-rails into gsd/v1.3-int-17-18'`)
**HEAD at record time:** `4756b51 docs(27): record production schema probe and operator answers`

## Prerequisite presence (git-tracked, verified with `git ls-files` + `grep`)

| Prerequisite | Status | Evidence |
|---|---|---|
| `scripts/rehearsal.ts` (Phase 16 harness) | present | `git ls-files` lists it; imports `buildRehearsalEnv` (`:34`), writes `stores.env` (`:1181`) |
| `packages/mcp-server/src/rehearsal-env.ts` exporting `buildRehearsalEnv` | present | `git ls-files` lists it; `grep -c buildRehearsalEnv` = 2; `export function buildRehearsalEnv` at `:134`; `stores.env` record builder at `:186` |
| `stores.env` producer (harness `storesEnvRecord` → `writeMode(.../stores.env)`) | present | `scripts/rehearsal.ts:1181` + `rehearsal-env.ts:186` |
| `packages/mcp-server/src/redact-lock.test.ts` (Phase 18 lock) | present | `git ls-files` lists it |
| `packages/ledger/package.json` (`@substrate/ledger`, `main: src/index.ts`, root workspace) | present | `git ls-files` lists it; `src/` missing (`ls packages/ledger/src/` → NO_LEDGER_SRC) — this plan ports it |

No prerequisite is MISSING. Nothing is BLOCKED for the scratch proof; nothing faked or reconstructed. D27-18 fallback does not apply (production probe already DONE per 27-CONTEXT.md).

## Base suite numbers (dispatch baseline, this branch)

- `bun test`: **1605 pass / 57 skip / 1 fail** across 1663 tests in 54 files; the 1 failure is the known pre-existing flaky timing test `packages/audit/src/log.test.ts` "the scan does not go quadratic once the window is full" (out of scope, ignored per dispatch).
- `bunx tsc --noEmit`: clean.
- `bun run check:phase-close`: pass.

(STATE.md's older `ab62c91` figure — 1129 pass / 56 skip / 0 fail — predates the Phase 16/18 merges on this base; the numbers above are the current-base baseline the plan's verification compares against.)
