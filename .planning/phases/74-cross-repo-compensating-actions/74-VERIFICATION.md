---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-12T08:38:44Z
status: human_needed
score: 3/3 success criteria verified at module level; SC1 route decision open (no production caller)
overrides_applied: 0
behavior_unverified: 0
covered_files: [".planning/phases/74-cross-repo-compensating-actions/74-01-PLAN.md", ".planning/phases/74-cross-repo-compensating-actions/74-01-SUMMARY.md", "docs/runbooks/rollback-compat.md", "docs/worktree-fleet-api.md", "packages/mcp-server/src/cross-repo-fake.ts", "packages/mcp-server/src/cross-repo-ops.pg.test.ts", "packages/mcp-server/src/cross-repo-ops.test.ts", "packages/mcp-server/src/cross-repo-ops.testkit.ts", "packages/mcp-server/src/cross-repo-ops.ts", "packages/mcp-server/src/cross-repo-store.pg.test.ts", "packages/mcp-server/src/cross-repo-store.test.ts", "packages/mcp-server/src/cross-repo-store.testkit.ts", "packages/mcp-server/src/cross-repo-store.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts"]
covered_digest: "v3:sha256:2e759b90d5ece3bb81e976610765c0575383897754a0540f1c0b0dd056819bac"
human_verification:
  - test: "Decide whether module-level delivery satisfies SC1's 'actual operation' wording, or require an operator-visible route/MCP tool first."
    expected: "A recorded owner decision. If a route is required, it is a separate phase with admission classification (per D74-10)."
    why_human: "runBranchFanout has no caller outside the module's own tests (grep of packages and scripts). Whether an uncalled module delivers the operation is a scope/gate decision, not something code can settle."
  - test: "Rehearse migration step 43 (cross_repo_operations, cross_repo_steps) on a restored dump before production, as steps 33 to 42 were."
    expected: "Migrate up and down on the restored copy with no error; existing row counts unchanged."
    why_human: "Operator-gated live-data check (SUMMARY remaining gate 2). Not runnable from this workspace against production."
---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Verified:** 2026-11-12T08:38:44Z
**Status:** human_needed
**Re-verification:** No — this run regenerates the report from current code. The prior human_needed report was used as a set of leads, not as evidence.

## Caveat: no route or MCP caller

`runBranchFanout` (`packages/mcp-server/src/cross-repo-ops.ts:337`) and `crossRepoStatus` (`cross-repo-ops.ts:377`) are referenced only from the module's own tests. A grep of `packages` and `scripts` (excluding `*.test.ts` and testkits) finds no HTTP route, MCP tool or CLI command that reaches them. D74-10 defers the route deliberately, and ROADMAP.md line 144 records the phase as PARTIAL for this reason.

SC1 ("Execute an actual operation") is therefore observed at module level, not delivered as an operator-visible operation. Status is `human_needed` per the owner-decision rule for uncalled modules, not `passed`.

## Goal Achievement

### Observable Truths

| #   | Truth (ROADMAP success criterion) | Status | Evidence |
| --- | --------------------------------- | ------ | -------- |
| SC1 | An actual operation across ≥2 registered repositories persists operation/step state before effects, with stable dedupe keys and idempotent per-step retry. | ✓ VERIFIED at module level; route decision open | `runBranchFanout` calls `ctx.store.create(...)` (`cross-repo-ops.ts:~364`) before `drive`, so operation and steps are stored `running`/`pending` before any git effect. Dedupe: caller `key` pattern plus `fingerprintOf` (`cross-repo-ops.ts:165`); a reused key with another fingerprint is refused `key-reused`. Named tests passing in `cross-repo-ops.test.ts`: "a branch is cut in every repository and each step is recorded applied with its planned sha"; "a retry with the same key runs no effect and returns the stored operation"; "a crash after the create landed is adopted on retry, not created again"; "a crash before the create ran leaves the step applying, and the retry creates it once". |
| SC2 | A forced failure at step N yields compensated pre-operation state or durable needs-attention naming unfinished/failed compensation; never report success for a partial operation. | ✓ VERIFIED | Driver sets `done` only when every step is `applied`; otherwise it undoes applied steps and ends `rolled-back`, or `needs-attention` if any step is parked. Named tests passing in `cross-repo-ops.test.ts`: "a failed create at the second repository undoes the first and reports rolled-back, never done"; "a failure at the first repository stops the run"; "a rolled-back operation is terminal: a retry performs no git call"; "a failed compensating delete parks the step, and a retry completes the rollback". |
| SC3 | Exercised against temporary real repositories. Recovery/status exposes the parked result; cannot overwrite an outside ref change or silently repeat a completed effect. | ✓ VERIFIED | Real git via `cross-repo-ops.testkit.ts` (temporary `git init` repositories, production `scopedGit` runner with fault injection). Create is create-only (`applyStep`, `cross-repo-ops.ts:~250`: `update-ref ref planned zero`); undo is compare-and-delete (`undoStep`, `cross-repo-ops.ts:~276`: `update-ref -d ref planned`; `ref-moved` parks when the value differs). Named tests passing: "a ref moved by an outside change is parked and left alone; the retry neither deletes it nor repeats a create"; "a branch that already sits at the planned sha is not adopted"; "a parked step is visible to the surface that drove it, with its reason"; "a surface not granted every repository of the operation sees nothing" (`crossRepoStatus`, `cross-repo-ops.ts:377`). |

