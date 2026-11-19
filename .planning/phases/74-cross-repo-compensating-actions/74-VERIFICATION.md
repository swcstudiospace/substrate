---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 3/3 success criteria verified in code at HEAD ee998735; operator/live sign-off outstanding
behavior_unverified: 0
overrides_applied: 0
covered_files:
  - .planning/ROADMAP.md
  - packages/mcp-server/src/cross-repo-ops.ts
  - packages/mcp-server/src/cross-repo-store.ts
  - packages/mcp-server/src/cross-repo-ops.test.ts
  - packages/mcp-server/src/cross-repo-ops.testkit.ts
  - packages/mcp-server/src/cross-repo-ops.pg.test.ts
  - packages/mcp-server/src/cross-repo.routes.test.ts
  - packages/mcp-server/src/repo-scope.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/service.ts
human_verification:
  - test: "Owner/live gate re-run and sign-off on this line (tsc --noEmit, Biome, affected cross-repo test files with live PostgreSQL)."
    expected: "Gate green on HEAD ee998735 and owner sign-off recorded here, as ROADMAP.md Phase 74 requires ('human sign-off pending')."
    why_human: "This verification pass was instructed not to run tests, tsc, Biome, or formatters. Code inspection confirms the implementation; it does not substitute for the live gate run or the owner sign-off."
  - test: "Confirm production runs one mcp-server driver per index database, or decide on a cross-process guard (lease/owner column on cross_repo_steps)."
    expected: "Either one driver per Postgres index, or a cross-process guard. Today the one-driver-per-key guarantee is the in-process KeyedLock (cross-repo-ops.ts:242,261), and the resume-from-applying rule assumes it."
    why_human: "Depends on production replica count, which the code does not show. moveStep is a compare-and-set, so cross-process races cannot double-apply, but the recovery rule is only sound with one driver."
  - test: "Owner confirm of the default surface policy: with SUBSTRATE_REPO_SCOPES unset, repo-scope.ts grants every authenticated surface every registered repository, so any authenticated surface can fan-out/compensate across all registered repos."
    expected: "Owner confirms that default for cross-repo writes, or requires SUBSTRATE_REPO_SCOPES set (enforcement on) wherever cross-repo writes run."
    why_human: "Policy choice, not a code defect. ROADMAP.md Phase 74 records it as open for the owner."
---

# Phase 74: Cross-repo compensating actions: Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Verified:** 2026-11-19 (re-verification at HEAD `ee998735`, branch `gsd/autonomous-rerun`)
**Status:** human_needed
**Re-verification:** Yes. Prior record verified at `357d6b15` (status human_needed, 3/3). This pass re-inspects the implementation at current HEAD and checks for drift.

**Drift check:** `git diff 357d6b15..HEAD` over the cross-repo implementation (`cross-repo-ops.ts`, `cross-repo-store.ts`, `cross-repo-ops.test.ts`, `cross-repo-ops.testkit.ts`, `repo-scope.ts`) is empty. The only touched file is `cross-repo.routes.test.ts` (5 lines, cosmetic env-token helper in test setup, no behavior change). Implementation evidence below is therefore unchanged from the prior pass.

**Scope / method:** Code inspection only. Per assignment constraints, no tests, tsc, Biome, knip, or formatters were run in this pass; no test results are claimed here. Named tests cited below were read in the test files at HEAD.

## Goal Achievement

### Success Criterion 1: operation across >=2 registered repositories, state persisted before effects, stable dedupe keys, idempotent per-step retry — VERIFIED in code

- `cross-repo-ops.ts:193` `fingerprintOf` (SHA-256 over branch + sorted repo/base pairs); `fanout` (~441) refuses `key-reused` on fingerprint mismatch.
- `cross-repo-store.ts:77-102` `create`: operation row + `pending` steps in one transaction, `on conflict do nothing` — state persisted before any git effect.
- `cross-repo-ops.ts:278` `applyStep`: `pending`→`applying` recorded before `update-ref` create-only (line ~296, `<planned> <zero>` CAS); outcome read back from `refs/heads/<branch>` (~297), never from exit code alone. Resumed `applying` step with ref at planned sha is adopted, not re-created (~293).
- `drive` (~355): `applied` steps skipped on retry; terminal `done`/`rolled-back` returned untouched (no git call).
- Wiring: `service.ts:6825-6843` `crossRepoFanout/Status/Compensate` via `withCrossRepo` → `server.ts:1815-1867` routes. Named tests present: "a branch is cut in every repository…", "a retry with the same key runs no effect", "a step is applying in the store before its create runs…" (`cross-repo-ops.test.ts`).

### Success Criterion 2: forced failure at step N yields compensated state or durable needs-attention; never success for partial — VERIFIED in code

- `drive` (~362-378): forward loop breaks at first non-`applied`; undo loop reverses steps newest-first; `done` set only when every step `applied`; otherwise `needs-attention` if any step parked, else `rolled-back`.
- `compensate` (~390-406): undo-only, never calls `applyStep`; in-flight `applying` parked as `apply-unknown`; `rolled-back` terminal.
- Per-step `detail` (`ref-moved`, `undo-failed`, `undo-unknown`, `apply-unknown`, `adopted`, …) persisted and returned, naming the parked step/reason.
- Named tests: "a failed create at the second repository undoes the first and reports rolled-back, never done", "a failure at the first repository stops the run…", "a rolled-back operation is terminal…", "a failed compensating delete parks the step…".

### Success Criterion 3: exercised against temporary real repositories; parked result exposed; outside ref change never overwritten, completed effect never silently repeated — VERIFIED in code

- `cross-repo-ops.testkit.ts` builds two real git repositories in a temp dir, registered via production env vars. Tests: "a ref moved by an outside change is parked and left alone…", "a ref another writer put at the planned sha… is adopted, never deleted", "a branch that already sits at the planned sha is not adopted…".
- `undoStep` (~313-330): deletes only when ref equals `plannedSha`; `adopted` steps parked, never deleted; ref-move parked as `ref-moved`.
- PG-backed tests present (`cross-repo-ops.pg.test.ts:34,56`): crash-resume by a fresh index with no second create; parked compensation read back by a fresh index.
- `crossRepoStatus` returns null (404) unless surface granted every step repo; `KeyedLock` serializes drivers in-process (concurrent-driver tests present).

## Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| HARD-R1 | SATISFIED in code; operator/live sign-off pending | Criteria 1–3 above |

## Anti-Patterns

No `TODO`/`FIXME`/`XXX`/`TBD`/placeholder markers found in `cross-repo-ops.ts` / `cross-repo-store.ts` (grep at HEAD). No empty-return stubs in the fan-out/drive/compensate paths; refusals are explicit typed outcomes with HTTP mapping (`refusalStatus`).

## Gaps Summary

No code gaps. All three success criteria hold in the implementation at HEAD `ee998735`, with named tests in the repo covering real temporary repositories and the live-Postgres adapter. Status is `human_needed` solely because the remaining items are operator/live: the gate re-run + owner sign-off that ROADMAP.md requires (this pass was barred from running tests/tsc/Biome), the one-driver-per-index deployment assumption, and the default surface-policy confirmation.

## Human Verification Required

1. Gate re-run and owner sign-off — see frontmatter.
2. Single driver per index database — see frontmatter.
3. Default surface policy for cross-repo writes — see frontmatter.

Verified: 2026-11-19 (HEAD ee998735)
Verifier: GSD verifier (v18-reverify-4)
