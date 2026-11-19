---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-18T12:31:00Z
status: human_needed
score: 3/3 success criteria verified in code and tests at HEAD 357d6b15; owner decisions and sign-off outstanding
behavior_unverified: 0
overrides_applied: 0
covered_files:
  - .planning/ROADMAP.md
  - docs/worktree-fleet-api.md
  - packages/mcp-server/src/admission.ts
  - packages/mcp-server/src/cross-repo-fake.ts
  - packages/mcp-server/src/cross-repo-ops.pg.test.ts
  - packages/mcp-server/src/cross-repo-ops.test.ts
  - packages/mcp-server/src/cross-repo-ops.testkit.ts
  - packages/mcp-server/src/cross-repo-ops.ts
  - packages/mcp-server/src/cross-repo-store.pg.test.ts
  - packages/mcp-server/src/cross-repo-store.test.ts
  - packages/mcp-server/src/cross-repo-store.testkit.ts
  - packages/mcp-server/src/cross-repo-store.ts
  - packages/mcp-server/src/cross-repo.routes.test.ts
  - packages/mcp-server/src/index-store.ts
  - packages/mcp-server/src/repo-scope.ts
  - packages/mcp-server/src/route-policy.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/service.ts
covered_digest: "v3:sha256:20626a485627801b9e32a79a73b7f9ad45d857409a296cfbc9b14b35b19a6c74"
human_verification:
  - test: "Owner decision on the default surface policy. With SUBSTRATE_REPO_SCOPES unset, repo-scope.ts sets enforced: false and every authenticated surface is granted every registered repository, so any authenticated surface can start a fan-out or drive a compensation across all registered repositories."
    expected: "Owner confirms that policy for cross-repo writes, or requires SUBSTRATE_REPO_SCOPES to be set (enforcement on) wherever cross-repo writes run."
    why_human: "ROADMAP.md Phase 74 records this as open for the owner. It is a policy choice, not a code defect. The owner decision of 2026-11-16 is recorded in the Owner decisions section below."
  - test: "Confirm the deployment runs one mcp-server driver per index database, or decide on a cross-process guard."
    expected: "Either one driver process per Postgres index, or a lease or owner column on cross_repo_steps. Today the one-driver-per-key guarantee is the in-process KeyedLock in cross-repo-ops.ts, and the 'applying step is from a dead process' rule assumes it."
    why_human: "Depends on production replica count, which the code does not show. Store moveStep is a compare-and-set, so cross-process races cannot double-apply a step, but the recovery rule is only sound with one driver."
  - test: "Decide whether a key collision may be visible to a surface that is not granted the stored operation's repositories."
    expected: "POST /cross-repo/fanout with a key stored under a different request answers 409 key-reused, reached only after the caller's own requested repositories pass the gate. GET /cross-repo/status answers 404 for the same key when the caller cannot see it. Owner keeps 409 and documents it, or answers both cases uniformly."
    why_human: "A disclosure trade-off between idempotent-retry feedback and existence hiding. Not decidable from the code."
  - test: "Re-run the phase gate on this line and record owner sign-off, as ROADMAP.md Phase 74 requires."
    expected: "tsc --noEmit and Biome clean on this line, the affected test files green with live PostgreSQL, and the owner's sign-off recorded here."
    why_human: "ROADMAP.md states 'Verification record not yet re-run on this line; human sign-off pending.' This pass re-ran the cross-repo tests (below) but did not run tsc or Biome."
---

# Phase 74: Cross-repo compensating actions: Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Verified:** 2026-11-18T12:31:00Z
**Status:** human_needed
**Re-verification:** Yes. This pass re-reads the engine, store, service and route code at HEAD `357d6b15` and re-runs the cross-repo tests. It supersedes the earlier record in this file, whose route-handler and PG-test items are now resolved (see below).

**Scope of this pass:** `cross-repo-ops.ts` (full), `cross-repo-store.ts` (full), `server.ts` lines 1812-1867 (the three cross-repo routes), `service.ts` `withCrossRepo` and the three `crossRepo*` delegators, `repo-scope.ts` enforcement switch, and the cross-repo test files. No code was edited.

**Commands run:**
- `bun test src/cross-repo-ops.test.ts src/cross-repo-store.test.ts src/cross-repo.routes.test.ts`: 61 pass, 0 fail (in-memory store, real temporary git repositories, route-level refusal ordering).
- `bun test src/service.test.ts -t "cross-repo|cross_repo|phase 74"`: 2 pass, 0 fail.
- Temporary PostgreSQL 16 on `127.0.0.1:55432`, then `SUBSTRATE_TEST_PG_URL=… bun test src/cross-repo-ops.pg.test.ts src/cross-repo-store.pg.test.ts src/index-store.migrate.test.ts`: 17 pass, 0 fail. The temporary cluster was stopped and its data removed afterwards.

Not run: `tsc --noEmit`, Biome, and the full 101-file gate.

## Goal Achievement

### Success Criterion 1: an actual operation across at least two registered repositories, with operation and step state persisted before effects, stable dedupe keys, and idempotent per-step retry