**Score:** 3/3 success criteria verified at module level. SC1 carries the route decision (human item 1).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cross-repo-ops.ts` | Operation, driver, status, refusals | ✓ VERIFIED | Read in full. Every git call goes through `scopedGit` via the `git()` helper. Grant and registration are checked before the store is written (`gateRepo`). |
| `packages/mcp-server/src/cross-repo-store.ts` | Postgres adapter | ✓ VERIFIED | Compare-and-set `moveStep` per transition. Live Postgres contract not run in this session (see Behavioral Spot-Checks). |
| `packages/mcp-server/src/cross-repo-fake.ts` | In-memory adapter | ✓ VERIFIED | Same contract, exercised by `cross-repo-store.test.ts`. |
| `packages/mcp-server/src/index-store.ts` (step 43) | Tables `cross_repo_operations`, `cross_repo_steps` | ✓ VERIFIED | Step 43 at lines 914–927 with `down`. `IndexStore.crossRepoStore()` at line 1081. |
| `index-store.migrations.digests.json` | Digest for step 43 | ✓ VERIFIED | Line 44: `"43": "cb7ffa19…"`. `index-store.migrate-contract.test.ts` passes. |
| `docs/runbooks/rollback-compat.md` | Row naming step 43 | ✓ VERIFIED | Row present (line 56). |
| `docs/worktree-fleet-api.md` | "Cross-repository operations (phase 74)" section | ✓ VERIFIED | Section at line 164; states no route exists. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `runBranchFanout` | `store.create` | operation and steps persisted before drive | ✓ WIRED | `cross-repo-ops.ts` |
| `applyStep` / `undoStep` | `scopedGit` | every git call | ✓ WIRED | `git()` helper; refusals return before spawn |
| `cross-repo-store.ts` | `IndexStore` pool | `crossRepoStore()` | ✓ WIRED | `index-store.ts:1081` |
| `runBranchFanout` | HTTP route / MCP tool / CLI | — | ✗ NOT_WIRED (by design, D74-10) | No caller outside the module's own tests. Carried as human item 1. |

### Data-Flow Trace (Level 4)

Not applicable. No UI or rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Operation, refusals, compensation, crash resume (fake store, real git) and migration contract | `bun test src/cross-repo-ops.test.ts src/cross-repo-store.test.ts src/index-store.migrate-contract.test.ts` in `packages/mcp-server` | 81 pass, 0 fail, 190 expect() calls, 3 files (run this session) | ✓ PASS |
| Live Postgres contract and live operation tests (`*.pg.test.ts`) | Requires `SUBSTRATE_TEST_PG_URL` | Not run. `127.0.0.1:5432` refuses TCP in this session; no restart or credential guessing was attempted. The prior report's disposable-container run (38 pass) is not reproduced here. | ? NOT RUN (live DB) |
| Read-only probe of the Postgres port | `bash -c 'echo > /dev/tcp/127.0.0.1/5432'` | Connection refused | — |

### Probe Execution

Not applicable. No probes are declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R1 | 74-01-PLAN.md | Cross-repo compensating actions | ? NEEDS HUMAN | SC1–SC3 verified at module level; production caller decision open. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cross-repo-ops.ts` | 244 (`applyStep`, `before.kind === "unreadable"`) and 274 (`undoStep`) | Step parks as `apply-unknown` on a pending step, without a create having run. A later `undoStep` deletes the ref if it reads as the planned sha, without checking that this operation created it. | ⚠️ Warning | Conflicts with the D74-07 rule "never overwrites a ref the operation did not write" in a narrow case: an unreadable first read, then an outside create of the identical sha before undo. Confirmed by reading the code; not reproduced and not covered by a test. Not a blocker. |
| `cross-repo-ops.test.ts` / `.pg.test.ts` | — | No test interleaves two live drivers on the same key | ℹ️ Info | SUMMARY lists it as unverified. D74-09 relies on compare-and-set and the create-only ref. |
| `.planning/ROADMAP.md` | Phase 74 details | "Status: Not started" conflicts with the PARTIAL entry at line 144 | ℹ️ Info | Not edited here. The owner should reconcile it. |

### Human Verification Required

### 1. Route or module-level delivery for SC1

**Test:** Decide whether SC1's "actual operation" is satisfied by the module, or whether an operator-visible route or MCP tool is required first.
**Expected:** A recorded owner decision. If a route is required, it is a separate phase with admission classification, per D74-10.
**Why human:** No caller exists in the repository (grep verified). Whether an uncalled module delivers the operation is a scope and gate decision.

### 2. Migration step 43 rehearsal

**Test:** Migrate step 43 up and down on a restored copy of production data, as was done for steps 33 to 42.
**Expected:** No error; existing row counts unchanged.
**Why human:** Operator-gated, live-data check (SUMMARY remaining gate 2).

### Gaps Summary

No blocker found in code. All three ROADMAP success criteria are observed in code and by named tests that pass in this session (fake store and real git). The status is not `passed` because SC1 is delivered only as a module with no caller, the route decision is an open owner decision, the step 43 rehearsal is operator-gated, and the live Postgres tests were not run here. One warning is recorded in Anti-Patterns (the `apply-unknown` park path can let the undo delete an unowned ref at the planned sha in a narrow race).

---

_Verified: 2026-11-12T08:38:44Z_
_Verifier: Claude (gsd-verifier)_
