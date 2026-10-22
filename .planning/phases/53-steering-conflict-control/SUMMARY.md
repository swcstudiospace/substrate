---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
verified: 2026-10-22
status: passed in-repo for SC1 to SC4 (residuals and operator-gated steps recorded in VERIFICATION.md)
head: d25b5b4
branch: gsd/p53-complete-store
prior_verified_head: fc59cff (verdict passed; docs at ec23741). First verified head eedb64e (verdict gaps_found: SC2, SC3, SC4 failed)
merge_base_origin_main: 0df730ecd42e8a152fd73f1b6b5db04dc170b413
---

# 53-SUMMARY: Steering, conflict control and checkpoint/resume (SOTA-09)

## What was executed

Read-only delta re-verification in `/root/src/worktrees/as-p53-store` at `d25b5b4`. No tests, `bun install`, `tsc`, lint or formatters were run. The orchestrator's gate on this head reports tsc clean, and 488 pass with 0 fail in the planning, fabric, dashboards and metrics tests.

- Confirmed the head (`git rev-parse --short HEAD` gives `d25b5b4`) and the delta range `fc59cff..d25b5b4`: the Greptile review fixes for phase 53 (`787ac85`, `c520dc8`, `4bbeb2d`, `dc40f65`, `aa529e3`, `660e1cb`), the phase 52 and 51 review fixes merged in, and the two merges `9e866eb` and `d25b5b4`.
- Checked that the delta leaves `steering.ts`, `steering-tools.ts`, `steering.test.ts`, `report.ts`, `checkpoint.ts` and `checkpoint.test.ts` unchanged. It changes `observer.ts`, `observer.test.ts`, `conflicts.ts`, `conflicts.test.ts`, `presence.ts`, `checkout.ts`, `checkpoint-store.ts`, `checkpoint-store.test.ts`, `read.test.ts` and fixtures. No dependency manifest changed.
- Re-cited the production path in the changed `observer.ts`: the fresh-change gate and touch (`:216-222`, `:275-282`), the presence write (`:289-317`), detection and the repository filter (`:324-349`), and the per-process announced set (`:127`, `:335`, `:347`).
- Re-cited the gap rule and its retry: `observer.ts:201-204`, `:262-268`, `:290-292`, `:311-315`. Re-cited the store's second-open fix: `checkpoint-store.ts:64-90`, and the test `checkpoint-store.test.ts:110-121`.
- Searches (no test run):
  - `grep -rn "recordCompletion(\|DurableCompletionStore.open(\|gateConflictSensitiveWrite(" packages/mcp-server/src --include=*.ts | grep -v "\.test\.ts"` (definitions only: `checkpoint.ts:71`, `conflicts.ts:112`; no production caller).
  - `grep -rn "activePhase" packages/mcp-server/src --include=*.ts` (empty).
  - `grep -n "_run" observer.test.ts` (last checked in the prior delta: the cadence callback is still not invoked by the cadence test).
- Read-only git: `rev-parse`, `log`, `diff --stat` on the delta and on the dependency manifests.
- Wrote `VERIFICATION.md` and this file.

## Review-fix commits since fc59cff

Phase 53 fixes (Greptile review threads):

```
4bbeb2d fix(planning): conflicts are scoped to repository identity (greptile thread: Unrelated repos appear to conflict)
660e1cb fix(planning): a timer tick during a running scan starts no second scan (greptile thread: Slow reads pile up scans)
aa529e3 fix(planning): a held publish retry keeps the touched time of its edit (greptile thread: Publish retries renew old edits)
dc40f65 fix(planning): a failed scan writes the unknown report to presence (greptile thread: Failed scans still look known)
c520dc8 fix(planning): a failed presence write is retried on the next scan (greptile thread: Gap updates stop retrying)
787ac85 fix(planning): a second open of a completion directory no longer drops records (greptile thread: Saved completions disappear)
```

Phase 52 and 51 fixes merged into this branch in the same delta (verified only for their effect on phase 53 files):

