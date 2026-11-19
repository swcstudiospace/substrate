---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-18T00:00:00Z
status: human_needed
score: 3/3 success criteria verified in code with test evidence; 3 human-decision items and 2 live checks outstanding
behavior_unverified: 0
overrides_applied: 0
covered_files:
  - packages/mcp-server/src/cross-repo-ops.ts
  - packages/mcp-server/src/cross-repo-store.ts
  - packages/mcp-server/src/cross-repo-fake.ts
  - packages/mcp-server/src/cross-repo-ops.test.ts
  - packages/mcp-server/src/cross-repo-ops.pg.test.ts
  - packages/mcp-server/src/cross-repo-ops.testkit.ts
  - packages/mcp-server/src/cross-repo-store.test.ts
  - packages/mcp-server/src/cross-repo-store.pg.test.ts
  - packages/mcp-server/src/cross-repo-store.testkit.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/route-policy.ts
  - packages/mcp-server/src/admission.ts
  - docs/worktree-fleet-api.md
human_verification:
  - test: "Owner decision on the default surface policy: with SUBSTRATE_REPO_SCOPES unset, every authenticated surface is granted every registered repository, so any authenticated surface can drive a cross-repo fan-out or compensation."
    expected: "Owner either confirms that policy for cross-repo writes, or requires SUBSTRATE_REPO_SCOPES to be set (enforcement on) for any deployment that runs cross-repo writes."
    why_human: "A policy choice recorded as open in ROADMAP.md Phase 74 status (owner decision of 2026-11-16 left this open). Not a code defect."
  - test: "Confirm the deployment runs a single mcp-server process per index database, or decide on a cross-process guard."
    expected: "Either one driver process per Postgres index, or a lease/owner column on cross_repo_steps. Today the one-driver-per-key guarantee is an in-process KeyedLock; the 'a step found applying is from a dead process' rule in cross-repo-ops.ts assumes it."
    why_human: "Depends on the production replica count, which is not visible from the code read in this pass. The store's compare-and-set limits the damage across processes, but the recovery rule is only sound with one process."
  - test: "Decide whether a key collision may be visible to a surface that is not granted the stored operation's repositories."
    expected: "POST /cross-repo/fanout with a key already stored under a different request answers 409 key-reused. It is reached after the caller's own requested repositories are gated, so a surface granted some repositories learns that the key exists. GET /cross-repo/status hides the same key with 404. Owner decides: keep 409 and document it, or answer a uniform reply for both cases."
    why_human: "A disclosure trade-off between idempotent retry feedback and existence hiding. Not decidable from the code alone."
  - test: "Run the route-level refusals against a running server with live PostgreSQL: POST /cross-repo/compensate with no surface (401), with a non-operator token (403), and with an audit sink that refuses (503 error); confirm each runs before any body read or store write."
    expected: "Each refusal answers the status and fixed message in docs/worktree-fleet-api.md (Compensation table) and leaves the stored operation unchanged."
    why_human: "The route handler in server.ts (about lines 1815-1863) was not read in this pass, and the test names found by grep cover the engine and the service layer (service.test.ts 'cross-repo service (phase 74)') but not the HTTP route ordering. Needs a live or server-level check."
  - test: "Re-run the phase verification record on this line and record human sign-off, as ROADMAP.md Phase 74 requires."
    expected: "A fresh gate run on the current line (tsc, Biome, the affected test files with live PostgreSQL) and the owner's sign-off recorded in the phase record."
    why_human: "ROADMAP.md states 'Verification record not yet re-run on this line; human sign-off pending'. The gate evidence cited here is the recorded run from the assignment; it was not re-read or re-run in this pass."
---

# Phase 74: Cross-repo compensating actions: Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Verified:** 2026-11-18
**Status:** human_needed
**Re-verification:** No (initial verification of this line)

Scope of this pass: read `cross-repo-ops.ts`, `cross-repo-store.ts`, the `crossRepoFanout` / `crossRepoStatus` / `crossRepoCompensate` methods of `service.ts`, and the "Cross-repository operations (phase 74)" section of `docs/worktree-fleet-api.md`; located tests by grep. No test, tsc, lint, or git-state command was run. Gate evidence (`/tmp/set74.log`: 101 affected files, 2896 pass, live PostgreSQL; `/tmp/gate76-tests.log`; commit `be3e3ef3` on `gsd/v18-p78-on-main`) is cited from the assignment and was not re-read here.

## Goal Achievement

### Success Criterion 1: an actual operation across at least two registered repositories, with operation and step state persisted before effects, stable dedupe keys, and idempotent per-step retry

