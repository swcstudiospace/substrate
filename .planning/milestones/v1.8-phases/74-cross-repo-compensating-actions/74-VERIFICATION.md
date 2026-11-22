---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-19T12:00:00Z
status: human_needed
score: 3/3 success criteria verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/74-cross-repo-compensating-actions/74-01-PLAN.md", ".planning/phases/74-cross-repo-compensating-actions/74-01-SUMMARY.md", "docs/worktree-fleet-api.md", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cross-repo-ops.ts", "packages/mcp-server/src/cross-repo-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:af6f9bc5a12f862516e129ebb47d7c4b8d111dcf0baf84028fe0fa9d5d8719de"
overrides_applied: 0
behavior_unverified: 0
re_verification:
  previous_status: human_needed
  previous_score: 3/3
  gaps_closed:
    - "SC1 route decision (prior human_needed ground: no production caller) — production route and MCP tools now exist and wire to runBranchFanout via the service layer"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Rehearse migration step 43 (cross_repo_operations, cross_repo_steps) on a restored dump before production, as steps 33 to 42 were."
    expected: "Migrate up and down on the restored copy with no error; existing row counts unchanged."
    why_human: "Operator-gated live-data check (SUMMARY remaining gate 2). Not runnable from this workspace against production. Resume: operator runs the index-store migrate up/down rehearsal against a restored dump on a quiesced host, then records the result; do not run in this verification."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Verified:** 2026-11-19T12:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after route landing (commit 8b8521b9 and related). Prior report (2026-11-12) was used as leads, not evidence.

code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

## Module-vs-route answer (SC1)

Prior verification found `runBranchFanout` referenced only from its own tests and recorded SC1 as human_needed on that ground. That is no longer true. Grep evidence (`crossRepoFanoutReply|crossRepoStatusReply|crossRepoCompensateReply|/cross-repo/` over `packages/mcp-server/src`):

- `packages/mcp-server/src/server.ts:1843` — `POST /cross-repo/fanout` handler, audited fail-closed under `cross_repo_fanout`, calls `substrate.crossRepoFanout(parsed, surface)`; `server.ts:1857` `GET /cross-repo/status`; `server.ts:1866` `POST /cross-repo/compensate` (operator-only, 401/403 before body read).
- `packages/mcp-server/src/service.ts:6974-6986` — `crossRepoFanout` / `crossRepoStatus` / `crossRepoCompensate` delegate via `withCrossRepo` to `crossRepoFanoutReply` / `crossRepoStatusReply` / `crossRepoCompensateReply` in `cross-repo-ops.ts:549,558,566`, with deps `{ scope, surface, store: this.index.crossRepoStore() }` (`service.ts:6993`); 503 `cross-repo.disabled` when no index store.
- `packages/mcp-server/src/mcp.ts:1681,1713,1731` — MCP tools `cross_repo_fanout`, `cross_repo_status`, `cross_repo_compensate` registered, calling the same service methods.
- `packages/mcp-server/src/admission.ts:216-218,305-307` — route/tool admission classes (`write`/`read`/`write`); `packages/mcp-server/src/route-policy.ts:35-37,77-79` — repo-gated declarations naming the grant/allowlist check; `packages/mcp-server/src/observe.ts:702-704` — observability names.
- `packages/mcp-server/src/cross-repo-ops.ts:459` — `runBranchFanout` holds `operationLocks.run(key, …)` (`cross-repo-ops.ts:284`); `cross-repo-ops.ts:548-566` reply functions call `runBranchFanout` / `crossRepoStatus` / `compensateBranchFanout`; `IndexStore.crossRepoStore()` (`index-store.ts:1189`) builds `PgCrossRepoStore` (`cross-repo-store.ts`), whose transitions are compare-and-set `update`s with closed-set row checks.

Conclusion: SC1 is delivered as an operator-visible operation (REST + MCP), not module-only. The prior owner-decision item is closed; SC1 is not human_needed on that ground.

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
| --- | --- | --- | --- |
| SC1 | Actual operation across ≥2 registered repos persists operation/step state before effects, stable dedupe keys, idempotent per-step retry. | ✓ VERIFIED | Route + MCP wiring above; `runBranchFanout`/`fanout` (`cross-repo-ops.ts:459-483`) validates, gates each repo, fingerprint-checks stored key (`key-reused`), drives stored steps (terminal ops return untouched); tests `cross-repo-ops.test.ts:8,20,29,131,153` (branch cut in every repo, retry no effect, crash adoption). |
| SC2 | Forced failure at step N yields compensated state or durable needs-attention naming unfinished/failed compensation; never success for partial. | ✓ VERIFIED | `drive` undoes newest-first, sets `needs-attention` if any step parked else `rolled-back` (`cross-repo-ops.ts:440-460` region); tests `cross-repo-ops.test.ts:53,84,107,509,520` (failure at second repo, ref-moved park, failed delete park + retry, operator compensate). |
| SC3 | Exercised against temporary real repositories; recovery/status exposes parked result, cannot overwrite outside ref change or silently repeat completed effect. | ✓ VERIFIED | Tests use real git repos via `cross-repo-ops.testkit.ts`; status gated by grant+allowlist (`crossRepoStatus`, `cross-repo-ops.ts:484-510`); tests `cross-repo-ops.test.ts:41,191,278,295,342`. |