```
d25b5b4 merge(gsd/p52-wiring): absorb the phase 52 review fixes into phase 53
9e866eb merge(gsd/p51-fabric-impl): absorb the phase 51 review fixes into phase 52 wiring
6614b06 Merge remote-tracking branch 'origin/gsd/p52-planning-core' into gsd/p52-wiring
681149f docs(52): the planning status read walks the documents on every call, and the observer's scan is not a read
097f41b fix(planning): shutdown waits for an in-flight planning scan inside its bound
25e8213 fix(planning): an inline comment after the origin URL is not part of the repo
da3f7de fix(planning): a quiet checkout does not read as active, scans never overlap, and failures are reported
8a9b1bf fix(planning): the fake tree gives each file its own fingerprint and includes its resolved path
8202976 fix(planning): the event payload stays within the ledger budget and says how many paths it left out
91d74c7 fix(healthz): the size read starts when the ping answers, not after the write probe (phase 51)
b5123ad fix(fabric): a healthy Greptime is not unavailable with the write probe off (phase 51)
```

Totals: 180 commits since the merge-base `0df730e`. 33 of them are tagged phase 53. Before this delta the earlier SUMMARY lists the phase 53 commits from `2a06852` and `db0729f`, which are in git history.

## Deviations from PLAN.md and CONTEXT.md

- **Wiring landed in a phase that scoped it out.** `CONTEXT.md:12-14` and `PLAN.md:23` said no MCP tool, flag, policy entry, migration or file write would be added. The branch contains the steering audit sink (W1, `steering-store.ts`), migration 33 (opt-in, default off, `index-store.ts:601-636`), the steering MCP tools (`mcp.ts`), policy entries and flag rows (`packages/audit/src/policy.ts`, `flag-registry.ts`), and the planning checkpoint directory flag (`config.ts:95`).
- **Conflict runtime caller added (PLAN W5).** `9965506` and `21d747a` feed `detectConflicts` from the production presence snapshot (`observer.ts:324-349`, `read.ts:175`). Sessions carry touched phase and plan pairs (`presence.ts:53-59`).
- **Conflicts are repository-scoped.** This was not in the PLAN. `4bbeb2d` adds the repository identity to presence (`presence.ts:62-65`, `:73`), to the detector (`conflicts.ts:100-108`), and to the announce filter (`observer.ts:333`).
- **Plan-id keying widened.** `CONTEXT.md:32-34` (D53-g) keyed conflicts on phase only. The fix-ups add a plan key across phases (`conflicts.ts:183`), as ROADMAP criterion 2 requires.
- **Watcher gap is scan-based.** The PLAN named no watcher. The gap is an incomplete scan (`report.ts:30-36`). The repo has no filesystem watch.
- **Durable completion store added.** The PLAN listed only the in-memory store. `checkpoint-store.ts` persists `completions.jsonl` under `SUBSTRATE_PLANNING_CHECKPOINT_DIR`, and now rereads the file on every insert and list (`checkpoint-store.ts:66`, `:79`, `:84-90`).
- **Scan cadence is configuration.** `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS` (default 15000, bounds 1000 to 3600000) is read by `config.ts:16-30`. Timer ticks now coalesce into a running scan (`observer.ts:161-164`, `:176-179`).
- **Not built: W2.** The durable directive store is absent. `SteeringInbox` keeps records in memory (`steering.ts:171`).
- **SC3 decision.** `gateConflictSensitiveWrite` has no production caller (`conflicts.ts:112`). SC3 as written requires only the unknown view, so the caller is not required. The reason is in `VERIFICATION.md`.
- **Residuals, not changed here.** Per-process announcement set (`observer.ts:127`), store-level-only SC4 proof with no OS kill, no production caller of `recordCompletion` (`checkpoint.ts:71`), the write gate with no caller (`conflicts.ts:112`), in-memory steering directives (`steering.ts:171`), the caller-supplied steering conflict flag (`steering-tools.ts:167`), and reread-then-write not serialised across two open instances (`checkpoint-store.ts:66-71`).

## New dependencies

None. `package.json`, `packages/mcp-server/package.json` and `bun.lock` show no diff between `2a06852` and `d25b5b4`. The durable store uses `node:fs/promises`, `node:crypto` and `node:path`, which are built-ins. `zod` was already a dependency.

## Artifacts

- `.planning/phases/53-steering-conflict-control/VERIFICATION.md`
- `.planning/phases/53-steering-conflict-control/SUMMARY.md`
