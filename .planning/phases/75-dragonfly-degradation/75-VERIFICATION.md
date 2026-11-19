---
phase: 75-dragonfly-degradation
verified: 2026-11-19T14:05:48Z
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
covered_digest: "v4:sha256:1f79545b77f2b893d3d18fa222a34d8c8cc0950775a5687213a5ef4bfa223f8d"
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
**Verified:** 2026-11-19T14:05:48Z
**Status:** passed
**Re-verification:** Yes — re-verification of prior passed (2/2). No gaps were open; regression check only.

code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | With the cache breaker open, brief and recall return authoritative results. A test proves it. | ✓ VERIFIED | `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it", `:99` "recall returns the same reply as a substrate with no cache at all", `:118` "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands". `cache.ts:176` `ScriptOutcome` sets `breakerRetryAfterMs` only for `BreakerOpenError` (`cache.ts:1082`); `staleGenerations` (`cache.ts:505,584,868`) keeps a refused bump off the cache until a later bump. Re-ran 2026-11-19: `bun test` on the three phase test files — 85 pass, 0 fail. |
| 2 | Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags. | ✓ VERIFIED | `config.ts:1847-1848` `loadAdmissionSettings` parses `SUBSTRATE_BUDGET_{READ,WRITE,COORDINATION}_BREAKER` via `breakerPolicyOf` (`config.ts:1868`); unset/blank is `fail-open`, other values throw `ConfigError` naming the variable; `loadConfig` calls `loadAdmissionSettings` unguarded (`config.ts:1244`). `admission.ts:440-442` returns `refused` only for a breaker refusal on `fail-closed` in `enforce`; shadow/fail-open and non-breaker failures return `bypass`. `admission.ts:508-509` `budgetBody` uses `cache_unavailable` for `refused`; `isRefusal` (`admission.ts:475-476`) treats `refused` like `limited`. `server.ts:640-641` `sendBudgetRefusal` sends 503 + `Retry-After` for `refused`, 429 for `limited`. Named tests: `admission.test.ts:330` "with no flag set every class is fail-open", `:339` "a fail-closed class is refused in enforce", `:346` "a breaker refusal of a fail-closed class is a bypass in shadow", `:355` "only a breaker refusal is policed", `:380` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot"; `http.admission.test.ts:274` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one". Same 85-pass run covers them. |

**Score:** 2/2 truths verified

### Operator-gated (not a repo gap)

A live proof against the production cache plane is outside this plan. It is not claimed and does not fail either roadmap criterion.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | ----------- | ------ | ------- |
| `packages/mcp-server/src/config.ts` | Per-class breaker flags, invalid value refuses boot | ✓ VERIFIED | `breakerPolicyOf` (`config.ts:1868`); only `fail-open`/`fail-closed` after trim+case fold |
| `packages/mcp-server/src/flag-registry.ts` | Family `SUBSTRATE_BUDGET_<CLASS>_BREAKER` from admission classes only | ✓ VERIFIED | `CLASS_BREAKER_NAMES` (`flag-registry.ts:189`), members from `ADMISSION_CLASSES` |
| `packages/mcp-server/src/admission.ts` | Fail-closed enforce refuses; shadow and non-breaker failures bypass | ✓ VERIFIED | Branch on `breakerRetryAfterMs`+policy+mode (`admission.ts:440-442`); `budgetBody` split (`:508`) |
| `packages/mcp-server/src/server.ts` | 503 + Retry-After for `refused` | ✓ VERIFIED | `sendBudgetRefusal` (`server.ts:640-641`) |
| `packages/mcp-server/src/cache.ts` | Authoritative fallback; refused generation stays stale until bump | ✓ VERIFIED | `staleGenerations` (`cache.ts:505`); breaker-only `breakerRetryAfterMs` (`cache.ts:1082`) |
| `packages/observability/src/slo.ts` | `refused` stays out of admission SLO numerator | ✓ VERIFIED | `slo.ts:349,368` — `bypass`/`refused` excluded from numerator+denominator |
| `packages/mcp-server/src/cache-breaker.test.ts` | C1 tests, no live Redis | ✓ VERIFIED | 3 named C1 tests + admission-over-open-breaker (`:146`) |
| `packages/mcp-server/src/admission.test.ts` | C2 policy matrix and flag parsing | ✓ VERIFIED | Named tests at `:330,339,346,355,380` |
| `packages/mcp-server/src/http.admission.test.ts` | Fail-open 200 and fail-closed 503 | ✓ VERIFIED | Combined test `:274`; "a harness with no cache at all" remains |
| `docs/observability.md` | Flags, shadow bypass, source fallback, R1 | ✓ VERIFIED | Paragraph beside cache breaker |
| `docs/config-reference.md` | Hand-rendered breaker row | ✓ VERIFIED | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` row (`config-reference.md:275`) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `admission.ts` | `cache.ts` `ScriptOutcome.breakerRetryAfterMs` | Open-breaker refusal before a command is sent | WIRED | Only `BreakerOpenError` sets field (`cache.ts:1082`); connect/timeout stays `bypass` |
| `server.ts` `sendBudgetRefusal` | `admission.ts` `budgetBody` | REST and MCP `admitBatch` | WIRED | 503 `cache_unavailable` vs 429 `budget` |
| `config.ts` `loadAdmissionSettings` | `flag-registry.ts` `CLASS_BREAKER_NAMES` | Same three admission classes | WIRED | `budget`/`gen` are not admission classes |
| brief / recall | index / Hindsight | `getOrLoad` load path; tests compare to uncached reply | WIRED | Store of truth is not Dragonfly |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| brief under open breaker | composed brief | index `load`, not cache hit | Yes, in named test | ✓ FLOWING |
| recall under open breaker | recall reply | Hindsight fake equal to uncached substrate | Yes, in named test | ✓ FLOWING |
| fail-closed refusal body | `error`, `retry_after_s` | breaker wait on `ScriptOutcome` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| C1 and C2 named tests | `bun test packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts` (re-run 2026-11-19, no live Dragonfly) | 85 pass, 0 fail, 1337 expect() calls, 8.15s | ✓ PASS |
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

_Verified: 2026-11-19T14:05:48Z_
_Verifier: Claude (gsd-verifier)_
