---
phase: 53-steering-conflict-control
verified: 2026-11-12T08:39:00Z
status: human_needed
score: 4/4 success criteria verified at library level; 1 operator check (OS-level kill) not run
covered_files: ["packages/mcp-server/src/planning/checkpoint-store.test.ts", "packages/mcp-server/src/planning/checkpoint-store.ts", "packages/mcp-server/src/planning/checkpoint.test.ts", "packages/mcp-server/src/planning/checkpoint.ts", "packages/mcp-server/src/planning/conflicts.test.ts", "packages/mcp-server/src/planning/conflicts.ts", "packages/mcp-server/src/planning/observer.test.ts", "packages/mcp-server/src/planning/observer.ts", "packages/mcp-server/src/planning/report.ts", "packages/mcp-server/src/planning/steering-durable.test.ts", "packages/mcp-server/src/planning/steering-store.test.ts", "packages/mcp-server/src/planning/steering-store.ts", "packages/mcp-server/src/planning/steering.test.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:27867caa81a1f23bbfdffaf33c1e5caaf077b5d3e44bbc61a8c9731d671c90a3"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Run a real kill-and-restart of a checkpointed plan-step runner against DurableCompletionStore (checkpoint dir set), killing the process after one step's completion is written, then restart and count records for the phase/step/hash key."
    expected: "Exactly one completion record for the key after restart; the completed step is skipped on resume; a changed file hash re-runs and is flagged."
    why_human: "checkpoint-store.test.ts:34 simulates restart by reopening the directory in one process. No OS process was killed, and the step runner that calls recordCompletion lives outside this repo."
---

# 53-VERIFICATION: Steering, conflict control and checkpoint/resume

**Phase Goal:** Human-authorized steering directives are queued, acknowledged and audited before any file change; conflicts between sessions on the same parsed phase or plan id emit events and never auto-resolve; checkpoints at plan-step boundaries resume without duplicate completion.
**Verified:** 2026-11-12T08:39:00Z
**Status:** human_needed
**Re-verification:** No. The prior record (2026-10-28, `passed`, against main 31a9bb36) had no `gaps:` section, so this run is a fresh verification against HEAD `708e03e6`. Its status is superseded here: one success criterion's proof level needs an operator check.

## Goal Achievement

### Observable Truths

Roadmap success criteria are the contract (ROADMAP.md, phase 53). PLAN.md declares no `must_haves` frontmatter, so no further truths were added.

| #   | Truth (ROADMAP SC) | Status | Evidence |
| --- | ------------------ | ------ | -------- |
| 1 | Directive queued, then acknowledged, then audited; if audit cannot be made, directive is held and no file changes | ✓ VERIFIED | Audit-before-effect with bounded retry: `steering.ts:38` (`STEERING_AUDIT_ATTEMPTS = 2`), retry loops `steering.ts:557`, `:590`, `:603`; held failure `steering.ts:597`, `:611` (`audit-unavailable`). Tests run and passing: `steering.test.ts` "a queue that cannot be audited stores nothing and returns a typed error", "an acknowledgement that cannot be audited holds the directive queued and leaves it retryable", "queued is audited before it takes effect". No file I/O: `steering.ts` imports only `zod`, `../redact.ts`, `./index.ts`, `./presence.ts`. |
| 2 | Two sessions on the same parsed phase or plan id emit a conflict event; neither side resolves it automatically | ✓ VERIFIED | Detector `conflicts.ts:95` (`detectConflicts`) returns open events only; no resolve path. Tests run and passing: `conflicts.test.ts` "two sessions that touched one phase emit one open phase event", "two sessions that touched a shared plan id under different phases emit one open plan event", and the unknown/no-scan exclusion tests. Announce-once lives in `observer.ts` (its named tests were not run; see Behavioral Spot-Checks). |
| 3 | Watcher gap marks the session view unknown until a full rescan | ✓ VERIFIED | Gap derivation `report.ts:33` (truncated → `scan-truncated`, unlisted → `scan-unlisted`); observer gap state `observer.ts:210`. Tests run and passing (`observer.test.ts`, name filter): "a truncated scan opens the watcher gap: its heartbeat is unknown, and the read shows the same", "a later complete scan clears the gap and returns the checkout to known", "a failed scan writes the unknown report, and the recovered complete scan writes the known one". Gap detection is scan-based; the repo has no filesystem watch. |
| 4 | Kill-and-restart at a plan-step boundary yields exactly one completion record, keyed by phase id, plan step and file hash | ✓ VERIFIED (library level) | Key `checkpoint.ts:39-40` (`sha256(phase \n step \n fileHash)`); idempotent `recordCompletion` `checkpoint.ts:71`; durable store `checkpoint-store.ts:52`. Tests run and passing: `checkpoint.test.ts` key test, "recording the same completion twice leaves one record", resume tests; `checkpoint-store.test.ts` "record, reopen the same directory, record the same key again: exactly one record is stored", "two concurrent inserts through two opens of one directory both survive". Restart is simulated by reopen, not an OS kill, so it is routed to human verification. |

**Score:** 4/4 success criteria verified at library level. 0 behavior-unverified truths (the restart invariant is exercised by a passing reopen test). 1 operator check outstanding.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Audited steering inbox, held on failure | ✓ VERIFIED | 817 lines; audit retry and hold at `:557-611` |
| `packages/mcp-server/src/planning/conflicts.ts` | Pure conflict detector, unknown views excluded | ✓ VERIFIED | `detectConflicts` `:95`; `gateConflictSensitiveWrite` `:116`; `conflictIdempotencyKey` `:132`; `phaseCount` with capped lists `:168` |
| `packages/mcp-server/src/planning/checkpoint.ts` | Completion key, idempotent record, pure resume | ✓ VERIFIED | `completionKey` `:39`; `recordCompletion` `:71`; `planResume` `:116` |
| `packages/mcp-server/src/planning/checkpoint-store.ts` | Durable completion store | ✓ VERIFIED | `DurableCompletionStore` `:52`; tmpfile/fsync/rename/fsync-dir write |
| `packages/mcp-server/src/planning/observer.ts` | Presence, conflict and gap wiring | ✓ VERIFIED (code read) | Gap state `:210`; pending-change state `:218`; announce path not executed here |
| `packages/mcp-server/src/planning/report.ts` | Watcher-gap derivation | ✓ VERIFIED | `:21` WatcherGap type; `:33` gap rule |
| `packages/mcp-server/src/planning/steering-store.ts` | Durable audit sink (migration 33, opt-in) | ✓ VERIFIED (code present) | Not exercised in this run; migration not applied to any DB (operator decision) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering.ts` | audit history sink | `this.deps.history.append` before queue/ack | ✓ WIRED | `steering.ts:557-611` |
| `checkpoint.ts` `recordCompletion` | `CompletionStore.putIfAbsent` | key from `completionKey` | ✓ WIRED (store level) | `checkpoint.ts:71`; no production caller outside tests |
| `conflicts.ts` `detectConflicts` | presence snapshot | `observer.ts` announce, `read.ts` | ✓ WIRED (code read) | Presence `touched` pairs per SUMMARY; repo-scoped |
| `report.ts` gap | `observer.ts` gap state | `nextGap` → heartbeat | ✓ WIRED (tests run) | Gap tests pass |

### Data-Flow Trace (Level 4)

Not applicable: phase 53 delivers library modules and a store, not rendered UI.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Steering audit-before-effect, held-on-failure, auth, rate limit, confirm, env parsing; conflict detection and unknown exclusion; checkpoint key, idempotent record, resume; durable store reopen | `bun test packages/mcp-server/src/planning/steering.test.ts packages/mcp-server/src/planning/conflicts.test.ts packages/mcp-server/src/planning/checkpoint.test.ts packages/mcp-server/src/planning/checkpoint-store.test.ts` | 76 pass, 0 fail | ✓ PASS |
| Watcher gap opens, clears, and failed-scan recovery | `bun test packages/mcp-server/src/planning/observer.test.ts -t "a truncated scan opens the watcher gap\|a later complete scan clears the gap\|a failed scan writes the unknown report"` | 3 pass, 0 fail | ✓ PASS |
| Smallest-session-only announce (SC2 announce-once) | not run (`observer.test.ts:1493` exists by title) | — | ? SKIP |

### Probe Execution

No probe scripts declared or found for this phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SOTA-09 | PLAN.md (`requirements: [SOTA-09]`) | Steering, conflict control, checkpoint/resume | ✓ SATISFIED (library level) | SC1–SC4 above |

No orphaned requirements for phase 53 in this scope.

### Anti-Patterns Found

No `TBD`, `FIXME` or `XXX` markers in the covered files (grep run, zero hits).

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `conflicts.ts` | `:116` | `gateConflictSensitiveWrite` has no production caller | ℹ️ Info | Carried residual (SC3 requires only the unknown view) |
| `checkpoint.ts` | `:71` | `recordCompletion` has no production caller | ⚠️ Warning | Plan-step executor is outside this repo; criterion 4 is store-proven only |
| `steering.ts` | `:171` (per SUMMARY) | Directives held in memory when no live sink | ℹ️ Info | Known residual; durable directive store (W2) not built |
| `steering-tools.ts` | `:167` (per SUMMARY) | Steering conflict flag is caller-supplied | ℹ️ Info | Confirm rule trusts caller flag, not `detectConflicts` |

### Human Verification Required

### 1. Real kill-and-restart at a plan-step boundary

**Test:** With `SUBSTRATE_PLANNING_CHECKPOINT_DIR` set, run a checkpointed step runner that calls `recordCompletion`, kill the OS process after one step's record is written, restart it, and count records for the phase/step/file-hash key.
**Expected:** Exactly one completion record for the key; the completed step is skipped on resume; a changed file hash re-runs and is flagged.
**Why human:** `checkpoint-store.test.ts:34` simulates restart by reopening in one process. No process was killed, and the step runner that would call `recordCompletion` lives outside this repo.

## Gaps Summary

No blocking gaps. All four roadmap success criteria are met at library level by code read and by passing tests (76 pass across the four core files; 3 pass for the watcher-gap tests).

Residuals, none blocking, carried from SUMMARY.md:
- Migration 33 (`planning_steering_audit`) is opt-in and not applied to any live database (operator decision).
- Live delivery of directives into sessions is not built (the roadmap says so).
- `recordCompletion`, `gateConflictSensitiveWrite` and `DurableCompletionStore.open` have no production caller in this repo.
- Per-process announcement set and the default-mode SC2 limit (`observer.ts`); the announce-once tests were not executed in this run.
- Not run: the full `observer.test.ts`, `steering-store.test.ts`, `steering-durable.test.ts`, `steering-idempotency.pg.test.ts` (needs live Postgres; 127.0.0.1:5432 refuses TCP here), and the full `bun test` gate.

Status is `human_needed` rather than `passed` because the OS-level kill-and-restart check for SC4 was not run and needs an operator.

---

_Verified: 2026-11-12T08:39:00Z_
_Verifier: Claude (gsd-verifier)_