| Check | Evidence | Status |
| --- | --- | --- |
| Operation spans 2 to 16 repositories, each named once | `parseBranchFanoutRequest` in `cross-repo-ops.ts` rejects `repos` outside `[2, CROSS_REPO_MAX_REPOS]` and duplicate repositories | VERIFIED |
| Registered repositories only, gated per surface before any git call | `fanout` calls `gateRepo` for every repository before `store.load`; `gateRepo` checks surface, `scope.registry.has(repo)` and `authorizeRepo` | VERIFIED |
| Operation and steps written before any effect | `fanout` calls `ctx.store.create` (all steps `pending`, one transaction) and only then `drive`; `PgCrossRepoStore.create` runs `begin` with insert of `cross_repo_operations` and all `cross_repo_steps` before returning | VERIFIED |
| Step moves `pending` to `applying` before its git call | `applyStep` calls `moveStep(["pending"] to "applying")` before `update-ref`; test "a step is applying in the store before its create runs, and applied only after the create is read back" (cross-repo-ops.test.ts, describe "the operation persists each step before its git effect") | VERIFIED |
| Stable dedupe key, reuse refused when the request differs | Key is caller-supplied; `fanout` compares `fingerprintOf(branch, repos)` against the stored fingerprint and returns `key-reused` (409) on mismatch; test "a request under a stored key with a different branch is refused and writes nothing" | VERIFIED (key is caller-chosen, not derived; see Info) |
| Idempotent per-step retry | Stored planned shas are authoritative on retry; `drive` skips `applied` steps; terminal `done` and `rolled-back` return untouched; tests "a retry with the same key runs no effect and returns the stored operation", "a crash after the create landed is adopted on retry, not created again", "a crash before the create ran leaves the step applying, and the retry creates it once" | VERIFIED |
| Two drivers of one key do not interleave | `KeyedLock` per key in-process; tests in describe "concurrent drivers of one operation key never interleave their steps" | VERIFIED in-process only (see Human item 2) |
| Live PostgreSQL adapter | `cross-repo-ops.pg.test.ts` tests "a crash after a create lands is resumed by a fresh index over the same database, with no second create" and "a parked compensation is read back by a fresh index..."; `cross-repo-store.pg.test.ts` runs `crossRepoStoreContract` | VERIFIED by test names; live run per cited gate log |

### Success Criterion 2: a forced failure at step N yields compensated pre-operation state or durable needs-attention; never success for a partial operation

| Check | Evidence | Status |
| --- | --- | --- |
| Failure at step 2 undoes step 1, reports rolled-back, never done | test "a failed create at the second repository undoes the first and reports rolled-back, never done"; expected step states `owner/a:compensated`, `owner/b:failed/apply-failed` | VERIFIED |
| Failure at step 1 stops the run; later steps never attempted | test "a failure at the first repository stops the run: the second is never attempted and stays pending" | VERIFIED |
| Partial operation never `done` | `drive` sets `done` only when `every step applied`; otherwise `rolled-back` or `needs-attention` via `setStatus` | VERIFIED |
| Compensation failure yields durable needs-attention naming the step | `undoStep` settles `parked` with a closed detail (`undo-failed`, `undo-unknown`, `ref-moved`); `drive`/`compensate` set `needs-attention` when any step is parked; test "a failed compensating delete parks the step, and a retry completes the rollback" | VERIFIED |
| Step N other than 1 and 2 | Loop in `drive` is generic; no test uses N of 3 or more | VERIFIED by code, not by test (Info) |

Named unfinished or failed steps are carried by each step's `state` and `detail` in the stored operation, not by a separate list. This satisfies "naming", given the closed detail set (`CROSS_REPO_DETAILS`) and the docs' statement that git output and paths are never stored.

### Success Criterion 3: failure and compensation failure against temporary real repositories; recovery and status expose the parked result and never overwrite an outside ref change or silently repeat an effect

