---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
verified: 2026-10-22
status: gaps_found (criterion 1 PASS; criteria 2, 3, 4 FAIL; see VERIFICATION.md)
head: eedb64e4522ff9928c501873623026e73e9f0079
branch: gsd/p53-complete-store
merge_base_origin_main: 0df730ecd42e8a152fd73f1b6b5db04dc170b413
---

# 53-SUMMARY: Steering, conflict control and checkpoint/resume (SOTA-09)

## What was executed

Read-only verification in `/root/src/worktrees/as-p53-store`. No tests, `bun install`, `tsc`, lint or formatters were run, per the verifier rules. The orchestrator runs the gates.

- Read `CONTEXT.md`, `PLAN.md`, `steering.ts`, `conflicts.ts`, `checkpoint.ts`, their tests, `steering-store.ts`, `steering-tools.ts`, the steering wiring in `mcp.ts`, `service.ts`, `flag-registry.ts`, `packages/audit/src/policy.ts`, and migration 33 in `index-store.ts`.
- Searches: `grep -rniE "rescan|re-scan|watcher|\bwatch\b|gap" packages/mcp-server/src/planning/`; `grep -rniE "watch" packages/mcp-server/src/planning/`; `grep -rniE "rescan|full scan|watcher gap|gap.*scan|scan.*gap" packages/mcp-server/src --include=*.ts`; `grep -niE "watch"` over the five server wiring files; `grep -rn` for `detectConflicts`, `gateConflictSensitiveWrite`, `PLANNING_CONFLICT`, `recordCompletion`, `planResume`, `completionKey`, `pendingFor`, and `new SteeringInbox`, excluding tests; a restart/kill grep over the checkpoint and steering tests; a write-call grep (`writeFile|appendFile|rename|mkdir|unlink|node:fs`) over the steering, conflict and checkpoint modules.
- Read-only git: `rev-parse HEAD`, `merge-base`, `log --oneline`, `rev-list --count`, `diff --stat` for dependency manifests.
- Wrote `VERIFICATION.md` and this file.

Verdicts and evidence are in `VERIFICATION.md`.

## Phase commits since merge-base with origin/main

Merge-base `0df730e`. The branch has 124 commits since it. Most are phase 51 and phase 52 integration merges and their fixes. The 18 commits tagged phase 53 are:

```
eedb64e fix(steering): take retried transition times from the saved audit row (phase 53, SOTA-09)
f6cedbc fix(steering): bound retry state and take plan identity from content (phase 53, SOTA-09)
2c04dd5 fix(steering): keep a queue's audit time across retries (phase 53, SOTA-09)
29b688b fix(steering): keep an acknowledgement's transition time across retries (phase 53, SOTA-09)
0b9f879 fix(steering): recover lost-reply audit writes and never refill on a backwards clock (phase 53, SOTA-09)
bf7380e fix(steering): answer Greptile review items a-h (phase 53, SOTA-09)
7fe0eb7 fix(steering): fail-open list and author refusal at the MCP boundary (phase 53, SOTA-09)
c80e07d fix(steering): describe the registered steering tools in the flag registry (phase 53, SOTA-09)
cfcccd9 fix(steering): list acknowledged directives with state and outcome (phase 53, SOTA-09)
951c8fe fix(steering): derive steering authorship from the operator caller (phase 53, SOTA-09)
f2b73e7 feat(steering): steering MCP tools with fail-closed writes (phase 53, SOTA-09)
375dc35 feat(steering): persist confirm evidence in the audit row (phase 53, SOTA-09)
e3f2c70 feat(steering): durable audit sink with idempotent transitions (phase 53, SOTA-09)
e2ea6ac fix(steering): register SUBSTRATE_PLANNING_STEERING flags (phase 53, SOTA-09)
9bfca3b docs(planning): phase 53 context and plan (SOTA-09)
7511ed4 feat(steering): idempotent completion checkpoints and resume (phase 53, SOTA-09)
2268e4a feat(steering): conflict detection keyed on parsed phase and plan ids (phase 53, SOTA-09)
6112371 feat(steering): audited steering inbox with human-only authorisation (phase 53, SOTA-09)
```

## Deviations from PLAN.md and CONTEXT.md

- **Wiring landed in a phase that scoped it out.** `CONTEXT.md:12-14` and `PLAN.md:23` say this phase adds no MCP tool, flag registration, policy entry, migration or file write. The branch contains:
  - W1, the Postgres audit sink `steering-store.ts`, with migration 33 at `index-store.ts:601-636`, opt-in and default off.
  - W3, steering MCP tools registered in `mcp.ts:1439-1490` while the switch is on.
  - W4, policy entries in `packages/audit/src/policy.ts:34-37` and `:83-84`, and flag rows in `flag-registry.ts:315-317` and `:498`.
  - `service.ts:1471` constructs `SteeringInbox`.
- **Wiring not done.** W2, the durable directive store, is missing, so `SteeringInbox` keeps records in memory (`steering.ts:171`). W5, feeding `detectConflicts` from the presence snapshot and per-session scans, is missing, so conflict detection has no runtime caller.
- **Completion store not in the plan.** The checkpoint module has only `InMemoryCompletionStore` (`checkpoint.ts:51-63`). The PLAN lists no durable completion store, and ROADMAP criterion 4 needs one.
- **Plan-id keying narrower than the criterion.** `CONTEXT.md:32-34` (D53-g) keys conflicts on phase, with plan ids compared inside a phase. ROADMAP criterion 2 says "parsed phase or plan id". This is recorded as C2a in `VERIFICATION.md`.
- **Migration table is not a hypertable.** `index-store.ts:601-636` creates a plain table. ROADMAP says "audited in TimescaleDB". Whether that needs a hypertable is an operator decision.
- **Phase 52 and 51 commits are interleaved.** Merges of `gsd/p51-fabric-impl` and `gsd/p52-*` are in this branch's history. They were not verified here.

## New dependencies

None. `package.json`, `packages/mcp-server/package.json` and `bun.lock` show no diff against `0df730e`. `zod` (`^4.6.5`, `packages/mcp-server/package.json:13`) was already a dependency. The `bun` SQL type import in `steering-store.ts` comes from the runtime already in use.

## Artifacts

- `.planning/phases/53-steering-conflict-control/VERIFICATION.md`
- `.planning/phases/53-steering-conflict-control/SUMMARY.md`
