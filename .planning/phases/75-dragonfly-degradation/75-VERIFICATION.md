---
phase: 75-dragonfly-degradation
verified: 2026-11-20T01:26:13Z
status: passed
score: 2/2 must-haves verified
covered_files:
  - .planning/REQUIREMENTS.md
  - .planning/phases/75-dragonfly-degradation/75-01-PLAN.md
  - .planning/phases/75-dragonfly-degradation/75-CONTEXT.md
  - docs/config-reference.md
  - docs/observability.md
  - packages/mcp-server/src/admission.test.ts
  - packages/mcp-server/src/admission.ts
  - packages/mcp-server/src/cache-breaker.test.ts
  - packages/mcp-server/src/cache.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/flag-registry.ts
  - packages/mcp-server/src/http.admission.test.ts
  - packages/mcp-server/src/server.ts
  - packages/observability/src/slo.ts
covered_digest: "v3:sha256:ec3019fab21af865606db3355cd4c1b4d4fcd05af5eb8b80d39ba7357a93924a"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: 5
  total: 5
  not_honored: []
re_verification:
  previous_status: passed
  previous_score: 2/2
  gaps_closed: []
  gaps_remaining: []
  regressions: []
operator_gated:
  - item: "Live cache-plane proof against production Dragonfly"
    reason: "Plan acceptance marks this outside the tasks. Repo criteria are the named tests, not a live plane."
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-20T01:26:13Z
**Status:** passed
**Re-verification:** Yes — re-verification of prior passed (2/2). No gaps were open; regression check only.