| Check | Evidence | Status |
| --- | --- | --- |
| Real git repositories in tests | `cross-repo-ops.testkit.ts` header: "two real git repositories registered through the same env variables"; `runnerWith` records every `update-ref` and can inject a failure | VERIFIED |
| Create-only, cannot overwrite an outside branch | `applyStep` uses `update-ref <ref> <planned> <zero>`; `ref-exists` refused; test "a branch that already sits at the planned sha is not adopted: it is refused..."; test "a ref another writer put at the planned sha during the create is adopted, never deleted by the rollback" | VERIFIED |
| Outside ref move is parked and left alone | `undoStep` deletes only with `update-ref -d <ref> <planned>` and parks `ref-moved` otherwise; test "a ref moved by an outside change is parked and left alone; the retry neither deletes it nor repeats a create" (cross-repo-ops.test.ts line 84 region); PG read-back test with `parked/ref-moved` | VERIFIED |
| Compensation failure exercised | test "a failed compensating delete parks the step, and a retry completes the rollback" (`parked/undo-failed`, then `compensated`) | VERIFIED |
| Undo never deletes a ref the operation did not create | `undoStep` parks `adopted` steps and never deletes them; test "undo never deletes a ref the operation did not create" describe block (includes "a step whose first ref read fails never attempted its create...") | VERIFIED |
| Recovery and status expose the parked result | `crossRepoStatus` returns the operation to a granted surface; test "a parked step is visible to the surface that drove it, with its reason" | VERIFIED |
| Operator compensation never applies a step forward | `compensate` only calls `undoStep` and `applying`-to-`parked`; test "compensation never applies a pending step: no ref is written and the pending steps stay pending" | VERIFIED |

### Behavior-dependent truths

The state transitions and cleanup invariants above (step CAS, adopt-on-retry, compensate-only-applied, parked-on-moved-ref) are each covered by a named test that drives real git or the live Postgres adapter. None are classified PRESENT_BEHAVIOR_UNVERIFIED. Their passing status rests on the recorded gate run cited above, which this pass did not re-run.

## Required Artifacts (surface and wiring)

| Artifact | Status | Evidence |
| --- | --- | --- |
| `cross-repo-ops.ts` engine | VERIFIED | Exports `runBranchFanout`, `crossRepoStatus`, `compensateBranchFanout`, `crossRepoFanoutReply`, `crossRepoStatusReply`, `crossRepoCompensateReply`; `refusalStatus` maps 400 / 403 / 404 / 409 / 422 |
| `cross-repo-store.ts` Postgres adapter | VERIFIED | `PgCrossRepoStore.create` (one transaction, `on conflict do nothing`), `load`, `moveStep` (compare-and-set via `where state = any(...)`), `setStatus`; every row read through closed-set checks (`memberOf`) |
| `cross-repo-fake.ts` in-memory adapter | VERIFIED | Run against the same contract via `crossRepoStoreContract` in `cross-repo-store.test.ts` and `cross-repo-store.pg.test.ts` |
| `service.ts` methods | VERIFIED | `crossRepoFanout` (line 6828), `crossRepoStatus` (6833), `crossRepoCompensate` (6838); `withCrossRepo` (6846) answers 503 `cross-repo.disabled` when no index store |
| `server.ts` routes | VERIFIED by grep only | `/cross-repo/fanout` (1815), `/cross-repo/status` (1833), `/cross-repo/compensate` (1846) with audit at 1828 and 1863 |
| `route-policy.ts` / `admission.ts` | VERIFIED by grep only | Route policy entries (route-policy.ts 33-35, 75-77); admission classes `write` / `read` / `write` (admission.ts 214-216, 257-259) |
| Migration step | VERIFIED | Step 44 (index-store.ts:1057; migrate-contract allowlist; rollback-compat.md row 57). The header said 43 and was corrected to 44 on this line, with the Postgres test header |

## Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| `service.ts` crossRepo* methods | `cross-repo-ops.ts` reply functions | `withCrossRepo` builds `CrossRepoDeps` with `repoScope`, `surface`, `index.crossRepoStore()` | WIRED |
| `cross-repo-ops.ts` steps | `scopedGit` (phase 72) | `git()` passes `scope`, `surface`, `repo` and args; refusal returns before any spawn | WIRED |
| `cross-repo-ops.ts` store port | `PgCrossRepoStore` | `IndexStore.crossRepoStore()` | WIRED |
| Compensate route | operator check | `crossRepoCompensateReply` passes `isOperator`; `compensateBranchFanout` refuses first | WIRED |

## Anti-patterns and Engineering Review

| File | Finding | Severity |
| --- | --- | --- |
| `cross-repo-ops.ts` `fanout` | A caller who is granted some repositories but not the stored operation's repositories gets 409 `key-reused` for a key whose stored request differs, so the existence of the key is disclosed. Status hides the same key with 404. The docs (worktree-fleet-api.md) say the status read hides it, and do not mention the fanout 409. | WARNING (Human item 3) |
| `cross-repo-ops.ts` header and `applyStep` | "A step found applying is from a dead process, never a live driver" holds only if one process drives an index database. The guard is an in-process `KeyedLock`; rows carry no owner or lease. Compare-and-set limits the damage across processes, but a live driver's in-flight step can be parked by another process's compensate. The result is `needs-attention`, not silent success; a second compensate converges. | WARNING (Human item 2) |
| `docs/worktree-fleet-api.md` needs-attention row | Says a retry "re-inspects only the parked and applied steps". The `compensate` path also re-undoes `compensating` steps, and the undo branch of `drive` was not traced line by line in this pass. | Info |
| `cross-repo-store.ts` header | "migration step 43" versus docs "migration step 44" | Resolved: header corrected to step 44 on this line (also cross-repo-store.pg.test.ts) |
| `cross-repo-ops.ts` `ctx.surface === null` in `git()` | Anonymous callers are refused before any spawn, consistent with the header | None |
| TODO, FIXME, placeholder, stub markers in the read files | None found in the read files | None |

## Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| HARD-R1 | SATISFIED (code and tests), pending owner sign-off | Criteria 1 to 3 above; ROADMAP.md Phase 74 "human sign-off pending" |

## Gaps Summary

No success criterion failed. Every criterion has code evidence and a named test that drives real repositories or the live Postgres adapter. Nothing blocks the phase goal in the code read in this pass.

Status is `human_needed` rather than `passed` because the open items need an owner or a live check, and ROADMAP.md itself records the verification record as not re-run on this line and sign-off as pending: the surface-grant default policy, the single-driver assumption for the cross-process recovery rule, the key-existence disclosure of the 409, the route-level refusal ordering that this pass did not read, and the re-run gate record.

## Human Verification Required

### 1. Default surface policy for cross-repo writes
**Test:** Confirm the owner's decision for `SUBSTRATE_REPO_SCOPES` unset (every authenticated surface granted every repository).
**Expected:** Policy confirmed for cross-repo writes, or enforcement required for deployments that run them.
**Why human:** Owner decision recorded as open in ROADMAP.md Phase 74.

### 2. Single driver per index database
**Test:** Confirm the production replica count for the substrate's index database.
**Expected:** One driver process, or an owner or lease column added before any second process drives.
**Why human:** Depends on deployment topology, not visible in the code read here.

### 3. Key-existence disclosure via 409 key-reused
**Test:** From a surface granted some repositories, send a fanout with a key stored under a different request.
**Expected:** Owner decides between the current 409 (documented) and a uniform reply that matches the status read's 404.
**Why human:** Trade-off between retry feedback and existence hiding.

### 4. Route-level refusal ordering against a live server
**Test:** Against a running server with live PostgreSQL: `POST /cross-repo/compensate` with no surface (expect 401), with a non-operator token (expect 403), and with a refusing audit sink (expect 503 `error`), checking that each runs before any body read or store write.
**Expected:** Each answer and fixed message as in the docs' Compensation table, and the stored operation unchanged.
**Why human:** Route handler lines in `server.ts` were not read in this pass, and no route-level test name was found by grep.

### 5. Re-run of the verification record on this line
**Test:** Re-run tsc, Biome and the affected test files with live PostgreSQL on the current line, and record owner sign-off in the phase record.
**Expected:** Gate green, and sign-off recorded.
**Why human:** ROADMAP.md: "Verification record not yet re-run on this line; human sign-off pending." The cited gate numbers (101 files, 2896 pass) come from the assignment and were not re-read.

## Owner decisions 2026

These record the owner's answers to the human-verification items above. The status and verdicts in this file are unchanged.

- **Surface policy:** with `SUBSTRATE_REPO_SCOPES` unset, every authenticated surface stays granted every registered repository. This is the owner's choice and the current behaviour; cross-repo writes are not gated further by default.
- **One driver per index database:** stays the in-process per-key lock (`KeyedLock` in `cross-repo-ops.ts`). It is documented there and is not changed. The recovery rule for a step found `applying` assumes one driver process per index database.
- **Key existence:** a reused key keeps answering 409 `key-reused`. This is the owner's choice.
- **Refusal order:** pinned by `packages/mcp-server/src/cross-repo.routes.test.ts`. The order the code has is 401 (no surface) and 403 (non-operator compensation), both before the body is read or audited; then 400 for a body that is not JSON; then the fail-closed audit (503 with its reason); then the missing index store (503 `cross-repo.disabled`); then the engine's grant gate (403). A fan-out on a run with no index answers 503 before its grant gate, so it does not reach 403 there. The compensation's audit refusal happens after the body is read, so it is not "before any body read" as item 4 above says.

## Info

- Criterion 2 is tested at N = 1 and N = 2 only. The loop in `drive` is generic, so N of 3 or more follows from the code without a test.
- The dedupe key is caller-supplied, not derived. "Stable dedupe key" is met by the caller choosing it and the fingerprint check; a caller who changes the key gets a new operation by design (docs: "A new attempt needs a new key").
- Commit `be3e3ef3` and the gate logs are cited as recorded evidence only.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
