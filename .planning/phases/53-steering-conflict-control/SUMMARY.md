---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
verified: 2026-10-22
status: passed in-repo for SC1 to SC4 (residuals and operator-gated steps recorded in VERIFICATION.md)
head: ef361d5
branch: gsd/p53-complete-store
first_verified_head: eedb64e (verdict gaps_found: SC2, SC3, SC4 failed)
merge_base_origin_main: 0df730ecd42e8a152fd73f1b6b5db04dc170b413
---

# 53-SUMMARY: Steering, conflict control and checkpoint/resume (SOTA-09)

## What was executed

Read-only re-verification in `/root/src/worktrees/as-p53-store` at `ef361d5`. No tests, `bun install`, `tsc`, lint or formatters were run. The orchestrator's gate on this head runs separately.

- Confirmed the head (`git rev-parse --short HEAD` gives `ef361d5`) and the fix-up range `2a06852..ef361d5` (31 commits, 10 tagged phase 53).
- Read the production path: `observer.ts`, `presence.ts`, `conflicts.ts`, `report.ts`, `read.ts`, `service.ts:1456-1462`; the durable store `checkpoint-store.ts` and `config.ts:87-95`; the steering core `steering.ts` (unchanged since `eedb64e`).
- Read the proving tests: `observer.test.ts:311`, `:322`, `:337`, `:397`, `:452`, `:477`, `:499`, `:528`; `conflicts.test.ts`; `checkpoint-store.test.ts:34`, `:47`; `steering.test.ts:83`, `:97`, `:123`.
- Searches (no test run):
  - `grep -rn "detectConflicts\|gateConflictSensitiveWrite\|PLANNING_CONFLICT" packages/mcp-server/src --include=*.ts | grep -v "\.test\.ts"` (callers: `observer.ts:230`, `read.ts:175`; `gateConflictSensitiveWrite` has none).
  - `grep -rn "DurableCompletionStore\|completionStoreView\|recordCompletion\|planResume\|PLANNING_CHECKPOINT_DIR" packages/mcp-server/src --include=*.ts | grep -v "\.test\.ts"` (`service.ts` uses only `completionStoreView`; nothing calls `recordCompletion` or `DurableCompletionStore.open`).
  - `grep -rn "activePhase" packages/mcp-server/src --include=*.ts` (empty: the field is removed).
  - `grep -rln "gateConflictSensitiveWrite" --include=*.ts` (`conflicts.ts`, `conflicts.test.ts` only).
  - Steering file diff since `eedb64e` (empty): SC1 line numbers are unchanged.
- Read-only git: `rev-parse`, `log`, `diff --stat` for manifests.
- Wrote `VERIFICATION.md` and this file.

## Phase 53 commits since the first verification (2a06852)

```
ef361d5 test(planning): conflict assertions count conflict events, not publishes (phase 53, SOTA-09)
8cad887 merge(gsd/p52-wiring): absorb the phase 51 S6 gauge fix into phase 53
ea101eb merge(gsd/p52-wiring): absorb the phase 51 metrics fix and phase 52 test fix into phase 53
3d8d4a4 refactor(planning): remove the unused activePhase presence field (phase 53, SOTA-09)
21d747a fix(planning): sessions carry the phases and plans they touched, so conflicts occur in production (phase 53, SOTA-09)
08fed90 merge(gsd/p52-wiring): absorb the latest phase 52 wiring into phase 53
f05f5d0 merge(gsd/p52-wiring): absorb phase 52 wiring into phase 53
cc6d4f3 docs(53): record fixes and scope decisions in CONTEXT and SUMMARY
3500fcd fix(planning): completion checkpoints survive restart (phase 53, SOTA-09)
174863f fix(planning): a watcher gap makes the session view unknown until a full rescan (phase 53, SOTA-09)
9965506 fix(planning): conflicts detect shared plan ids and reach a runtime caller (phase 53, SOTA-09)
```

The earlier 18 phase 53 commits (merge-base `0df730e` to `2a06852`) are listed in the first SUMMARY revision in history. The branch has 124 commits since the merge-base, and 29 of them are tagged phase 53. The rest are phase 51 and 52 integration merges and their fixes.

## Deviations from PLAN.md and CONTEXT.md

- **Wiring landed in a phase that scoped it out.** `CONTEXT.md:12-14` and `PLAN.md:23` said no MCP tool, flag, policy entry, migration or file write would be added. The branch contains the steering audit sink (W1, `steering-store.ts`), migration 33 (opt-in, default off, `index-store.ts:601-636`), the steering MCP tools (`mcp.ts`), policy entries and flag rows (`packages/audit/src/policy.ts`, `flag-registry.ts`), and the planning checkpoint directory flag (`flag-registry.ts:504`).
- **Conflict runtime caller added (PLAN W5).** `9965506` and `21d747a` feed `detectConflicts` from the production presence snapshot (`observer.ts:225-246`, `read.ts:175`). Sessions now carry touched phase and plan pairs (`presence.ts:53-57`).
- **Plan-id keying widened.** `CONTEXT.md:32-34` (D53-g) keyed conflicts on phase only. The fix-ups add a plan key across phases (`conflicts.ts:170-198`), as ROADMAP criterion 2 requires.
- **Watcher gap is scan-based.** The PLAN named no watcher. The gap is an incomplete scan (`report.ts:30-36`). The repo has no filesystem watch.
- **Durable completion store added.** The PLAN listed only the in-memory store. `checkpoint-store.ts` persists `completions.jsonl` under `SUBSTRATE_PLANNING_CHECKPOINT_DIR`.
- **Not built: W2.** The durable directive store is absent. `SteeringInbox` keeps records in memory (`steering.ts:171`).
- **SC3 decision.** `gateConflictSensitiveWrite` has no production caller (`conflicts.ts:100`). SC3 as written requires only the unknown view, so the caller is not required. The reason is in `VERIFICATION.md`.
- **Residuals, not changed here.** Cross-checkout duplicate announcements (`observer.ts:91`), the caller-supplied steering conflict flag (`steering-tools.ts:167`), no production writer of completions, and reopen-as-restart (`checkpoint-store.test.ts:34`).

## New dependencies

None. `package.json`, `packages/mcp-server/package.json` and `bun.lock` show no diff between `2a06852` and `ef361d5`. The durable store uses `node:fs/promises`, `node:crypto` and `node:path`, which are built-ins. `zod` was already a dependency.

## Artifacts

- `.planning/phases/53-steering-conflict-control/VERIFICATION.md`
- `.planning/phases/53-steering-conflict-control/SUMMARY.md`