| Check | Evidence | Status |
| --- | --- | --- |
| Spans 2 to `CROSS_REPO_MAX_REPOS` repositories, each named once | `parseBranchFanoutRequest` (cross-repo-ops.ts ~153-175) refuses a count outside `[2, MAX]` and a repeated repository | VERIFIED |
| Every repository gated before any git call or store write | `fanout` loops `gateRepo` over all repositories (line ~436) before `store.load` or `store.create`; `gateRepo` refuses no surface, unregistered repository, or ungranted surface | VERIFIED |
| Operation and steps written before any effect | `fanout` calls `store.create` (one transaction: operation row plus `pending` step rows, `on conflict do nothing`, store lines 75-102) before `drive`; `drive` moves `pending` to `applying` before each git create (`applyStep` line 288) | VERIFIED |
| Stable dedupe key with fingerprint | `fingerprintOf` is SHA-256 over branch and sorted `(repo, base)` pairs (line ~193). A stored key with a different fingerprint is refused `key-reused` (line 444, and again at 462 after a race) | VERIFIED |
| Idempotent per-step retry, no second effect | A retry with a stored key skips planning and `drive` resumes from the stored state. `applied` steps are skipped (line 360). `applying` with the ref at the planned sha is adopted, not re-created (line 293). Test: "a crash after the create landed is adopted on retry, not created again" | VERIFIED |
| Outcome read from the ref, not the exit code | `applyStep` reads `refs/heads/<branch>` back after each create (line 297) | VERIFIED |
| Create-only | `update-ref <ref> <planned> <zero>` (line 296); a ref at another value is `ref-exists` and never overwritten (line 293) | VERIFIED |

Tests: "a branch is cut in every repository and each step is recorded applied with its planned sha", "a retry with the same key runs no effect", "a request under a stored key with a different branch is refused and writes nothing", "a step is applying in the store before its create runs, and applied only after the create is read back" (cross-repo-ops.test.ts).

### Success Criterion 2: a forced failure at step N yields compensated pre-operation state or a durable needs-attention result naming the unfinished or failed steps; never success for a partial operation

| Check | Evidence | Status |
| --- | --- | --- |
| A failure at step N stops forward work | `drive` breaks at the first outcome other than `applied` (line 363) | VERIFIED |
| Applied steps are undone newest first | `drive` undo loop reverses `op.steps` (line 372-375) | VERIFIED |
| Partial is never `done` | `done` is set only when `every` step is `applied` (line 366). Otherwise `setStatus` is `needs-attention` when any step is parked, else `rolled-back` (line 378) | VERIFIED |
| Parked result names the step and reason | Step `detail` values (`ref-moved`, `undo-failed`, `undo-unknown`, `apply-unknown`, `adopted`, `already-absent`, …) are stored per step and returned in the operation | VERIFIED |
| Operator compensation undoes only | `compensate` never calls `applyStep`; in-flight `applying` steps are parked `apply-unknown` and skipped (lines 392-403) | VERIFIED |
| Rolled-back is terminal, retry makes no git call | `drive` and `compensate` return `done` and `rolled-back` untouched (lines 355, 390) | VERIFIED |

Tests: "a failed create at the second repository undoes the first and reports rolled-back, never done", "a failure at the first repository stops the run: the second is never attempted and stays pending", "a rolled-back operation is terminal: a retry performs no git call", "a failed compensating delete parks the step, and a retry completes the rollback" (cross-repo-ops.test.ts).

Criterion 2 is tested at N = 1 and N = 2. The `drive` loop is generic, so N ≥ 3 follows from the code without its own test.

### Success Criterion 3: failure and compensation failure against temporary real repositories; recovery and status expose the parked result and cannot overwrite an outside ref change or silently repeat a completed effect

| Check | Evidence | Status |
| --- | --- | --- |
| Real repositories | `cross-repo-ops.testkit.ts` creates two real git repositories in a temp directory, registered via the same env variables production reads | VERIFIED |
| Outside ref change parked and left alone | Test "a ref moved by an outside change is parked and left alone; the retry neither deletes it nor repeats a create". `undoStep` deletes only when the ref equals `plannedSha` (line 329); otherwise `ref-moved` | VERIFIED |
| Ref another writer put at the planned sha during create is never deleted | Test "a ref another writer put at the planned sha during the create is adopted, never deleted by the rollback". An `adopted` step is parked and never deleted (line 318-321) | VERIFIED |
| Branch the operation did not write is never adopted or deleted | Test "a branch that already sits at the planned sha is not adopted: it is refused, and the rollback leaves it in place"; a `pending` step that finds a ref records `ref-exists` (line 293) | VERIFIED |
| Parked result readable after restart | `cross-repo-ops.pg.test.ts` "a parked compensation is read back by a fresh index, and the ref an outside change moved is left as it is"; "a crash after a create lands is resumed by a fresh index over the same database, with no second create" | VERIFIED (live PG, run this pass) |
| Status shows the stored operation only to a granted surface | `crossRepoStatus` returns null (404) unless the surface is granted every step's repository (line 481) | VERIFIED |
| Concurrent drivers of one key | `KeyedLock` (line 242) serialises drivers in-process. Test "two overlapping drivers create each branch once" and "a driver that finds a live applying step waits for it" | VERIFIED (in-process) |

