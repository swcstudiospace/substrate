---
phase: 53-steering-conflict-control
verified: 2026-10-22
status: gaps_found
score: 1 of 4 success criteria proven in-repo (criterion 1). Criteria 2, 3 and 4 have FAIL verdicts; their operator-gated parts are listed separately
verified_on: gsd/p53-complete-store at eedb64e4522ff9928c501873623026e73e9f0079 (merge-base with origin/main 0df730e)
covered_files: ["packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/planning/steering.test.ts", "packages/mcp-server/src/planning/steering-store.ts", "packages/mcp-server/src/planning/steering-store.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/conflicts.ts", "packages/mcp-server/src/planning/conflicts.test.ts", "packages/mcp-server/src/planning/checkpoint.ts", "packages/mcp-server/src/planning/checkpoint.test.ts", "packages/mcp-server/src/planning/presence.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/audit/src/policy.ts", "packages/mcp-server/src/index-archive-watch.ts", ".planning/phases/53-steering-conflict-control/CONTEXT.md", ".planning/phases/53-steering-conflict-control/PLAN.md"]
---

# 53-VERIFICATION: Steering, conflict control and checkpoint/resume

## Gates

Not run by the verifier; orchestrator gates pending.

## Acceptance criteria

| Criterion | Verdict | Evidence (file:line) |
|---|---|---|
| 1. A directive is queued, then acknowledged, then audited. When the audit write cannot be made, the directive is held and no file changes. | PASS | Audit precedes each transition. Queue: `steering.ts:237-245` (saved time at 237, audit append at 240, record stored at 245). Acknowledge: `steering.ts:265-286` (audit at 268, record stored at 286). Two attempts: `steering.ts:35` (`STEERING_AUDIT_ATTEMPTS = 2`), `steering.ts:309-320`. Hold: a failed audit returns before any state change (`steering.ts:240-241`, `steering.ts:275-276`). No file writes: no `node:fs` import in `steering.ts:20-23`, and grep for `writeFile\|appendFile\|rename\|mkdir\|unlink\|node:fs` over `steering*.ts` returns nothing. Tests: `steering.test.ts:83` ("queued is audited before it takes effect, and acknowledged is audited before it is recorded"), `steering.test.ts:97` ("a queue that cannot be audited stores nothing"), `steering.test.ts:123` ("an acknowledgement that cannot be audited holds the directive queued"). |
| 2. Two sessions touching the same parsed phase or plan id emit a conflict event, and neither side resolves it automatically. | FAIL | Same-phase path works: `conflicts.ts:137-167` groups known active sessions by phase and emits `kind: "planning.conflict"`, `status: "open"` (`conflicts.ts:43`, `conflicts.ts:157-158`). Test: `conflicts.test.ts:53`. No auto-resolve: the status is the literal `"open"` and nothing mutates it (`conflicts.ts:10`, `conflicts.ts:43`); test `conflicts.test.ts:148` ("a conflict stays open across detections"). Failing part, plan id: a plan id is compared only inside a phase group. Claims are filtered to each session's active phase (`conflicts.ts:115-124`, filter at `conflicts.ts:119`), and plan sharing is computed only within a group (`conflicts.ts:142-148`). Two sessions sharing a plan id under different active phases produce no event, and `conflicts.test.ts:90` asserts that different phases never conflict. Failing part, emission: `detectConflicts` has no non-test caller in `packages/mcp-server/src` (grep in Gaps below). The event is returned to a caller, not emitted to any sink. |
| 3. A watcher gap marks the session view unknown until a full rescan. | FAIL | No watcher or rescan concept exists in the planning code. Unknown reasons are `conflicts.ts:29` (`no-scan`, `scan-failed`, `scan-truncated`, `scan-has-errors`, `scan-stale`), derived in `conflicts.ts:96-108` from scans passed in by the caller. None of them is a watcher gap. The nearest test, `conflicts.test.ts:174` ("a failed scan is unknown and blocks writes until a full scan completes"), covers a failed scan only. The exact searches are in the Gaps section. |
| 4. Kill-and-restart at a plan-step boundary yields exactly one completion record, keyed by phase id, plan step and file hash. | FAIL | Key and idempotence are present: `checkpoint.ts:39-41` (`sha256(phase, step, fileHash)` joined by newlines), `checkpoint.ts:71-76` (`recordCompletion` through `putIfAbsent`), test `checkpoint.test.ts:41` ("recording the same completion twice leaves one record"). Re-run on a changed hash is flagged: `checkpoint.ts:140-143`, test `checkpoint.test.ts:91`. Failing part, durability: the only store is `InMemoryCompletionStore` (`checkpoint.ts:51-63`). No durable adapter exists. Nothing outside `checkpoint.test.ts` calls `recordCompletion`, `planResume` or `completionKey`. No test is named for restart or kill, and `checkpoint.test.ts:109-123` replays against the same live object. A process kill therefore loses every record. |

## Gaps

