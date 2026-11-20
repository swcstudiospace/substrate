---
phase: 40-docs-memory
verified: 2026-11-12T08:36:07Z
status: human_needed
score: 2/3 must-haves verified (criteria 1 and 3 verified in-repo; criterion 2 operator-gated, not met)
covered_files: [".planning/milestones/v1.3.x-phases/40-docs-memory/PLAN.md", ".planning/milestones/v1.3.x-phases/40-docs-memory/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "docs/event-vocabulary.md", "docs/memory-governance.md", "docs/runbooks/memory-mcp-retirement.md", "packages/mcp-server/src/brief-recall-fanout.test.ts", "packages/mcp-server/src/brief-recall.test.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/mental-model-refresh.test.ts", "packages/mcp-server/src/mental-model-refresh.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/recall-snapshot.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:303985816871a39f3954a09f7c00ab7d8ff3c2189b4d56b852388c952b06b4b2"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 40 (DOCS-MEMORY) Verification Report

**Phase Goal:** Memory planes consolidate into one: cross-surface recall, retirement of the duplicate memory MCPs once the `sub-*` banks answer, and a weekly refresh of config-named mental models.
**Verified:** 2026-11-12T08:36:07Z
**Status:** human_needed
**Re-verification:** Yes (prior report 2026-10-21 was human_needed; re-run against HEAD af4c4278 with fresh code evidence)

## Goal Achievement

### Observable Truths

| #   | Truth (ROADMAP criterion, as amended) | Status | Evidence |
| --- | ------------------------------------- | ------ | -------- |
| 1   | D-D1: brief recall is a bounded, cached fan-out over the `sub-*` banks | ✓ VERIFIED (in-repo; no live effect) | `brief.ts:179` `boundedRecall`, capped by `BRIEF_RECALL_CAP_MS` (`recall-snapshot.ts:46`, 3000 ms); `memory-recall.ts:189` `recallAcrossBanks`, `:349` `fanOutBriefRecall`; `service.ts:2602` `recallFanout`; cache keyed on `gen:memory` / `gen:recall` (`cache.ts:84`, `:93`). Targeted tests pass (see Behavioral Spot-Checks). Live fan-out not run. |
| 2   | Claude Code `hindsight` MCP and Hermes supermemory retired once `sub-*` banks answer, restore routes recorded first | ✗ NOT MET (operator-gated) | Restore routes recorded in `docs/runbooks/memory-mcp-retirement.md` section 1. Drill (section 2) is operator-run and not executed; retirement (section 3) not executed. `sub-grok-bot` absent from the VPS bank list and Hermes supermemory has no configured integration (SUMMARY, 2026-10-21). Routed to human verification, not `passed`. |
| 3   | Weekly refresh of config-named mental models through the refresh endpoint, without `reflect` (owner-accepted narrower scope, 2026-10-22) | ✓ VERIFIED (in-repo; live pass not run) | `config.ts:2596` `loadMentalModelConfig`; `mental-model-refresh.ts:23` `REFRESH_INTERVAL_MS` = 7 days; `:82-86` `start` sets an unref'd interval with no run at boot; `:91` `stop`; `:129` POST to `/v1/default/banks/{bank}/mental-models/{id}/refresh`; `index.ts:209` start, `:230` stop on shutdown. Targeted tests pass. No `reflect` call in the code path. Live refresh not run. |

**Score:** 2/3 truths verified (0 behavior-unverified)

### Deferred Items

None. Criterion 2 is not addressed by a later phase; it is operator-gated within this phase.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/brief-recall-fanout.test.ts` | Fan-out cap, key, cache and forgotten-entry behaviour | ✓ VERIFIED | Exists; passes in the targeted run |
| `packages/mcp-server/src/mental-model-refresh.ts` | Weekly unref'd refresh | ✓ VERIFIED | Exists; wired at `index.ts:209`, `:230` |
| `packages/mcp-server/src/config.ts` | `HINDSIGHT_MENTAL_MODELS` parser | ✓ VERIFIED | `loadMentalModelConfig` at `:2596`, wired at `:1299` |
| `docs/runbooks/memory-mcp-retirement.md` | Restore routes and drill steps; no retirement | ✓ VERIFIED | Exists; section 1 records restore routes; status lines say retirement not executed |
| `packages/mcp-server/src/event-sources.ts` | Catalog entry `memory.mental_model.refresh` | ✓ VERIFIED | `:1046`, `:1063` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `memory-recall.ts` fan-out | `recallFanout` → `fanOutBriefRecall` | ✓ WIRED | `service.ts:2620` |
| `brief.ts` | cap | `boundedRecall(..., BRIEF_RECALL_CAP_MS)` | ✓ WIRED | `brief.ts:310` |
| `index.ts` | mental-model refresh | `mentalModelRefresh.start()` / `.stop()` | ✓ WIRED | `index.ts:209`, `:230` |
| `config.ts` | refresh models | `mentalModels: loadMentalModelConfig(env)` | ✓ WIRED | `config.ts:1299` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `brief.ts` recall section | `RecallSnapshot` hits | `recallAcrossBanks` → Hindsight recall per bank | Yes in code; live not run | ✓ FLOWING (code path); live proof pending |
| `mental-model-refresh.ts` | model list | `config.mentalModels.models` | Yes (from env) | ✓ FLOWING (code path) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fan-out, cap, cache, refresh and config tests | `bun test packages/mcp-server/src/brief-recall.test.ts packages/mcp-server/src/brief-recall-fanout.test.ts packages/mcp-server/src/mental-model-refresh.test.ts packages/mcp-server/src/config.test.ts` | 253 pass, 0 fail, 1392 expect() calls, 13.08 s | ✓ PASS |
| Typecheck | not run (`bunx tsc --noEmit` not run in this verification) | - | ? SKIP |
| Full `bun test` suite | not run (targeted suites only) | - | ? SKIP |

### Probe Execution

No probes declared for this phase (no `scripts/*/tests/probe-*.sh` referenced in PLAN or SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| D-D1 | PLAN.md | Cross-surface brief recall, bounded and cached | ✓ SATISFIED (in-repo) | Truth 1; tests pass; live proof human |
| D-D3 | PLAN.md | One memory plane; retire duplicate MCPs with restore routes first | ✗ BLOCKED (operator-gated) | Truth 2; runbook only, nothing retired |
| D-D4 | PLAN.md | Weekly refresh of named mental models | ✓ SATISFIED (in-repo, narrowed scope) | Truth 3; tests pass; live proof human |

No orphaned requirements: D-D1, D-D3 and D-D4 are all claimed by PLAN.md.

### Anti-Patterns Found

None. Grep for `TBD|FIXME|XXX` across the covered source files and the runbook returned no matches. No stub returns in the new modules.

### Human Verification Required

### 1. Live brief recall fan-out under `enforce`
**Test:** On the VPS, operator sets `SUBSTRATE_BRIEF_RECALL=enforce` and `HINDSIGHT_BANKS` to the `sub-*` names, restarts, then requests a brief for a repo with memory.
**Expected:** Brief contains a recall section drawn from more than one bank; `substrate.cache.operations{class=recall-snapshot}` shows fan-out hits; recall never holds the brief past 3000 ms.
**Why human:** Needs live Hindsight and operator-set env. Not run. Hindsight was not contacted in this check, and Postgres at 127.0.0.1:5432 refuses TCP (per task context).

### 2. Mental-model refresh against Hindsight
**Test:** Operator sets `HINDSIGHT_MENTAL_MODELS` (names and counts only; never print the key). After the first scheduled pass, seven days after start, check the ledger.
**Expected:** One `memory.mental_model.refresh` note per named model with an accepted or failed outcome.
**Why human:** Live endpoint and a seven-day timer. No refresh was run here.

### 3. Criterion 2: restore drill and retirement approval
**Test:** Operator runs the restore drill in runbook section 2, confirms every `sub-*` bank answers (including `sub-grok-bot`, currently absent), and approves retirement; then executes section 3.
**Expected:** Both restore routes proven restorable; the Claude Code `hindsight` MCP and supermemory entries removed only after approval.
**Why human:** Operator-gated. Criterion 2 is not met in the repository and must not be reported as passed.

### 4. Criterion 3 scope acceptance on record
**Test:** Owner confirms the narrowed criterion 3 wording (ROADMAP.md:571) stands as the accepted scope.
**Expected:** Owner acknowledgement on record (2026-10-22 per the prior report). The ROADMAP 2026-10-23 "accepted as debt" entry is a separate phase-level acceptance and is not reconciled here.
**Why human:** Scope acceptance is an owner decision.

### Carried-forward live checks (2026-10-21, not re-run)

- `SUBSTRATE_BRIEF_RECALL` unset (default off); `HINDSIGHT_BANKS` unset; `HINDSIGHT_MENTAL_MODELS` unset on the server.
- Hindsight `/v1/default/banks` returned 11 banks on 2026-10-21; `sub-grok-bot` absent.

### Gaps Summary

No must-have is FAILED against the amended ROADMAP wording. Criteria 1 and 3 are verified in-repo by code inspection and passing targeted tests. Criterion 2 is not met as written: retirement has not been executed, and its drill and approval are operator-gated. Operator-gated items route to `human_needed`, not `passed`.

Status is `human_needed` because human items exist (items 1 to 4). It is not `gaps_found` because no must-have is FAILED against the amended criteria. Criterion 2 remains an open item and the phase must not be closed as `passed`.

Observed outside this phase's scope (from SUMMARY, not re-verified): six `grok-bot` memory writes refused with `retain.unsourced`; root filesystem at 99%.

---

_Verified: 2026-11-12T08:36:07Z_
_Verifier: Claude (gsd-verifier)_