code review skipped (Greptile unavailable, owner override 2026-11-20 — CI gates apply)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | With the cache breaker open, brief and recall return authoritative results. A test proves it. | ✓ VERIFIED | `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it", `:99` "recall returns the same reply as a substrate with no cache at all", `:118` "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands". `cache.ts:176` `ScriptOutcome` sets `breakerRetryAfterMs` only for `BreakerOpenError` (`cache.ts:1082`); `staleGenerations` (`cache.ts:505,584,868`) keeps a refused bump off the cache until a later bump. Re-ran 2026-11-20: `bun test` on the three phase test files — 85 pass, 0 fail. |
| 2 | Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags. | ✓ VERIFIED | `config.ts:1847-1848` `loadAdmissionSettings` parses `SUBSTRATE_BUDGET_{READ,WRITE,COORDINATION}_BREAKER` via `breakerPolicyOf` (`config.ts:1868`); unset/blank is `fail-open`, other values throw `ConfigError` naming the variable; `loadConfig` calls `loadAdmissionSettings` unguarded (`config.ts:1244`). `admission.ts:440-442` returns `refused` only for a breaker refusal on `fail-closed` in `enforce`; shadow/fail-open and non-breaker failures return `bypass`. `admission.ts:508-509` `budgetBody` uses `cache_unavailable` for `refused`; `isRefusal` (`admission.ts:475-476`) treats `refused` like `limited`. `server.ts:640-641` `sendBudgetRefusal` sends 503 + `Retry-After` for `refused`, 429 for `limited`. Named tests: `admission.test.ts:330` "with no flag set every class is fail-open", `:339` "a fail-closed class is refused in enforce", `:346` "a breaker refusal of a fail-closed class is a bypass in shadow", `:355` "only a breaker refusal is policed", `http.admission.test.ts:274` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one". |

**Score:** 2/2 truths verified

### Operator-gated (not a repo gap)

A live proof against the production cache plane is outside this plan. It is not claimed and does not fail either roadmap criterion.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cache.ts` | breaker-aware fallback, `staleGenerations` | ✓ VERIFIED | Substantive (1291 lines), wired via `service.ts` `ReadThroughCache` gate; `breakerRetryAfterMs` only on `BreakerOpenError`. |
| `packages/mcp-server/src/admission.ts` | per-class fail-open/closed `refused`/`bypass` | ✓ VERIFIED | Substantive (532 lines), wired; `budgetBody` `cache_unavailable`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings` flag parsing | ✓ VERIFIED | Substantive (2613 lines); `ConfigError` names the variable; unguarded call in `loadConfig`. |
| `packages/mcp-server/src/server.ts` | 503 + `Retry-After` for `refused` | ✓ VERIFIED | `sendBudgetRefusal` at `server.ts:640-641`. |
| `packages/mcp-server/src/flag-registry.ts` | `CLASS_BREAKER_NAMES` family | ✓ VERIFIED | `flag-registry.ts:189` members from `ADMISSION_CLASSES`. |
| `packages/observability/src/slo.ts` | `refused` out of SLO numerator | ✓ VERIFIED | `slo.ts:349,368` documents exclusion by design (R3). |
| `packages/mcp-server/src/cache-breaker.test.ts` | C1 named tests | ✓ VERIFIED | 156 lines; `:73`, `:99`, `:118`, `:146`. |
| `packages/mcp-server/src/admission.test.ts` | C2 policy matrix + flag parsing | ✓ VERIFIED | 754 lines; `:330`, `:339`, `:346`, `:355`. |
| `packages/mcp-server/src/http.admission.test.ts` | HTTP 200/503 pair | ✓ VERIFIED | 416 lines; `:274` asserts `{error:"cache_unavailable", class:"read", retry_after_s:2}`. |
| `docs/config-reference.md`, `docs/observability.md` | flags + fallback documented | ✓ VERIFIED | Covered by fingerprint; hand-rendered rows present. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `cache.ts` `script` | admission `admission.ts:440` | `ScriptOutcome.breakerRetryAfterMs` | ✓ WIRED | Set only on `BreakerOpenError` (`cache.ts:1082`); admission polices only that signal. |
| `service.ts` | `ReadThroughCache` | `gate("cache")` | ✓ WIRED | Unchanged since prior pass; tests exercise the gated path. |
| `config.ts` `loadConfig` | `loadAdmissionSettings` | unguarded call (`config.ts:1244`) | ✓ WIRED | Invalid `_BREAKER` value refuses boot. |
| `server.ts` `sendBudgetRefusal` | HTTP client | 503 + `Retry-After`, body from `budgetBody` | ✓ WIRED | Both REST and MCP refusal paths. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| brief under open breaker | composed brief | index `load`, not cache hit | Yes, in named test | ✓ FLOWING |
| recall under open breaker | recall reply | Hindsight fake equal to uncached substrate | Yes, in named test | ✓ FLOWING |
| fail-closed refusal body | `error`, `retry_after_s` | breaker wait on `ScriptOutcome` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| C1 and C2 named tests | `bun test packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts` (re-run 2026-11-20, no live Dragonfly) | 85 pass, 0 fail, 1337 expect() calls, 1.37s | ✓ PASS |
| Live Dragonfly | — | operator-gated, not a task | SKIP |

### Probe Execution

No phase probe scripts. Step 7c not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-R2 | 75-01 (phase 75) | Reuse cache-plane breaker. On outage, reads fall back or report degradation. No authoritative state only in the cache. | ✓ SATISFIED | Breaker reuse via `callPlane`/`BreakerOpenError`. Brief/recall tests fall through to source. Fail-closed answers 503 `cache_unavailable` with `Retry-After`. Default fail-open still admits with source answer. Live plane proof operator-gated. |

### Decision Coverage

All trackable CONTEXT.md decisions honored (5/5: D75-1, D75-2, D75-2a, D75-3, D75-4). Non-blocking. No source edits made by this verification.

### Anti-Patterns Found

None in phase paths that block the goal. `refused` excluded from admission SLO numerator by design (R3). Cross-process staleness after refused bump (R1) documented, bounded by 5-minute brief TTL, out of scope.

### Human Verification Required

N/A — infrastructure phase. Acceptance is the named tests, all passing without live Dragonfly. Live cache plane is an operator checkpoint outside the plan, not a repo failure. No UAT.md created.

### Gaps Summary

None. Both roadmap criteria hold on current code; re-run confirms prior pass. No live Dragonfly proof claimed.

---

_Verified: 2026-11-20T01:26:13Z_
_Verifier: Claude (gsd-verifier)_

## Addendum — retained origin/main evidence (2026-11-19, HEAD `ee998735`)

Merge note: HEAD above (2026-11-20 re-verification, passed 2/2, named tests re-run 85 pass / 0 fail) is the primary verdict and supersedes the origin/main record (`human_needed`, 4/5 sub-truths, v3). The finer origin/main truth split is retained below as evidence; its items are operator/live or residual-risk, not repo gaps, consistent with HEAD's `operator_gated` live-plane item.

**Truth split (origin/main, maps onto HEAD truths 1–2):** 1a brief under open breaker → authoritative index result, and 1b recall → authoritative Hindsight result, both `VERIFIED` by the same named tests cited in truth 1; 2a per-class admission policy and 2b flag declaration/boot-refusal, both `VERIFIED` as in truth 2. **1c (retained residual):** degraded-brief sub-truth — breaker open with the live source failing, the refused snapshot read leaves the brief `degraded` with no stale serve (`service.ts:2477,2542` `snapshotSurvivesForget`, `cache.ts:889`) — was `PRESENT_BEHAVIOR_UNVERIFIED` in origin/main because no test combined an open breaker with a failing live source. It is a sub-truth, not a ROADMAP criterion; retained here as a residual risk, not a gap under HEAD's passed verdict.

**Operator/live items recorded only in origin/main (H-1–H-5, retained):** H-1 the 1c combined path above; H-2 live Dragonfly stop, then `POST /brief`/`/memory/recall` at default flags answer 200 from the authoritative source within timeout with health `degraded`; H-3 live fail-closed 503 `cache_unavailable` with `Retry-After` and one `substrate.admission.decisions{decision="refused"}` increment; H-4 refused-decision series in the real pipeline (`/metrics`, OTel/Greptime export, dashboards) plus operator acceptance of the read policy (D75-2); H-5 explicit decision on whether a fail-closed class may admit during the 5 s connect cooldown, where `cache.ts:408-409` rejects with a plain `Error`, not `BreakerOpenError`, while the breaker may still be closed. Also retained: anti-pattern notes that `staleGenerations` (`cache.ts:502`) is an in-process `Set` (residual R1, bounded by the 5-minute brief TTL) and that CONTEXT.md D75-2's `shadow` wording drifts from the tested `bypass` behavior.