- **C2a. Plan-id overlap across phases is not a conflict.** Missing: a rule that two known active sessions sharing a parsed plan id emit a conflict whatever their active phase. Current behaviour is `conflicts.ts:119` plus `conflicts.ts:142-148`, asserted by `conflicts.test.ts:90`. This is either code to add or a ROADMAP amendment to the phrase "same parsed phase or plan id". The verifier does not amend criteria.
- **C2b. Conflict detection is not wired, so no event is emitted at runtime.** Missing: the feed from the phase 52 presence snapshot and per-session index scans (PLAN W5), and the emit path that carries a `planning.conflict` to an event sink. Search that shows no caller: `grep -rn "detectConflicts\|gateConflictSensitiveWrite\|PLANNING_CONFLICT" packages/mcp-server/src --include=*.ts | grep -v "\.test\.ts"` returns only `conflicts.ts` lines.
- **C3. No watcher gap input exists.** Missing: a watcher or observer gap that marks an affected session's view `unknown` (a new reason) until a full rescan completes, plus a test. The searches run were:
  - `grep -rniE "rescan|re-scan|watcher|\bwatch\b|gap" packages/mcp-server/src/planning/`. Hits: `diff.ts:6` (a phase 52 diff gap, about withholding a publish, not a watcher) and `conflicts.ts:13` / `conflicts.test.ts:3,174` ("until a full scan completes", a failed scan only).
  - `grep -rniE "watch" packages/mcp-server/src/planning/`. No hits.
  - `grep -rniE "rescan|full scan|watcher gap|gap.*scan|scan.*gap" packages/mcp-server/src --include=*.ts`. Hits are in `greptime.ts`, `redact.ts` and tests, all unrelated.
  - `grep -niE "watch" packages/mcp-server/src/{mcp,service,index-store,event-sources,flag-registry}.ts`. Hits are `IndexArchiveWatch` (archive directory age, `service.ts:1385-1388`), `watchdog` (systemd, unrelated), and prose. No planning watcher.
  - The one watch module, `packages/mcp-server/src/index-archive-watch.ts`, watches the archive directory's age only.
- **C4a. No durable completion store.** Missing: a `CompletionStore` adapter that survives process death (a table or file, with `putIfAbsent` semantics), a caller at plan-step boundaries, and a restart test that rebuilds the process from stored state and asserts one record per `(phase, step, fileHash)`. The adapter and a fake-SQL test are in-repo work. A production table would need migration approval, which is operator-gated and listed separately.
- **C4b. No restart test.** Missing: a test that kills and restarts the resume path, not one that reuses a live in-memory object. Search: `grep -rniE "restart|kill|resum" packages/mcp-server/src/planning/checkpoint.test.ts packages/mcp-server/src/planning/steering*.test.ts` finds only prose and function names, no restart scenario.

## Operator-gated

These steps cannot run in-repo. The in-repo parts pass, and none of these is counted as FAIL.

- **Migration 33 is not applied to any database.** `planning_steering_audit` is defined at `index-store.ts:601-636` (`version: 33`, `optIn: "steering-audit"`). It is opt-in through `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` (`steering-store.ts:31`), default off (`index-store.ts:310`, `index-store.ts:315`). The migration comment (`index-store.ts:600-601`) requires an operator rehearsal on a restored dump before production.
- **The TimescaleDB rehearsal on a restored dump has not run.** The table is a plain `create table`, with no `create_hypertable` in `index-store.ts:601-636`. "Audited in TimescaleDB" therefore means the sink writes to the Timescale-hosted Postgres database, not to a hypertable. Whether a hypertable is wanted is an operator decision.

## Residual risks

- **Directive state is in memory.** `SteeringInbox` keeps records in a `Map` (`steering.ts:171`). `service.ts:1471` constructs it with that map. The durable directive store (PLAN W2) is not implemented. A restart loses queued and acknowledged directives, though the audit rows persist when the sink is live.
- **Scope drift against CONTEXT and PLAN.** `CONTEXT.md:12-14` and `PLAN.md:23` say this phase adds no MCP tool, flag registration, policy entry, migration or file write. The branch adds them: `mcp.ts:1439-1490` (steering tools registered while the switch is on), `flag-registry.ts:315-317` and `flag-registry.ts:498`, `packages/audit/src/policy.ts:34-37` and `:83-84`, and migration 33 at `index-store.ts:601-636`. Those rows were read here, not tested against their own acceptance.
- **Audit is append-only only at application level.** `steering-store.ts` header says a database-level REVOKE or trigger is an operator decision.
- **Import-free core is checked only directly.** `steering.ts:20-23`, `conflicts.ts:17-18` and `checkpoint.ts:15-16` import no `node:fs` module. The transitive imports of `./index.ts` were not traced.
- **Queued directives are not delivered to the target session.** `pendingFor` (`steering.ts:205`) is a read. Nothing in the planning path consumes it, so a directive is queued and audited but has no runtime effect on the session.
