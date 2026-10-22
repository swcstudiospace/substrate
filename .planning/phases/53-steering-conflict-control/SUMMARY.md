---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
verified: 2026-10-22
status: corrective commits landed for criteria 2, 3 and 4; re-verification pending (criterion 1 PASS; findings in VERIFICATION.md)
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

## Corrective work (gaps C2, C3, C4)

Branch `gsd/p53-complete-store`, starting at `2a06852`. Four commits, in order. The docs commit is the one that adds this section.

| Gap | Criterion | Commit | Files |
| --- | --- | --- | --- |
| C2: plan id across phases; detector had no runtime caller (PLAN W5) | 2 | `9965506` | `presence.ts`, `report.ts` (new), `conflicts.ts`, `conflicts.test.ts`, `read.ts`, `read.test.ts` |
| C3: a watcher gap makes the session view unknown until a full rescan | 3 | `174863f` | `report.ts`, `read.ts`, `read.test.ts` |
| C4: completion checkpoints survive restart | 4 | `3500fcd` | `checkpoint-store.ts` (new), `checkpoint-store.test.ts` (new), `planning/config.ts`, `read.ts`, `read.test.ts`, `config.ts`, `service.ts` |
| Decisions, registry row, `.env.example` line, config reference row, this section | all | docs commit | `CONTEXT.md`, `SUMMARY.md`, `docs/config-reference.md`, `flag-registry.ts`, `.env.example` |

### Verifier claims, checked against the source before any change

- C2a, plan id overlap across phases is not detected (`conflicts.ts:119`, `:142-148`): correct.
- C2b, `detectConflicts` has no runtime caller: correct. Grep showed only `conflicts.ts`.
- C3, no watcher or rescan concept: correct. Only per-scan unknown reasons existed.
- C4, the checkpoint store is in memory only and no test restarts: correct. `InMemoryCompletionStore` was the only store.

No verifier claim was wrong.

### What each fix does

- **C2 (criterion 2).** Each session's planning report rides in its presence record (PLAN W5), so every reader sees every session's index. `PlanningReader.sessions()` runs `detectConflicts` over the presence snapshot and announces each open conflict once through the ledger ingest. A phase key is two or more known, active sessions on one active phase. A plan key is one plan id held under two or more active phases. Nothing closes or edits a session's record.
- **C3 (criterion 3).** A truncated or unlisted index opens a watcher gap in the reader. The report is then unknown (`scan-truncated` or `scan-unlisted`) until a complete scan clears the gap. A failed scan keeps an open gap. An unknown session takes no part in detection, and its conflict-sensitive gate refuses. A report older than the presence TTL is `scan-stale`. The state shows in each `planning_sessions` row as `planning`.
- **C4 (criterion 4).** `DurableCompletionStore` keeps an append-only file, `completions.jsonl`, in `SUBSTRATE_PLANNING_CHECKPOINT_DIR`. The file is rewritten through a temporary file with fsync and rename. Reopening loads the stored keys, and recording a stored key is a no-op. A changed file hash is a new key, flagged on resume. With the variable unset, `planning_status` reports `durable: false`.

### Decisions

Recorded in `CONTEXT.md` as dated lines. D53-g itself is unchanged.

- D53-g.1: amends D53-g to criterion 2: a shared plan id under different active phases is a conflict.
- D53-j: a conflict event is `kind: "warning"` on the `substrate` surface.
- D53-k: the feed is each session's planning report in its presence record. The staleness threshold is the presence TTL.
- D53-l: a watcher gap is an incomplete observation; a failed scan keeps it open.
- D53-m: the checkpoint store's file format, write order, and the unset behaviour.

### Event kind for conflicts

`warning`, on the `substrate` surface. The payload is `{ kind: "planning.conflict", key, phases, plans, sessionIds, ... }`. `EVENT_KINDS` is unchanged, as phase 17 requires.

### Wiring status

- W1, the TimescaleDB history table: unchanged from the earlier commits. It is not part of these gaps.
- W2, the durable directive store behind `SteeringInbox`: not implemented. No criterion needs it. C4 concerns completion checkpoints, not steering directives. `SteeringInbox` still keeps records in memory (`steering.ts:171`). Out of scope for this correction.
- W3 and W4: kept as they were.
- W5, the feed to `detectConflicts`: implemented as D53-k. Per-session index scans reach the detector through presence records. The runtime caller is `PlanningReader.sessions()`.

### Open items after this correction

1. **No session writes an active phase.** The heartbeat writes `activePhase: null` (`read.ts`), and nothing else sets it. No conflict can arise in production until a writer exists. The runtime path is tested with presence records that carry an active phase. Choosing the source (the checkout's STATE.md, a branch convention, or an operator setting) is a design decision that this correction does not make.
2. **Conflict-sensitive writes are not gated.** `gateConflictSensitiveWrite` refuses an unknown view and is tested. No write path in the repo calls it. The steering inbox targets other sessions but takes no planning view. Gating it needs an inbox dependency change, which I did not make.
3. **No caller of the durable store.** No plan-step executor exists in this server, so nothing calls `recordCompletion` on `DurableCompletionStore`. `planning_status` reports `durable: true` when the directory is configured. That means configured, not opened: the service does not open the store at boot.
4. **The unlisted-directory gap has no test.** The path exists (`scan-unlisted`). Reproducing an unreadable directory needs a non-root user.
5. **No cross-process lock** on a checkpoint directory. One writer per directory is assumed (D53-m).
6. **Criterion source.** `.planning/ROADMAP.md` has no phase 53 entry, and the phrase "parsed phase or plan id" does not appear in it. Criterion 2 is cited as VERIFICATION.md quotes it.
7. **Gates not run**, per the assignment. The orchestrator should run the config reference check (`bun run config:reference -- --check`; the row was written by hand in the generator's format), `flag-registry.test.ts` (the new registry row and `.env.example` line), and the planning tests.

## New dependencies

None. `package.json`, `packages/mcp-server/package.json` and `bun.lock` show no diff against `0df730e`. `zod` (`^4.6.5`, `packages/mcp-server/package.json:13`) was already a dependency. The `bun` SQL type import in `steering-store.ts` comes from the runtime already in use.

## Artifacts

- `.planning/phases/53-steering-conflict-control/VERIFICATION.md`
- `.planning/phases/53-steering-conflict-control/SUMMARY.md`