**Score:** 3/3 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cross-repo-ops.ts` | operation, fingerprint, step/undo logic, reply functions | ✓ VERIFIED | Substantive (~578 lines); `runBranchFanout`, `crossRepoStatus`, `compensateBranchFanout`, `crossRepo*Reply` all defined and wired from service/mcp/server. |
| `packages/mcp-server/src/cross-repo-store.ts` | Pg adapter, CAS transitions | ✓ VERIFIED | `PgCrossRepoStore`; closed-set row checks; built by `IndexStore.crossRepoStore()`. |
| `packages/mcp-server/src/server.ts`, `service.ts`, `mcp.ts`, `admission.ts`, `route-policy.ts` | production route/tool exposure | ✓ VERIFIED | Lines cited above; admission + policy + observe consistent. |
| `docs/worktree-fleet-api.md:165-211` | docs name route/tools | ✓ VERIFIED | States exposed as `POST /cross-repo/fanout` + `cross_repo_fanout` etc. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `server.ts` REST handlers | `service.ts` crossRepo* | `substrate.crossRepoFanout/Status/Compensate` | ✓ WIRED | server.ts:1843-1885 → service.ts:6974-6986 |
| `mcp.ts` tools | `service.ts` crossRepo* | `substrate.crossRepo*` | ✓ WIRED | mcp.ts:1681,1713,1731 |
| `service.ts` withCrossRepo | `cross-repo-ops.ts` reply fns | `crossRepo*Reply(raw, deps)` | ✓ WIRED | service.ts:6993 deps include `index.crossRepoStore()` |
| `crossRepoFanoutReply` | `runBranchFanout` | direct call under key lock | ✓ WIRED | cross-repo-ops.ts:549,459 |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-R1 | 74-01-PLAN C1–C3 | Cross-repo compensating actions | ✓ SATISFIED (code+route) | SC1–SC3 above. Note REQUIREMENTS.md table still says "Not started" and ROADMAP.md:144 says PARTIAL/no route, ROADMAP.md:1311 says "Not started" — stale planning text, not code; flagged below, not edited here. |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
| ---- | ------- | -------- | ------ |
| `cross-repo-ops.ts` undoStep | Parked (`apply-unknown`) step can move to `compensating` and delete a ref at the planned sha without proving this operation created it, in a narrow race (unreadable first read, then outside create of identical sha before undo) | ⚠️ Warning | Prior-report warning persists in current code shape; not reproduced, no test covers it; not a blocker for SC1–SC3. |
| `.planning/ROADMAP.md:144,1311`, `.planning/REQUIREMENTS.md` HARD-R1 row | Stale status text contradicting landed route | ℹ️ Info | Planning-doc drift only; owner to reconcile. |

### Human Verification Required

### 1. Migration step 43 rehearsal

**Test:** Migrate step 43 (`cross_repo_operations`, `cross_repo_steps`) up and down on a restored copy of production data, as was done for steps 33 to 42.
**Expected:** No error; existing row counts unchanged.
**Why human:** Operator-gated live-data check (SUMMARY remaining gate 2). Resume: operator runs the index-store migrate up/down rehearsal against a restored dump on a quiesced host, then records the result. See `74-UAT.md`.

### Gaps Summary

No code blocker. SC1's prior human_needed ground (no production caller) is closed by the landed REST+MCP route. Overall status remains `human_needed` solely for the operator-gated migration step 43 rehearsal, recorded in `74-UAT.md`. Gates/formatters were skipped per assignment; Greptile review was not run (owner override 2026-11-19).

---
_Verified: 2026-11-19T12:00:00Z_
_Verifier: Claude (gsd-verifier)_

## Addendum — retained origin/main evidence (2026-11-19, HEAD ee998735)

Merge note: HEAD above (2026-11-19T12:00:00Z, covered_digest v4) is retained as the primary record — it closes SC1's prior "no production caller" ground with the landed REST+MCP route (`server.ts:1843-1866`, `service.ts:6974-6986`, `mcp.ts:1681,1713,1731`). The origin/main record below is retained as additive evidence, not as a competing verdict: both records agree status stays `human_needed` and SC1–SC3 are verified in code.

**Drift check (origin/main):** `git diff 357d6b15..HEAD` over the cross-repo implementation (`cross-repo-ops.ts`, `cross-repo-store.ts`, `cross-repo-ops.test.ts`, `cross-repo-ops.testkit.ts`, `repo-scope.ts`) is empty; the only touched file was `cross-repo.routes.test.ts` (5 lines, cosmetic env-token helper). Implementation evidence is therefore unchanged from the prior pass. Named tests cited there: `cross-repo-ops.test.ts` branch-cut/retry/crash-adoption, failure-at-step-N/park/retry, real-temp-repo adoption/ref-move, and PG crash-resume in `cross-repo-ops.pg.test.ts:34,56`.

**Additional operator/live items from origin/main (retained, beyond migration step 43 above):**

1. **Gate re-run and owner sign-off on HEAD `ee998735`** — expected: gate green (`tsc --noEmit`, Biome, affected cross-repo test files with live PostgreSQL) and owner sign-off recorded, as ROADMAP.md Phase 74 requires ("human sign-off pending"). Why human: that pass was barred from running tests/tsc/Biome.
2. **Single driver per index database** — expected: either one `mcp-server` driver per Postgres index, or a cross-process guard (lease/owner column on `cross_repo_steps`). Why human: today the one-driver-per-key guarantee is the in-process `KeyedLock` (`cross-repo-ops.ts:242,261`); `moveStep` is compare-and-set so cross-process races cannot double-apply, but the resume-from-`applying` rule assumes one driver. Depends on production replica count, which code does not show.
3. **Default surface policy confirmation** — expected: owner confirms that with `SUBSTRATE_REPO_SCOPES` unset, `repo-scope.ts` granting every authenticated surface every registered repository is acceptable for cross-repo writes, or requires `SUBSTRATE_REPO_SCOPES` set wherever cross-repo writes run. Why human: policy choice, recorded as open for the owner in ROADMAP.md Phase 74.

_Headline verdict above is unchanged by this addendum: no code gaps; remaining items are operator/live._
