---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
verified: 2026-10-22
status: passed in-repo for SC1 to SC4 (residuals and operator-gated steps recorded in VERIFICATION.md)
head: ca4f659
branch: gsd/p53-complete-store
prior_verified_head: d25b5b4 (verdict passed; docs f45ff07). Earlier: fc59cff (ec23741, passed); eedb64e (gaps_found: SC2, SC3, SC4 failed)
merge_base_origin_main: 0df730ecd42e8a152fd73f1b6b5db04dc170b413
---

# 53-SUMMARY: Steering, conflict control and checkpoint/resume (SOTA-09)

## What was executed

Read-only delta re-verification in `/root/src/worktrees/as-p53-store` at `ca4f659`. No tests, `bun install`, `tsc`, lint or formatters were run. The orchestrator's gate on this head reports tsc clean and 494 pass, 0 fail.

- Confirmed the head (`git rev-parse --short HEAD` gives `ca4f659`) and the delta range `d25b5b4..ca4f659`.
- Checked that the delta leaves `steering.ts`, `steering-tools.ts`, `steering.test.ts`, `report.ts`, `presence.ts`, `checkpoint.ts`, `checkpoint.test.ts`, `checkpoint-store.ts` and `checkpoint-store.test.ts` unchanged. It changes `conflicts.ts` (one added `phaseCount` line and the phase cap), `observer.ts` and `observer.test.ts` (truncated-listing rule, clock read after the listing, recovered-repository heartbeat), and `checkout.ts`, `config.ts`, `index.ts` and their tests from the phase 52 merge. No dependency manifest changed.
- Re-cited the production path in the changed `observer.ts`: the retry guard and touch (`:221-224`, `:277-284`), the heartbeat and repository pending rule (`:291-320`), and announce with the clock read after the listing and the truncated-listing rule (`:329-359`).
- Searches (no test run):
  - `grep -rn "recordCompletion(\|DurableCompletionStore.open(\|gateConflictSensitiveWrite(" packages/mcp-server/src --include=*.ts | grep -v "\.test\.ts"` (definitions only: `checkpoint.ts:71`, `conflicts.ts:112`; no production caller).
  - `grep -rn "activePhase" packages/mcp-server/src --include=*.ts` (empty).
  - `git diff --stat 2a06852..HEAD -- package.json bun.lock packages/mcp-server/package.json` (empty).
- Read-only git: `rev-parse`, `log`, `diff --stat`.
- Wrote `VERIFICATION.md` and this file.

## Commits since d25b5b4

Phase 53 fixes (Greptile review threads):

```
c695770 fix(planning): the conflict event caps its phases and keeps their full count (greptile thread: Conflict details disappear)
c6235ce fix(planning): a scan judges peers at the clock read after its listing (greptile thread: Expired edits trigger warnings)
0beab53 fix(planning): a recovered repository triggers a heartbeat without re-dating the edit (greptile thread: Recovered sessions miss conflicts)
93a66f5 fix(planning): a truncated presence listing keeps open conflicts open (greptile thread: Partial listings repeat warnings)
```

Phase 52 and 51 fixes merged into this branch in the same delta, verified only for their effect on phase 53 files:

```
ca4f659 merge(gsd/p52-wiring): absorb the phase 52 review fixes into phase 53
0189469 merge(gsd/p51-fabric-impl): absorb the phase 51 doc fixes into phase 52 wiring
76c1fcb fix(planning): a refused planning setting is named at boot, with its key and never its value (phase 52, SOTA-08)
0f7647c fix(planning): the origin remote follows git's case, whitespace and indentation rules (phase 52, SOTA-08)
e286332 docs(fabric): the write-probe rule and the hindsight panel match the code (phase 51, SOTA-07)
```

The Greptile claim that publish retries renew old edits did not hold at this head. The retry guard is `observer.ts:221-223`, and `heldChange` is kept while the publish is held (`observer.ts:253`). The regression test is `observer.test.ts:478`, and it still passes by the orchestrator's gate.

Totals: the branch has commits since the merge-base `0df730e`, and their phase 53 count is recorded in git history. The phase 53 commit lists for earlier deltas are in `2a06852`, `db0729f`, `fc59cff` and `d25b5b4` history.

## Deviations from PLAN.md and CONTEXT.md

- **Wiring landed in a phase that scoped it out.** `CONTEXT.md:12-14` and `PLAN.md:23` said no MCP tool, flag, policy entry, migration or file write would be added. The branch contains the steering audit sink (W1, `steering-store.ts`), migration 33 (opt-in, default off, `index-store.ts:601-636`), the steering MCP tools (`mcp.ts`), policy entries and flag rows (`packages/audit/src/policy.ts`, `flag-registry.ts`), and the planning checkpoint directory flag (`config.ts:95`).
- **Conflict runtime caller added (PLAN W5).** `9965506` and `21d747a` feed `detectConflicts` from the production presence snapshot (`observer.ts:329-359`, `read.ts:175`). Sessions carry touched phase and plan pairs (`presence.ts:53-59`).
- **Conflicts are repository-scoped.** This was not in the PLAN. `4bbeb2d` adds the repository identity to presence (`presence.ts:62-65`, `:73`), to the detector (`conflicts.ts:100-108`), and to the announce filter (`observer.ts:341`).
- **Conflict events are capped.** `c695770` caps phases at 32 and keeps `phaseCount` (`conflicts.ts:132-133`), inside the ledger payload limit. This was not in the PLAN.
- **Plan-id keying widened.** `CONTEXT.md:32-34` (D53-g) keyed conflicts on phase only. The fix-ups add a plan key across phases (`conflicts.ts:184`), as ROADMAP criterion 2 requires.
- **Watcher gap is scan-based.** The PLAN named no watcher. The gap is an incomplete scan (`report.ts:30-36`). The repo has no filesystem watch.
- **Durable completion store added.** The PLAN listed only the in-memory store. `checkpoint-store.ts` persists `completions.jsonl` under `SUBSTRATE_PLANNING_CHECKPOINT_DIR`, and rereads the file on every insert and list (`checkpoint-store.ts:66`, `:79`, `:84-90`).
- **Scan cadence is configuration.** `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS` (default 15000, bounds 1000 to 3600000) is read by `config.ts:16-30`. Timer ticks coalesce into a running scan (`observer.ts:164-165`, `:179-180`).
- **Not built: W2.** The durable directive store is absent. `SteeringInbox` keeps records in memory (`steering.ts:171`).
- **SC3 decision.** `gateConflictSensitiveWrite` has no production caller (`conflicts.ts:112`). SC3 as written requires only the unknown view, so the caller is not required. The reason is in `VERIFICATION.md`.
- **Residuals, not changed here.** Per-process announcement set (`observer.ts:129`), store-level-only SC4 proof with no OS kill, no production caller of `recordCompletion` (`checkpoint.ts:71`), the write gate with no caller (`conflicts.ts:112`), in-memory steering directives (`steering.ts:171`), the caller-supplied steering conflict flag (`steering-tools.ts:167`), reread-then-write not serialised across two open instances (`checkpoint-store.ts:66-71`), and truncated listings keeping open conflicts open without re-checking them (`observer.ts:356`).

## New dependencies

None. `package.json`, `packages/mcp-server/package.json` and `bun.lock` show no diff between `2a06852` and `ca4f659`. The durable store uses `node:fs/promises`, `node:crypto` and `node:path`, which are built-ins. `zod` was already a dependency.

## Artifacts

- `.planning/phases/53-steering-conflict-control/VERIFICATION.md`
- `.planning/phases/53-steering-conflict-control/SUMMARY.md`
