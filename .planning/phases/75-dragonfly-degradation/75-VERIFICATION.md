---
phase: 75-dragonfly-degradation
verified: 2026-11-16T12:00:00Z
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
covered_digest: "v4:sha256:ff06240a2f9b5c00611a4e19fc9f69d66da0c97dd2503862c1657929b430451c"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: 5
  total: 5
  not_honored: []
operator_gated:
  - item: "Live cache-plane proof against production Dragonfly"
    reason: "Plan acceptance marks this outside the tasks. Repo criteria are the named tests, not a live plane."
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-16T12:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | With the cache breaker open, brief and recall return authoritative results. A test proves it. | ✓ VERIFIED | `cache-breaker.test.ts` names "brief is composed from the index on every call, and the cache never answers it", "recall returns the same reply as a substrate with no cache at all", and "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands". `ReadThroughCache.script` sets `breakerRetryAfterMs` only for `BreakerOpenError`. `staleGenerations` keeps a refused bump off the cache until a later bump. Orchestrator, after `ec2ced00`: `bun test` on this file with the other two, 85 pass, 0 fail. Not re-run here. |
| 2 | Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags. | ✓ VERIFIED | `loadAdmissionSettings` parses `SUBSTRATE_BUDGET_{READ,WRITE,COORDINATION}_BREAKER` via `breakerPolicyOf`; unset/blank is `fail-open`; other values throw `ConfigError` and `loadConfig` calls it unguarded. `admission.ts` returns `refused` only for a breaker refusal on `fail-closed` in `enforce`; shadow and fail-open return `bypass`. `budgetBody` uses `cache_unavailable` for `refused`. `sendBudgetRefusal` sends 503 with `Retry-After` for `refused` and 429 for `limited`. Named tests in `admission.test.ts` and HTTP test "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" cover the plan's C2 list. Same orchestrator run: 85 pass, 0 fail. `tsc --noEmit` and `bun run lint` exit 0 at that commit, not re-run here. |

**Score:** 2/2 truths verified

### Operator-gated (not a repo gap)

A live proof against the production cache plane is outside this plan. It is not claimed and does not fail either roadmap criterion.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | ----------- | ------ | ------- |
| `packages/mcp-server/src/config.ts` | Per-class breaker flags, invalid value refuses boot | ✓ VERIFIED | `breakerPolicyOf` at the admission settings loader; only `fail-open` / `fail-closed` after trim and case fold |
| `packages/mcp-server/src/flag-registry.ts` | Family `SUBSTRATE_BUDGET_<CLASS>_BREAKER` from admission classes only | ✓ VERIFIED | `CLASS_BREAKER_NAMES` from `ADMISSION_CLASSES` |
| `packages/mcp-server/src/admission.ts` | Fail-closed enforce refuses; shadow and non-breaker failures bypass | ✓ VERIFIED | Decision branch on `breakerRetryAfterMs` + policy + mode; `budgetBody` error split |
| `packages/mcp-server/src/server.ts` | 503 + Retry-After for `refused` | ✓ VERIFIED | `sendBudgetRefusal` |
| `packages/mcp-server/src/cache.ts` | Authoritative fallback; refused generation stays stale until bump | ✓ VERIFIED | `staleGenerations`; script outcome distinguishes breaker refusal |
| `packages/observability/src/slo.ts` | `refused` stays out of the admission SLO numerator | ✓ VERIFIED | Denominator is `allowed` + `limited` + `shadow_limited` |
| `packages/mcp-server/src/cache-breaker.test.ts` | C1 tests, no live Redis | ✓ VERIFIED | Three named tests plus admission-over-open-breaker |
| `packages/mcp-server/src/admission.test.ts` | C2 policy matrix and flag parsing | ✓ VERIFIED | Named tests present |
| `packages/mcp-server/src/http.admission.test.ts` | Fail-open 200 and fail-closed 503 | ✓ VERIFIED | Combined in one named test; "a harness with no cache at all" remains |
| `docs/observability.md` | Flags, shadow bypass, source fallback, R1 | ✓ VERIFIED | Paragraph beside the cache breaker (commit `ec2ced00`) |
| `docs/config-reference.md` | Hand-rendered breaker row | ✓ VERIFIED | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` row |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `admission.ts` | `cache.ts` `ScriptOutcome.breakerRetryAfterMs` | Open-breaker refusal before a command is sent | WIRED | Only `BreakerOpenError` sets the field; connect/timeout stays `bypass` |
| `server.ts` `sendBudgetRefusal` | `admission.ts` `budgetBody` | REST and MCP `admitBatch` | WIRED | 503 `cache_unavailable` vs 429 `budget` |
| `config.ts` `loadAdmissionSettings` | `flag-registry.ts` `CLASS_BREAKER_NAMES` | Same three admission classes | WIRED | `budget` and `gen` are not admission classes |
| brief / recall | index / Hindsight | `getOrLoad` load path; tests compare to uncached reply | WIRED | Store of truth is not Dragonfly |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| brief under open breaker | composed brief | index `load`, not cache hit | Yes, in the named test | ✓ FLOWING |
| recall under open breaker | recall reply | Hindsight fake equal to uncached substrate | Yes, in the named test | ✓ FLOWING |
| fail-closed refusal body | `error`, `retry_after_s` | breaker wait on `ScriptOutcome` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| C1 and C2 named tests | Orchestrator `bun test` on `cache-breaker.test.ts`, `admission.test.ts`, `http.admission.test.ts` after `ec2ced00` | 85 pass, 0 fail | ✓ PASS (not re-run) |
| Typecheck and lint | Orchestrator `tsc --noEmit` and `bun run lint` at that commit | exit 0 | ✓ PASS (not re-run) |
| Live Dragonfly | — | operator-gated, not a task | SKIP |

### Probe Execution

No phase probe scripts. Step 7c not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-R2 | 75-01 (phase 75) | Reuse the cache-plane breaker. On outage, reads fall back or report degradation. Reject writes that cannot be made durable with retryable errors. No authoritative state only in the cache. | ✓ SATISFIED | Breaker reuse via `callPlane` / `BreakerOpenError`. Brief and recall tests fall through to the source. Fail-closed classes answer 503 `cache_unavailable` with `Retry-After`. Default fail-open still admits, and the answer is the source, not a cache-only write. Live plane proof is operator-gated. |

### Decision Coverage

All trackable CONTEXT.md decisions are honored by shipped artifacts. 5/5 (D75-1, D75-2, D75-2a, D75-3, D75-4). Non-blocking.

### Anti-Patterns Found

None in the phase paths that block the goal. `refused` is intentionally excluded from the admission SLO numerator (R3). Cross-process staleness after a refused bump (R1) is documented, bounded by the 5-minute brief TTL, and out of scope.

### Human Verification Required

N/A — infrastructure phase. Acceptance is the named tests. The live cache plane is an operator checkpoint outside the plan, not a repo failure.

### Gaps Summary

None. Both roadmap criteria are met by the named tests and the wired code. No live Dragonfly proof is claimed.

---

_Verified: 2026-11-16T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