### Route boundary (earlier open item, now resolved at test level)

`server.ts` lines 1815-1867 read as follows. `/cross-repo/fanout` and `/cross-repo/status`: 401 for no surface, before the body or audit. `/cross-repo/compensate`: 401 for no surface, then 403 for a non-operator, both before the body is read or audited. Then 400 for a body that is not JSON, then `auditedRest` (fail-closed, 503 on refusal), then the engine. `withCrossRepo` answers 503 `cross-repo.disabled` before any grant check when there is no index. `cross-repo.routes.test.ts` pins this ordering (9 tests in three describe blocks; all pass). The earlier record's statement that the compensation route's audit ran before the body read was wrong: the audit runs after the body read, and the 401 and 403 checks run before both.

## Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| HARD-R1 | SATISFIED in code and tests; owner sign-off pending | Criteria 1 to 3 above; ROADMAP.md Phase 74 "human sign-off pending" |

## Gate Record Correction

The earlier record cited `/tmp/set74.log` as "101 affected files, 2896 pass". That log's own footer reads `2894 pass, 2 fail, 2896 tests across 101 files`, and the two failures are:

1. `cross-repo service (phase 74) > an anonymous caller is refused before the operation log is read or written`. This test passes at HEAD (`service.test.ts -t` above, 0 fail). The log was produced in worktree `/root/src/worktrees/as-v18-int`, not this one, so the failure is not reproduced on this line.
2. `migrate against a live index > the second migrate adds no ledger rows`. Expected 40 applicable steps, received 43, in the same other worktree. On this line, `index-store.migrate.test.ts` passes against live PostgreSQL (run this pass).

`/tmp/gate76-tests.log` shows 4 failures across 3441 tests in 113 files. None of its failing tests is in the cross-repo files. The gate record in this file should be read as "not re-run on this line"; the human item above asks for a fresh run.

## Owner decisions (2026)

These record the owner's answers. They do not change the status. The fourth item stays open.

- **Surface policy:** `SUBSTRATE_REPO_SCOPES` unset means every authenticated surface stays granted every registered repository, the current behaviour. The owner has chosen this. Cross-repo writes are not gated further by default.
- **One driver per index database:** stays the in-process per-key lock (`KeyedLock`). Not changed.
- **Key existence:** a reused key keeps answering 409 `key-reused`. The owner has chosen this.
- **Refusal order:** pinned by `cross-repo.routes.test.ts`. The code's order is as described in the Route boundary section above.

## Info

- **Apply-unknown undo.** A step parked `apply-unknown` by a crashed or in-flight create is not deleted by `compensate`, but a later `drive` (a fan-out retry) undoes it: if the ref reads at the planned sha, it is deleted. The "never delete an unproven ref" rule is applied to `adopted` steps, not to `apply-unknown`. The window is narrow, because a resumed `applying` step with a readable ref at the planned sha is adopted rather than parked. Owner may want the rule extended.
- **Doc accuracy.** `docs/worktree-fleet-api.md` says a needs-attention retry "re-inspects only the parked and applied steps". `compensate` also re-undoes `compensating` steps, which is consistent with `undoStep` (line 322).
- **Migration step.** The `cross-repo-store.ts` header now says migration 44, matching `index-store.ts` line 946.
- **Disclosure.** The 409 on key reuse is reached after the caller's own repositories pass the gate, so a granted surface learns that the key exists. This is the subject of human item 3.

## Gaps Summary

No success criterion fails. Every criterion has code evidence and a named test that drives real temporary repositories or the live Postgres adapter. Nothing blocks the phase goal in the code read in this pass.

Status is `human_needed` because the ROADMAP itself lists owner sign-off and a re-run gate as pending, and because the surface-grant default, the single-driver assumption and the key-existence disclosure are owner decisions.

## Human Verification Required

### 1. Default surface policy for cross-repo writes
**Test:** Confirm the policy for `SUBSTRATE_REPO_SCOPES` unset, or require it set for deployments that run cross-repo writes.
**Expected:** Owner confirms, or enforcement is turned on where cross-repo writes run.
**Why human:** Policy decision.

### 2. Single driver per index database
**Test:** Confirm production runs one mcp-server driver per index database, or decide on a lease or owner column on `cross_repo_steps`.
**Expected:** Either one driver, or a cross-process guard.
**Why human:** Depends on replica count.

### 3. Key-existence disclosure
**Test:** Decide whether a granted surface may learn a key exists via 409 `key-reused`.
**Expected:** Keep 409 and document it, or answer uniformly.
**Why human:** Trade-off between retry feedback and existence hiding.

### 4. Gate re-run and sign-off
**Test:** Run `tsc --noEmit`, Biome, and the affected test files with live PostgreSQL on this line; record owner sign-off.
**Expected:** Gate green; sign-off recorded here.
**Why human:** ROADMAP.md requires human sign-off. This pass did not run tsc or Biome.

---

_Verified: 2026-11-18T12:31:00Z_
_Verifier: Claude (gsd-verifier)_
