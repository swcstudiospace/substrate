---
phase: 75-dragonfly-degradation
verified: 2026-11-18T12:24:20Z
status: human_needed
score: 4/5 truths verified (2/2 ROADMAP success criteria verified; 1 sub-truth behavior-unverified)
covered_files: [".planning/phases/75-dragonfly-degradation/75-CONTEXT.md", "packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/server.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:5d3192377b65d5d3b21f0a502295ec0c61bddaec42829818a2f49b11eab57288"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "Degraded brief with the cache breaker open: the live source fails, the refused snapshot read leaves the brief in state degraded, and no stale answer is served from the cache"
    test: "Open the cache breaker (PlaneRegistry failureThreshold 1, or a real plane failure), make the brief's live source throw (for example getGraph), call briefDetailed for the same repo and graph"
    expected: "state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw"
    why_human: "No test opens the breaker and fails the live source together. The degraded-brief tests in brief-fast-path.test.ts use a healthy or merely failing FakeRedis with no breaker. The snapshot-refusal branch (service.ts:2542-2544, snapshotSurvivesForget) under an open breaker is unexercised"
coincidental_reliance_items: []
gaps: []
human_verification:
  - test: "With the full stack running, stop the live Dragonfly, then call POST /brief and POST /memory/recall with default flags (nothing set)"
    expected: "Both answer 200 with authoritative source content, the answer returns within the command timeout (no hang), and cache health reports degraded"
    why_human: "The in-process tests inject an open breaker or point at an unreachable port (cache-breaker.test.ts:17, :20-27). A live outage with real sockets, real timeouts and a real breaker transition is not exercised"
  - test: "Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive enough cache failures to open the breaker, then call POST /brief"
    expected: "HTTP 503, body {\"error\":\"cache_unavailable\",\"class\":\"read\",\"retry_after_s\":N}, a Retry-After header equal to N as an integer, and one substrate.admission.decisions{decision=\"refused\"} increment"
    why_human: "http.admission.test.ts injects BreakerOpenError into a fake redis; the real breaker opening and closing under a live Dragonfly is not observed"
  - test: "Check the refused decision in the real pipeline: /metrics, the OTel/Greptime export, and any dashboard that reads substrate.admission.decisions"
    expected: "decision=\"refused\" series appears with class and surface labels, and is outside the admission.limited_rate SLO numerator (slo.ts, R3)"
    why_human: "recordAdmission (observability/src/instruments.ts) is verified in code and in-process; delivery to the live exporter and dashboards is not"
  - test: "Operator acceptance of the read policy: with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall (class read) answer 503 before the authoritative source is consulted"
    expected: "Operator confirms this is the intended declared policy for read (D75-2)"
    why_human: "The consequence is a declared policy decision that a human must accept; it is not a code defect"
  - test: "Decide whether a fail-closed class may admit during the 5 s connect cooldown (cache.ts run(): the cooldown rejects with a plain Error, not BreakerOpenError) while the breaker is still closed"
    expected: "Explicit operator decision: accept the cooldown window as outside the 'open breaker' scope of criterion 2, or change the cooldown to refuse fail-closed classes"
    why_human: "Criterion 2 is scoped to an open breaker; the cooldown is a separate mechanism. Whether the gap matters is a policy call"
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-18T12:24:20Z
**Status:** human_needed
**Re-verification:** Yes — this record replaces the 2026-11-02 record (status human_needed, same open items) after re-reading the code at HEAD `357d6b15`. The earlier record's code citations had drifted (for example the brief degraded path moved from `service.ts:2231-2239` to `service.ts:2542-2544`); line numbers below are current.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1a  | ROADMAP criterion 1: with the cache breaker open, brief returns the authoritative (index) result | ✓ VERIFIED | `service.ts` brief reads go through `cache.getOrLoad({ klass: "brief", ..., load })`; a refused read is served by `request.load()` (`cache.ts`, `getOrLoad` catch path and `run()` gate). Named test `packages/mcp-server/src/cache-breaker.test.ts` "brief is composed from the index on every call, and the cache never answers it": run now, 1 pass, 0 fail |
| 1b  | ROADMAP criterion 1: with the cache breaker open, recall returns the authoritative (Hindsight) result | ✓ VERIFIED | Recall cache read is `klass: "memory-search"`, load is `recallUncounted`; test `cache-breaker.test.ts` "recall returns the same reply as a substrate with no cache at all": run now, 1 pass, 0 fail; asserts the reply deep-equals the no-cache reply |
| 1c  | Degraded brief sub-truth: breaker open and live source failing, the refused snapshot read leaves the brief `degraded` with no stale serve | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Presence: `service.ts:2477` and `:2542` call `snapshotSurvivesForget`; `:2544` builds the `degraded` detail. No test opens the breaker and fails the live source together (see Human Verification H-1). Not counted as verified |
| 2a  | ROADMAP criterion 2: admission under an open breaker follows the declared policy per class (fail-open admits as bypass; fail-closed refuses in enforce; shadow never refuses) | ✓ VERIFIED | `admission.ts:392-394`: `refused` only when `breakerRetryAfterMs` is set AND class policy is `fail-closed` AND mode is `enforce`; other cases fall to bypass. Named test `cache-breaker.test.ts` "admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane": run now, 1 pass, 0 fail. 503 plus `Retry-After` at `server.ts` (`cache_unavailable` body) |
| 2b  | ROADMAP criterion 2: the policy is declared per class in flags, defaults fail-open, and an invalid value refuses boot naming the variable | ✓ VERIFIED | `config.ts` `breakerPolicyOf` (blank or unset → `fail-open`; other values throw `ConfigError` naming the variable). `flag-registry.ts:189` `CLASS_BREAKER_NAMES` (`SUBSTRATE_BUDGET_<CLASS>_BREAKER`, prefix `SUBSTRATE_BUDGET_`). Documented in `docs/config-reference.md` (line 279). Named test `admission.test.ts` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot": run now, 1 pass, 0 fail |

**Score:** 4/5 truths verified (1a, 1b, 2a, 2b). 1c is present but behaviour-unverified. Both ROADMAP success criteria are verified by their named tests.

### ROADMAP Success Criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | With the cache breaker open, brief and recall return authoritative results. A test proves it. | ✓ VERIFIED | 1a and 1b: both named tests pass |
| 2 | Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags. | ✓ VERIFIED | 2a and 2b: policy test and boot-refusal test pass; flags in `flag-registry.ts` and `config.ts` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `cache.ts` `getOrLoad` | `klass: "brief"` with live compose as `load` | ✓ WIRED | Brief answers from the source when the gate refuses |
| `cache.ts` `run()` | `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Open breaker refuses before any socket is opened |
| `admission.ts` `admit` | `server.ts` 503 path | verdict `refused` | ✓ WIRED | fail-closed enforce only |
| `config.ts` `loadConfig` | `loadAdmissionSettings` | unguarded call | ✓ WIRED | Invalid value refuses boot |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Brief answers from the index with the breaker open (1a) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "brief is composed from the index on every call"` | 1 pass, 0 fail | ✓ PASS |
| Recall equals the uncached reply with the breaker open (1b) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "recall returns the same reply as a substrate with no cache"` | 1 pass, 0 fail | ✓ PASS |
| Admission policy per class over an open breaker (2a) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "admission over the open breaker"` | 1 pass, 0 fail | ✓ PASS |
| Invalid breaker flag refuses boot (2b) | `bun test packages/mcp-server/src/admission.test.ts -t "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot"` | 1 pass, 0 fail | ✓ PASS |
| Degraded brief with breaker open (1c) | none (no test combines an open breaker with a failing live source) | not run | ? SKIP → H-1 |
| Live Dragonfly stop, real 503 | requires a running server and Dragonfly | not run | ? SKIP → H-2, H-3 |

Probe execution (Step 7c): SKIPPED. Not a migration or tooling phase; no PLAN, SUMMARY or success criterion mentions probes.

### Requirements Coverage

No PLAN exists for this phase, so there are no plan `requirements:` IDs. Not evaluated beyond this note.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | ~494 | `staleGenerations` is an in-process `Set` (residual R1 in CONTEXT, predates this phase) | ℹ️ Info | Cross-process or post-restart staleness is bounded by the 5-minute brief TTL |
| `packages/mcp-server/src/cache.ts` | ~402-403 | Connect-cooldown refusal rejects with a plain `Error`, not `BreakerOpenError`, so a fail-closed class admits during the 5 s cooldown while the breaker may be closed | ⚠️ Warning | Outside the criterion's "open breaker" scope; routed to H-5 for an explicit decision |
| `.planning/phases/75-dragonfly-degradation/75-CONTEXT.md` | D75-2 / Flags | CONTEXT says `shadow` records `shadow_limited` for a breaker refusal; code (`admission.ts:392-394`) and `flag-registry.ts` / `config-reference.md` say shadow admits and counts `bypass` | ℹ️ Info | Documentation drift only; the tested behaviour is bypass in shadow |
| `packages/mcp-server/src/` | - | No `TODO`, `FIXME`, `.skip` or `.only` in the covered test files | ✓ | No debt-marker blockers |

## Human Verification Required

### H-1. Degraded brief with the breaker open and the live source failing (1c)
**Test:** Open the cache breaker (`PlaneRegistry` with `failureThreshold: 1`, or a real plane failure). Make the brief's live source throw, for example `getGraph`. Call `briefDetailed` for the same repo and graph.
**Expected:** State `degraded`; no brief-snapshot text served; the cache answers nothing; the brief does not throw.
**Why human:** The degraded-brief tests use a healthy or failing `FakeRedis` with no breaker. The combined path is unexercised.

### H-2. Live stop of Dragonfly while brief and recall run
**Test:** Full stack up, default flags (nothing set). Stop the live Dragonfly. Call `POST /brief` and `POST /memory/recall`.
**Expected:** 200 with authoritative source content; each returns within the command timeout; cache health reports degraded.
**Why human:** In-process tests use an unreachable port or an injected open breaker.

### H-3. Live fail-closed 503 with Retry-After
**Test:** `SUBSTRATE_BUDGETS=enforce`, `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`. Stop Dragonfly and drive failures until the breaker opens. Call `POST /brief`.
**Expected:** HTTP 503, body `{"error":"cache_unavailable","class":"read","retry_after_s":N}`, `Retry-After: N`, and one `substrate.admission.decisions{decision="refused"}` increment.
**Why human:** `http.admission.test.ts` injects a `BreakerOpenError` into a fake redis.

### H-4. Refused-decision metric in the real pipeline; operator acceptance of the read policy
**Test:** (a) Check `/metrics`, the OTel/Greptime export and dashboards for `substrate.admission.decisions{decision="refused"}`, and confirm it is outside `admission.limited_rate`. (b) Confirm the operator accepts that with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 without reaching the authoritative source.
**Expected:** (a) the series exists with class and surface labels; (b) the operator confirms the policy is intended.
**Why human:** Live exporter and dashboard delivery are not in code; the read-policy consequence is a declared decision (D75-2).

### H-5. Cooldown window for fail-closed classes
**Test:** Decide whether a fail-closed class may admit during the 5 s connect cooldown while the breaker is still closed.
**Expected:** An explicit decision recorded in this file or in CONTEXT.
**Why human:** Criterion 2 is scoped to an open breaker; the cooldown is a separate mechanism.

### Residual risks (carried from CONTEXT, unchanged)
- **R1** cross-process staleness after a refused generation bump (bounded by the 5-minute brief TTL). Follow-up, not in this phase.
- **R3** `refused` is not in the admission SLO numerator (`slo.ts`); a cache outage is the breaker's signal, not a budget breach.

---

_Verified: 2026-11-18T12:24:20Z_
_Verifier: Claude (gsd-verifier)_
